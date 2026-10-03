// 端口转发:本地(L)/远程(R)/动态 SOCKS5(D)
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

use crate::ssh::AsyncReadWrite;

pub struct RunningEntry {
    pub session_id: String,
    pub kind: char,
    pub bind_host: String,
    pub bound_port: u32,
    pub task: tokio::task::JoinHandle<()>,
    pub remote_forward: Option<crate::ssh::RemoteForward>,
}

fn entry_is_running(entry: &RunningEntry) -> bool {
    // Remote forwarding is registered on the SSH channel, not the placeholder task.
    entry.kind == 'R' || !entry.task.is_finished()
}

fn entry_runtime_state(entry: &RunningEntry) -> Value {
    json!({
        "running": entry_is_running(entry), "bindHost": entry.bind_host,
        "port": entry.bound_port, "type": entry.kind.to_string(),
        "sessionId": entry.session_id,
    })
}

pub struct ForwardService {
    pub running: Mutex<HashMap<String, RunningEntry>>,
    pub remote_targets: crate::ssh::RemoteTargets, // "bindHost:port" -> (destHost, destPort, ruleId)
}

#[cfg(test)]
mod runtime_state_tests {
    use super::*;

    #[tokio::test]
    async fn runtime_state_reports_allocated_port_and_actual_bind_address() {
        let service = ForwardService::new(Arc::new(Mutex::new(HashMap::new())));
        service.running.lock().unwrap().insert(
            "rule".into(),
            RunningEntry {
                session_id: "session".into(),
                kind: 'L',
                bind_host: "127.0.0.1".into(),
                bound_port: 32145,
                task: tokio::spawn(std::future::pending()),
                remote_forward: None,
            },
        );
        let value = service.runtime_state("rule");
        assert_eq!(value["running"], true);
        assert_eq!(value["port"], 32145);
        assert_eq!(value["bindHost"], "127.0.0.1");
        assert_eq!(service.runtime_states(&["rule".into()])["rule"], value);
        assert_eq!(service.runtime_state("missing")["running"], false);
        service
            .running
            .lock()
            .unwrap()
            .remove("rule")
            .unwrap()
            .task
            .abort();
    }

    #[tokio::test]
    async fn finished_listener_is_stopped_but_remote_registration_is_running() {
        let task = tokio::spawn(async {});
        while !task.is_finished() {
            tokio::task::yield_now().await;
        }
        let mut entry = RunningEntry {
            session_id: "session".into(),
            kind: 'D',
            bind_host: "::1".into(),
            bound_port: 12345,
            task,
            remote_forward: None,
        };
        assert!(!entry_is_running(&entry));
        entry.kind = 'R';
        assert!(entry_is_running(&entry));
    }
}

pub fn emit_state(app: &tauri::AppHandle, rule_id: &str, running: bool, port: u32) {
    crate::ai::emit_evt(
        app,
        "forward:state",
        json!({ "ruleId": rule_id, "running": running, "port": port }),
    );
}

async fn pump<T1: AsyncReadWrite + 'static, T2: AsyncReadWrite + 'static>(mut a: T1, mut b: T2) {
    let (mut ra, mut wa) = tokio::io::split(a);
    let (mut rb, mut wb) = tokio::io::split(b);
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

impl ForwardService {
    pub fn new(remote_targets: crate::ssh::RemoteTargets) -> Self {
        ForwardService {
            running: Mutex::new(HashMap::new()),
            remote_targets,
        }
    }

    pub fn is_running(&self, rule_id: &str) -> bool {
        self.running
            .lock()
            .unwrap()
            .get(rule_id)
            .map_or(false, entry_is_running)
    }

    pub fn states(&self, ids: &[String]) -> Value {
        let running = self.running.lock().unwrap();
        let mut out = serde_json::Map::new();
        for id in ids {
            out.insert(
                id.clone(),
                json!(running.get(id).map_or(false, entry_is_running)),
            );
        }
        Value::Object(out)
    }

    /// Rich state for commands/UI: configured port 0 is not the listening port.
    pub fn runtime_states(&self, ids: &[String]) -> Value {
        let running = self.running.lock().unwrap();
        let mut out = serde_json::Map::new();
        for id in ids {
            out.insert(
                id.clone(),
                running
                    .get(id)
                    .map_or_else(|| json!({ "running": false }), entry_runtime_state),
            );
        }
        Value::Object(out)
    }

    pub fn runtime_state(&self, id: &str) -> Value {
        self.running
            .lock()
            .unwrap()
            .get(id)
            .map_or_else(|| json!({ "running": false }), entry_runtime_state)
    }

    fn emit_runtime_state(&self, app: &tauri::AppHandle, rule_id: &str) {
        let mut value = self.runtime_state(rule_id);
        value["ruleId"] = json!(rule_id);
        crate::ai::emit_evt(app, "forward:state", value);
    }

    pub async fn start(
        &self,
        app: tauri::AppHandle,
        ssh: Arc<crate::ssh::SshService>,
        rule: &Value,
    ) -> Result<u32, String> {
        let rule_id = rule["id"].as_str().unwrap_or("").to_string();
        if self.is_running(&rule_id) {
            return Err("规则已在运行".into());
        }
        let kind = rule["type"].as_str().unwrap_or("L").to_string();
        let session_id = rule["hostId"]
            .as_str()
            .and_then(|hid| futures::executor::block_on(ssh.find_by_host(hid)))
            .ok_or("该主机会话未连接,无法建立转发")?;
        let bind_host = rule["bindHost"].as_str().unwrap_or("127.0.0.1").to_string();
        let bind_port = rule["bindPort"].as_u64().unwrap_or(0) as u32;

        match kind.as_str() {
            "L" => {
                let dest_host = rule["destHost"].as_str().unwrap_or("").to_string();
                let dest_port = rule["destPort"].as_u64().unwrap_or(0) as u32;
                let listener = TcpListener::bind((bind_host.as_str(), bind_port as u16))
                    .await
                    .map_err(|e| format!("本地监听失败: {}", e))?;
                let bound_addr = listener.local_addr().map_err(|e| e.to_string())?;
                let bound_port = bound_addr.port() as u32;
                let bind_host = bound_addr.ip().to_string();
                let sid = session_id.clone();
                let rid = rule_id.clone();
                let task = tokio::spawn(async move {
                    loop {
                        let (sock, _) = match listener.accept().await {
                            Ok(v) => v,
                            Err(_) => break,
                        };
                        let stream = match ssh
                            .direct_tcpip(&sid, &dest_host, dest_port, "127.0.0.1", 0)
                            .await
                        {
                            Ok(s) => s,
                            Err(_) => continue,
                        };
                        tokio::spawn(pump(sock, stream));
                    }
                    let _ = rid;
                });
                self.running.lock().unwrap().insert(
                    rule_id.clone(),
                    RunningEntry {
                        session_id,
                        kind: 'L',
                        bind_host,
                        bound_port,
                        task,
                        remote_forward: None,
                    },
                );
                self.emit_runtime_state(&app, &rule_id);
                Ok(bound_port)
            }
            "D" => {
                let listener = TcpListener::bind((bind_host.as_str(), bind_port as u16))
                    .await
                    .map_err(|e| format!("SOCKS 监听失败: {}", e))?;
                let bound_addr = listener.local_addr().map_err(|e| e.to_string())?;
                let bound_port = bound_addr.port() as u32;
                let bind_host = bound_addr.ip().to_string();
                let ssh2 = ssh.clone();
                let sid = session_id.clone();
                let rid = rule_id.clone();
                let task = tokio::spawn(async move {
                    loop {
                        let (mut sock, _) = match listener.accept().await {
                            Ok(v) => v,
                            Err(_) => break,
                        };
                        let ssh = ssh2.clone();
                        let sid2 = sid.clone();
                        tokio::spawn(async move {
                            // SOCKS5 握手:无认证 + CONNECT
                            let mut head = [0u8; 2];
                            if sock.read_exact(&mut head).await.is_err() {
                                return;
                            }
                            if head[1] < 1 {
                                return;
                            }
                            let mut methods = vec![0u8; head[1] as usize];
                            if sock.read_exact(&mut methods).await.is_err() {
                                return;
                            }
                            if !methods.contains(&0) {
                                let _ = sock.write_all(&[5, 0xff]).await;
                                return;
                            }
                            let _ = sock.write_all(&[5, 0]).await;
                            let mut req = [0u8; 4];
                            if sock.read_exact(&mut req).await.is_err() {
                                return;
                            }
                            let (host, port) = match req[3] {
                                1 => {
                                    let mut ip = [0u8; 4];
                                    if sock.read_exact(&mut ip).await.is_err() {
                                        return;
                                    }
                                    let mut p = [0u8; 2];
                                    if sock.read_exact(&mut p).await.is_err() {
                                        return;
                                    }
                                    (
                                        format!("{}.{}.{}.{}", ip[0], ip[1], ip[2], ip[3]),
                                        u16::from_be_bytes(p),
                                    )
                                }
                                3 => {
                                    let mut l = [0u8; 1];
                                    if sock.read_exact(&mut l).await.is_err() {
                                        return;
                                    }
                                    let mut name = vec![0u8; l[0] as usize];
                                    if sock.read_exact(&mut name).await.is_err() {
                                        return;
                                    }
                                    let mut p = [0u8; 2];
                                    if sock.read_exact(&mut p).await.is_err() {
                                        return;
                                    }
                                    (
                                        String::from_utf8_lossy(&name).to_string(),
                                        u16::from_be_bytes(p),
                                    )
                                }
                                _ => return,
                            };
                            let _ = sock.write_all(&[5, 0, 0, 1, 0, 0, 0, 0, 0, 0]).await;
                            if let Ok(stream) = ssh
                                .direct_tcpip(&sid2, &host, port as u32, "127.0.0.1", 0)
                                .await
                            {
                                pump(sock, stream).await;
                            }
                        });
                    }
                    let _ = rid;
                });
                self.running.lock().unwrap().insert(
                    rule_id.clone(),
                    RunningEntry {
                        session_id,
                        kind: 'D',
                        bind_host,
                        bound_port,
                        task,
                        remote_forward: None,
                    },
                );
                self.emit_runtime_state(&app, &rule_id);
                Ok(bound_port)
            }
            "R" => {
                let dest_host = rule["destHost"].as_str().unwrap_or("").to_string();
                let dest_port = rule["destPort"].as_u64().unwrap_or(0) as u32;
                let (bound_port, remote_forward) = ssh
                    .remote_forward_listen(&session_id, &bind_host, bind_port)
                    .await?;
                self.remote_targets.lock().unwrap().insert(
                    format!("{}:{}", bind_host, bound_port),
                    (dest_host.clone(), dest_port, rule_id.clone()),
                );
                self.running.lock().unwrap().insert(
                    rule_id.clone(),
                    RunningEntry {
                        session_id,
                        kind: 'R',
                        bind_host,
                        bound_port,
                        task: tokio::spawn(async {}),
                        remote_forward: Some(remote_forward),
                    },
                );
                self.emit_runtime_state(&app, &rule_id);
                Ok(bound_port)
            }
            other => Err(format!("未知转发类型: {}", other)),
        }
    }

    pub fn stop(
        &self,
        app: &tauri::AppHandle,
        _ssh: Arc<crate::ssh::SshService>,
        rule_id: &str,
    ) -> bool {
        let entry = self.running.lock().unwrap().remove(rule_id);
        match entry {
            Some(e) => {
                e.task.abort();
                if e.kind == 'R' {
                    self.remote_targets
                        .lock()
                        .unwrap()
                        .remove(&format!("{}:{}", e.bind_host, e.bound_port));
                    if let Some(remote_forward) = e.remote_forward {
                        tokio::spawn(remote_forward.cancel());
                    }
                }
                emit_state(app, rule_id, false, e.bound_port);
                true
            }
            None => false,
        }
    }

    pub fn stop_by_session(
        &self,
        app: &tauri::AppHandle,
        ssh: Arc<crate::ssh::SshService>,
        session_id: &str,
    ) {
        let ids: Vec<String> = self
            .running
            .lock()
            .unwrap()
            .iter()
            .filter(|(_, e)| e.session_id == session_id)
            .map(|(k, _)| k.clone())
            .collect();
        for id in ids {
            self.stop(app, ssh.clone(), &id);
        }
    }
}
