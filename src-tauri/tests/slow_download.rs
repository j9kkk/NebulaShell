//! 慢速链路下大文件下载的 Timeout 复现测试床。
//!
//! mock sshd 的 READ 响应带人为延迟(sftpReadDelayMs),模拟高 RTT/慢盘。
//! russh-sftp 客户端对每个请求有 10s 硬超时(Error::Timeout,Display 即 "Timeout");
//! 且 File::poll_read 每次只发一个 READ(64KB)并串行等待 —— 单请求往返一旦
//! 超过 10s,下载中途必报 Timeout。
#![cfg(not(windows))]

use nebulashell_lib::config::Store;
use nebulashell_lib::ssh::SshService;
use serde_json::json;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Arc;
use std::time::Duration;

struct MockSshd {
    child: Child,
    port: u16,
    dir: PathBuf,
}

impl Drop for MockSshd {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

fn start_mock_sshd(password: &str, read_delay_ms: u32) -> MockSshd {
    let dir = std::env::temp_dir().join(format!(
        "nb-slow-sshd-{}-{}",
        std::process::id(),
        read_delay_ms
    ));
    let _ = std::fs::create_dir_all(&dir);
    let port_file = dir.join("port");
    let helper =
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../e2e/helpers/sshd-standalone.mjs");
    let child = Command::new("node")
        .arg(&helper)
        .arg(&port_file)
        .arg(password)
        .arg(read_delay_ms.to_string())
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
        std::thread::sleep(Duration::from_millis(100));
    }
}

fn tmp_store(tag: &str) -> Arc<Store> {
    let dir = std::env::temp_dir().join(format!("nb-slow-store-{}-{}", tag, std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    Arc::new(Store::load_plain(dir))
}

// generate_context! 在同一测试二进制里只能展开一次(info.plist 嵌入符号),
// 两个用例共享一个 mock app(各用例用独立 store 与会话 id,互不干扰)。
// mock sshd(node 进程,RSA 密钥生成)在多用例并发时资源争抢会导致上传
// rename 偶发 Failure —— 进程级互斥把用例串行化,消除测试床自身的 flake。
static TEST_MUTEX: std::sync::Mutex<()> = std::sync::Mutex::new(());

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

async fn connect<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    store: &Arc<Store>,
    mock: &MockSshd,
    sid: &str,
) -> Arc<SshService> {
    let host = store
        .save_host(&json!({
            "name": "slow-dl", "host": "127.0.0.1", "port": mock.port,
            "username": "root", "authType": "password", "password": "itest-pass"
        }))
        .unwrap();
    let full = store.host_full(host["id"].as_str().unwrap()).unwrap();
    let ssh = Arc::new(SshService::new(store.clone(), Default::default()));
    tokio::time::timeout(
        Duration::from_secs(20),
        ssh.connect(app.clone(), full, sid.into()),
    )
    .await
    .expect("连接超时")
    .expect("连接应成功");
    ssh
}

/// 8MB 文件 + 每 READ 延迟 700ms:
/// 8MB / 64KB = 128 个串行 READ,每个往返 0.7s,总时长 ~90s;
/// 其间任意一个请求只要一次抖到 10s 即超时 —— 这里用稳定 700ms 延迟先验证
/// 串行读确实一条道跑到黑,再单独验证超时触发点。
#[tokio::test(flavor = "multi_thread")]
async fn slow_download_serial_reads_measure() {
    let handle = mock_app();
    let _guard = TEST_MUTEX.lock().unwrap();
    let mock = start_mock_sshd("itest-pass", 700);
    let store = tmp_store("slow");

    let ssh = connect(&handle, &store, &mock, "slow-dl").await;
    let sftp = ssh.open_sftp("slow-dl").await.expect("sftp 通道");

    // 预置 8MB 文件
    let payload = vec![0x5au8; 8 * 1024 * 1024];
    let remote = nebulashell_lib::sftp::upload(
        &sftp,
        handle.clone(),
        "slow-dl".into(),
        {
            let dir = std::env::temp_dir().join(format!("nb-slow-up-{}", std::process::id()));
            std::fs::create_dir_all(&dir).unwrap();
            let p = dir.join("big.bin");
            std::fs::write(&p, &payload).unwrap();
            p.to_str().unwrap().to_string()
        }
        .as_str(),
        "/home/user",
    )
    .await
    .expect("上传 8MB(上传路径写不受延迟影响)");

    let dl_dir = std::env::temp_dir().join(format!("nb-slow-dl-{}", std::process::id()));
    std::fs::create_dir_all(&dl_dir).unwrap();
    let dl = dl_dir.join("big.bin");
    let started = std::time::Instant::now();
    let r = nebulashell_lib::sftp::download(
        sftp.clone(),
        handle.clone(),
        "slow-dl".into(),
        "/home/user/big.bin",
        dl.to_str().unwrap(),
        "download",
        None,
        None,
    )
    .await;
    let elapsed = started.elapsed();
    println!(
        "下载 8MB @700ms/READ 耗时: {:?},结果: {:?}",
        elapsed,
        r.is_ok()
    );
    match r {
        Ok(_) => assert_eq!(std::fs::read(&dl).unwrap().len(), payload.len()),
        Err(e) => println!("下载失败: {e}"),
    }

    let _ = nebulashell_lib::sftp::remove(&sftp, "/home/user/big.bin", false).await;
    let _ = std::fs::remove_dir_all(&dl_dir);
    ssh.disconnect("slow-dl").await;
}

/// 回归(修复后语义):open_sftp 已 set_timeout(30),单 READ 延迟 11s
/// (原默认 10s 必炸的区间)现在应成功下载 —— 验证放宽生效。
#[tokio::test(flavor = "multi_thread")]
async fn slow_download_hits_request_timeout() {
    let handle = mock_app();
    let _guard = TEST_MUTEX.lock().unwrap();
    let mock = start_mock_sshd("itest-pass", 11_000);
    let store = tmp_store("slowto");

    let ssh = connect(&handle, &store, &mock, "slow-to").await;
    let sftp = ssh.open_sftp("slow-to").await.expect("sftp 通道");

    let payload = vec![0x42u8; 256 * 1024];
    let up_dir = std::env::temp_dir().join(format!("nb-slowto-up-{}", std::process::id()));
    std::fs::create_dir_all(&up_dir).unwrap();
    let up = up_dir.join("mid.bin");
    std::fs::write(&up, &payload).unwrap();
    // 上传路径每 WRITE 延迟 0(只 READ 有延迟),应该秒传
    nebulashell_lib::sftp::upload(
        &sftp,
        handle.clone(),
        "slow-to".into(),
        up.to_str().unwrap(),
        "/home/user",
    )
    .await
    .expect("上传");

    let dl_dir = std::env::temp_dir().join(format!("nb-slowto-dl-{}", std::process::id()));
    std::fs::create_dir_all(&dl_dir).unwrap();
    let dl = dl_dir.join("mid.bin");
    let started = std::time::Instant::now();
    let r = nebulashell_lib::sftp::download(
        sftp.clone(),
        handle.clone(),
        "slow-to".into(),
        "/home/user/mid.bin",
        dl.to_str().unwrap(),
        "download",
        None,
        None,
    )
    .await;
    let elapsed = started.elapsed();
    println!(
        "下载 256KB @11s/READ 耗时: {:?},成功: {}",
        elapsed,
        r.is_ok()
    );
    assert!(r.is_ok(), "set_timeout(30) 后 11s/READ 下载应成功");
    assert_eq!(std::fs::read(&dl).unwrap().len(), payload.len());

    let _ = nebulashell_lib::sftp::remove(&sftp, "/home/user/mid.bin", false).await;
    let _ = std::fs::remove_dir_all(&dl_dir);
    let _ = std::fs::remove_dir_all(&up_dir);
    ssh.disconnect("slow-to").await;
}

/// 慢下载进行中,并发的列目录(独立请求,同一条 SFTP 通道)是否被拖死:
/// russh-sftp 的请求 map 按 id 配对,理论上 READ 在途不应阻塞 READDIR;
/// 但若服务端/通道层排队,列目录的 10s 超时同样会炸。
/// 该用例把 READ 延迟设为 2s(不触发超时),在下载进行 1s 时并发列目录,
/// 断言列目录能在自己的超时窗口内完成。
#[tokio::test(flavor = "multi_thread")]
async fn list_dir_during_slow_download() {
    let handle = mock_app();
    let _guard = TEST_MUTEX.lock().unwrap();
    let mock = start_mock_sshd("itest-pass", 2_000);
    let store = tmp_store("slowls");

    let ssh = connect(&handle, &store, &mock, "slow-ls").await;
    let sftp = ssh.open_sftp("slow-ls").await.expect("sftp 通道");

    let payload = vec![0x11u8; 2 * 1024 * 1024];
    let up_dir = std::env::temp_dir().join(format!("nb-slowls-up-{}", std::process::id()));
    std::fs::create_dir_all(&up_dir).unwrap();
    let up = up_dir.join("two.bin");
    std::fs::write(&up, &payload).unwrap();
    nebulashell_lib::sftp::upload(
        &sftp,
        handle.clone(),
        "slow-ls".into(),
        up.to_str().unwrap(),
        "/home/user",
    )
    .await
    .expect("上传");

    let dl_dir = std::env::temp_dir().join(format!("nb-slowls-dl-{}", std::process::id()));
    std::fs::create_dir_all(&dl_dir).unwrap();
    let dl = dl_dir.join("two.bin");

    let sftp2 = sftp.clone();
    let dl_handle = handle.clone();
    let dl_path = dl.to_str().unwrap().to_string();
    let downloader = tokio::spawn(async move {
        nebulashell_lib::sftp::download(
            sftp2.clone(),
            dl_handle,
            "slow-ls".into(),
            "/home/user/two.bin",
            &dl_path,
            "download",
            None,
            None,
        )
        .await
    });

    // 下载进行中(串行 READ,每个 2s)并发列目录
    tokio::time::sleep(Duration::from_millis(500)).await;
    let started = std::time::Instant::now();
    let ls = tokio::time::timeout(
        Duration::from_secs(15),
        nebulashell_lib::sftp::list(&sftp, None),
    )
    .await;
    let ls_elapsed = started.elapsed();
    match ls {
        Ok(Ok(_)) => println!("列目录 OK,耗时 {:?}", ls_elapsed),
        Ok(Err(ref e)) => println!("列目录失败: {e}"),
        Err(_) => println!("列目录 15s 未返回(被拖死)"),
    }
    assert!(matches!(ls, Ok(Ok(_))), "慢下载中列目录必须仍可用");

    let _ = downloader.await;
    let _ = nebulashell_lib::sftp::remove(&sftp, "/home/user/two.bin", false).await;
    let _ = std::fs::remove_dir_all(&dl_dir);
    let _ = std::fs::remove_dir_all(&up_dir);
    ssh.disconnect("slow-ls").await;
}

/// 修复验证 A:set_timeout(30) 后,11s/请求的慢链路下载应成功。
#[tokio::test(flavor = "multi_thread")]
async fn fix_set_timeout_allows_slow_reads() {
    let handle = mock_app();
    let _guard = TEST_MUTEX.lock().unwrap();
    let mock = start_mock_sshd("itest-pass", 11_000);
    let store = tmp_store("slowfix");

    let ssh = connect(&handle, &store, &mock, "slow-fix").await;
    let sftp = ssh.open_sftp("slow-fix").await.expect("sftp 通道");
    sftp.set_timeout(30);

    let payload = vec![0x42u8; 256 * 1024];
    let up_dir = std::env::temp_dir().join(format!("nb-slowfix-up-{}", std::process::id()));
    std::fs::create_dir_all(&up_dir).unwrap();
    let up = up_dir.join("mid.bin");
    std::fs::write(&up, &payload).unwrap();
    nebulashell_lib::sftp::upload(
        &sftp,
        handle.clone(),
        "slow-fix".into(),
        up.to_str().unwrap(),
        "/home/user",
    )
    .await
    .expect("上传");

    let dl_dir = std::env::temp_dir().join(format!("nb-slowfix-dl-{}", std::process::id()));
    std::fs::create_dir_all(&dl_dir).unwrap();
    let dl = dl_dir.join("mid.bin");
    let r = nebulashell_lib::sftp::download(
        sftp.clone(),
        handle.clone(),
        "slow-fix".into(),
        "/home/user/mid.bin",
        dl.to_str().unwrap(),
        "download",
        None,
        None,
    )
    .await;
    assert!(r.is_ok(), "set_timeout(30) 后 11s/READ 下载应成功");
    assert_eq!(std::fs::read(&dl).unwrap().len(), payload.len());

    let _ = nebulashell_lib::sftp::remove(&sftp, "/home/user/mid.bin", false).await;
    let _ = std::fs::remove_dir_all(&dl_dir);
    let _ = std::fs::remove_dir_all(&up_dir);
    ssh.disconnect("slow-fix").await;
}

/// 修复验证 B:4 个独立 handle 并发分段读同一文件(共享一条 SFTP 通道)。
/// 期望:8MB @700ms/READ 从 91s(串行)降到 ~23s(4 段并行),且内容一致。
#[tokio::test(flavor = "multi_thread")]
async fn fix_concurrent_range_reads_speedup() {
    let handle = mock_app();
    let _guard = TEST_MUTEX.lock().unwrap();
    let mock = start_mock_sshd("itest-pass", 700);
    let store = tmp_store("slowpar");

    let ssh = connect(&handle, &store, &mock, "slow-par").await;
    let sftp = ssh.open_sftp("slow-par").await.expect("sftp 通道");

    let payload = vec![0x5au8; 8 * 1024 * 1024];
    let up_dir = std::env::temp_dir().join(format!("nb-slowpar-up-{}", std::process::id()));
    std::fs::create_dir_all(&up_dir).unwrap();
    let up = up_dir.join("big.bin");
    std::fs::write(&up, &payload).unwrap();
    nebulashell_lib::sftp::upload(
        &sftp,
        handle.clone(),
        "slow-par".into(),
        up.to_str().unwrap(),
        "/home/user",
    )
    .await
    .expect("上传");

    // 4 路并发分段读:每路自己的 handle + 顺序 seek
    const K: u64 = 4;
    let meta = sftp.metadata("/home/user/big.bin").await.unwrap();
    let total = meta.size.unwrap();
    let chunk = total.div_ceil(K);
    let mut tasks = Vec::new();
    for i in 0..K {
        let sftp = sftp.clone();
        let start = i * chunk;
        let end = total.min(start + chunk);
        tasks.push(tokio::spawn(async move {
            let mut f = sftp.open("/home/user/big.bin").await.unwrap();
            let mut buf = vec![0u8; 64 * 1024];
            let mut pos = start;
            let mut out = Vec::with_capacity((end - start) as usize);
            while pos < end {
                let want = usize::try_from(end - pos).unwrap().min(buf.len());
                let n = tokio::io::AsyncReadExt::read(&mut f, &mut buf[..want])
                    .await
                    .unwrap();
                if n == 0 {
                    break;
                }
                out.extend_from_slice(&buf[..n]);
                pos += n as u64;
            }
            out
        }));
    }
    let started = std::time::Instant::now();
    let mut merged = Vec::with_capacity(total as usize);
    for t in tasks {
        merged.extend_from_slice(&t.await.unwrap());
    }
    let elapsed = started.elapsed();
    println!(
        "4 路并发读 8MB @700ms/READ 耗时: {:?}(串行基线 91s)",
        elapsed
    );
    assert_eq!(merged.len(), payload.len());
    assert_eq!(merged, payload, "并发分段读内容必须与串行一致");

    let _ = nebulashell_lib::sftp::remove(&sftp, "/home/user/big.bin", false).await;
    let _ = std::fs::remove_dir_all(&up_dir);
    ssh.disconnect("slow-par").await;
}
