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
    let base = match dir {
        Some(ref d) if d != "~" && !d.is_empty() => d.clone(),
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

pub async fn download<R: tauri::Runtime, E: tauri::Emitter<R> + Clone + Send + Sync + 'static>(
    sftp: &russh_sftp::client::SftpSession,
    app: E,
    session_id: String,
    remote_path: &str,
    local_path: &str,
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
                    json!({ "sessionId": session_id, "op": "download", "name": name, "pct": pct }),
                );
            }
        }
    }
    local.flush().await.ok();
    Ok(json!({ "localPath": local_path }))
}
