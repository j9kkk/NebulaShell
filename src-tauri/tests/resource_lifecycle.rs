// 资源生命周期回归测试:确认"连接/通道不泄漏"与"多字节 UTF-8 不被包边界切断"。
//
// 这两个缺陷的共同点是:短测试看不出来,只有在重连/分包场景下才暴露。
// 因此断言直接对准服务端侧的真实连接数与通道数(而非内存,后者会被共享页噪声淹没)。
#![cfg(not(windows))]

use nebulashell_lib::config::Store;
use nebulashell_lib::ssh::SshService;
use serde_json::{json, Value};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Arc;
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
    fn counts(&self) -> Value {
        std::fs::read_to_string(&self.count_file)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or(json!({}))
    }
    fn clients(&self) -> i64 {
        self.counts()["clients"].as_i64().unwrap_or(-1)
    }
    fn shells(&self) -> i64 {
        self.counts()["shells"].as_i64().unwrap_or(-1)
    }
    fn sftp_opens(&self) -> i64 {
        self.counts()["sftpOpens"].as_i64().unwrap_or(-1)
    }
    /// 轮询等待条件成立,避免依赖固定 sleep 造成 flaky。
    async fn wait_until<F: Fn(&Value) -> bool>(&self, secs: u64, pred: F) -> bool {
        let start = std::time::Instant::now();
        while start.elapsed() < Duration::from_secs(secs) {
            if pred(&self.counts()) {
                return true;
            }
            tokio::time::sleep(Duration::from_millis(200)).await;
        }
        pred(&self.counts())
    }
}

fn start_counting_sshd(tag: &str, password: &str) -> CountingSshd {
    let dir = std::env::temp_dir().join(format!("nb-count-{}-{}", tag, std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    let _ = std::fs::create_dir_all(&dir);
    let port_file = dir.join("port");
    let count_file = dir.join("count.json");
    let helper =
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../tests/helpers/sshd-counting.mjs");
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

fn tmp_store(tag: &str) -> Arc<Store> {
    let dir = std::env::temp_dir().join(format!("nb-count-store-{}-{}", tag, std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    Arc::new(Store::load_plain(dir))
}

fn mock_app() -> tauri::AppHandle<tauri::test::MockRuntime> {
    tauri::test::mock_builder()
        .build(tauri::generate_context!())
        .expect("mock app")
        .handle()
        .clone()
}

/// 同一 sessionId 反复重连,旧连接必须被显式关闭。
///
/// 回归:此前 `sessions.insert` 直接覆盖旧 Session,而 russh 的 `Handle::drop`
/// 只打日志不关连接 —— 每次自动重连都遗弃一条 TCP 连接 + shell 通道。
#[tokio::test]
async fn reconnect_same_session_id_does_not_leak_connections() {
    let mock = start_counting_sshd("reconnect", "itest-pass");
    let store = tmp_store("reconnect");
    let host = store
        .save_host(&json!({
            "name": "leak-a", "host": "127.0.0.1", "port": mock.port,
            "username": "root", "authType": "password", "password": "itest-pass"
        }))
        .unwrap();
    let full = store.host_full(host["id"].as_str().unwrap()).unwrap();
    let app = mock_app();
    let ssh = Arc::new(SshService::new(store.clone(), Default::default()));
    let sid = "leak-sess";

    // 首连
    tokio::time::timeout(
        Duration::from_secs(20),
        ssh.connect(app.clone(), full.clone(), sid.into()),
    )
    .await
    .expect("连接超时")
    .expect("首连应成功");
    assert!(
        mock.wait_until(10, |c| c["clients"].as_i64() == Some(1))
            .await,
        "首连后应有 1 条连接,实际 {:?}",
        mock.counts()
    );

    // 复用同一 sessionId 重连 4 次(模拟自动重连路径)
    for i in 1..=4 {
        tokio::time::timeout(
            Duration::from_secs(20),
            ssh.connect(app.clone(), full.clone(), sid.into()),
        )
        .await
        .unwrap_or_else(|_| panic!("第 {} 次重连超时", i))
        .unwrap_or_else(|e| panic!("第 {} 次重连失败: {}", i, e));
    }

    // 关键断言:服务端应只剩 1 条连接、1 个 shell 通道
    let ok = mock
        .wait_until(15, |c| {
            c["clients"].as_i64() == Some(1) && c["shells"].as_i64() == Some(1)
        })
        .await;
    let final_counts = mock.counts();
    assert!(
        ok,
        "重连 4 次后应只剩 1 连接/1 通道,实际 {:?}(说明旧连接未被关闭)",
        final_counts
    );

    // 断开后应归零
    ssh.disconnect(sid).await;
    assert!(
        mock.wait_until(15, |c| c["clients"].as_i64() == Some(0))
            .await,
        "disconnect 后连接应归零,实际 {:?}",
        mock.counts()
    );
}

/// 远端主动结束 shell 后,本地 sessions 表应自我回收(不能留着连接)。
///
/// 回归:此前数据泵收到 Close 只 break 退出,不从 sessions 移除,
/// 留下的连接靠 keepalive 一直在跑,并在 SFTP/转发等路径上继续被使用。
#[tokio::test]
async fn remote_close_reclaims_session() {
    let mock = start_counting_sshd("remoteclose", "itest-pass");
    let store = tmp_store("remoteclose");
    let host = store
        .save_host(&json!({
            "name": "rc-a", "host": "127.0.0.1", "port": mock.port,
            "username": "root", "authType": "password", "password": "itest-pass"
        }))
        .unwrap();
    let full = store.host_full(host["id"].as_str().unwrap()).unwrap();
    let app = mock_app();
    let ssh = Arc::new(SshService::new(store.clone(), Default::default()));
    let sid = "rc-sess";

    tokio::time::timeout(
        Duration::from_secs(20),
        ssh.connect(app.clone(), full, sid.into()),
    )
    .await
    .expect("连接超时")
    .expect("连接应成功");
    assert!(
        mock.wait_until(10, |c| c["clients"].as_i64() == Some(1))
            .await,
        "连接后应有 1 条连接,实际 {:?}",
        mock.counts()
    );

    // 让远端 shell 主动结束:mock sshd 的 `exit` 命令会 stream.end()
    ssh.write(sid, "exit\r").await.expect("写入 exit");

    // 数据泵应观察到 Close → 发 ssh:status(exited) → 自我回收连接
    assert!(
        mock.wait_until(20, |c| c["clients"].as_i64() == Some(0))
            .await,
        "远端关闭 shell 后本地应自我回收连接,实际 {:?}(说明数据泵未回收会话)",
        mock.counts()
    );

    // 回收后该会话在服务侧应不可用
    let r = ssh.write(sid, "echo hi\r").await;
    assert!(r.is_err(), "会话已回收,写入应失败");
}

/// 同一会话的多次 SFTP 操作应复用同一条 SFTP 通道,而不是每次重开。
///
/// 回归:此前 `sftp_op` 每次调用都 `open_sftp`,即一次完整的
/// channel_open_session + sftp 子系统协商;文件面板每次列目录都会触发。
#[tokio::test]
async fn sftp_operations_reuse_single_channel() {
    let mock = start_counting_sshd("sftpreuse", "itest-pass");
    let store = tmp_store("sftpreuse");
    let host = store
        .save_host(&json!({
            "name": "sf-a", "host": "127.0.0.1", "port": mock.port,
            "username": "root", "authType": "password", "password": "itest-pass"
        }))
        .unwrap();
    let full = store.host_full(host["id"].as_str().unwrap()).unwrap();
    let app = mock_app();
    let ssh = Arc::new(SshService::new(store.clone(), Default::default()));
    let sid = "sf-sess";

    tokio::time::timeout(
        Duration::from_secs(20),
        ssh.connect(app.clone(), full, sid.into()),
    )
    .await
    .expect("连接超时")
    .expect("连接应成功");

    // 连续 5 次取 SFTP 句柄并各做一次列目录
    for i in 0..5 {
        let sftp = ssh.open_sftp(sid).await.expect("sftp 通道");
        let listing = nebulashell_lib::sftp::list(&sftp, None)
            .await
            .unwrap_or_else(|e| panic!("第 {} 次列目录失败: {}", i, e));
        assert!(listing["entries"].to_string().contains("README.md"));
    }

    let opens = mock.sftp_opens();
    assert_eq!(
        opens, 1,
        "同一会话的 5 次 SFTP 操作应只开 1 条 sftp 通道(实际 {} 条)—— 说明未复用",
        opens
    );

    // 断开后再打开应是新通道(缓存已随连接作废)
    ssh.disconnect(sid).await;
    tokio::time::timeout(
        Duration::from_secs(20),
        ssh.connect(
            app.clone(),
            store.host_full(host["id"].as_str().unwrap()).unwrap(),
            sid.into(),
        ),
    )
    .await
    .expect("重连超时")
    .expect("重连应成功");
    let sftp = ssh.open_sftp(sid).await.expect("sftp 通道");
    nebulashell_lib::sftp::list(&sftp, None)
        .await
        .expect("列目录");
    assert_eq!(mock.sftp_opens(), 2, "重连后应重新开通道(旧缓存必须已作废)");

    ssh.disconnect(sid).await;
}

/// 多字节 UTF-8 被 SSH 分包切开时,终端数据不应出现 U+FFFD。
///
/// 回归:此前对每条 `ChannelMsg` 独立调用 `String::from_utf8_lossy`,
/// 一个汉字 3 字节若跨两条消息,两半都会变成替换字符。
#[tokio::test]
async fn multibyte_utf8_survives_chunk_boundary() {
    let mock = start_counting_sshd("utf8", "itest-pass");
    let store = tmp_store("utf8");
    let host = store
        .save_host(&json!({
            "name": "u8-a", "host": "127.0.0.1", "port": mock.port,
            "username": "root", "authType": "password", "password": "itest-pass"
        }))
        .unwrap();
    let full = store.host_full(host["id"].as_str().unwrap()).unwrap();
    let app = mock_app();
    let ssh = Arc::new(SshService::new(store.clone(), Default::default()));
    let sid = "u8-sess";

    tokio::time::timeout(
        Duration::from_secs(20),
        ssh.connect(app.clone(), full, sid.into()),
    )
    .await
    .expect("连接超时")
    .expect("连接应成功");

    // mock sshd 的 `utf8split` 会把 "中文测试" 的每个字节分开发送
    let (_, out) = tokio::time::timeout(Duration::from_secs(20), ssh.exec(sid, "utf8split"))
        .await
        .expect("exec 超时")
        .expect("exec 应成功");

    assert!(
        !out.contains('\u{FFFD}'),
        "多字节字符被包边界切断产生了替换字符: {:?}",
        out
    );
    assert!(
        out.contains("中文测试"),
        "应完整还原中文,实际输出: {:?}",
        out
    );

    ssh.disconnect(sid).await;
}
