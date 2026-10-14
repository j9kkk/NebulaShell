//! 远端命令执行：包装脚本、流式读取、超时与中止、进程组清理、输出整理。

use crate::ai_exec_guard::{redact, shell_quote, MASK};
use crate::commands::AppState;
use crate::ssh::ExecEvent;
use serde_json::json;
use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

/// 包装脚本（`$1`=工作目录，`$2`=命令）：先报告进程组号 —— sshd 为每个 exec
/// 会话 setsid，`exec sh` 后 `$$` 即会话首进程，整棵进程树都在这个组里；
/// 再切目录（失败即退出，绝不在错误目录里执行）、关掉分页器与交互式前端，
/// 最后交给 bash（没有就 sh）。命令经位置参数传入，不再多拼一层 shell。
const WRAPPER: &str = r#"printf '__NB_PGID %s\n' "$$"; if [ -n "$1" ]; then cd -- "$1" || exit 97; fi; export DEBIAN_FRONTEND=noninteractive PAGER=cat SYSTEMD_PAGER= GIT_PAGER=cat LESS=FRX; if command -v bash >/dev/null 2>&1; then exec bash -c "$2"; else exec sh -c "$2"; fi"#;

/// sudo 密码托管：密码经通道 stdin 读进非导出变量，每次 sudo 由 askpass
/// 取回（`SUDO_ASKPASS=printenv` + 以变量名作提示语，sudo 执行
/// `printenv __NB_SUDO_PW` 拿到密码）。不进命令行、不落盘，也不经命令的
/// stdin —— sudo 无需密码时也不会把密码漏进 `sudo tee` 之类的输入里。
const SUDO_SHIM: &str = r#"IFS= read -r __nb_pw; __nb_askpass=$(command -v printenv); sudo() { __NB_SUDO_PW="$__nb_pw" SUDO_ASKPASS="$__nb_askpass" command sudo -A -p __NB_SUDO_PW "$@"; }; "#;

pub(super) fn wrap(cwd: &str, cmd: &str, sudo: bool) -> String {
    let body = if sudo {
        format!("{SUDO_SHIM}{cmd}")
    } else {
        cmd.to_string()
    };
    format!(
        "exec sh -c {} nb {} {}",
        shell_quote(WRAPPER),
        shell_quote(cwd),
        shell_quote(&body)
    )
}

pub(super) fn sudo_stdin(password: Option<&str>) -> Option<Vec<u8>> {
    password.map(|p| format!("{p}\n").into_bytes())
}

/// 输出采集：只保留头尾，中间按字节计数。错误信息多在末尾，不能只留开头。
pub(super) struct HeadTail {
    head: Vec<u8>,
    tail: VecDeque<u8>,
    head_cap: usize,
    tail_cap: usize,
    total: usize,
}

impl HeadTail {
    pub fn new(head_cap: usize, tail_cap: usize) -> Self {
        Self {
            head: Vec::new(),
            tail: VecDeque::new(),
            head_cap,
            tail_cap,
            total: 0,
        }
    }

    pub fn push(&mut self, mut bytes: &[u8]) {
        self.total += bytes.len();
        let room = self.head_cap.saturating_sub(self.head.len());
        let take = room.min(bytes.len());
        self.head.extend_from_slice(&bytes[..take]);
        bytes = &bytes[take..];
        if bytes.len() > self.tail_cap {
            bytes = &bytes[bytes.len() - self.tail_cap..];
        }
        self.tail.extend(bytes);
        while self.tail.len() > self.tail_cap {
            self.tail.pop_front();
        }
    }

    /// （文本, 是否省略了中间部分, 原始字节数）
    pub fn finish(self) -> (String, bool, usize) {
        let head = String::from_utf8_lossy(&self.head).into_owned();
        let tail: Vec<u8> = self.tail.into_iter().collect();
        let tail = String::from_utf8_lossy(&tail).into_owned();
        let kept = self.head.len() + tail.len();
        if self.total <= self.head_cap + self.tail_cap {
            return (head + &tail, false, self.total);
        }
        let omitted = self.total.saturating_sub(kept);
        (
            format!("{head}\n…（中间省略 {omitted} 字节）…\n{tail}"),
            true,
            self.total,
        )
    }
}

/// 去掉 ANSI 控制序列与杂散控制字符；`\r` 覆盖的进度行只留最后一帧。
pub(super) fn clean_output(s: &str) -> String {
    let mut stripped = String::with_capacity(s.len());
    let mut it = s.chars().peekable();
    while let Some(c) = it.next() {
        match c {
            '\x1b' => match it.peek() {
                Some('[') => {
                    it.next();
                    for d in it.by_ref() {
                        if ('@'..='~').contains(&d) {
                            break;
                        }
                    }
                }
                Some(']') => {
                    it.next();
                    while let Some(d) = it.next() {
                        if d == '\x07' || (d == '\x1b' && it.peek() == Some(&'\\')) {
                            if d == '\x1b' {
                                it.next();
                            }
                            break;
                        }
                    }
                }
                _ => {
                    it.next();
                }
            },
            '\n' | '\t' | '\r' => stripped.push(c),
            c if c.is_control() => {}
            c => stripped.push(c),
        }
    }
    stripped
        .replace("\r\n", "\n")
        .split('\n')
        .map(|line| line.rsplit('\r').find(|seg| !seg.is_empty()).unwrap_or(""))
        .collect::<Vec<_>>()
        .join("\n")
}

/// 取出缓冲区里完整的 UTF-8 前缀，末尾被截断的多字节字符留到下一批。
pub(super) fn take_complete_utf8(buf: &mut Vec<u8>) -> String {
    let cut = match std::str::from_utf8(buf) {
        Ok(_) => buf.len(),
        Err(e) if e.error_len().is_none() => e.valid_up_to(),
        Err(_) => buf.len(),
    };
    let rest = buf.split_off(cut);
    let text = String::from_utf8_lossy(buf).into_owned();
    *buf = rest;
    text
}

/// 给模型的最终文本：清洗 → 脱敏 → 遮掉 sudo 密码原文。
pub(super) fn finalize(text: &str, password: Option<&str>) -> (String, usize) {
    let (mut out, mut n) = redact(&clean_output(text));
    if let Some(pw) = password.filter(|p| p.len() >= 3) {
        if out.contains(pw) {
            out = out.replace(pw, MASK);
            n += 1;
        }
    }
    (out, n)
}

pub(super) struct RunSpec<'a> {
    pub sid: &'a str,
    pub cmd: &'a str,
    pub cwd: &'a str,
    pub sudo_password: Option<&'a str>,
    pub idle: Duration,
    pub hard: Duration,
    /// Some：把输出以 ai:tool-output 事件流给前端。
    pub ui_run_id: Option<&'a str>,
    pub abort: Option<&'a AtomicBool>,
    pub head_cap: usize,
    pub tail_cap: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum RunEnd {
    Exited,
    Aborted,
    IdleTimeout,
    HardTimeout,
}

pub(super) struct RunResult {
    pub end: RunEnd,
    pub exit_code: Option<i64>,
    pub signal: Option<String>,
    pub output: String,
    pub truncated: bool,
    pub total_bytes: usize,
    pub duration_ms: u64,
}

/// 节流的前端输出流：100ms 合并一批，按完整 UTF-8 切分。
struct UiStream<'a> {
    app: &'a tauri::AppHandle,
    run_id: &'a str,
    pending: Vec<u8>,
    password: Option<&'a str>,
}

impl UiStream<'_> {
    fn flush(&mut self) {
        if self.pending.is_empty() {
            return;
        }
        let mut text = clean_output(&take_complete_utf8(&mut self.pending));
        if let Some(pw) = self.password.filter(|p| p.len() >= 3) {
            text = text.replace(pw, MASK);
        }
        if !text.is_empty() {
            crate::ai::emit_evt(
                self.app,
                "ai:tool-output",
                json!({ "toolRunId": self.run_id, "chunk": text }),
            );
        }
    }
}

/// 从输出开头找出 `__NB_PGID <n>` 标记行（登录脚本可能先打印东西）。
/// 返回 (进程组号, 去掉标记行后的字节)；8KB 内找不到就放弃。
pub(super) fn split_pgid(prelude: &[u8]) -> Option<(Option<u32>, Vec<u8>)> {
    const MARK: &[u8] = b"__NB_PGID ";
    if let Some(pos) = prelude.windows(MARK.len()).position(|w| w == MARK) {
        let after = &prelude[pos + MARK.len()..];
        let nl = after.iter().position(|b| *b == b'\n')?;
        let pgid = std::str::from_utf8(&after[..nl])
            .ok()
            .and_then(|s| s.trim().parse().ok());
        let mut rest = prelude[..pos].to_vec();
        rest.extend_from_slice(&after[nl + 1..]);
        return Some((pgid, rest));
    }
    (prelude.len() > 8 * 1024).then(|| (None, prelude.to_vec()))
}

pub(super) async fn run(
    state: &AppState,
    app: &tauri::AppHandle,
    spec: RunSpec<'_>,
) -> Result<RunResult, String> {
    let started = Instant::now();
    let stdin = sudo_stdin(spec.sudo_password);
    let wrapped = wrap(spec.cwd, spec.cmd, spec.sudo_password.is_some());
    let mut ch = state
        .ssh
        .exec_open(spec.sid, &wrapped, stdin.as_deref())
        .await?;
    let mut collector = HeadTail::new(spec.head_cap, spec.tail_cap);
    let mut ui = spec.ui_run_id.map(|run_id| UiStream {
        app,
        run_id,
        pending: Vec::new(),
        password: spec.sudo_password,
    });
    let mut prelude: Option<Vec<u8>> = Some(Vec::new());
    let mut pgid: Option<u32> = None;
    let mut exit_code = None;
    let mut signal = None;
    let mut last_output = Instant::now();
    let mut tick = tokio::time::interval(Duration::from_millis(100));
    fn accept(bytes: &[u8], collector: &mut HeadTail, ui: &mut Option<UiStream<'_>>) {
        collector.push(bytes);
        if let Some(ui) = ui.as_mut() {
            ui.pending.extend_from_slice(bytes);
        }
    }
    let end = loop {
        tokio::select! {
            ev = ch.next() => match ev {
                Some(ExecEvent::Data(bytes)) => {
                    last_output = Instant::now();
                    match prelude.as_mut() {
                        Some(buf) => {
                            buf.extend_from_slice(&bytes);
                            if let Some((found, rest)) = split_pgid(buf) {
                                pgid = found;
                                prelude = None;
                                accept(&rest, &mut collector, &mut ui);
                            }
                        }
                        None => accept(&bytes, &mut collector, &mut ui),
                    }
                }
                Some(ExecEvent::Exit(code)) => exit_code = Some(code),
                Some(ExecEvent::Signal(name)) => signal = Some(name),
                None => break RunEnd::Exited,
            },
            _ = tick.tick() => {
                if let Some(ui) = ui.as_mut() {
                    ui.flush();
                }
                if spec.abort.is_some_and(|f| f.load(Ordering::Acquire)) {
                    break RunEnd::Aborted;
                }
                if last_output.elapsed() > spec.idle {
                    break RunEnd::IdleTimeout;
                }
                if started.elapsed() > spec.hard {
                    break RunEnd::HardTimeout;
                }
            }
        }
    };
    if let Some(rest) = prelude.take() {
        accept(&rest, &mut collector, &mut ui);
    }
    if end != RunEnd::Exited {
        terminate(state, spec.sid, pgid, spec.sudo_password, spec.cmd, &mut ch).await;
    }
    ch.close().await;
    if let Some(ui) = ui.as_mut() {
        ui.flush();
    }
    let (raw, truncated, total_bytes) = collector.finish();
    let (output, _) = finalize(&raw, spec.sudo_password);
    Ok(RunResult {
        end,
        exit_code,
        signal,
        output,
        truncated,
        total_bytes,
        duration_ms: started.elapsed().as_millis() as u64,
    })
}

/// 结束远端进程组：先 TERM，2 秒内未退出再 KILL。命令里用过 sudo 时
/// 用 sudo 再发一遍（root 进程普通用户杀不掉）。只关通道不会结束远端进程。
async fn terminate(
    state: &AppState,
    sid: &str,
    pgid: Option<u32>,
    password: Option<&str>,
    cmd: &str,
    ch: &mut crate::ssh::ExecChannel,
) {
    let Some(pg) = pgid else {
        return;
    };
    let used_sudo = super::mentions_sudo(cmd);
    for (sig, wait) in [("TERM", 2000u64), ("KILL", 1000)] {
        let mut script =
            format!("kill -{sig} -- -{pg} 2>/dev/null || kill -{sig} {pg} 2>/dev/null");
        if used_sudo {
            let sudo = if password.is_some() {
                "sudo"
            } else {
                "sudo -n"
            };
            script.push_str(&format!(
                "; {sudo} kill -{sig} -- -{pg} 2>/dev/null || {sudo} kill -{sig} {pg} 2>/dev/null"
            ));
        }
        let _ = quick(state, sid, &script, password, Duration::from_secs(5)).await;
        let closed = tokio::time::timeout(Duration::from_millis(wait), async {
            while ch.next().await.is_some() {}
        })
        .await;
        if closed.is_ok() {
            return;
        }
    }
}

/// 短命令：整段收集输出，超时即放弃（只用于探测类命令）。
pub(super) async fn quick(
    state: &AppState,
    sid: &str,
    cmd: &str,
    password: Option<&str>,
    timeout: Duration,
) -> Result<(Option<i64>, String), String> {
    let stdin = sudo_stdin(password);
    let wrapped = wrap("", cmd, password.is_some());
    let mut ch = state.ssh.exec_open(sid, &wrapped, stdin.as_deref()).await?;
    let mut out = Vec::new();
    let mut code = None;
    let read = tokio::time::timeout(timeout, async {
        while let Some(ev) = ch.next().await {
            match ev {
                ExecEvent::Data(b) => out.extend_from_slice(&b),
                ExecEvent::Exit(c) => code = Some(c),
                ExecEvent::Signal(_) => {}
            }
        }
    })
    .await;
    ch.close().await;
    if read.is_err() {
        return Err("远端命令超时".to_string());
    }
    let text = match split_pgid(&out) {
        Some((_, rest)) => String::from_utf8_lossy(&rest).into_owned(),
        None => String::from_utf8_lossy(&out).into_owned(),
    };
    Ok((code, clean_output(&text)))
}
