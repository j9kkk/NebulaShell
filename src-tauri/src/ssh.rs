// SSH 会话服务(russh 实现):密码/私钥/键盘交互认证、跳板链、shell 数据泵、exec、resize、TOFU 指纹
use russh::client::{self, Handle};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::Arc;
use tokio::io::{AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::sync::Mutex as AsyncMutex;

use futures::FutureExt; // Channel::wait().now_or_never():收干已就绪数据做合帧

pub type RemoteTargets = Arc<std::sync::Mutex<HashMap<String, (String, u32, String)>>>;

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
            Some(stored) => Ok(stored == fp),
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
fn take_utf8(pending: &mut Vec<u8>) -> String {
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

/// 判断 token 是否仍是该 sessionId 的当前连接(用于旧泵退出时避免误动新会话)。
async fn is_owner(svc: &SshService, session_id: &str, token: &Arc<()>) -> bool {
    let sessions = svc.sessions.lock().await;
    sessions
        .get(session_id)
        .map(|s| Arc::ptr_eq(&s.token, token))
        .unwrap_or(false)
}

/// 彻底关闭一个会话:断开跳板链与主连接。
///
/// 必须显式调用:russh 的 `Handle::drop` 只打一条 debug 日志,**不会**关闭连接。
/// 被替换或被遗弃的会话若只靠 drop,会一直占着 TCP 连接与通道接收窗口。
async fn shut_down_session(session: Session) {
    for j in &session.jump_handles {
        let _ = j
            .disconnect(russh::Disconnect::ByApplication, "", "en")
            .await;
    }
    let _ = session
        .handle
        .disconnect(russh::Disconnect::ByApplication, "", "en")
        .await;
}

pub struct Session {
    pub handle: Handle<SshHandler>,
    pub writer: tokio::sync::mpsc::UnboundedSender<Vec<u8>>,
    pub resize_tx: tokio::sync::mpsc::UnboundedSender<(u32, u32)>,
    pub host: Value,
    pub jump_handles: Vec<Handle<SshHandler>>,
    /// 连接代际标识。同一 sessionId 重连时旧会话会被新会话替换,旧数据泵退出后
    /// 只能回收"自己那一代",否则会误删正在使用的新会话。
    pub token: Arc<()>,
}

pub struct SshService {
    pub sessions: AsyncMutex<std::collections::HashMap<String, Session>>,
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
        let handler = SshHandler {
            host_id: host["id"].as_str().unwrap_or("").to_string(),
            key,
            password: host["password"].as_str().unwrap_or("").to_string(),
            store: store.clone(),
            remote_targets: self.remote_targets.clone(),
            remote_pump: None,
        };
        let mut handle = match sock {
            Some(stream) => client::connect_stream(Self::make_config(), stream, handler)
                .await
                .map_err(|e| format!("{}:{}", host_addr, e))?,
            None => {
                let addr = format!("{}:{}", host_addr, port);
                client::connect(Self::make_config(), addr, handler)
                    .await
                    .map_err(|e| format!("{}:{}", host_addr, e))?
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

        let mut handle = self
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

        // 先登记会话再启动数据泵:数据泵会用 token 判断自己是否仍是该会话的主人,
        // 若此时会话尚未登记,首批终端输出会被判定为"非主人"而丢弃。
        //
        // 原子替换:若该 sessionId 已有旧会话(自动重连走的就是这条路径),
        // 必须先显式断开,否则旧 TCP 连接与 shell 通道会永久泄漏
        // (russh 的 Handle::drop 不做任何关闭动作)。
        let token: Arc<()> = Arc::new(());
        let pump_token = token.clone();
        let replaced = {
            let mut sessions = self.sessions.lock().await;
            sessions.insert(
                session_id.clone(),
                Session {
                    handle,
                    writer: writer_tx,
                    resize_tx,
                    host: host_full,
                    jump_handles,
                    token,
                },
            )
        };
        if let Some(old) = replaced {
            self.forget_sftp(&session_id).await; // 旧连接的 SFTP 缓存必须作废
            shut_down_session(old).await;
        }

        // 数据泵:channel → ssh:data / ssh:status 事件。
        // token 用于标识"这一代"连接:同一 sessionId 重连时旧泵可能还在退出途中,
        // 靠它区分自己是否仍是该会话的主人(否则会误删/误报新会话)。
        let pump_app = app.clone();
        let pump_sid = session_id.clone();
        let pump_svc = Arc::clone(self);
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
                            if let Some((cols, rows)) = r {
                                let _ = channel.window_change(cols, rows, 0, 0).await;
                            }
                            continue;
                        }
                        d = writer_rx.recv() => {
                            if let Some(bytes) = d {
                                let _ = channel.data(&bytes[..]).await;
                            }
                            continue;
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
                    if !text.is_empty() && is_owner(&pump_svc, &pump_sid, &pump_token).await {
                        crate::ai::emit_evt(
                            &pump_app,
                            "ssh:data",
                            json!({ "sessionId": pump_sid, "data": text }),
                        );
                    }
                }

                // 4) 通道结束:发退出状态后退出泵
                if let Some(st) = exit {
                    if is_owner(&pump_svc, &pump_sid, &pump_token).await {
                        crate::ai::emit_evt(&pump_app, "ssh:status", st);
                    }
                    break 'pump;
                }
            }

            // 5) 自回收:远端主动断开时,会话必须从 sessions 移除,
            //    否则连接(含跳板链)与通道会一直留在 map 里。
            //    token 不匹配说明本会话已被重连替换,不能动新会话。
            let mut sessions = pump_svc.sessions.lock().await;
            let is_current = sessions
                .get(&pump_sid)
                .map(|s| Arc::ptr_eq(&s.token, &pump_token))
                .unwrap_or(false);
            if is_current {
                if let Some(s) = sessions.remove(&pump_sid) {
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

    pub async fn write(&self, session_id: &str, data: &str) -> Result<(), String> {
        let sessions = self.sessions.lock().await;
        let s = sessions.get(session_id).ok_or("会话不存在或已断开")?;
        s.writer
            .send(data.as_bytes().to_vec())
            .map_err(|_| "会话已断开".to_string())
    }

    pub async fn resize(&self, session_id: &str, cols: u32, rows: u32) -> Result<(), String> {
        let sessions = self.sessions.lock().await;
        let s = sessions.get(session_id).ok_or("会话不存在或已断开")?;
        s.resize_tx
            .send((cols, rows))
            .map_err(|_| "会话已断开".to_string())
    }

    pub async fn exec(&self, session_id: &str, command: &str) -> Result<(i64, String), String> {
        let mut sessions = self.sessions.lock().await;
        let s = sessions.get_mut(session_id).ok_or("会话不存在或已断开")?;
        let mut channel = s
            .handle
            .channel_open_session()
            .await
            .map_err(|e| e.to_string())?;
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
        let sftp = {
            let mut sessions = self.sessions.lock().await;
            let s = sessions.get_mut(session_id).ok_or("会话不存在或已断开")?;
            let mut channel = s
                .handle
                .channel_open_session()
                .await
                .map_err(|e| e.to_string())?;
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
        self.sftp_sessions
            .lock()
            .await
            .insert(session_id.to_string(), sftp.clone());
        Ok(sftp)
    }

    pub async fn direct_tcpip(
        &self,
        session_id: &str,
        dest_host: &str,
        dest_port: u32,
        src_ip: &str,
        src_port: u32,
    ) -> Result<BoxStream, String> {
        let mut sessions = self.sessions.lock().await;
        let s = sessions.get_mut(session_id).ok_or("会话不存在或已断开")?;
        let ch = s
            .handle
            .channel_open_direct_tcpip(dest_host, dest_port, src_ip, src_port)
            .await
            .map_err(|e| e.to_string())?;
        Ok(Box::new(ch.into_stream()) as BoxStream)
    }

    pub async fn remote_forward_listen(
        &self,
        session_id: &str,
        bind_host: &str,
        bind_port: u32,
    ) -> Result<u32, String> {
        let mut sessions = self.sessions.lock().await;
        let s = sessions.get_mut(session_id).ok_or("会话不存在或已断开")?;
        s.handle
            .tcpip_forward(bind_host, bind_port)
            .await
            .map_err(|e| e.to_string())
    }

    pub async fn remote_forward_cancel(&self, session_id: &str, bind_host: &str, bind_port: u32) {
        let mut sessions = self.sessions.lock().await;
        if let Some(s) = sessions.get_mut(session_id) {
            let _ = s.handle.cancel_tcpip_forward(bind_host, bind_port).await;
        }
    }

    pub async fn disconnect(&self, session_id: &str) {
        let mut sessions = self.sessions.lock().await;
        if let Some(s) = sessions.remove(session_id) {
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

    pub async fn find_by_host(&self, host_id: &str) -> Option<String> {
        let sessions = self.sessions.lock().await;
        sessions
            .iter()
            .find(|(_, s)| s.host["id"].as_str() == Some(host_id))
            .map(|(k, _)| k.clone())
    }
}

#[cfg(test)]
mod utf8_test {
    use super::take_utf8;

    /// 完整的 ASCII 应立即全部取出
    #[test]
    fn ascii_passes_through() {
        let mut p = b"hello".to_vec();
        assert_eq!(take_utf8(&mut p), "hello");
        assert!(p.is_empty());
    }

    /// 多字节字符被切成两半时,前一半必须留在缓冲里等下一批,
    /// 不能产出 U+FFFD(这正是"中文跨包变乱码"的根因)。
    #[test]
    fn split_multibyte_is_buffered_not_replaced() {
        let full = "中".as_bytes().to_vec(); // 3 字节
        let mut p = vec![full[0]];
        assert_eq!(take_utf8(&mut p), "", "不完整字符不应产出任何文本");
        assert_eq!(p, vec![full[0]], "不完整字节应留在缓冲");

        // 第二批补齐剩余字节 -> 拼出完整汉字
        p.extend_from_slice(&full[1..]);
        assert_eq!(take_utf8(&mut p), "中");
        assert!(p.is_empty());
    }

    /// 前缀完整 + 尾部残缺:只吐出完整部分,残缺留待下批
    #[test]
    fn partial_tail_is_retained() {
        let mut p = b"abc".to_vec();
        p.extend_from_slice(&"中".as_bytes()[..2]); // 只有 2/3 字节
        assert_eq!(take_utf8(&mut p), "abc");
        assert_eq!(p.len(), 2, "残缺的 2 字节应留存");

        p.push("中".as_bytes()[2]);
        assert_eq!(take_utf8(&mut p), "中");
    }

    /// 4 字节字符(emoji)同样不能被切断
    #[test]
    fn four_byte_sequence_is_buffered() {
        let e = "😀".as_bytes().to_vec(); // 4 字节
        let mut p = e[..3].to_vec();
        assert_eq!(take_utf8(&mut p), "", "3/4 字节时不应产出文本");
        p.push(e[3]);
        assert_eq!(take_utf8(&mut p), "😀");
    }

    /// 逐字节喂入完整字符串,最终结果必须与原文逐字一致
    #[test]
    fn byte_by_byte_reassembly_matches_original() {
        let text = "中文测试 emoji😀 混排 abc";
        let bytes = text.as_bytes();
        let mut p = Vec::new();
        let mut out = String::new();
        for b in bytes {
            p.push(*b);
            out.push_str(&take_utf8(&mut p));
        }
        assert_eq!(out, text, "逐字节重组结果应与原文一致");
        assert!(!out.contains('\u{FFFD}'), "不应出现替换字符");
    }
}
