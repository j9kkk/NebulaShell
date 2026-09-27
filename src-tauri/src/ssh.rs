// SSH 会话服务(russh 实现):密码/私钥/键盘交互认证、跳板链、shell 数据泵、exec、resize、TOFU 指纹
use russh::client::{self, Handle};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::Arc;
use tokio::io::{AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::sync::Mutex as AsyncMutex;

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

    async fn check_server_key(&mut self, key: &russh::keys::key::PublicKey) -> Result<bool, Self::Error> {
        let fp = key.fingerprint(); // russh_keys::key::PublicKey 自带 SHA256 指纹(base64-nopad)
        let known = {
            let data = self.store.data.lock().unwrap();
            data["knownHosts"][self.key.clone()].as_str().map(String::from)
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

    async fn data(&mut self, _channel: russh::ChannelId, _data: &[u8], _session: &mut client::Session) -> Result<(), Self::Error> {
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
                    match tokio::net::TcpStream::connect((dest_host.as_str(), dest_port as u16)).await {
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

pub struct Session {
    pub handle: Handle<SshHandler>,
    pub writer: tokio::sync::mpsc::UnboundedSender<Vec<u8>>,
    pub resize_tx: tokio::sync::mpsc::UnboundedSender<(u32, u32)>,
    pub host: Value,
    pub jump_handles: Vec<Handle<SshHandler>>,
}

pub struct SshService {
    pub sessions: AsyncMutex<std::collections::HashMap<String, Session>>,
    pub store: Arc<crate::config::Store>,
    pub remote_targets: RemoteTargets,
}

impl SshService {
    pub fn new(store: Arc<crate::config::Store>, remote_targets: RemoteTargets) -> Self {
        SshService {
            sessions: AsyncMutex::new(std::collections::HashMap::new()),
            store,
            remote_targets,
        }
    }

    pub fn clone_shared(&self) -> Arc<Self> {
        Arc::new(SshService {
            sessions: AsyncMutex::new(std::collections::HashMap::new()),
            store: self.store.clone(),
            remote_targets: self.remote_targets.clone(),
        })
    }

    fn make_config() -> Arc<client::Config> {
        let mut config = client::Config::default();
        config.keepalive_interval = Some(std::time::Duration::from_secs(8));
        config.keepalive_max = 6;
        Arc::new(config)
    }

    async fn auth(
        handle: &mut Handle<SshHandler>,
        user: &str,
        host: &Value,
    ) -> Result<(), String> {
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
                                .authenticate_keyboard_interactive_respond(vec![password.to_string()])
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
    pub async fn connect<R: tauri::Runtime, E: tauri::Emitter<R> + Clone + Send + Sync + 'static>(
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
            .map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect())
            .unwrap_or_default();

        // 跳板链:逐级 forwardOut 直通流到最终目标
        let mut jump_handles: Vec<Handle<SshHandler>> = Vec::new();
        let mut prev_sock: Option<BoxStream> = None;
        let chain_len = jump_ids.len();
        for (i, jid) in jump_ids.iter().enumerate() {
            let jump = self.store.host_full(jid).map_err(|e| format!("跳板: {}", e))?;
            let jhost = jump["host"].as_str().unwrap_or("").to_string();
            let jport = jump["port"].as_i64().unwrap_or(22);
            let target = if i + 1 < jump_ids.len() {
                self.store.host_full(&jump_ids[i + 1]).map_err(|e| format!("跳板: {}", e))?
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
            .map_err(|e| if chain_len > 0 { format!("经跳板连接 {} 失败: {}", host_addr, e) } else { e })?;

        // shell 通道
        let mut channel = handle.channel_open_session().await.map_err(|e| e.to_string())?;
        channel
            .request_pty(true, "xterm-256color", 100, 30, 0, 0, &[])
            .await
            .map_err(|e| e.to_string())?;
        channel.request_shell(true).await.map_err(|e| e.to_string())?;
        let channel_id = channel.id();
        let (writer_tx, mut writer_rx) = tokio::sync::mpsc::unbounded_channel::<Vec<u8>>();
        let (resize_tx, mut resize_rx) = tokio::sync::mpsc::unbounded_channel::<(u32, u32)>();

        // 数据泵:channel → ssh:data / ssh:status 事件
        let pump_app = app.clone();
        let pump_sid = session_id.clone();
        let pump_host = format!("{}@{}", user, host_addr);
        tokio::spawn(async move {
            loop {
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
                    Some(russh::ChannelMsg::Data { ref data }) => {
                        crate::ai::emit_evt(
                            &pump_app,
                            "ssh:data",
                            json!({ "sessionId": pump_sid, "data": String::from_utf8_lossy(data) }),
                        );
                    }
                    Some(russh::ChannelMsg::ExtendedData { ref data, .. }) => {
                        crate::ai::emit_evt(
                            &pump_app,
                            "ssh:data",
                            json!({ "sessionId": pump_sid, "data": String::from_utf8_lossy(data) }),
                        );
                    }
                    Some(russh::ChannelMsg::ExitStatus { exit_status }) => {
                        crate::ai::emit_evt(
                            &pump_app,
                            "ssh:status",
                            json!({ "sessionId": pump_sid, "state": "exited", "code": exit_status }),
                        );
                        break;
                    }
                    Some(russh::ChannelMsg::Close) | None => {
                        crate::ai::emit_evt(
                            &pump_app,
                            "ssh:status",
                            json!({ "sessionId": pump_sid, "state": "exited" }),
                        );
                        break;
                    }
                    _ => {}
                }
            }
            let _ = pump_host;
        });

        {
            let mut sessions = self.sessions.lock().await;
            sessions.insert(
                session_id.clone(),
                Session {
                    handle,
                    writer: writer_tx,
                    resize_tx,
                    host: host_full,
                    jump_handles,
                },
            );
        }
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
        let mut channel = s.handle.channel_open_session().await.map_err(|e| e.to_string())?;
        channel.exec(true, command).await.map_err(|e| e.to_string())?;
        let mut output = String::new();
        let mut code: i64 = 0;
        loop {
            match channel.wait().await {
                Some(russh::ChannelMsg::Data { ref data }) => {
                    output.push_str(&String::from_utf8_lossy(data));
                }
                Some(russh::ChannelMsg::ExtendedData { ref data, .. }) => {
                    output.push_str(&String::from_utf8_lossy(data));
                }
                Some(russh::ChannelMsg::ExitStatus { exit_status }) => code = exit_status as i64,
                Some(russh::ChannelMsg::Close) | None => break,
                _ => {}
            }
        }
        Ok((code, output))
    }

    pub async fn open_sftp(&self, session_id: &str) -> Result<russh_sftp::client::SftpSession, String> {
        let mut sessions = self.sessions.lock().await;
        let s = sessions.get_mut(session_id).ok_or("会话不存在或已断开")?;
        let mut channel = s.handle.channel_open_session().await.map_err(|e| e.to_string())?;
        channel
            .request_subsystem(true, "sftp")
            .await
            .map_err(|e| format!("请求 sftp 子系统失败: {}", e))?;
        let stream: BoxStream = Box::new(channel.into_stream());
        russh_sftp::client::SftpSession::new(stream)
            .await
            .map_err(|e| format!("打开 SFTP 通道失败: {}", e))
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
        if let Some(mut s) = sessions.remove(session_id) {
            for mut j in s.jump_handles.drain(..) {
                let _ = j
                    .disconnect(russh::Disconnect::ByApplication, "", "en")
                    .await;
            }
            let _ = s
                .handle
                .disconnect(russh::Disconnect::ByApplication, "", "en")
                .await;
        }
    }

    pub async fn session_host_id(&self, session_id: &str) -> Option<String> {
        let sessions = self.sessions.lock().await;
        sessions.get(session_id).map(|s| s.host["id"].as_str().unwrap_or("").to_string())
    }

    pub async fn find_by_host(&self, host_id: &str) -> Option<String> {
        let sessions = self.sessions.lock().await;
        sessions
            .iter()
            .find(|(_, s)| s.host["id"].as_str() == Some(host_id))
            .map(|(k, _)| k.clone())
    }
}
