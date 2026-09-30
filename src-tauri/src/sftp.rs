// SFTP 操作:列目录/建目录/删除/重命名/权限/上传/下载(带进度)
use serde_json::{json, Value};
use std::path::PathBuf;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

fn attr_val(e: &russh_sftp::protocol::FileAttributes) -> (bool, u64, u64) {
    (
        e.is_dir(),
        e.size.unwrap_or(0),
        e.mtime.unwrap_or(0) as u64 * 1000,
    )
}

pub async fn list(
    sftp: &russh_sftp::client::SftpSession,
    dir: Option<String>,
) -> Result<Value, String> {
    // 路径栏允许手输后,`~` / `~/x` 是高频写法,而 SFTP 协议不认波浪号
    // (那是 shell 的展开)。canonicalize(".") = SFTP 会话登录用户的家目录,
    // 在客户端展开成绝对路径;展开不了时让 read_dir 的报错照常透出。
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
                if rest.is_empty() {
                    home
                } else {
                    format!("{}/{}", home, rest)
                }
            } else {
                d.to_string()
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

pub async fn upload<R: tauri::Runtime, E: tauri::Emitter<R> + Clone + Send + Sync + 'static>(
    sftp: &russh_sftp::client::SftpSession,
    app: E,
    session_id: String,
    local_path: &str,
    remote_dir: &str,
) -> Result<Value, String> {
    use russh_sftp::protocol::OpenFlags;
    let name = PathBuf::from(local_path)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "upload.bin".into());
    let remote_path = format!("{}/{}", remote_dir.trim_end_matches('/'), name);
    let mut local = tokio::fs::File::open(local_path)
        .await
        .map_err(|e| e.to_string())?;
    let total = local.metadata().await.map(|m| m.len()).unwrap_or(0);
    let remote = sftp
        .open_with_flags(
            &remote_path,
            OpenFlags::CREATE | OpenFlags::WRITE | OpenFlags::TRUNCATE,
        )
        .await
        .map_err(|e| e.to_string())?;
    let mut remote = remote;
    let mut buf = vec![0u8; 64 * 1024];
    let mut sent: u64 = 0;
    let mut last_pct = -1;
    loop {
        let n = local.read(&mut buf).await.map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        remote
            .write_all(&buf[..n])
            .await
            .map_err(|e| e.to_string())?;
        sent += n as u64;
        if total > 0 {
            let pct = (sent * 100 / total) as i64;
            if pct != last_pct {
                last_pct = pct;
                crate::ai::emit_evt(
                    &app,
                    "sftp:progress",
                    json!({ "sessionId": session_id, "op": "upload", "name": name, "pct": pct }),
                );
            }
        }
    }
    remote.shutdown().await.ok();
    Ok(json!({ "remotePath": remote_path }))
}

/// op 用于进度事件的文案(前端按 op 显示「下载/打开 x 42%」);普通下载传 "download"。
pub async fn download<R: tauri::Runtime, E: tauri::Emitter<R> + Clone + Send + Sync + 'static>(
    sftp: &russh_sftp::client::SftpSession,
    app: E,
    session_id: String,
    remote_path: &str,
    local_path: &str,
    op: &str,
) -> Result<Value, String> {
    let name = PathBuf::from(remote_path)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "download.bin".into());
    let meta = sftp
        .metadata(remote_path)
        .await
        .map_err(|e| e.to_string())?;
    let total = meta.size.unwrap_or(0);
    let mut remote = sftp.open(remote_path).await.map_err(|e| e.to_string())?;
    let mut local = tokio::fs::File::create(local_path)
        .await
        .map_err(|e| e.to_string())?;
    let mut buf = vec![0u8; 64 * 1024];
    let mut got: u64 = 0;
    let mut last_pct = -1;
    loop {
        let n = remote.read(&mut buf).await.map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        local
            .write_all(&buf[..n])
            .await
            .map_err(|e| e.to_string())?;
        got += n as u64;
        if total > 0 {
            let pct = (got * 100 / total) as i64;
            if pct != last_pct {
                last_pct = pct;
                crate::ai::emit_evt(
                    &app,
                    "sftp:progress",
                    json!({ "sessionId": session_id, "op": op, "name": name, "pct": pct }),
                );
            }
        }
    }
    local.flush().await.ok();
    Ok(json!({ "localPath": local_path }))
}

/// 右键「打开」:把远端文件下载到本机临时目录后交给系统默认程序。
///
/// 每次打开都落在独立的 `NebulaShell-open/<时间戳>/` 子目录 —— 同名文件反复
/// 打开互不覆盖,旧副本被本地程序占用(如 Excel 锁定)也不影响新副本;
/// 超过 24h 的旧目录在下次打开时顺手清理。test_mode 下不真正拉起系统程序
/// (e2e 会在测试机上弹窗),只验证"下载落盘"这一段。
pub async fn open_remote<R: tauri::Runtime, E: tauri::Emitter<R> + Clone + Send + Sync + 'static>(
    sftp: &russh_sftp::client::SftpSession,
    app: E,
    session_id: String,
    remote_path: &str,
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
    let root = std::env::temp_dir().join("NebulaShell-open");
    let dir = root.join(format!("open-{}", chrono::Local::now().timestamp_millis()));
    tokio::fs::create_dir_all(&dir)
        .await
        .map_err(|e| e.to_string())?;
    cleanup_open_dir(&root).await;
    let local = dir.join(&name);
    let local_str = local.to_string_lossy().to_string();
    // 复用 download 的搬运与进度上报,op 用 "open":前端状态栏显示「打开 x 42%」
    download(sftp, app, session_id, remote_path, &local_str, "open").await?;
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
        let _ = std::process::Command::new("xdg-open").arg(&local_str).spawn();
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
    let stem = name.to_uppercase().split('.').next().unwrap_or("").to_string();
    const RESERVED: [&str; 22] = [
        "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7",
        "COM8", "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
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
