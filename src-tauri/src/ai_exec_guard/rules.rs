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
    rules_net::redirects(seg, ctx, v);
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
    if !x.quoted && (is_assignment(t) || is_prefix_keyword(t)) {
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

/// 后面紧跟一条命令的 shell 保留字：`then rm -rf x` 的命令是 rm，不是 then。
fn is_prefix_keyword(t: &str) -> bool {
    matches!(
        t,
        "if" | "then" | "else" | "elif" | "while" | "until" | "do" | "!" | "{"
    )
}

/// 条件与循环结构的保留字：出现即说明分段未必按书写顺序、未必都会执行。
pub(super) fn is_flow_keyword(t: &str) -> bool {
    matches!(
        t,
        "if" | "then"
            | "else"
            | "elif"
            | "fi"
            | "for"
            | "do"
            | "done"
            | "while"
            | "until"
            | "case"
            | "esac"
            | "select"
    )
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
    // chroot、env -C、sudo -D 改了根目录或执行目录：按 cwd 解析的路径都不对。
    if words[..k.min(words.len())].iter().any(|x| {
        let t = x.text.as_str();
        basename(t) == "chroot" || matches!(t, "-C" | "-D" | "--chdir") || t.starts_with("--chdir=")
    }) {
        v.block_allow(grant::B_CWD);
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
            // xargs 把 stdin 拼到命令末尾：补一个动态占位参与分级（裸 `xargs kill`
            // 才会被认作结束进程）；-I 是替换占位符，不补。目标都运行期才知道。
            v.block_allow(grant::B_TARGET);
            let n = skip_opts(rest, 0, XARGS_VALUE_OPTS);
            if n < rest.len() {
                let replace = rest[..n].iter().any(|x| {
                    let t = x.text.as_str();
                    t.starts_with("-I") || t.starts_with("-i") || t.starts_with("--replace")
                });
                let mut cmd = rest[n..].to_vec();
                if !replace {
                    cmd.push(Word {
                        text: "$XARGS".into(),
                        dynamic: true,
                        ..Default::default()
                    });
                }
                classify_words(lx, idx, &cmd, ctx, depth + 1, v);
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
    taint_check(head_path, head, args, ctx, v);
    destructive(head_path, head, args, ctx, v);
    match head {
        "find" => find(lx, idx, args, ctx, depth, v),
        "git" => git(args, ctx, v),
        "docker" | "podman" | "nerdctl" | "docker-compose" | "podman-compose" => {
            containers(head, args, v)
        }
        "mysql" | "mariadb" | "psql" | "sqlite3" | "clickhouse-client" | "mongo" | "mongosh"
        | "redis-cli" | "cqlsh" => database(lx, idx, args, v),
        _ => {}
    }
    rules_net::writes(head, args, ctx, v);
    rules_net::interpreters(lx, idx, head, args, ctx, depth, v);
    rules_net::disconnect(lx, idx, head, args, v);
    rules_net::network(head, args, ctx, v);
    rules_net::download_pipes(lx, idx, head, ctx, v);
}

/// `cd`/`pushd` 的静态目标：之后的分段据此解析相对路径。
pub(super) fn cd_target(seg: &Segment) -> Option<String> {
    let head = segment_head(seg)?;
    if !matches!(head.as_str(), "cd" | "pushd") {
        return None;
    }
    let target = seg
        .words
        .iter()
        .skip_while(|w| basename(&w.text) != head)
        .skip(1)
        .find(|w| !w.text.starts_with('-'))?;
    (!target.dynamic && !target.text.is_empty()).then(|| target.text.clone())
}

/// 引用下载产物也只是查看内容的命令（校验哈希、阅读是好习惯，不算执行）。
const TAINT_READONLY: &[&str] = &[
    "cat",
    "head",
    "tail",
    "less",
    "more",
    "file",
    "stat",
    "ls",
    "wc",
    "sha1sum",
    "sha224sum",
    "sha256sum",
    "sha384sum",
    "sha512sum",
    "md5sum",
    "b2sum",
    "cksum",
    "diff",
    "cmp",
    "grep",
    "egrep",
    "fgrep",
    "rg",
    "strings",
    "hexdump",
    "xxd",
    "od",
    "du",
    "jq",
    "yq",
    "rm",
    "curl",
    "wget",
    "cd",
    "pushd",
    "echo",
    "test",
    "[",
    "git",
];

/// 在下载产物目录（如 git clone 的仓库）里运行就会执行其中代码的构建/安装工具。
const BUILD_TOOLS: &[&str] = &[
    "make",
    "gmake",
    "cmake",
    "ninja",
    "meson",
    "npm",
    "yarn",
    "pnpm",
    "bun",
    "npx",
    "pip",
    "pip3",
    "cargo",
    "go",
    "mvn",
    "gradle",
    "ant",
    "bundle",
    "rake",
    "composer",
    "autoreconf",
    "python",
    "python3",
    "node",
    "ruby",
    "perl",
    "php",
    "sh",
    "bash",
    "zsh",
    "docker",
    "docker-compose",
    "podman",
];

/// 执行、安装、移动、解压本会话下载的文件都要确认：授权下载之后最常见的
/// 远程代码执行路径是「先下载、再执行」两步走，单看哪一步都像普通命令。
fn taint_check(head_path: &str, head: &str, args: &[Word], ctx: &GuardCtx, v: &mut Verdict) {
    if ctx.tainted.is_empty() && v.downloads.is_empty() {
        return;
    }
    let hit_head = head_path.contains('/') && is_tainted(ctx, v, head_path);
    let hit_cwd = BUILD_TOOLS.contains(&head) && !ctx.cwd.is_empty() && is_tainted(ctx, v, ctx.cwd);
    let hit_arg = !TAINT_READONLY.contains(&head)
        && args.iter().filter(|w| !w.dynamic).any(|w| {
            let t = w.text.as_str();
            let t = match t.split_once('=') {
                Some((k, val)) if k.starts_with('-') => val,
                _ => t,
            };
            let t = t.strip_prefix('@').unwrap_or(t);
            !t.is_empty() && !t.starts_with('-') && is_tainted(ctx, v, t)
        });
    if hit_head || hit_cwd || hit_arg {
        v.add(Tier::Egress, R_EXEC_DOWNLOADED);
    }
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

fn destructive(head_path: &str, head: &str, w: &[Word], ctx: &GuardCtx, v: &mut Verdict) {
    let a = Args(w);
    let danger = |v: &mut Verdict, r: &str| v.add(Tier::Danger, r);
    match head {
        "rm" | "rmdir" | "unlink" | "shred" | "srm" | "wipe" => {
            let recursive = head == "rm" && (a.short('r') || a.short('R') || a.has("--recursive"));
            let pos = a.positional();
            for t in &pos {
                push_unique(&mut v.delete_targets, t.text.clone());
            }
            let wipe = matches!(head, "shred" | "srm" | "wipe");
            let static_targets = !pos.is_empty()
                && pos
                    .iter()
                    .all(|x| !x.dynamic && !x.glob && !x.proc_subst && !x.text.is_empty());
            if recursive {
                danger(v, R_RECURSIVE_DELETE);
            } else if !wipe && static_targets {
                let targets = pos.iter().map(|x| grant::GrantTarget::File {
                    class: grant::G_DELETE,
                    path: resolve_path(ctx.cwd, &x.text),
                });
                v.add_targets(Tier::Danger, R_DELETE, targets);
            } else {
                if wipe {
                    v.block_allow(grant::B_WIPE);
                }
                danger(v, R_DELETE);
            }
        }
        "mkswap" | "wipefs" | "fdisk" | "sfdisk" | "cfdisk" | "gdisk" | "sgdisk" | "parted"
        | "blkdiscard" | "mke2fs" | "mkdosfs" => danger(v, R_DISK),
        h if h == "mkfs" || h.starts_with("mkfs.") => danger(v, R_DISK),
        "dd" => {
            for t in a.texts() {
                if let Some(of) = t.strip_prefix("of=") {
                    rules_net::note_write_path(of, false, ctx.cwd, v);
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
        "kill" if !(w.is_empty() || a.has_any(&["-0", "-l", "-L", "--list"])) => kill(head, w, v),
        "killall" | "pkill" | "killall5" | "skill" | "slay" => kill(head, w, v),
        "apt" | "apt-get" | "aptitude"
            if a.has_any(&["remove", "purge", "autoremove", "autopurge"]) =>
        {
            uninstall(head_path, head, w, v)
        }
        "yum" | "dnf" | "microdnf" | "tdnf" if a.has_any(&["remove", "erase", "autoremove"]) => {
            uninstall(head_path, head, w, v)
        }
        "zypper" if a.has_any(&["remove", "rm"]) => uninstall(head_path, head, w, v),
        "pacman" if a.texts().any(|t| t.starts_with("-R") || t == "--remove") => {
            uninstall(head_path, head, w, v)
        }
        "apk" if a.has("del") => uninstall(head_path, head, w, v),
        "snap" | "flatpak" if a.has_any(&["remove", "uninstall"]) => {
            uninstall(head_path, head, w, v)
        }
        "dpkg" if a.has_any(&["-r", "-P", "--remove", "--purge"]) => {
            uninstall(head_path, head, w, v)
        }
        "rpm" if a.has_any(&["-e", "--erase"]) => uninstall(head_path, head, w, v),
        h if (h == "pip" || h == "pip2" || h.starts_with("pip3")) && a.has("uninstall") => {
            uninstall(head_path, head, w, v)
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
    if adds_privileged_group(head, w) {
        danger(v, R_PRIV_GROUP);
    }
    if trusts_source(head, w) {
        danger(v, R_TRUST_SOURCE);
    }
    // systemctl link 把任意路径的单元文件注册进 systemd：持久化入口。
    if head == "systemctl" && a.pos_text().first() == Some(&"link") {
        danger(v, R_SENSITIVE_WRITE);
    }
}

/// 结束进程：只有「信号选项 + 明确 PID / 名字」的写法登记授权目标；
/// 按名字结束 sshd 等同切断 SSH。
fn kill(head: &str, w: &[Word], v: &mut Verdict) {
    let sels = kill_targets(head, w);
    if let Some(sels) = &sels {
        let hits_sshd = sels.iter().any(|s| match s {
            grant::KillSel::Name { pattern, exact } => ["sshd", "sshd-session"].iter().any(|n| {
                if *exact {
                    *n == pattern.as_str()
                } else {
                    n.contains(pattern.as_str())
                }
            }),
            grant::KillSel::Pids(_) => false,
        });
        if hits_sshd {
            v.add(Tier::Danger, R_DISCONNECT);
        }
    }
    match sels {
        Some(sels) => v.add_targets(
            Tier::Danger,
            R_KILL,
            sels.into_iter().map(grant::GrantTarget::Kill),
        ),
        None => {
            v.block_allow(grant::B_KILL_MODE);
            v.add(Tier::Danger, R_KILL);
        }
    }
}

/// `-9`、`-KILL`、`-SIGTERM`。信号名至少两个字母：`-U`、`-G` 这类单字母是选择器。
fn is_signal_spec(s: &str) -> bool {
    (!s.is_empty() && s.chars().all(|c| c.is_ascii_digit()))
        || (s.len() >= 2
            && s.starts_with(|c: char| c.is_ascii_uppercase())
            && s.chars()
                .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit()))
}

/// 名字只认普通进程名字符：正则元字符让命中范围难以预期。
fn plain_proc_name(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 64
        && s.chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-' | '+'))
}

fn kill_targets(head: &str, w: &[Word]) -> Option<Vec<grant::KillSel>> {
    if !matches!(head, "kill" | "pkill" | "killall") {
        return None;
    }
    if w.iter().any(|x| x.dynamic || x.glob || x.proc_subst) {
        return None;
    }
    let mut exact = head == "killall";
    let mut sig = false;
    let mut opts = true;
    let mut targets: Vec<&str> = Vec::new();
    let mut i = 0;
    while i < w.len() {
        let t = w[i].text.as_str();
        if opts && t == "--" {
            opts = false;
        } else if opts && t.starts_with('-') && t != "-" {
            match (head, t) {
                (_, "-s" | "--signal") | ("kill", "-n") => {
                    sig = true;
                    i += 1;
                }
                (_, t) if t.starts_with("--signal=") => sig = true,
                ("pkill", "-x" | "--exact") => exact = true,
                ("pkill", "-e" | "--echo") => {}
                (
                    "killall",
                    "-e" | "--exact" | "-q" | "--quiet" | "-w" | "--wait" | "-v" | "--verbose",
                ) => {}
                (_, t) if !sig && is_signal_spec(&t[1..]) => sig = true,
                _ => return None,
            }
        } else {
            targets.push(t);
        }
        i += 1;
    }
    if targets.is_empty() {
        return None;
    }
    match head {
        "kill" => targets
            .iter()
            .map(|t| t.parse::<u32>().ok().filter(|&p| p > 0))
            .collect::<Option<Vec<_>>>()
            .map(|p| vec![grant::KillSel::Pids(p)]),
        "pkill" if targets.len() == 1 && plain_proc_name(targets[0]) => {
            Some(vec![grant::KillSel::Name {
                pattern: targets[0].to_string(),
                exact,
            }])
        }
        "killall" if targets.iter().all(|t| plain_proc_name(t)) => Some(
            targets
                .iter()
                .map(|t| grant::KillSel::Name {
                    pattern: t.to_string(),
                    exact: true,
                })
                .collect(),
        ),
        _ => None,
    }
}

/// 卸载软件包：只有「系统包管理器 + 普通卸载 + 明确包名」登记授权目标。
fn uninstall(head_path: &str, head: &str, w: &[Word], v: &mut Verdict) {
    match pkg_target(head_path, head, w) {
        Ok((mgr, pkgs)) => v.add_targets(
            Tier::Danger,
            R_UNINSTALL,
            [grant::GrantTarget::Pkg { mgr, pkgs }],
        ),
        Err(why) => {
            v.block_allow(why);
            v.add(Tier::Danger, R_UNINSTALL);
        }
    }
}

fn pkg_name_ok(s: &str) -> bool {
    s.len() <= 128
        && s.chars().next().is_some_and(|c| c.is_ascii_alphanumeric())
        && s.chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '+' | '-'))
}

fn pkg_target(
    head_path: &str,
    head: &str,
    w: &[Word],
) -> Result<(grant::PkgMgr, Vec<String>), &'static str> {
    use grant::PkgMgr::*;
    // 复核只模拟系统 PATH 里的包管理器，绝不运行命令里点名路径的程序。
    if head_path.contains('/') {
        return Err(grant::B_PKG_MGR);
    }
    if w.iter().any(|x| x.dynamic || x.glob || x.proc_subst) {
        return Err(grant::B_PKG_MODE);
    }
    let pip = head == "pip" || head.starts_with("pip3");
    // (包管理器, 子命令, 卸载操作选项, 允许的附加选项)
    let (mgr, subs, ops, extra): (grant::PkgMgr, &[&str], &[&str], &[&str]) = match head {
        "apt" | "apt-get" => (
            Apt,
            &["remove"],
            &[],
            &[
                "-y",
                "--yes",
                "--assume-yes",
                "-q",
                "-qq",
                "--quiet",
                "-yq",
                "-qy",
            ],
        ),
        "dnf" => (
            Dnf,
            &["remove", "erase"],
            &[],
            &["-y", "--assumeyes", "-q", "--quiet"],
        ),
        "yum" => (
            Yum,
            &["remove", "erase"],
            &[],
            &["-y", "--assumeyes", "-q", "--quiet"],
        ),
        "snap" => (Snap, &["remove"], &[], &[]),
        "flatpak" => (
            Flatpak,
            &["uninstall"],
            &[],
            &["-y", "--assumeyes", "--noninteractive"],
        ),
        _ if pip => (Pip, &["uninstall"], &[], &["-y", "--yes", "-q", "--quiet"]),
        "pacman" => (Pacman, &[], &["-R", "--remove"], &["--noconfirm"]),
        "dpkg" => (Dpkg, &[], &["-r", "--remove"], &[]),
        "rpm" => (Rpm, &[], &["-e", "--erase"], &[]),
        _ => return Err(grant::B_PKG_MGR),
    };
    let mut op_seen = ops.is_empty();
    let mut sub_seen = subs.is_empty();
    let mut pkgs = Vec::new();
    for x in w {
        let t = x.text.as_str();
        if ops.contains(&t) && !op_seen {
            op_seen = true;
        } else if t.starts_with('-') {
            if !extra.contains(&t) {
                return Err(grant::B_PKG_MODE);
            }
        } else if !sub_seen {
            if !subs.contains(&t) {
                return Err(grant::B_PKG_MODE);
            }
            sub_seen = true;
        } else if pkg_name_ok(t) {
            push_unique(&mut pkgs, t.to_string());
        } else {
            return Err(grant::B_PKG_MODE);
        }
    }
    if !op_seen || !sub_seen || pkgs.is_empty() {
        return Err(grant::B_PKG_MODE);
    }
    Ok((mgr, pkgs))
}

/// 加入后等同 root 的用户组（sudo/wheel 提权，docker/lxd 可挂宿主根，disk/shadow 直读）。
const PRIV_GROUPS: &[&str] = &[
    "sudo", "wheel", "admin", "root", "docker", "lxd", "disk", "shadow", "libvirt",
];

fn adds_privileged_group(head: &str, w: &[Word]) -> bool {
    let a = Args(w);
    // (组列表文本, 是否动态)
    let mut groups: Vec<(String, bool)> = Vec::new();
    let word = |x: &Word| (x.text.clone(), x.dynamic);
    match head {
        "usermod" | "useradd" => {
            let mut i = 0;
            while let Some(x) = w.get(i) {
                let t = x.text.as_str();
                if t == "-G" || t == "--groups" {
                    groups.extend(w.get(i + 1).map(word));
                    i += 2;
                    continue;
                }
                if let Some(list) = t.strip_prefix("--groups=") {
                    groups.push((list.to_string(), x.dynamic));
                } else if t.starts_with('-') && !t.starts_with("--") {
                    // 短选项簇里的 G：在末尾取下一个词（-aG docker），否则其后即内联值（-aGdocker）。
                    if let Some(p) = t.find('G') {
                        let inline = &t[p + 1..];
                        if inline.is_empty() {
                            groups.extend(w.get(i + 1).map(word));
                            i += 1;
                        } else {
                            groups.push((inline.to_string(), x.dynamic));
                        }
                    }
                }
                i += 1;
            }
        }
        "gpasswd" if a.short('a') || a.has("--add") => {
            groups.extend(a.positional().last().map(|x| word(x)));
        }
        "adduser" | "addgroup" => {
            let pos = a.positional();
            if pos.len() >= 2 {
                groups.push(word(pos[1]));
            }
        }
        _ => return false,
    }
    groups.iter().any(|(list, dynamic)| {
        *dynamic
            || list
                .split(',')
                .any(|name| PRIV_GROUPS.contains(&name.trim()))
    })
}

/// 添加软件源或信任密钥：之后安装的任何包都来自新来源，属于供应链信任决策。
fn trusts_source(head: &str, w: &[Word]) -> bool {
    let a = Args(w);
    match head {
        "add-apt-repository" | "apt-add-repository" => !a.has_any(&["-r", "--remove"]),
        "apt-key" => a.has_any(&["add", "adv"]),
        "rpm" | "rpmkeys" => a.has("--import"),
        "yum-config-manager" => a.texts().any(|t| t.starts_with("--add-repo")),
        "dnf" | "yum" => {
            a.has("addrepo")
                || (a.has("config-manager") && a.texts().any(|t| t.starts_with("--add-repo")))
        }
        "zypper" => a.has_any(&["addrepo", "ar"]),
        _ => false,
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
                    rules_net::note_write(t, false, ctx.cwd, v);
                }
            }
            _ => {}
        }
        i += 1;
    }
}

/// git 配置里能执行任意命令的键（`-c` 或 `clone --config` 传入）。
fn git_exec_config(kv: &str) -> bool {
    let key = kv.split('=').next().unwrap_or("").to_ascii_lowercase();
    matches!(
        key.as_str(),
        "core.sshcommand"
            | "core.fsmonitor"
            | "core.pager"
            | "core.editor"
            | "core.hookspath"
            | "core.askpass"
            | "core.gitproxy"
            | "protocol.ext.allow"
            | "credential.helper"
            | "diff.external"
            | "gpg.program"
            | "sequence.editor"
            | "uploadpack.packobjectshook"
    ) || key.starts_with("alias.")
        || key.starts_with("filter.")
        || (key.starts_with("diff.") && key.ends_with(".textconv"))
        || (key.starts_with("merge.") && key.ends_with(".driver"))
}

/// 改写网络目标的 git 配置（URL 重写、代理）：下载目标不再静态可知。
fn git_net_config(kv: &str) -> bool {
    let key = kv.split('=').next().unwrap_or("").to_ascii_lowercase();
    key.starts_with("url.") || key.contains("proxy")
}

/// clone/fetch/pull/ls-remote 带值的选项（其值不是仓库地址）。
const GIT_NET_VALUE_OPTS: &[&str] = &[
    "-b",
    "--branch",
    "--depth",
    "-o",
    "--origin",
    "-c",
    "--config",
    "--reference",
    "--reference-if-able",
    "--separate-git-dir",
    "--template",
    "-j",
    "--jobs",
    "--filter",
    "--shallow-since",
    "--shallow-exclude",
    "--server-option",
    "--bundle-uri",
];

/// 仓库地址对应的默认目录名（`https://h/a/b.git` → `b`）。
fn repo_dir_name(url: &str) -> Option<String> {
    let name = url
        .trim_end_matches('/')
        .rsplit(['/', ':'])
        .next()?
        .trim_end_matches(".git");
    (!name.is_empty()).then(|| name.to_string())
}

fn git(w: &[Word], ctx: &GuardCtx, v: &mut Verdict) {
    // 跳过全局选项（-C 目录、-c 键=值 带值），顺带检查 -c 配置。
    let mut i = 0;
    let mut dir: Option<&str> = None;
    let mut net_rewrite = false;
    let mut check_config = |kv: &Word, v: &mut Verdict| {
        if kv.dynamic || git_exec_config(&kv.text) {
            v.add(Tier::Danger, R_OBFUSCATED);
        }
        net_rewrite |= git_net_config(&kv.text);
    };
    while let Some(x) = w.get(i) {
        match x.text.as_str() {
            "-C" => {
                dir = w.get(i + 1).map(|d| d.text.as_str());
                i += 2;
            }
            "-c" => {
                if let Some(kv) = w.get(i + 1) {
                    check_config(kv, v);
                }
                i += 2;
            }
            t if t.starts_with('-') => i += 1,
            _ => break,
        }
    }
    let Some(sub) = w.get(i) else {
        return;
    };
    let sub = sub.text.as_str();
    let rest = &w[i + 1..];
    let a = Args(rest);
    // 子命令里同样能传配置，或指定在远端/本地执行的程序（--upload-pack、ext:: 传输）。
    for (j, x) in rest.iter().enumerate() {
        let t = x.text.as_str();
        if t == "-c" || t == "--config" {
            if let Some(kv) = rest.get(j + 1) {
                check_config(kv, v);
            }
        } else if let Some(kv) = t.strip_prefix("--config=") {
            check_config(
                &Word {
                    text: kv.to_string(),
                    ..x.clone()
                },
                v,
            );
        }
        let runs_program = t.starts_with("--upload-pack")
            || t.starts_with("--receive-pack")
            || t.starts_with("--exec")
            || (t == "-u" && matches!(sub, "clone" | "fetch" | "pull" | "ls-remote" | "archive"))
            || t.starts_with("ext::");
        if runs_program {
            v.add(Tier::Danger, R_OBFUSCATED);
        }
    }
    let bad = match sub {
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
    match sub {
        // 推送 = 把仓库内容（可能含误提交的密钥）送到远端。
        "push" | "send-pack" => v.add(Tier::Egress, R_UPLOAD),
        // 显式给出外部仓库地址的拉取；不带地址（用已配置的远端）仍是普通操作。
        "clone" | "fetch" | "pull" | "ls-remote" => {
            let pos = rules_net::positional_with(rest, GIT_NET_VALUE_OPTS, "bocj");
            let mut hosts = Vec::new();
            let mut dynamic = false;
            for x in &pos {
                if x.dynamic {
                    dynamic = true;
                } else if let Some(h) = rules_net::git_remote_host(&x.text) {
                    hosts.push(h);
                }
            }
            if hosts.is_empty() && !dynamic {
                return;
            }
            v.add(Tier::Egress, R_DOWNLOAD);
            for h in hosts {
                push_unique(&mut v.net_hosts, h);
            }
            if dynamic {
                v.block_allow(rules_net::B_DYNAMIC);
            }
            if net_rewrite {
                v.block_allow(rules_net::B_PROXY);
            }
            if sub == "clone" {
                let target = match (pos.first(), pos.get(1)) {
                    (_, Some(d)) if !d.dynamic => Some(d.text.clone()),
                    (Some(u), None) if !u.dynamic => repo_dir_name(&u.text),
                    _ => None,
                };
                match target {
                    Some(t) => {
                        let base = dir.map_or(ctx.cwd.to_string(), |d| resolve_path(ctx.cwd, d));
                        push_unique(&mut v.downloads, resolve_path(&base, &t));
                    }
                    None => v.block_allow(rules_net::B_NAME_UNKNOWN),
                }
            }
        }
        _ => {}
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
    if compose {
        return;
    }
    if sub == Some("push") {
        v.add(Tier::Egress, R_UPLOAD);
    }
    if matches!(sub, Some("run" | "create")) && container_escapes(w) {
        v.add(Tier::Danger, R_CONTAINER_ESCAPE);
    }
}

/// 让容器拿到宿主机 root 等价能力的参数：特权、共享宿主 PID/用户命名空间、
/// 危险能力、裸设备、关闭隔离，或把宿主根/系统目录/docker.sock 挂进容器。
fn container_escapes(w: &[Word]) -> bool {
    let texts: Vec<&str> = w.iter().map(|x| x.text.as_str()).collect();
    let value = |i: usize, name: &str| -> Option<&str> {
        let t = texts[i];
        if t == name {
            texts.get(i + 1).copied()
        } else {
            t.strip_prefix(name).and_then(|r| r.strip_prefix('='))
        }
    };
    for i in 0..texts.len() {
        let t = texts[i];
        if t == "--privileged" || t == "--privileged=true" {
            return true;
        }
        if ["--pid", "--userns"]
            .iter()
            .any(|n| value(i, n) == Some("host"))
        {
            return true;
        }
        if let Some(caps) = value(i, "--cap-add") {
            let dangerous = caps.split(',').any(|c| {
                let c = c.trim().to_ascii_uppercase();
                matches!(
                    c.trim_start_matches("CAP_"),
                    "SYS_ADMIN"
                        | "ALL"
                        | "SYS_PTRACE"
                        | "SYS_MODULE"
                        | "DAC_READ_SEARCH"
                        | "SYS_RAWIO"
                )
            });
            if dangerous {
                return true;
            }
        }
        if value(i, "--device").is_some() {
            return true;
        }
        if value(i, "--security-opt").is_some_and(|s| {
            s.contains("unconfined") || s.contains("label=disable") || s.contains("label:disable")
        }) {
            return true;
        }
        let volume = value(i, "--volume").or_else(|| value(i, "-v")).or_else(|| {
            (t.len() > 2 && t.starts_with("-v") && !t.starts_with("--")).then(|| &t[2..])
        });
        if let Some(spec) = volume {
            if host_root_source(spec.split(':').next().unwrap_or("")) {
                return true;
            }
        }
        if let Some(spec) = value(i, "--mount") {
            let src = spec.split(',').find_map(|kv| {
                kv.strip_prefix("source=")
                    .or_else(|| kv.strip_prefix("src="))
            });
            if src.is_some_and(host_root_source) {
                return true;
            }
        }
    }
    false
}

fn host_root_source(src: &str) -> bool {
    let trimmed = src.trim_end_matches('/');
    let s = if trimmed.is_empty() && src.starts_with('/') {
        "/"
    } else {
        trimmed
    };
    matches!(
        s,
        "/" | "/etc"
            | "/root"
            | "/boot"
            | "/home"
            | "/var"
            | "/usr"
            | "/proc"
            | "/sys"
            | "/dev"
            | "/var/lib/docker"
    ) || s.ends_with("docker.sock")
        || s.starts_with("/proc/")
        || s.starts_with("/sys/")
        || (s.starts_with("/dev/") && !matches!(s, "/dev/shm" | "/dev/null"))
        || path_policy(s) == PathPolicy::Deny
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
