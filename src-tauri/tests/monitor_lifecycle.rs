// 监控任务启停的回归测试(黑盒:用服务端观察到的探测速率判定)。
//
// 回归:此前 `start_monitor` 直接 `monitors.insert(...)` 覆盖旧 JoinHandle。
// tokio 的 JoinHandle drop 只解绑、不取消任务,于是自动重连路径上每次重连
// 都多留一个探测循环 —— 实测重连 3 次后并发探测速率变成 4 倍。
//
// 为什么不用"map 长度"断言:insert 会覆盖条目,map 长度始终为 1,
// 但被覆盖的任务仍在后台跑。必须观察外部可测的副作用(探测次数)。
#![cfg(not(windows))]

use nebulashell_lib::commands::AppState;
use nebulashell_lib::config::Store;
use nebulashell_lib::forward::ForwardService;
use serde_json::json;
use std::collections::HashMap;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::Duration;

struct CountingSshd {
    child: Child,
    port: u16,
    count_file: PathBuf,
    dir: PathBuf,
}

impl Drop for CountingSshd {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

impl CountingSshd {
    fn execs(&self) -> i64 {
        std::fs::read_to_string(&self.count_file)
            .ok()
            .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
            .and_then(|v| v["execs"].as_i64())
            .unwrap_or(0)
    }
}

fn start_counting_sshd(tag: &str, password: &str) -> CountingSshd {
    let dir = std::env::temp_dir().join(format!("nb-mon-{}-{}", tag, std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    let _ = std::fs::create_dir_all(&dir);
    let port_file = dir.join("port");
    let count_file = dir.join("count.json");
    let helper = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../e2e/helpers/sshd-counting.mjs");
    let child = Command::new("node")
        .arg(&helper)
        .arg(&port_file)
        .arg(&count_file)
        .arg(password)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .expect("启动 node mock sshd 失败(需要 node)");
    let start = std::time::Instant::now();
    loop {
        if let Ok(p) = std::fs::read_to_string(&port_file) {
            if let Ok(port) = p.trim().parse::<u16>() {
                return CountingSshd {
                    child,
                    port,
                    count_file,
                    dir,
                };
            }
        }
        if start.elapsed() > Duration::from_secs(15) {
            panic!("mock sshd 启动超时");
        }
        std::thread::sleep(Duration::from_millis(200));
    }
}

fn mock_app() -> tauri::AppHandle<tauri::test::MockRuntime> {
    tauri::test::mock_builder()
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .expect("mock app")
        .handle()
        .clone()
}

fn make_state(tag: &str) -> AppState {
    let dir = std::env::temp_dir().join(format!("nb-mon-store-{}-{}", tag, std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    let dir2 = dir.clone();
    let store = Arc::new(Store::load_plain(dir));
    let remote_targets = nebulashell_lib::ssh::RemoteTargets::default();
    let ssh = Arc::new(nebulashell_lib::ssh::SshService::new(
        store.clone(),
        remote_targets.clone(),
    ));
    AppState {
        store: store.clone(),
        ssh: ssh.clone(),
        forwards: ForwardService::new(remote_targets),
        transfers: Arc::new(nebulashell_lib::transfer::TransferManager::new(
            ssh.clone(),
            dir2,
        )),
        transfer_aborts: Arc::new(Mutex::new(HashMap::new())),
        force_exit: std::sync::atomic::AtomicBool::new(false),
        monitors: Mutex::new(HashMap::new()),
        logs: Mutex::new(HashMap::new()),
        ai_aborts: Arc::new(Mutex::new(HashMap::new())),
        batch_aborts: Arc::new(Mutex::new(HashMap::new())),
        test_results: Arc::new(Mutex::new(HashMap::new())),
        test_mode: true,
    }
}

/// 建立真实连接后,反复 start_monitor(模拟自动重连),探测速率不应累积。
///
/// 监控循环每 3s 通过 exec 发一次探测。若旧任务未被 abort,
/// 观察到的探测次数会按"遗留任务数"成倍增长。
#[tokio::test]
async fn repeated_start_monitor_does_not_accumulate_probes() {
    let mock = start_counting_sshd("accum", "itest-pass");
    let state = make_state("accum");
    let app = mock_app();

    let host = state
        .store
        .save_host(&json!({
            "name": "mon-a", "host": "127.0.0.1", "port": mock.port,
            "username": "root", "authType": "password", "password": "itest-pass"
        }))
        .unwrap();
    let full = state.store.host_full(host["id"].as_str().unwrap()).unwrap();
    let sid = "mon-sess";

    tokio::time::timeout(
        Duration::from_secs(20),
        state.ssh.connect(app.clone(), full.clone(), sid.into()),
    )
    .await
    .expect("连接超时")
    .expect("连接应成功");

    // 只启动 1 个监控任务,作为速率基线
    state.start_monitor(&app, sid);
    tokio::time::sleep(Duration::from_secs(7)).await;
    let baseline = mock.execs();
    assert!(
        baseline >= 1,
        "基线期应至少收到 1 次探测(实际 {})",
        baseline
    );

    // 再重复启动 3 次(模拟自动重连):旧任务必须被 abort
    for _ in 0..3 {
        state.start_monitor(&app, sid);
    }
    tokio::time::sleep(Duration::from_secs(2)).await; // 让 abort 生效并进入稳态
    let before = mock.execs();
    tokio::time::sleep(Duration::from_secs(9)).await; // 稳态跨越 ~3 个探测周期
    let during = mock.execs() - before;

    // 1 个任务在 9s 内约 3 次探测;若遗留 4 个任务则约 12 次。
    assert!(
        during <= 6,
        "重复启动 3 次后探测速率应仍是单任务水平(9s 内 ≤6 次),实际 {} 次 —— 旧监控任务未被回收",
        during
    );

    state.stop_monitor(sid);
    state.ssh.disconnect(sid).await;
}
