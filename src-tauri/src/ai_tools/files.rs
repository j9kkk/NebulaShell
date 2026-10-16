//! SFTP 只读工具：read_file / list_dir / file_size，以及命令类工具的路径解析。

use crate::ai_exec_guard::{path_policy, PathPolicy};
use russh_sftp::client::SftpSession;
use serde_json::{json, Value};
use tokio::io::{AsyncReadExt, AsyncSeekExt};

pub(super) const READ_MAX: usize = 64 * 1024;
const LIST_MAX: usize = 500;
const LINE_MAX: usize = 2000;

pub(super) enum PathError {
    Denied(String),
    Missing(String),
    Failed(String),
}

/// 解析成服务器上的真实路径（`~` 相对家目录、符号链接展开），并在展开前后
/// 都过一遍敏感路径策略 —— 指向 ~/.ssh 的软链接也拦得住。
pub(super) async fn resolve(sftp: &SftpSession, raw: &str) -> Result<String, PathError> {
    let raw = raw.trim();
    if raw.is_empty() {
        return Err(PathError::Failed("缺少路径".to_string()));
    }
    if path_policy(raw) == PathPolicy::Deny {
        return Err(PathError::Denied(raw.to_string()));
    }
    let rel = match raw {
        "~" => ".",
        r => r.strip_prefix("~/").unwrap_or(r),
    };
    let real = sftp.canonicalize(rel).await.map_err(|e| {
        let s = e.to_string();
        let lower = s.to_ascii_lowercase();
        if lower.contains("no such file")
            || lower.contains("nosuchfile")
            || lower.contains("not found")
        {
            PathError::Missing(raw.to_string())
        } else {
            PathError::Failed(s)
        }
    })?;
    if path_policy(&real) == PathPolicy::Deny {
        return Err(PathError::Denied(real));
    }
    Ok(real)
}

fn looks_binary(b: &[u8]) -> bool {
    !b.is_empty() && b.iter().filter(|x| **x == 0).count() * 100 > b.len()
}

/// 不含末尾残缺 UTF-8 字符的长度（下一次读取从字符边界开始）。
pub(super) fn complete_utf8_len(b: &[u8]) -> usize {
    match std::str::from_utf8(b) {
        Ok(_) => b.len(),
        Err(e) if e.error_len().is_none() => e.valid_up_to(),
        Err(_) => b.len(),
    }
}

pub(super) fn clip_long_lines(s: &str, max: usize) -> String {
    s.split('\n')
        .map(|l| {
            if l.chars().count() > max {
                let cut: String = l.chars().take(max).collect();
                format!("{cut}…（此行过长，已截断）")
            } else {
                l.to_string()
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
}

pub(super) fn human_size(n: u64) -> String {
    const UNITS: [&str; 5] = ["B", "KB", "MB", "GB", "TB"];
    let mut v = n as f64;
    let mut u = 0;
    while v >= 1024.0 && u < UNITS.len() - 1 {
        v /= 1024.0;
        u += 1;
    }
    if u == 0 {
        format!("{n} B")
    } else {
        format!("{v:.1} {}", UNITS[u])
    }
}

/// UTC 时间戳格式化（不引入日期库；只用于给模型看的列表）。
pub(super) fn fmt_time(secs: u64) -> String {
    let days = (secs / 86_400) as i64;
    let rem = secs % 86_400;
    let (h, m) = (rem / 3600, rem % 3600 / 60);
    // Howard Hinnant 的 civil_from_days。
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let mo = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(mo <= 2);
    format!("{y:04}-{mo:02}-{d:02} {h:02}:{m:02}")
}

pub(super) async fn read_file(
    sftp: &SftpSession,
    real: &str,
    offset: u64,
    length: usize,
) -> Result<Value, String> {
    let meta = sftp.metadata(real).await.map_err(|e| e.to_string())?;
    if meta.is_dir() {
        return Err("这是目录，请改用 list_dir".to_string());
    }
    let size = meta.size.unwrap_or(0);
    let length = length.clamp(1, READ_MAX);
    let mut f = sftp.open(real).await.map_err(|e| e.to_string())?;
    if offset > 0 {
        f.seek(std::io::SeekFrom::Start(offset))
            .await
            .map_err(|e| e.to_string())?;
    }
    let mut buf = vec![0u8; length];
    let mut got = 0;
    while got < length {
        let n = f.read(&mut buf[got..]).await.map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        got += n;
    }
    buf.truncate(got);
    if looks_binary(&buf) {
        return Err(
            "二进制文件，无法按文本读取（.gz 压缩日志请用 tail_file 或 search_file，会自动解压）"
                .to_string(),
        );
    }
    let at_end = got < length || offset + got as u64 >= size;
    let keep = if at_end { got } else { complete_utf8_len(&buf) };
    let content = clip_long_lines(&String::from_utf8_lossy(&buf[..keep]), LINE_MAX);
    let next = offset + keep as u64;
    Ok(json!({
        "content": content,
        "meta": { "path": real, "offset": offset, "nextOffset": next, "size": size, "eof": at_end && keep == got },
    }))
}

pub(super) async fn list_dir(sftp: &SftpSession, real: &str) -> Result<Value, String> {
    let rd = sftp.read_dir(real).await.map_err(|e| e.to_string())?;
    let mut items: Vec<(bool, String, u64, u64, bool)> = rd
        .into_iter()
        .map(|e| {
            let m = e.metadata();
            (
                m.is_dir(),
                e.file_name(),
                m.size.unwrap_or(0),
                m.mtime.unwrap_or(0) as u64,
                m.is_symlink(),
            )
        })
        .filter(|(_, name, ..)| name != "." && name != "..")
        .collect();
    items.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.cmp(&b.1)));
    let total = items.len();
    let mut lines: Vec<String> = items
        .iter()
        .take(LIST_MAX)
        .map(|(dir, name, size, mtime, link)| {
            let kind = if *link {
                "l"
            } else if *dir {
                "d"
            } else {
                "-"
            };
            let suffix = if *dir { "/" } else { "" };
            format!(
                "{kind} {:>10}  {}  {name}{suffix}",
                human_size(*size),
                fmt_time(*mtime)
            )
        })
        .collect();
    if total > LIST_MAX {
        lines.push(format!("…还有 {} 项未列出", total - LIST_MAX));
    }
    Ok(json!({
        "content": if lines.is_empty() { "（空目录）".to_string() } else { lines.join("\n") },
        "meta": { "path": real, "total": total },
    }))
}

pub(super) async fn file_size(sftp: &SftpSession, real: &str) -> Result<Value, String> {
    let m = sftp.metadata(real).await.map_err(|e| e.to_string())?;
    let size = m.size.unwrap_or(0);
    let kind = if m.is_dir() { "目录" } else { "文件" };
    let mtime = m.mtime.unwrap_or(0) as u64;
    Ok(json!({
        "content": format!("{real}：{kind}，{size} 字节（{}），修改于 {} UTC", human_size(size), fmt_time(mtime)),
        "meta": { "path": real, "size": size, "isDir": m.is_dir(), "mtime": mtime },
    }))
}
