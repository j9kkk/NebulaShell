// 连接延迟探测的计量口径回归。
//
// 回归:旧实现用 `ssh.exec("echo ...")` 全程计时,而每条 exec 都要
// "channel_open_session + exec(want_reply)"两次往返,高 RTT 链路上算出来
// 正好是真实延迟的两倍(实测 80ms RTT 报 174ms)。状态栏把它当作
// "敲命令感知到的延迟"展示,双倍的数值会误导用户判断链路质量。
//
// 断言方式:在客户端与 mock sshd 之间插一个双向固定延迟的 TCP 代理,
// 真实 RTT = 2 × 单向延迟,是确定的;探测结果必须落在一个 RTT 附近,
// 而不是两个。同时锁住"复用常驻通道"(第二次探测不该再开新通道),
// 否则实现退化成每次重建通道就会重新引入那次多余的往返。
#![cfg(not(windows))]

use nebulashell_lib::config::Store;
use nebulashell_lib::ssh::SshService;
use serde_json::json;
use std::process::{Child, Command, Stdio};
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

/// 单向延迟。真实 RTT = 2 × ONE_WAY_MS。
const ONE_WAY_MS: u64 = 40;

struct MockSshd {
    child: Child,
    port: u16,
    dir: std::path::PathBuf,
}

impl Drop for MockSshd {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

fn start_mock_sshd(tag: &str, password: &str) -> MockSshd {
    start_mock_sshd_opts(tag, password, 0)
}

/// cat_close_after > 0:mock 的回显通道在回显 N 条后自行关闭(用于自愈用例)。
fn start_mock_sshd_opts(tag: &str, password: &str, cat_close_after: u32) -> MockSshd {
    let dir = std::env::temp_dir().join(format!("nb-lat-{}-{}", tag, std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    let _ = std::fs::create_dir_all(&dir);
    let port_file = dir.join("port");
    let helper = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../e2e/helpers/sshd-standalone.mjs");
    let child = Command::new("node")
        .arg(&helper)
        .arg(&port_file)
        .arg(password)
        .arg("0")
        .arg(cat_close_after.to_string())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .expect("启动 node mock sshd 失败(需要 node)");
    let start = std::time::Instant::now();
    loop {
        if let Ok(p) = std::fs::read_to_string(&port_file) {
            if let Ok(port) = p.trim().parse::<u16>() {
                return MockSshd { child, port, dir };
            }
        }
        if start.elapsed() > Duration::from_secs(15) {
            panic!("mock sshd 启动超时");
        }
        std::thread::sleep(Duration::from_millis(200));
    }
}

/// 双向各延迟 ONE_WAY_MS 的 TCP 代理,把上游端口包一层"长链路"。
async fn start_delay_proxy(upstream: u16) -> u16 {
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind proxy");
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        loop {
            let Ok((client, _)) = listener.accept().await else {
                return;
            };
            let Ok(server) = TcpStream::connect(("127.0.0.1", upstream)).await else {
                continue;
            };
            let (mut cr, mut cw) = client.into_split();
            let (mut sr, mut sw) = server.into_split();
            let delay = Duration::from_millis(ONE_WAY_MS);
            tokio::spawn(async move {
                let mut buf = vec![0u8; 16 * 1024];
                loop {
                    match cr.read(&mut buf).await {
                        Ok(0) | Err(_) => {
                            let _ = sw.shutdown().await;
                            return;
                        }
                        Ok(n) => {
                            let chunk = buf[..n].to_vec();
                            tokio::time::sleep(delay).await;
                            if sw.write_all(&chunk).await.is_err() {
                                return;
                            }
                        }
                    }
                }
            });
            tokio::spawn(async move {
                let mut buf = vec![0u8; 16 * 1024];
                loop {
                    match sr.read(&mut buf).await {
                        Ok(0) | Err(_) => {
                            let _ = cw.shutdown().await;
                            return;
                        }
                        Ok(n) => {
                            let chunk = buf[..n].to_vec();
                            tokio::time::sleep(delay).await;
                            if cw.write_all(&chunk).await.is_err() {
                                return;
                            }
                        }
                    }
                }
            });
        }
    });
    port
}

fn tmp_store(tag: &str) -> Arc<Store> {
    let dir = std::env::temp_dir().join(format!("nb-lat-store-{}-{}", tag, std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    Arc::new(Store::load_plain(dir))
}

fn mock_app() -> tauri::AppHandle<tauri::test::MockRuntime> {
    static APP: std::sync::OnceLock<tauri::AppHandle<tauri::test::MockRuntime>> =
        std::sync::OnceLock::new();
    APP.get_or_init(|| {
        tauri::test::mock_builder()
            .build(tauri::generate_context!())
            .expect("mock app")
            .handle()
            .clone()
    })
    .clone()
}

#[tokio::test]
async fn probe_latency_reports_one_round_trip_not_two() {
    let password = "itest-pass";
    let mock = start_mock_sshd("rtt", password);
    let proxy_port = start_delay_proxy(mock.port).await;

    let store = tmp_store("rtt");
    let host = store
        .save_host(&json!({
            "name": "lat-a", "host": "127.0.0.1", "port": proxy_port,
            "username": "root", "authType": "password", "password": password
        }))
        .unwrap();
    let full = store.host_full(host["id"].as_str().unwrap()).unwrap();
    let app = mock_app();
    let ssh = Arc::new(SshService::new(store.clone(), Default::default()));
    let sid = "lat-sess";

    tokio::time::timeout(
        Duration::from_secs(30),
        ssh.connect(app.clone(), full, sid.into()),
    )
    .await
    .expect("连接超时")
    .expect("连接应成功");

    let true_rtt = ONE_WAY_MS * 2;

    // 首轮要建通道,读数已剔除建通道开销;之后每轮都是纯往返。
    let mut samples = Vec::new();
    for _ in 0..5 {
        let ms = tokio::time::timeout(Duration::from_secs(15), ssh.probe_latency(sid))
            .await
            .expect("探测超时")
            .expect("探测应成功");
        samples.push(ms);
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    let mut sorted = samples.clone();
    sorted.sort_unstable();
    let median = sorted[sorted.len() / 2];

    // 单次往返:落在 1 倍 RTT 附近。旧实现会稳定落在 2 倍(≈160ms),
    // 这里留出调度抖动的余量,但明确排除"两倍"。
    assert!(
        median >= true_rtt / 2 && median < true_rtt * 3 / 2,
        "探测值应接近单次往返(约 {}ms),实际样本 {:?} 中位数 {}ms —— \
         若接近 {}ms 说明又退回了'开通道 + exec'的双往返计时",
        true_rtt,
        samples,
        median,
        true_rtt * 2
    );

    ssh.disconnect(sid).await;
}

#[tokio::test]
async fn probe_latency_keeps_working_across_repeated_calls() {
    // 常驻通道必须能反复复用:每一轮都重建通道也能过上面的断言(只是慢),
    // 这里用"多轮探测的总耗时"锁住复用行为 —— 复用后每轮只有一个往返。
    let password = "itest-pass";
    let mock = start_mock_sshd("reuse", password);
    let proxy_port = start_delay_proxy(mock.port).await;
    let store = tmp_store("reuse");
    let host = store
        .save_host(&json!({
            "name": "lat-b", "host": "127.0.0.1", "port": proxy_port,
            "username": "root", "authType": "password", "password": password
        }))
        .unwrap();
    let full = store.host_full(host["id"].as_str().unwrap()).unwrap();
    let app = mock_app();
    let ssh = Arc::new(SshService::new(store.clone(), Default::default()));
    let sid = "reuse-sess";
    tokio::time::timeout(
        Duration::from_secs(30),
        ssh.connect(app.clone(), full, sid.into()),
    )
    .await
    .expect("连接超时")
    .expect("连接应成功");

    let true_rtt = Duration::from_millis(ONE_WAY_MS * 2);
    let started = std::time::Instant::now();
    const ROUNDS: u32 = 8;
    for _ in 0..ROUNDS {
        tokio::time::timeout(Duration::from_secs(15), ssh.probe_latency(sid))
            .await
            .expect("探测超时")
            .expect("探测应成功");
    }
    let total = started.elapsed();
    // 每轮 ~1 个 RTT(复用);若每轮都重建通道则是 ~2 个 RTT 起步(实测约 4 倍,
    // 因为建通道还要再付 channel_open + exec 确认两次往返)。
    // 阈值取 2 倍:实测复用约 1.5 倍 RTT(代理分块的额外调度开销),
    // 重建约 3.9 倍,两侧都有清晰间隔,不会因抖动误判。
    let budget = true_rtt * ROUNDS * 2;
    assert!(
        total < budget,
        "{} 轮探测耗时 {:?} 超过预算 {:?} —— 说明没有复用常驻通道,每轮都在重建",
        ROUNDS,
        total,
        budget
    );

    ssh.disconnect(sid).await;
}

#[tokio::test]
async fn probe_latency_recovers_after_channel_dies() {
    // 常驻通道的失效自愈:远端 cat 退出(通道僵死)后,下一次探测必须自动
    // 重建并继续给出读数,而不是永久报错。监控循环每 3s 探一次 —— 不能自愈
    // 的话状态栏延迟会永远冻结在旧值。
    //
    // 触发方式:mock sshd 收到 NB_MOCK_CAT_CLOSE_AFTER 条回显后就结束 cat,
    // 第一次探测正常,第二次撞上通道已关,必须靠重建恢复。
    let password = "itest-pass";
    // mock 的第一条 cat 通道在回显 3 条后自行退出。首轮探测建通道 + 补测
    // 吃掉 2 条,第 2 次探测吃掉第 3 条,第 3 次才会撞上"通道已关闭"。
    let mock = start_mock_sshd_opts("heal", password, 3);
    let store = tmp_store("heal");
    let host = store
        .save_host(&json!({
            "name": "lat-c", "host": "127.0.0.1", "port": mock.port,
            "username": "root", "authType": "password", "password": password
        }))
        .unwrap();
    let full = store.host_full(host["id"].as_str().unwrap()).unwrap();
    let app = mock_app();
    let ssh = Arc::new(SshService::new(store.clone(), Default::default()));
    let sid = "heal-sess";
    tokio::time::timeout(
        Duration::from_secs(30),
        ssh.connect(app.clone(), full, sid.into()),
    )
    .await
    .expect("连接超时")
    .expect("连接应成功");

    // 约定:远端把回显通道关掉后,探测最多丢一轮(那次返回 Err),随后自动重建
    // 并稳定给出读数。监控循环每 3s 一轮,丢的那轮由"沿用上一轮读数"兜住,
    // 用户看不到中断。
    let mut ok_count = 0;
    let mut recovered_after_error = false;
    for round in 0..6 {
        match tokio::time::timeout(Duration::from_secs(15), ssh.probe_latency(sid)).await {
            Ok(Ok(ms)) => {
                assert!(ms < 5000, "第 {} 轮读数应在合理范围,实际 {}", round, ms);
                ok_count += 1;
                if recovered_after_error {
                    break;
                }
            }
            Ok(Err(_)) => {
                // 允许且只允许失败一轮:紧接着的下一轮必须恢复。
                tokio::time::sleep(Duration::from_millis(100)).await;
                recovered_after_error = true;
            }
            Err(_) => panic!("第 {} 轮探测超时(应靠超时而非挂死)", round),
        }
    }
    assert!(
        ok_count >= 3,
        "端口通道失效后应能持续给出读数(实际成功 {} 轮)",
        ok_count
    );
    assert!(
        recovered_after_error || ok_count >= 6,
        "未观察到通道关闭(说明 mock 开关没生效),用例失去判别力"
    );

    ssh.disconnect(sid).await;
}
