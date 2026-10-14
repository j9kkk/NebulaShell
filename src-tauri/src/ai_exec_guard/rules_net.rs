//! 写入、解释器、自断连接与外联规则。

use super::lexer::{Lexed, Segment, Sep, Word};
use super::paths::{normalize, path_policy, PathPolicy};
use super::rules::{segment_head, Args};
use super::*;

pub(super) fn is_tmp_path(p: &str) -> bool {
    ["/tmp/", "/var/tmp/", "/dev/shm/"]
        .iter()
        .any(|d| p.starts_with(d))
}

pub(super) fn is_block_device(p: &str) -> bool {
    const SAFE: &[&str] = &[
        "/dev/null",
        "/dev/zero",
        "/dev/random",
        "/dev/urandom",
        "/dev/stdin",
        "/dev/stdout",
        "/dev/stderr",
        "/dev/tty",
    ];
    p.starts_with("/dev/")
        && !SAFE.contains(&p)
        && !["/dev/fd/", "/dev/pts/", "/dev/shm/"]
            .iter()
            .any(|d| p.starts_with(d))
}

/// 新建或覆盖都要确认的位置：提权、持久化、登录与启动链路。
fn sensitive_write_location(p: &str) -> bool {
    const PREFIXES: &[&str] = &[
        "/etc/sudoers",
        "/etc/cron",
        "/var/spool/cron",
        "/etc/profile",
        "/etc/passwd",
        "/etc/shadow",
        "/etc/group",
        "/etc/gshadow",
        "/etc/ssh/",
        "/etc/pam.d/",
        "/boot/",
        "/etc/security/",
    ];
    const EXACT: &[&str] = &[
        "/etc/bash.bashrc",
        "/etc/environment",
        "/etc/ld.so.preload",
        "/etc/rc.local",
        "/etc/hosts.allow",
        "/etc/hosts.deny",
        "/etc/fstab",
    ];
    const SUFFIXES: &[&str] = &[
        "/.bashrc",
        "/.bash_profile",
        "/.bash_login",
        "/.profile",
        "/.zshrc",
        "/.zprofile",
    ];
    let n = normalize(p);
    PREFIXES.iter().any(|x| n.starts_with(x))
        || EXACT.contains(&n.as_str())
        || SUFFIXES.iter().any(|x| n.ends_with(x))
        || n.contains("/.ssh/")
}

/// 记录一次写入：敏感位置与磁盘设备直接升档，其余非追加写入留给调用方查存在性。
pub(super) fn note_write(target: &Word, append: bool, v: &mut Verdict) {
    if target.dynamic {
        v.add(Tier::Danger, R_DYNAMIC_TARGET);
        return;
    }
    note_write_path(&target.text, append || target.glob, v);
}

pub(super) fn note_write_path(t: &str, append: bool, v: &mut Verdict) {
    if t.is_empty() {
        return;
    }
    if is_block_device(t) {
        v.add(Tier::Danger, R_DISK);
    } else if t.starts_with("/dev/") {
    } else if sensitive_write_location(t) {
        v.add(Tier::Danger, R_SENSITIVE_WRITE);
    } else if !append {
        push_unique(&mut v.redirect_targets, t.to_string());
    }
}

pub(super) fn redirects(seg: &Segment, v: &mut Verdict) {
    let is_fd = |t: &str| t == "-" || (!t.is_empty() && t.chars().all(|c| c.is_ascii_digit()));
    for r in &seg.redirects {
        match r.op {
            ">" | ">|" | "&>" => note_write(&r.target, false, v),
            ">>" | "&>>" | "<>" => note_write(&r.target, true, v),
            ">&" if !is_fd(&r.target.text) => note_write(&r.target, false, v),
            "<" if !r.target.dynamic && path_policy(&r.target.text) == PathPolicy::Deny => {
                v.add(Tier::Danger, R_SENSITIVE)
            }
            _ => {}
        }
    }
}

pub(super) fn writes(head: &str, w: &[Word], v: &mut Verdict) {
    let a = Args(w);
    match head {
        "tee" => {
            let append = a.short('a') || a.has("--append");
            for x in a.positional() {
                note_write(x, append, v);
            }
        }
        "cp" | "mv" | "install" | "ln" => {
            if head == "ln" && !(a.short('f') || a.has("--force")) {
                return;
            }
            if a.texts()
                .any(|t| t == "-t" || t.starts_with("--target-directory"))
            {
                return;
            }
            let pos = a.positional();
            if pos.len() >= 2 {
                note_write(pos[pos.len() - 1], false, v);
            }
        }
        "sed" => {
            let inplace = a.texts().any(|t| {
                t == "--in-place"
                    || t.starts_with("--in-place=")
                    || (t.starts_with('-') && !t.starts_with("--") && t[1..].contains('i'))
            });
            if inplace {
                v.add(Tier::Danger, R_INPLACE);
                for x in a.positional().into_iter().skip(1) {
                    if !x.dynamic && sensitive_write_location(&x.text) {
                        v.add(Tier::Danger, R_SENSITIVE_WRITE);
                    }
                }
            }
        }
        "curl" | "wget" => {
            let names: &[&str] = if head == "curl" {
                &["-o", "--output"]
            } else {
                &["-O", "--output-document"]
            };
            for (i, x) in w.iter().enumerate() {
                if names.contains(&x.text.as_str()) {
                    if let Some(t) = w.get(i + 1) {
                        note_write(t, false, v);
                    }
                }
            }
        }
        _ => {}
    }
}

const SHELLS: &[&str] = &[
    "sh", "bash", "zsh", "dash", "ksh", "mksh", "ash", "fish", "csh", "tcsh", "rbash",
];
const DOWNLOADERS: &[&str] = &[
    "curl", "wget", "fetch", "aria2c", "axel", "http", "https", "xh", "nc", "ncat", "socat", "scp",
    "ssh", "lynx", "w3m",
];

fn is_interpreter(h: &str) -> bool {
    h.starts_with("python")
        || h.starts_with("pypy")
        || h.starts_with("perl")
        || h.starts_with("php")
        || h.starts_with("lua")
        || matches!(
            h,
            "ruby"
                | "node"
                | "nodejs"
                | "deno"
                | "bun"
                | "Rscript"
                | "tclsh"
                | "osascript"
                | "pwsh"
                | "powershell"
                | "expect"
                | "julia"
                | "groovy"
        )
}

/// 解释器的内联代码选项（程序文本在命令行上，规则看不到里面）。
fn has_inline_code(head: &str, w: &[Word]) -> bool {
    let opts: Vec<&str> = w
        .iter()
        .map(|x| x.text.as_str())
        .take_while(|t| t.starts_with('-'))
        .collect();
    // 短选项簇里的字母（遇到非字母即止：-I/usr/share 不算含 e）。
    let cluster = |t: &str| -> String {
        if t.starts_with("--") {
            return String::new();
        }
        t[1..]
            .chars()
            .take_while(|c| c.is_ascii_alphabetic())
            .collect()
    };
    if head.starts_with("python") || head.starts_with("pypy") {
        return opts.iter().any(|t| cluster(t).ends_with('c'));
    }
    if head.starts_with("perl") || head == "ruby" {
        return opts.iter().any(|t| cluster(t).contains(['e', 'E']));
    }
    match head {
        "node" | "nodejs" | "bun" => opts
            .iter()
            .any(|t| matches!(*t, "-e" | "--eval" | "-p" | "--print")),
        "deno" => w.first().is_some_and(|x| x.text == "eval"),
        "pwsh" | "powershell" => opts.iter().any(|t| {
            matches!(
                t.to_ascii_lowercase().as_str(),
                "-c" | "-command" | "-encodedcommand" | "-enc" | "-e" | "-ec"
            )
        }),
        "expect" => opts.contains(&"-c"),
        h if h.starts_with("php") => opts.contains(&"-r"),
        h if h.starts_with("lua") || h == "Rscript" || h == "osascript" => opts.contains(&"-e"),
        _ => false,
    }
}

/// 管道上游（`a | b | 本段`）里是否有下载/网络工具。
fn upstream_downloads(lx: &Lexed, idx: usize) -> bool {
    let mut j = idx;
    while j > 0 && lx.segments[j].sep_before == Sep::Pipe {
        j -= 1;
        if segment_head(&lx.segments[j]).is_some_and(|h| DOWNLOADERS.contains(&h.as_str())) {
            return true;
        }
    }
    false
}

fn mentions_download(body: &str) -> bool {
    body.split(|c: char| !c.is_ascii_alphanumeric() && c != '-')
        .any(|t| DOWNLOADERS.contains(&t))
}

pub(super) fn interpreters(
    lx: &Lexed,
    idx: usize,
    head: &str,
    w: &[Word],
    ctx: &GuardCtx,
    depth: usize,
    v: &mut Verdict,
) {
    let seg = &lx.segments[idx];
    match head {
        "eval" => {
            if w.iter().any(|x| x.dynamic) {
                v.add(Tier::Danger, R_OBFUSCATED);
            } else {
                let joined = w.iter().map(|x| x.text.as_str()).collect::<Vec<_>>();
                classify_nested(&joined.join(" "), ctx, depth, v);
            }
            return;
        }
        "source" | "." => {
            if let Some(f) = w.first() {
                if f.dynamic {
                    v.add(Tier::Danger, R_OBFUSCATED);
                } else if is_tmp_path(&f.text) {
                    v.add(Tier::Egress, R_TMP_EXEC);
                }
            }
            return;
        }
        "awk" | "gawk" | "mawk" | "nawk" => {
            awk(w, v);
            return;
        }
        _ => {}
    }
    let shell = SHELLS.contains(&head);
    if !shell && !is_interpreter(head) {
        return;
    }
    if shell {
        // -c 后的字符串就是命令行：递归分级（-lc、-ec 等短选项簇也算）。
        let c_flag = w
            .iter()
            .take_while(|x| x.text.starts_with('-'))
            .position(|x| {
                let t = x.text.as_str();
                !t.starts_with("--") && t[1..].contains('c')
            });
        if let Some(pos) = c_flag {
            match w.get(pos + 1) {
                Some(code) if code.dynamic => v.add(Tier::Danger, R_OBFUSCATED),
                Some(code) => classify_nested(&code.text, ctx, depth, v),
                None => {}
            }
            return;
        }
    } else if has_inline_code(head, w) {
        v.add(Tier::Danger, R_INLINE_SCRIPT);
        return;
    }
    // heredoc / here-string 喂给解释器。
    let mut fed_by_redirect = false;
    for r in &seg.redirects {
        match (r.op, &r.heredoc) {
            ("<<" | "<<-", Some(body)) => {
                fed_by_redirect = true;
                if shell {
                    classify_nested(body, ctx, depth, v);
                } else {
                    v.add(Tier::Danger, R_INLINE_SCRIPT);
                }
            }
            ("<<<", _) => {
                fed_by_redirect = true;
                if shell && !r.target.dynamic {
                    classify_nested(&r.target.text, ctx, depth, v);
                } else {
                    v.add(Tier::Danger, R_INLINE_SCRIPT);
                }
            }
            ("<", _) => {
                fed_by_redirect = true;
                if is_tmp_path(&r.target.text) {
                    v.add(Tier::Egress, R_TMP_EXEC);
                }
            }
            _ => {}
        }
    }
    let a = Args(w);
    let script = a.positional().into_iter().next();
    let reads_stdin = script.is_none() || (shell && a.short('s'));
    match script {
        Some(s) if s.proc_subst => {
            let dl = lx.proc_substitutions.iter().any(|b| mentions_download(b));
            v.add(
                Tier::Danger,
                if dl { R_DOWNLOAD_SHELL } else { R_PIPE_SHELL },
            );
        }
        Some(s) if s.dynamic && !(shell && a.short('s')) => v.add(Tier::Danger, R_OBFUSCATED),
        Some(s) if is_tmp_path(&s.text) && !(shell && a.short('s')) => {
            v.add(Tier::Egress, R_TMP_EXEC)
        }
        _ => {}
    }
    // 从 stdin 读程序且上游是管道：把内容直接交给解释器执行。
    if reads_stdin && !fed_by_redirect && seg.sep_before == Sep::Pipe {
        let dl = upstream_downloads(lx, idx);
        v.add(
            Tier::Danger,
            if dl { R_DOWNLOAD_SHELL } else { R_PIPE_SHELL },
        );
    }
}

fn awk(w: &[Word], v: &mut Verdict) {
    let mut i = 0;
    while let Some(x) = w.get(i) {
        match x.text.as_str() {
            "-f" | "--file" => return,
            "-F" | "-v" | "--assign" | "--field-separator" => i += 2,
            t if t.starts_with('-') && t != "-" => i += 1,
            _ => break,
        }
    }
    let Some(p) = w.get(i) else {
        return;
    };
    let prog = p.text.as_str();
    let pipes = prog.replace("||", "").contains('|');
    let print_to_file = prog.contains("print") && (prog.contains(">\"") || prog.contains("> \""));
    if prog.contains("system(") || pipes || print_to_file || p.dynamic {
        v.add(Tier::Danger, R_INLINE_SCRIPT);
    }
}

pub(super) fn disconnect(lx: &Lexed, idx: usize, head: &str, w: &[Word], v: &mut Verdict) {
    let a = Args(w);
    let pos = a.pos_text();
    let unit = |x: &str| {
        x.trim_end_matches(".service")
            .trim_end_matches(".socket")
            .to_string()
    };
    let ssh_unit = |x: &str| matches!(unit(x).as_str(), "ssh" | "sshd" | "openssh-server");
    let net_unit = |x: &str| {
        matches!(
            unit(x).as_str(),
            "network" | "networking" | "NetworkManager" | "systemd-networkd" | "wicked"
        )
    };
    let cut = match head {
        "systemctl" => {
            let verb = pos.first().copied().unwrap_or("");
            let units = pos.iter().skip(1);
            match verb {
                "stop" | "disable" | "mask" | "kill" => {
                    units.clone().any(|u| ssh_unit(u) || net_unit(u))
                }
                "restart" | "try-restart" | "reload-or-restart" => {
                    units.clone().any(|u| net_unit(u))
                }
                "isolate" => true,
                _ => false,
            }
        }
        "service" => {
            let (u, act) = (
                pos.first().copied().unwrap_or(""),
                pos.get(1).copied().unwrap_or(""),
            );
            (ssh_unit(u) && act == "stop") || (net_unit(u) && matches!(act, "stop" | "restart"))
        }
        "iptables" | "ip6tables" | "iptables-nft" | "iptables-legacy" => {
            a.has_any(&["-F", "--flush"])
                || ((a.has_any(&["-P", "--policy"]) || a.has_any(&["-j", "--jump"]))
                    && a.has_any(&["DROP", "REJECT"]))
        }
        "iptables-restore" | "ip6tables-restore" => true,
        "nft" => a.has_any(&["flush", "delete", "-f", "--file", "destroy"]),
        "firewall-cmd" => a.texts().any(|t| {
            t == "--panic-on" || t == "--set-default-zone=drop" || t == "--set-default-zone=block"
        }),
        "ufw" => {
            let verb = pos.first().copied().unwrap_or("");
            let names_ssh = pos
                .iter()
                .any(|t| matches!(*t, "22" | "22/tcp" | "ssh" | "OpenSSH" | "openssh"));
            match verb {
                "enable" => !prior_ufw_allows_ssh(lx, idx),
                "reset" => true,
                "default" => a.has_any(&["deny", "reject"]) && !a.has_any(&["outgoing", "routed"]),
                "deny" | "reject" | "delete" => names_ssh,
                _ => false,
            }
        }
        "ip" => {
            let p = &pos;
            let obj = p.first().copied().unwrap_or("");
            let act = p.get(1).copied().unwrap_or("");
            (matches!(obj, "link" | "l") && p.contains(&"down"))
                || (matches!(obj, "addr" | "address" | "a")
                    && matches!(act, "flush" | "del" | "delete"))
                || (matches!(obj, "route" | "r" | "ro")
                    && matches!(act, "del" | "delete" | "flush" | "replace"))
        }
        "ifdown" => true,
        "ifconfig" => pos.contains(&"down"),
        "nmcli" => a.has_any(&["down", "off", "disconnect", "delete"]),
        "netplan" => a.has("apply"),
        _ => false,
    };
    if cut {
        v.add(Tier::Danger, R_DISCONNECT);
    }
}

/// 同一命令行里先放行了 SSH（`ufw allow 22 && ufw enable`）。
fn prior_ufw_allows_ssh(lx: &Lexed, idx: usize) -> bool {
    lx.segments[..idx].iter().any(|s| {
        segment_head(s).as_deref() == Some("ufw")
            && s.words
                .iter()
                .any(|w| matches!(w.text.as_str(), "allow" | "limit"))
            && s.words.iter().any(|w| {
                matches!(
                    w.text.as_str(),
                    "22" | "22/tcp" | "ssh" | "OpenSSH" | "openssh" | "'OpenSSH'"
                )
            })
    })
}

fn is_local_host(h: &str) -> bool {
    let h = h
        .trim_matches(|c| c == '[' || c == ']')
        .to_ascii_lowercase();
    h == "localhost"
        || h.ends_with(".localhost")
        || h.starts_with("127.")
        || h == "::1"
        || h == "0.0.0.0"
}

/// 从 URL 或 `host[:port][/path]` 形态的参数里取主机名。
fn host_of(t: &str) -> Option<String> {
    let (rest, has_scheme) = match t.find("://") {
        Some(p) => (&t[p + 3..], true),
        None => {
            if t.starts_with(['/', '.', '@', '~']) {
                return None;
            }
            (t, false)
        }
    };
    let hostport = rest.split(['/', '?', '#']).next()?;
    let hostport = hostport.rsplit('@').next()?;
    let host = match hostport.strip_prefix('[') {
        Some(v6) => v6.split(']').next()?.to_string(),
        None => hostport.split(':').next()?.to_string(),
    };
    if host.is_empty() {
        return None;
    }
    (has_scheme || host == "localhost" || host.contains('.') || hostport.contains(':'))
        .then_some(host)
}

/// 参数里的网络目标都在本机。没有可识别的目标时按外部处理（fail-closed）。
fn all_targets_local(w: &[Word], value_opts: &[&str]) -> bool {
    let mut found = false;
    let mut i = 0;
    while let Some(x) = w.get(i) {
        let t = x.text.as_str();
        if value_opts.contains(&t) {
            i += 2;
            continue;
        }
        i += 1;
        if t.starts_with('-') {
            continue;
        }
        if x.dynamic {
            return false;
        }
        if let Some(h) = host_of(t) {
            found = true;
            if !is_local_host(&h) {
                return false;
            }
        }
    }
    found
}

const CURL_VALUE_OPTS: &[&str] = &[
    "-o",
    "-u",
    "-X",
    "-H",
    "-A",
    "-e",
    "-m",
    "-w",
    "-x",
    "-K",
    "-c",
    "-b",
    "-E",
    "-r",
    "-y",
    "-Y",
    "-z",
    "-C",
    "-U",
    "--output",
    "--user",
    "--request",
    "--header",
    "--user-agent",
    "--referer",
    "--max-time",
    "--connect-timeout",
    "--write-out",
    "--proxy",
    "--config",
    "--cookie",
    "--cookie-jar",
    "--cert",
    "--key",
    "--cacert",
    "--capath",
    "--resolve",
    "--retry",
    "--retry-delay",
    "--limit-rate",
    "--max-filesize",
    "--range",
    "--interface",
];
const WGET_VALUE_OPTS: &[&str] = &[
    "-O",
    "-o",
    "-a",
    "-P",
    "-U",
    "-t",
    "-T",
    "-w",
    "-e",
    "--output-document",
    "--output-file",
    "--directory-prefix",
    "--user-agent",
    "--tries",
    "--timeout",
    "--wait",
    "--header",
    "--user",
    "--password",
];
const NC_VALUE_OPTS: &[&str] = &["-w", "-p", "-s", "-i", "-q", "-x", "-X", "-I", "-O", "-T"];

pub(super) fn network(head: &str, w: &[Word], v: &mut Verdict) {
    let a = Args(w);
    match head {
        "curl" => {
            let upload = a.texts().any(|t| {
                matches!(
                    t,
                    "-d" | "-F" | "-T" | "--json" | "--form" | "--upload-file"
                ) || t.starts_with("--data")
                    || t.starts_with("--form")
                    || (t.len() > 2 && ["-d", "-F", "-T"].iter().any(|p| t.starts_with(p)))
            });
            if upload {
                v.add(Tier::Egress, R_UPLOAD);
            } else if !(a.has("--unix-socket") || all_targets_local(w, CURL_VALUE_OPTS)) {
                v.add(Tier::Egress, R_NETWORK);
            }
        }
        "wget" => {
            if a.texts().any(|t| {
                t.starts_with("--post-") || t.starts_with("--body-") || t.starts_with("--method")
            }) {
                v.add(Tier::Egress, R_UPLOAD);
            } else if !all_targets_local(w, WGET_VALUE_OPTS) {
                v.add(Tier::Egress, R_NETWORK);
            }
        }
        "aria2c" | "axel" | "fetch" | "http" | "https" | "xh" | "lynx" | "links" | "w3m" => {
            if !all_targets_local(w, &[]) {
                v.add(Tier::Egress, R_NETWORK);
            }
        }
        "nc" | "ncat" | "netcat" | "telnet" => {
            if a.texts()
                .any(|t| matches!(t, "-e" | "-c" | "--exec" | "--sh-exec" | "--lua-exec"))
            {
                v.add(Tier::Danger, R_OBFUSCATED);
            } else if a.short('l') || !all_targets_local(w, NC_VALUE_OPTS) {
                v.add(Tier::Egress, R_NETWORK);
            }
        }
        "socat" => {
            let lower: Vec<String> = a.texts().map(|t| t.to_ascii_lowercase()).collect();
            if lower
                .iter()
                .any(|t| t.starts_with("exec:") || t.starts_with("system:"))
            {
                v.add(Tier::Danger, R_OBFUSCATED);
            } else {
                v.add(Tier::Egress, R_NETWORK);
            }
        }
        "ssh" | "scp" | "sftp" | "ftp" | "lftp" | "tftp" | "sshpass" | "ssh-copy-id" | "mosh" => {
            v.add(Tier::Egress, R_REMOTE)
        }
        "rsync" => {
            let remote = a.pos_text().iter().any(|t| {
                t.starts_with("rsync://")
                    || t.split_once(':')
                        .is_some_and(|(h, _)| !h.is_empty() && !h.contains('/'))
            });
            if remote {
                v.add(Tier::Egress, R_REMOTE);
            }
        }
        "openssl" if a.has("s_client") => v.add(Tier::Egress, R_NETWORK),
        // DNS/ICMP 本身只读，但参数里带运行期内容可以把数据外带出去。
        "dig" | "nslookup" | "host" | "ping" | "ping6" | "traceroute" | "tracepath" | "mtr"
        | "whois" | "drill" => {
            if w.iter().any(|x| x.dynamic) {
                v.add(Tier::Egress, R_NETWORK);
            }
        }
        _ => {}
    }
}
