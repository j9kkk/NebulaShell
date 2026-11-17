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
    /// `"unix"` | `"windows"` | `""`
    pub os_family: String,
    pub user: String,
    pub uid: Option<u32>,
    pub is_root: bool,
    pub shell: String,
    pub systemd: bool,
    pub journald: bool,
    /// 识别出已知系统（Linux/BSD/macOS 或 Windows）；否则所有命令都要用户确认。
    pub os_known: bool,
}

const PROBE: &str = "uname -srm 2>/dev/null; echo __NB_SEP; cat /etc/os-release 2>/dev/null; echo __NB_SEP; id -un 2>/dev/null; id -u 2>/dev/null; echo \"$SHELL\"; echo __NB_SEP; command -v systemctl >/dev/null 2>&1 && echo systemd; command -v journalctl >/dev/null 2>&1 && echo journald";

/// Windows OpenSSH 探测命令（当 POSIX PROBE 失败或未识别出类 Unix 系统时回退）：
pub const WIN_PROBE: &str = "powershell -NoLogo -NoProfile -NonInteractive -Command \"$ErrorActionPreference='SilentlyContinue'; $os=Get-CimInstance Win32_OperatingSystem; $isAdmin=([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator); Write-Output '__NB_WIN_HOSTINFO__'; Write-Output ('Windows_NT ' + $os.Version + ' ' + $env:PROCESSOR_ARCHITECTURE); Write-Output $os.Caption; Write-Output $env:USERNAME; Write-Output ($(if($isAdmin){'admin'}else{'user'})); Write-Output 'PowerShell'\"";

pub(super) fn parse(out: &str) -> HostInfo {
    if let Some((_, win_body)) = out.split_once("__NB_WIN_HOSTINFO__") {
        let lines: Vec<&str> = win_body
            .lines()
            .map(str::trim)
            .filter(|l| !l.is_empty())
            .collect();
        let kernel = lines.first().copied().unwrap_or("Windows_NT").to_string();
        let os = lines
            .get(1)
            .copied()
            .filter(|s| !s.is_empty())
            .unwrap_or("Microsoft Windows")
            .to_string();
        let user = lines.get(2).copied().unwrap_or("Administrator").to_string();
        let is_admin = lines.get(3).copied() == Some("admin");
        let shell = lines.get(4).copied().unwrap_or("PowerShell").to_string();
        return HostInfo {
            kernel,
            os,
            os_id: "windows".to_string(),
            os_family: "windows".to_string(),
            user,
            uid: if is_admin { Some(0) } else { Some(1000) },
            is_root: is_admin,
            shell,
            systemd: false,
            journald: false,
            os_known: true,
        };
    }
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
    }
    info.is_root = info.uid == Some(0);
    let k = info.kernel.to_ascii_lowercase();
    info.os_known = ["linux", "darwin", "freebsd", "openbsd", "netbsd"]
        .iter()
        .any(|p| k.starts_with(p));
    if info.os_known {
        info.os_family = "unix".to_string();
    }
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

/// 查询某会话是否已被识别为 Windows 主机（供 run::quick / run::run 选择包装器）。
pub(super) fn is_windows_cached(sid: &str) -> bool {
    let c = cache().lock().unwrap();
    c.iter()
        .any(|((s, _), info)| s == sid && info.os_family == "windows")
}

/// 按 (会话, 连接代次) 缓存；重连后代次变化自然重新探测。
pub(super) async fn get(state: &AppState, sid: &str, epoch: u64, refresh: bool) -> HostInfo {
    let key = (sid.to_string(), epoch);
    if !refresh {
        if let Some(info) = cache().lock().unwrap().get(&key) {
            return info.clone();
        }
    }
    let mut info = match quick(state, sid, PROBE, None, Duration::from_secs(6)).await {
        Ok((_, out)) => parse(&out),
        Err(_) => HostInfo::default(),
    };
    if !info.os_known {
        // POSIX 探测失败（Windows OpenSSH 默认 cmd.exe 或 PowerShell 不支持 `exec sh -c`），
        // 直接走原始 SSH exec 探测 Windows 主机信息。
        if let Ok(Ok((_, win_out))) =
            tokio::time::timeout(Duration::from_secs(6), state.ssh.exec(sid, WIN_PROBE)).await
        {
            let win_info = parse(&win_out);
            if win_info.os_known {
                info = win_info;
            }
        }
    }
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
    if i.os_family == "windows" {
        let admin = if i.is_root { "（管理员）" } else { "" };
        return format!(
            "系统：{}；内核：{}；用户：{}{admin}；Shell：{}（Windows OpenSSH）",
            i.os, i.kernel, i.user, i.shell
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
