mod ai;
mod bridge;
mod cloud;
pub mod commands;
pub mod config;
pub mod forward;
mod monitor;
mod session_log;
pub mod sftp;
pub mod signing;
pub mod ssh;
pub mod transfer;

#[cfg(test)]
mod cloud_test;
#[cfg(test)]
mod monitor_test;
#[cfg(test)]
mod signing_test;
#[cfg(test)]
mod ssh_test;
#[cfg(test)]
mod store_test;

use commands::AppState;
use serde_json::json;
use std::collections::HashMap;
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let test_mode = std::env::var("NEBULA_TEST")
        .map(|v| v == "1")
        .unwrap_or(false);
    let data_dir = match std::env::var("NEBULA_USER_DATA") {
        Ok(p) => std::path::PathBuf::from(p),
        Err(_) => dirs::data_dir()
            .unwrap_or_else(std::path::PathBuf::new)
            .join("NebulaShell"),
    };
    let store = Arc::new(config::Store::load(data_dir.clone()));
    let remote_targets = ssh::RemoteTargets::default();
    let ssh = Arc::new(ssh::SshService::new(store.clone(), remote_targets.clone()));
    let test_results: Arc<Mutex<HashMap<String, String>>> = Arc::new(Mutex::new(HashMap::new()));

    let state = AppState {
        store: store.clone(),
        ssh: ssh.clone(),
        forwards: forward::ForwardService::new(remote_targets),
        transfers: Arc::new(transfer::TransferManager::new(
            ssh.clone(),
            data_dir.clone(),
        )),
        transfer_aborts: Arc::new(Mutex::new(HashMap::new())),
        force_exit: AtomicBool::new(false),
        monitors: Mutex::new(HashMap::new()),
        logs: Mutex::new(HashMap::new()),
        ai_aborts: Arc::new(Mutex::new(HashMap::new())),
        batch_aborts: Arc::new(Mutex::new(HashMap::new())),
        test_results: test_results.clone(),
        test_mode,
    };

    tauri::Builder::default()
        .manage(state)
        .invoke_handler(tauri::generate_handler![
            nebula_invoke,
            nebula_test_result,
            nebula_test_pin_window
        ])
        // 有未完成传输任务时拦截窗口关闭:emit 询问事件,由前端确认底座
        // 决定退出(app:exit 置 force_exit 后放行)。无任务时保持原有关闭手感。
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let allow = window
                    .app_handle()
                    .try_state::<AppState>()
                    .map(|state| {
                        let active = state.transfers.list().iter().any(|t| {
                            !matches!(
                                t["stage"].as_str().unwrap_or(""),
                                "done"
                                    | "done-partial"
                                    | "partial"
                                    | "failed"
                                    | "cancelled"
                                    | "interrupted"
                            )
                        });
                        state.force_exit.load(std::sync::atomic::Ordering::SeqCst) || !active
                    })
                    .unwrap_or(true);
                if !allow {
                    api.prevent_close();
                    let count = window
                        .app_handle()
                        .state::<AppState>()
                        .transfers
                        .list()
                        .iter()
                        .filter(|t| {
                            !matches!(
                                t["stage"].as_str().unwrap_or(""),
                                "done"
                                    | "done-partial"
                                    | "partial"
                                    | "failed"
                                    | "cancelled"
                                    | "interrupted"
                            )
                        })
                        .count();
                    ai::emit_evt(
                        window.app_handle(),
                        "app:closeRequest",
                        json!({ "count": count }),
                    );
                }
            }
        })
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
            // 配置去抖落盘:高频小写入(命令历史)只在脏位置位时按周期合并写盘,
            // 避免每敲一条命令就重写整份配置(含加密凭据)。
            let flush_store = store.clone();
            tauri::async_runtime::spawn(async move {
                loop {
                    tokio::time::sleep(std::time::Duration::from_secs(2)).await;
                    flush_store.flush_if_dirty();
                }
            });
            void(&handle);
            Ok(())
        })
        .on_page_load(|webview, payload| {
            if payload.event() == tauri::webview::PageLoadEvent::Finished {
                eprintln!(
                    "[page] loaded: {}",
                    webview.url().map(|u| u.to_string()).unwrap_or_default()
                );
                webview.eval("window.__NB_E2E__ = true; 0").ok();
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| match event {
            // 退出前把未落盘的配置写回,避免去抖窗口内的最后一次变更丢失
            tauri::RunEvent::ExitRequested { .. } => {
                if let Some(state) = app.try_state::<AppState>() {
                    stop_session_logs(&state);
                    state.store.flush_now();
                }
            }
            // macOS 的 ⌘Q(默认菜单)、Dock 退出、注销不经 ExitRequested,直接以
            // Exit 收尾(tao 没有实现 applicationShouldTerminate)。这里再收一次尾:
            // 日志已在上一步排空则为空操作,配置只在仍有脏数据时写盘。
            tauri::RunEvent::Exit => {
                if let Some(state) = app.try_state::<AppState>() {
                    stop_session_logs(&state);
                    state.store.flush_if_dirty();
                }
            }
            _ => {}
        });
}

/// 停止全部会话日志并等待写线程排空队列。可重复调用:日志表取空后再调用为空操作。
fn stop_session_logs(state: &AppState) {
    let logs: Vec<_> = state
        .logs
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .drain()
        .map(|(_, log)| log)
        .collect();
    for log in logs {
        if let Err(error) = log.stop() {
            eprintln!("[log] {}: {}", log.file.display(), error);
        }
    }
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

/// 仅测试模式:主窗口设为"所有 Space 可见"并聚焦。
/// e2e 从后台会话拉起被测实例时,宿主的全屏应用会占住当前 Space,窗口被压在
/// 其它 Space 上(AX `set frontmost` 静默失效,visibilityState 恒为 hidden)
/// —— 窗口跟随所有 Space 后任何桌面状态下可见。独立 command(不进
/// nebula_invoke 的巨型 match):那个 match 里出现新的窗口 drop glue 会把
/// objc2 类型求解推过 trait 递归上限(E0275)。
#[tauri::command]
fn nebula_test_pin_window(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    if !state.test_mode {
        return Err("仅测试模式可用".into());
    }
    let win = app
        .get_webview_window("main")
        .ok_or_else(|| "主窗口不存在".to_string())?;
    let _ = win.set_visible_on_all_workspaces(true);
    let _ = win.show();
    let _ = win.unminimize();
    let _ = win.set_focus();
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
    pub fn start_monitor<R: tauri::Runtime>(&self, app: &tauri::AppHandle<R>, session_id: &str)
    where
        R: 'static,
    {
        // 先回收同 sessionId 的旧任务:tokio 的 JoinHandle drop 只解绑、不取消,
        // 直接覆盖会让自动重连路径上每次重连都多留一个探测循环(实测重连 3 次
        // 后并发探测速率变成 4 倍)。
        self.stop_monitor(session_id);
        let app = app.clone();
        let ssh = self.ssh.clone();
        let sid = session_id.to_string();
        let handle = tauri::async_runtime::spawn(async move {
            let mut prev: Option<serde_json::Value> = None;
            // 速率差分的真实窗口:上次探针执行 → 本次探针执行(sleep/ping/exec 全在其中)。
            // 按固定 3.0s 算会在高 RTT 链路上把网速/磁盘速率系统性高估,这里按实测计时。
            let mut last_probe = std::time::Instant::now();
            loop {
                tokio::time::sleep(std::time::Duration::from_secs(3)).await;
                // 连接延迟:单独对一次最小 exec(echo)计时 —— 通道建立 + 命令往返,
                // 高 RTT 链路上这就是用户敲命令感知到的延迟下界。不与资源探针混测:
                // cat/df 的执行时长随机器负载波动,混进去测的就不是"延迟"了。
                let t0 = std::time::Instant::now();
                let latency_ms = match tokio::time::timeout(
                    std::time::Duration::from_secs(5),
                    ssh.exec(&sid, "echo __NB_PING__"),
                )
                .await
                {
                    Ok(Ok(_)) => t0.elapsed().as_millis() as u64,
                    _ => break,
                };
                let interval_sec = last_probe.elapsed().as_secs_f64().clamp(1.0, 60.0);
                let r = match tokio::time::timeout(
                    std::time::Duration::from_secs(5),
                    ssh.exec(&sid, monitor::PROBE),
                )
                .await
                {
                    Ok(Ok((_, out))) => out,
                    _ => break,
                };
                last_probe = std::time::Instant::now();
                let parsed = monitor::parse_proc(&r, prev.as_ref(), interval_sec);
                if parsed["supported"] == json!(false) {
                    // 非 Linux 主机没有 /proc:资源面板切"不支持"终态,但连接是通的,
                    // 循环继续跑 —— 延迟(echo 往返)对任何 shell 都有意义。
                    // exec 失败(超时/断开)仍走上面分支退出。
                    ai::emit_evt(
                        &app,
                        "ssh:metrics",
                        json!({ "sessionId": sid, "supported": false, "latencyMs": latency_ms }),
                    );
                    continue;
                }
                prev = Some(parsed["raw"].clone());
                ai::emit_evt(
                    &app,
                    "ssh:metrics",
                    json!({ "sessionId": sid, "supported": true, "cpuPct": parsed["cpuPct"], "memPct": parsed["memPct"], "memUsedMB": parsed["memUsedMB"], "memTotalMB": parsed["memTotalMB"], "rxBps": parsed["rxBps"], "txBps": parsed["txBps"], "diskPct": parsed["diskPct"], "diskUsedGB": parsed["diskUsedGB"], "diskTotalGB": parsed["diskTotalGB"], "diskReadBps": parsed["diskReadBps"], "diskWriteBps": parsed["diskWriteBps"], "latencyMs": latency_ms }),
                );
            }
        });
        self.monitors
            .lock()
            .unwrap()
            .insert(session_id.to_string(), handle);
    }

    pub fn stop_monitor(&self, session_id: &str) {
        if let Some(h) = self.monitors.lock().unwrap().remove(session_id) {
            h.abort();
        }
    }
}
