//! 会话授权（自动模式下按「授权类 + 目标」免确认）的唯一判定处。
//!
//! 下载类只靠静态信息；高危子集（修改/覆盖/删除单个文件、结束进程、卸载软件包）
//! 还要远端事实：目标所在目录的真实路径、实际命中的进程、卸载模拟的结果。
//! 没有备份兜底——授权即接受「该范围内的同类操作直接执行、不可撤销」，所以
//! 范围要窄，任何前提缺失或复核失败都按不可授权处理（逐条确认）。

use super::paths::{path_policy, PathPolicy};
use super::rules::basename;
use super::rules_net::{in_exec_dir, sensitive_write_location};
use super::*;

pub const G_DOWNLOAD: &str = RULE_DOWNLOAD;
pub const G_MODIFY: &str = "danger.modify";
pub const G_DELETE: &str = "danger.delete";
pub const G_KILL: &str = "danger.kill";
pub const G_UNINSTALL: &str = "danger.uninstall";

pub const B_TARGET: &str = "操作目标无法静态确定";
pub const B_CWD: &str = "命令切换了执行目录或根目录，目标路径无法确定";
pub const B_FLOW: &str = "命令含条件或循环结构，目标无法静态确定";
pub const B_KILL_MODE: &str = "结束进程的方式过宽（进程组、全部进程或按条件匹配）";
pub const B_PKG_MODE: &str = "卸载方式不可授权（彻底清除、自动清理、强制、指定版本或通配）";
pub const B_PKG_MGR: &str = "该包管理器暂不支持授权";
pub const B_WIPE: &str = "安全擦除不可授权";
pub const B_RECHECK: &str = "无法完成授权所需的远端复核";

/// 一次结束的进程上限：超过多半是匹配写宽了。
const MAX_KILL: usize = 20;

/// 规则 ID → 授权类。原地修改与覆盖已有文件同属「修改文件」。
pub fn class_of(rule_id: &str) -> Option<&'static str> {
    match rule_id {
        RULE_DOWNLOAD => Some(G_DOWNLOAD),
        "danger.inplace" | "danger.overwrite-existing" => Some(G_MODIFY),
        "danger.delete" => Some(G_DELETE),
        "danger.kill" => Some(G_KILL),
        "danger.uninstall" => Some(G_UNINSTALL),
        _ => None,
    }
}

fn label(class: &str) -> &'static str {
    match class {
        G_MODIFY => "修改文件",
        G_DELETE => "删除文件",
        G_KILL => "结束进程",
        G_UNINSTALL => "卸载",
        _ => "下载",
    }
}

/// 高危可授权原因必须随目标一并登记（`Verdict::add_targets`）；规则分支直接
/// `add` 说明目标看不清，`Verdict::add` 据此自动阻断授权。
pub(crate) fn needs_target(reason: &str) -> bool {
    matches!(reason, R_INPLACE | R_DELETE | R_KILL | R_UNINSTALL)
        || reason.starts_with(R_OVERWRITE_EXISTING)
}

/// 高危授权的静态目标，在规则分支里随原因登记。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GrantTarget {
    /// 文件类：授权类（G_MODIFY/G_DELETE）与按执行目录解析后的路径（可能以 `~/` 开头）。
    File {
        class: &'static str,
        path: String,
    },
    Kill(KillSel),
    Pkg {
        mgr: PkgMgr,
        pkgs: Vec<String>,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum KillSel {
    Pids(Vec<u32>),
    /// pkill/killall 的名字；`exact` = 整名匹配（killall、pkill -x）。
    Name {
        pattern: String,
        exact: bool,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PkgMgr {
    Apt,
    Dnf,
    Yum,
    Dpkg,
    Rpm,
    Pacman,
    Snap,
    Flatpak,
    Pip,
}

impl PkgMgr {
    /// 会连带卸载、必须先模拟的包管理器的模拟命令；其余遇到依赖会直接拒绝卸载。
    fn simulation(self) -> Option<&'static str> {
        match self {
            PkgMgr::Apt => Some("apt-get -s remove"),
            // 卸载只看本机包数据库：禁用软件源，免得刷元数据联网超时。
            PkgMgr::Dnf => Some("dnf remove --assumeno --disablerepo='*'"),
            PkgMgr::Yum => Some("yum remove --assumeno --disablerepo='*'"),
            _ => None,
        }
    }
}

/// 远端复核取回的事实，`targets` 与 `Verdict::grant_targets` 下标对齐。
#[derive(Debug, Clone, Default)]
pub struct Facts {
    /// 家目录的真实路径（判定过宽前缀）。
    pub home: Option<String>,
    pub targets: Vec<TargetFact>,
    pub procs: Vec<Proc>,
    /// 要结束的进程的完整命令行（PID → args），审计留痕用。
    pub args: Vec<(u32, String)>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TargetFact {
    /// 文件：目标所在目录的真实路径。
    Dir(String),
    /// 文件本身是符号链接。
    Link,
    /// pkill/killall 实际命中的 PID。
    Pids(Vec<u32>),
    /// 卸载模拟的输出。
    Sim(String),
    Missing,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Proc {
    pub pid: u32,
    pub ppid: u32,
    pub uid: u32,
    pub comm: String,
}

/// 执行身份：进程属主判定用。
#[derive(Debug, Clone, Copy, Default)]
pub struct Who {
    pub uid: Option<u32>,
    pub as_root: bool,
}

/// 是否值得去取远端事实：全部规则都属可授权类，且没有静态阻断原因。
pub fn candidate(v: &Verdict) -> bool {
    !v.force_confirm
        && v.allow_block.is_none()
        && !v.rule_ids.is_empty()
        && v.rule_ids.iter().all(|id| class_of(id).is_some())
}

/// 授权判定。Ok = 可授权条目（每类一条，键去重保序）；Err(Some) = 规则都可授权
/// 但前提不满足，原因写在确认卡上；Err(None) = 不在可授权范围。
/// 必须在全部补判（远端「覆盖已有文件」检查）之后、用该命令自己的事实调用。
pub fn evaluate(
    v: &Verdict,
    f: &Facts,
    tainted: &[String],
    who: Who,
) -> Result<Vec<Allowable>, Option<String>> {
    if v.force_confirm
        || v.rule_ids.is_empty()
        || !v.rule_ids.iter().all(|id| class_of(id).is_some())
    {
        return Err(None);
    }
    if let Some(b) = &v.allow_block {
        return Err(Some(b.clone()));
    }
    let mut items: Vec<Allowable> = Vec::new();
    let mut push =
        |class: &'static str, key: String| match items.iter_mut().find(|a| a.rule == class) {
            Some(a) => push_unique(&mut a.keys, key),
            None => items.push(Allowable {
                rule: class,
                label: label(class),
                keys: vec![key],
            }),
        };
    if v.rule_ids.iter().any(|id| id == RULE_DOWNLOAD) {
        if v.net_hosts.is_empty() {
            return Err(None);
        }
        for h in &v.net_hosts {
            push(G_DOWNLOAD, h.to_ascii_lowercase());
        }
    }
    for (i, t) in v.grant_targets.iter().enumerate() {
        let fact = f.targets.get(i).unwrap_or(&TargetFact::Missing);
        match t {
            GrantTarget::File { class, path } => push(*class, file_key(path, fact, f, tainted)?),
            GrantTarget::Kill(sel) => {
                for name in kill_names(sel, fact, f, who)? {
                    push(G_KILL, name);
                }
            }
            GrantTarget::Pkg { mgr, pkgs } => {
                for p in pkg_names(*mgr, pkgs, fact)? {
                    push(G_UNINSTALL, p);
                }
            }
        }
    }
    // 每条高危规则都得落到至少一个目标上，否则是哪里漏登了目标：不可授权。
    for id in &v.rule_ids {
        let c = class_of(id).unwrap_or(G_DOWNLOAD);
        if !items.iter().any(|a| a.rule == c) {
            return Err(Some(B_TARGET.to_string()));
        }
    }
    Ok(items)
}

/// 授权是否覆盖全部条目。目录类按前缀命中（授权 `/a/b/` 覆盖 `/a/b/c/`）。
pub fn covered(items: &[Allowable], allow: &[(String, String)]) -> bool {
    !items.is_empty()
        && items.iter().all(|a| {
            a.keys.iter().all(|k| {
                allow
                    .iter()
                    .any(|(r, g)| r == a.rule && key_matches(a.rule, g, k))
            })
        })
}

fn key_matches(class: &str, granted: &str, key: &str) -> bool {
    match class {
        G_MODIFY | G_DELETE => granted.ends_with('/') && key.starts_with(granted),
        G_DOWNLOAD => granted.eq_ignore_ascii_case(key),
        _ => granted == key,
    }
}

/// 文件类授权键 = 目标所在目录的真实路径（带尾 `/`）。
fn file_key(
    path: &str,
    fact: &TargetFact,
    f: &Facts,
    tainted: &[String],
) -> Result<String, Option<String>> {
    let dir = match fact {
        TargetFact::Dir(d) if d.starts_with('/') => d,
        TargetFact::Link => return Err(Some("目标是符号链接".into())),
        _ => return Err(Some("无法确认目标所在目录".into())),
    };
    let key = format!("{}/", dir.trim_end_matches('/'));
    let home = f
        .home
        .as_deref()
        .map(|h| format!("{}/", h.trim_end_matches('/')));
    if key.matches('/').count() < 3 || home.as_deref() == Some(key.as_str()) {
        return Err(Some(format!("目录范围过宽：{key}")));
    }
    let real = format!("{key}{}", basename(path));
    for p in [path, real.as_str()] {
        if sensitive_write_location(p) || path_policy(p) == PathPolicy::Deny {
            return Err(Some("目标在敏感位置".into()));
        }
        if in_exec_dir(p) {
            return Err(Some("目标在可执行目录".into()));
        }
        if tainted.iter().any(|t| {
            p == t
                || p.strip_prefix(t.as_str())
                    .is_some_and(|r| r.starts_with('/'))
        }) {
            return Err(Some("目标是本会话下载的文件".into()));
        }
    }
    Ok(key)
}

/// 永不可授权结束的进程：结束后主机失联、服务全停或系统失稳。
fn protected_proc(name: &str) -> bool {
    const EXACT: &[&str] = &[
        "init",
        "launchd",
        "sshd",
        "sshd-session",
        "sshd-auth",
        "dbus-daemon",
        "dbus-broker",
        "udevd",
        "journald",
        "networkd",
        "NetworkManager",
        "dhclient",
        "dhcpcd",
        "wpa_supplicant",
        "dockerd",
        "kubelet",
        "kube-proxy",
        "agetty",
        "getty",
        "login",
        "auditd",
        "polkitd",
    ];
    const PREFIX: &[&str] = &["systemd", "containerd"];
    EXACT.contains(&name) || PREFIX.iter().any(|p| name.starts_with(p))
}

fn is_sshd(comm: &str) -> bool {
    matches!(basename(comm), "sshd" | "sshd-session" | "sshd-auth")
}

fn kill_names(
    sel: &KillSel,
    fact: &TargetFact,
    f: &Facts,
    who: Who,
) -> Result<Vec<String>, Option<String>> {
    let pids = match (sel, fact) {
        (KillSel::Pids(p), _) => p.clone(),
        (KillSel::Name { .. }, TargetFact::Pids(p)) => p.clone(),
        _ => return Err(Some("无法查询要结束的进程".into())),
    };
    if pids.is_empty() {
        return Err(Some("没有匹配的进程".into()));
    }
    if pids.len() > MAX_KILL {
        return Err(Some(format!("一次结束的进程超过 {MAX_KILL} 个")));
    }
    if f.procs.is_empty() {
        return Err(Some("无法查询进程列表".into()));
    }
    let mut names = Vec::new();
    for pid in pids {
        if pid <= 1 {
            return Err(Some("PID 1 是系统初始进程，不可授权".into()));
        }
        let Some(p) = f.procs.iter().find(|p| p.pid == pid) else {
            return Err(Some(format!("进程 {pid} 不存在")));
        };
        let name = basename(&p.comm).to_string();
        if protected_proc(&name) {
            return Err(Some(format!("系统关键进程不可授权：{name}")));
        }
        if f.procs
            .iter()
            .find(|q| q.pid == p.ppid)
            .is_some_and(|q| is_sshd(&q.comm))
        {
            return Err(Some("SSH 会话的登录进程不可授权".into()));
        }
        if !who.as_root && who.uid != Some(p.uid) {
            return Err(Some(format!("进程 {pid} 属于其他用户")));
        }
        push_unique(&mut names, name);
    }
    Ok(names)
}

/// 永不可授权卸载的包：卸了就登不上、包管理器自身或系统基础组件。
fn protected_pkg(name: &str) -> bool {
    const EXACT: &[&str] = &[
        "sudo",
        "bash",
        "dash",
        "coreutils",
        "util-linux",
        "findutils",
        "grep",
        "sed",
        "tar",
        "gzip",
        "procps",
        "procps-ng",
        "login",
        "passwd",
        "shadow-utils",
        "ssh",
        "dpkg",
        "apt",
        "rpm",
        "yum",
        "dnf",
        "dnf5",
        "pacman",
        "pip",
        "python3",
        "python3-minimal",
        "libc6",
        "libc-bin",
        "pam",
        "libpam0g",
        "libpam-modules",
        "network-manager",
        "NetworkManager",
        "netplan.io",
        "ifupdown",
        "iproute",
        "iproute2",
        "init",
        "e2fsprogs",
        "ca-certificates",
    ];
    const PREFIX: &[&str] = &[
        "linux-image",
        "linux-generic",
        "linux-modules",
        "linux-firmware",
        "kernel",
        "systemd",
        "libsystemd",
        "glibc",
        "openssh",
        "grub",
        "python3.",
    ];
    EXACT.contains(&name) || PREFIX.iter().any(|p| name.starts_with(p))
}

fn pkg_names(
    mgr: PkgMgr,
    pkgs: &[String],
    fact: &TargetFact,
) -> Result<Vec<String>, Option<String>> {
    let removed = match mgr.simulation() {
        Some(_) => {
            let TargetFact::Sim(out) = fact else {
                return Err(Some("无法模拟卸载".into()));
            };
            let parsed = if mgr == PkgMgr::Apt {
                parse_apt_sim(out)
            } else {
                parse_dnf_sim(out)
            };
            parsed.map_err(|e| Some(e.to_string()))?
        }
        None => pkgs.to_vec(),
    };
    let extra: Vec<&str> = removed
        .iter()
        .filter(|p| !pkgs.contains(p))
        .map(String::as_str)
        .collect();
    if !extra.is_empty() {
        return Err(Some(format!("会连带卸载：{}", extra.join("、"))));
    }
    if let Some(p) = pkgs.iter().chain(&removed).find(|p| protected_pkg(p)) {
        return Err(Some(format!("关键软件包不可授权：{p}")));
    }
    Ok(pkgs.to_vec())
}

/// `apt-get -s remove` 的实际卸载集合（`Remv 包名[:架构] [版本]` 行）。
pub fn parse_apt_sim(out: &str) -> Result<Vec<String>, &'static str> {
    if out.lines().any(|l| l.starts_with("E: ")) {
        return Err("模拟卸载失败");
    }
    if out.to_ascii_lowercase().contains("essential packages") {
        return Err("会卸载系统必需的软件包");
    }
    let mut names = Vec::new();
    for l in out.lines() {
        if let Some(rest) = l.strip_prefix("Remv ") {
            let name = rest.split_whitespace().next().unwrap_or("");
            let name = name.split(':').next().unwrap_or(name);
            if !name.is_empty() {
                push_unique(&mut names, name.to_string());
            }
        }
    }
    if names.is_empty() {
        return Err("模拟结果里没有要卸载的包");
    }
    Ok(names)
}

/// `dnf/yum remove --assumeno` 的实际卸载集合：所有 `Removing…` 小节里的行首包名。
pub fn parse_dnf_sim(out: &str) -> Result<Vec<String>, &'static str> {
    const ARCH: &[&str] = &[
        "x86_64", "noarch", "aarch64", "i686", "i386", "armv7hl", "ppc64le", "s390x",
    ];
    if out
        .lines()
        .any(|l| l.trim_start().starts_with("Error:") || l.contains("No match for argument"))
    {
        return Err("模拟卸载失败");
    }
    let mut names = Vec::new();
    let mut collect = false;
    for l in out.lines() {
        if l.trim().is_empty() {
            collect = false;
        } else if !l.starts_with(char::is_whitespace) {
            collect = l.starts_with("Removing");
        } else if collect {
            if let Some(name) = l.split_whitespace().next() {
                if !ARCH.contains(&name) {
                    push_unique(&mut names, name.to_string());
                }
            }
        }
    }
    if names.is_empty() {
        return Err("模拟结果里没有要卸载的包");
    }
    Ok(names)
}

/// 路径在复核脚本里的写法：`~/x` 保留波浪号展开，其余整体加引号。
fn sh_path(p: &str) -> String {
    match p.strip_prefix("~/") {
        Some(rest) => format!("~/{}", shell_quote(rest)),
        None if p == "~" => "~".to_string(),
        None => shell_quote(p),
    }
}

/// 复核脚本：一次远端执行取回全部事实。PATH 固定为系统目录，不执行命令里点名的程序。
pub fn facts_script(cwd: &str, targets: &[GrantTarget]) -> String {
    let mut s = String::from("PATH=/usr/sbin:/usr/bin:/sbin:/bin; export PATH\n");
    if !cwd.is_empty() {
        s.push_str(&format!("cd -- {} 2>/dev/null\n", sh_path(cwd)));
    }
    s.push_str("printf '@@HOME %s\\n' \"$(cd -P ~ 2>/dev/null && pwd -P)\"\nA=''\n");
    let mut need_ps = false;
    for (i, t) in targets.iter().enumerate() {
        match t {
            GrantTarget::File { path, .. } => {
                let q = sh_path(path);
                s.push_str(&format!(
                    "if [ -L {q} ]; then echo '@@T {i} L'; else d=$(cd -P -- \"$(dirname -- {q})\" 2>/dev/null && pwd -P) && printf '@@T {i} D %s\\n' \"$d\" || echo '@@T {i} X'; fi\n"
                ));
            }
            GrantTarget::Kill(sel) => {
                need_ps = true;
                match sel {
                    KillSel::Name { pattern, exact } => {
                        let x = if *exact { "-x " } else { "" };
                        s.push_str(&format!(
                            "printf '@@T {i} P'; for p in $(pgrep {x}-- {}); do printf ' %s' \"$p\"; A=\"$A,$p\"; done; echo\n",
                            shell_quote(pattern)
                        ));
                    }
                    KillSel::Pids(p) => {
                        let list: Vec<String> = p.iter().map(u32::to_string).collect();
                        s.push_str(&format!("A=\"$A,{}\"\n", list.join(",")));
                    }
                }
            }
            GrantTarget::Pkg { mgr, pkgs } => {
                if let Some(sim) = mgr.simulation() {
                    let list: Vec<String> = pkgs.iter().map(|p| shell_quote(p)).collect();
                    s.push_str(&format!(
                        "echo '@@T {i} S'; LC_ALL=C {sim} {} 2>&1; echo; echo '@@E {i}'\n",
                        list.join(" ")
                    ));
                }
            }
        }
    }
    if need_ps {
        s.push_str(
            "echo '@@PS'; ps -A -o pid= -o ppid= -o uid= -o comm= 2>/dev/null; echo '@@PSEND'\n",
        );
        // 只取要结束的那几个进程的完整命令行（审计留痕），不拉全表。
        s.push_str("A=${A#,}; echo '@@ARGS'; [ -n \"$A\" ] && ps -o pid= -o args= -p \"$A\" 2>/dev/null; echo '@@ARGSEND'\n");
    }
    s.push_str("true\n");
    s
}

/// 「覆盖已有文件」补判脚本：写入目标是已有普通文件，或复制/移动进已有目录时撞上
/// 同名文件，输出 `@@O 路径`；递归复制会合并同名目录，输出 `@@M 路径`；
/// 复制进已有目录但来源看不清，输出 `@@U`。
pub fn overwrite_script(cwd: &str, targets: &[String], copies: &[CopyDest]) -> String {
    let mut s = String::new();
    if !cwd.is_empty() {
        s.push_str(&format!("cd -- {} 2>/dev/null\n", sh_path(cwd)));
    }
    if !targets.is_empty() {
        let list: Vec<String> = targets.iter().map(|t| sh_path(t)).collect();
        s.push_str(&format!(
            "for f in {}; do [ -f \"$f\" ] && printf '@@O %s\\n' \"$f\"; done\n",
            list.join(" ")
        ));
    }
    for c in copies {
        let d = sh_path(&c.dest);
        let mut srcs = Vec::new();
        let mut unknown = false;
        for src in &c.srcs {
            match src {
                // 通配来源已校验只含路径与通配字符，原样交给远端 shell 展开。
                Some((p, true)) => srcs.push(match p.strip_prefix("~/") {
                    Some(rest) => format!("~/{rest}"),
                    None => p.clone(),
                }),
                Some((p, false)) => srcs.push(sh_path(p)),
                None => unknown = true,
            }
        }
        s.push_str(&format!("if [ -d {d} ]; then\n"));
        if unknown {
            s.push_str("echo '@@U'\n");
        }
        if !srcs.is_empty() {
            let merge = if c.recursive {
                "elif [ -d \"$t\" ]; then printf '@@M %s\\n' \"$t\"; "
            } else {
                ""
            };
            s.push_str(&format!(
                "for s in {}; do [ -e \"$s\" ] || continue; t={d}/\"${{s##*/}}\"; if [ -f \"$t\" ]; then printf '@@O %s\\n' \"$t\"; {merge}fi; done\n",
                srcs.join(" ")
            ));
        }
        s.push_str("fi\n");
    }
    s.push_str("true\n");
    s
}

/// 确认卡展示：这条命令实际会结束的进程（PID、名字）。
pub fn kill_preview(v: &Verdict, f: &Facts) -> Vec<(u32, String)> {
    let mut out = Vec::new();
    for (i, t) in v.grant_targets.iter().enumerate() {
        let GrantTarget::Kill(sel) = t else {
            continue;
        };
        let pids = match (sel, f.targets.get(i)) {
            (KillSel::Pids(p), _) => p.clone(),
            (_, Some(TargetFact::Pids(p))) => p.clone(),
            _ => continue,
        };
        for pid in pids {
            if let Some(p) = f.procs.iter().find(|p| p.pid == pid) {
                out.push((pid, basename(&p.comm).to_string()));
            }
        }
    }
    out
}

/// 审计留痕：结束前的进程快照（PID、名字、属主 uid、完整命令行）。
pub fn kill_snapshot(v: &Verdict, f: &Facts) -> Vec<(u32, String, Option<u32>, String)> {
    kill_preview(v, f)
        .into_iter()
        .map(|(pid, name)| {
            let uid = f.procs.iter().find(|p| p.pid == pid).map(|p| p.uid);
            let args = f
                .args
                .iter()
                .find(|(p, _)| *p == pid)
                .map(|(_, a)| a.clone())
                .unwrap_or_default();
            (pid, name, uid, args)
        })
        .collect()
}

/// 确认卡展示：卸载模拟得出的实际卸载集合（含连带卸载的包）。
pub fn pkg_preview(v: &Verdict, f: &Facts) -> Vec<String> {
    let mut out = Vec::new();
    for (i, t) in v.grant_targets.iter().enumerate() {
        let (GrantTarget::Pkg { mgr, .. }, Some(TargetFact::Sim(sim))) = (t, f.targets.get(i))
        else {
            continue;
        };
        let parsed = if *mgr == PkgMgr::Apt {
            parse_apt_sim(sim)
        } else {
            parse_dnf_sim(sim)
        };
        for p in parsed.unwrap_or_default() {
            push_unique(&mut out, p);
        }
    }
    out
}

/// 解析复核脚本输出；行格式见 `facts_script`。
pub fn parse_facts(out: &str, n: usize) -> Facts {
    let mut f = Facts {
        home: None,
        targets: vec![TargetFact::Missing; n],
        procs: Vec::new(),
        args: Vec::new(),
    };
    let mut sim: Option<(usize, String)> = None;
    let mut in_ps = false;
    let mut in_args = false;
    for line in out.lines() {
        if let Some(i) = sim.as_ref().map(|(i, _)| *i) {
            if line == format!("@@E {i}") {
                if let Some((i, buf)) = sim.take() {
                    f.targets[i] = TargetFact::Sim(buf);
                }
            } else if let Some((_, buf)) = sim.as_mut() {
                buf.push_str(line);
                buf.push('\n');
            }
            continue;
        }
        if in_ps {
            if line == "@@PSEND" {
                in_ps = false;
            } else if let Some(p) = parse_ps_line(line) {
                f.procs.push(p);
            }
            continue;
        }
        if in_args {
            if line == "@@ARGSEND" {
                in_args = false;
            } else if let Some((pid, args)) = line.trim_start().split_once(' ') {
                if let Ok(pid) = pid.parse() {
                    f.args.push((pid, args.trim().to_string()));
                }
            }
            continue;
        }
        if line == "@@PS" {
            in_ps = true;
        } else if line == "@@ARGS" {
            in_args = true;
        } else if let Some(h) = line.strip_prefix("@@HOME ") {
            let h = h.trim();
            f.home = h.starts_with('/').then(|| h.to_string());
        } else if let Some(rest) = line.strip_prefix("@@T ") {
            let mut it = rest.splitn(3, ' ');
            let (Some(i), Some(kind)) =
                (it.next().and_then(|x| x.parse::<usize>().ok()), it.next())
            else {
                continue;
            };
            if i >= n {
                continue;
            }
            let arg = it.next().unwrap_or("");
            f.targets[i] = match kind {
                "D" => TargetFact::Dir(arg.to_string()),
                "L" => TargetFact::Link,
                "P" => TargetFact::Pids(
                    arg.split_whitespace()
                        .filter_map(|p| p.parse().ok())
                        .collect(),
                ),
                "S" => {
                    sim = Some((i, String::new()));
                    TargetFact::Missing
                }
                _ => TargetFact::Missing,
            };
        }
    }
    f
}

fn parse_ps_line(line: &str) -> Option<Proc> {
    let mut it = line.split_whitespace();
    let pid = it.next()?.parse().ok()?;
    let ppid = it.next()?.parse().ok()?;
    let uid = it.next()?.parse().ok()?;
    let comm = it.collect::<Vec<_>>().join(" ");
    (!comm.is_empty()).then_some(Proc {
        pid,
        ppid,
        uid,
        comm,
    })
}
