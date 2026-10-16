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

/// 新建或覆盖都要确认的位置：提权、持久化、登录与启动链路、软件源与信任密钥。
pub(super) fn sensitive_write_location(p: &str) -> bool {
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
        // 开机/服务持久化
        "/etc/systemd/",
        "/lib/systemd/",
        "/usr/lib/systemd/",
        "/etc/init.d/",
        "/etc/rc",
        "/etc/update-motd.d/",
        // 软件源与信任密钥（之后安装的一切都来自这里）
        "/etc/apt/sources.list",
        "/etc/apt/trusted.gpg",
        "/etc/apt/keyrings/",
        "/usr/share/keyrings/",
        "/etc/yum.repos.d/",
        "/etc/zypp/repos.d/",
        "/etc/apk/repositories",
        // 动态链接与内核模块加载
        "/etc/ld.so.conf",
        "/etc/ld.so.preload",
        "/etc/modprobe.d/",
        "/etc/modules",
    ];
    const EXACT: &[&str] = &[
        "/etc/bash.bashrc",
        "/etc/environment",
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
        || n.contains("/.config/systemd/")
}

/// bash 的 `/dev/tcp`、`/dev/udp` 伪设备：重定向到它就是建立网络连接。
fn is_net_device(p: &str) -> bool {
    p.starts_with("/dev/tcp/") || p.starts_with("/dev/udp/")
}

/// 记录一次写入：敏感位置与磁盘设备直接升档，其余非追加写入留给调用方查存在性。
/// 路径按执行目录解析：`cd /etc && echo x > sudoers` 写的是 /etc/sudoers。
pub(super) fn note_write(target: &Word, append: bool, cwd: &str, v: &mut Verdict) {
    if target.dynamic {
        v.add(Tier::Danger, R_DYNAMIC_TARGET);
        return;
    }
    note_write_path(&target.text, append || target.glob, cwd, v);
}

pub(super) fn note_write_path(t: &str, append: bool, cwd: &str, v: &mut Verdict) {
    if t.is_empty() || t == "-" {
        return;
    }
    let p = resolve_path(cwd, t);
    if is_net_device(&p) {
        v.add(Tier::Egress, R_NETWORK);
    } else if is_block_device(&p) {
        v.add(Tier::Danger, R_DISK);
    } else if p.starts_with("/dev/") {
    } else if sensitive_write_location(&p) {
        v.add(Tier::Danger, R_SENSITIVE_WRITE);
    } else if !append {
        push_unique(&mut v.redirect_targets, p);
    }
}

pub(super) fn redirects(seg: &Segment, ctx: &GuardCtx, v: &mut Verdict) {
    let is_fd = |t: &str| t == "-" || (!t.is_empty() && t.chars().all(|c| c.is_ascii_digit()));
    let cwd = ctx.cwd;
    for r in &seg.redirects {
        match r.op {
            ">" | ">|" | "&>" => note_write(&r.target, false, cwd, v),
            ">>" | "&>>" | "<>" => note_write(&r.target, true, cwd, v),
            ">&" if !is_fd(&r.target.text) => note_write(&r.target, false, cwd, v),
            "<" if !r.target.dynamic && is_net_device(&r.target.text) => {
                v.add(Tier::Egress, R_NETWORK)
            }
            "<" if !r.target.dynamic && path_policy(&r.target.text) == PathPolicy::Deny => {
                v.add(Tier::Danger, R_SENSITIVE)
            }
            _ => {}
        }
    }
}

pub(super) fn writes(head: &str, w: &[Word], ctx: &GuardCtx, v: &mut Verdict) {
    let a = Args(w);
    let cwd = ctx.cwd;
    match head {
        "tee" => {
            let append = a.short('a') || a.has("--append");
            for x in a.positional() {
                note_write(x, append, cwd, v);
            }
        }
        "cp" | "mv" | "install" | "ln" => {
            if head == "ln" && !(a.short('f') || a.has("--force")) {
                return;
            }
            if head == "install" && (a.short('d') || a.has("--directory")) {
                return;
            }
            let Some(c) = copy_args(head, w) else {
                return;
            };
            if c.dest.dynamic {
                v.add(Tier::Danger, R_DYNAMIC_TARGET);
                return;
            }
            let dest = resolve_path(cwd, &c.dest.text);
            if c.into_dir {
                if sensitive_write_location(&dest) {
                    v.add(Tier::Danger, R_SENSITIVE_WRITE);
                }
            } else {
                note_write(&c.dest, false, cwd, v);
            }
            if c.no_dir {
                return;
            }
            let srcs = c
                .srcs
                .iter()
                .map(|s| {
                    if s.dynamic || s.proc_subst || (s.glob && !glob_safe(&s.text)) {
                        None
                    } else {
                        Some((resolve_path(cwd, &s.text), s.glob))
                    }
                })
                .collect();
            let d = CopyDest {
                dest,
                srcs,
                recursive: c.recursive,
            };
            if !v.copy_dests.contains(&d) {
                v.copy_dests.push(d);
            }
        }
        "sed" => {
            let inplace = a.texts().any(|t| {
                t == "--in-place"
                    || t.starts_with("--in-place=")
                    || (t.starts_with('-') && !t.starts_with("--") && t[1..].contains('i'))
            });
            if inplace {
                let files = sed_files(w);
                for x in &files {
                    if !x.dynamic && sensitive_write_location(&resolve_path(cwd, &x.text)) {
                        v.add(Tier::Danger, R_SENSITIVE_WRITE);
                    }
                }
                let fixed = !files.is_empty()
                    && files
                        .iter()
                        .all(|x| !x.dynamic && !x.glob && !x.proc_subst && !x.text.is_empty());
                if fixed {
                    let targets = files.iter().map(|x| grant::GrantTarget::File {
                        class: grant::G_MODIFY,
                        path: resolve_path(cwd, &x.text),
                    });
                    v.add_targets(Tier::Danger, R_INPLACE, targets);
                } else {
                    v.add(Tier::Danger, R_INPLACE);
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
                        note_write(t, false, cwd, v);
                    }
                }
            }
        }
        // gpg --dearmor -o /etc/apt/keyrings/x.gpg：写入信任密钥的常见形态。
        "gpg" | "gpg2" => {
            for (i, x) in w.iter().enumerate() {
                match x.text.as_str() {
                    "-o" | "--output" => {
                        if let Some(t) = w.get(i + 1) {
                            note_write(t, false, cwd, v);
                        }
                    }
                    t if t.starts_with("--output=") => {
                        note_write_path(&t["--output=".len()..], false, cwd, v)
                    }
                    _ => {}
                }
            }
        }
        _ => {}
    }
}

/// cp/mv/install/ln 的参数：目标、来源，`-t` 指定目标目录，`-T` 禁止当目录。
struct CopyArgs {
    dest: Word,
    srcs: Vec<Word>,
    into_dir: bool,
    no_dir: bool,
    recursive: bool,
}

fn copy_args(head: &str, w: &[Word]) -> Option<CopyArgs> {
    const VALUE_OPTS: &[&str] = &[
        "-S", "--suffix", "-m", "--mode", "-o", "--owner", "-g", "--group",
    ];
    let mut target: Option<Word> = None;
    let mut pos: Vec<Word> = Vec::new();
    let (mut opts, mut no_dir, mut recursive) = (true, false, false);
    let mut i = 0;
    while i < w.len() {
        let x = &w[i];
        let t = x.text.as_str();
        if opts && t == "--" {
            opts = false;
        } else if opts && t.starts_with('-') && t != "-" {
            if t == "-t" || t == "--target-directory" {
                target = w.get(i + 1).cloned();
                i += 1;
            } else if let Some(d) = t.strip_prefix("--target-directory=") {
                target = Some(Word {
                    text: d.to_string(),
                    ..x.clone()
                });
            } else if t == "-T" || t == "--no-target-directory" {
                no_dir = true;
            } else if VALUE_OPTS.contains(&t) {
                i += 1;
            } else if t == "--recursive" || t == "--archive" {
                recursive = true;
            } else if !t.starts_with("--") {
                // 短选项簇：`t` 之后的部分（或下一个词）是目标目录，如 `-rt /dest`。
                let cluster = &t[1..];
                let (flags, dir) = match cluster.find('t') {
                    Some(p) => (&cluster[..p], Some(&cluster[p + 1..])),
                    None => (cluster, None),
                };
                if flags.contains(['r', 'R', 'a']) {
                    recursive = true;
                }
                if flags.contains('T') {
                    no_dir = true;
                }
                match dir {
                    Some("") => {
                        target = w.get(i + 1).cloned();
                        i += 1;
                    }
                    Some(d) => {
                        target = Some(Word {
                            text: d.to_string(),
                            ..x.clone()
                        })
                    }
                    None => {}
                }
            }
        } else {
            pos.push(x.clone());
        }
        i += 1;
    }
    let recursive = recursive && head == "cp";
    match target {
        Some(dest) => (!pos.is_empty()).then_some(CopyArgs {
            dest,
            srcs: pos,
            into_dir: true,
            no_dir: false,
            recursive,
        }),
        None if pos.len() >= 2 => {
            let dest = pos.pop()?;
            Some(CopyArgs {
                dest,
                srcs: pos,
                into_dir: false,
                no_dir,
                recursive,
            })
        }
        None => None,
    }
}

/// 只含路径与通配字符的来源可以原样放进复核脚本，由远端 shell 展开。
fn glob_safe(t: &str) -> bool {
    let body = t.strip_prefix("~/").unwrap_or(t);
    !body.is_empty()
        && body.chars().all(|c| {
            c.is_ascii_alphanumeric()
                || matches!(
                    c,
                    '/' | '.'
                        | '_'
                        | '-'
                        | '+'
                        | '*'
                        | '?'
                        | '['
                        | ']'
                        | ','
                        | '@'
                        | '%'
                        | ':'
                        | '='
                )
        })
}

/// `sed -i` 实际改写的文件：脚本经 -e/-f 给出时全部位置参数都是文件，否则第一个是脚本。
/// `-i` 之后同一短选项簇里的字符是备份后缀（`-i.bak`、`-ie` 都是）。
fn sed_files(w: &[Word]) -> Vec<&Word> {
    let mut files = Vec::new();
    let (mut script, mut opts) = (false, true);
    let mut i = 0;
    while i < w.len() {
        let t = w[i].text.as_str();
        if opts && t == "--" {
            opts = false;
        } else if opts && t.starts_with("--") {
            match t {
                "--expression" | "--file" => {
                    script = true;
                    i += 1;
                }
                "--line-length" => i += 1,
                _ if t.starts_with("--expression=") || t.starts_with("--file=") => script = true,
                _ => {}
            }
        } else if opts && t.starts_with('-') && t != "-" {
            for (j, c) in t[1..].char_indices() {
                match c {
                    'i' => break,
                    'e' | 'f' | 'l' => {
                        script |= c != 'l';
                        if j + 1 == t.len() - 1 {
                            i += 1;
                        }
                        break;
                    }
                    _ => {}
                }
            }
        } else {
            files.push(&w[i]);
        }
        i += 1;
    }
    if !script && !files.is_empty() {
        files.remove(0);
    }
    files
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
    listeners(head, w, v);
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

/// 外部主机名（小写）；本机地址与认不出主机的参数返回 None。
pub(super) fn external_host(t: &str) -> Option<String> {
    host_of(t)
        .filter(|h| !is_local_host(h))
        .map(|h| h.to_ascii_lowercase())
}

/// git 仓库地址的外部主机：只认带协议的 URL 与 scp 形式（`user@host:path`），
/// 避免把带点的分支、标签名（v1.2.3）误当成主机。
pub(super) fn git_remote_host(t: &str) -> Option<String> {
    if t.contains("://") {
        return external_host(t);
    }
    let (before, _) = t.split_once(':')?;
    if before.contains('/') {
        return None;
    }
    let host = before.rsplit('@').next()?;
    if host.contains('.') {
        external_host(host)
    } else {
        None
    }
}

/// 位置参数（跳过带值选项的值）。短选项簇里第一个带值字母若在末尾就吞下一个词
/// （curl 的 `-sSLo FILE`），否则其后即内联值；`--` 之后全部算位置参数。
pub(super) fn positional_with<'a>(
    w: &'a [Word],
    long_value: &[&str],
    short_value: &str,
) -> Vec<&'a Word> {
    let mut out = Vec::new();
    let mut opts = true;
    let mut i = 0;
    while let Some(x) = w.get(i) {
        let t = x.text.as_str();
        i += 1;
        if !opts || !t.starts_with('-') || t == "-" {
            out.push(x);
            continue;
        }
        if t == "--" {
            opts = false;
            continue;
        }
        if t.starts_with("--") {
            if long_value.contains(&t) {
                i += 1;
            }
            continue;
        }
        let chars = &t[1..];
        if let Some(p) = chars.find(|c| short_value.contains(c)) {
            if p + 1 == chars.len() {
                i += 1;
            }
        }
    }
    out
}

/// 短选项（含簇）或长选项的值：`-o F`、`-sSLo F`、`-oF`、`--output F`、`--output=F`。
fn option_values(w: &[Word], short: char, short_value: &str, long: &[&str]) -> Vec<Word> {
    let mut out = Vec::new();
    let mut i = 0;
    while let Some(x) = w.get(i) {
        let t = x.text.as_str();
        i += 1;
        if t == "--" {
            break;
        }
        if long.contains(&t) {
            out.extend(w.get(i).cloned());
            i += 1;
            continue;
        }
        if let Some(val) = long
            .iter()
            .find_map(|n| t.strip_prefix(n).and_then(|r| r.strip_prefix('=')))
        {
            out.push(Word {
                text: val.to_string(),
                ..x.clone()
            });
            continue;
        }
        if t.len() > 1 && t.starts_with('-') && !t.starts_with("--") {
            let chars = &t[1..];
            if let Some(p) = chars.find(|c| short_value.contains(c)) {
                let inline = &chars[p + 1..];
                let letter = chars[p..].chars().next();
                if letter == Some(short) {
                    if inline.is_empty() {
                        out.extend(w.get(i).cloned());
                    } else {
                        out.push(Word {
                            text: inline.to_string(),
                            ..x.clone()
                        });
                    }
                }
                if inline.is_empty() {
                    i += 1;
                }
            }
        }
    }
    out
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
    "-D",
    "--output",
    "--output-dir",
    "--user",
    "--request",
    "--header",
    "--user-agent",
    "--referer",
    "--max-time",
    "--connect-timeout",
    "--write-out",
    "--proxy",
    "--preproxy",
    "--proxy-user",
    "--socks4",
    "--socks4a",
    "--socks5",
    "--socks5-hostname",
    "--config",
    "--cookie",
    "--cookie-jar",
    "--cert",
    "--key",
    "--cacert",
    "--capath",
    "--resolve",
    "--connect-to",
    "--retry",
    "--retry-delay",
    "--limit-rate",
    "--max-filesize",
    "--range",
    "--interface",
    "--dump-header",
    "--netrc-file",
    "--trace",
    "--trace-ascii",
    "--stderr",
];
/// curl 带值的短选项字母（用于识别 `-sSLo FILE` 这类选项簇）。
const CURL_SHORT_VALUE: &str = "ouXHAemwxKcbErYyzCUDdFTQt";
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
    "-i",
    "-B",
    "-l",
    "-Q",
    "-D",
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
    "--input-file",
    "--base",
    "--execute",
    "--level",
    "--domains",
    "--referer",
    "--load-cookies",
    "--save-cookies",
];
const WGET_SHORT_VALUE: &str = "OoaPUtTweiBlQD";
const NC_VALUE_OPTS: &[&str] = &["-w", "-p", "-s", "-i", "-q", "-x", "-X", "-I", "-O", "-T"];

/// 下载类命令不可会话授权的原因（确认卡上会说明）。
pub(super) const B_DYNAMIC: &str = "命令含动态片段，目标无法静态确定";
pub(super) const B_REDIRECT: &str = "重定向参数可能把请求转到其他站点";
pub(super) const B_CREDENTIAL: &str = "跟随重定向时会携带凭据";
pub(super) const B_PROXY: &str = "改写域名解析或经代理访问";
pub(super) const B_CONFIG: &str = "从配置文件读取参数";
pub(super) const B_NAME_UNKNOWN: &str = "下载产物路径无法确定";
pub(super) const B_BATCH: &str = "批量、递归或一次多请求下载";
pub(super) const B_EXEC_DIR: &str = "下载到可执行目录";
pub(super) const B_PIPE: &str = "下载内容经管道交给其他程序";

/// 下载内容经管道交给它们仍算纯下载（只读过滤）；其余程序可能执行或落地内容。
const SAFE_PIPE: &[&str] = &[
    "jq",
    "yq",
    "grep",
    "egrep",
    "fgrep",
    "rg",
    "head",
    "tail",
    "wc",
    "sort",
    "uniq",
    "cut",
    "tr",
    "column",
    "less",
    "more",
    "cat",
    "sha256sum",
    "sha1sum",
    "sha512sum",
    "md5sum",
    "xmllint",
];

/// URL 路径的最后一段（curl -O / wget 默认文件名）；没有文件名时返回 None。
fn url_basename(u: &str) -> Option<String> {
    let after = u.split_once("://").map_or(u, |(_, r)| r);
    let path = after.split(['?', '#']).next().unwrap_or("");
    let (_, path) = path.split_once('/')?;
    let name = path.rsplit('/').next().unwrap_or("");
    (!name.is_empty()).then(|| name.to_string())
}

/// 落在 PATH 目录里的产物下次可能被直接当命令执行，不允许自动下载到那里。
pub(super) fn in_exec_dir(p: &str) -> bool {
    const DIRS: &[&str] = &[
        "/usr/local/bin/",
        "/usr/local/sbin/",
        "/usr/bin/",
        "/usr/sbin/",
        "/bin/",
        "/sbin/",
        "/opt/bin/",
        "~/bin/",
        "~/.local/bin/",
    ];
    DIRS.iter().any(|d| p.starts_with(d)) || p.contains("/.local/bin/") || {
        let mut parts = p.trim_start_matches('/').split('/');
        // /home/<user>/bin/x、/root/bin/x
        matches!(
            (parts.next(), parts.next(), parts.next()),
            (Some("home"), Some(_), Some("bin")) | (Some("root"), Some("bin"), Some(_))
        )
    }
}

/// 重定向参数里藏着另一个站点（开放重定向可把请求转给攻击者）。
fn query_points_elsewhere(u: &str) -> bool {
    let query = u
        .split_once('?')
        .map_or("", |(_, q)| q)
        .to_ascii_lowercase();
    query.contains("://") || query.contains("%3a%2f%2f") || query.contains("%2f%2f")
}

/// curl/wget 纯下载：登记产物路径与不可授权原因。主机已由调用方登记。
fn download_details(head: &str, w: &[Word], urls: &[&Word], ctx: &GuardCtx, v: &mut Verdict) {
    let a = Args(w);
    let cluster_has = |c: char, value_letters: &str| {
        a.texts().any(|t| {
            t.starts_with('-')
                && !t.starts_with("--")
                && !t.starts_with("-n")
                && t[1..]
                    .chars()
                    .take_while(|ch| !value_letters.contains(*ch) || *ch == c)
                    .any(|ch| ch == c)
        })
    };
    let mut outputs: Vec<Word> = Vec::new();
    // 两者都会跟随重定向（wget 默认跟随）：重定向本身由已授权站点担保，
    // 但查询参数里再带一个站点就可能是开放重定向，不能自动放行。
    let follows = head == "wget" || cluster_has('L', CURL_SHORT_VALUE) || a.has("--location");
    if follows && urls.iter().any(|u| query_points_elsewhere(&u.text)) {
        v.block_allow(B_REDIRECT);
    }
    if head == "curl" {
        if a.has("--location-trusted") {
            v.block_allow(B_CREDENTIAL);
        }
        if cluster_has('x', CURL_SHORT_VALUE)
            || a.texts().any(|t| {
                [
                    "--proxy",
                    "--preproxy",
                    "--socks4",
                    "--socks4a",
                    "--socks5",
                    "--socks5-hostname",
                    "--resolve",
                    "--connect-to",
                    "--doh-url",
                ]
                .iter()
                .any(|n| t == *n || t.starts_with(&format!("{n}=")))
            })
        {
            v.block_allow(B_PROXY);
        }
        if cluster_has('K', CURL_SHORT_VALUE) || a.has("--config") {
            v.block_allow(B_CONFIG);
        }
        if cluster_has('J', CURL_SHORT_VALUE) || a.has("--remote-header-name") {
            v.block_allow(B_NAME_UNKNOWN);
        }
        if a.has_any(&["--next", "-:", "--parallel", "-Z"]) {
            v.block_allow(B_BATCH);
        }
        outputs.extend(
            option_values(w, 'o', CURL_SHORT_VALUE, &["--output"])
                .into_iter()
                .filter(|o| o.text != "-"),
        );
        if cluster_has('O', CURL_SHORT_VALUE) || a.has_any(&["--remote-name", "--remote-name-all"])
        {
            for u in urls {
                match url_basename(&u.text) {
                    Some(n) => outputs.push(Word {
                        text: n,
                        ..(*u).clone()
                    }),
                    None => v.block_allow(B_NAME_UNKNOWN),
                }
            }
        }
        if let Some(dir) = option_values(w, '\0', "", &["--output-dir"]).first() {
            for o in &mut outputs {
                if !o.text.starts_with('/') {
                    o.text = format!("{}/{}", dir.text.trim_end_matches('/'), o.text);
                }
            }
        }
    } else {
        let batch_flags = [
            "-i",
            "--input-file",
            "-e",
            "--execute",
            "-r",
            "--recursive",
            "-m",
            "--mirror",
            "-p",
            "--page-requisites",
            "-H",
            "--span-hosts",
            "-B",
            "--base",
        ];
        if a.texts().any(|t| {
            batch_flags
                .iter()
                .any(|f| t == *f || t.starts_with(&format!("{f}=")))
        }) || ['r', 'm', 'p', 'i', 'e']
            .iter()
            .any(|c| cluster_has(*c, WGET_SHORT_VALUE))
        {
            v.block_allow(B_BATCH);
        }
        if a.has_any(&[
            "--content-disposition",
            "--trust-server-names",
            "-x",
            "--force-directories",
        ]) {
            v.block_allow(B_NAME_UNKNOWN);
        }
        let named = option_values(w, 'O', WGET_SHORT_VALUE, &["--output-document"]);
        if named.is_empty() {
            let prefix = option_values(w, 'P', WGET_SHORT_VALUE, &["--directory-prefix"]);
            for u in urls {
                let name = url_basename(&u.text).unwrap_or_else(|| "index.html".to_string());
                let text = match prefix.first() {
                    Some(d) => format!("{}/{name}", d.text.trim_end_matches('/')),
                    None => name,
                };
                outputs.push(Word {
                    text,
                    ..(*u).clone()
                });
            }
        } else {
            outputs.extend(named.into_iter().filter(|o| o.text != "-"));
        }
    }
    for o in outputs {
        if o.dynamic {
            v.block_allow(B_NAME_UNKNOWN);
            continue;
        }
        let p = resolve_path(ctx.cwd, &o.text);
        if in_exec_dir(&p) {
            v.block_allow(B_EXEC_DIR);
        }
        push_unique(&mut v.downloads, p);
    }
}

/// 下载命令的 stdout：重定向到文件即产物；经管道交给非只读程序则不可授权，
/// 只读过滤器后面的重定向产物同样记为下载。
pub(super) fn download_pipes(lx: &Lexed, idx: usize, head: &str, ctx: &GuardCtx, v: &mut Verdict) {
    if !matches!(head, "curl" | "wget") {
        return;
    }
    let record = |seg: &Segment, v: &mut Verdict| {
        for r in &seg.redirects {
            let target = &r.target;
            if matches!(r.op, ">" | ">>" | ">|" | "&>" | "&>>")
                && !target.dynamic
                && !target.text.starts_with("/dev/")
            {
                push_unique(&mut v.downloads, resolve_path(ctx.cwd, &target.text));
            }
        }
    };
    record(&lx.segments[idx], v);
    let mut j = idx + 1;
    while let Some(next) = lx.segments.get(j) {
        if next.sep_before != Sep::Pipe {
            break;
        }
        let consumer = segment_head(next).unwrap_or_default();
        if !SAFE_PIPE.contains(&consumer.as_str()) {
            v.block_allow(B_PIPE);
            break;
        }
        record(next, v);
        j += 1;
    }
}

/// 从非默认源安装软件包（安装过程会执行包里的代码），以及发布/上传软件包。
fn packages(head: &str, w: &[Word], v: &mut Verdict) {
    let vcs = |t: &str| {
        t.contains("://")
            || [
                "git+",
                "hg+",
                "svn+",
                "bzr+",
                "git@",
                "github:",
                "gitlab:",
                "bitbucket:",
                "gist:",
            ]
            .iter()
            .any(|p| t.starts_with(p))
    };
    // npm 的 user/repo 简写即 GitHub 仓库；@scope/pkg 与本地路径不算。
    let gh_shorthand = |t: &str| {
        !t.starts_with(['@', '.', '/', '~'])
            && !t.contains('@')
            && t.split('#').next().unwrap_or("").matches('/').count() == 1
    };
    let pip = |w: &[Word]| {
        let a = Args(w);
        let pos = a.pos_text();
        if !matches!(pos.first(), Some(&("install" | "download" | "wheel"))) {
            return false;
        }
        a.texts().any(|t| {
            [
                "-i",
                "--index-url",
                "--extra-index-url",
                "-f",
                "--find-links",
                "--trusted-host",
            ]
            .iter()
            .any(|f| t == *f || t.starts_with(&format!("{f}=")))
        }) || pos.iter().skip(1).any(|t| vcs(t))
    };
    let a = Args(w);
    let pos = a.pos_text();
    let sub = pos.first().copied().unwrap_or("");
    let from_source = match head {
        h if h == "pip" || h == "pip2" || h.starts_with("pip3") => pip(w),
        h if h.starts_with("python") => match (w.first(), w.get(1)) {
            (Some(m), Some(p)) if m.text == "-m" && p.text == "pip" => pip(&w[2..]),
            _ => false,
        },
        "npm" | "yarn" | "pnpm" | "bun" => {
            matches!(sub, "install" | "i" | "add")
                && pos.iter().skip(1).any(|t| vcs(t) || gh_shorthand(t))
        }
        "npx" | "pnpx" | "bunx" => pos.first().is_some_and(|t| vcs(t) || gh_shorthand(t)),
        "gem" => {
            sub == "install"
                && (a.has_any(&["--source", "-s"]) || pos.iter().skip(1).any(|t| vcs(t)))
        }
        "cargo" => {
            sub == "install"
                && a.texts()
                    .any(|t| t == "--git" || t.starts_with("--git=") || t.starts_with("--index"))
        }
        _ => false,
    };
    if from_source {
        v.add(Tier::Egress, R_PKG_SOURCE);
    }
    let publish = match head {
        "npm" | "yarn" | "pnpm" | "bun" => sub == "publish",
        "twine" => sub == "upload",
        "gem" => sub == "push",
        "cargo" | "poetry" => sub == "publish",
        _ => false,
    };
    if publish {
        v.add(Tier::Egress, R_UPLOAD);
    }
}

/// 开放网络服务、把目录或文件暴露出去的一次性服务器。
fn listeners(head: &str, w: &[Word], v: &mut Verdict) {
    let module = w
        .iter()
        .position(|x| x.text == "-m")
        .and_then(|p| w.get(p + 1))
        .map(|x| x.text.as_str());
    let serves = match head {
        h if h.starts_with("python") || h.starts_with("pypy") => matches!(
            module,
            Some(
                "http.server"
                    | "SimpleHTTPServer"
                    | "uploadserver"
                    | "pyftpdlib"
                    | "smtpd"
                    | "aiosmtpd"
            )
        ),
        h if h.starts_with("php") => w.iter().any(|x| x.text.starts_with("-S")),
        "httpd" => w.iter().any(|x| x.text == "-h"),
        "npx" | "pnpx" | "bunx" => w
            .iter()
            .find(|x| !x.text.starts_with('-'))
            .is_some_and(|x| {
                matches!(
                    x.text.as_str(),
                    "http-server" | "serve" | "live-server" | "local-web-server"
                )
            }),
        _ => false,
    };
    if serves {
        v.add(Tier::Egress, R_LISTEN);
    }
}

/// 对象存储/云平台 CLI 里会把本地数据送出去的子命令。
const CLOUD_TRANSFER: &[&str] = &[
    "cp", "put", "upload", "sync", "mv", "copy", "copyto", "move", "moveto", "rsync", "push",
    "mirror", "scp",
];

pub(super) fn network(head: &str, w: &[Word], ctx: &GuardCtx, v: &mut Verdict) {
    let a = Args(w);
    packages(head, w, v);
    match head {
        "curl" | "wget" => {
            let upload = if head == "curl" {
                a.texts().any(|t| {
                    matches!(
                        t,
                        "-d" | "-F" | "-T" | "--json" | "--form" | "--upload-file"
                    ) || t.starts_with("--data")
                        || t.starts_with("--form")
                        || (t.len() > 2 && ["-d", "-F", "-T"].iter().any(|p| t.starts_with(p)))
                })
            } else {
                a.texts().any(|t| {
                    t.starts_with("--post-")
                        || t.starts_with("--body-")
                        || t.starts_with("--method")
                })
            };
            if upload {
                v.add(Tier::Egress, R_UPLOAD);
                return;
            }
            if head == "curl" && a.has("--unix-socket") {
                return;
            }
            let (long, short) = if head == "curl" {
                (CURL_VALUE_OPTS, CURL_SHORT_VALUE)
            } else {
                (WGET_VALUE_OPTS, WGET_SHORT_VALUE)
            };
            let pos = positional_with(w, long, short);
            let mut urls = Vec::new();
            let mut hosts = Vec::new();
            let mut found = false;
            let mut dynamic = false;
            for x in &pos {
                if x.dynamic {
                    dynamic = true;
                } else if let Some(h) = host_of(&x.text) {
                    found = true;
                    if !is_local_host(&h) {
                        hosts.push(h.to_ascii_lowercase());
                        urls.push(*x);
                    }
                }
            }
            // 目标全在本机才不算外联；认不出目标同样按外部处理（fail-closed）。
            if found && !dynamic && hosts.is_empty() {
                return;
            }
            v.add(Tier::Egress, R_DOWNLOAD);
            for h in hosts {
                push_unique(&mut v.net_hosts, h);
            }
            if dynamic || w.iter().any(|x| x.dynamic) {
                v.block_allow(B_DYNAMIC);
            }
            download_details(head, w, &urls, ctx, v);
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
        // 对象存储与云平台 CLI：传输类子命令按上传处理，其余是在操作云上资源。
        "aws" | "gsutil" | "coscli" | "coscmd" | "ossutil" | "ossutil64" | "obsutil" | "s3cmd"
        | "mc" | "rclone" | "azcopy" | "tccli" | "aliyun" | "az" | "gcloud" | "qshell" | "bypy"
        | "doctl" | "hcloud" => {
            let pos = a.pos_text();
            let transfer = pos.iter().take(3).any(|t| CLOUD_TRANSFER.contains(t))
                || matches!(
                    (pos.first(), pos.get(1)),
                    (Some(&"s3api"), Some(&("put-object" | "upload-part")))
                );
            v.add(Tier::Egress, if transfer { R_UPLOAD } else { R_REMOTE });
        }
        "sendmail" | "mail" | "mailx" | "mutt" | "msmtp" | "ssmtp" | "swaks" | "s-nail" => {
            v.add(Tier::Egress, R_UPLOAD)
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
