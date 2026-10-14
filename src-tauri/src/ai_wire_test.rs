use super::*;

fn history() -> Value {
    json!([
        { "role": "system", "content": "SYS" },
        { "role": "user", "content": "旧问题" },
        { "role": "assistant", "content": "旧答案", "reasoning": "old-think",
          "toolCalls": [{ "id": "call_old", "name": "host_info", "arguments": "{}" }] },
        { "role": "tool", "toolCallId": "call_old", "name": "host_info", "content": "Ubuntu" },
        { "role": "user", "content": "网站 502" },
        { "role": "assistant", "content": "", "reasoning": "think",
          "toolCalls": [
            { "id": "call.1", "name": "tail_file", "arguments": "{\"path\":\"/var/log/nginx/error.log\"}" },
            { "id": "call_2", "name": "exec", "arguments": "{\"cmd\":\"uptime\"}" }
          ] },
        { "role": "tool", "toolCallId": "call.1", "name": "tail_file", "content": "upstream timed out" },
        { "role": "tool", "toolCallId": "call_2", "name": "exec", "content": "load 9.0" }
    ])
}

#[test]
fn openai_messages_keep_tool_pairs_and_current_reasoning() {
    let out = to_openai_messages(&history(), true);
    let a = out.as_array().unwrap();
    assert_eq!(a.len(), 8);
    assert_eq!(a[2]["tool_calls"][0]["function"]["name"], "host_info");
    assert!(a[2].get("reasoning_content").is_none(), "旧回合不回传思考");
    assert_eq!(a[5]["reasoning_content"], "think");
    assert_eq!(a[5]["content"], Value::Null);
    assert_eq!(a[5]["tool_calls"][1]["type"], "function");
    assert_eq!(
        a[6],
        json!({ "role": "tool", "tool_call_id": "call.1", "content": "upstream timed out" })
    );
}

#[test]
fn openai_flattens_tools_when_disabled() {
    let out = to_openai_messages(&history(), false);
    let a = out.as_array().unwrap();
    assert!(a
        .iter()
        .all(|m| m.get("tool_calls").is_none() && m["role"] != "tool"));
    assert!(a[5]["content"]
        .as_str()
        .unwrap()
        .contains("[调用工具 exec] {\"cmd\":\"uptime\"}"));
    assert!(a[7]["content"]
        .as_str()
        .unwrap()
        .starts_with("[工具 exec 的结果]"));
}

#[test]
fn anthropic_merges_tool_results_and_sanitizes_ids() {
    let (system, msgs) = to_anthropic(&history(), true);
    assert_eq!(system.as_deref(), Some("SYS"));
    let a = msgs.as_array().unwrap();
    let roles: Vec<&str> = a.iter().map(|m| m["role"].as_str().unwrap()).collect();
    assert_eq!(
        roles,
        ["user", "assistant", "user", "assistant", "user"],
        "角色必须交替"
    );
    let turn = &a[3]["content"];
    assert_eq!(turn[0]["type"], "tool_use");
    assert_eq!(turn[0]["id"], "call_1");
    assert_eq!(turn[0]["input"]["path"], "/var/log/nginx/error.log");
    let results = a[4]["content"].as_array().unwrap();
    assert_eq!(results.len(), 2);
    assert_eq!(results[0]["tool_use_id"], "call_1");
    // 旧回合的工具结果与新问题合并：tool_result 排在文本前。
    let mixed = a[2]["content"].as_array().unwrap();
    assert_eq!(mixed[0]["type"], "tool_result");
    assert_eq!(mixed[1]["text"], "网站 502");
}

#[test]
fn anthropic_flattens_tools_when_disabled() {
    let (_, msgs) = to_anthropic(&history(), false);
    let s = msgs.to_string();
    assert!(!s.contains("tool_use") && !s.contains("tool_result"));
    assert!(s.contains("[调用工具 tail_file]"));
}

#[test]
fn tool_definitions_per_protocol() {
    let tools = json!([{ "name": "exec", "description": "d", "parameters": { "type": "object" } }]);
    assert_eq!(
        tools_for("openai", &tools).unwrap()[0],
        json!({ "type": "function", "function": { "name": "exec", "description": "d", "parameters": { "type": "object" } } })
    );
    assert_eq!(
        tools_for("anthropic", &tools).unwrap()[0],
        json!({ "name": "exec", "description": "d", "input_schema": { "type": "object" } })
    );
    assert!(tools_for("openai", &json!([])).is_none());
    assert!(tools_for("openai", &Value::Null).is_none());
}

#[test]
fn openai_stream_fragments_are_aggregated() {
    let mut acc = ToolAcc::default();
    let frames = [
        json!({ "choices": [{ "delta": { "reasoning_content": "先看" } }] }),
        json!({ "choices": [{ "delta": { "tool_calls": [{ "index": 0, "id": "call_a", "type": "function", "function": { "name": "exec", "arguments": "" } }] } }] }),
        json!({ "choices": [{ "delta": { "tool_calls": [{ "index": 0, "function": { "arguments": "{\"cm" } }] } }] }),
        json!({ "choices": [{ "delta": { "tool_calls": [{ "index": 1, "id": "call_b", "function": { "name": "host_info" } }] } }] }),
        json!({ "choices": [{ "delta": { "tool_calls": [{ "index": 0, "function": { "arguments": "d\":\"ls\"}" } }] } }] }),
    ];
    let started: Vec<Option<String>> = frames.iter().map(|f| acc.feed("openai", f)).collect();
    assert_eq!(started[1].as_deref(), Some("exec"));
    assert_eq!(started[3].as_deref(), Some("host_info"));
    let mut done = json!({});
    acc.attach(&mut done);
    assert_eq!(
        done["toolCalls"],
        json!([
            { "id": "call_a", "name": "exec", "arguments": "{\"cmd\":\"ls\"}" },
            { "id": "call_b", "name": "host_info", "arguments": "{}" }
        ])
    );
    assert_eq!(done["reasoning"], "先看");
}

#[test]
fn openai_variants_without_index_or_with_object_arguments() {
    let mut acc = ToolAcc::default();
    acc.feed("openai", &json!({ "choices": [{ "delta": { "tool_calls": [{ "id": "x1", "function": { "name": "exec", "arguments": { "cmd": "df -h" } } }] } }] }));
    acc.feed("openai", &json!({ "choices": [{ "message": { "tool_calls": [{ "id": "x2", "function": { "name": "host_info", "arguments": "{}" } }] } }] }));
    let mut done = json!({});
    acc.attach(&mut done);
    assert_eq!(done["toolCalls"][0]["arguments"], "{\"cmd\":\"df -h\"}");
    assert_eq!(done["toolCalls"][1]["id"], "x2");
    let mut empty = json!({});
    ToolAcc::default().attach(&mut empty);
    assert_eq!(empty, json!({}), "没有工具调用时不写字段");
}

#[test]
fn anthropic_stream_blocks_are_aggregated() {
    let mut acc = ToolAcc::default();
    let frames = [
        json!({ "type": "content_block_start", "index": 0, "content_block": { "type": "thinking", "thinking": "" } }),
        json!({ "type": "content_block_delta", "index": 0, "delta": { "type": "thinking_delta", "thinking": "需要看日志" } }),
        json!({ "type": "content_block_delta", "index": 0, "delta": { "type": "signature_delta", "signature": "sig==" } }),
        json!({ "type": "content_block_start", "index": 1, "content_block": { "type": "text", "text": "" } }),
        json!({ "type": "content_block_start", "index": 2, "content_block": { "type": "tool_use", "id": "toolu_1", "name": "tail_file", "input": {} } }),
        json!({ "type": "content_block_delta", "index": 2, "delta": { "type": "input_json_delta", "partial_json": "{\"path\": \"/var/" } }),
        json!({ "type": "content_block_delta", "index": 2, "delta": { "type": "input_json_delta", "partial_json": "log/syslog\"}" } }),
    ];
    let started: Vec<Option<String>> = frames.iter().map(|f| acc.feed("anthropic", f)).collect();
    assert_eq!(started[4].as_deref(), Some("tail_file"));
    let mut done = json!({});
    acc.attach(&mut done);
    assert_eq!(
        done["toolCalls"],
        json!([{ "id": "toolu_1", "name": "tail_file", "arguments": "{\"path\": \"/var/log/syslog\"}" }])
    );
    assert_eq!(
        done["thinkingBlocks"],
        json!([{ "thinking": "需要看日志", "signature": "sig==" }])
    );
}

#[test]
fn unsupported_tool_errors_are_recognized() {
    assert!(is_tools_unsupported(
        400,
        r#"{"error":"registry.ollama.ai/library/gemma:2b does not support tools"}"#
    ));
    assert!(is_tools_unsupported(
        400,
        "\"auto\" tool choice requires --enable-auto-tool-choice and --tool-call-parser to be set"
    ));
    assert!(is_tools_unsupported(
        422,
        "Unrecognized request argument supplied: tools"
    ));
    assert!(!is_tools_unsupported(401, "invalid api key for function"));
    assert!(!is_tools_unsupported(400, "max_tokens is too large"));
}
