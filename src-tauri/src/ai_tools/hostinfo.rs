//! 主机信息探测与按会话缓存：host_info 工具、命令分级上下文、默认工作目录。

use super::run::quick;
use crate::commands::AppState;
use serde::Serialize;
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct HostInfo {
    pub kernel: String,
    pub os: String,
    pub os_id: String,
    pub user: String,
    pub uid: Option<u32>,
    pub is_root: bool,
    pub shell: String,
    pub systemd: bool,
    pub journald: bool,
    /// 远端有 printenv：sudo 密码托管（askpass）的前提。
    pub askpass: bool,
    /// 识别出类 Unix 系统；否则所有命令都要用户确认。
    pub os_known: bool,
}

const PROBE: &str = "uname -srm 2>/dev/null; echo __NB_SEP; cat /etc/os-release 2>/dev/null; echo __NB_SEP; id -un 2>/dev/null; id -u 2>/dev/null; echo \"$SHELL\"; echo __NB_SEP; command -v systemctl >/dev/null 2>&1 && echo systemd; command -v journalctl >/dev/null 2>&1 && echo journald; command -v printenv >/dev/null 2>&1 && echo printenv";

pub(super) fn parse(out: &str) -> HostInfo {
    let parts: Vec<&str> = out.split("__NB_SEP").collect();
    let last_line = |s: &str| {
        s.lines()
            .map(str::trim)
            .rfind(|l| !l.is_empty())
            .unwrap_or("")
            .to_string()
    };
    let mut info = HostInfo {
        kernel: parts.first().map(|s| last_line(s)).unwrap_or_default(),
        ..HostInfo::default()
    };
    if let Some(osr) = parts.get(1) {
        for line in osr.lines() {
            if let Some((k, v)) = line.split_once('=') {
                let v = v.trim().trim_matches('"').to_string();
                match k.trim() {
                    "PRETTY_NAME" => info.os = v,
                    "ID" => info.os_id = v,
                    _ => {}
                }
            }
        }
    }
    if let Some(ids) = parts.get(2) {
        let lines: Vec<&str> = ids
            .lines()
            .map(str::trim)
            .filter(|l| !l.is_empty())
            .collect();
        info.user = lines.first().unwrap_or(&"").to_string();
        info.uid = lines.get(1).and_then(|s| s.parse().ok());
        info.shell = lines.get(2).unwrap_or(&"").to_string();
    }
    if let Some(flags) = parts.get(3) {
        info.systemd = flags.contains("systemd");
        info.journald = flags.contains("journald");
        info.askpass = flags.contains("printenv");
    }
    info.is_root = info.uid == Some(0);
    let k = info.kernel.to_ascii_lowercase();
    info.os_known = ["linux", "darwin", "freebsd", "openbsd", "netbsd"]
        .iter()
        .any(|p| k.starts_with(p));
    if info.os.is_empty() && info.os_known {
        info.os = info
            .kernel
            .split_whitespace()
            .next()
            .unwrap_or("")
            .to_string();
    }
    info
}

fn cache() -> &'static Mutex<HashMap<(String, u64), HostInfo>> {
    static C: OnceLock<Mutex<HashMap<(String, u64), HostInfo>>> = OnceLock::new();
    C.get_or_init(Default::default)
}

/// 按 (会话, 连接代次) 缓存；重连后代次变化自然重新探测。
pub(super) async fn get(state: &AppState, sid: &str, epoch: u64, refresh: bool) -> HostInfo {
    let key = (sid.to_string(), epoch);
    if !refresh {
        if let Some(info) = cache().lock().unwrap().get(&key) {
            return info.clone();
        }
    }
    let info = match quick(state, sid, PROBE, None, Duration::from_secs(10)).await {
        Ok((_, out)) => parse(&out),
        Err(_) => HostInfo::default(),
    };
    let mut c = cache().lock().unwrap();
    c.retain(|(s, e), _| s != sid || *e == epoch);
    c.insert(key, info.clone());
    info
}

pub(super) fn summary(i: &HostInfo) -> String {
    if !i.os_known {
        let k = if i.kernel.is_empty() {
            "无输出"
        } else {
            &i.kernel
        };
        return format!(
            "无法识别的系统（uname：{k}）。该主机可能不是 Linux/Unix，所有命令都需要用户确认。"
        );
    }
    let root = if i.is_root { "（root）" } else { "" };
    let yes = |b: bool| if b { "有" } else { "无" };
    format!(
        "系统：{}；内核：{}；用户：{}{root}；Shell：{}；systemd：{}；journald：{}",
        i.os,
        i.kernel,
        i.user,
        i.shell,
        yes(i.systemd),
        yes(i.journald)
    )
}

/// 终端当前目录（exec 的默认工作目录），按会话缓存 30 秒。
pub(super) async fn cwd(state: &AppState, sid: &str) -> String {
    static C: OnceLock<Mutex<HashMap<String, (Instant, String)>>> = OnceLock::new();
    let c = C.get_or_init(Default::default);
    if let Some((at, dir)) = c.lock().unwrap().get(sid) {
        if at.elapsed() < Duration::from_secs(30) {
            return dir.clone();
        }
    }
    let dir = state
        .ssh
        .probe_cwd(sid)
        .await
        .ok()
        .flatten()
        .unwrap_or_default();
    c.lock()
        .unwrap()
        .insert(sid.to_string(), (Instant::now(), dir.clone()));
    dir
}
