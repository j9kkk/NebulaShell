// AI 助手:OpenAI 兼容 / Anthropic 双协议流式客户端(SSE)+ 模型列表发现
use base64::Engine;
use futures::StreamExt;
use serde_json::{json, Value};

pub fn emit_evt<R: tauri::Runtime, E: tauri::Emitter<R>>(app: &E, evt: &str, payload: Value) {
    let name = evt.replace(':', "__");
    app.emit(&name, payload).ok();
}

pub async fn list_models(
    protocol: &str,
    base_url: &str,
    api_key: &str,
) -> Result<Vec<String>, String> {
    if base_url.trim().is_empty() {
        return Err("未配置 API Base URL,请先填写".into());
    }
    let url = format!("{}/models", base_url.trim().trim_end_matches('/'));
    let client = reqwest::Client::new();
    let mut req = client.get(&url);
    if protocol == "anthropic" {
        req = req
            .header("x-api-key", api_key)
            .header("anthropic-version", "2023-06-01");
    } else if !api_key.is_empty() {
        req = req.header("authorization", format!("Bearer {}", api_key));
    }
    let res = req
        .send()
        .await
        .map_err(|e| format!("获取模型列表失败: {}", e))?;
    if !res.status().is_success() {
        let status = res.status();
        let t = res.text().await.unwrap_or_default();
        return Err(format!(
            "获取模型列表失败 HTTP {}: {}",
            status,
            &t[..t.len().min(200)]
        ));
    }
    let j: Value = res.json().await.map_err(|e| e.to_string())?;
    let list = j["data"].as_array().cloned().unwrap_or_default();
    let ids: Vec<String> = list
        .iter()
        .filter_map(|m| {
            let id = m["id"]
                .as_str()
                .or_else(|| m["name"].as_str())
                .unwrap_or("");
            if id.is_empty() {
                None
            } else {
                Some(id.to_string())
            }
        })
        .collect();
    if ids.is_empty() {
        return Err("端点未返回任何模型,请确认 Base URL 是否到 /v1 级别".into());
    }
    Ok(ids)
}

/// 流式对话;每 250ms 一帧,SSE 逐行解析(与 Electron 版 ai.js 语义一致)
pub async fn chat_stream<
    R: tauri::Runtime,
    E: tauri::Emitter<R> + Clone + Send + Sync + 'static,
>(
    app: E,
    request_id: String,
    protocol: String,
    base_url: String,
    api_key: String,
    model: String,
    temperature: f64,
    messages: Value,
    abort_flag: std::sync::Arc<std::sync::atomic::AtomicBool>,
) -> Result<(), String> {
    if base_url.trim().is_empty() {
        return Err("未配置 API Base URL,请先打开 AI 设置".into());
    }
    if model.trim().is_empty() {
        return Err("未配置模型名称,请先打开 AI 设置".into());
    }
    let client = reqwest::Client::new();
    let (url, body, mut req) = if protocol == "anthropic" {
        let url = format!("{}/messages", base_url.trim().trim_end_matches('/'));
        let system: Vec<&str> = messages
            .as_array()
            .map(|m| {
                m.iter()
                    .filter(|m| m["role"] == "system")
                    .filter_map(|m| m["content"].as_str())
                    .collect()
            })
            .unwrap_or_default();
        let msgs: Vec<Value> = messages
            .as_array()
            .map(|m| {
                m.iter()
                    .filter(|m| m["role"] != "system")
                    .cloned()
                    .collect()
            })
            .unwrap_or_default();
        let body = json!({
            "model": model, "max_tokens": 4096,
            "system": if system.is_empty() { json!(null) } else { json!(system.join("\n")) },
            "messages": msgs, "stream": true
        });
        let r = client
            .post(&url)
            .header("x-api-key", &api_key)
            .header("anthropic-version", "2023-06-01")
            .json(&body);
        (url, body, r)
    } else {
        let url = format!("{}/chat/completions", base_url.trim().trim_end_matches('/'));
        let body = json!({ "model": model, "messages": messages, "stream": true, "temperature": temperature });
        let mut r = client.post(&url).json(&body);
        if !api_key.is_empty() {
            r = r.header("authorization", format!("Bearer {}", api_key));
        }
        (url, body, r)
    };
    void(&url);
    void(&body);

    let res = req
        .send()
        .await
        .map_err(|e| format!("AI 请求失败: {}", e))?;
    if !res.status().is_success() {
        let status = res.status();
        let t = res.text().await.unwrap_or_default();
        return Err(format!(
            "AI 请求失败 HTTP {}: {}",
            status,
            &t[..t.len().min(300)]
        ));
    }

    let mut stream = res.bytes_stream();
    let mut buffer = String::new();
    loop {
        if abort_flag.load(std::sync::atomic::Ordering::Relaxed) {
            emit_evt(
                &app,
                "ai:done",
                json!({ "requestId": request_id, "finishReason": "aborted" }),
            );
            return Ok(());
        }
        let chunk = tokio::select! {
            c = stream.next() => c,
            _ = tokio::time::sleep(std::time::Duration::from_millis(200)) => continue,
        };
        let bytes = match chunk {
            Some(b) => b.map_err(|e| e.to_string())?,
            None => break,
        };
        buffer.push_str(&String::from_utf8_lossy(&bytes));
        let lines: Vec<String> = buffer.split('\n').map(String::from).collect();
        let (last, done_lines) = lines.split_last().unwrap();
        buffer = last.clone();
        for line in done_lines {
            let trimmed = line.trim();
            if !trimmed.starts_with("data:") {
                continue;
            }
            let data = trimmed[5..].trim();
            if data.is_empty() {
                continue;
            }
            if data == "[DONE]" {
                emit_evt(
                    &app,
                    "ai:done",
                    json!({ "requestId": request_id, "finishReason": "stop" }),
                );
                return Ok(());
            }
            let evt: Value = match serde_json::from_str(data) {
                Ok(v) => v,
                Err(_) => continue,
            };
            if protocol == "anthropic" {
                match evt["type"].as_str().unwrap_or("") {
                    "content_block_delta" => {
                        if let Some(text) = evt["delta"]["text"].as_str() {
                            emit_evt(
                                &app,
                                "ai:delta",
                                json!({ "requestId": request_id, "text": text }),
                            );
                        }
                    }
                    "message_stop" => {
                        emit_evt(
                            &app,
                            "ai:done",
                            json!({ "requestId": request_id, "finishReason": "stop" }),
                        );
                        return Ok(());
                    }
                    "error" => {
                        return Err(format!(
                            "AI API 错误: {}",
                            &evt.to_string()[..evt.to_string().len().min(300)]
                        ));
                    }
                    _ => {}
                }
            } else {
                if !evt["error"].is_null() {
                    return Err(format!(
                        "AI API 错误: {}",
                        &evt["error"].to_string()[..evt["error"].to_string().len().min(300)]
                    ));
                }
                let delta = &evt["choices"][0]["delta"];
                let text = delta["content"]
                    .as_str()
                    .or_else(|| delta["text"].as_str())
                    .or_else(|| evt["choices"][0]["message"]["content"].as_str())
                    .unwrap_or("");
                if !text.is_empty() {
                    emit_evt(
                        &app,
                        "ai:delta",
                        json!({ "requestId": request_id, "text": text }),
                    );
                }
            }
        }
    }
    emit_evt(
        &app,
        "ai:done",
        json!({ "requestId": request_id, "finishReason": "end" }),
    );
    Ok(())
}

fn void<T>(_: &T) {}
pub fn b64(s: &str) -> String {
    base64::engine::general_purpose::STANDARD.encode(s.as_bytes())
}
