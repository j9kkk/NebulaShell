// IPC 统一分发:channel → 处理器,返回 {ok, data|error} 信封(与 Electron 版 IPC 契约一致)
use crate::config::Store;
use crate::forward::ForwardService;
use crate::ssh::SshService;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use tauri::Manager;

use crate::session_log::LogEntry;
use std::sync::atomic::{AtomicBool, Ordering};

/// Command-side setup must be serialized with disconnect, not just SSH publication.
/// Weak entries keep closed session IDs from accumulating in the lifecycle registry.
#[derive(Default)]
struct ConnectionLifecycle {
    current: Mutex<Option<Arc<AtomicBool>>>,
    activation: tokio::sync::Mutex<()>,
}

impl ConnectionLifecycle {
    fn begin(&self) -> Arc<AtomicBool> {
        let token = Arc::new(AtomicBool::new(false));
        if let Some(previous) = self.current.lock().unwrap().replace(token.clone()) {
            previous.store(true, Ordering::Release);
        }
        token
    }

    fn cancel(&self) {
        if let Some(token) = self.current.lock().unwrap().as_ref() {
            token.store(true, Ordering::Release);
        }
    }
}

type AbortRegistry = Arc<Mutex<HashMap<String, Arc<AtomicBool>>>>;

struct RequestRegistration {
    registry: AbortRegistry,
    id: String,
    flag: Arc<AtomicBool>,
}

impl RequestRegistration {
    fn new(registry: AbortRegistry, id: String, duplicate_error: &str) -> Result<Self, String> {
        let flag = Arc::new(AtomicBool::new(false));
        {
            let mut requests = registry.lock().unwrap();
            if requests.contains_key(&id) {
                return Err(duplicate_error.to_string());
            }
            requests.insert(id.clone(), flag.clone());
        }
        Ok(Self { registry, id, flag })
    }
}

impl Drop for RequestRegistration {
    fn drop(&mut self) {
        self.flag.store(true, Ordering::Release);
        let mut requests = self.registry.lock().unwrap();
        if requests
            .get(&self.id)
            .is_some_and(|flag| Arc::ptr_eq(flag, &self.flag))
        {
            requests.remove(&self.id);
        }
    }
}

pub fn record_session_log<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    sid: &str,
    data: &str,
    input: bool,
) {
    let Some(state) = app.try_state::<AppState>() else {
        return;
    };
    let entry = state.logs.lock().unwrap().get(sid).cloned();
    if let Some(entry) = entry {
        if let Err(message) = entry.record(data, input) {
            let current = state
                .logs
                .lock()
                .unwrap()
                .get(sid)
                .is_some_and(|current| Arc::ptr_eq(current, &entry));
            if current {
                crate::ai::emit_evt(
                    app,
                    "log:error",
                    json!({ "sessionId": sid, "file": entry.file.to_string_lossy(), "message": message }),
                );
            }
        }
    }
}

pub struct AppState {
    pub store: Arc<Store>,
    pub ssh: Arc<SshService>,
    pub forwards: ForwardService,
    pub transfers: Arc<crate::transfer::TransferManager>,
    /// 上传/下载按 taskId 的取消标记(任务中心可取消在途传输)
    pub transfer_aborts: AbortRegistry,
    /// 「强制退出」标记:窗口关闭请求被传输任务拦截后,用户确认退出即置位
    pub force_exit: AtomicBool,
    pub monitors: Mutex<HashMap<String, tauri::async_runtime::JoinHandle<()>>>,
    pub logs: Mutex<HashMap<String, Arc<LogEntry>>>,
    pub ai_aborts: Arc<Mutex<HashMap<String, Arc<std::sync::atomic::AtomicBool>>>>,
    pub batch_aborts: Arc<Mutex<HashMap<String, Arc<std::sync::atomic::AtomicBool>>>>,
    pub test_results: Arc<Mutex<HashMap<String, String>>>,
    pub test_mode: bool,
}

impl AppState {
    fn connection_lifecycle(&self, sid: &str) -> Arc<ConnectionLifecycle> {
        type Lifecycles = Mutex<HashMap<(usize, String), std::sync::Weak<ConnectionLifecycle>>>;
        static LIFECYCLES: std::sync::OnceLock<Lifecycles> = std::sync::OnceLock::new();
        let key = (Arc::as_ptr(&self.ssh) as usize, sid.to_string());
        let mut lifecycles = LIFECYCLES.get_or_init(Mutex::default).lock().unwrap();
        lifecycles.retain(|_, lifecycle| lifecycle.strong_count() > 0);
        if let Some(lifecycle) = lifecycles.get(&key).and_then(std::sync::Weak::upgrade) {
            return lifecycle;
        }
        let lifecycle = Arc::new(ConnectionLifecycle::default());
        lifecycles.insert(key, Arc::downgrade(&lifecycle));
        lifecycle
    }
}

fn ok(data: Value) -> Result<Value, String> {
    Ok(json!({ "ok": true, "data": data }))
}

fn err_msg(e: impl std::fmt::Display) -> Result<Value, String> {
    Ok(json!({ "ok": false, "error": e.to_string() }))
}

fn uid() -> String {
    uuid::Uuid::new_v4().to_string()
}

pub async fn notify(app: &tauri::AppHandle, title: &str, body: &str) {
    if let Some(win) = app.get_webview_window("main") {
        // 使用原生通知的轻量途径:macOS 通知中心
        let script = format!(
            "new Notification({}, {});",
            serde_json::to_string(title).unwrap_or_default(),
            serde_json::to_string(body).unwrap_or_default()
        );
        win.eval(&script).ok();
    }
}

pub async fn nebula_invoke(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    channel: String,
    payload: Value,
) -> Result<Value, String> {
    let payload = if payload.is_null() {
        json!({})
    } else {
        payload
    };
    match channel.as_str() {
        // 版本取自 Cargo.toml(编译期常量),避免与 manifest 手写值漂移
        "app:info" => ok(json!({
            "version": env!("CARGO_PKG_VERSION"),
            "platform": std::env::consts::OS
        })),

        "app:openExternal" => {
            let url = payload["url"].as_str().unwrap_or("");
            let allow = regex_lite(url);
            if !allow {
                return err_msg(format!("不允许打开外部链接: {}", url));
            }
            #[cfg(target_os = "macos")]
            {
                let _ = std::process::Command::new("open").arg(url).spawn();
            }
            #[cfg(target_os = "windows")]
            {
                let _ = std::process::Command::new("cmd")
                    .args(["/C", "start", "", url])
                    .spawn();
            }
            #[cfg(target_os = "linux")]
            {
                let _ = std::process::Command::new("xdg-open").arg(url).spawn();
            }
            ok(json!(null))
        }

        "hosts:list" => ok(json!(state.store.list_hosts())),
        "hosts:save" => match state.store.save_host(&payload) {
            Ok(h) => ok(h),
            Err(e) => err_msg(e),
        },
        "hosts:delete" => match state
            .store
            .delete_host(payload["id"].as_str().unwrap_or(""))
        {
            Ok(n) => ok(json!(n)),
            Err(e) => err_msg(e),
        },
        "hosts:clone" => match state.store.clone_host(payload["id"].as_str().unwrap_or("")) {
            Ok(h) => ok(h),
            Err(e) => err_msg(e),
        },
        "hosts:exportFile" => {
            // includeCredentials 为真时必须带 passphrase,由 Store 用 scrypt+AES-GCM 加密;
            // 否则导出文件不含任何凭据(明文密码落盘后很难收回)。
            let pass: Option<String> = if payload["includeCredentials"].as_bool().unwrap_or(false) {
                match payload["passphrase"].as_str() {
                    Some(p) if !p.trim().is_empty() => Some(p.to_string()),
                    _ => return err_msg("请设置导出加密口令"),
                }
            } else {
                None
            };
            let data = match state.store.export_hosts(pass.as_deref()) {
                Ok(d) => d,
                Err(e) => return err_msg(e),
            };
            if state.test_mode {
                if let Ok(p) = std::env::var("NEBULA_TEST_SAVE_PATH") {
                    std::fs::write(&p, serde_json::to_string_pretty(&data).unwrap_or_default())
                        .ok();
                    return ok(
                        json!({ "path": p, "count": data["hosts"].as_array().map(|a| a.len()).unwrap_or(0) }),
                    );
                }
            }
            let file = rfd::AsyncFileDialog::new()
                .set_file_name("nebulashell-hosts.json")
                .save_file()
                .await;
            match file {
                Some(f) => {
                    let path = f.path().to_string_lossy().to_string();
                    std::fs::write(
                        &path,
                        serde_json::to_string_pretty(&data).unwrap_or_default(),
                    )
                    .map_err(|e| e.to_string())?;
                    ok(
                        json!({ "path": path, "count": data["hosts"].as_array().map(|a| a.len()).unwrap_or(0) }),
                    )
                }
                None => ok(json!(null)),
            }
        }
        "hosts:importFile" => {
            // 允许复用已选路径:文件含加密凭据时,前端需要二次调用并带上口令,
            // 不能要求用户重选一次文件。
            let preset = payload["path"].as_str().filter(|s| !s.is_empty());
            let path = match preset {
                Some(p) => Some(p.to_string()),
                // 测试模式:优先用专用的导入路径变量,避免与 SFTP 选文件的
                // NEBULA_TEST_PICK_PATHS 抢同一个值(两者会同时出现在 e2e 里)。
                None if state.test_mode => std::env::var("NEBULA_TEST_IMPORT_PATH")
                    .ok()
                    .or_else(|| std::env::var("NEBULA_TEST_PICK_PATHS").ok()),
                None => rfd::AsyncFileDialog::new()
                    .pick_file()
                    .await
                    .map(|f| f.path().to_string_lossy().to_string()),
            };
            match path {
                Some(p) => match std::fs::read_to_string(&p) {
                    Ok(text) => {
                        let pass = payload["passphrase"].as_str().filter(|s| !s.is_empty());
                        // 文件带凭据但未给口令:先回一个信号让前端弹口令框,
                        // 不要把"需要口令"当成错误(前端 api() 会把错误当失败抛掉)。
                        if pass.is_none() && file_has_credentials(&text) {
                            return ok(json!({ "needsPassphrase": true, "path": p }));
                        }
                        match state.store.import_hosts(&text, pass) {
                            Ok(r) => ok(json!({
                                "path": p, "added": r["added"], "skipped": r["skipped"],
                                "withCredentials": r["withCredentials"],
                                "updated": r["updated"], "credentialsFilled": r["credentialsFilled"],
                                "legacyPlaintext": r["legacyPlaintext"],
                            })),
                            Err(e) => err_msg(e),
                        }
                    }
                    Err(e) => err_msg(e),
                },
                None => ok(json!(null)),
            }
        }

        "ssh:connect" | "ssh:connectQuick" => {
            let host = if channel == "ssh:connect" {
                match state
                    .store
                    .host_full(payload["hostId"].as_str().unwrap_or(""))
                {
                    Ok(h) => h,
                    Err(e) => return err_msg(e),
                }
            } else {
                payload["host"].clone()
            };
            let session_id = payload["sessionId"]
                .as_str()
                .map(String::from)
                .unwrap_or_else(uid);
            let lifecycle = state.connection_lifecycle(&session_id);
            let token = {
                let _activation = lifecycle.activation.lock().await;
                lifecycle.begin()
            };
            let result = tokio::select! {
                biased;
                _ = wait_for_cancel(&token) => Err("连接已取消".to_string()),
                result = state.ssh.connect(app.clone(), host, session_id.clone()) => result,
            };
            let _activation = lifecycle.activation.lock().await;
            // Cancellation is not a connection failure. A stale invoke error must not
            // make the frontend overwrite the status of a newer connection generation.
            if token.load(Ordering::Acquire) {
                return ok(json!({ "sessionId": session_id, "cancelled": true }));
            }
            match result {
                Ok(_) => {
                    let session = state.ssh.sessions.lock().await.get(&session_id).cloned();
                    let Some(session) = session.filter(|session| {
                        !token.load(Ordering::Acquire) && session.alive.load(Ordering::Acquire)
                    }) else {
                        return ok(json!({ "sessionId": session_id, "cancelled": true }));
                    };
                    // 监控任务随连接启动(批量会话除外)
                    if !session_id.starts_with("batch-") {
                        state.start_monitor(&app, &session_id);
                        // 清理台账:该主机上可能还挂着上次传输任务的临时文件
                        state
                            .transfers
                            .clone()
                            .on_session_connected(session_id.clone());
                        // 后台预热 SFTP 通道:把 channel_open + 子系统协商 + INIT
                        // 的往返挪出文件面板首次列目录的关键路径。失败静默
                        //(服务器禁 sftp 子系统不影响终端连接);与首个
                        // sftp:list 的并发由 open_sftp 的按会话协商锁去重。
                        {
                            let ssh = state.ssh.clone();
                            let sid = session_id.clone();
                            tokio::spawn(async move {
                                let _ = ssh.open_sftp(&sid).await;
                            });
                        }
                        let rules: Vec<Value> = {
                            let data = state.store.data.lock().unwrap();
                            data["forwards"].as_array().cloned().unwrap_or_default()
                        };
                        let host_id = session.host["id"].as_str().unwrap_or("");
                        for rule in rules {
                            if token.load(Ordering::Acquire)
                                || !session.alive.load(Ordering::Acquire)
                            {
                                break;
                            }
                            if rule["autoStart"].as_bool().unwrap_or(false)
                                && rule["hostId"].as_str() == Some(host_id)
                            {
                                tokio::select! {
                                    biased;
                                    _ = wait_for_cancel(&token) => break,
                                    _ = state.forwards.start(app.clone(), state.ssh.clone(), &rule) => {},
                                }
                            }
                        }
                        // Disconnect may have arrived while an async forward was
                        // binding. It takes the same activation lock before cleanup.
                        if token.load(Ordering::Acquire) || !session.alive.load(Ordering::Acquire) {
                            state.stop_monitor(&session_id);
                            state
                                .forwards
                                .stop_by_session(&app, state.ssh.clone(), &session_id);
                            return ok(json!({ "sessionId": session_id, "cancelled": true }));
                        }
                    }
                    ok(json!({ "sessionId": session_id }))
                }
                Err(e) if e == "连接已取消" => {
                    ok(json!({ "sessionId": session_id, "cancelled": true }))
                }
                Err(e) => err_msg(e),
            }
        }
        "ssh:write" => match state
            .ssh
            .write(
                payload["sessionId"].as_str().unwrap_or(""),
                payload["data"].as_str().unwrap_or(""),
            )
            .await
        {
            Ok(_) => {
                record_session_log(
                    &app,
                    payload["sessionId"].as_str().unwrap_or(""),
                    payload["data"].as_str().unwrap_or(""),
                    true,
                );
                ok(json!(null))
            }
            Err(e) => err_msg(e),
        },
        "ssh:setReadonly" => {
            let sid = payload["sessionId"].as_str().unwrap_or("");
            match state
                .ssh
                .set_readonly(sid, payload["readOnly"].as_bool().unwrap_or(false))
                .await
            {
                Ok(_) => ok(json!(null)),
                Err(e) => err_msg(e),
            }
        }
        "ssh:resize" => match state
            .ssh
            .resize(
                payload["sessionId"].as_str().unwrap_or(""),
                payload["cols"].as_u64().unwrap_or(100) as u32,
                payload["rows"].as_u64().unwrap_or(30) as u32,
            )
            .await
        {
            Ok(_) => ok(json!(null)),
            Err(e) => err_msg(e),
        },
        "ssh:disconnect" => {
            let sid = payload["sessionId"].as_str().unwrap_or("").to_string();
            let lifecycle = state.connection_lifecycle(&sid);
            lifecycle.cancel();
            let _activation = lifecycle.activation.lock().await;
            state.ssh.disconnect(&sid).await;
            state.stop_monitor(&sid);
            state
                .forwards
                .stop_by_session(&app, state.ssh.clone(), &sid);
            ok(json!(null))
        }

        "sftp:list" => {
            sftp_op(
                &state,
                app.clone(),
                &payload,
                |sftp, _app, _sid, p| async move {
                    crate::sftp::list(&sftp, p["path"].as_str().map(String::from)).await
                },
            )
            .await
        }
        "sftp:mkdir" => {
            sftp_op(
                &state,
                app.clone(),
                &payload,
                |sftp, _app, _sid, p| async move {
                    crate::sftp::mkdir(&sftp, p["path"].as_str().unwrap_or(""))
                        .await
                        .map(|_| json!(null))
                },
            )
            .await
        }
        "sftp:remove" => {
            sftp_op(
                &state,
                app.clone(),
                &payload,
                |sftp, _app, _sid, p| async move {
                    crate::sftp::remove(
                        &sftp,
                        p["path"].as_str().unwrap_or(""),
                        p["isDir"].as_bool().unwrap_or(false),
                    )
                    .await
                    .map(|_| json!(null))
                },
            )
            .await
        }
        "sftp:rename" => {
            sftp_op(
                &state,
                app.clone(),
                &payload,
                |sftp, _app, _sid, p| async move {
                    crate::sftp::rename(
                        &sftp,
                        p["from"].as_str().unwrap_or(""),
                        p["to"].as_str().unwrap_or(""),
                    )
                    .await
                    .map(|_| json!(null))
                },
            )
            .await
        }
        "sftp:chmod" => {
            sftp_op(
                &state,
                app.clone(),
                &payload,
                |sftp, _app, _sid, p| async move {
                    crate::sftp::chmod(
                        &sftp,
                        p["path"].as_str().unwrap_or(""),
                        p["mode"].as_u64().unwrap_or(0o644) as u32,
                    )
                    .await
                    .map(|_| json!(null))
                },
            )
            .await
        }
        "sftp:upload" => {
            // taskId 存在时登记取消标记:任务中心的「取消」在数据块间生效;
            // Registration 存活到上传结束,重复 taskId 的并发提交会被拒绝。
            let reg = match payload["taskId"].as_str() {
                Some(id) if !id.is_empty() => Some(RequestRegistration::new(
                    state.transfer_aborts.clone(),
                    id.to_string(),
                    "任务正在执行",
                )?),
                _ => None,
            };
            let cancel = reg.as_ref().map(|r| r.flag.clone());
            let cancel_c = cancel.clone();
            let r = sftp_op(&state, app.clone(), &payload, |sftp, app, sid, p| {
                let cancel = cancel_c.clone();
                async move {
                    crate::sftp::upload_with_policy(
                        &sftp,
                        app,
                        sid,
                        p["localPath"].as_str().unwrap_or(""),
                        p["remoteDir"].as_str().unwrap_or(""),
                        p["remoteName"].as_str(),
                        p["conflictPolicy"].as_str().unwrap_or("error"),
                        p["taskId"].as_str(),
                        cancel,
                    )
                    .await
                }
            })
            .await;
            drop(reg);
            r
        }
        "sftp:download" => {
            let reg = match payload["taskId"].as_str() {
                Some(id) if !id.is_empty() => Some(RequestRegistration::new(
                    state.transfer_aborts.clone(),
                    id.to_string(),
                    "任务正在执行",
                )?),
                _ => None,
            };
            let cancel = reg.as_ref().map(|r| r.flag.clone());
            let cancel_c = cancel.clone();
            let r = sftp_op(&state, app.clone(), &payload, |sftp, app, sid, p| {
                let cancel = cancel_c.clone();
                async move {
                    crate::sftp::download(
                        sftp.clone(),
                        app,
                        sid,
                        p["remotePath"].as_str().unwrap_or(""),
                        p["localPath"].as_str().unwrap_or(""),
                        "download",
                        p["taskId"].as_str(),
                        cancel,
                    )
                    .await
                }
            })
            .await;
            drop(reg);
            r
        }
        // 目录/批量递归下载:编排与字节都在后端,进度经 sftp:progress 归属任务
        "sftp:downloadTree" => {
            let reg = match payload["taskId"].as_str() {
                Some(id) if !id.is_empty() => Some(RequestRegistration::new(
                    state.transfer_aborts.clone(),
                    id.to_string(),
                    "任务正在执行",
                )?),
                _ => None,
            };
            let cancel = reg.as_ref().map(|r| r.flag.clone());
            let cancel_c = cancel.clone();
            let r = sftp_op(&state, app.clone(), &payload, |sftp, app, sid, p| {
                let cancel = cancel_c.clone();
                async move {
                    crate::sftp::download_tree(
                        &sftp,
                        app,
                        sid,
                        p["remotePath"].as_str().unwrap_or(""),
                        p["localPath"].as_str().unwrap_or(""),
                        p["taskId"].as_str(),
                        cancel,
                    )
                    .await
                }
            })
            .await;
            drop(reg);
            r
        }
        // 双击「打开」:下载到临时目录后交系统默认程序(test_mode 只落盘不拉起)
        "sftp:openRemote" => {
            let test_mode = state.test_mode;
            // 打开前读一次设置(data 锁只握到返回,不跨网络/IO)
            let temp_root = state.store.open_temp_dir();
            sftp_op(&state, app.clone(), &payload, move |sftp, app, sid, p| {
                let temp_root = temp_root.clone();
                async move {
                    crate::sftp::open_remote(
                        sftp.clone(),
                        app,
                        sid,
                        p["remotePath"].as_str().unwrap_or(""),
                        &temp_root,
                        test_mode,
                    )
                    .await
                }
            })
            .await
        }
        // 会话端点(代次 + 展示名 + 主机摘要):文件面板/传输任务锁定真实连接
        "session:endpoint" => {
            let sid = payload["sessionId"].as_str().unwrap_or("").to_string();
            match state.ssh.session_endpoint(&sid).await {
                Some(e) => ok(json!({
                    "sessionId": e.session_id, "epoch": e.epoch, "label": e.label, "summary": e.summary,
                })),
                None => ok(json!(null)),
            }
        }
        // 跨主机复制:提交即返回任务号,编排与进度在后端
        "transfer:copy" => {
            let items: Vec<String> = payload["items"]
                .as_array()
                .map(|a| {
                    a.iter()
                        .filter_map(|v| v.as_str().map(String::from))
                        .collect()
                })
                .unwrap_or_default();
            match state
                .transfers
                .submit_copy(
                    app,
                    payload["srcSessionId"].as_str().unwrap_or(""),
                    payload["srcDir"].as_str().unwrap_or(""),
                    payload["srcEpoch"].as_u64(),
                    payload["dstSessionId"].as_str().unwrap_or(""),
                    payload["dstDir"].as_str().unwrap_or(""),
                    payload["dstEpoch"].as_u64(),
                    items,
                    payload["batchId"].as_str().unwrap_or(""),
                    payload["autoRename"].as_bool().unwrap_or(false),
                )
                .await
            {
                Ok(v) => ok(v),
                Err(e) => err_msg(e),
            }
        }
        "transfer:cancel" => ok(state
            .transfers
            .cancel(payload["taskId"].as_str().unwrap_or(""))?),
        "transfer:resolve" => {
            let r = state
                .transfers
                .resolve_conflict(
                    payload["taskId"].as_str().unwrap_or(""),
                    payload["conflictId"].as_str().unwrap_or(""),
                    payload["decision"].clone(),
                )
                .await;
            ok(r?)
        }
        "transfer:list" => ok(json!(state.transfers.list())),
        "transfer:activeFor" => {
            let sids: Vec<String> = payload["sessionIds"]
                .as_array()
                .map(|a| {
                    a.iter()
                        .filter_map(|v| v.as_str().map(String::from))
                        .collect()
                })
                .unwrap_or_default();
            ok(json!(state.transfers.active_for_sessions(&sids)))
        }
        // 取消在途上传/下载(按 taskId)
        "sftp:cancel" => {
            let id = payload["taskId"].as_str().unwrap_or("");
            if id.is_empty() {
                return err_msg("缺少 taskId");
            }
            let flag = state.transfer_aborts.lock().unwrap().get(id).cloned();
            match flag {
                Some(flag) => {
                    flag.store(true, Ordering::Release);
                    ok(json!({ "ok": true }))
                }
                None => ok(json!({ "ok": false, "gone": true })),
            }
        }
        // 传输任务存在时的退出确认链路:前端确认后置 force_exit 再退
        "app:exit" => {
            state.force_exit.store(true, Ordering::SeqCst);
            app.exit(0);
            ok(json!(null))
        }

        // 文件面板首次打开的初始目录:探测交互 shell 的实时 cwd(见 ssh.rs probe_cwd)
        "ssh:probeCwd" => {
            let sid = payload["sessionId"].as_str().unwrap_or("").to_string();
            match state.ssh.probe_cwd(&sid).await {
                Ok(cwd) => ok(json!({ "cwd": cwd })),
                Err(e) => err_msg(e),
            }
        }

        "forwards:list" => {
            let data = state.store.data.lock().unwrap();
            ok(data["forwards"].clone())
        }
        "forwards:save" => {
            let mut rule = payload.clone();
            if rule["id"].as_str().unwrap_or("").is_empty() {
                rule["id"] = json!(uid());
            }
            {
                let mut data = state.store.data.lock().unwrap();
                let list = data["forwards"].as_array_mut().unwrap();
                match list.iter().position(|f| f["id"] == rule["id"]) {
                    Some(i) => list[i] = rule.clone(),
                    None => list.push(rule.clone()),
                }
            }
            state.store.save().ok();
            ok(rule)
        }
        "forwards:delete" => {
            let id = payload["id"].as_str().unwrap_or("").to_string();
            state.forwards.stop(&app, state.ssh.clone(), &id);
            {
                let mut data = state.store.data.lock().unwrap();
                data["forwards"]
                    .as_array_mut()
                    .unwrap()
                    .retain(|f| f["id"] != json!(id));
            }
            state.store.save().ok();
            ok(json!(null))
        }
        "forward:start" => match state
            .forwards
            .start(app.clone(), state.ssh.clone(), &payload)
            .await
        {
            Ok(_port) => ok(state
                .forwards
                .runtime_state(payload["id"].as_str().unwrap_or(""))),
            Err(e) => err_msg(e),
        },
        "forward:stop" => {
            state.forwards.stop(
                &app,
                state.ssh.clone(),
                payload["id"].as_str().unwrap_or(""),
            );
            ok(json!(null))
        }
        "forward:states" => {
            let ids: Vec<String> = payload["ids"]
                .as_array()
                .map(|a| {
                    a.iter()
                        .filter_map(|x| x.as_str().map(String::from))
                        .collect()
                })
                .unwrap_or_default();
            ok(state.forwards.runtime_states(&ids))
        }

        "batch:exec" => batch_exec(app.clone(), &state, &payload).await,
        "batch:exportResults" => {
            let result = export_batch_results(&payload, |default_name| async move {
                // Test hosts opt in via an environment-owned directory, never an IPC path.
                // With no directory configured, test mode cancels without showing a dialog.
                if state.test_mode {
                    return batch_test_export_path(
                        std::env::var_os("NEBULA_TEST_EXPORT_DIR"),
                        &default_name,
                    );
                }
                rfd::AsyncFileDialog::new()
                    .set_title("导出批量执行结果")
                    .add_filter("JSON", &["json"])
                    .set_file_name(&default_name)
                    .save_file()
                    .await
                    .map(|file| file.path().to_path_buf())
            })
            .await;
            match result {
                Ok(data) => ok(data),
                Err(error) => err_msg(error),
            }
        }
        "batch:cancel" => {
            if let Some(flag) = state
                .batch_aborts
                .lock()
                .unwrap()
                .get(payload["requestId"].as_str().unwrap_or(""))
            {
                flag.store(true, std::sync::atomic::Ordering::Release);
            }
            ok(json!(null))
        }

        "history:add" => {
            {
                let mut data = state.store.data.lock().unwrap();
                let cmd = payload["cmd"].as_str().unwrap_or("").trim().to_string();
                if !cmd.is_empty() {
                    let history = data["history"].as_array_mut().unwrap();
                    history.retain(|h| h["cmd"].as_str() != Some(cmd.as_str()));
                    history.push(json!({ "hostId": payload["hostId"], "host": payload["host"], "cmd": cmd, "at": chrono::Utc::now().timestamp_millis() }));
                    let len = history.len();
                    if len > 500 {
                        data["history"] = json!(history[len - 500..]);
                    }
                }
            }
            // 每敲一条命令都全量重写配置文件的代价过高(含加密凭据的整份 JSON),
            // 改为标记脏位,由后台去抖任务合并落盘。
            state.store.mark_dirty();
            ok(json!(null))
        }
        "history:list" => {
            let kw = payload["kw"].as_str().unwrap_or("").to_lowercase();
            let data = state.store.data.lock().unwrap();
            let mut list: Vec<Value> = data["history"].as_array().cloned().unwrap_or_default();
            list.reverse();
            if !kw.is_empty() {
                list.retain(|h| h["cmd"].as_str().unwrap_or("").to_lowercase().contains(&kw));
            }
            list.truncate(200);
            ok(json!(list))
        }
        "history:clear" => {
            {
                let mut data = state.store.data.lock().unwrap();
                data["history"] = json!([]);
            }
            state.store.save().ok();
            ok(json!(null))
        }

        "fingerprints:list" => {
            let data = state.store.data.lock().unwrap();
            let list: Vec<Value> = data["knownHosts"]
                .as_object()
                .map(|m| m.iter().map(|(k, v)| json!({ "id": k, "fp": v })).collect())
                .unwrap_or_default();
            ok(json!(list))
        }
        "fingerprints:delete" => {
            {
                let mut data = state.store.data.lock().unwrap();
                if let Some(m) = data["knownHosts"].as_object_mut() {
                    m.remove(payload["id"].as_str().unwrap_or(""));
                }
            }
            state.store.save().ok();
            ok(json!(null))
        }

        "bookmarks:list" => {
            let data = state.store.data.lock().unwrap();
            ok(data["bookmarks"].clone())
        }
        "bookmarks:add" => {
            {
                let mut data = state.store.data.lock().unwrap();
                let list = data["bookmarks"].as_array_mut().unwrap();
                let host_id = payload["hostId"].as_str().unwrap_or("");
                let path = payload["path"].as_str().unwrap_or("");
                if !list.iter().any(|b| {
                    b["hostId"].as_str() == Some(host_id) && b["path"].as_str() == Some(path)
                }) {
                    list.push(json!({ "hostId": host_id, "path": path, "at": chrono::Utc::now().timestamp_millis() }));
                }
            }
            state.store.save().ok();
            ok(json!(null))
        }
        "bookmarks:remove" => {
            {
                let mut data = state.store.data.lock().unwrap();
                data["bookmarks"].as_array_mut().unwrap().retain(|b| {
                    !(b["hostId"].as_str() == Some(payload["hostId"].as_str().unwrap_or(""))
                        && b["path"].as_str() == Some(payload["path"].as_str().unwrap_or("")))
                });
            }
            state.store.save().ok();
            ok(json!(null))
        }

        "log:start" => {
            let sid = payload["sessionId"].as_str().unwrap_or("").to_string();
            let dir = dirs::home_dir()
                .unwrap_or_default()
                .join("NebulaShell-logs");
            std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
            let label = payload["hostLabel"].as_str().unwrap_or("session").replace(
                |c: char| !c.is_alphanumeric() && c != '.' && c != '-' && c != '_',
                "_",
            );
            let stamp = chrono::Local::now().format("%Y-%m-%dT%H-%M-%S");
            let file = dir.join(format!("{}-{}-{}.log", label, stamp, uid()));
            let mut options = std::fs::OpenOptions::new();
            options.create_new(true).write(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.mode(0o600);
            }
            let handle = options.open(&file).map_err(|e| e.to_string())?;
            let file_str = file.to_string_lossy().to_string();
            let app_log = app.clone();
            let sid_log = sid.clone();
            let log_file = file.clone();
            let entry = match LogEntry::new(
                file,
                handle,
                payload["timestamps"].as_bool().unwrap_or(true),
                payload["recordInput"].as_bool().unwrap_or(false),
                move |message| {
                    let current = app_log.try_state::<AppState>().is_some_and(|state| {
                        state
                            .logs
                            .lock()
                            .unwrap()
                            .get(&sid_log)
                            .is_some_and(|entry| entry.file == log_file)
                    });
                    if current {
                        crate::ai::emit_evt(
                            &app_log,
                            "log:error",
                            json!({ "sessionId": sid_log, "file": log_file.to_string_lossy(), "message": message }),
                        );
                    }
                },
            ) {
                Ok(entry) => entry,
                Err(error) => return err_msg(error),
            };
            let previous = state.logs.lock().unwrap().insert(sid.clone(), entry);
            if let Some(previous) = previous {
                let previous_file = previous.file.to_string_lossy().to_string();
                let failure = match tokio::task::spawn_blocking(move || previous.stop()).await {
                    Ok(Ok(())) => None,
                    Ok(Err(error)) => Some(error),
                    Err(error) => Some(error.to_string()),
                };
                if let Some(message) = failure {
                    crate::ai::emit_evt(
                        &app,
                        "log:error",
                        json!({ "sessionId": sid, "file": previous_file, "message": message }),
                    );
                }
            }
            ok(json!({ "file": file_str }))
        }
        "log:stop" => {
            let sid = payload["sessionId"].as_str().unwrap_or("").to_string();
            let entry = state.logs.lock().unwrap().remove(&sid);
            match entry {
                Some(entry) => {
                    let file = entry.file.to_string_lossy().to_string();
                    match tokio::task::spawn_blocking(move || entry.stop()).await {
                        Ok(Ok(())) => ok(json!({ "file": file })),
                        Ok(Err(error)) => err_msg(error),
                        Err(error) => err_msg(error),
                    }
                }
                None => ok(json!({ "file": null })),
            }
        }
        "log:status" => {
            let sid = payload["sessionId"].as_str().unwrap_or("").to_string();
            let logs = state.logs.lock().unwrap();
            match logs.get(&sid) {
                Some(e) => ok(
                    json!({ "active": e.active(), "file": e.file.to_string_lossy(), "recordInput": e.record_input }),
                ),
                None => ok(json!({ "active": false, "file": null })),
            }
        }

        "plugins:info" => ok(json!({
            "points": [
                { "id": "connection.middleware", "desc": "连接建立前后的中间件(审计、跳板策略、自动命令)", "stable": false },
                { "id": "panel", "desc": "右侧面板注册(与 AI/文件/Agent 同级容器)", "stable": false },
                { "id": "ai.provider", "desc": "自定义 AI 供应商与模型发现", "stable": false },
                { "id": "command.palette", "desc": "命令面板动作注入", "stable": false },
                { "id": "snippet.source", "desc": "片段数据源", "stable": false },
                { "id": "theme", "desc": "终端配色主题(JSON 配色)", "stable": false }
            ],
            "registered": []
        })),

        "cloud:accounts" => ok(json!({
            "accounts": state.store.get_settings()["cloudAccounts"]
        })),

        "cloud:saveAccount" => {
            let r = state.store.save_cloud_account(
                payload["id"].as_str().unwrap_or(""),
                payload["label"].as_str().unwrap_or(""),
                payload["vendor"].as_str().unwrap_or("tencent"),
                payload["keyId"].as_str().unwrap_or(""),
                payload["secret"].as_str().unwrap_or(""),
                payload["endpoint"].as_str().unwrap_or(""),
            );
            match r {
                Ok(id) => ok(id),
                Err(e) => err_msg(e),
            }
        }
        "cloud:deleteAccount" => match state
            .store
            .delete_cloud_account(payload["id"].as_str().unwrap_or(""))
        {
            Ok(n) => ok(json!({ "removed": n })),
            Err(e) => err_msg(e),
        },

        // 凭据校验:保存前做一次与"拉取全部"同路径的全量只读扫描(不落库),
        // 报出的地域数/实例数即真实拉取结果;个别地域失败不阻断,附 errorCount。
        // keyId/secret 留空时回退到已保存账号的值(编辑场景无需重输密钥)。
        "cloud:testAccount" => {
            let id = payload["id"].as_str().unwrap_or("");
            let mut vendor = payload["vendor"].as_str().unwrap_or("tencent").to_string();
            let mut key = payload["keyId"].as_str().unwrap_or("").trim().to_string();
            let mut secret = payload["secret"].as_str().unwrap_or("").trim().to_string();
            let mut endpoint = payload["endpoint"]
                .as_str()
                .unwrap_or("")
                .trim()
                .to_string();
            if !id.is_empty() && (key.is_empty() || secret.is_empty()) {
                match state.store.cloud_account_creds(id) {
                    Ok((k, s, ep, v)) => {
                        if key.is_empty() {
                            key = k;
                        }
                        if secret.is_empty() {
                            secret = s;
                        }
                        if endpoint.is_empty() {
                            endpoint = ep;
                        }
                        if payload["vendor"].as_str().unwrap_or("").is_empty() {
                            vendor = v;
                        }
                    }
                    Err(e) => return err_msg(e),
                }
            }
            let r = if vendor == "aliyun" {
                crate::cloud::aliyun_probe(&key, &secret, &endpoint).await
            } else {
                crate::cloud::tencent_probe(&key, &secret, &endpoint).await
            };
            match r {
                Ok((regions, instances, services, error_count)) => ok(json!({
                    "regionCount": regions,
                    "instanceCount": instances,
                    "services": services,
                    "errorCount": error_count,
                })),
                Err(e) => err_msg(e),
            }
        }

        // 一键拉取:按账号(可多个)全区域探测并拉取实例。
        // 腾讯云一次拉 CVM+轻量;单账号/单区域失败不阻断,错误汇总返回。
        "cloud:fetchAll" => {
            let ids: Vec<String> = payload["accountIds"]
                .as_array()
                .map(|a| {
                    a.iter()
                        .filter_map(|x| x.as_str().map(String::from))
                        .collect()
                })
                .unwrap_or_default();
            if ids.is_empty() {
                return err_msg("请先添加云账号");
            }
            let mut instances: Vec<Value> = Vec::new();
            let mut errors: Vec<String> = Vec::new();
            for id in &ids {
                let (key, secret, endpoint, vendor) = match state.store.cloud_account_creds(id) {
                    Ok(c) => c,
                    Err(e) => {
                        errors.push(e);
                        continue;
                    }
                };
                let r = if vendor == "aliyun" {
                    crate::cloud::aliyun_fetch_all(&key, &secret, &endpoint).await
                } else {
                    crate::cloud::tencent_fetch_all(&key, &secret, &endpoint).await
                };
                match r {
                    Ok((mut list, mut errs)) => {
                        // 默认名 {云}-{区域}-{IP};已命名的实例保留原名
                        for it in list.iter_mut() {
                            it["cloud"]["accountId"] = json!(id);
                            if it["name"]
                                .as_str()
                                .map(|s| s.trim().is_empty())
                                .unwrap_or(true)
                            {
                                it["name"] = default_cloud_name(it);
                            }
                        }
                        instances.append(&mut list);
                        errors.append(&mut errs);
                    }
                    Err(e) => errors.push(e),
                }
            }
            ok(json!({ "instances": instances, "errors": errors }))
        }

        "cloud:fetch" => {
            let provider = payload["provider"]
                .as_str()
                .unwrap_or("tencent")
                .to_string();
            let key = payload["key"].as_str().unwrap_or("").to_string();
            let secret = payload["secret"].as_str().unwrap_or("").to_string();
            let region = payload["region"].as_str().unwrap_or("").to_string();
            let endpoint = payload["endpoint"].as_str().unwrap_or("").to_string();
            let res = if provider == "aliyun" {
                crate::cloud::aliyun_describe_instances(&key, &secret, &region, &endpoint).await
            } else {
                crate::cloud::tencent_describe_instances(
                    &key, &secret, &provider, &region, &endpoint,
                )
                .await
            };
            match res {
                Ok(list) => {
                    state
                        .store
                        .save_cloud_creds(&provider, &key, &secret, &endpoint);
                    ok(json!(list))
                }
                Err(e) => err_msg(e),
            }
        }

        "settings:get" => ok(state.store.get_settings()),
        "settings:save" => ok(state.store.save_settings(&payload)),

        "ai:models" => {
            let (saved, saved_key) = {
                let data = state.store.data.lock().unwrap();
                let saved = data["settings"]["ai"].clone();
                let key = state.store.dec(saved["apiKeyEnc"].as_str().unwrap_or(""));
                (saved, key)
            };
            let config = crate::ai::resolve_request_config(&saved, Some(&payload), &saved_key);
            match crate::ai::list_models(&config.protocol, &config.base_url, &config.api_key).await
            {
                Ok(ids) => ok(json!(ids)),
                Err(e) => err_msg(e),
            }
        }
        "ai:chat" => {
            let request_id = payload["requestId"].as_str().unwrap_or("").to_string();
            if request_id.is_empty() {
                return err_msg("缺少 AI 请求标识");
            }
            let (saved, saved_key) = {
                let data = state.store.data.lock().unwrap();
                let saved = data["settings"]["ai"].clone();
                let key = state.store.dec(saved["apiKeyEnc"].as_str().unwrap_or(""));
                (saved, key)
            };
            let config = crate::ai::resolve_request_config(
                &saved,
                payload.get("ai").filter(|value| value.is_object()),
                &saved_key,
            );
            if config.base_url.is_empty() {
                return err_msg("未配置 API Base URL,请先在 AI 设置中填写");
            }
            let registration = match RequestRegistration::new(
                state.ai_aborts.clone(),
                request_id.clone(),
                "AI 请求标识已存在",
            ) {
                Ok(registration) => registration,
                Err(error) => return err_msg(error),
            };
            let flag = registration.flag.clone();
            let request_id2 = request_id.clone();
            let app_err = app.clone();
            tokio::spawn(async move {
                // 流式任务与前端之间只有事件一条通道:Err 若在这里被吞掉,
                // 前端会永远停在"生成中…"(表现为"配置后对话无响应"),必须转成 ai:error。
                if let Err(e) = crate::ai::chat_stream(
                    app.clone(),
                    request_id2.clone(),
                    config.protocol,
                    config.base_url,
                    config.api_key,
                    config.model,
                    payload["messages"].clone(),
                    flag,
                )
                .await
                {
                    crate::ai::emit_evt(
                        &app_err,
                        "ai:error",
                        json!({ "requestId": request_id2.clone(), "message": e }),
                    );
                }
                drop(registration);
            });
            ok(json!({ "requestId": request_id }))
        }
        "ai:abort" => {
            let rid = payload["requestId"].as_str().unwrap_or("").to_string();
            if let Some(flag) = state.ai_aborts.lock().unwrap().get(&rid) {
                flag.store(true, std::sync::atomic::Ordering::Relaxed);
            }
            ok(json!(null))
        }

        "dialog:pickKey" => {
            if state.test_mode {
                if let Ok(p) = std::env::var("NEBULA_TEST_PICK_KEY") {
                    let content = std::fs::read_to_string(&p).unwrap_or_default();
                    return ok(json!({ "path": p, "content": content }));
                }
            }
            match rfd::AsyncFileDialog::new()
                .set_title("选择私钥文件")
                .pick_file()
                .await
            {
                Some(f) => {
                    let path = f.path().to_string_lossy().to_string();
                    match std::fs::read_to_string(&path) {
                        Ok(content) => ok(json!({ "path": path, "content": content })),
                        Err(e) => err_msg(e),
                    }
                }
                None => ok(json!(null)),
            }
        }
        "dialog:pickAnyFile" => {
            if state.test_mode {
                if let Ok(paths) = std::env::var("NEBULA_TEST_PICK_PATHS") {
                    return ok(json!(paths
                        .split(':')
                        .filter(|s| !s.is_empty())
                        .collect::<Vec<_>>()));
                }
            }
            match rfd::AsyncFileDialog::new()
                .set_title("选择要上传的文件")
                .pick_files()
                .await
            {
                Some(files) => ok(json!(files
                    .iter()
                    .map(|f| f.path().to_string_lossy().to_string())
                    .collect::<Vec<_>>())),
                None => ok(json!(null)),
            }
        }
        "dialog:saveFile" => {
            let default_name = payload["defaultName"].as_str().unwrap_or("");
            if state.test_mode {
                if let Ok(p) = std::env::var("NEBULA_TEST_SAVE_PATH") {
                    return ok(json!(p));
                }
            }
            match rfd::AsyncFileDialog::new()
                .set_file_name(default_name)
                .save_file()
                .await
            {
                Some(f) => ok(json!(f.path().to_string_lossy().to_string())),
                None => ok(json!(null)),
            }
        }
        // 选择目录(文件夹下载/批量下载的目标根目录)
        "dialog:pickDirectory" => {
            if state.test_mode {
                if let Ok(p) = std::env::var("NEBULA_TEST_PICK_DIR") {
                    return ok(json!(p));
                }
            }
            match rfd::AsyncFileDialog::new()
                .set_title("选择下载目标文件夹")
                .pick_folder()
                .await
            {
                Some(f) => ok(json!(f.path().to_string_lossy().to_string())),
                None => ok(json!(null)),
            }
        }

        _ => err_msg(format!("IPC 通道未授权: {}", channel)),
    }
}

/// 判断导出文件是否携带(加密的)凭据块。
/// 用于决定是否需要向用户索取口令,而不把"需要口令"报成错误。
fn file_has_credentials(text: &str) -> bool {
    serde_json::from_str::<Value>(text)
        .map(|v| !v["credentials"].is_null() || v["credentialsIncluded"] == json!(true))
        .unwrap_or(false)
}

/// SFTP 通道死亡特征:缓存通道挂在已死/半死的子通道上时,russh-sftp 的
/// 每请求 10s(现为 30s)超时报 "Timeout",事件循环 EOF 后发送端仍开放则报
/// "session closed"。命中即丢缓存重试一次,新请求自动重新协商通道。
fn sftp_channel_dead(e: &str) -> bool {
    e.contains("Timeout") || e.contains("session closed") || e.contains("UnexpectedEof")
}

async fn sftp_op<F, Fut>(
    state: &tauri::State<'_, AppState>,
    app: tauri::AppHandle,
    payload: &Value,
    f: F,
) -> Result<Value, String>
where
    F: Fn(Arc<russh_sftp::client::SftpSession>, tauri::AppHandle, String, Value) -> Fut + Clone,
    Fut: std::future::Future<Output = Result<Value, String>>,
{
    let sid = payload["sessionId"].as_str().unwrap_or("").to_string();
    let payload = payload.clone();
    // 统一信封:前端 api() 要求 {ok:true,data:...},失败时要求 {ok:false,error}。
    // 此前这里直接返回裸数据,导致文件面板所有操作都被判为失败(报"调用失败")。
    let sftp = match state.ssh.open_sftp(&sid).await {
        Ok(s) => s,
        Err(e) => return err_msg(e),
    };
    match f(sftp, app.clone(), sid.clone(), payload.clone()).await {
        Ok(data) => ok(data),
        Err(e) if sftp_channel_dead(&e) => {
            // 自愈:通道僵死(连接本身正常)→ 丢缓存重建后重试一次;
            // 重试仍失败才报给前端。各操作均幂等:下载/打开重建本地临时文件,
            // 上传走 .part + rename,列目录/stat 只读。
            state.ssh.forget_sftp(&sid).await;
            let sftp = match state.ssh.open_sftp(&sid).await {
                Ok(s) => s,
                Err(e2) => return err_msg(e2),
            };
            match f(sftp, app, sid, payload).await {
                Ok(data) => ok(data),
                Err(_) => err_msg(e),
            }
        }
        Err(e) => err_msg(e),
    }
}

pub fn regex_lite(url: &str) -> bool {
    url.starts_with("https://console.cloud.tencent.com/")
        || url.starts_with("https://ram.console.aliyun.com/")
        || url.starts_with("https://console.aliyun.com/")
}

/// 云实例默认名:{云}-{区域}-{IP}。仅在实例没有名字时使用。
fn default_cloud_name(it: &Value) -> Value {
    let provider = it["cloud"]["provider"].as_str().unwrap_or("");
    let vendor = match provider {
        "lighthouse" => "腾讯轻量",
        "tencent" | "cvm" => "腾讯云",
        "aliyun" => "阿里云",
        other => other,
    };
    let region = it["cloud"]["region"].as_str().unwrap_or("");
    let ip = it["host"].as_str().unwrap_or("");
    json!(format!("{}-{}-{}", vendor, region, ip))
}

async fn wait_for_cancel(flag: &std::sync::atomic::AtomicBool) {
    while !flag.load(std::sync::atomic::Ordering::Acquire) {
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
}

fn batch_test_export_path(
    directory: Option<std::ffi::OsString>,
    default_name: &str,
) -> Option<std::path::PathBuf> {
    directory
        .filter(|dir| !dir.is_empty())
        .map(|dir| std::path::PathBuf::from(dir).join(default_name))
}

/// The picker is the only authority for the destination; payload paths/names are ignored.
/// Taking owned JSON before awaiting the picker also preserves the frontend snapshot.
async fn export_batch_results<F, Fut>(payload: &Value, pick_path: F) -> Result<Value, String>
where
    F: FnOnce(String) -> Fut,
    Fut: std::future::Future<Output = Option<std::path::PathBuf>>,
{
    let snapshot = payload["json"]
        .as_str()
        .ok_or_else(|| "缺少批量结果 JSON".to_string())?
        .to_string();
    let results: Value =
        serde_json::from_str(&snapshot).map_err(|e| format!("批量结果 JSON 无效: {e}"))?;
    let rows = results
        .as_array()
        .filter(|rows| rows.iter().all(Value::is_object))
        .ok_or_else(|| "批量结果必须是 JSON 对象数组".to_string())?;
    let count = rows.len();
    let default_name = format!(
        "NebulaShell-batch-{}.json",
        chrono::Local::now().format("%Y-%m-%dT%H-%M-%S-%3f")
    );
    let Some(path) = pick_path(default_name).await else {
        return Ok(Value::Null);
    };
    tokio::fs::write(&path, snapshot)
        .await
        .map_err(|e| format!("写入批量结果失败 ({}): {e}", path.display()))?;
    Ok(json!({ "path": path.to_string_lossy(), "count": count }))
}

fn batch_output_result(code: i64, output: String, truncated: bool, original_bytes: usize) -> Value {
    json!({
        "ok": code == 0, "code": code, "retainedChars": output.chars().count(),
        "originalBytes": original_bytes, "output": output, "truncated": truncated,
        "outputLimitBytes": 1048576, "cancelled": false, "error": null,
    })
}

fn batch_exec(
    app: tauri::AppHandle,
    state: &tauri::State<'_, AppState>,
    payload: &Value,
) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<Value, String>> + Send>> {
    let ssh = state.ssh.clone();
    let store = state.store.clone();
    let aborts = state.batch_aborts.clone();
    let payload = payload.clone();
    Box::pin(async move {
        let mut host_ids: Vec<String> = payload["hostIds"]
            .as_array()
            .map(|ids| {
                ids.iter()
                    .filter_map(|id| id.as_str().map(String::from))
                    .collect()
            })
            .unwrap_or_default();
        let mut seen = std::collections::HashSet::new();
        host_ids.retain(|id| seen.insert(id.clone()));
        if host_ids.is_empty() {
            return err_msg("请选择目标主机");
        }
        let command = payload["command"].as_str().unwrap_or("").trim().to_string();
        if command.is_empty() {
            return err_msg("请输入命令");
        }
        let request_id = payload["requestId"]
            .as_str()
            .filter(|id| !id.is_empty())
            .map(String::from)
            .unwrap_or_else(uid);
        let registration =
            match RequestRegistration::new(aborts, request_id.clone(), "批量任务标识已存在")
            {
                Ok(registration) => registration,
                Err(error) => return err_msg(error),
            };
        let cancelled = registration.flag.clone();
        let targets: Vec<_> = host_ids
            .into_iter()
            .map(|id| {
                let full = store.host_full(&id);
                (id, full)
            })
            .collect();
        let timeout_ms = payload["timeoutMs"]
            .as_u64()
            .unwrap_or(30000)
            .clamp(1000, 600000);
        let parallel = payload["maxParallel"].as_u64().unwrap_or(5).clamp(1, 10) as usize;
        let semaphore = Arc::new(tokio::sync::Semaphore::new(parallel));
        let mut tasks = Vec::new();
        for (host_id, full) in targets {
            let app = app.clone();
            let ssh = ssh.clone();
            let semaphore = semaphore.clone();
            let cancelled = cancelled.clone();
            let command = command.clone();
            let request_id = request_id.clone();
            tasks.push(tokio::spawn(async move {
                let session_id = format!("batch-{}", uid());
                let started = std::time::Instant::now();
                let label = full.as_ref().map(|host| format!("{}@{}", host["username"].as_str().unwrap_or("root"), host["host"].as_str().unwrap_or(""))).unwrap_or_else(|_| host_id.clone());
                let work = async {
                    let _permit = semaphore.acquire_owned().await.map_err(|e| e.to_string())?;
                    if cancelled.load(std::sync::atomic::Ordering::Acquire) { return Err("已取消".to_string()); }
                    let host = full?;
                    tokio::time::timeout(std::time::Duration::from_millis(timeout_ms), async {
                        ssh.connect(app.clone(), host, session_id.clone()).await?;
                        ssh.exec_limited(&session_id, &command, 1024 * 1024).await
                    }).await.map_err(|_| "连接或执行超时".to_string())?
                };
                let result = tokio::select! {
                    biased;
                    _ = wait_for_cancel(&cancelled) => Err("已取消".to_string()),
                    result = work => result,
                };
                ssh.disconnect(&session_id).await;
                let ms = started.elapsed().as_millis() as u64;
                let mut out = match result {
                    Ok((code, output, truncated, original_bytes)) => batch_output_result(code, output, truncated, original_bytes),
                    Err(error) => json!({ "ok": false, "code": null, "output": "", "retainedChars": 0, "originalBytes": null, "outputLimitBytes": 1048576, "truncated": false, "cancelled": error == "已取消", "error": error }),
                };
                out["requestId"] = json!(request_id);
                out["hostId"] = json!(host_id);
                out["host"] = json!(label);
                out["ms"] = json!(ms);
                crate::ai::emit_evt(&app, "batch:progress", out.clone());
                out
            }));
        }
        let mut results = Vec::new();
        for task in tasks {
            match task.await {
                Ok(result) => results.push(result),
                Err(error) => results.push(json!({ "requestId": request_id, "ok": false, "error": format!("任务异常：{}", error) })),
            }
        }
        drop(registration);
        ok(json!(results))
    })
}

#[cfg(test)]
mod integration_tests {
    use super::*;

    struct BatchExportTempDir(std::path::PathBuf);

    impl BatchExportTempDir {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!("nebula-batch-export-{}", uid()));
            std::fs::create_dir(&path).unwrap();
            Self(path)
        }
    }

    impl Drop for BatchExportTempDir {
        fn drop(&mut self) {
            std::fs::remove_dir_all(&self.0).ok();
        }
    }

    #[tokio::test]
    async fn batch_export_uses_safe_test_filename_and_preserves_retained_json() {
        let directory = BatchExportTempDir::new();
        let unselected = directory.0.join("unselected.json");
        std::fs::write(&unselected, "do not overwrite").unwrap();
        let snapshot = serde_json::to_string_pretty(&json!([{
            "hostId": "a", "output": format!("中🙂\n{}", "x".repeat(5000)),
            "truncated": true, "originalBytes": 2_000_000,
            "retainedChars": 5003, "outputLimitBytes": 1_048_576,
            "detail": "[输出已截断]", "code": 2, "error": "failed"
        }]))
        .unwrap();
        let payload = json!({
            "json": snapshot, "path": unselected, "defaultName": "../unselected.json"
        });
        let result = export_batch_results(&payload, |name| {
            assert!(name.starts_with("NebulaShell-batch-20"));
            assert!(name.ends_with(".json"));
            assert!(name
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '.'));
            std::future::ready(batch_test_export_path(
                Some(directory.0.clone().into_os_string()),
                &name,
            ))
        })
        .await
        .unwrap();
        let path = std::path::PathBuf::from(result["path"].as_str().unwrap());
        assert_eq!(path.parent(), Some(directory.0.as_path()));
        assert_eq!(result["count"], 1);
        assert_eq!(std::fs::read_to_string(path).unwrap(), snapshot);
        assert_eq!(
            std::fs::read_to_string(unselected).unwrap(),
            "do not overwrite"
        );
    }

    #[tokio::test]
    async fn batch_export_cancellation_is_null_and_writes_nothing() {
        let directory = BatchExportTempDir::new();
        let result = export_batch_results(&json!({ "json": "[]" }), |_| async { None })
            .await
            .unwrap();
        assert!(result.is_null());
        assert_eq!(std::fs::read_dir(&directory.0).unwrap().count(), 0);
        assert!(batch_test_export_path(None, "NebulaShell-batch.json").is_none());
        assert!(batch_test_export_path(Some("".into()), "NebulaShell-batch.json").is_none());
    }

    #[tokio::test]
    async fn batch_export_write_failure_is_reported() {
        let directory = BatchExportTempDir::new();
        let error = export_batch_results(&json!({ "json": "[]" }), |_| async {
            // A directory cannot be overwritten with JSON; only temporary paths are touched.
            Some(directory.0.clone())
        })
        .await
        .unwrap_err();
        assert!(error.contains("写入批量结果失败"));
        assert_eq!(std::fs::read_dir(&directory.0).unwrap().count(), 0);
    }

    #[tokio::test]
    async fn batch_export_invalid_snapshot_never_opens_picker() {
        for payload in [
            json!({}),
            json!({ "json": "not JSON" }),
            json!({ "json": "{}" }),
            json!({ "json": "[1]" }),
        ] {
            let result = export_batch_results(&payload, |_| async {
                panic!("invalid results must not open the picker")
            })
            .await;
            assert!(result.is_err());
        }
    }

    #[test]
    fn batch_metadata_distinguishes_retained_characters_from_total_bytes() {
        let result = batch_output_result(0, "中🙂".into(), true, 2_000_000);
        assert_eq!(result["retainedChars"], 2);
        assert_eq!(result["originalBytes"], 2_000_000);
        assert_eq!(result["outputLimitBytes"], 1_048_576);
        assert_eq!(result["truncated"], true);
        assert!(result.get("originalChars").is_none());
    }

    #[test]
    fn duplicate_request_ids_do_not_replace_original_abort_flag() {
        let registry = Arc::new(Mutex::new(HashMap::new()));
        let first = RequestRegistration::new(registry.clone(), "same".into(), "duplicate").unwrap();
        assert!(RequestRegistration::new(registry.clone(), "same".into(), "duplicate").is_err());
        assert!(Arc::ptr_eq(
            registry.lock().unwrap().get("same").unwrap(),
            &first.flag
        ));
        registry
            .lock()
            .unwrap()
            .get("same")
            .unwrap()
            .store(true, Ordering::Release);
        assert!(first.flag.load(Ordering::Acquire));
        drop(first);
        assert!(registry.lock().unwrap().is_empty());
        let next = RequestRegistration::new(registry.clone(), "same".into(), "duplicate").unwrap();
        assert!(!next.flag.load(Ordering::Acquire));
    }

    #[test]
    fn concurrent_duplicate_requests_have_exactly_one_owner() {
        let registry = Arc::new(Mutex::new(HashMap::new()));
        let barrier = Arc::new(std::sync::Barrier::new(8));
        let threads: Vec<_> = (0..8)
            .map(|_| {
                let registry = registry.clone();
                let barrier = barrier.clone();
                std::thread::spawn(move || {
                    barrier.wait();
                    let registration =
                        RequestRegistration::new(registry, "same".into(), "duplicate");
                    barrier.wait(); // Keep the winner registered until every attempt has completed.
                    registration.is_ok()
                })
            })
            .collect();
        let owners = threads
            .into_iter()
            .map(|thread| thread.join().unwrap())
            .filter(|owner| *owner)
            .count();
        assert_eq!(owners, 1);
        assert!(registry.lock().unwrap().is_empty());
    }

    #[test]
    fn request_cleanup_never_removes_a_replacement_and_cancels_dropped_work() {
        let registry = Arc::new(Mutex::new(HashMap::new()));
        let first = RequestRegistration::new(registry.clone(), "same".into(), "duplicate").unwrap();
        let first_flag = first.flag.clone();
        let replacement = Arc::new(AtomicBool::new(false));
        registry
            .lock()
            .unwrap()
            .insert("same".into(), replacement.clone());
        drop(first);
        assert!(first_flag.load(Ordering::Acquire));
        assert!(Arc::ptr_eq(
            registry.lock().unwrap().get("same").unwrap(),
            &replacement
        ));
    }

    #[tokio::test]
    async fn new_connection_generation_cancels_only_previous_attempt() {
        let lifecycle = ConnectionLifecycle::default();
        let old = lifecycle.begin();
        let new = lifecycle.begin();
        assert!(old.load(Ordering::Acquire));
        assert!(!new.load(Ordering::Acquire));
        lifecycle.cancel();
        tokio::time::timeout(std::time::Duration::from_secs(1), wait_for_cancel(&new))
            .await
            .unwrap();
        assert!(new.load(Ordering::Acquire));
    }

    #[tokio::test]
    async fn cancellation_interrupts_a_pending_forward_activation() {
        let lifecycle = Arc::new(ConnectionLifecycle::default());
        let token = lifecycle.begin();
        let activation = lifecycle.clone();
        let (started_tx, started_rx) = tokio::sync::oneshot::channel();
        let task = tokio::spawn(async move {
            let _activation = activation.activation.lock().await;
            started_tx.send(()).unwrap();
            tokio::select! {
                biased;
                _ = wait_for_cancel(&token) => {},
                _ = std::future::pending::<()>() => panic!("forward must not complete"),
            }
        });
        started_rx.await.unwrap();
        lifecycle.cancel();
        tokio::time::timeout(std::time::Duration::from_secs(1), task)
            .await
            .unwrap()
            .unwrap();
        assert!(lifecycle.activation.try_lock().is_ok());
    }

    #[tokio::test]
    async fn disconnect_invalidates_in_flight_activation_before_cleanup_lock() {
        let lifecycle = Arc::new(ConnectionLifecycle::default());
        let token = lifecycle.begin();
        let activating = lifecycle.activation.lock().await;
        let disconnecting = lifecycle.clone();
        let (cancelled_tx, cancelled_rx) = tokio::sync::oneshot::channel();
        let cleanup = tokio::spawn(async move {
            disconnecting.cancel();
            cancelled_tx.send(()).unwrap();
            let _activation = disconnecting.activation.lock().await;
        });
        cancelled_rx.await.unwrap();
        assert!(token.load(Ordering::Acquire));
        assert!(!cleanup.is_finished());
        drop(activating);
        cleanup.await.unwrap();
    }
}
