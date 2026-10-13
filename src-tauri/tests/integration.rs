// 集成测试(真实 SSH 协议端到端):拉起 node mock sshd,验证
// 连接认证 / exec / SFTP 上传下载删除全链路。事件经 mock app 的事件系统即可,无需真实窗口。
//
// 平台限制:仅 macOS/Linux 运行。Windows 上该测试二进制加载 russh 依赖时抛
// STATUS_ENTRYPOINT_NOT_FOUND(0xc0000139),且 mock sshd 依赖 node 子进程 —— 该组合在
// Windows CI 环境不可用。Windows 的正确性由单元测试(20 项)与真实构建验证覆盖。
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

fn start_mock_sshd(password: &str) -> MockSshd {
    let dir = std::env::temp_dir().join(format!(
        "nb-it-sshd-{}-{}",
        std::process::id(),
        password.len()
    ));
    let _ = std::fs::create_dir_all(&dir);
    let port_file = dir.join("port");
    let helper =
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../e2e/helpers/sshd-standalone.mjs");
    let child = Command::new("node")
        .arg(&helper)
        .arg(&port_file)
        .arg(password)
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

fn store2_host(store: &Arc<Store>, port: u16) -> serde_json::Value {
    store
        .save_host(&json!({
            "name": "it-sftp", "host": "127.0.0.1", "port": port,
            "username": "root", "authType": "password", "password": "itest-pass"
        }))
        .unwrap()
}

fn tmp_store(tag: &str) -> Arc<Store> {
    let dir = std::env::temp_dir().join(format!("nb-it-store-{}-{}", tag, std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    Arc::new(Store::load_plain(dir))
}

#[tokio::test]
async fn ssh_connect_exec_roundtrip() {
    let app = tauri::test::mock_builder()
        .build(tauri::generate_context!())
        .expect("mock app");
    let handle = app.handle().clone();
    let mock = start_mock_sshd("itest-pass");
    let store = tmp_store("conn");

    let host = store
        .save_host(&json!({
            "name": "it-a", "host": "127.0.0.1", "port": mock.port,
            "username": "root", "authType": "password", "password": "itest-pass"
        }))
        .unwrap();
    let full = store.host_full(host["id"].as_str().unwrap()).unwrap();

    let ssh = Arc::new(SshService::new(store.clone(), Default::default()));
    let sid = "it-sess-1";
    tokio::time::timeout(
        Duration::from_secs(20),
        ssh.connect(handle.clone(), full, sid.into()),
    )
    .await
    .expect("连接超时")
    .expect("连接应成功(密码认证 + shell)");

    // exec:独立通道执行命令并收退出码
    let (code, out) = tokio::time::timeout(Duration::from_secs(10), ssh.exec(sid, "nebula-probe"))
        .await
        .expect("exec 超时")
        .expect("exec 应成功");
    assert_eq!(code, 0);
    assert!(out.contains("EXEC-OK:nebula-probe"), "exec 输出: {}", out);

    // resize:window-change 链路(不 panic 即链路可用)
    ssh.resize(sid, 88, 24).await.expect("resize");

    // 错误密码:明确失败
    let bad_host = store
        .save_host(&json!({
            "name": "it-bad", "host": "127.0.0.1", "port": mock.port,
            "username": "root", "authType": "password", "password": "WRONG"
        }))
        .unwrap();
    let bad_full = store.host_full(bad_host["id"].as_str().unwrap()).unwrap();
    let r = ssh.connect(handle.clone(), bad_full, "it-bad".into()).await;
    assert!(r.is_err(), "错误密码应认证失败");

    ssh.disconnect(sid).await;

    // —— SFTP 全链路(复用同一 mock sshd 与 app 上下文)——
    let host2 = store
        .save_host(&json!({
            "name": "it-sftp", "host": "127.0.0.1", "port": mock.port,
            "username": "root", "authType": "password", "password": "itest-pass"
        }))
        .unwrap();
    let full = store.host_full(host2["id"].as_str().unwrap()).unwrap();
    let ssh = Arc::new(SshService::new(store.clone(), Default::default()));
    let sid = "it-sftp";
    ssh.connect(handle.clone(), full, sid.into())
        .await
        .expect("连接");

    let sftp = ssh.open_sftp(sid).await.expect("sftp 通道");
    let root = nebulashell_lib::sftp::list(&sftp, None)
        .await
        .expect("列目录");
    assert!(
        root["entries"].to_string().contains("README.md"),
        "应有预置文件"
    );

    let dir = std::env::temp_dir().join(format!("nb-it-sftp-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let local = dir.join("up.bin");
    let payload = "tauri-it-payload-0123456789abcdef".repeat(8);
    std::fs::write(&local, &payload).unwrap();

    nebulashell_lib::sftp::upload(
        &sftp,
        handle.clone(),
        sid.into(),
        local.to_str().unwrap(),
        "/home/user",
    )
    .await
    .expect("上传");

    let dl = dir.join("down.bin");
    nebulashell_lib::sftp::download(
        sftp.clone(),
        handle.clone(),
        sid.into(),
        "/home/user/up.bin",
        dl.to_str().unwrap(),
        "download",
        None,
        None,
    )
    .await
    .expect("下载");
    assert_eq!(
        std::fs::read(&dl).unwrap(),
        payload.as_bytes(),
        "下载内容应与上传一致"
    );

    nebulashell_lib::sftp::remove(&sftp, "/home/user/up.bin", false, false)
        .await
        .expect("删除");

    // —— 递归删除非空目录 ——
    // 造树:/home/user/rmroot/{a.txt, sub/{deep.txt}, empty/, link -> /home/user/README.md}
    // 链接目标在目录树外,必须存活 —— 递归删除绝不跟随符号链接。
    nebulashell_lib::sftp::mkdir(&sftp, "/home/user/rmroot")
        .await
        .expect("mkdir root");
    nebulashell_lib::sftp::mkdir(&sftp, "/home/user/rmroot/sub")
        .await
        .expect("mkdir sub");
    nebulashell_lib::sftp::mkdir(&sftp, "/home/user/rmroot/empty")
        .await
        .expect("mkdir empty");
    let seed_dir = std::env::temp_dir().join(format!("nb-it-rmrec-{}", std::process::id()));
    std::fs::create_dir_all(seed_dir.join("sub")).unwrap();
    std::fs::write(seed_dir.join("a.txt"), "a\n").unwrap();
    std::fs::write(seed_dir.join("sub/deep.txt"), "deep\n").unwrap();
    nebulashell_lib::sftp::upload(
        &sftp,
        handle.clone(),
        sid.into(),
        seed_dir.join("a.txt").to_str().unwrap(),
        "/home/user/rmroot",
    )
    .await
    .expect("seed a.txt");
    nebulashell_lib::sftp::upload(
        &sftp,
        handle.clone(),
        sid.into(),
        seed_dir.join("sub/deep.txt").to_str().unwrap(),
        "/home/user/rmroot/sub",
    )
    .await
    .expect("seed deep.txt");
    let _ = std::fs::remove_dir_all(&seed_dir);
    // mock sshd 不支持 SYMLINK(OpUnsupported),链接场景由 e2e mock 覆盖;
    // 这里仅在有支持时验证"不跟随链接"
    let link_supported = sftp
        .symlink("/home/user/README.md", "/home/user/rmroot/link")
        .await
        .is_ok();

    // 非 recursive 删非空目录:仍报错(协议语义保留),且目录原封不动
    assert!(
        nebulashell_lib::sftp::remove(&sftp, "/home/user/rmroot", true, false)
            .await
            .is_err(),
        "非空目录非递归删除应失败"
    );
    assert!(
        sftp.metadata("/home/user/rmroot").await.is_ok(),
        "失败后目录应还在"
    );

    // 递归删除:成功,且链接目标(树外)存活
    nebulashell_lib::sftp::remove(&sftp, "/home/user/rmroot", true, true)
        .await
        .expect("递归删除");
    let left = nebulashell_lib::sftp::list(&sftp, Some("/home/user".into()))
        .await
        .expect("列目录");
    let names: Vec<&str> = left["entries"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|e| e["name"].as_str())
        .collect();
    assert!(
        !names.contains(&"rmroot"),
        "rmroot 应已删除,实际: {names:?}"
    );
    // README.md 预置文件一直在;若链接创建成功,它就是链接目标,同样必须存活
    assert!(names.contains(&"README.md"), "README.md 不应被误删");
    let _ = link_supported;

    let _ = std::fs::remove_dir_all(&dir);
    ssh.disconnect(sid).await;
}
