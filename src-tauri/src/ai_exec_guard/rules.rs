//! 逐段分级：剥前缀 → 定位真实命令 → 按命令名分派规则。
//!
//! 破坏不可逆类规则在本文件；写入、解释器、断连与外联规则在 rules_net。

use super::lexer::{Lexed, Segment, Sep, Word};
use super::paths::{path_policy, PathPolicy};
use super::rules_net;
use super::*;

pub(super) fn classify_segment(
    lx: &Lexed,
    idx: usize,
    ctx: &GuardCtx,
    depth: usize,
    v: &mut Verdict,
) {
    let seg = &lx.segments[idx];
    rules_net::redirects(seg, v);
    for w in &seg.words {
        check_sensitive_word(w, v);
    }
    classify_words(lx, idx, &seg.words, ctx, depth, v);
}

/// 任何位置引用密钥/凭据文件都要确认（读取、拷贝、上传、改权限都算）。
fn check_sensitive_word(w: &Word, v: &mut Verdict) {
    if w.dynamic {
        return;
    }
    let mut t = w.text.as_str();
    if let Some((k, val)) = t.split_once('=') {
        if k.starts_with('-') || k == "if" || k == "of" {
            t = val;
        }
    }
    let t = t.strip_prefix('@').unwrap_or(t);
    if !t.is_empty() && !t.starts_with('-') && path_policy(t) == PathPolicy::Deny {
        v.add(Tier::Danger, R_SENSITIVE);
    }
}

pub(super) fn basename(p: &str) -> &str {
    p.rsplit('/').next().unwrap_or(p)
}

fn is_assignment(t: &str) -> bool {
    let Some((name, _)) = t.split_once('=') else {
        return false;
    };
    let name = name.strip_suffix('+').unwrap_or(name);
    let mut cs = name.chars();
    cs.next()
        .is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
        && cs.all(|c| c.is_ascii_alphanumeric() || c == '_')
}

/// 跳过选项，返回第一个非选项词下标；`with_value` 中的选项再吞一个参数。
pub(super) fn skip_opts(w: &[Word], mut k: usize, with_value: &[&str]) -> usize {
    while let Some(x) = w.get(k) {
        let t = x.text.as_str();
        if t == "--" {
            return k + 1;
        }
        if !t.starts_with('-') || t == "-" {
            break;
        }
        k += if with_value.contains(&t) { 2 } else { 1 };
    }
    k.min(w.len())
}

/// 取某个带值选项的值（`-c CMD`）。
fn option_value<'a>(w: &'a [Word], names: &[&str]) -> Option<&'a Word> {
    w.iter()
        .position(|x| names.contains(&x.text.as_str()))
        .and_then(|i| w.get(i + 1))
}

fn join_words(w: &[Word]) -> String {
    w.iter()
        .map(|x| x.text.as_str())
        .collect::<Vec<_>>()
        .join(" ")
}

const SUDO_VALUE_OPTS: &[&str] = &[
    "-u",
    "-g",
    "-C",
    "-D",
    "-h",
    "-p",
    "-r",
    "-t",
    "-U",
    "-T",
    "--user",
    "--group",
    "--chdir",
    "--prompt",
    "--role",
    "--type",
    "--other-user",
    "--host",
];

/// 若 `w[k]` 是不改变语义的前缀（赋值、sudo、env、nohup…），返回其后的下标；
/// `root` 记录是否以 root 身份执行。
fn simple_prefix(w: &[Word], k: usize, root: &mut bool) -> Option<usize> {
    let x = w.get(k)?;
    if x.dynamic {
        return None;
    }
    let t = x.text.as_str();
    if !x.quoted && is_assignment(t) {
        return Some(k + 1);
    }
    let next = match basename(t) {
        "sudo" | "doas" => {
            let n = skip_opts(w, k + 1, SUDO_VALUE_OPTS);
            let user = option_value(&w[k + 1..n], &["-u", "--user"]).map(|u| u.text.as_str());
            if user.is_none_or(|u| matches!(u, "root" | "0" | "#0")) {
                *root = true;
            }
            n
        }
        "env" => {
            let split = w[k + 1..]
                .iter()
                .take_while(|o| o.text.starts_with('-'))
                .any(|o| o.text.starts_with("-S") || o.text.starts_with("--split-string"));
            if split {
                return None;
            }
            skip_opts(w, k + 1, &["-u", "--unset", "-C", "--chdir"])
        }
        "nohup" | "setsid" | "builtin" | "busybox" | "unbuffer" => skip_opts(w, k + 1, &[]),
        "exec" => skip_opts(w, k + 1, &["-a"]),
        "nice" => skip_opts(w, k + 1, &["-n", "--adjustment"]),
        "ionice" => skip_opts(w, k + 1, &["-c", "-n", "-p", "-P", "-u", "--class"]),
        "stdbuf" => skip_opts(w, k + 1, &["-i", "-o", "-e"]),
        "time" => skip_opts(w, k + 1, &["-f", "-o", "--format", "--output"]),
        // 选项之后还有一个时长 / 新根目录参数。
        "timeout" => skip_opts(w, k + 1, &["-s", "-k", "--signal", "--kill-after"]) + 1,
        "chroot" => skip_opts(w, k + 1, &["--userspec", "--groups"]) + 1,
        "command" => {
            if w.get(k + 1)
                .is_some_and(|o| o.text == "-v" || o.text == "-V")
            {
                return Some(w.len());
            }
            skip_opts(w, k + 1, &[])
        }
        _ => return None,
    };
    Some(next.min(w.len()))
}

/// 段的真实命令名（剥掉前缀后的 basename），供管道上下游判断。
pub(super) fn segment_head(seg: &Segment) -> Option<String> {
    let mut k = 0;
    let mut root = false;
    while let Some(n) = simple_prefix(&seg.words, k, &mut root) {
        k = n;
    }
    seg.words.get(k).map(|w| basename(&w.text).to_string())
}

pub(super) fn classify_words(
    lx: &Lexed,
    idx: usize,
    words: &[Word],
    ctx: &GuardCtx,
    depth: usize,
    v: &mut Verdict,
) {
    let mut k = 0;
    let mut root = false;
    while let Some(n) = simple_prefix(words, k, &mut root) {
        k = n;
    }
    if root {
        v.as_root = true;
    }
    let Some(w) = words.get(k) else {
        return;
    };
    if w.dynamic {
        // 命令名运行期才确定（$x、$(...)、ANSI-C 引号）：看不透即确认。
        v.add(Tier::Danger, R_OBFUSCATED);
        return;
    }
    let head = basename(&w.text);
    let rest = &words[k + 1..];
    match head {
        "env" => {
            // 只剩 -S/--split-string：其参数本身就是命令行。
            match option_value(rest, &["-S", "--split-string"]) {
                Some(s) if !s.dynamic => {
                    let n = skip_opts(rest, 0, &["-S", "--split-string", "-u", "-C"]);
                    let tail = join_words(&rest[n..]);
                    classify_nested(&format!("{} {tail}", s.text), ctx, depth, v);
                }
                _ => v.add(Tier::Danger, R_OBFUSCATED),
            }
        }
        "xargs" => {
            const XARGS_VALUE_OPTS: &[&str] = &[
                "-n",
                "-L",
                "-s",
                "-P",
                "-d",
                "-E",
                "-I",
                "-a",
                "--max-args",
                "--max-lines",
                "--max-procs",
                "--delimiter",
                "--arg-file",
                "--replace",
                "--eof",
            ];
            let n = skip_opts(rest, 0, XARGS_VALUE_OPTS);
            if n < rest.len() {
                classify_words(lx, idx, &rest[n..], ctx, depth + 1, v);
            }
        }
        "watch" => {
            let n = skip_opts(rest, 0, &["-n", "--interval"]);
            let cmd = &rest[n..];
            if cmd.iter().any(|x| x.dynamic) {
                v.add(Tier::Danger, R_OBFUSCATED);
            } else if !cmd.is_empty() {
                classify_nested(&join_words(cmd), ctx, depth, v);
            }
        }
        "su" | "runuser" | "flock" | "sg" => {
            if head == "su"
                && rest
                    .iter()
                    .all(|x| x.text.starts_with('-') || x.text == "root")
            {
                v.as_root = true;
            }
            if let Some(c) = option_value(rest, &["-c", "--command"]) {
                if c.dynamic {
                    v.add(Tier::Danger, R_OBFUSCATED);
                } else {
                    classify_nested(&c.text, ctx, depth, v);
                }
            } else if head == "runuser" {
                let n = skip_opts(rest, 0, &["-u", "-g", "-G", "--user", "--group"]);
                classify_words(lx, idx, &rest[n..], ctx, depth + 1, v);
            } else if head == "flock" {
                // flock [选项] 锁文件 命令...
                let n = skip_opts(rest, 0, &["-w", "--timeout", "-E", "--conflict-exit-code"]);
                if n + 1 < rest.len() {
                    classify_words(lx, idx, &rest[n + 1..], ctx, depth + 1, v);
                }
            }
        }
        "systemd-run" => {
            const VALUE_OPTS: &[&str] = &[
                "-u",
                "--unit",
                "-p",
                "--property",
                "-E",
                "--setenv",
                "-M",
                "--machine",
                "--description",
                "--slice",
                "-H",
                "--host",
                "--uid",
                "--gid",
                "--nice",
                "--working-directory",
                "--on-calendar",
                "--on-active",
            ];
            let n = skip_opts(rest, 0, VALUE_OPTS);
            classify_words(lx, idx, &rest[n..], ctx, depth + 1, v);
        }
        _ => dispatch(lx, idx, &w.text, head, rest, ctx, depth, v),
    }
}

#[allow(clippy::too_many_arguments)]
fn dispatch(
    lx: &Lexed,
    idx: usize,
    head_path: &str,
    head: &str,
    args: &[Word],
    ctx: &GuardCtx,
    depth: usize,
    v: &mut Verdict,
) {
    if rules_net::is_tmp_path(head_path) {
        v.add(Tier::Egress, R_TMP_EXEC);
    }
    destructive(head, args, v);
    match head {
        "find" => find(lx, idx, args, ctx, depth, v),
        "git" => git(args, v),
        "docker" | "podman" | "nerdctl" | "docker-compose" | "podman-compose" => {
            containers(head, args, v)
        }
        "mysql" | "mariadb" | "psql" | "sqlite3" | "clickhouse-client" | "mongo" | "mongosh"
        | "redis-cli" | "cqlsh" => database(lx, idx, args, v),
        _ => {}
    }
    rules_net::writes(head, args, v);
    rules_net::interpreters(lx, idx, head, args, ctx, depth, v);
    rules_net::disconnect(lx, idx, head, args, v);
    rules_net::network(head, args, v);
}

/// 参数视图：短选项簇判断、位置参数提取。
pub(super) struct Args<'a>(pub &'a [Word]);

impl<'a> Args<'a> {
    pub fn texts(&self) -> impl Iterator<Item = &'a str> {
        self.0.iter().map(|w| w.text.as_str())
    }
    pub fn has(&self, f: &str) -> bool {
        self.texts().any(|t| t == f)
    }
    pub fn has_any(&self, fs: &[&str]) -> bool {
        self.texts().any(|t| fs.contains(&t))
    }
    /// 短选项簇里含某字母（`-rf` 同时含 r 与 f）；遇 `--` 停止。
    pub fn short(&self, c: char) -> bool {
        for t in self.texts() {
            if t == "--" {
                break;
            }
            if t.len() > 1 && t.starts_with('-') && !t.starts_with("--") && t[1..].contains(c) {
                return true;
            }
        }
        false
    }
    /// 非选项参数（`--` 之后全部算）。
    pub fn positional(&self) -> Vec<&'a Word> {
        let mut out = Vec::new();
        let mut opts = true;
        for w in self.0 {
            let t = w.text.as_str();
            if opts && t == "--" {
                opts = false;
                continue;
            }
            if opts && t.starts_with('-') && t != "-" {
                continue;
            }
            out.push(w);
        }
        out
    }
    pub fn pos_text(&self) -> Vec<&'a str> {
        self.positional()
            .into_iter()
            .map(|w| w.text.as_str())
            .collect()
    }
}

fn destructive(head: &str, w: &[Word], v: &mut Verdict) {
    let a = Args(w);
    let danger = |v: &mut Verdict, r: &str| v.add(Tier::Danger, r);
    match head {
        "rm" | "rmdir" | "unlink" | "shred" | "srm" | "wipe" => {
            let recursive = head == "rm" && (a.short('r') || a.short('R') || a.has("--recursive"));
            danger(
                v,
                if recursive {
                    R_RECURSIVE_DELETE
                } else {
                    R_DELETE
                },
            );
            for t in a.pos_text() {
                push_unique(&mut v.delete_targets, t.to_string());
            }
        }
        "mkswap" | "wipefs" | "fdisk" | "sfdisk" | "cfdisk" | "gdisk" | "sgdisk" | "parted"
        | "blkdiscard" | "mke2fs" | "mkdosfs" => danger(v, R_DISK),
        h if h == "mkfs" || h.starts_with("mkfs.") => danger(v, R_DISK),
        "dd" => {
            for t in a.texts() {
                if let Some(of) = t.strip_prefix("of=") {
                    rules_net::note_write_path(of, false, v);
                }
            }
        }
        "diskutil" => {
            if a.pos_text().first().is_some_and(|s| {
                s.starts_with("erase")
                    || s.starts_with("zero")
                    || s.starts_with("secureErase")
                    || matches!(*s, "partitionDisk" | "reformat")
            }) {
                danger(v, R_DISK);
            }
        }
        "shutdown" | "reboot" | "halt" | "poweroff" => danger(v, R_POWER),
        "init" | "telinit" if matches!(a.pos_text().first(), Some(&"0" | &"6")) => {
            danger(v, R_POWER)
        }
        "systemctl" => {
            const POWER: &[&str] = &[
                "poweroff",
                "reboot",
                "halt",
                "kexec",
                "suspend",
                "hibernate",
                "hybrid-sleep",
                "rescue",
                "emergency",
                "soft-reboot",
            ];
            if a.pos_text().first().is_some_and(|s| POWER.contains(s)) {
                danger(v, R_POWER);
            }
        }
        "userdel" | "groupdel" | "deluser" | "delgroup" | "chpasswd" | "chgpasswd" => {
            danger(v, R_ACCOUNT)
        }
        "passwd" if !a.has_any(&["-S", "--status"]) => danger(v, R_ACCOUNT),
        "usermod"
            if a.short('L')
                || a.short('p')
                || a.short('e')
                || a.has_any(&["--lock", "--password", "--expiredate"]) =>
        {
            danger(v, R_ACCOUNT)
        }
        "chmod" | "chown" | "chgrp" => {
            if a.short('R') || a.has("--recursive") {
                danger(v, R_PERM_RECURSIVE);
            } else if head == "chmod" && a.has_any(&["000", "0000", "a-rwx", "ugo-rwx", "a="]) {
                danger(v, R_PERM);
            }
        }
        "chattr" if a.texts().any(|t| t.starts_with('+') && t.contains('i')) => danger(v, R_PERM),
        "kill" if !(w.is_empty() || a.has_any(&["-0", "-l", "-L", "--list"])) => danger(v, R_KILL),
        "killall" | "pkill" | "killall5" | "skill" | "slay" => danger(v, R_KILL),
        "apt" | "apt-get" | "aptitude"
            if a.has_any(&["remove", "purge", "autoremove", "autopurge"]) =>
        {
            danger(v, R_UNINSTALL)
        }
        "yum" | "dnf" | "microdnf" | "tdnf" if a.has_any(&["remove", "erase", "autoremove"]) => {
            danger(v, R_UNINSTALL)
        }
        "zypper" if a.has_any(&["remove", "rm"]) => danger(v, R_UNINSTALL),
        "pacman" if a.texts().any(|t| t.starts_with("-R") || t == "--remove") => {
            danger(v, R_UNINSTALL)
        }
        "apk" if a.has("del") => danger(v, R_UNINSTALL),
        "snap" | "flatpak" if a.has_any(&["remove", "uninstall"]) => danger(v, R_UNINSTALL),
        "dpkg" if a.has_any(&["-r", "-P", "--remove", "--purge"]) => danger(v, R_UNINSTALL),
        "rpm" if a.has_any(&["-e", "--erase"]) => danger(v, R_UNINSTALL),
        h if (h == "pip" || h == "pip2" || h.starts_with("pip3")) && a.has("uninstall") => {
            danger(v, R_UNINSTALL)
        }
        "crontab" => {
            // -r 删除整表；给文件或 `-` 则整表替换。-u 的值是用户名，不是文件。
            let mut i = 0;
            while i < w.len() {
                let t = w[i].text.as_str();
                if t == "-u" {
                    i += 1;
                } else if t == "-r" || t == "-" || !t.starts_with('-') {
                    danger(v, R_CRON);
                }
                i += 1;
            }
        }
        "truncate" => danger(v, R_TRUNCATE),
        "kubectl" | "oc" if a.has_any(&["delete", "drain"]) => danger(v, R_CLUSTER),
        "helm" if a.has_any(&["uninstall", "delete"]) => danger(v, R_CLUSTER),
        "at" | "batch" if !a.has_any(&["-l", "-c", "-r", "-d"]) => danger(v, R_DEFERRED),
        "mv" if a.pos_text().last() == Some(&"/dev/null") => danger(v, R_DELETE),
        "rsync"
            if a.texts()
                .any(|t| t.starts_with("--delete") || t == "--remove-source-files") =>
        {
            danger(v, R_DELETE)
        }
        _ => {}
    }
}

fn find(lx: &Lexed, idx: usize, args: &[Word], ctx: &GuardCtx, depth: usize, v: &mut Verdict) {
    // 表达式之前的非选项词是搜索起点。
    let paths: Vec<String> = args
        .iter()
        .map(|w| w.text.as_str())
        .skip_while(|t| matches!(*t, "-H" | "-L" | "-P"))
        .take_while(|t| !t.starts_with('-') && !matches!(*t, "(" | "!"))
        .map(str::to_string)
        .collect();
    let mut i = 0;
    while i < args.len() {
        match args[i].text.as_str() {
            "-delete" => {
                v.add(Tier::Danger, R_RECURSIVE_DELETE);
                for p in &paths {
                    push_unique(&mut v.delete_targets, p.clone());
                }
            }
            "-exec" | "-execdir" | "-ok" | "-okdir" => {
                let start = i + 1;
                let mut end = start;
                while end < args.len() && !matches!(args[end].text.as_str(), ";" | "+") {
                    end += 1;
                }
                classify_words(lx, idx, &args[start..end], ctx, depth + 1, v);
                i = end;
            }
            "-fprint" | "-fprint0" | "-fprintf" | "-fls" => {
                if let Some(t) = args.get(i + 1) {
                    rules_net::note_write(t, false, v);
                }
            }
            _ => {}
        }
        i += 1;
    }
}

fn git(w: &[Word], v: &mut Verdict) {
    // 跳过全局选项（-C 目录、-c 键=值 带值）。
    let mut i = 0;
    while let Some(x) = w.get(i) {
        match x.text.as_str() {
            "-C" | "-c" => i += 2,
            t if t.starts_with('-') => i += 1,
            _ => break,
        }
    }
    let Some(sub) = w.get(i) else {
        return;
    };
    let a = Args(&w[i + 1..]);
    let bad = match sub.text.as_str() {
        "reset" => a.has("--hard"),
        "clean" => a.short('f') || a.has("--force"),
        "push" => {
            a.short('f')
                || a.short('d')
                || a.has_any(&[
                    "--force",
                    "--force-with-lease",
                    "--delete",
                    "--mirror",
                    "--prune",
                ])
                || a.pos_text()
                    .iter()
                    .any(|t| t.starts_with('+') || t.starts_with(':'))
        }
        "branch" => a.short('D'),
        "stash" => matches!(a.pos_text().first(), Some(&"drop" | &"clear")),
        "checkout" => a.has_any(&["--", ".", "--force"]) || a.short('f'),
        "restore" => !a.has_any(&["--staged", "-S"]),
        "filter-branch" | "filter-repo" => true,
        _ => false,
    };
    if bad {
        v.add(Tier::Danger, R_GIT);
    }
}

fn containers(head: &str, w: &[Word], v: &mut Verdict) {
    let a = Args(w);
    let pos = a.pos_text();
    let sub_compose = pos.first() == Some(&"compose");
    let compose = head.ends_with("compose") || sub_compose;
    let skip = usize::from(sub_compose);
    let sub = pos.get(skip).copied();
    let sub2 = pos.get(skip + 1).copied();
    let bad = match sub {
        Some("rm" | "rmi") => true,
        Some("system" | "volume" | "image" | "container" | "network" | "builder" | "buildx") => {
            matches!(sub2, Some("prune" | "rm" | "remove"))
        }
        Some("down") if compose => a.has_any(&["-v", "--volumes", "--rmi"]),
        _ => false,
    };
    if bad {
        v.add(Tier::Danger, R_CONTAINER);
    }
    if sub == Some("kill") {
        v.add(Tier::Danger, R_KILL);
    }
}

fn database(lx: &Lexed, idx: usize, w: &[Word], v: &mut Verdict) {
    let seg = &lx.segments[idx];
    let mut texts: Vec<&str> = w.iter().map(|x| x.text.as_str()).collect();
    for r in &seg.redirects {
        if let Some(body) = &r.heredoc {
            texts.push(body);
        }
        if r.op == "<<<" {
            texts.push(&r.target.text);
        }
    }
    // `echo 'DROP ...' | mysql`：SQL 来自管道上游。
    if seg.sep_before == Sep::Pipe && idx > 0 {
        texts.extend(lx.segments[idx - 1].words.iter().map(|x| x.text.as_str()));
    }
    if texts.iter().any(|t| sql_destructive(t)) {
        v.add(Tier::Danger, R_DB);
    }
}

fn sql_destructive(s: &str) -> bool {
    let l = s.to_ascii_lowercase();
    const PATTERNS: &[&str] = &[
        "drop ",
        "drop\t",
        "drop\n",
        "truncate ",
        "delete from",
        "dropdatabase",
        ".drop(",
        "deletemany",
        ".remove(",
        "flushall",
        "flushdb",
    ];
    PATTERNS.iter().any(|p| l.contains(p))
}
