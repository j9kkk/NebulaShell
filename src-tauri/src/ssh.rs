// SSH 会话服务(russh 实现):密码/私钥/键盘交互认证、跳板链、shell 数据泵、exec、resize、TOFU 指纹
use russh::client::{self, Handle};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tokio::io::{AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::sync::Mutex as AsyncMutex;

use futures::FutureExt; // Channel::wait().now_or_never():收干已就绪数据做合帧

pub type RemoteTargets = Arc<std::sync::Mutex<HashMap<String, (String, u32, String)>>>;

/// 指纹校验失败时由 `check_server_key` 填入 (主机 host:port, 记录中的指纹, 服务器出示的指纹)。
/// Handler 会被 russh 的 connect 消费掉,失败后无法再访问,故与 remote_targets 同法:
/// 用共享句柄把详情带出来,供连接错误构造"重新信任"提示(跳板链上任一跳失败都能定位到那一跳)。
pub type FpMismatch = Arc<std::sync::Mutex<Option<(String, String, String)>>>;

pub trait AsyncReadWrite: tokio::io::AsyncRead + tokio::io::AsyncWrite + Send + Unpin {}
impl<T: tokio::io::AsyncRead + tokio::io::AsyncWrite + Send + Unpin> AsyncReadWrite for T {}
pub type BoxStream = Box<dyn AsyncReadWrite>;

pub struct SshHandler {
    pub host_id: String,
    pub key: String, // TOFU 键 host:port
    pub password: String,
    pub store: Arc<crate::config::Store>,
    pub remote_targets: RemoteTargets,
    pub remote_pump: Option<(String, u32)>, // 回连目的地缓存
    pub fp_mismatch: FpMismatch,            // 指纹不匹配时回填,供上层给出可操作的恢复提示
}

#[derive(Debug)]
pub enum HandlerError {
    russh(russh::Error),
    Msg(String),
}

impl std::fmt::Display for HandlerError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            HandlerError::russh(e) => write!(f, "{}", e),
            HandlerError::Msg(m) => write!(f, "{}", m),
        }
    }
}
impl std::error::Error for HandlerError {}
impl From<russh::Error> for HandlerError {
    fn from(e: russh::Error) -> Self {
        HandlerError::russh(e)
    }
}

/// 指纹归一:把同一 SHA256 摘要的各种历史存法还原成字节。
/// - 现行 russh `fingerprint()`:`base64-nopad`(43 字符)
/// - 遗留记录:hex(64 字符,Electron 版写入,随配置文件原样迁移而来)
/// - "SHA256:xxx"(OpenSSH 展示格式)顺带兼容
/// 比较前必须归一,否则同一把服务器密钥会因为编码不同被误判为"指纹变更"。
pub(crate) fn fp_digest(s: &str) -> Option<Vec<u8>> {
    use data_encoding::{BASE64_NOPAD, HEXLOWER};
    let t = s.strip_prefix("SHA256:").unwrap_or(s).trim();
    if t.len() == 64 && t.chars().all(|c| c.is_ascii_hexdigit()) {
        return HEXLOWER.decode(t.as_bytes()).ok();
    }
    BASE64_NOPAD
        .decode(t.as_bytes())
        .ok()
        .filter(|b| b.len() == 32)
}

pub(crate) fn fp_matches(stored: &str, current: &str) -> bool {
    match (fp_digest(stored), fp_digest(current)) {
        (Some(a), Some(b)) => a == b,
        // 双方都归一失败(理论不可能:两侧都是程序写入的摘要)时退回字符串比较
        _ => stored == current,
    }
}

/// 连接错误转人话:UnknownKey 只说明"指纹与记录不一致",直接甩 russh 原文
/// ("Unknown server key")用户既不知道原因也不知道怎么恢复。
fn humanize_connect_error(e: HandlerError) -> String {
    match e {
        HandlerError::russh(russh::Error::UnknownKey) => "服务器主机指纹与已保存记录不一致(该服务器可能更换过 SSH 主机密钥)。若非本人操作,请警惕中间人风险".into(),
        HandlerError::russh(e) => e.to_string(),
        HandlerError::Msg(m) => m,
    }
}

/// 指纹变更的错误文案,末尾附可机读标记 `[NB-FP key|stored|current]`。
/// 前端据此把"可一键恢复的指纹变更"与普通连接失败区分开:错误通道全程是纯
/// 字符串(见 commands.rs err_msg),跳板链还会再套一层"跳板 X 失败:"前缀,
/// 所以标记放在句中任意位置都可被检索,前端按标记解析后再剥掉它显示。
/// key/stored/current 分别取自 host:port 与两种指纹编码(base64-nopad 或 hex),
/// 均不含 `]` 与 `|`,不会与分隔符冲突。
pub(crate) fn fp_mismatch_error(key: &str, stored: &str, current: &str) -> String {
    format!(
        "服务器主机指纹与已保存记录不一致(该服务器可能更换过 SSH 主机密钥)。若非本人操作,请警惕中间人风险。[NB-FP {}|{}|{}]",
        key, stored, current
    )
}

/// 连接失败的错误串。指纹变更优先于通用文案:此时 UnknownKey 只是表象,
/// 用户需要的是"哪台、怎么恢复",而这些只存在于 fp_mismatch(Handler 已被消费)。
pub(crate) fn connect_err(host_addr: &str, e: HandlerError, fp_mismatch: &FpMismatch) -> String {
    if let Ok(m) = fp_mismatch.lock() {
        if let Some((key, stored, current)) = m.as_ref() {
            return format!("{}:{}", host_addr, fp_mismatch_error(key, stored, current));
        }
    }
    format!("{}:{}", host_addr, humanize_connect_error(e))
}

#[async_trait::async_trait]
impl client::Handler for SshHandler {
    type Error = HandlerError;

    async fn check_server_key(
        &mut self,
        key: &russh::keys::key::PublicKey,
    ) -> Result<bool, Self::Error> {
        let fp = key.fingerprint(); // russh_keys::key::PublicKey 自带 SHA256 指纹(base64-nopad)
        let known = {
            let data = self.store.data.lock().unwrap();
            data["knownHosts"][self.key.clone()]
                .as_str()
                .map(String::from)
        };
        match known {
            None => {
                {
                    let mut data = self.store.data.lock().unwrap();
                    data["knownHosts"][self.key.clone()] = json!(fp);
                }
                self.store.save().ok();
                Ok(true)
            }
            Some(stored) => {
                if stored == fp {
                    return Ok(true);
                }
                if !fp_matches(&stored, &fp) {
                    // 记下这一跳的主机与双方指纹:Handler 随后被 russh 消费,
                    // 这是把"是谁、旧指纹、新指纹"带出连接流程的唯一时机。
                    if let Ok(mut m) = self.fp_mismatch.lock() {
                        *m = Some((self.key.clone(), stored.clone(), fp.clone()));
                    }
                    return Ok(false); // 摘要真的不同:服务器换钥,拒绝连接
                }
                // 同一把密钥、仅编码不同(hex 遗留):升级为现行格式,自愈迁移数据,
                // 之后走快速字符串比较,不再进兼容分支。
                {
                    let mut data = self.store.data.lock().unwrap();
                    data["knownHosts"][self.key.clone()] = json!(fp);
                }
                self.store.save().ok();
                Ok(true)
            }
        }
    }

    async fn data(
        &mut self,
        _channel: russh::ChannelId,
        _data: &[u8],
        _session: &mut client::Session,
    ) -> Result<(), Self::Error> {
        // shell 数据泵在专用任务里读取,这里不处理
        Ok(())
    }

    // 远程转发:服务端回连的通道 → 泵到本机目标(R 转发的客户端侧)
    async fn server_channel_open_forwarded_tcpip(
        &mut self,
        channel: russh::Channel<client::Msg>,
        connected_address: &str,
        connected_port: u32,
        _originator_address: &str,
        _originator_port: u32,
        _session: &mut client::Session,
    ) -> Result<(), Self::Error> {
        let key = format!("{}:{}", connected_address, connected_port);
        let target = self.remote_targets.lock().unwrap().get(&key).cloned();
        match target {
            Some((dest_host, dest_port, rule_id)) => {
                let stream = channel.into_stream();
                void_rule(&rule_id);
                tokio::spawn(async move {
                    match tokio::net::TcpStream::connect((dest_host.as_str(), dest_port as u16))
                        .await
                    {
                        Ok(sock) => {
                            let _ = sock.set_nodelay(true); // 同 connect_one:转发的交互流量也不该吃 Nagle
                            let (mut ra, mut wa) = tokio::io::split(sock);
                            let (mut rb, mut wb) = tokio::io::split(stream);
                            let t1 = tokio::spawn(async move {
                                let mut buf = vec![0u8; 64 * 1024];
                                loop {
                                    match ra.read(&mut buf).await {
                                        Ok(0) | Err(_) => break,
                                        Ok(n) => {
                                            if wb.write_all(&buf[..n]).await.is_err() {
                                                break;
                                            }
                                        }
                                    }
                                }
                                let _ = wb.shutdown().await;
                            });
                            let mut buf = vec![0u8; 64 * 1024];
                            loop {
                                match rb.read(&mut buf).await {
                                    Ok(0) | Err(_) => break,
                                    Ok(n) => {
                                        if wa.write_all(&buf[..n]).await.is_err() {
                                            break;
                                        }
                                    }
                                }
                            }
                            let _ = wa.shutdown().await;
                            t1.abort();
                        }
                        Err(_) => {}
                    }
                });
                Ok(())
            }
            None => Err(HandlerError::Msg(format!("未注册的远程转发目标: {}", key))),
        }
    }
}

fn void_rule(_: &str) {}

/// 从跨消息缓冲中取出可完整解码的 UTF-8 前缀,把结尾不完整的多字节序列留在缓冲里。
///
/// 直接对每条 ChannelMsg 调 `from_utf8_lossy` 会在 SSH 分包切开多字节字符时
/// 产生 U+FFFD(中文/emoji 场景实测可见)。这里按"完整前缀"解码,残留尾部留待下一批。
pub(crate) fn take_utf8(pending: &mut Vec<u8>) -> String {
    if pending.is_empty() {
        return String::new();
    }
    // 从尾部最多回看 4 字节,定位最后一个"字符起始"位置:
    // ASCII 自身完整;多字节起始字节则需判断后继字节是否到齐。
    // 未到齐 -> 该字符整体留给下一批(而不是用 U+FFFD 顶替)。
    let mut split = pending.len();
    for back in 1..=pending.len().min(4) {
        let idx = pending.len() - back;
        let b = pending[idx];
        if b < 0x80 {
            break; // ASCII:边界在其后
        }
        if b >= 0xC0 {
            let need = if b >= 0xF0 {
                4
            } else if b >= 0xE0 {
                3
            } else {
                2
            };
            split = if back >= need { pending.len() } else { idx };
            break;
        }
        // 0x80..=0xBF:后继字节,继续往前找起始字节
    }
    let tail = pending.split_off(split);
    let head = std::mem::replace(pending, tail);
    String::from_utf8(head).unwrap_or_else(|e| String::from_utf8_lossy(e.as_bytes()).to_string())
}

/// 判断会话是否仍是当前代(旧泵退出前避免误动新会话)。
/// 只读会话自持的 alive 标记,不锁全局会话表 —— 这张表同时被 exec(监控探针
/// 全程持有)、write、resize 抢占,数据泵热路径上再排一次队会把高 RTT 链路上
/// 每 3 秒一次的探针放大成"输入/输出周期性冻结"。
fn is_alive(session: &Session) -> bool {
    session.alive.load(Ordering::Relaxed)
}

/// 彻底关闭一个会话:断开跳板链与主连接。
///
/// 必须显式调用:russh 的 `Handle::drop` 只打一条 debug 日志,**不会**关闭连接。
/// 被替换或被遗弃的会话若只靠 drop,会一直占着 TCP 连接与通道接收窗口。
async fn shut_down_session(session: Arc<Session>) {
    for j in &session.jump_handles {
        let _ = j
            .disconnect(russh::Disconnect::ByApplication, "", "en")
            .await;
    }
    let _ = session
        .handle
        .lock()
        .await
        .disconnect(russh::Disconnect::ByApplication, "", "en")
        .await;
}

pub struct Session {
    /// Handle 不可 Clone(内含 receiver),tcpip_forward 需要 &mut 而其余方法
    /// 只要 &self,故以 Arc<tokio::Mutex<_>> 共享:exec/open_sftp/转发只在
    /// "开通道/子系统/转发请求"这一个往返期间持互斥,数据读写不经过它,
    /// 不会阻塞终端热路径。
    pub handle: Arc<tokio::sync::Mutex<Handle<SshHandler>>>,
    pub writer: tokio::sync::mpsc::UnboundedSender<Vec<u8>>,
    pub resize_tx: tokio::sync::mpsc::UnboundedSender<(u32, u32)>,
    pub host: Value,
    pub jump_handles: Vec<Handle<SshHandler>>,
    /// 存活标记(代际身份)。数据泵靠它判断"自己是否仍是该会话的主人",
    /// 置 false 的时机:被新会话替换(connect)、主动断开(disconnect)、
    /// 远端关闭后的自回收(数据泵收尾)。热路径上只做原子读。
    pub alive: AtomicBool,
}

pub struct SshService {
    /// 值为 Arc<Session>:write/resize/exec 等热路径只从表里克隆句柄副本即放锁,
    /// 数据泵持有同代 Arc 做存活判断,均不长期占用这张表。
    pub sessions: AsyncMutex<std::collections::HashMap<String, Arc<Session>>>,
    /// 按 sessionId 缓存的 SFTP 会话。
    ///
    /// 每次 SFTP 操作都新开一条通道要付"channel_open_session + sftp 子系统协商"
    /// 的往返成本;文件面板的每次列目录/上传/下载都会用到它。
    /// 连接被替换/回收/断开时必须清理,否则残留通道挂在已废弃的 SSH 连接上。
    pub sftp_sessions:
        AsyncMutex<std::collections::HashMap<String, Arc<russh_sftp::client::SftpSession>>>,
    pub store: Arc<crate::config::Store>,
    pub remote_targets: RemoteTargets,
}

impl SshService {
    pub fn new(store: Arc<crate::config::Store>, remote_targets: RemoteTargets) -> Self {
        SshService {
            sessions: AsyncMutex::new(std::collections::HashMap::new()),
            sftp_sessions: AsyncMutex::new(std::collections::HashMap::new()),
            store,
            remote_targets,
        }
    }

    pub fn clone_shared(&self) -> Arc<Self> {
        Arc::new(SshService {
            sessions: AsyncMutex::new(std::collections::HashMap::new()),
            sftp_sessions: AsyncMutex::new(std::collections::HashMap::new()),
            store: self.store.clone(),
            remote_targets: self.remote_targets.clone(),
        })
    }

    /// 丢弃指定会话的 SFTP 缓存(连接被替换/回收/断开时调用)
    pub async fn forget_sftp(&self, session_id: &str) {
        self.sftp_sessions.lock().await.remove(session_id);
    }

    fn make_config() -> Arc<client::Config> {
        let mut config = client::Config::default();
        config.keepalive_interval = Some(std::time::Duration::from_secs(8));
        config.keepalive_max = 6;
        // 通道接收窗口:默认 2MB/通道。终端与 SFTP 的稳态吞吐远低于此,
        // 而窗口大小按"连接数 × 通道数"占用内存(分屏/批量/转发/SFTP 叠加)。
        // 512KB 足以维持高吞吐(受 maximum_packet_size=32KB 限制,吞吐主要取决于往返),
        // 同时把每条通道的接收缓冲从 2MB 降到 512KB。
        config.window_size = 512 * 1024;
        Arc::new(config)
    }

    async fn auth(handle: &mut Handle<SshHandler>, user: &str, host: &Value) -> Result<(), String> {
        let auth_type = host["authType"].as_str().unwrap_or("password");
        let password = host["password"].as_str().unwrap_or("");
        if auth_type == "key" {
            let pem = host["privateKey"].as_str().unwrap_or("");
            if pem.is_empty() {
                return Err("未配置私钥,请编辑主机补全".into());
            }
            let pem = if !pem.contains('\n') && pem.contains("\\n") {
                pem.replace("\\n", "\n")
            } else {
                pem.to_string()
            };
            let passphrase = host["passphrase"].as_str().filter(|s| !s.is_empty());
            let key = russh::keys::decode_secret_key(&pem, passphrase)
                .map_err(|e| format!("私钥解析失败: {}", e))?;
            let ok = handle
                .authenticate_publickey(user, Arc::new(key))
                .await
                .map_err(|e| e.to_string())?;
            if !ok {
                return Err("私钥认证失败".into());
            }
            Ok(())
        } else {
            if password.is_empty() {
                return Err("未配置密码,请编辑主机补全".into());
            }
            let ok = handle
                .authenticate_password(user, password)
                .await
                .map_err(|e| e.to_string())?;
            if !ok {
                // 退化到键盘交互(与 Electron 版 keyboard-interactive 自动应答一致)
                use russh::client::KeyboardInteractiveAuthResponse as Kir;
                let mut r = handle
                    .authenticate_keyboard_interactive_start(user, None)
                    .await
                    .map_err(|e| e.to_string())?;
                loop {
                    match r {
                        Kir::InfoRequest { .. } => {
                            r = handle
                                .authenticate_keyboard_interactive_respond(vec![
                                    password.to_string()
                                ])
                                .await
                                .map_err(|e| e.to_string())?;
                        }
                        Kir::Success => break,
                        Kir::Failure => {
                            return Err("All configured authentication methods failed".into())
                        }
                    }
                }
            }
            Ok(())
        }
    }

    async fn connect_one(
        &self,
        store: Arc<crate::config::Store>,
        host: &Value,
        sock: Option<BoxStream>,
    ) -> Result<Handle<SshHandler>, String> {
        let host_addr = host["host"].as_str().unwrap_or("");
        let port = host["port"].as_i64().unwrap_or(22);
        let user = host["username"].as_str().unwrap_or("root");
        let key = format!("{}:{}", host_addr, port);
        // 每一跳各持一个槽:check_server_key 填入后由 connect_err 读出,
        // 这样跳板链上"哪一跳换钥"能定位到具体主机,而不是笼统报最终目标失败。
        let fp_mismatch: FpMismatch = Arc::new(std::sync::Mutex::new(None));
        let handler = SshHandler {
            host_id: host["id"].as_str().unwrap_or("").to_string(),
            key,
            password: host["password"].as_str().unwrap_or("").to_string(),
            store: store.clone(),
            remote_targets: self.remote_targets.clone(),
            remote_pump: None,
            fp_mismatch: fp_mismatch.clone(),
        };
        let mut handle = match sock {
            Some(stream) => client::connect_stream(Self::make_config(), stream, handler)
                .await
                .map_err(|e| connect_err(host_addr, e, &fp_mismatch))?,
            None => {
                let addr = format!("{}:{}", host_addr, port);
                // 不用 client::connect:russh 不代设 socket 选项,默认 Nagle 会把
                // 快速打字的小包扣到上一个包 ACK(≈1 个 RTT)之后才发出,高延迟
                // 国际链路上回显明显成坨。OpenSSH/MobaXterm 均在认证后关 Nagle,
                // 这里自建 socket 补齐(TCP_NODELAY 在已连接的 TCP 上不会失败,尽力而为)。
                let sock = tokio::net::TcpStream::connect(&addr)
                    .await
                    .map_err(|e| format!("{}:连接失败: {}", host_addr, e))?;
                let _ = sock.set_nodelay(true);
                client::connect_stream(Self::make_config(), sock, handler)
                    .await
                    .map_err(|e| connect_err(host_addr, e, &fp_mismatch))?
            }
        };
        Self::auth(&mut handle, user, host).await?;
        Ok(handle)
    }

    /// 连接(支持跳板链 host.jumpIds):返回 (sessionId, 跳板连接数)
    pub async fn connect<
        R: tauri::Runtime,
        E: tauri::Emitter<R> + Clone + Send + Sync + 'static,
    >(
        self: &Arc<Self>,
        app: E,
        host_full: Value,
        session_id: String,
    ) -> Result<usize, String> {
        let host_addr = host_full["host"].as_str().unwrap_or("").to_string();
        let port = host_full["port"].as_i64().unwrap_or(22);
        let user = host_full["username"].as_str().unwrap_or("root").to_string();
        let jump_ids: Vec<String> = host_full["jumpIds"]
            .as_array()
            .map(|a| {
                a.iter()
                    .filter_map(|x| x.as_str().map(String::from))
                    .collect()
            })
            .unwrap_or_default();

        // 跳板链:逐级 forwardOut 直通流到最终目标
        let mut jump_handles: Vec<Handle<SshHandler>> = Vec::new();
        let mut prev_sock: Option<BoxStream> = None;
        let chain_len = jump_ids.len();
        for (i, jid) in jump_ids.iter().enumerate() {
            let jump = self
                .store
                .host_full(jid)
                .map_err(|e| format!("跳板: {}", e))?;
            let jhost = jump["host"].as_str().unwrap_or("").to_string();
            let jport = jump["port"].as_i64().unwrap_or(22);
            let target = if i + 1 < jump_ids.len() {
                self.store
                    .host_full(&jump_ids[i + 1])
                    .map_err(|e| format!("跳板: {}", e))?
            } else {
                host_full.clone()
            };
            let mut jh = self
                .connect_one(self.store.clone(), &jump, prev_sock.take())
                .await
                .map_err(|e| format!("跳板 {} 失败: {}", jhost, e))?;
            let ch = jh
                .channel_open_direct_tcpip(
                    target["host"].as_str().unwrap_or(""),
                    target["port"].as_i64().unwrap_or(22) as u32,
                    "127.0.0.1",
                    0,
                )
                .await
                .map_err(|e| format!("跳板 {} 建立直连失败: {}", jhost, e))?;
            let stream: BoxStream = Box::new(ch.into_stream());
            prev_sock = Some(stream);
            jump_handles.push(jh);
        }

        let handle = self
            .connect_one(self.store.clone(), &host_full, prev_sock)
            .await
            .map_err(|e| {
                if chain_len > 0 {
                    format!("经跳板连接 {} 失败: {}", host_addr, e)
                } else {
                    e
                }
            })?;

        // shell 通道
        let mut channel = handle
            .channel_open_session()
            .await
            .map_err(|e| e.to_string())?;
        channel
            .request_pty(true, "xterm-256color", 100, 30, 0, 0, &[])
            .await
            .map_err(|e| e.to_string())?;
        channel
            .request_shell(true)
            .await
            .map_err(|e| e.to_string())?;
        let (writer_tx, mut writer_rx) = tokio::sync::mpsc::unbounded_channel::<Vec<u8>>();
        let (resize_tx, mut resize_rx) = tokio::sync::mpsc::unbounded_channel::<(u32, u32)>();

        // 先登记会话再启动数据泵:数据泵靠 session.alive 判断自己是否仍是该
        // 会话的主人,登记与否不影响首批输出(Arc 克隆自持),但保持先登记的
        // 顺序能让"会话不存在"类查询(write/resize)在泵启动前就拿到正确结果。
        //
        // 原子替换:若该 sessionId 已有旧会话(自动重连走的就是这条路径),
        // 必须先显式断开,否则旧 TCP 连接与 shell 通道会永久泄漏
        // (russh 的 Handle::drop 不做任何关闭动作)。
        let session = Arc::new(Session {
            handle: Arc::new(tokio::sync::Mutex::new(handle)),
            writer: writer_tx,
            resize_tx,
            host: host_full,
            jump_handles,
            alive: AtomicBool::new(true),
        });
        let replaced = {
            let mut sessions = self.sessions.lock().await;
            sessions.insert(session_id.clone(), session.clone())
        };
        if let Some(old) = replaced {
            old.alive.store(false, Ordering::Relaxed); // 旧泵据此停止发射并退出
            self.forget_sftp(&session_id).await; // 旧连接的 SFTP 缓存必须作废
            shut_down_session(old).await;
        }

        // 数据泵:channel → ssh:data / ssh:status 事件。
        // session.alive 标识"这一代"连接:同一 sessionId 重连时旧泵可能还在
        // 退出途中,靠它区分自己是否仍是该会话的主人(否则会误删/误报新会话)。
        let pump_app = app.clone();
        let pump_sid = session_id.clone();
        let pump_svc = Arc::clone(self);
        let pump_session = session.clone();
        tokio::spawn(async move {
            let mut pending: Vec<u8> = Vec::new(); // 跨消息未拼完的多字节序列
            let mut batch: Vec<u8> = Vec::new(); // 本轮累积的数据(合帧)
            let mut exit: Option<Value> = None;
            'pump: loop {
                batch.clear();
                // 1) 先收干"已就绪"的数据消息,合成单个事件(降低 IPC 次数与 GC 压力)。
                //    设上限 64 条,避免持续洪泛把写入/尺寸变化饿死。
                for _ in 0..64 {
                    match channel.wait().now_or_never() {
                        Some(Some(russh::ChannelMsg::Data { ref data }))
                        | Some(Some(russh::ChannelMsg::ExtendedData { ref data, .. })) => {
                            batch.extend_from_slice(data);
                        }
                        Some(Some(russh::ChannelMsg::ExitStatus { exit_status })) => {
                            exit = Some(json!({
                                "sessionId": pump_sid,
                                "state": "exited",
                                "code": exit_status
                            }));
                            break;
                        }
                        Some(Some(russh::ChannelMsg::Close)) | Some(None) => {
                            exit = Some(json!({ "sessionId": pump_sid, "state": "exited" }));
                            break;
                        }
                        Some(Some(_)) => {}
                        None => break, // 没有更多就绪数据
                    }
                }

                // 2) 空闲时阻塞等待数据 / 输入 / 尺寸变化
                if batch.is_empty() && exit.is_none() {
                    let msg = tokio::select! {
                        m = channel.wait() => m,
                        r = resize_rx.recv() => {
                            // None = Session 已从会话表移除(发送端随之 drop)。
                            // 此时必须退出,否则 recv() 会持续立即返回 None 形成忙等。
                            match r {
                                Some((cols, rows)) => {
                                    let _ = channel.window_change(cols, rows, 0, 0).await;
                                    continue;
                                }
                                None => break 'pump,
                            }
                        }
                        d = writer_rx.recv() => {
                            match d {
                                Some(bytes) => {
                                    let _ = channel.data(&bytes[..]).await;
                                    continue;
                                }
                                None => break 'pump,
                            }
                        }
                    };
                    match msg {
                        Some(russh::ChannelMsg::Data { ref data })
                        | Some(russh::ChannelMsg::ExtendedData { ref data, .. }) => {
                            batch.extend_from_slice(data);
                        }
                        Some(russh::ChannelMsg::ExitStatus { exit_status }) => {
                            exit = Some(json!({
                                "sessionId": pump_sid,
                                "state": "exited",
                                "code": exit_status
                            }));
                        }
                        Some(russh::ChannelMsg::Close) | None => {
                            exit = Some(json!({ "sessionId": pump_sid, "state": "exited" }));
                        }
                        Some(_) => continue,
                    }
                }

                // 3) 发射数据(仅当仍是该会话的主人,避免旧泵污染新会话)
                if !batch.is_empty() {
                    pending.extend_from_slice(&batch);
                    let text = take_utf8(&mut pending);
                    if !text.is_empty() && is_alive(&pump_session) {
                        crate::ai::emit_evt(
                            &pump_app,
                            "ssh:data",
                            json!({ "sessionId": pump_sid, "data": text }),
                        );
                    }
                }

                // 4) 通道结束:发退出状态后退出泵
                if let Some(st) = exit {
                    if is_alive(&pump_session) {
                        crate::ai::emit_evt(&pump_app, "ssh:status", st);
                    }
                    break 'pump;
                }
            }

            // 5) 自回收:远端主动断开时,会话必须从 sessions 移除,
            //    否则连接(含跳板链)与通道会一直留在 map 里。
            //    Arc 指针不一致说明本会话已被重连替换,不能动新会话。
            let mut sessions = pump_svc.sessions.lock().await;
            let is_current = sessions
                .get(&pump_sid)
                .map(|s| Arc::ptr_eq(s, &pump_session))
                .unwrap_or(false);
            if is_current {
                if let Some(s) = sessions.remove(&pump_sid) {
                    s.alive.store(false, Ordering::Relaxed);
                    drop(sessions);
                    pump_svc.forget_sftp(&pump_sid).await;
                    shut_down_session(s).await;
                }
            }
        });
        crate::ai::emit_evt(
            &app,
            "ssh:status",
            json!({ "sessionId": session_id.clone(), "state": "connected", "label": format!("{}@{}", user, host_addr) }),
        );
        Ok(chain_len)
    }

    // write/resize 是按键与窗口变化的热路径:锁只用来查表取句柄副本,
    // 发送在锁外完成 —— 否则监控探针(3s 一次,高 RTT 下全程持锁)会把
    // 每次敲键卡出可感知的停顿。
    pub async fn write(&self, session_id: &str, data: &str) -> Result<(), String> {
        let writer = {
            let sessions = self.sessions.lock().await;
            sessions
                .get(session_id)
                .ok_or("会话不存在或已断开")?
                .writer
                .clone()
        };
        writer
            .send(data.as_bytes().to_vec())
            .map_err(|_| "会话已断开".to_string())
    }

    pub async fn resize(&self, session_id: &str, cols: u32, rows: u32) -> Result<(), String> {
        let resize_tx = {
            let sessions = self.sessions.lock().await;
            sessions
                .get(session_id)
                .ok_or("会话不存在或已断开")?
                .resize_tx
                .clone()
        };
        resize_tx
            .send((cols, rows))
            .map_err(|_| "会话已断开".to_string())
    }

    pub async fn exec(&self, session_id: &str, command: &str) -> Result<(i64, String), String> {
        // exec 的执行期(开通道 + 远端跑完 + 读到 Close)在高 RTT 链路上可达
        // 数秒,旧实现全程持有全局会话锁,期间所有会话的输入/输出一并冻结。
        // 这里只克隆句柄指针,通道打开即放锁,读输出期间不占任何锁。
        let handle = {
            let sessions = self.sessions.lock().await;
            sessions
                .get(session_id)
                .ok_or("会话不存在或已断开")?
                .handle
                .clone()
        };
        let mut channel = {
            let mut h = handle.lock().await;
            h.channel_open_session().await.map_err(|e| e.to_string())?
        };
        channel
            .exec(true, command)
            .await
            .map_err(|e| e.to_string())?;
        let mut output = String::new();
        let mut pending: Vec<u8> = Vec::new();
        let mut code: i64 = 0;
        loop {
            match channel.wait().await {
                Some(russh::ChannelMsg::Data { ref data })
                | Some(russh::ChannelMsg::ExtendedData { ref data, .. }) => {
                    // 逐块拼接后再按完整 UTF-8 前缀解码,避免多字节字符被包边界切断
                    pending.extend_from_slice(data);
                    output.push_str(&take_utf8(&mut pending));
                }
                Some(russh::ChannelMsg::ExitStatus { exit_status }) => code = exit_status as i64,
                Some(russh::ChannelMsg::Close) | None => break,
                _ => {}
            }
        }
        output.push_str(&take_utf8(&mut pending)); // 收尾:残留的完整前缀
        output.push_str(&String::from_utf8_lossy(&pending)); // 异常截断的尾部(尽力而为)
        Ok((code, output))
    }

    /// 取该会话的 SFTP 通道(优先复用缓存)。
    ///
    /// 旧实现每次调用都新开通道 + 子系统协商;文件面板的每次列目录/上传/下载
    /// 都走这里,按 sessionId 复用可省掉反复协商的往返与通道开销。
    /// 连接失效时缓存由 forget_sftp 清理。
    pub async fn open_sftp(
        &self,
        session_id: &str,
    ) -> Result<Arc<russh_sftp::client::SftpSession>, String> {
        {
            let cache = self.sftp_sessions.lock().await;
            if let Some(s) = cache.get(session_id) {
                return Ok(s.clone());
            }
        }
        // 通道协商(channel_open + 子系统 + SFTP 握手)在高 RTT 下要好几个往返,
        // 与 exec 同理:取 Handle 副本后立刻放锁,不阻塞终端输入/输出。
        let handle = {
            let sessions = self.sessions.lock().await;
            sessions
                .get(session_id)
                .ok_or("会话不存在或已断开")?
                .handle
                .clone()
        };
        let sftp = {
            let channel = {
                let mut h = handle.lock().await;
                h.channel_open_session().await.map_err(|e| e.to_string())?
            };
            channel
                .request_subsystem(true, "sftp")
                .await
                .map_err(|e| format!("请求 sftp 子系统失败: {}", e))?;
            let stream: BoxStream = Box::new(channel.into_stream());
            Arc::new(
                russh_sftp::client::SftpSession::new(stream)
                    .await
                    .map_err(|e| format!("打开 SFTP 通道失败: {}", e))?,
            )
        };
        // entry().or_insert:并发首次调用时双方都会建通道,后完成者复用先完成者
        // 的缓存,避免重复通道挂在连接上。
        let mut cache = self.sftp_sessions.lock().await;
        Ok(cache.entry(session_id.to_string()).or_insert(sftp).clone())
    }

    pub async fn direct_tcpip(
        &self,
        session_id: &str,
        dest_host: &str,
        dest_port: u32,
        src_ip: &str,
        src_port: u32,
    ) -> Result<BoxStream, String> {
        let handle = {
            let sessions = self.sessions.lock().await;
            sessions
                .get(session_id)
                .ok_or("会话不存在或已断开")?
                .handle
                .clone()
        };
        let ch = {
            let mut h = handle.lock().await;
            h.channel_open_direct_tcpip(dest_host, dest_port, src_ip, src_port)
                .await
                .map_err(|e| e.to_string())?
        };
        Ok(Box::new(ch.into_stream()) as BoxStream)
    }

    pub async fn remote_forward_listen(
        &self,
        session_id: &str,
        bind_host: &str,
        bind_port: u32,
    ) -> Result<u32, String> {
        let handle = {
            let sessions = self.sessions.lock().await;
            sessions
                .get(session_id)
                .ok_or("会话不存在或已断开")?
                .handle
                .clone()
        };
        let mut h = handle.lock().await;
        h.tcpip_forward(bind_host, bind_port)
            .await
            .map_err(|e| e.to_string())
    }

    pub async fn remote_forward_cancel(&self, session_id: &str, bind_host: &str, bind_port: u32) {
        let handle = {
            let sessions = self.sessions.lock().await;
            match sessions.get(session_id) {
                Some(s) => s.handle.clone(),
                None => return,
            }
        };
        let mut h = handle.lock().await;
        let _ = h.cancel_tcpip_forward(bind_host, bind_port).await;
    }

    pub async fn disconnect(&self, session_id: &str) {
        let mut sessions = self.sessions.lock().await;
        if let Some(s) = sessions.remove(session_id) {
            s.alive.store(false, Ordering::Relaxed);
            drop(sessions);
            self.forget_sftp(session_id).await;
            shut_down_session(s).await;
        }
    }

    pub async fn session_host_id(&self, session_id: &str) -> Option<String> {
        let sessions = self.sessions.lock().await;
        sessions
            .get(session_id)
            .map(|s| s.host["id"].as_str().unwrap_or("").to_string())
    }

    /// 探测交互 shell 的当前工作目录(文件面板首次打开的默认路径)。
    ///
    /// exec 通道的命令与交互 shell 同为本连接 sshd 会话进程的子进程:在 exec 里
    /// 用 $PPID 找到 sshd 会话进程,再取其下**持有 tty** 的那个子进程 —— 即交互
    /// shell(exec 型子进程没有 pty,监控探针/sftp-server 都会被 tty 条件排除),
    /// 读它的 cwd:
    /// - Linux:/proc/<pid>/cwd 符号链接;
    /// - macOS/BSD:无 /proc,退回 lsof 读 cwd。
    /// ps 的过滤不用 GNU 专属的 `--ppid`,而是 `ps axo pid,ppid,tty` + awk
    /// (procps 与 BSD/macOS 通用);tty 列排除空与 `?`(macOS 无 tty 显示 `??`)。
    /// 输出用 `NB_CWD ` 前缀标记,避免与登录脚本的无关回显混淆。
    pub const CWD_PROBE: &'static str = "for p in $(ps axo pid=,ppid=,tty= 2>/dev/null | awk -v pp=\"$PPID\" '$2==pp && $3!=\"\" && $3!~/^\\?/{print $1}'); do [ \"$p\" = \"$$\" ] && continue; d=$(readlink /proc/$p/cwd 2>/dev/null); if [ -z \"$d\" ]; then d=$(lsof -a -p $p -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -n 1); fi; if [ -n \"$d\" ]; then echo \"NB_CWD $d\"; fi; break; done";

    /// 返回 None 表示探测不可用(非类 Unix/受限环境),由前端回落到
    /// OSC7 记录或家目录;这里不把"探测不出"当错误。
    pub async fn probe_cwd(&self, session_id: &str) -> Result<Option<String>, String> {
        if let Ok((_, out)) = self.exec(session_id, Self::CWD_PROBE).await {
            for line in out.lines().rev() {
                if let Some(rest) = line.trim_start().strip_prefix("NB_CWD ") {
                    let p = rest.trim();
                    if p.starts_with('/') {
                        return Ok(Some(p.to_string()));
                    }
                }
            }
        }
        // 兜底:exec 通道里 pwd = 登录家目录(shell 实时 cwd 拿不到时的下限)
        if let Ok((code, out)) = self.exec(session_id, "pwd").await {
            if code == 0 {
                for line in out.lines().rev() {
                    let l = line.trim();
                    if l.starts_with('/') {
                        return Ok(Some(l.to_string()));
                    }
                }
            }
        }
        Ok(None)
    }

    pub async fn find_by_host(&self, host_id: &str) -> Option<String> {
        let sessions = self.sessions.lock().await;
        sessions
            .iter()
            .find(|(_, s)| s.host["id"].as_str() == Some(host_id))
            .map(|(k, _)| k.clone())
    }
}
