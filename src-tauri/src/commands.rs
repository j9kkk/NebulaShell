// IPC 统一分发:channel → 处理器,返回 {ok, data|error} 信封(与 Electron 版 IPC 契约一致)
use crate::config::Store;
use crate::forward::ForwardService;
use crate::monitor;
use crate::ssh::SshService;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use tauri::{Emitter, Manager};

pub struct LogEntry {
    pub file: std::path::PathBuf,
    pub timestamps: bool,
    pub record_input: bool,
    pub handle: std::fs::File,
}

pub struct AppState {
    pub store: Arc<Store>,
    pub ssh: Arc<SshService>,
    pub forwards: ForwardService,
    pub monitors: Mutex<HashMap<String, tauri::async_runtime::JoinHandle<()>>>,
    pub logs: Mutex<HashMap<String, LogEntry>>,
    pub ai_aborts: Arc<Mutex<HashMap<String, Arc<std::sync::atomic::AtomicBool>>>>,
    pub test_results: Arc<Mutex<HashMap<String, String>>>,
    pub test_mode: bool,
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
    let payload = if payload.is_null() { json!({}) } else { payload };
    match channel.as_str() {
        "app:info" => ok(json!({ "version": "1.0.0", "platform": std::env::consts::OS })),

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
                let _ = std::process::Command::new("cmd").args(["/C", "start", "", url]).spawn();
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
        "hosts:delete" => match state.store.delete_host(payload["id"].as_str().unwrap_or("")) {
            Ok(n) => ok(json!(n)),
            Err(e) => err_msg(e),
        },
        "hosts:clone" => match state.store.clone_host(payload["id"].as_str().unwrap_or("")) {
            Ok(h) => ok(h),
            Err(e) => err_msg(e),
        },
        "hosts:exportFile" => {
            let data = match state.store.export_hosts() {
                Ok(d) => d,
                Err(e) => return err_msg(e),
            };
            if state.test_mode {
                if let Ok(p) = std::env::var("NEBULA_TEST_SAVE_PATH") {
                    std::fs::write(&p, serde_json::to_string_pretty(&data).unwrap_or_default()).ok();
                    return ok(json!({ "path": p, "count": data["hosts"].as_array().map(|a| a.len()).unwrap_or(0) }));
                }
            }
            let file = rfd::AsyncFileDialog::new()
                .set_file_name("nebulashell-hosts.json")
                .save_file()
                .await;
            match file {
                Some(f) => {
                    let path = f.path().to_string_lossy().to_string();
                    std::fs::write(&path, serde_json::to_string_pretty(&data).unwrap_or_default())
                        .map_err(|e| e.to_string())?;
                    ok(json!({ "path": path, "count": data["hosts"].as_array().map(|a| a.len()).unwrap_or(0) }))
                }
                None => ok(json!(null)),
            }
        }
        "hosts:importFile" => {
            let path = if state.test_mode {
                std::env::var("NEBULA_TEST_PICK_PATHS").ok()
            } else {
                rfd::AsyncFileDialog::new().pick_file().await.map(|f| f.path().to_string_lossy().to_string())
            };
            match path {
                Some(p) => match std::fs::read_to_string(&p) {
                    Ok(text) => match state.store.import_hosts(&text) {
                        Ok(r) => ok(json!({ "path": p, "added": r["added"], "skipped": r["skipped"] })),
                        Err(e) => err_msg(e),
                    },
                    Err(e) => err_msg(e),
                },
                None => ok(json!(null)),
            }
        }

        "ssh:connect" | "ssh:connectQuick" => {
            let host = if channel == "ssh:connect" {
                match state.store.host_full(payload["hostId"].as_str().unwrap_or("")) {
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
            match state.ssh.connect(app.clone(), host, session_id.clone()).await {
                Ok(_) => {
                    // 监控任务随连接启动(批量会话除外)
                    if !session_id.starts_with("batch-") {
                        state.start_monitor(&app, &session_id);
                        // autoStart 转发规则
                        let rules: Vec<Value> = {
                            let data = state.store.data.lock().unwrap();
                            data["forwards"].as_array().cloned().unwrap_or_default()
                        };
                        let host_id = state.ssh.session_host_id(&session_id).await.unwrap_or_default();
                        for rule in rules {
                            if rule["autoStart"].as_bool().unwrap_or(false) && rule["hostId"].as_str() == Some(host_id.as_str()) {
                                let _ = state.forwards.start(app.clone(), state.ssh.clone(), &rule).await;
                            }
                        }
                    }
                    ok(json!({ "sessionId": session_id }))
                }
                Err(e) => err_msg(e),
            }
        }
        "ssh:write" => match state.ssh.write(
            payload["sessionId"].as_str().unwrap_or(""),
            payload["data"].as_str().unwrap_or(""),
        ).await {
            Ok(_) => {
                // 会话日志记录输入(J1/J2)
                let sid = payload["sessionId"].as_str().unwrap_or("").to_string();
                let data = payload["data"].as_str().unwrap_or("").to_string();
                let mut logs = state.logs.lock().unwrap();
                if let Some(entry) = logs.get_mut(&sid) {
                    if entry.record_input && data != "\r" {
                        use std::io::Write;
                        let ts = if entry.timestamps {
                            format!("[IN ] {} ", chrono::Local::now().to_rfc3339())
                        } else {
                            String::new()
                        };
                        let _ = entry.handle.write_all(format!("{}{}", ts, data.replace('\r', "")).as_bytes());
                    }
                }
                ok(json!(null))
            }
            Err(e) => err_msg(e),
        },
        "ssh:resize" => match state.ssh.resize(
            payload["sessionId"].as_str().unwrap_or(""),
            payload["cols"].as_u64().unwrap_or(100) as u32,
            payload["rows"].as_u64().unwrap_or(30) as u32,
        ).await {
            Ok(_) => ok(json!(null)),
            Err(e) => err_msg(e),
        },
        "ssh:disconnect" => {
            let sid = payload["sessionId"].as_str().unwrap_or("").to_string();
            state.ssh.disconnect(&sid).await;
            state.stop_monitor(&sid);
            state.forwards.stop_by_session(&app, state.ssh.clone(), &sid);
            ok(json!(null))
        }

        "sftp:list" => sftp_op(&state, app.clone(), &payload, |sftp, _app, sid, p| async move {
            crate::sftp::list(&sftp, p["path"].as_str().map(String::from)).await
        }).await,
        "sftp:mkdir" => sftp_op(&state, app.clone(), &payload, |sftp, _app, _sid, p| async move {
            crate::sftp::mkdir(&sftp, p["path"].as_str().unwrap_or("")).await.map(|_| json!(null))
        }).await,
        "sftp:remove" => sftp_op(&state, app.clone(), &payload, |sftp, _app, _sid, p| async move {
            crate::sftp::remove(&sftp, p["path"].as_str().unwrap_or(""), p["isDir"].as_bool().unwrap_or(false)).await.map(|_| json!(null))
        }).await,
        "sftp:rename" => sftp_op(&state, app.clone(), &payload, |sftp, _app, _sid, p| async move {
            crate::sftp::rename(&sftp, p["from"].as_str().unwrap_or(""), p["to"].as_str().unwrap_or("")).await.map(|_| json!(null))
        }).await,
        "sftp:chmod" => sftp_op(&state, app.clone(), &payload, |sftp, _app, _sid, p| async move {
            crate::sftp::chmod(&sftp, p["path"].as_str().unwrap_or(""), p["mode"].as_u64().unwrap_or(0o644) as u32).await.map(|_| json!(null))
        }).await,
        "sftp:upload" => sftp_op(&state, app.clone(), &payload, |sftp, app, sid, p| async move {
            crate::sftp::upload(&sftp, app, sid, p["localPath"].as_str().unwrap_or(""), p["remoteDir"].as_str().unwrap_or("")).await
        }).await,
        "sftp:download" => sftp_op(&state, app.clone(), &payload, |sftp, app, sid, p| async move {
            crate::sftp::download(&sftp, app, sid, p["remotePath"].as_str().unwrap_or(""), p["localPath"].as_str().unwrap_or("")).await
        }).await,

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
                data["forwards"].as_array_mut().unwrap().retain(|f| f["id"] != json!(id));
            }
            state.store.save().ok();
            ok(json!(null))
        }
        "forward:start" => match state.forwards.start(app.clone(), state.ssh.clone(), &payload).await {
            Ok(port) => ok(json!({ "port": port })),
            Err(e) => err_msg(e),
        },
        "forward:stop" => {
            state.forwards.stop(&app, state.ssh.clone(), payload["id"].as_str().unwrap_or(""));
            ok(json!(null))
        }
        "forward:states" => {
            let ids: Vec<String> = payload["ids"]
                .as_array()
                .map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect())
                .unwrap_or_default();
            ok(state.forwards.states(&ids))
        }

        "batch:exec" => batch_exec(app.clone(), &state, &payload).await,

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
            state.store.save().ok();
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
                if !list.iter().any(|b| b["hostId"].as_str() == Some(host_id) && b["path"].as_str() == Some(path)) {
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
            let dir = dirs::home_dir().unwrap_or_default().join("NebulaShell-logs");
            std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
            let label = payload["hostLabel"].as_str().unwrap_or("session").replace(|c: char| !c.is_alphanumeric() && c != '.' && c != '-' && c != '_', "_");
            let stamp = chrono::Local::now().format("%Y-%m-%dT%H-%M-%S");
            let file = dir.join(format!("{}-{}.log", label, stamp));
            let handle = std::fs::OpenOptions::new().create(true).append(true).open(&file).map_err(|e| e.to_string())?;
            let file_str = file.to_string_lossy().to_string();
            state.logs.lock().unwrap().insert(
                sid,
                LogEntry {
                    file: file.clone(),
                    timestamps: payload["timestamps"].as_bool().unwrap_or(true),
                    record_input: payload["recordInput"].as_bool().unwrap_or(false),
                    handle,
                },
            );
            ok(json!({ "file": file_str }))
        }
        "log:stop" => {
            let sid = payload["sessionId"].as_str().unwrap_or("").to_string();
            match state.logs.lock().unwrap().remove(&sid) {
                Some(entry) => ok(json!({ "file": entry.file.to_string_lossy() })),
                None => ok(json!({ "file": null })),
            }
        }
        "log:status" => {
            let sid = payload["sessionId"].as_str().unwrap_or("").to_string();
            let logs = state.logs.lock().unwrap();
            match logs.get(&sid) {
                Some(e) => ok(json!({ "active": true, "file": e.file.to_string_lossy() })),
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

        "cloud:fetch" => {
            let provider = payload["provider"].as_str().unwrap_or("tencent").to_string();
            let key = payload["key"].as_str().unwrap_or("").to_string();
            let secret = payload["secret"].as_str().unwrap_or("").to_string();
            let region = payload["region"].as_str().unwrap_or("").to_string();
            let endpoint = payload["endpoint"].as_str().unwrap_or("").to_string();
            let res = if provider == "aliyun" {
                crate::cloud::aliyun_describe_instances(&key, &secret, &region, &endpoint).await
            } else {
                crate::cloud::tencent_describe_instances(&key, &secret, &provider, &region, &endpoint).await
            };
            match res {
                Ok(list) => {
                    state.store.save_cloud_creds(&provider, &key, &secret, &endpoint);
                    ok(json!(list))
                }
                Err(e) => err_msg(e),
            }
        }

        "settings:get" => ok(state.store.get_settings()),
        "settings:save" => ok(state.store.save_settings(&payload)),

        "ai:models" => {
            let protocol = payload["protocol"].as_str().unwrap_or("openai").to_string();
            let base = payload["baseUrl"].as_str().unwrap_or("").to_string();
            let key = payload["apiKey"].as_str().unwrap_or("").to_string();
            let key = if key.is_empty() {
                let data = state.store.data.lock().unwrap();
                state.store.dec(data["settings"]["ai"]["apiKeyEnc"].as_str().unwrap_or(""))
            } else {
                key
            };
            match crate::ai::list_models(&protocol, &base, &key).await {
                Ok(ids) => ok(json!(ids)),
                Err(e) => err_msg(e),
            }
        }
        "ai:chat" => {
            let request_id = payload["requestId"].as_str().unwrap_or("").to_string();
            let ai = {
                let data = state.store.data.lock().unwrap();
                data["settings"]["ai"].clone()
            };
            let base = ai["baseUrl"].as_str().unwrap_or("").to_string();
            if base.is_empty() {
                return err_msg("请先在 AI 设置中配置供应商");
            }
            let key = state.store.dec(ai["apiKeyEnc"].as_str().unwrap_or(""));
            let flag = Arc::new(std::sync::atomic::AtomicBool::new(false));
            state.ai_aborts.lock().unwrap().insert(request_id.clone(), flag.clone());
            let aborts = state.ai_aborts.clone();
            let request_id2 = request_id.clone();
            tokio::spawn(async move {
                let _ = crate::ai::chat_stream(
                    app.clone(),
                    request_id2.clone(),
                    ai["protocol"].as_str().unwrap_or("openai").to_string(),
                    base,
                    key,
                    ai["model"].as_str().unwrap_or("").to_string(),
                    ai["temperature"].as_f64().unwrap_or(0.3),
                    payload["messages"].clone(),
                    flag,
                )
                .await;
                aborts.lock().unwrap().remove(&request_id2);
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
            match rfd::AsyncFileDialog::new().set_title("选择私钥文件").pick_file().await {
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
                    return ok(json!(paths.split(':').filter(|s| !s.is_empty()).collect::<Vec<_>>()));
                }
            }
            match rfd::AsyncFileDialog::new().set_title("选择要上传的文件").pick_files().await {
                Some(files) => ok(json!(files.iter().map(|f| f.path().to_string_lossy().to_string()).collect::<Vec<_>>())),
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
            match rfd::AsyncFileDialog::new().set_file_name(default_name).save_file().await {
                Some(f) => ok(json!(f.path().to_string_lossy().to_string())),
                None => ok(json!(null)),
            }
        }

        _ => err_msg(format!("IPC 通道未授权: {}", channel)),
    }
}

async fn sftp_op<F, Fut>(state: &tauri::State<'_, AppState>, app: tauri::AppHandle, payload: &Value, f: F) -> Result<Value, String>
where
    F: FnOnce(russh_sftp::client::SftpSession, tauri::AppHandle, String, Value) -> Fut,
    Fut: std::future::Future<Output = Result<Value, String>>,
{
    let sid = payload["sessionId"].as_str().unwrap_or("").to_string();
    let payload = payload.clone();
    let sftp = state.ssh.open_sftp(&sid).await?;
    f(sftp, app, sid, payload).await
}

pub fn regex_lite(url: &str) -> bool {
    url.starts_with("https://console.cloud.tencent.com/")
        || url.starts_with("https://ram.console.aliyun.com/")
        || url.starts_with("https://console.aliyun.com/")
}


fn batch_exec(
    app: tauri::AppHandle,
    state: &tauri::State<'_, AppState>,
    payload: &Value,
) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<Value, String>> + Send>> {
    let app = app.clone();
    let ssh = state.ssh.clone();
    let store = state.store.clone();
    let payload = payload.clone();
    Box::pin(async move {
        let host_ids: Vec<String> = payload["hostIds"]
            .as_array()
            .map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect())
            .unwrap_or_default();
        if host_ids.is_empty() {
            return err_msg("请选择目标主机");
        }
        let cmd = payload["command"].as_str().unwrap_or("").trim().to_string();
        if cmd.is_empty() {
            return err_msg("请输入命令");
        }
        let timeout_ms = payload["timeoutMs"].as_u64().unwrap_or(30000);
        let max_parallel = payload["maxParallel"].as_u64().unwrap_or(5).clamp(1, 10) as usize;
        let sem = Arc::new(tokio::sync::Semaphore::new(max_parallel));
        let mut handles = vec![];
        for host_id in &host_ids {
            let permit = sem.clone();
            let app = app.clone();
            let ssh = ssh.clone();
            let store = store.clone();
            let cmd = cmd.clone();
            let timeout_ms = timeout_ms;
            let host_id = host_id.clone();
            handles.push(tokio::spawn(async move {
                let started = std::time::Instant::now();
                let _permit = permit.acquire_owned().await;
                let out = match store.host_full(&host_id) {
                    Ok(full) => {
                        let sid = format!("batch-{}", host_id);
                        ssh.disconnect(&sid).await;
                        let label = format!(
                            "{}@{}",
                            full["username"].as_str().unwrap_or("root"),
                            full["host"].as_str().unwrap_or("")
                        );
                        match ssh.connect(app.clone(), full, sid.clone()).await {
                            Ok(_) => match tokio::time::timeout(
                                std::time::Duration::from_millis(timeout_ms),
                                ssh.exec(&sid, &cmd),
                            )
                            .await
                            {
                                Ok(Ok((code, output))) => json!({
                                    "hostId": host_id, "host": label, "ok": code == 0, "code": code,
                                    "output": output.chars().rev().take(4000).collect::<String>().chars().rev().collect::<String>(),
                                    "ms": started.elapsed().as_millis() as u64, "error": null
                                }),
                                Ok(Err(e)) => json!({ "hostId": host_id, "host": label, "ok": false, "code": null, "output": "", "ms": started.elapsed().as_millis() as u64, "error": e }),
                                Err(_) => json!({ "hostId": host_id, "host": label, "ok": false, "code": null, "output": "", "ms": started.elapsed().as_millis() as u64, "error": "执行超时" }),
                            },
                            Err(e) => json!({ "hostId": host_id, "host": host_id, "ok": false, "code": null, "output": "", "ms": started.elapsed().as_millis() as u64, "error": e }),
                        }
                    }
                    Err(e) => json!({ "hostId": host_id, "host": host_id, "ok": false, "code": null, "output": "", "ms": 0, "error": e }),
                };
                ssh.disconnect(&format!("batch-{}", host_id)).await;
                crate::ai::emit_evt(&app, "batch:progress", out.clone());
                out
            }));
        }
        let mut results = vec![];
        for h in handles {
            if let Ok(r) = h.await {
                results.push(r);
            }
        }
        ok(json!(results))
    })
}







