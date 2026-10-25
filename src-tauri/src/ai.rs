// AI 助手:OpenAI 兼容 / Anthropic 双协议流式客户端(SSE)+ 模型列表发现
use base64::Engine;
use futures::StreamExt;
use serde_json::{json, Value};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

pub const AI_IDLE_TIMEOUT: Duration = Duration::from_secs(60);

/// commands.rs 对 models/chat 共用此解析器:空草稿字段不偷偷回退,旧密钥只属于
/// 已保存的协议 + 完整 Base URL(忽略空白和尾部斜杠,不忽略路径/查询/大小写)。
pub struct AiRequestConfig {
    pub protocol: String,
    pub base_url: String,
    pub model: String,
    pub api_key: String,
    pub max_tokens: Option<i64>,
    pub reasoning_params: Option<Value>,
}

pub fn same_endpoint(a: &Value, b: &Value) -> bool {
    let protocol = |v: &Value| {
        v["protocol"]
            .as_str()
            .filter(|s| !s.is_empty())
            .unwrap_or("openai")
            .to_string()
    };
    let base = |v: &Value| {
        v["baseUrl"]
            .as_str()
            .unwrap_or("")
            .trim()
            .trim_end_matches('/')
            .to_string()
    };
    protocol(a) == protocol(b) && !base(a).is_empty() && base(a) == base(b)
}

pub fn resolve_request_config(
    saved: &Value,
    override_ai: Option<&Value>,
    saved_key: &str,
) -> AiRequestConfig {
    let mut requested = saved.clone();
    if let Some(ov) = override_ai.filter(|v| v.is_object()) {
        for field in ["protocol", "baseUrl", "model"] {
            if let Some(value) = ov.get(field).filter(|v| v.is_string()) {
                requested[field] = value.clone();
            }
        }
    }
    let ov = override_ai.unwrap_or(&Value::Null);
    let explicit_key = ov["apiKey"].as_str().unwrap_or("").trim();
    let clear = ov["clearApiKey"].as_bool().unwrap_or(false);
    let allow_saved = ov["useSavedApiKey"].as_bool().unwrap_or(true);
    let api_key = if clear {
        String::new()
    } else if !explicit_key.is_empty() {
        explicit_key.to_string()
    } else if allow_saved && same_endpoint(saved, &requested) {
        saved_key.to_string()
    } else {
        String::new()
    };
    let max_tokens = ov
        .get("maxTokens")
        .or_else(|| ov.get("max_tokens"))
        .and_then(|v| v.as_i64());
    let reasoning_params = ov
        .get("reasoningParams")
        .or_else(|| ov.get("reasoning_params"))
        .filter(|v| v.is_object())
        .cloned();
    AiRequestConfig {
        protocol: requested["protocol"]
            .as_str()
            .filter(|s| !s.is_empty())
            .unwrap_or("openai")
            .to_string(),
        base_url: requested["baseUrl"]
            .as_str()
            .unwrap_or("")
            .trim()
            .to_string(),
        model: requested["model"].as_str().unwrap_or("").trim().to_string(),
        api_key,
        max_tokens,
        reasoning_params,
    }
}

// 取消覆盖等待 HTTP headers/error body/流式 chunk 的每一段,而不是仅在有 chunk
// 之后检查。固定 pin 住操作;轮询 timeout 不能重发请求或丢掉半个网络操作。
async fn wait_cancellable<F: std::future::Future>(
    operation: F,
    abort: &AtomicBool,
    idle_timeout: Duration,
) -> Result<Option<F::Output>, String> {
    tokio::pin!(operation);
    let started = Instant::now();
    loop {
        if abort.load(Ordering::Relaxed) {
            return Ok(None);
        }
        let remaining = idle_timeout.saturating_sub(started.elapsed());
        if remaining.is_zero() {
            return Err("AI 响应超时（60 秒未收到数据），请重试".into());
        }
        match tokio::time::timeout(remaining.min(Duration::from_millis(100)), &mut operation).await
        {
            Ok(value) => {
                if abort.load(Ordering::Relaxed) {
                    return Ok(None);
                }
                return Ok(Some(value));
            }
            Err(_) => continue,
        }
    }
}

fn error_excerpt(text: &str, limit: usize) -> String {
    // HTTP/API 错误可能有汉字,按 byte 切片会在 UTF-8 中间 panic。
    text.chars().take(limit).collect()
}

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
    // 不跨重定向发送认证头,尤其 x-api-key 不享受 Bearer 的跨域剥离规则。
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(15))
        .build()
        .map_err(|e| e.to_string())?;
    let mut req = client.get(&url).timeout(Duration::from_secs(20));
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
            error_excerpt(&t, 200)
        ));
    }
    let j: Value = res.json().await.map_err(|e| e.to_string())?;
    let list = j["data"].as_array().cloned().unwrap_or_default();
    let out = parse_model_entries(&list);
    if out.is_empty() {
        return Err("端点未返回任何模型,请确认 Base URL 是否到 /v1 级别".into());
    }
    Ok(out)
}

/// 把各家 /models 的条目归一成前端用的结构。
/// 抽成纯函数以便单测:上游字段的别名覆盖(OpenAI / Anthropic / OpenRouter /
/// DeepSeek)是这里最容易出错、也最需要固定下来的部分。
pub fn parse_model_entries(list: &[Value]) -> Vec<Value> {
    let mut out: Vec<Value> = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for m in list {
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
        // 上下文窗口:OpenRouter 用 context_length,DeepSeek 用 context_window,
        // 其余是各家常见别名。拿不到就传 null,由前端按模型 ID 推导兜底。
        let context = m["context_length"]
            .as_i64()
            .or_else(|| m["context_window"].as_i64())
            .or_else(|| m["max_input_tokens"].as_i64())
            .or_else(|| m["max_model_len"].as_i64())
            .or_else(|| m["top_provider"]["context_length"].as_i64());
        // 最大输出同理由上游给(DeepSeek 用 max_output_tokens)。
        let max_output = m["max_output_tokens"]
            .as_i64()
            .or_else(|| m["max_completion_tokens"].as_i64())
            .or_else(|| m["max_tokens"].as_i64());
        // 推理档位:DeepSeek 新版 /models 直接给 effort.supported_levels,
        // 这是"上游权威值",优先于前端按 ID 猜的那套。
        let effort_levels = m["effort"]["supported_levels"].as_array().map(|a| {
            a.iter()
                .filter_map(|v| v.as_str())
                .map(|s| s.to_string())
                .collect::<Vec<_>>()
        });
        let effort_default = m["effort"]["default_level"].as_str().map(|s| s.to_string());
        // 视觉能力:OpenRouter 走 architecture.input_modalities,
        // DeepSeek / 其余用扁平的 input_modalities。
        let vision = m["architecture"]["input_modalities"]
            .as_array()
            .or_else(|| m["input_modalities"].as_array())
            .map(|a| a.iter().any(|v| v.as_str() == Some("image")))
            .unwrap_or(false);
        out.push(json!({
            "id": id,
            "name": name,
            "ownedBy": owned_by,
            "created": created,
            "context": context,
            "maxOutput": max_output,
            "effortLevels": effort_levels,
            "effortDefault": effort_default,
            "vision": vision,
        }));
    }
    out
}

/// 服务端拒绝工具调用时 Err 文本的前缀；commands 据此给 ai:error 加 code。
pub const TOOLS_UNSUPPORTED: &str = "[tools_unsupported]";

/// 流式对话;每 250ms 一帧,SSE 逐行解析(与 Electron 版 ai.js 语义一致)。
/// 生产路径走 chat_stream_with_tools;这里保留给不带工具的既有测试。
#[cfg(test)]
#[allow(clippy::too_many_arguments)]
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
    chat_stream_with_tools(
        app,
        request_id,
        protocol,
        base_url,
        api_key,
        model,
        messages,
        Value::Null,
        None,
        None,
        abort_flag,
    )
    .await
}

/// 同上，可带工具定义；messages 为中立格式（见 ai_wire）。工具调用随 ai:done
/// 的 toolCalls 字段返回，由前端执行后再发下一轮。
#[allow(clippy::too_many_arguments)]
pub async fn chat_stream_with_tools<
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
    tools: Value,
    max_tokens: Option<i64>,
    reasoning_params: Option<Value>,
    abort_flag: std::sync::Arc<std::sync::atomic::AtomicBool>,
) -> Result<(), String> {
    let started = Instant::now();
    let wire_tools = crate::ai_wire::tools_for(&protocol, &tools);
    let with_tools = wire_tools.is_some();
    if abort_flag.load(Ordering::Relaxed) {
        emit_evt(
            &app,
            "ai:done",
            done_payload(&request_id, "aborted", Usage::default(), started),
        );
        return Ok(());
    }
    if base_url.trim().is_empty() {
        return Err("未配置 API Base URL,请先打开 AI 设置".into());
    }
    if model.trim().is_empty() {
        return Err("未配置模型名称,请先打开 AI 设置".into());
    }
    // 不跨重定向发送认证头,尤其 x-api-key 不享受 Bearer 的跨域剥离规则。
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(15))
        .build()
        .map_err(|e| e.to_string())?;
    let (url, body, req) = if protocol == "anthropic" {
        let url = format!("{}/messages", base_url.trim().trim_end_matches('/'));
        let (system, msgs) = crate::ai_wire::to_anthropic(&messages, with_tools);
        let max_tok = max_tokens.unwrap_or(4096);
        let mut body = json!({
            "model": model, "max_tokens": max_tok,
            "system": system,
            "messages": msgs, "stream": true
        });
        if let Some(t) = &wire_tools {
            body["tools"] = t.clone();
        }
        if let Some(rp) = &reasoning_params {
            if let Some(obj) = rp.as_object() {
                for (k, v) in obj {
                    body[k] = v.clone();
                }
            }
        }
        let r = client
            .post(&url)
            .header("x-api-key", &api_key)
            .header("anthropic-version", "2023-06-01")
            .json(&body);
        (url, body, r)
    } else {
        let url = format!("{}/chat/completions", base_url.trim().trim_end_matches('/'));
        // include_usage:OpenAI 兼容流式默认不带 usage,显式请求后最后一帧会附带
        let mut body = json!({
            "model": model,
            "messages": crate::ai_wire::to_openai_messages(&messages, with_tools),
            "stream": true,
            "stream_options": { "include_usage": true }
        });
        if let Some(mt) = max_tokens {
            body["max_tokens"] = json!(mt);
        }
        // 不发 tool_choice:默认即 auto,部分兼容网关对显式 tool_choice 另有开关要求。
        if let Some(t) = &wire_tools {
            body["tools"] = t.clone();
        }
        if let Some(rp) = &reasoning_params {
            if let Some(obj) = rp.as_object() {
                for (k, v) in obj {
                    body[k] = v.clone();
                }
            }
        }
        // 不发 tool_choice:默认即 auto,部分兼容网关对显式 tool_choice 另有开关要求。
        if let Some(t) = &wire_tools {
            body["tools"] = t.clone();
        }
        let mut r = client.post(&url).json(&body);
        if !api_key.is_empty() {
            r = r.header("authorization", format!("Bearer {}", api_key));
        }
        (url, body, r)
    };
    void(&url);
    void(&body);

    let Some(response) = wait_cancellable(req.send(), &abort_flag, AI_IDLE_TIMEOUT).await? else {
        emit_evt(
            &app,
            "ai:done",
            done_payload(&request_id, "aborted", Usage::default(), started),
        );
        return Ok(());
    };
    let res = response.map_err(|e| format!("AI 请求失败: {}", e))?;
    // 响应头到达即发心跳:前端 60 秒空闲计时只看"收没收到事件",不区分内容,
    // 慢网关下首帧 SSE 之前的这段时间也必须计入活跃。
    emit_evt(&app, "ai:progress", json!({ "requestId": request_id }));
    if !res.status().is_success() {
        let status = res.status();
        let Some(text) = wait_cancellable(res.text(), &abort_flag, AI_IDLE_TIMEOUT).await? else {
            emit_evt(
                &app,
                "ai:done",
                done_payload(&request_id, "aborted", Usage::default(), started),
            );
            return Ok(());
        };
        let text = text.unwrap_or_default();
        let prefix = if with_tools && crate::ai_wire::is_tools_unsupported(status.as_u16(), &text) {
            TOOLS_UNSUPPORTED
        } else {
            ""
        };
        return Err(format!(
            "{prefix}AI 请求失败 HTTP {}: {}",
            status,
            error_excerpt(&text, 300)
        ));
    }

    let mut stream = res.bytes_stream();
    // 未消费的 SSE 字节(以行为单位攒);用字节缓冲是为了让跨 chunk 的
    // 多字节字符在被解码前保持完整,见下方 decode 处的注释
    let mut buffer: Vec<u8> = Vec::new();
    // token 用量:OpenAI 兼容在最后一帧带 usage;Anthropic 分散在 message_start
    // (输入)与 message_delta(输出)里。拿不到就留 null,前端不展示。
    let mut usage = Usage::default();
    // 结束标记只说明传输完成;明确的截断原因必须跨帧保留,不能被 usage 帧覆盖。
    let mut finish_reason: Option<String> = None;
    let mut acc = crate::ai_wire::ToolAcc::default();
    let finished = |finish: &str, usage: Usage, acc: &crate::ai_wire::ToolAcc| {
        let mut payload = done_payload(&request_id, finish, usage, started);
        acc.attach(&mut payload);
        payload
    };
    loop {
        let Some(chunk) = wait_cancellable(stream.next(), &abort_flag, AI_IDLE_TIMEOUT).await?
        else {
            emit_evt(
                &app,
                "ai:done",
                done_payload(&request_id, "aborted", usage, started),
            );
            return Ok(());
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
                // 非 data 行(event:/冒号注释)也是活跃信号:网关 keep-alive
                // 注释常在长静默期到达,漏掉会被前端误判空闲超时。
                if !trimmed.is_empty() {
                    emit_evt(&app, "ai:progress", json!({ "requestId": request_id }));
                }
                continue;
            }
            let data = trimmed[5..].trim();
            if data.is_empty() {
                continue;
            }
            if data == "[DONE]" {
                let finish = finish_reason.as_deref().unwrap_or("stop");
                emit_evt(&app, "ai:done", finished(finish, usage, &acc));
                return Ok(());
            }
            let evt: Value = match serde_json::from_str(data) {
                Ok(v) => v,
                Err(_) => continue,
            };
            collect_usage(protocol.as_str(), &evt, &mut usage);
            collect_finish_reason(protocol.as_str(), &evt, &mut finish_reason);
            if let Some(name) = acc.feed(&protocol, &evt) {
                emit_evt(
                    &app,
                    "ai:tool-delta",
                    json!({ "requestId": request_id, "name": name }),
                );
            }
            match emit_deltas(&app, &request_id, protocol.as_str(), &evt) {
                Ok(FrameOutcome::Continue) => {}
                // Anthropic 用 message_stop 收尾,保留此前 message_delta 的明确原因
                Ok(FrameOutcome::Done) => {
                    let finish = finish_reason.as_deref().unwrap_or("stop");
                    emit_evt(&app, "ai:done", finished(finish, usage, &acc));
                    return Ok(());
                }
                Err(e) => return Err(e),
            }
        }
        buffer.drain(..start);
    }
    emit_evt(&app, "ai:done", finished("end", usage, &acc));
    Ok(())
}

/// SSE 累计的 token 用量。缓存相关字段各家命名不同,统一归一到这两个:
/// cache_read(命中缓存、按低价计费的输入)与 cache_write(写入缓存)。
/// 前端据此算命中率;拿不到就保持 None,界面隐藏该行而不是显示 0。
#[derive(Default, Clone, Copy)]
struct Usage {
    input: Option<i64>,
    output: Option<i64>,
    cache_read: Option<i64>,
    cache_write: Option<i64>,
}

/// 结束事件附带耗时(毫秒)与 token 用量,缺省字段以 null 透传
fn done_payload(
    request_id: &str,
    finish: &str,
    usage: Usage,
    started: std::time::Instant,
) -> Value {
    json!({
        "requestId": request_id,
        "finishReason": finish,
        "elapsedMs": started.elapsed().as_millis() as u64,
        "usage": {
            "promptTokens": usage.input,
            "completionTokens": usage.output,
            "cacheReadTokens": usage.cache_read,
            "cacheWriteTokens": usage.cache_write,
        },
    })
}

/// 从一帧 SSE 里提取 token 用量,其余字段忽略
fn collect_usage(protocol: &str, evt: &Value, usage: &mut Usage) {
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
        usage.input = Some(v);
    }
    if let Some(v) = u["completion_tokens"]
        .as_i64()
        .or_else(|| u["output_tokens"].as_i64())
    {
        usage.output = Some(v);
    }
    // 缓存字段按协议取,顺序覆盖为"后到的帧更新":
    //   Anthropic: message.usage.cache_read_input_tokens / cache_creation_input_tokens
    //   DeepSeek:  usage.prompt_cache_hit_tokens / prompt_cache_miss_tokens
    //   OpenAI:    usage.prompt_tokens_details.cached_tokens(只报命中,不报写入)
    if protocol == "anthropic" {
        if let Some(v) = u["cache_read_input_tokens"].as_i64() {
            usage.cache_read = Some(v);
        }
        if let Some(v) = u["cache_creation_input_tokens"].as_i64() {
            usage.cache_write = Some(v);
        }
    } else {
        if let Some(v) = u["prompt_cache_hit_tokens"]
            .as_i64()
            .or_else(|| u["prompt_tokens_details"]["cached_tokens"].as_i64())
        {
            usage.cache_read = Some(v);
        }
        if let Some(v) = u["prompt_cache_miss_tokens"].as_i64() {
            // miss 是"未命中"的那部分,换算成写入侧仅供展示参考;
            // 命中率分母用 命中+未命中。
            usage.cache_write = Some(v);
        }
    }
}

/// 仅供应商明确的正常结束归一为 stop;其余原因原样传播,由前端 incomplete 兜底。
/// stop_sequence 可能截断命令块,保守不视为正常完成。缺省/null/空原因不覆盖已保存值。
fn collect_finish_reason(protocol: &str, evt: &Value, finish_reason: &mut Option<String>) {
    let reason = if protocol == "anthropic" {
        if evt["type"] != "message_delta" {
            return;
        }
        evt["delta"]["stop_reason"].as_str()
    } else {
        evt["choices"][0]["finish_reason"].as_str()
    };
    if let Some(reason) = reason.filter(|reason| !reason.is_empty()) {
        let normalized = match (protocol, reason) {
            ("anthropic", "end_turn") => "stop",
            _ => reason,
        };
        *finish_reason = Some(normalized.to_string());
    }
}

/// 一帧 SSE 事件的解析结果
enum FrameOutcome {
    /// 普通增量,继续读流
    Continue,
    /// 收到流结束标记(Anthropic 的 message_stop),不代表内容正常完成
    Done,
}

/// 解析一帧 SSE 事件并广播增量文本。OpenAI 与 Anthropic 的字段名不同,在这里
/// 归一;两种协议的流式错误都转成 Err(与旧的逐帧返回语义一致)。
/// 思考内容(reasoning/thinking)与 usage/finish 等非内容帧一律以 ai:progress
/// 心跳转发:前端 60 秒空闲计时以"收到过事件"为准 —— 模型纯思考不产出正文时
/// 连接其实活跃,若不心跳会被前端误判超时并 abort(服务端侧表现为 HTTP 499)。
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
                } else if let Some(text) = evt["delta"]["thinking"].as_str() {
                    if !text.is_empty() {
                        emit_evt(
                            app,
                            "ai:thinking",
                            json!({ "requestId": request_id, "text": text }),
                        );
                    }
                } else {
                    // 工具参数(input_json_delta)、签名等分片:不是正文,但流仍活跃。
                    emit_evt(app, "ai:progress", json!({ "requestId": request_id }));
                }
            }
            "message_stop" => return Ok(FrameOutcome::Done),
            "error" => {
                return Err(format!(
                    "AI API 错误: {}",
                    error_excerpt(&evt.to_string(), 300)
                ));
            }
            _ => emit_evt(app, "ai:progress", json!({ "requestId": request_id })),
        }
        return Ok(FrameOutcome::Continue);
    }
    if !evt["error"].is_null() {
        return Err(format!(
            "AI API 错误: {}",
            error_excerpt(&evt["error"].to_string(), 300)
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
    } else if let Some(think) = delta["reasoning_content"]
        .as_str()
        .filter(|t| !t.is_empty())
        .or_else(|| delta["reasoning"].as_str().filter(|t| !t.is_empty()))
    {
        emit_evt(
            app,
            "ai:thinking",
            json!({ "requestId": request_id, "text": think }),
        );
    } else if !delta["role"].is_null()
        || !delta["tool_calls"].is_null()
        || !evt["choices"][0]["finish_reason"].is_null()
        || !evt["usage"].is_null()
    {
        // role 帧、收尾帧证明流仍活着,但不能作为正文转发。
        emit_evt(app, "ai:progress", json!({ "requestId": request_id }));
    }
    Ok(FrameOutcome::Continue)
}

fn void<T>(_: &T) {}
pub fn b64(s: &str) -> String {
    base64::engine::general_purpose::STANDARD.encode(s.as_bytes())
}

#[cfg(test)]
mod ux_tests {
    // 复用原有测试与 mock_app Emitter,新增回归只放在本文件。
    include!("ai_ux_test.rs");

    async fn finish_reason_sse_events(
        protocol: &str,
        reason: Option<&str>,
        terminal_marker: bool,
    ) -> Vec<Value> {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = format!("http://{}/v1", listener.local_addr().unwrap());
        let (frames, terminal) = if protocol == "anthropic" {
            (
                vec![
                    json!({"type":"message_start","message":{"stop_reason":null,"usage":{"input_tokens":10}}}),
                    json!({"type":"content_block_delta","delta":{"text":"中文"}}),
                    json!({"type":"message_delta","delta":{"stop_reason":reason},"usage":{"output_tokens":2}}),
                    // 后续缺省原因的 usage 帧不得覆盖明确原因,仍应解析最新用量。
                    json!({"type":"message_delta","delta":{"stop_reason":null},"usage":{"output_tokens":9}}),
                ],
                "data: {\"type\":\"message_stop\"}\n\n",
            )
        } else {
            (
                vec![
                    json!({"choices":[{"delta":{"content":"中文"},"finish_reason":null}]}),
                    json!({"choices":[{"delta":{},"finish_reason":reason}]}),
                    json!({"choices":[{"delta":{},"finish_reason":null}]}),
                    // OpenAI usage-only 帧通常在 finish_reason 后、[DONE] 前到达。
                    json!({"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":9}}),
                ],
                "data: [DONE]\n\n",
            )
        };
        let reason_frame = frames[if protocol == "anthropic" { 2 } else { 1 }].to_string();
        let mut body: String = frames
            .iter()
            .map(|frame| format!("data: {frame}\n\n"))
            .collect();
        if terminal_marker {
            body.push_str(terminal);
        }
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = [0; 4096];
            socket.read(&mut request).await.unwrap();
            let headers = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                body.len()
            );
            socket.write_all(headers.as_bytes()).await.unwrap();
            // 与现有 HTTP SSE 测试一样跨 TCP 写入拆开 UTF-8,同时拆开原因字段。
            let utf8_split = body.find('中').unwrap() + 1;
            let reason_field = if body.contains("finish_reason") {
                "finish_reason"
            } else {
                "stop_reason"
            };
            let reason_split = body.find(&reason_frame).unwrap()
                + reason_frame.find(reason_field).unwrap()
                + reason_field.len()
                + 4;
            for part in [
                &body.as_bytes()[..utf8_split],
                &body.as_bytes()[utf8_split..reason_split],
                &body.as_bytes()[reason_split..],
            ] {
                socket.write_all(part).await.unwrap();
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        });
        let app = mock_app();
        let events = Arc::new(Mutex::new(Vec::<Value>::new()));
        for name in ["ai__delta", "ai__done"] {
            let captured = events.clone();
            app.listen(name, move |evt| {
                captured
                    .lock()
                    .unwrap()
                    .push(serde_json::from_str(evt.payload()).unwrap());
            });
        }
        tokio::time::timeout(
            Duration::from_secs(5),
            chat_stream(
                app,
                "finish-reason".into(),
                protocol.into(),
                endpoint,
                "".into(),
                "manual-model".into(),
                json!([{"role":"user","content":"test"}]),
                Arc::new(AtomicBool::new(false)),
            ),
        )
        .await
        .unwrap()
        .unwrap();
        server.await.unwrap();
        let events = events.lock().unwrap().clone();
        assert_eq!(
            events.len(),
            2,
            "one delta and exactly one done: {events:?}"
        );
        assert_eq!(events[0]["requestId"], "finish-reason");
        assert_eq!(events[0]["text"], "中文");
        assert_eq!(events[1]["requestId"], "finish-reason");
        assert_eq!(events[1]["usage"]["promptTokens"], 10);
        assert_eq!(events[1]["usage"]["completionTokens"], 9);
        assert!(events[1]["elapsedMs"].is_number());
        events
    }

    #[tokio::test]
    async fn http_sse_openai_normal_stop() {
        let events = finish_reason_sse_events("openai", Some("stop"), true).await;
        assert_eq!(events[1]["finishReason"], "stop");
    }

    #[tokio::test]
    async fn http_sse_openai_length_is_incomplete() {
        let events = finish_reason_sse_events("openai", Some("length"), true).await;
        assert_eq!(events[1]["finishReason"], "length");
    }

    #[tokio::test]
    async fn http_sse_openai_content_filter_is_incomplete() {
        let events = finish_reason_sse_events("openai", Some("content_filter"), true).await;
        assert_eq!(events[1]["finishReason"], "content_filter");
    }

    #[tokio::test]
    async fn http_sse_anthropic_max_tokens_is_incomplete() {
        let events = finish_reason_sse_events("anthropic", Some("max_tokens"), true).await;
        assert_eq!(events[1]["finishReason"], "max_tokens");
    }

    #[tokio::test]
    async fn http_sse_anthropic_end_turn_is_normal_stop() {
        let events = finish_reason_sse_events("anthropic", Some("end_turn"), true).await;
        assert_eq!(events[1]["finishReason"], "stop");
    }

    #[tokio::test]
    async fn http_sse_anthropic_stop_sequence_is_conservatively_incomplete() {
        let events = finish_reason_sse_events("anthropic", Some("stop_sequence"), true).await;
        assert_eq!(events[1]["finishReason"], "stop_sequence");
    }

    #[tokio::test]
    async fn http_sse_other_explicit_reasons_remain_incomplete() {
        for (protocol, reason) in [
            ("openai", "tool_calls"),
            ("openai", "vendor_limit"),
            ("anthropic", "tool_use"),
            ("anthropic", "refusal"),
        ] {
            let events = finish_reason_sse_events(protocol, Some(reason), true).await;
            assert_eq!(events[1]["finishReason"], reason);
        }
    }

    #[tokio::test]
    async fn http_sse_terminal_without_explicit_reason_defaults_to_stop() {
        for protocol in ["openai", "anthropic"] {
            for reason in [None, Some("")] {
                let events = finish_reason_sse_events(protocol, reason, true).await;
                assert_eq!(events[1]["finishReason"], "stop");
            }
        }
    }

    #[tokio::test]
    async fn http_sse_eof_stays_end_even_with_explicit_reason() {
        for (protocol, reason) in [
            ("openai", None),
            ("openai", Some("stop")),
            ("openai", Some("length")),
            ("anthropic", None),
            ("anthropic", Some("end_turn")),
            ("anthropic", Some("max_tokens")),
        ] {
            let events = finish_reason_sse_events(protocol, reason, false).await;
            assert_eq!(events[1]["finishReason"], "end");
        }
    }
}
