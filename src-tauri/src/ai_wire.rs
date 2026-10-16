//! AI 线协议适配：中立消息格式 ↔ OpenAI / Anthropic，以及流式工具调用的聚合。
//!
//! 前端历史只存中立格式（见 ai-host-tools-plan.md §2.1）：
//! `{role:'user'|'system', content}`、`{role:'assistant', content, toolCalls?,
//! reasoning?, thinkingBlocks?}`、`{role:'tool', toolCallId, name, content}`。
//! 两家协议对工具消息的形状、配对、角色交替要求各不相同，统一在这里转换。

use serde_json::{json, Map, Value};

/// Anthropic 的 tool_use id 只允许 `[a-zA-Z0-9_-]`；两侧用同一映射保证配对。
fn sanitize_id(id: &str) -> String {
    let s: String = id
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '_' || c == '-' {
                c
            } else {
                '_'
            }
        })
        .collect();
    if s.is_empty() {
        "call".to_string()
    } else {
        s
    }
}

fn text(v: &Value) -> String {
    v.as_str().unwrap_or("").to_string()
}

/// 最后一条用户消息的下标：此后的 assistant 才属于「当前工具循环」。
fn last_user_index(msgs: &[Value]) -> usize {
    msgs.iter().rposition(|m| m["role"] == "user").unwrap_or(0)
}

/// 不带工具发请求（模型不支持或已关闭）时，把工具往返压成普通文本，
/// 否则孤立的 tool 角色/调用会被服务端判为非法请求。
fn flatten_call(call: &Value) -> String {
    format!(
        "[调用工具 {}] {}",
        text(&call["name"]),
        text(&call["arguments"])
    )
}

pub fn to_openai_messages(messages: &Value, with_tools: bool) -> Value {
    let msgs = messages.as_array().cloned().unwrap_or_default();
    let current = last_user_index(&msgs);
    let mut out = Vec::new();
    for (i, m) in msgs.iter().enumerate() {
        let calls = m["toolCalls"].as_array().filter(|c| !c.is_empty());
        match m["role"].as_str().unwrap_or("") {
            "assistant" if calls.is_some() && with_tools => {
                let calls: Vec<Value> = calls
                    .unwrap()
                    .iter()
                    .map(|c| {
                        json!({
                            "id": text(&c["id"]),
                            "type": "function",
                            "function": { "name": text(&c["name"]), "arguments": text(&c["arguments"]) },
                        })
                    })
                    .collect();
                let content = text(&m["content"]);
                let mut msg = json!({
                    "role": "assistant",
                    "content": if content.is_empty() { Value::Null } else { json!(content) },
                    "tool_calls": calls,
                });
                // Kimi / DeepSeek 思考模式要求在同一轮工具循环里回传 reasoning_content。
                if i > current {
                    if let Some(r) = m["reasoning"].as_str().filter(|r| !r.is_empty()) {
                        msg["reasoning_content"] = json!(r);
                    }
                }
                out.push(msg);
            }
            "assistant" => {
                let mut content = text(&m["content"]);
                for c in calls.into_iter().flatten() {
                    content.push('\n');
                    content.push_str(&flatten_call(c));
                }
                out.push(json!({ "role": "assistant", "content": content.trim() }));
            }
            "tool" if with_tools => out.push(json!({
                "role": "tool",
                "tool_call_id": text(&m["toolCallId"]),
                "content": text(&m["content"]),
            })),
            "tool" => out.push(json!({
                "role": "user",
                "content": format!("[工具 {} 的结果]\n{}", text(&m["name"]), text(&m["content"])),
            })),
            role @ ("system" | "user") => {
                out.push(json!({ "role": role, "content": text(&m["content"]) }))
            }
            _ => {}
        }
    }
    Value::Array(out)
}

/// 返回 (system 文本, messages)。连续同角色消息合并为一条（Anthropic 要求交替），
/// tool 结果块排在同一条 user 消息的文本之前。
pub fn to_anthropic(messages: &Value, with_tools: bool) -> (Option<String>, Value) {
    let msgs = messages.as_array().cloned().unwrap_or_default();
    let current = last_user_index(&msgs);
    let system: Vec<String> = msgs
        .iter()
        .filter(|m| m["role"] == "system")
        .map(|m| text(&m["content"]))
        .collect();
    let mut out: Vec<(String, Vec<Value>)> = Vec::new();
    let mut push = |role: &str, blocks: Vec<Value>| {
        if blocks.is_empty() {
            return;
        }
        match out.last_mut() {
            Some((r, existing)) if r == role => existing.extend(blocks),
            _ => out.push((role.to_string(), blocks)),
        }
    };
    for (i, m) in msgs.iter().enumerate() {
        match m["role"].as_str().unwrap_or("") {
            "user" => {
                let t = text(&m["content"]);
                push(
                    "user",
                    vec![
                        json!({ "type": "text", "text": if t.is_empty() { " ".to_string() } else { t } }),
                    ],
                );
            }
            "assistant" => {
                let mut blocks = Vec::new();
                if with_tools && i > current {
                    for b in m["thinkingBlocks"].as_array().into_iter().flatten() {
                        if let Some(data) = b["redacted"].as_str() {
                            blocks.push(json!({ "type": "redacted_thinking", "data": data }));
                        } else {
                            blocks.push(json!({
                                "type": "thinking",
                                "thinking": text(&b["thinking"]),
                                "signature": text(&b["signature"]),
                            }));
                        }
                    }
                }
                let mut content = text(&m["content"]);
                let calls = m["toolCalls"].as_array().cloned().unwrap_or_default();
                if !with_tools {
                    for c in &calls {
                        content.push('\n');
                        content.push_str(&flatten_call(c));
                    }
                }
                let content = content.trim().to_string();
                if !content.is_empty() {
                    blocks.push(json!({ "type": "text", "text": content }));
                }
                if with_tools {
                    for c in &calls {
                        let input: Value =
                            serde_json::from_str(c["arguments"].as_str().unwrap_or(""))
                                .ok()
                                .filter(Value::is_object)
                                .unwrap_or_else(|| json!({}));
                        blocks.push(json!({
                            "type": "tool_use",
                            "id": sanitize_id(c["id"].as_str().unwrap_or("")),
                            "name": text(&c["name"]),
                            "input": input,
                        }));
                    }
                }
                push("assistant", blocks);
            }
            "tool" if with_tools => push(
                "user",
                vec![json!({
                    "type": "tool_result",
                    "tool_use_id": sanitize_id(m["toolCallId"].as_str().unwrap_or("")),
                    "content": text(&m["content"]),
                })],
            ),
            "tool" => push(
                "user",
                vec![json!({
                    "type": "text",
                    "text": format!("[工具 {} 的结果]\n{}", text(&m["name"]), text(&m["content"])),
                })],
            ),
            _ => {}
        }
    }
    let messages = out
        .into_iter()
        .map(|(role, mut blocks)| {
            // 纯文本保持字符串形态（与无工具时的旧请求一致）。
            if blocks.iter().all(|b| b["type"] == "text") {
                let joined: Vec<&str> = blocks.iter().filter_map(|b| b["text"].as_str()).collect();
                return json!({ "role": role, "content": joined.join("\n\n") });
            }
            // tool_result 必须排在同一条 user 消息的其他内容之前。
            blocks.sort_by_key(|b| u8::from(b["type"] != "tool_result"));
            json!({ "role": role, "content": blocks })
        })
        .collect();
    let system = (!system.is_empty()).then(|| system.join("\n"));
    (system, Value::Array(messages))
}

/// 工具定义（OpenAI function 形状 `{name, description, parameters}`）→ 线格式。
pub fn tools_for(protocol: &str, tools: &Value) -> Option<Value> {
    let list = tools.as_array().filter(|t| !t.is_empty())?;
    let mapped = list
        .iter()
        .map(|t| {
            if protocol == "anthropic" {
                json!({ "name": t["name"], "description": t["description"], "input_schema": t["parameters"] })
            } else {
                json!({ "type": "function", "function": { "name": t["name"], "description": t["description"], "parameters": t["parameters"] } })
            }
        })
        .collect();
    Some(Value::Array(mapped))
}

/// 服务端明确拒绝工具调用（模型或网关不支持）。只认请求格式类状态码：
/// 401/403/429 等鉴权、限流错误的文案里也可能出现 function 字样。
pub fn is_tools_unsupported(status: u16, body: &str) -> bool {
    if !matches!(status, 400 | 404 | 422) {
        return false;
    }
    let l = body.to_ascii_lowercase();
    (l.contains("tool") || l.contains("function"))
        && [
            "support",
            "unrecognized",
            "not allowed",
            "unknown",
            "invalid",
            "enable-auto-tool-choice",
            "not available",
        ]
        .iter()
        .any(|k| l.contains(k))
}

#[derive(Default)]
struct PendingCall {
    id: String,
    name: String,
    arguments: String,
}

#[derive(Default)]
struct Thinking {
    thinking: String,
    signature: String,
    redacted: Option<String>,
}

/// 流式响应里的工具调用、思考内容聚合器（每帧 feed 一次，结束时 finish）。
#[derive(Default)]
pub struct ToolAcc {
    calls: Vec<PendingCall>,
    /// OpenAI：delta.tool_calls[].index → calls 下标；Anthropic：内容块 index。
    by_index: Map<String, Value>,
    reasoning: String,
    thinking: Vec<Thinking>,
    thinking_index: Map<String, Value>,
}

impl ToolAcc {
    /// 返回新出现的工具名（供前端提前显示「正在准备调用…」）。
    pub fn feed(&mut self, protocol: &str, evt: &Value) -> Option<String> {
        if protocol == "anthropic" {
            return self.feed_anthropic(evt);
        }
        let choice = &evt["choices"][0];
        if let Some(r) = choice["delta"]["reasoning_content"].as_str() {
            self.reasoning.push_str(r);
        }
        let deltas = choice["delta"]["tool_calls"]
            .as_array()
            .or_else(|| choice["message"]["tool_calls"].as_array())?;
        let mut started = None;
        for d in deltas {
            let key = match d["index"].as_u64() {
                Some(i) => format!("i{i}"),
                None => match d["id"].as_str().filter(|s| !s.is_empty()) {
                    Some(id) => format!("id{id}"),
                    None => format!("i{}", self.calls.len().saturating_sub(1)),
                },
            };
            let slot = match self.by_index.get(&key).and_then(Value::as_u64) {
                Some(s) => s as usize,
                None => {
                    self.calls.push(PendingCall::default());
                    let s = self.calls.len() - 1;
                    self.by_index.insert(key, json!(s));
                    s
                }
            };
            let call = &mut self.calls[slot];
            if let Some(id) = d["id"].as_str().filter(|s| !s.is_empty()) {
                call.id = id.to_string();
            }
            if let Some(name) = d["function"]["name"].as_str().filter(|s| !s.is_empty()) {
                if call.name.is_empty() {
                    started = Some(name.to_string());
                }
                call.name = name.to_string();
            }
            match &d["function"]["arguments"] {
                Value::String(s) => call.arguments.push_str(s),
                Value::Object(_) => call.arguments = d["function"]["arguments"].to_string(),
                _ => {}
            }
        }
        started
    }

    fn feed_anthropic(&mut self, evt: &Value) -> Option<String> {
        let key = format!("i{}", evt["index"].as_u64().unwrap_or(0));
        match evt["type"].as_str().unwrap_or("") {
            "content_block_start" => {
                let block = &evt["content_block"];
                match block["type"].as_str().unwrap_or("") {
                    "tool_use" => {
                        self.calls.push(PendingCall {
                            id: text(&block["id"]),
                            name: text(&block["name"]),
                            arguments: String::new(),
                        });
                        self.by_index.insert(key, json!(self.calls.len() - 1));
                        return Some(text(&block["name"]));
                    }
                    "thinking" => {
                        self.thinking.push(Thinking {
                            thinking: text(&block["thinking"]),
                            ..Thinking::default()
                        });
                        self.thinking_index
                            .insert(key, json!(self.thinking.len() - 1));
                    }
                    "redacted_thinking" => self.thinking.push(Thinking {
                        redacted: Some(text(&block["data"])),
                        ..Thinking::default()
                    }),
                    _ => {}
                }
            }
            "content_block_delta" => {
                let d = &evt["delta"];
                match d["type"].as_str().unwrap_or("") {
                    "input_json_delta" => {
                        if let Some(slot) = self.by_index.get(&key).and_then(Value::as_u64) {
                            self.calls[slot as usize]
                                .arguments
                                .push_str(d["partial_json"].as_str().unwrap_or(""));
                        }
                    }
                    "thinking_delta" | "signature_delta" => {
                        if let Some(slot) = self.thinking_index.get(&key).and_then(Value::as_u64) {
                            let t = &mut self.thinking[slot as usize];
                            t.thinking.push_str(d["thinking"].as_str().unwrap_or(""));
                            t.signature.push_str(d["signature"].as_str().unwrap_or(""));
                        }
                    }
                    _ => {}
                }
            }
            _ => {}
        }
        None
    }

    /// 写入 ai:done 载荷：toolCalls / reasoning / thinkingBlocks（为空则不写）。
    pub fn attach(&self, payload: &mut Value) {
        let calls: Vec<Value> = self
            .calls
            .iter()
            .enumerate()
            .filter(|(_, c)| !c.name.is_empty())
            .map(|(i, c)| {
                let args = if c.arguments.trim().is_empty() {
                    "{}".to_string()
                } else {
                    c.arguments.clone()
                };
                let id = if c.id.is_empty() {
                    format!("call_{i}_{}", uuid::Uuid::new_v4().simple())
                } else {
                    c.id.clone()
                };
                json!({ "id": id, "name": c.name, "arguments": args })
            })
            .collect();
        if !calls.is_empty() {
            payload["toolCalls"] = Value::Array(calls);
        }
        if !self.reasoning.is_empty() {
            payload["reasoning"] = json!(self.reasoning);
        }
        let blocks: Vec<Value> = self
            .thinking
            .iter()
            .map(|t| match &t.redacted {
                Some(data) => json!({ "redacted": data }),
                None => json!({ "thinking": t.thinking, "signature": t.signature }),
            })
            .collect();
        if !blocks.is_empty() {
            payload["thinkingBlocks"] = Value::Array(blocks);
        }
    }
}

#[cfg(test)]
#[path = "ai_wire_test.rs"]
mod tests;
