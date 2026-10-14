//! AI 主机工具：`ai:tool-exec` / `ai:tool-cancel` / `ai:guard-classify` /
//! `ai:tool-audit` 的实现。
//!
//! 前端驱动工具循环，这里无状态执行：每次调用都重新分级，档位只信这里算出的
//! 结果。前端传来的 `confirmed` 只表示「用户看过 `confirmedTier` 档的确认卡」，
//! 档位升高（改后执行、写入目标变成已存在文件）必须重新确认。

mod files;
mod hostinfo;
mod run;
#[cfg(test)]
mod tests;

use crate::ai_exec_guard::{classify, preview_command, GuardCtx, Tier, R_OVERWRITE_EXISTING};
use crate::commands::AppState;
use files::PathError;
use run::{RunEnd, RunSpec};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::Write;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

/// 正在执行的工具调用的取消标记（toolRunId → flag）。
fn runs() -> &'static Mutex<HashMap<String, Arc<AtomicBool>>> {
    static R: OnceLock<Mutex<HashMap<String, Arc<AtomicBool>>>> = OnceLock::new();
    R.get_or_init(Default::default)
}

struct RunGuard {
    id: String,
    flag: Arc<AtomicBool>,
}

impl RunGuard {
    fn new(id: &str) -> Self {
        let flag = Arc::new(AtomicBool::new(false));
        if !id.is_empty() {
            runs().lock().unwrap().insert(id.to_string(), flag.clone());
        }
        Self {
            id: id.to_string(),
            flag,
        }
    }
}

impl Drop for RunGuard {
    fn drop(&mut self) {
        let mut r = runs().lock().unwrap();
        if r.get(&self.id).is_some_and(|f| Arc::ptr_eq(f, &self.flag)) {
            r.remove(&self.id);
        }
    }
}

pub fn tool_cancel(p: &Value) -> Value {
    let id = p["toolRunId"].as_str().unwrap_or("");
    let found = runs().lock().unwrap().get(id).cloned();
    if let Some(flag) = &found {
        flag.store(true, Ordering::Release);
    }
    json!({ "cancelled": found.is_some() })
}

/// 旧代码块执行路径与前端提示共用的分级入口（单一规则源）。
pub fn guard_classify(p: &Value) -> Value {
    let cmd = p["cmd"].as_str().unwrap_or("");
    let v = classify(
        cmd,
        &GuardCtx {
            os_known: true,
            is_root: false,
        },
    );
    serde_json::to_value(v).unwrap_or(Value::Null)
}

pub(crate) fn mentions_sudo(cmd: &str) -> bool {
    cmd.split(|c: char| c.is_whitespace() || ";|&()`$".contains(c))
        .any(|w| w == "sudo" || w.ends_with("/sudo"))
}

fn err(code: &str, message: impl Into<String>) -> Value {
    json!({ "status": "error", "code": code, "message": message.into() })
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// 审计：AI 经 exec 通道执行的命令不进终端也不进命令历史，必须单独留痕。
fn audit(state: &AppState, entry: Value) {
    let dir = crate::commands::default_log_dir(state.test_mode);
    if std::fs::create_dir_all(&dir).is_err() {
        return;
    }
    let path = dir.join("ai-audit.log");
    if std::fs::metadata(&path).is_ok_and(|m| m.len() > 10 * 1024 * 1024) {
        let _ = std::fs::rename(&path, dir.join("ai-audit.log.1"));
    }
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
    {
        let _ = writeln!(f, "{entry}");
    }
}

/// 前端记录用户的跳过/拒绝决定（这些命令没有到达后端执行）。
pub fn tool_audit(state: &AppState, p: &Value) -> Value {
    audit(
        state,
        json!({
            "ts": now_ms(),
            "sessionId": p["sessionId"],
            "host": p["host"],
            "cmd": p["cmd"],
            "tier": p["tier"],
            "decision": p["decision"],
            "reason": p["reason"],
        }),
    );
    json!(null)
}

struct Ctx<'a> {
    state: &'a AppState,
    app: &'a tauri::AppHandle,
    sid: String,
    epoch: u64,
    label: String,
    run_id: String,
    abort: Arc<AtomicBool>,
}

/// 主机级 AI 策略：default / manual（只允许手动）/ deny（禁止 AI 访问）。
fn ai_access(state: &AppState, host: &Value) -> String {
    let Some(id) = host["id"].as_str() else {
        return "default".to_string();
    };
    let data = state.store.data.lock().unwrap();
    data["hosts"]
        .as_array()
        .and_then(|hs| hs.iter().find(|h| h["id"] == id))
        .and_then(|h| h["aiAccess"].as_str())
        .unwrap_or("default")
        .to_string()
}

pub async fn tool_exec(app: &tauri::AppHandle, state: &AppState, p: &Value) -> Value {
    let sid = p["sessionId"].as_str().unwrap_or("").to_string();
    let session = state.ssh.sessions.lock().await.get(&sid).cloned();
    let Some(session) = session.filter(|s| s.alive.load(Ordering::Relaxed)) else {
        return err("session_gone", "主机未连接（会话已断开），请先重新连接");
    };
    let access = ai_access(state, &session.host);
    if access == "deny" {
        return err("host_denied", "该主机设置为禁止 AI 访问");
    }
    let label = session.host["name"]
        .as_str()
        .filter(|s| !s.is_empty())
        .or_else(|| session.host["host"].as_str())
        .unwrap_or("")
        .to_string();
    let run_id = p["toolRunId"].as_str().unwrap_or("").to_string();
    let guard = RunGuard::new(&run_id);
    let ctx = Ctx {
        state,
        app,
        sid,
        epoch: session.epoch,
        label,
        run_id,
        abort: guard.flag.clone(),
    };
    let args = &p["args"];
    match p["tool"].as_str().unwrap_or("") {
        "host_info" => {
            let info = hostinfo::get(state, &ctx.sid, ctx.epoch, args["refresh"] == true).await;
            json!({ "status": "done", "output": hostinfo::summary(&info), "meta": info })
        }
        "read_file" | "list_dir" | "file_size" => {
            sftp_tool(&ctx, p["tool"].as_str().unwrap(), args).await
        }
        "tail_file" | "search_file" | "read_journal" => {
            command_tool(&ctx, p["tool"].as_str().unwrap(), args).await
        }
        "exec" => {
            let manual = access == "manual" || p["mode"].as_str() != Some("auto");
            let confirmed_tier = p["confirmed"]
                .as_bool()
                .unwrap_or(false)
                .then(|| serde_json::from_value::<Tier>(p["confirmedTier"].clone()).ok())
                .flatten();
            // 「使用已保存的登录密码」：明文只在后端会话里，不经前端往返。
            let password = if p["useSavedPassword"] == true {
                match session.host["password"].as_str().filter(|s| !s.is_empty()) {
                    Some(pw) => Some(pw.to_string()),
                    None => {
                        return json!({ "status": "needs-sudo-password", "host": ctx.label, "error": "该主机没有保存登录密码" })
                    }
                }
            } else {
                p["sudoPassword"].as_str().map(str::to_string)
            };
            exec_tool(&ctx, args, manual, confirmed_tier, password.as_deref()).await
        }
        other => err("unsupported", format!("未知工具：{other}")),
    }
}

fn path_error(e: PathError) -> Value {
    match e {
        PathError::Denied(p) => err(
            "path_denied",
            format!("{p} 属于密钥/凭据类敏感文件，AI 工具不允许读取"),
        ),
        PathError::Missing(p) => err("not_found", format!("文件或目录不存在：{p}")),
        PathError::Failed(m) => err("failed", m),
    }
}

async fn sftp_tool(ctx: &Ctx<'_>, tool: &str, args: &Value) -> Value {
    let sftp = match ctx.state.ssh.open_sftp(&ctx.sid).await {
        Ok(s) => s,
        Err(e) => return err("failed", format!("无法打开 SFTP 通道：{e}")),
    };
    let real = match files::resolve(&sftp, args["path"].as_str().unwrap_or("")).await {
        Ok(r) => r,
        Err(e) => return path_error(e),
    };
    let res = match tool {
        "read_file" => {
            let offset = args["offset"].as_u64().unwrap_or(0);
            let length = args["length"].as_u64().unwrap_or(files::READ_MAX as u64) as usize;
            files::read_file(&sftp, &real, offset, length).await
        }
        "list_dir" => files::list_dir(&sftp, &real).await,
        _ => files::file_size(&sftp, &real).await,
    };
    match res {
        Ok(v) => {
            let (output, _) = run::finalize(v["content"].as_str().unwrap_or(""), None);
            json!({ "status": "done", "output": output, "meta": v["meta"] })
        }
        Err(e) if e.contains("Permission denied") || e.contains("PermissionDenied") => err(
            "failed",
            format!("没有权限读取 {real}；如确需读取，可用 exec 配合 sudo（需用户确认）"),
        ),
        Err(e) => err("failed", e),
    }
}

fn clamp(v: &Value, default: u64, max: u64) -> u64 {
    v.as_u64().unwrap_or(default).clamp(1, max)
}

pub(super) fn tail_cmd(real: &str, lines: u64, gz: bool) -> String {
    let p = crate::ai_exec_guard::shell_quote(real);
    if gz {
        format!("gzip -dc -- {p} | tail -n {lines}")
    } else {
        format!("tail -n {lines} -- {p}")
    }
}

pub(super) fn search_cmd(real: &str, args: &Value, gz: bool) -> String {
    let q = crate::ai_exec_guard::shell_quote;
    let mut flags = vec!["-n".to_string()];
    flags.push(if args["regex"] == true { "-E" } else { "-F" }.to_string());
    if args["ignoreCase"] == true {
        flags.push("-i".to_string());
    }
    let context = args["context"].as_u64().unwrap_or(0).min(5);
    if context > 0 {
        flags.push(format!("-C {context}"));
    }
    flags.push(format!("-m {}", clamp(&args["maxMatches"], 200, 200)));
    let flags = flags.join(" ");
    let pat = q(args["pattern"].as_str().unwrap_or(""));
    if gz {
        format!("gzip -dc -- {} | grep {flags} -e {pat}", q(real))
    } else {
        format!("grep {flags} -e {pat} -- {}", q(real))
    }
}

pub(super) fn journal_cmd(args: &Value) -> String {
    let q = crate::ai_exec_guard::shell_quote;
    let lines = clamp(&args["lines"], 200, 500);
    let mut c = "journalctl --no-pager -o short-iso".to_string();
    for (key, flag) in [("unit", "-u"), ("since", "--since"), ("priority", "-p")] {
        if let Some(v) = args[key].as_str().filter(|s| !s.trim().is_empty()) {
            c.push_str(&format!(" {flag} {}", q(v.trim())));
        }
    }
    match args["grep"].as_str().filter(|s| !s.is_empty()) {
        // 老版本 journalctl 没有 -g：取最近一段再交给 grep 过滤。
        Some(g) => format!("{c} -n 20000 | grep -F -i -e {} | tail -n {lines}", q(g)),
        None => format!("{c} -n {lines}"),
    }
}

async fn command_tool(ctx: &Ctx<'_>, tool: &str, args: &Value) -> Value {
    let cmd = if tool == "read_journal" {
        let info = hostinfo::get(ctx.state, &ctx.sid, ctx.epoch, false).await;
        if !info.journald {
            return err(
                "unsupported",
                "该主机没有 journalctl（非 systemd 系统），请改用 tail_file 读取日志文件",
            );
        }
        journal_cmd(args)
    } else {
        let sftp = match ctx.state.ssh.open_sftp(&ctx.sid).await {
            Ok(s) => s,
            Err(e) => return err("failed", format!("无法打开 SFTP 通道：{e}")),
        };
        let real = match files::resolve(&sftp, args["path"].as_str().unwrap_or("")).await {
            Ok(r) => r,
            Err(e) => return path_error(e),
        };
        let gz = args["gz"] == true || real.ends_with(".gz");
        if tool == "tail_file" {
            tail_cmd(&real, clamp(&args["lines"], 200, 500), gz)
        } else {
            if args["pattern"].as_str().unwrap_or("").is_empty() {
                return err("invalid", "缺少搜索内容 pattern");
            }
            search_cmd(&real, args, gz)
        }
    };
    let res = run::run(
        ctx.state,
        ctx.app,
        RunSpec {
            sid: &ctx.sid,
            cmd: &cmd,
            cwd: "",
            sudo_password: None,
            idle: Duration::from_secs(30),
            hard: Duration::from_secs(60),
            ui_run_id: None,
            abort: Some(&ctx.abort),
            head_cap: 16 * 1024,
            tail_cap: 48 * 1024,
        },
    )
    .await;
    match res {
        Ok(r) if r.end == RunEnd::Exited => {
            let output =
                if tool == "search_file" && r.exit_code == Some(1) && r.output.trim().is_empty() {
                    "（无匹配）".to_string()
                } else {
                    r.output
                };
            json!({ "status": "done", "exitCode": r.exit_code, "output": output, "truncated": r.truncated, "originalBytes": r.total_bytes })
        }
        Ok(r) if r.end == RunEnd::Aborted => json!({ "status": "aborted", "output": r.output }),
        Ok(r) => {
            json!({ "status": "error", "code": "timeout", "message": "读取超时", "output": r.output })
        }
        Err(e) => err("failed", e),
    }
}

/// 写入目标中已存在的普通文件（`[ -f ]`，目录不算）。
async fn existing_files(ctx: &Ctx<'_>, cwd: &str, targets: &[String]) -> Vec<String> {
    let quoted: Vec<String> = targets
        .iter()
        .map(|t| match t.strip_prefix("~/") {
            Some(rest) => format!("~/{}", crate::ai_exec_guard::shell_quote(rest)),
            None => crate::ai_exec_guard::shell_quote(t),
        })
        .collect();
    let script = format!(
        "{}for f in {}; do [ -f \"$f\" ] && printf '%s\\n' \"$f\"; done; true",
        if cwd.is_empty() {
            String::new()
        } else {
            format!(
                "cd -- {} 2>/dev/null; ",
                crate::ai_exec_guard::shell_quote(cwd)
            )
        },
        quoted.join(" ")
    );
    match run::quick(ctx.state, &ctx.sid, &script, None, Duration::from_secs(10)).await {
        Ok((_, out)) => out
            .lines()
            .map(str::trim)
            .filter(|l| !l.is_empty())
            .map(str::to_string)
            .collect(),
        // 查不了就当作会覆盖：宁可多一次确认。
        Err(_) => targets.to_vec(),
    }
}

async fn preview(ctx: &Ctx<'_>, cmd: &str, cwd: &str) -> Value {
    let Some(pc) = preview_command(cmd) else {
        return Value::Null;
    };
    let res = run::run(
        ctx.state,
        ctx.app,
        RunSpec {
            sid: &ctx.sid,
            cmd: &pc,
            cwd,
            sudo_password: None,
            idle: Duration::from_secs(15),
            hard: Duration::from_secs(20),
            ui_run_id: None,
            abort: Some(&ctx.abort),
            head_cap: 6 * 1024,
            tail_cap: 2 * 1024,
        },
    )
    .await;
    match res {
        Ok(r) if r.end == RunEnd::Exited => json!({ "command": pc, "output": r.output }),
        _ => json!({ "command": pc, "output": "（预览超时，未能列出影响范围）" }),
    }
}

async fn exec_tool(
    ctx: &Ctx<'_>,
    args: &Value,
    manual: bool,
    confirmed_tier: Option<Tier>,
    sudo_password: Option<&str>,
) -> Value {
    let cmd = args["cmd"].as_str().unwrap_or("").trim().to_string();
    if cmd.is_empty() {
        return err("invalid", "缺少要执行的命令");
    }
    let info = hostinfo::get(ctx.state, &ctx.sid, ctx.epoch, false).await;
    let cwd = match args["cwd"].as_str().filter(|s| !s.trim().is_empty()) {
        Some(c) => c.trim().to_string(),
        None => hostinfo::cwd(ctx.state, &ctx.sid).await,
    };
    let mut verdict = classify(
        &cmd,
        &GuardCtx {
            os_known: info.os_known,
            is_root: info.is_root,
        },
    );
    if verdict.tier < Tier::Danger && !verdict.redirect_targets.is_empty() {
        for f in existing_files(ctx, &cwd, &verdict.redirect_targets).await {
            verdict.add(Tier::Danger, &format!("{R_OVERWRITE_EXISTING}：{f}"));
        }
    }
    let needs = manual || verdict.force_confirm || verdict.tier > Tier::Normal;
    let accepted = confirmed_tier.is_some_and(|t| t >= verdict.tier);
    if needs && !accepted {
        let preview = if verdict.tier == Tier::Danger {
            preview(ctx, &cmd, &cwd).await
        } else {
            Value::Null
        };
        return json!({
            "status": "needs-confirm",
            "cmd": cmd,
            "tier": verdict.tier,
            "reasons": verdict.reasons,
            "preview": preview,
            "asRoot": verdict.as_root,
            "forceConfirm": verdict.force_confirm,
            "cwd": cwd,
            "host": ctx.label,
        });
    }

    let mut password = None;
    if !info.is_root && mentions_sudo(&cmd) {
        match sudo_password.filter(|s| !s.is_empty()) {
            Some(pw) => {
                if !info.askpass {
                    return err(
                        "unsupported",
                        "远端缺少 printenv，无法托管 sudo 密码；请在终端里手动执行该命令",
                    );
                }
                let check = run::quick(
                    ctx.state,
                    &ctx.sid,
                    "sudo -k true",
                    Some(pw),
                    Duration::from_secs(15),
                )
                .await;
                if !matches!(check, Ok((Some(0), _))) {
                    return json!({ "status": "needs-sudo-password", "host": ctx.label, "error": "sudo 密码不正确" });
                }
                password = Some(pw);
            }
            None => {
                let probe = run::quick(
                    ctx.state,
                    &ctx.sid,
                    "sudo -n true",
                    None,
                    Duration::from_secs(10),
                )
                .await;
                if let Ok((code, out)) = probe {
                    let lower = out.to_ascii_lowercase();
                    if code != Some(0) && (lower.contains("password") || lower.contains("terminal"))
                    {
                        return json!({ "status": "needs-sudo-password", "host": ctx.label });
                    }
                }
            }
        }
    }

    let idle = clamp(&args["idleTimeout"], 120, 600);
    let res = run::run(
        ctx.state,
        ctx.app,
        RunSpec {
            sid: &ctx.sid,
            cmd: &cmd,
            cwd: &cwd,
            sudo_password: password,
            idle: Duration::from_secs(idle),
            hard: Duration::from_secs(30 * 60),
            ui_run_id: (!ctx.run_id.is_empty()).then_some(ctx.run_id.as_str()),
            abort: Some(&ctx.abort),
            head_cap: 8 * 1024,
            tail_cap: 24 * 1024,
        },
    )
    .await;
    let decision = if accepted { "confirmed" } else { "auto" };
    let r = match res {
        Ok(r) => r,
        Err(e) => return err("failed", e),
    };
    let end = match r.end {
        RunEnd::Exited => "exited",
        RunEnd::Aborted => "aborted",
        RunEnd::IdleTimeout | RunEnd::HardTimeout => "timeout",
    };
    audit(
        ctx.state,
        json!({
            "ts": now_ms(), "host": ctx.label, "user": info.user, "sessionId": ctx.sid,
            "cmd": cmd, "cwd": cwd, "tier": verdict.tier, "mode": if manual { "manual" } else { "auto" },
            "decision": decision, "end": end, "exitCode": r.exit_code, "durationMs": r.duration_ms,
        }),
    );
    let code = r.exit_code.map_or("—".to_string(), |c| c.to_string());
    crate::commands::record_session_event(
        ctx.app,
        &ctx.sid,
        &format!("AI 执行：{cmd}（退出码 {code}）"),
    );
    let base = json!({
        "cmd": cmd, "tier": verdict.tier, "decision": decision, "exitCode": r.exit_code, "signal": r.signal,
        "output": r.output, "truncated": r.truncated, "originalBytes": r.total_bytes, "durationMs": r.duration_ms,
    });
    let mut out = base;
    match r.end {
        RunEnd::Exited => out["status"] = json!("done"),
        RunEnd::Aborted => {
            out["status"] = json!("aborted");
            let pm = ["apt", "apt-get", "dpkg", "yum", "dnf", "rpm", "zypper"];
            if cmd.split_whitespace().any(|w| pm.contains(&w)) {
                out["note"] = json!("包管理器被中途终止，可能留下未完成的安装；可先执行 dpkg --configure -a（Debian/Ubuntu）或检查包管理器锁再继续");
            }
        }
        RunEnd::IdleTimeout => {
            out["status"] = json!("error");
            out["code"] = json!("timeout");
            out["message"] = json!(format!("命令 {idle} 秒没有任何输出，已终止"));
        }
        RunEnd::HardTimeout => {
            out["status"] = json!("error");
            out["code"] = json!("timeout");
            out["message"] = json!("命令运行超过 30 分钟，已终止");
        }
    }
    out
}
