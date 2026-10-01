// AI 助手:OpenAI 兼容 / Anthropic 双协议流式客户端(SSE)+ 模型列表发现
use base64::Engine;
use futures::StreamExt;
use serde_json::{json, Value};

pub fn emit_evt<R: tauri::Runtime, E: tauri::Emitter<R>>(app: &E, evt: &str, payload: Value) {
    let name = evt.replace(':', "__");
    app.emit(&name, payload).ok();
}

/// 拉取可用模型。返回归一化后的对象数组,而非纯 id:
/// 不同协议的属性名不同(OpenAI 用 id/owned_by/created,Anthropic 用
/// display_name/type/created_at),前端要展示"名称 + 属性"就必须在这里统一成
/// 一套字段,否则选择框只能显示一串 id,用户无从判断该勾哪个。
pub async fn list_models(
    protocol: &str,
    base_url: &str,
    api_key: &str,
) -> Result<Vec<Value>, String> {
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
    let mut out: Vec<Value> = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for m in &list {
        let id = m["id"]
            .as_str()
            .or_else(|| m["name"].as_str())
            .unwrap_or("")
            .to_string();
        if id.is_empty() || !seen.insert(id.clone()) {
            continue;
        }
        // display_name(Anthropic)优先于 name;两者都缺时回落 id
        let name = m["display_name"]
            .as_str()
            .or_else(|| m["name"].as_str())
            .filter(|s| !s.is_empty())
            .unwrap_or(&id)
            .to_string();
        let owned_by = m["owned_by"]
            .as_str()
            .or_else(|| m["type"].as_str())
            .unwrap_or("")
            .to_string();
        // created 是 unix 秒(OpenAI)或 RFC3339 串(Anthropic),原样透传给前端格式化
        let created = if m["created"].is_null() {
            m["created_at"].clone()
        } else {
            m["created"].clone()
        };
        // 上下文窗口 / 视觉能力不是所有供应商都返回:OpenRouter 用
        // context_length + architecture.input_modalities,其余字段是各家常见
        // 别名。拿不到就传 null,前端对 null 一律不展示。
        let context = m["context_length"]
            .as_i64()
            .or_else(|| m["context_window"].as_i64())
            .or_else(|| m["max_input_tokens"].as_i64())
            .or_else(|| m["max_model_len"].as_i64())
            .or_else(|| m["top_provider"]["context_length"].as_i64());
        let vision = m["architecture"]["input_modalities"]
            .as_array()
            .map(|a| a.iter().any(|v| v.as_str() == Some("image")))
            .unwrap_or(false);
        out.push(json!({
            "id": id,
            "name": name,
            "ownedBy": owned_by,
            "created": created,
            "context": context,
            "vision": vision,
        }));
    }
    if out.is_empty() {
        return Err("端点未返回任何模型,请确认 Base URL 是否到 /v1 级别".into());
    }
    Ok(out)
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
        // include_usage:OpenAI 兼容流式默认不带 usage,显式请求后最后一帧会附带
        let body = json!({
            "model": model, "messages": messages, "stream": true,
            "stream_options": { "include_usage": true }
        });
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
    // 未消费的 SSE 字节(以行为单位攒);用字节缓冲是为了让跨 chunk 的
    // 多字节字符在被解码前保持完整,见下方 decode 处的注释
    let mut buffer: Vec<u8> = Vec::new();
    // token 用量:OpenAI 兼容在最后一帧带 usage;Anthropic 分散在 message_start
    // (输入)与 message_delta(输出)里。拿不到就留 null,前端不展示。
    let mut usage_in: Option<i64> = None;
    let mut usage_out: Option<i64> = None;
    let started = std::time::Instant::now();
    loop {
        if abort_flag.load(std::sync::atomic::Ordering::Relaxed) {
            emit_evt(
                &app,
                "ai:done",
                json!({ "requestId": request_id, "finishReason": "aborted" }),
            );
            return Ok(());
        }
        // timeout 而非 select!:select 公平调度会在数据与 sleep 同时就绪时
        // 随机选 sleep,让每个 chunk 平白多等一帧 200ms,拖慢整体耗时;
        // timeout 只在流真正停顿 200ms 时才超时,超时仅用于醒来检查取消。
        let chunk = match tokio::time::timeout(std::time::Duration::from_millis(200), stream.next())
            .await
        {
            Ok(c) => c,
            Err(_) => continue,
        };
        let bytes = match chunk {
            Some(b) => b.map_err(|e| e.to_string())?,
            None => break,
        };
        // 字节级缓冲,不能按 chunk 逐个 from_utf8_lossy:TCP 分块边界会把
        // 多字节汉字拦腰截断,两次"有损转换"正好把一个字变两个 �(乱码)。
        // SSE 以 \n 分帧,攒到完整行再解码 —— 行内字符此时必然完整。
        buffer.extend_from_slice(&bytes);
        let mut start = 0usize;
        while let Some(pos) = buffer[start..].iter().position(|&b| b == b'\n') {
            let line_bytes = &buffer[start..start + pos];
            start += pos + 1;
            let line = String::from_utf8_lossy(line_bytes).to_string();
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
                    done_payload(&request_id, "stop", usage_in, usage_out, started),
                );
                return Ok(());
            }
            let evt: Value = match serde_json::from_str(data) {
                Ok(v) => v,
                Err(_) => continue,
            };
            collect_usage(protocol.as_str(), &evt, &mut usage_in, &mut usage_out);
            match emit_deltas(&app, &request_id, protocol.as_str(), &evt) {
                Ok(FrameOutcome::Continue) => {}
                // Anthropic 用 message_stop 收尾,语义与 [DONE] 相同
                Ok(FrameOutcome::Done) => {
                    emit_evt(
                        &app,
                        "ai:done",
                        done_payload(&request_id, "stop", usage_in, usage_out, started),
                    );
                    return Ok(());
                }
                Err(e) => return Err(e),
            }
        }
        buffer.drain(..start);
    }
    emit_evt(
        &app,
        "ai:done",
        done_payload(&request_id, "end", usage_in, usage_out, started),
    );
    Ok(())
}

/// 结束事件附带耗时(毫秒)与 token 用量,缺省字段以 null 透传
fn done_payload(
    request_id: &str,
    finish: &str,
    usage_in: Option<i64>,
    usage_out: Option<i64>,
    started: std::time::Instant,
) -> Value {
    json!({
        "requestId": request_id,
        "finishReason": finish,
        "elapsedMs": started.elapsed().as_millis() as u64,
        "usage": {
            "promptTokens": usage_in,
            "completionTokens": usage_out,
        },
    })
}

/// 从一帧 SSE 里提取 token 用量,其余字段忽略
fn collect_usage(
    protocol: &str,
    evt: &Value,
    usage_in: &mut Option<i64>,
    usage_out: &mut Option<i64>,
) {
    let u = if protocol == "anthropic" {
        match evt["type"].as_str().unwrap_or("") {
            // message_start 的 message.usage 只有输入;输出计数后续由 message_delta 累加
            "message_start" => Some(evt["message"]["usage"].clone()),
            "message_delta" => Some(evt["usage"].clone()),
            _ => None,
        }
    } else {
        evt["usage"].as_object().map(|_| evt["usage"].clone())
    };
    let Some(u) = u else { return };
    if let Some(v) = u["prompt_tokens"]
        .as_i64()
        .or_else(|| u["input_tokens"].as_i64())
    {
        *usage_in = Some(v);
    }
    if let Some(v) = u["completion_tokens"]
        .as_i64()
        .or_else(|| u["output_tokens"].as_i64())
    {
        *usage_out = Some(v);
    }
}

/// 一帧 SSE 事件的解析结果
enum FrameOutcome {
    /// 普通增量,继续读流
    Continue,
    /// 流正常收尾(Anthropic 的 message_stop)
    Done,
}

/// 解析一帧 SSE 事件并广播增量文本。OpenAI 与 Anthropic 的字段名不同,在这里
/// 归一;两种协议的流式错误都转成 Err(与旧的逐帧返回语义一致)。
fn emit_deltas<R: tauri::Runtime, E: tauri::Emitter<R> + Clone + Send + Sync + 'static>(
    app: &E,
    request_id: &str,
    protocol: &str,
    evt: &Value,
) -> Result<FrameOutcome, String> {
    if protocol == "anthropic" {
        match evt["type"].as_str().unwrap_or("") {
            "content_block_delta" => {
                if let Some(text) = evt["delta"]["text"].as_str() {
                    emit_evt(
                        app,
                        "ai:delta",
                        json!({ "requestId": request_id, "text": text }),
                    );
                }
            }
            "message_stop" => return Ok(FrameOutcome::Done),
            "error" => {
                return Err(format!(
                    "AI API 错误: {}",
                    &evt.to_string()[..evt.to_string().len().min(300)]
                ));
            }
            _ => {}
        }
        return Ok(FrameOutcome::Continue);
    }
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
            app,
            "ai:delta",
            json!({ "requestId": request_id, "text": text }),
        );
    }
    Ok(FrameOutcome::Continue)
}

fn void<T>(_: &T) {}
pub fn b64(s: &str) -> String {
    base64::engine::general_purpose::STANDARD.encode(s.as_bytes())
}
