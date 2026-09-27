mod ai;
mod bridge;
mod cloud;
mod commands;
pub mod config;
mod forward;
pub mod monitor;
pub mod sftp;
pub mod signing;
pub mod ssh;

#[cfg(test)]
mod monitor_test;
#[cfg(test)]
mod signing_test;
#[cfg(test)]
mod store_test;

use commands::AppState;
use tauri::Manager;
use serde_json::json;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let test_mode = std::env::var("NEBULA_TEST").map(|v| v == "1").unwrap_or(false);
    let data_dir = match std::env::var("NEBULA_USER_DATA") {
        Ok(p) => std::path::PathBuf::from(p),
        Err(_) => dirs::data_dir().unwrap_or_else(std::path::PathBuf::new).join("NebulaShell"),
    };
    let store = Arc::new(config::Store::load(data_dir.clone()));
    let remote_targets = ssh::RemoteTargets::default();
    let ssh = Arc::new(ssh::SshService::new(store.clone(), remote_targets.clone()));
    let test_results: Arc<Mutex<HashMap<String, String>>> = Arc::new(Mutex::new(HashMap::new()));

    let state = AppState {
        store: store.clone(),
        ssh: ssh.clone(),
        forwards: forward::ForwardService::new(remote_targets),
        monitors: Mutex::new(HashMap::new()),
        logs: Mutex::new(HashMap::new()),
        ai_aborts: Arc::new(Mutex::new(HashMap::new())),
        test_results: test_results.clone(),
        test_mode,
    };

    tauri::Builder::default()
        .manage(state)
        .invoke_handler(tauri::generate_handler![nebula_invoke, nebula_test_result])
        .setup(move |app| {
            let handle = app.handle().clone();
            if test_mode {
                // 测试桥:HTTP eval 通道 + 端口写文件
                let port_file = std::env::var("NEBULA_TEST_BRIDGE_FILE")
                    .unwrap_or_else(|_| "/tmp/nebula-bridge.port".to_string());
                let app_handle = handle.clone();
                let results = test_results.clone();
                tauri::async_runtime::spawn(async move {
                    bridge::start_bridge(app_handle, port_file, results).await;
                });
            }
            void(&handle);
            Ok(())
        })
        .on_page_load(|webview, payload| {
            if payload.event() == tauri::webview::PageLoadEvent::Finished {
                eprintln!("[page] loaded: {}", webview.url().map(|u| u.to_string()).unwrap_or_default());
                webview.eval("window.__NB_E2E__ = true; 0").ok();
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

fn void<T>(_: T) {}

#[tauri::command]
fn nebula_test_result(
    state: tauri::State<'_, AppState>,
    id: String,
    value: String,
) -> Result<(), String> {
    state.test_results.lock().unwrap().insert(id, value);
    Ok(())
}

#[tauri::command]
async fn nebula_invoke(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    channel: String,
    payload: serde_json::Value,
) -> Result<serde_json::Value, String> {
    commands::nebula_invoke(app, state, channel.replace("__", ":"), payload).await
}

// 监控任务管理(随连接启停,3s 采样)
impl AppState {
    pub fn start_monitor(&self, app: &tauri::AppHandle, session_id: &str) {
        let app = app.clone();
        let ssh = self.ssh.clone();
        let sid = session_id.to_string();
        let handle = tauri::async_runtime::spawn(async move {
            let mut prev: Option<serde_json::Value> = None;
            loop {
                tokio::time::sleep(std::time::Duration::from_secs(3)).await;
                let r = match tokio::time::timeout(
                    std::time::Duration::from_secs(5),
                    ssh.exec(&sid, monitor::PROBE),
                )
                .await
                {
                    Ok(Ok((_, out))) => out,
                    _ => break,
                };
                let parsed = monitor::parse_proc(&r, prev.as_ref(), 3.0);
                if parsed["supported"] == json!(false) {
                    ai::emit_evt(&app, "ssh:metrics", json!({ "sessionId": sid, "supported": false }));
                    break;
                }
                prev = Some(parsed["raw"].clone());
                ai::emit_evt(
                    &app,
                    "ssh:metrics",
                    json!({ "sessionId": sid, "supported": true, "cpuPct": parsed["cpuPct"], "memPct": parsed["memPct"], "memUsedMB": parsed["memUsedMB"], "memTotalMB": parsed["memTotalMB"], "rxBps": parsed["rxBps"], "txBps": parsed["txBps"], "diskPct": parsed["diskPct"], "diskUsedGB": parsed["diskUsedGB"], "diskTotalGB": parsed["diskTotalGB"], "diskReadBps": parsed["diskReadBps"], "diskWriteBps": parsed["diskWriteBps"] }),
                );
            }
        });
        self.monitors.lock().unwrap().insert(session_id.to_string(), handle);
    }

    pub fn stop_monitor(&self, session_id: &str) {
        if let Some(h) = self.monitors.lock().unwrap().remove(session_id) {
            h.abort();
        }
    }
}
