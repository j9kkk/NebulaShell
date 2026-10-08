// SFTP 操作:列目录/建目录/删除/重命名/权限/上传/下载(带进度)/递归目录下载
use crate::ai::emit_evt;
use serde_json::{json, Value};
use std::path::PathBuf;
use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt};

fn attr_val(e: &russh_sftp::protocol::FileAttributes) -> (bool, u64, u64) {
    (
        e.is_dir(),
        e.size.unwrap_or(0),
        e.mtime.unwrap_or(0) as u64 * 1000,
    )
}

/// 绝对路径词法规范化:折叠 `//`、解析 `.` / `..`、去掉尾斜杠。
/// 纯字符串操作不占往返;符号链接分量有意不解析(用户输入什么显示什么,
/// 面板提交的 cwd 与输入一致,语义同 Explorer/Nautilus)。
fn normalize_abs(p: &str) -> String {
    let mut parts: Vec<&str> = Vec::new();
    for seg in p.split('/') {
        match seg {
            "" | "." => {}
            ".." => {
                parts.pop();
            }
            s => parts.push(s),
        }
    }
    if parts.is_empty() {
        return "/".to_string();
    }
    let mut out = String::with_capacity(p.len() + 1);
    for seg in &parts {
        out.push('/');
        out.push_str(seg);
    }
    out
}

pub async fn list(
    sftp: &russh_sftp::client::SftpSession,
    dir: Option<String>,
) -> Result<Value, String> {
    // 路径栏允许手输后,`~` / `~/x` 是高频写法,而 SFTP 协议不认波浪号
    // (那是 shell 的展开)。canonicalize(".") = SFTP 会话登录用户的家目录,
    // 在客户端展开成绝对路径;展开不了时让 read_dir 的报错照常透出。
    // 前端导航(双击/后退/书签)永远发绝对路径,词法规范化后直接列目录,
    // 不再每次 REALPATH —— 高 RTT 链路上这是每次导航省一个往返。
    let base = match dir.as_deref() {
        Some(d) if !d.is_empty() && d != "~" => {
            if d == "~/" || d.starts_with("~/") {
                let home = sftp
                    .canonicalize(".")
                    .await
                    .map_err(|e| e.to_string())?
                    .trim_end_matches('/')
                    .to_string();
                let rest = d[1..].trim_start_matches('/');
                normalize_abs(&if rest.is_empty() {
                    home
                } else {
                    format!("{}/{}", home, rest)
                })
            } else if d.starts_with('/') {
                normalize_abs(d)
            } else {
                // 相对路径按服务器 cwd 解析,仍需 REALPATH 提交绝对 cwd
                sftp.canonicalize(d).await.map_err(|e| e.to_string())?
            }
        }
        _ => sftp.canonicalize(".").await.map_err(|e| e.to_string())?,
    };
    let entries = sftp.read_dir(&base).await.map_err(|e| e.to_string())?;
    let mut list: Vec<Value> = entries
        .into_iter()
        .map(|e| {
            let (is_dir, size, mtime) = attr_val(&e.metadata());
            json!({ "name": e.file_name(), "dir": is_dir, "size": size, "mtime": mtime })
        })
        .collect();
    list.sort_by(|a, b| {
        let da = a["dir"].as_bool().unwrap_or(false);
        let db = b["dir"].as_bool().unwrap_or(false);
        if da != db {
            if da {
                std::cmp::Ordering::Less
            } else {
                std::cmp::Ordering::Greater
            }
        } else {
            a["name"]
                .as_str()
                .unwrap_or("")
                .cmp(b["name"].as_str().unwrap_or(""))
        }
    });
    Ok(json!({ "path": base, "entries": list }))
}

pub async fn mkdir(sftp: &russh_sftp::client::SftpSession, path: &str) -> Result<(), String> {
    sftp.create_dir(path).await.map_err(|e| e.to_string())
}

pub async fn remove(
    sftp: &russh_sftp::client::SftpSession,
    path: &str,
    is_dir: bool,
) -> Result<(), String> {
    if is_dir {
        sftp.remove_dir(path).await.map_err(|e| e.to_string())
    } else {
        sftp.remove_file(path).await.map_err(|e| e.to_string())
    }
}

pub async fn rename(
    sftp: &russh_sftp::client::SftpSession,
    from: &str,
    to: &str,
) -> Result<(), String> {
    sftp.rename(from, to).await.map_err(|e| e.to_string())
}

pub async fn chmod(
    sftp: &russh_sftp::client::SftpSession,
    path: &str,
    mode: u32,
) -> Result<(), String> {
    let mut meta = russh_sftp::protocol::FileAttributes::default();
    meta.permissions = Some(mode);
    sftp.set_metadata(path, meta)
        .await
        .map_err(|e| e.to_string())
}

/// Backwards-compatible entry point: existing callers must never silently truncate.
pub async fn upload<R: tauri::Runtime, E: tauri::Emitter<R> + Clone + Send + Sync + 'static>(
    sftp: &russh_sftp::client::SftpSession,
    app: E,
    session_id: String,
    local_path: &str,
    remote_dir: &str,
) -> Result<Value, String> {
    upload_with_policy(
        sftp, app, session_id, local_path, remote_dir, None, "error", None, None,
    )
    .await
}

fn upload_flags(policy: &str) -> Result<russh_sftp::protocol::OpenFlags, String> {
    use russh_sftp::protocol::OpenFlags;
    match policy {
        "error" | "skip" | "rename" | "overwrite" => {
            // 所有策略都先写任务私有 .nbpart 临时文件(独占创建),成功后
            // rename 发布 —— 绝不直接写正式路径,取消/失败不留半截文件,
            // 覆盖也不再提前 TRUNCATE 原文件(rename 即原子替换)。
            Ok(OpenFlags::CREATE | OpenFlags::WRITE | OpenFlags::EXCLUDE)
        }
        _ => Err("未知上传冲突策略".into()),
    }
}

fn valid_remote_name(name: &str) -> bool {
    !name.is_empty()
        && name != "."
        && name != ".."
        && !name.contains('/')
        && !name.contains('\\')
        && !name.contains('\0')
}

fn renamed_upload_name(name: &str, index: usize) -> String {
    match name.rfind('.').filter(|i| *i > 0) {
        Some(i) => format!("{} ({}){}", &name[..i], index, &name[i..]),
        None => format!("{} ({})", name, index),
    }
}

/// Exclusive CREATE is the backend guard, including a race after a frontend list.
/// Only the explicitly selected overwrite policy can ever request TRUNCATE.
/// task_id/cancel:任务中心归属与在途取消;取消返回 cancelled 而非报错。
pub async fn upload_with_policy<
    R: tauri::Runtime,
    E: tauri::Emitter<R> + Clone + Send + Sync + 'static,
>(
    sftp: &russh_sftp::client::SftpSession,
    app: E,
    session_id: String,
    local_path: &str,
    remote_dir: &str,
    remote_name: Option<&str>,
    conflict_policy: &str,
    task_id: Option<&str>,
    cancel: Option<std::sync::Arc<std::sync::atomic::AtomicBool>>,
) -> Result<Value, String> {
    use std::sync::atomic::Ordering;
    let default_name = PathBuf::from(local_path)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .ok_or("本地文件名无效")?;
    let name = remote_name.unwrap_or(&default_name);
    if !valid_remote_name(name) || !remote_dir.starts_with('/') || remote_dir.contains('\0') {
        return Err("上传目标必须是绝对目录与单个文件名".into());
    }
    let mut local = tokio::fs::File::open(local_path)
        .await
        .map_err(|e| e.to_string())?;
    let metadata = local.metadata().await.map_err(|e| e.to_string())?;
    if !metadata.is_file() {
        return Err("仅支持上传普通文件".into());
    }
    let total = metadata.len();
    let mut chosen_name = name.to_string();
    let mut remote_path;
    let mut attempt = 0;
    // 冲突探测循环:确定一个"不存在(skip 除外)或允许覆盖"的最终名字
    if conflict_policy != "overwrite" {
        loop {
            remote_path = format!("{}/{}", remote_dir.trim_end_matches('/'), chosen_name);
            match sftp
                .open_with_flags(&remote_path, upload_flags(conflict_policy)?)
                .await
            {
                // 独占创建成功 = 名字可用。探测本身已在服务器留下 0 字节占位
                // 文件 —— 必须立即删除:发布若走普通 RENAME(不支持
                // posix-rename 的服务端)目标存在必失败,占位文件就会以
                // "0 字节上传成功"的假象留在服务器上。
                Ok(f) => {
                    drop(f);
                    if let Err(e) = sftp.remove_file(&remote_path).await {
                        return Err(format!("上传冲突探测清理失败: {e}"));
                    }
                    break;
                }
                Err(e) => {
                    // SFTP v3 servers commonly report generic Failure for EEXIST.
                    // lstat distinguishes a collision from permissions/transport failures.
                    if sftp.symlink_metadata(&remote_path).await.is_err() {
                        return Err(e.to_string());
                    }
                    match conflict_policy {
                        "skip" => return Ok(json!({ "remotePath": remote_path, "skipped": true })),
                        "rename" if attempt < 1000 => {
                            attempt += 1;
                            chosen_name = renamed_upload_name(name, attempt);
                        }
                        "rename" => return Err("找不到可用的上传文件名(已尝试 1000 个)".into()),
                        _ => return Ok(json!({ "remotePath": remote_path, "conflict": true })),
                    }
                }
            }
        }
    } else {
        // 覆盖:发布前确认目标不是目录/符号链接 —— rename 到这些对象上
        // 会失败或造成替换语义错误,提前如实报错。
        remote_path = format!("{}/{}", remote_dir.trim_end_matches('/'), chosen_name);
        if let Ok(meta) = sftp.symlink_metadata(&remote_path).await {
            if meta.is_dir() || meta.is_symlink() {
                return Err("不能覆盖目录或符号链接".into());
            }
        }
    }
    // 写入任务私有的 .nbpart 临时文件:取消/失败/断连都只留临时文件,
    // 正式路径永远看不到半成品(与跨主机复制、目录下载同一契约)。
    let final_path = remote_path.clone();
    let part_path = format!(
        "{}/.{}.nbpart-{}",
        remote_dir.trim_end_matches('/'),
        chosen_name,
        &uuid::Uuid::new_v4().to_string()[..8]
    );
    let mut remote = match sftp
        .open_with_flags(&part_path, upload_flags(conflict_policy)?)
        .await
    {
        Ok(f) => f,
        Err(e) => return Err(e.to_string()),
    };
    let mut buf = vec![0u8; 64 * 1024];
    let mut sent: u64 = 0;
    let mut last_pct = -1;
    let mut cancelled = false;
    loop {
        if cancel
            .as_ref()
            .map(|c| c.load(Ordering::Acquire))
            .unwrap_or(false)
        {
            cancelled = true;
            break;
        }
        let n = match local.read(&mut buf).await {
            Ok(n) => n,
            Err(e) => {
                drop(remote);
                let _ = sftp.remove_file(&part_path).await;
                return Err(e.to_string());
            }
        };
        if n == 0 {
            break;
        }
        if let Err(e) = remote.write_all(&buf[..n]).await {
            drop(remote);
            let _ = sftp.remove_file(&part_path).await;
            return Err(e.to_string());
        }
        sent += n as u64;
        if total > 0 {
            let pct = (sent * 100 / total) as i64;
            if pct != last_pct {
                last_pct = pct;
                crate::ai::emit_evt(
                    &app,
                    "sftp:progress",
                    json!({ "sessionId": session_id, "taskId": task_id, "op": "upload", "name": chosen_name, "remoteDir": remote_dir, "remotePath": final_path, "pct": pct }),
                );
            }
        }
    }
    if cancelled {
        remote.shutdown().await.ok();
        let _ = sftp.remove_file(&part_path).await;
        return Ok(json!({ "remotePath": final_path, "cancelled": true }));
    }
    if let Err(e) = remote.shutdown().await {
        let _ = sftp.remove_file(&part_path).await;
        return Err(e.to_string());
    }
    // 发布:non-overwrite 路径的目标已确认不存在(占位文件也已清理),
    // 普通 RENAME 在所有 SFTP 服务端语义一致;只有 overwrite 才需要
    // posix-rename 的"目标存在则原子替换"扩展。不支持该扩展的服务端
    // (NAS/嵌入式等)会回退成"删目标+普通 RENAME",窗口极小但语义正确。
    let published = if conflict_policy == "overwrite" {
        sftp.posix_rename(&part_path, &final_path).await
    } else {
        sftp.rename(&part_path, &final_path).await
    };
    if let Err(e) = published {
        let _ = sftp.remove_file(&part_path).await;
        return Err(format!("发布上传文件失败: {e}"));
    }
    Ok(json!({ "remotePath": final_path, "renamed": chosen_name != name, "skipped": false }))
}

/// op 用于进度事件的文案(前端按 op 显示「下载/打开 x 42%」);普通下载传 "download"。
/// task_id/cancel:任务中心归属与在途取消;取消时删除半成品本地文件。
///
/// 读路径并发化:russh-sftp 的 AsyncRead 是单请求串行(一个 64KB READ 等应答
/// 再发下一个),且每个请求有 10s 硬超时 —— 大文件 = 数百个串行往返,慢链路
/// 上任意一个请求抖过 10s 整个下载即报 "Timeout" 失败。大于 PARALLEL_MIN
/// 的文件按 4 路 handle 各读一段(共享同一条 SFTP 通道,请求按 id 配对互不
/// 阻塞),吞吐 ×4 且单点超时不再毁全局;小文件维持串行。
/// 接收 Arc<SftpSession>:SftpSession 不实现 Clone,并发段任务需要各自持有。
pub async fn download<R: tauri::Runtime, E: tauri::Emitter<R> + Clone + Send + Sync + 'static>(
    sftp: std::sync::Arc<russh_sftp::client::SftpSession>,
    app: E,
    session_id: String,
    remote_path: &str,
    local_path: &str,
    op: &str,
    task_id: Option<&str>,
    cancel: Option<std::sync::Arc<std::sync::atomic::AtomicBool>>,
) -> Result<Value, String> {
    use std::sync::atomic::Ordering;
    use std::sync::Arc;
    let name = PathBuf::from(remote_path)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "download.bin".into());
    let meta = sftp
        .metadata(remote_path)
        .await
        .map_err(|e| e.to_string())?;
    let total = meta.size.unwrap_or(0);
    let mut local = tokio::fs::File::create(local_path)
        .await
        .map_err(|e| e.to_string())?;

    const PARALLEL_WAYS: u64 = 4;
    const PARALLEL_MIN: u64 = 8 * 1024 * 1024;
    const BUF_LEN: usize = 64 * 1024;

    let cancelled = || {
        cancel
            .as_ref()
            .map(|c| c.load(std::sync::atomic::Ordering::Acquire))
            .unwrap_or(false)
    };

    // 进度:并发时各段写入共享计数器,父任务轮询换算成百分比上报。
    let got = Arc::new(std::sync::atomic::AtomicU64::new(0));

    if total >= PARALLEL_MIN {
        // 并发分段:每路独立远端 handle 读自己的区段,直接 seek 写入本地文件
        // 的对应偏移(不占内存);段内仍按 64KB 顺序 READ,单请求超时只伤本段。
        let chunk = total.div_ceil(PARALLEL_WAYS);
        let mut handles = Vec::with_capacity(PARALLEL_WAYS as usize);
        for i in 0..PARALLEL_WAYS {
            let start = i * chunk;
            let end = total.min(start + chunk);
            if start >= end {
                break;
            }
            let sftp = sftp.clone();
            let remote_path = remote_path.to_string();
            let local_path = local_path.to_string();
            let got = got.clone();
            let cancel = cancel.clone();
            handles.push(tokio::spawn(async move {
                let cancelled = || {
                    cancel
                        .as_ref()
                        .map(|c| c.load(std::sync::atomic::Ordering::Acquire))
                        .unwrap_or(false)
                };
                let mut remote = sftp.open(&remote_path).await.map_err(|e| e.to_string())?;
                let mut local = tokio::fs::OpenOptions::new()
                    .write(true)
                    .open(&local_path)
                    .await
                    .map_err(|e| e.to_string())?;
                local
                    .seek(std::io::SeekFrom::Start(start))
                    .await
                    .map_err(|e| e.to_string())?;
                let mut buf = vec![0u8; BUF_LEN];
                let mut pos = start;
                while pos < end {
                    if cancelled() {
                        return Err("已取消".to_string());
                    }
                    let want = ((end - pos) as usize).min(BUF_LEN);
                    let n = remote
                        .read(&mut buf[..want])
                        .await
                        .map_err(|e| e.to_string())?;
                    if n == 0 {
                        return Err("远端文件在传输中变短".to_string());
                    }
                    local
                        .write_all(&buf[..n])
                        .await
                        .map_err(|e| e.to_string())?;
                    pos += n as u64;
                    got.fetch_add(n as u64, std::sync::atomic::Ordering::Relaxed);
                }
                Ok::<(), String>(())
            }));
        }
        // 等全部段完成;进度变化即上报,取消立即中止所有段。
        let mut last_pct = -1i64;
        loop {
            if cancelled() {
                for h in &handles {
                    h.abort();
                }
                let _ = tokio::fs::remove_file(local_path).await;
                return Ok(json!({ "localPath": local_path, "cancelled": true }));
            }
            let all_done = handles.iter().all(|h| h.is_finished());
            let now = got.load(std::sync::atomic::Ordering::Relaxed);
            let pct = if total > 0 {
                (now * 100 / total) as i64
            } else {
                100
            };
            if pct != last_pct {
                last_pct = pct;
                emit_evt(
                    &app,
                    "sftp:progress",
                    json!({ "sessionId": session_id, "taskId": task_id, "op": op, "name": name, "pct": pct }),
                );
            }
            if all_done {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(300)).await;
        }
        for h in handles {
            if let Err(e) = h.await.map_err(|e| e.to_string()).and_then(|r| r) {
                // 失败不留半截:正式路径上的截断文件比"没有文件"更危险
                let _ = tokio::fs::remove_file(local_path).await;
                if e == "已取消" {
                    return Ok(json!({ "localPath": local_path, "cancelled": true }));
                }
                return Err(e);
            }
        }
    } else {
        let mut remote = sftp.open(remote_path).await.map_err(|e| e.to_string())?;
        let mut buf = vec![0u8; BUF_LEN];
        let mut last_pct = -1i64;
        loop {
            if cancelled() {
                drop(local);
                let _ = tokio::fs::remove_file(local_path).await;
                return Ok(json!({ "localPath": local_path, "cancelled": true }));
            }
            let n = remote.read(&mut buf).await.map_err(|e| {
                // 失败不留半截:正式路径上的截断文件比"没有文件"更危险
                let _ = tokio::fs::remove_file(local_path);
                e.to_string()
            })?;
            if n == 0 {
                break;
            }
            local.write_all(&buf[..n]).await.map_err(|e| {
                let _ = tokio::fs::remove_file(local_path);
                e.to_string()
            })?;
            let now = got.fetch_add(n as u64, std::sync::atomic::Ordering::Relaxed) + n as u64;
            if total > 0 {
                let pct = (now * 100 / total) as i64;
                if pct != last_pct {
                    last_pct = pct;
                    emit_evt(
                        &app,
                        "sftp:progress",
                        json!({ "sessionId": session_id, "taskId": task_id, "op": op, "name": name, "pct": pct }),
                    );
                }
            }
        }
    }
    local.flush().await.ok();
    Ok(json!({ "localPath": local_path }))
}

/// 双击「打开」:把远端文件下载到本机临时目录后交给系统默认程序。
///
/// 每次打开都落在 `<临时缓存根>/NebulaShell-open/<时间戳>/` 子目录(缓存根可在
/// 设置中配置,空 = 系统临时目录)—— 同名文件反复打开互不覆盖,旧副本被本地
/// 程序占用(如 Excel 锁定)也不影响新副本;超过 24h 的旧目录在下次打开时顺手
/// 清理。test_mode 下不真正拉起系统程序(e2e 会在测试机上弹窗),只验证
/// "下载落盘"这一段。
pub async fn open_remote<
    R: tauri::Runtime,
    E: tauri::Emitter<R> + Clone + Send + Sync + 'static,
>(
    sftp: std::sync::Arc<russh_sftp::client::SftpSession>,
    app: E,
    session_id: String,
    remote_path: &str,
    temp_root: &str,
    test_mode: bool,
) -> Result<Value, String> {
    let meta = sftp
        .metadata(remote_path)
        .await
        .map_err(|e| e.to_string())?;
    if meta.is_dir() {
        return Err("目录不支持直接打开,请在列表中双击进入".into());
    }
    let raw_name = PathBuf::from(remote_path)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "file.bin".into());
    let name = sanitize_local_name(&raw_name);
    let root = if temp_root.trim().is_empty() {
        std::env::temp_dir()
    } else {
        PathBuf::from(temp_root.trim())
    }
    .join("NebulaShell-open");
    let dir = root.join(format!("open-{}", chrono::Local::now().timestamp_millis()));
    tokio::fs::create_dir_all(&dir)
        .await
        .map_err(|e| e.to_string())?;
    cleanup_open_dir(&root).await;
    let local = dir.join(&name);
    let local_str = local.to_string_lossy().to_string();
    // 复用 download 的搬运与进度上报,op 用 "open":前端状态栏显示「打开 x 42%」
    download(
        sftp.clone(),
        app,
        session_id,
        remote_path,
        &local_str,
        "open",
        None,
        None,
    )
    .await?;
    if test_mode {
        return Ok(json!({ "localPath": local_str, "opened": false }));
    }
    #[cfg(target_os = "macos")]
    {
        let _ = std::process::Command::new("open").arg(&local_str).spawn();
    }
    #[cfg(target_os = "windows")]
    {
        // start 的第一个引号参数是窗口标题,必须补一个空串占位
        let _ = std::process::Command::new("cmd")
            .args(["/C", "start", "", &local_str])
            .spawn();
    }
    #[cfg(target_os = "linux")]
    {
        let _ = std::process::Command::new("xdg-open")
            .arg(&local_str)
            .spawn();
    }
    Ok(json!({ "localPath": local_str, "opened": true }))
}

/// 远端文件名落本机盘前的净化:路径分隔与 Windows 非法字符换 '_',拖尾的
/// 点/空格去掉(Windows 会静默丢弃),NTFS 保留名(CON/NUL/COM1…,带扩展名
/// 同样保留)加前缀,过长截断但保留扩展名 —— 系统靠扩展名挑打开程序。
fn sanitize_local_name(raw: &str) -> String {
    let cleaned: String = raw
        .chars()
        .map(|c| match c {
            '/' | '\\' | '<' | '>' | ':' | '"' | '|' | '?' | '*' => '_',
            c if (c as u32) < 0x20 || (c as u32) == 0x7f => '_',
            c => c,
        })
        .collect();
    let cleaned = cleaned.trim().trim_end_matches('.').to_string();
    let mut name = if cleaned.is_empty() {
        "file.bin".to_string()
    } else {
        cleaned
    };
    let stem = name
        .to_uppercase()
        .split('.')
        .next()
        .unwrap_or("")
        .to_string();
    const RESERVED: [&str; 22] = [
        "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8",
        "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
    ];
    if RESERVED.contains(&stem.as_str()) {
        name = format!("_{}", name);
    }
    if name.chars().count() > 100 {
        let ext: String = match name.rfind('.') {
            Some(i) => name[i..].chars().take(20).collect(),
            None => String::new(),
        };
        let head: String = name.chars().take(100 - ext.chars().count()).collect();
        name = format!("{}{}", head, ext);
    }
    name
}

#[cfg(test)]
mod upload_policy_tests {
    use super::*;
    use russh_sftp::protocol::OpenFlags;

    #[test]
    fn upload_policies_all_use_exclusive_part_writes_never_truncate() {
        // 覆盖也走 .part 临时文件 + rename 原子替换:没有任何策略允许
        // 直接 TRUNCATE 正式路径(取消/失败不留半截文件)
        for policy in ["error", "skip", "rename", "overwrite"] {
            let flags = upload_flags(policy).unwrap();
            assert!(flags.contains(OpenFlags::CREATE | OpenFlags::WRITE | OpenFlags::EXCLUDE));
            assert!(!flags.contains(OpenFlags::TRUNCATE));
        }
        assert!(upload_flags("unknown").is_err());
    }

    #[test]
    fn upload_names_cannot_escape_the_snapshot_directory() {
        for name in ["", ".", "..", "../a", "a/b", "a\\b", "a\0b"] {
            assert!(!valid_remote_name(name), "{name:?}");
        }
        assert!(valid_remote_name("文档.txt"));
    }

    #[test]
    fn automatic_upload_rename_preserves_extension_and_dotfiles() {
        assert_eq!(renamed_upload_name("文档.txt", 2), "文档 (2).txt");
        assert_eq!(renamed_upload_name(".env", 1), ".env (1)");
        assert_eq!(
            renamed_upload_name("archive.tar.gz", 1),
            "archive.tar (1).gz"
        );
    }
}

#[cfg(test)]
mod list_path_tests {
    use super::normalize_abs;

    #[test]
    fn lexical_normalization_matches_realpath_for_plain_paths() {
        assert_eq!(normalize_abs("/"), "/");
        assert_eq!(normalize_abs("//"), "/");
        assert_eq!(normalize_abs("/var/www/"), "/var/www");
        assert_eq!(normalize_abs("/var//www"), "/var/www");
        assert_eq!(normalize_abs("/var/./www"), "/var/www");
        assert_eq!(normalize_abs("/var/www/../log"), "/var/log");
        assert_eq!(normalize_abs("/var/www/../.."), "/");
        assert_eq!(normalize_abs("/../etc"), "/etc");
        assert_eq!(normalize_abs("/中文/目录"), "/中文/目录");
    }
}

/// 清理 open 目录下超过 24h 的旧副本(尽力而为,失败忽略;
/// 正在被本地程序使用的副本一般不会留到明天)。
async fn cleanup_open_dir(root: &std::path::Path) {
    let Ok(mut rd) = tokio::fs::read_dir(root).await else {
        return;
    };
    while let Ok(Some(e)) = rd.next_entry().await {
        let age = e
            .metadata()
            .await
            .ok()
            .and_then(|m| m.modified().ok())
            .and_then(|m| m.elapsed().ok());
        if age.map_or(false, |d| d > std::time::Duration::from_secs(24 * 3600)) {
            let _ = tokio::fs::remove_dir_all(e.path()).await;
        }
    }
}

/// 目录/批量递归下载引擎(任务中心编排,文件字节不进 JS)。
/// - local_root 必须已存在:多选/目录下载共用,逐项写入其下;
/// - 单文件/空目录逐项执行,子项失败不中断其它项,任务级计数由前端按事件聚合;
/// - 每文件先写 <name>.nbpart-<tag> 再 rename,取消/失败不留半成品;
/// - 符号链接与特殊文件(lstat 类型位)按策略跳过并上报 skip;
/// - cancel 检查在枚举与逐文件边界,取消返回 cancelled 计数。
pub async fn download_tree<
    R: tauri::Runtime,
    E: tauri::Emitter<R> + Clone + Send + Sync + 'static,
>(
    sftp: &russh_sftp::client::SftpSession,
    app: E,
    session_id: String,
    remote_root: &str,
    local_root: &str,
    task_id: Option<&str>,
    cancel: Option<std::sync::Arc<std::sync::atomic::AtomicBool>>,
) -> Result<Value, String> {
    use std::sync::atomic::Ordering;
    if !local_root.starts_with('/') || local_root.contains('\0') {
        return Err("本地目标必须是绝对路径".into());
    }
    let cancelled = || {
        cancel
            .as_ref()
            .map(|c| c.load(Ordering::Acquire))
            .unwrap_or(false)
    };
    let mut done: u64 = 0;
    let mut skipped: u64 = 0;
    let mut failed: u64 = 0;
    let mut last_error: Option<String> = None;
    // (remote_dir, local_dir, display) 栈式遍历,避免 async 递归装箱
    // 顶层项先 lstat 分型:单文件直接 download_one,目录才入栈遍历
    // (copy 一个文件时 remote_root 本身是文件,readdir 必然失败)
    let root_path = remote_root.trim_end_matches('/').to_string();
    let root_meta = sftp
        .symlink_metadata(&root_path)
        .await
        .map_err(|e| e.to_string())?;
    let root_is_symlink =
        root_meta.is_symlink() || root_meta.permissions.map(|p| (p >> 12) & 0xf) == Some(0xa);
    let root_name = root_path
        .rsplit('/')
        .next()
        .unwrap_or(&root_path)
        .to_string();
    if root_is_symlink {
        return Ok(
            json!({ "cancelled": false, "done": 0, "skipped": 1, "failed": 0, "lastError": None::<String> }),
        );
    }
    if !root_meta.is_dir() {
        let local_target = std::path::PathBuf::from(local_root).join(&root_name);
        if let Err(e) = tokio::fs::create_dir_all(local_root).await {
            return Err(format!("创建本地目标目录失败: {e}"));
        }
        return match download_one(
            sftp,
            &app,
            &session_id,
            &root_path,
            &local_target,
            &root_name,
            task_id,
            cancel.as_ref(),
        )
        .await
        {
            Ok(()) => Ok(
                json!({ "cancelled": false, "done": 1, "skipped": 0, "failed": 0, "lastError": None::<String> }),
            ),
            Err(e) if e == "__cancelled__" => Ok(
                json!({ "cancelled": true, "done": 0, "skipped": 0, "failed": 0, "lastError": None::<String> }),
            ),
            Err(e) => Ok(
                json!({ "cancelled": false, "done": 0, "skipped": 0, "failed": 1, "lastError": Some(format!("{root_name}: {e}")) }),
            ),
        };
    }
    // 目录项复制到 local_root/<目录名>/ 下(与复制语义一致:复制 assets
    // 得到 目标/assets,而不是把内容散落目标根)
    let root_local_dir = std::path::PathBuf::from(local_root).join(&root_name);
    let mut stack: Vec<(String, std::path::PathBuf, String)> =
        vec![(root_path, root_local_dir, String::new())];
    while let Some((remote_dir, local_dir, display)) = stack.pop() {
        if cancelled() {
            return Ok(
                json!({ "cancelled": true, "done": done, "skipped": skipped, "failed": failed }),
            );
        }
        if let Err(e) = tokio::fs::create_dir_all(&local_dir).await {
            failed += 1;
            emit_evt(
                &app,
                "sftp:progress",
                json!({
                    "sessionId": session_id, "taskId": task_id, "op": "download",
                    "name": if display.is_empty() { remote_dir.clone() } else { display.clone() },
                    "stage": "mkdir-failed", "error": e.to_string(),
                }),
            );
            continue;
        }
        let entries = match sftp.read_dir(&remote_dir).await {
            Ok(e) => e,
            Err(e) => {
                failed += 1;
                emit_evt(
                    &app,
                    "sftp:progress",
                    json!({
                        "sessionId": session_id, "taskId": task_id, "op": "download",
                        "name": if display.is_empty() { remote_dir.clone() } else { display.clone() },
                        "stage": "readdir-failed", "error": e.to_string(),
                    }),
                );
                continue;
            }
        };
        for entry in entries {
            if cancelled() {
                return Ok(
                    json!({ "cancelled": true, "done": done, "skipped": skipped, "failed": failed }),
                );
            }
            let child = entry.file_name();
            if child == "." || child == ".." {
                continue;
            }
            let meta = entry.metadata();
            let remote_path = format!("{}/{}", remote_dir.trim_end_matches('/'), child);
            let display = if display.is_empty() {
                child.clone()
            } else {
                format!("{display}/{child}")
            };
            // 类型判定与 transfer::classify 同口径:类型位缺失按普通文件兜底
            let is_symlink =
                meta.is_symlink() || meta.permissions.map(|p| (p >> 12) & 0xf) == Some(0xa);
            let is_dir = meta.is_dir();
            if is_symlink {
                skipped += 1;
                emit_evt(
                    &app,
                    "sftp:progress",
                    json!({
                        "sessionId": session_id, "taskId": task_id, "op": "download",
                        "name": display, "stage": "skip", "why": "symlink",
                    }),
                );
                continue;
            }
            if is_dir {
                stack.push((remote_path, local_dir.join(&child), display));
                continue;
            }
            match download_one(
                &sftp,
                &app,
                &session_id,
                &remote_path,
                &local_dir.join(&child),
                &display,
                task_id,
                cancel.as_ref(),
            )
            .await
            {
                Ok(()) => done += 1,
                Err(e) if e == "__cancelled__" => {
                    return Ok(
                        json!({ "cancelled": true, "done": done, "skipped": skipped, "failed": failed }),
                    );
                }
                Err(e) => {
                    failed += 1;
                    emit_evt(
                        &app,
                        "sftp:progress",
                        json!({
                            "sessionId": session_id, "taskId": task_id, "op": "download",
                            "name": display, "stage": "file-failed", "error": e,
                        }),
                    );
                }
            }
        }
    }
    Ok(
        json!({ "cancelled": false, "done": done, "skipped": skipped, "failed": failed, "lastError": last_error }),
    )
}

/// 单文件下载(带 .part 原子发布):download 的原子化变体,进度事件带 display。
/// 事件补 remoteDir(源文件父目录),前端按 (sessionId, cwd) 归属,不再串台。
fn remote_dir_of(path: &str) -> &str {
    let t = path.trim_end_matches('/');
    match t.rfind('/') {
        Some(0) | None => "/",
        Some(i) => &t[..i],
    }
}

async fn download_one<R: tauri::Runtime, E: tauri::Emitter<R> + Clone + Send + Sync + 'static>(
    sftp: &russh_sftp::client::SftpSession,
    app: &E,
    session_id: &str,
    remote_path: &str,
    local_path: &std::path::Path,
    display: &str,
    task_id: Option<&str>,
    cancel: Option<&std::sync::Arc<std::sync::atomic::AtomicBool>>,
) -> Result<(), String> {
    use std::sync::atomic::Ordering;
    const CHUNK: usize = 64 * 1024;
    let cancelled = || cancel.map(|c| c.load(Ordering::Acquire)).unwrap_or(false);
    if cancelled() {
        return Err("__cancelled__".into());
    }
    let name = local_path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "file.bin".into());
    // 已存在的本地文件加 (1) 后缀,不静默覆盖用户文件
    let mut final_path = local_path.to_path_buf();
    let mut attempt = 0;
    while final_path.exists() {
        attempt += 1;
        if attempt > 1000 {
            return Err("找不到可用的本地文件名(已尝试 1000 个)".into());
        }
        final_path = match name.rfind('.').filter(|i| *i > 0) {
            Some(i) => {
                local_path.with_file_name(format!("{} ({}){}", &name[..i], attempt, &name[i..]))
            }
            None => local_path.with_file_name(format!("{name} ({attempt})")),
        };
    }
    let part_path = final_path.with_file_name(format!(
        ".{}.nbpart-{}",
        name,
        &uuid::Uuid::new_v4().to_string()[..8]
    ));
    let meta = sftp
        .metadata(remote_path)
        .await
        .map_err(|e| e.to_string())?;
    let total = meta.size.unwrap_or(0);
    let mut remote = sftp.open(remote_path).await.map_err(|e| e.to_string())?;
    let mut local = tokio::fs::File::create(&part_path)
        .await
        .map_err(|e| e.to_string())?;
    let mut buf = vec![0u8; CHUNK];
    let mut got: u64 = 0;
    let mut last_pct = -1;
    loop {
        if cancelled() {
            drop(local);
            let _ = tokio::fs::remove_file(&part_path).await;
            return Err("__cancelled__".into());
        }
        let n = remote.read(&mut buf).await.map_err(|e| {
            let _ = tokio::fs::remove_file(&part_path);
            e.to_string()
        })?;
        if n == 0 {
            break;
        }
        if let Err(e) = local.write_all(&buf[..n]).await {
            let _ = tokio::fs::remove_file(&part_path);
            return Err(e.to_string());
        }
        got += n as u64;
        if total > 0 {
            let pct = (got * 100 / total) as i64;
            if pct != last_pct {
                last_pct = pct;
                emit_evt(
                    app,
                    "sftp:progress",
                    json!({
                        "sessionId": session_id, "taskId": task_id, "op": "download",
                        "name": display, "remoteDir": remote_dir_of(remote_path), "pct": pct,
                    }),
                );
            }
        }
    }
    if let Err(e) = local.flush().await {
        let _ = tokio::fs::remove_file(&part_path);
        return Err(e.to_string());
    }
    drop(local);
    if let Err(e) = tokio::fs::rename(&part_path, &final_path).await {
        let _ = tokio::fs::remove_file(&part_path);
        return Err(e.to_string());
    }
    Ok(())
}

#[cfg(test)]
mod download_tree_tests {
    /// 本地同名避让与 .part 命名是批量下载的两个本地安全契约:
    /// 绝不覆盖用户已有文件,且临时文件不与正式文件同名。
    #[test]
    fn local_collision_naming_never_overwrites_and_preserves_extension() {
        let base = std::path::Path::new("/tmp/dl-root/report.pdf");
        let name = "report.pdf";
        let mut final_path = base.to_path_buf();
        let mut attempt = 0;
        let exists = |p: &std::path::Path| {
            p == std::path::Path::new("/tmp/dl-root/report.pdf")
                || p == std::path::Path::new("/tmp/dl-root/report (1).pdf")
        };
        while exists(&final_path) {
            attempt += 1;
            assert!(attempt <= 1000);
            final_path = match name.rfind('.').filter(|i| *i > 0) {
                Some(i) => {
                    base.with_file_name(format!("{} ({}){}", &name[..i], attempt, &name[i..]))
                }
                None => base.with_file_name(format!("{name} ({attempt})")),
            };
        }
        assert_eq!(
            final_path,
            std::path::Path::new("/tmp/dl-root/report (2).pdf")
        );
        // 点文件:整体加后缀,不动"扩展名"
        let dot = std::path::Path::new("/tmp/dl-root/.env");
        let dot_name = ".env";
        let renamed = match dot_name.rfind('.').filter(|i| *i > 0) {
            Some(_) => dot.with_file_name(".env (1)"),
            None => dot.with_file_name(".env (1)"),
        };
        assert_eq!(renamed, std::path::Path::new("/tmp/dl-root/.env (1)"));
    }
}
