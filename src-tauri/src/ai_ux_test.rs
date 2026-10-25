use super::*;
use std::sync::{Arc, Mutex};
use tauri::Listener;

fn saved() -> Value {
    json!({"protocol":"openai", "baseUrl":"https://saved.example/v1", "model":"saved-model"})
}

#[test]
fn saved_key_is_bound_to_full_endpoint_and_protocol_for_both_call_shapes() {
    for ov in [
        json!({"baseUrl":"https://other.example/v1"}),
        json!({"baseUrl":"http://saved.example/v1"}),
        json!({"baseUrl":"https://saved.example/v2"}),
        json!({"baseUrl":"https://saved.example/v1?route=other"}),
        json!({"protocol":"anthropic"}),
        json!({"baseUrl":""}),
    ] {
        // models passes the flat payload; chat passes the nested ai object.
        for payload in [ov.clone(), json!({"ai": ov})] {
            let draft = payload.get("ai").unwrap_or(&payload);
            let cfg = resolve_request_config(&saved(), Some(draft), "secret");
            assert!(cfg.api_key.is_empty());
        }
    }
    let ov = json!({"baseUrl":" https://saved.example/v1/// ", "apiKey":""});
    assert_eq!(
        resolve_request_config(&saved(), Some(&ov), "secret").api_key,
        "secret"
    );
    assert_eq!(
        resolve_request_config(&saved(), None, "secret").api_key,
        "secret"
    );
}

#[test]
fn explicit_credentials_and_blank_draft_fields_do_not_fallback() {
    let ov = json!({"baseUrl":"https://other.example/v1", "model":"", "apiKey":" fresh ", "useSavedApiKey":false});
    let cfg = resolve_request_config(&saved(), Some(&ov), "secret");
    assert_eq!(cfg.api_key, "fresh");
    assert_eq!(cfg.model, "");
    assert_eq!(cfg.base_url, "https://other.example/v1");
    assert_eq!(cfg.protocol, "openai");
    for ov in [json!({"useSavedApiKey":false}), json!({"clearApiKey":true})] {
        assert!(resolve_request_config(&saved(), Some(&ov), "secret")
            .api_key
            .is_empty());
    }
    assert!(!same_endpoint(&json!({}), &json!({})));
}

#[tokio::test]
async fn idle_wait_is_bounded_and_cancellation_interrupts_pending_operation() {
    let flag = AtomicBool::new(false);
    let result = wait_cancellable(
        std::future::pending::<()>(),
        &flag,
        Duration::from_millis(5),
    )
    .await;
    assert!(result.unwrap_err().contains("超时"));
    let started = Instant::now();
    let (result, _) = tokio::join!(
        wait_cancellable(std::future::pending::<()>(), &flag, Duration::from_secs(2)),
        async {
            tokio::time::sleep(Duration::from_millis(5)).await;
            flag.store(true, Ordering::Relaxed);
        }
    );
    assert!(result.unwrap().is_none());
    assert!(started.elapsed() < Duration::from_secs(1));
}

#[tokio::test]
async fn cancellation_polling_keeps_one_future_alive() {
    let flag = AtomicBool::new(false);
    let mut starts = 0;
    let op = async {
        starts += 1;
        tokio::time::sleep(Duration::from_millis(220)).await;
        42
    };
    assert_eq!(
        wait_cancellable(op, &flag, Duration::from_secs(2))
            .await
            .unwrap(),
        Some(42)
    );
    assert_eq!(starts, 1);
    flag.store(true, Ordering::Relaxed);
    assert!(wait_cancellable(
        async { panic!("cancelled operation must not run") },
        &flag,
        Duration::from_secs(1)
    )
    .await
    .unwrap()
    .is_none());
}

#[test]
fn usage_chains_and_unicode_errors_remain_intact() {
    let mut usage = Usage::default();
    collect_usage(
        "openai",
        &json!({"usage":{"prompt_tokens":12,"completion_tokens":3}}),
        &mut usage,
    );
    assert_eq!((usage.input, usage.output), (Some(12), Some(3)));
    collect_usage(
        "anthropic",
        &json!({"type":"message_start","message":{"usage":{"input_tokens":20}}}),
        &mut usage,
    );
    collect_usage(
        "anthropic",
        &json!({"type":"message_delta","usage":{"output_tokens":7}}),
        &mut usage,
    );
    assert_eq!((usage.input, usage.output), (Some(20), Some(7)));
    let done = done_payload("request", "aborted", usage, Instant::now());
    assert_eq!(done["requestId"], "request");
    assert_eq!(done["finishReason"], "aborted");
    assert_eq!(done["usage"]["completionTokens"], 7);
    // 没有任何缓存字段时透传 null,前端据此隐藏「缓存命中率」行
    assert!(done["usage"]["cacheReadTokens"].is_null());
    assert!(done["usage"]["cacheWriteTokens"].is_null());
    assert!(done["elapsedMs"].is_number());
    assert_eq!(error_excerpt(&"中".repeat(400), 200), "中".repeat(200));
}

#[test]
fn collect_usage_normalises_cache_fields_across_protocols() {
    // Anthropic: cache_read_input_tokens / cache_creation_input_tokens
    let mut a = Usage::default();
    collect_usage(
        "anthropic",
        &json!({"type":"message_start","message":{"usage":{
            "input_tokens": 100,
            "cache_read_input_tokens": 800,
            "cache_creation_input_tokens": 50
        }}}),
        &mut a,
    );
    assert_eq!(a.input, Some(100));
    assert_eq!(a.cache_read, Some(800));
    assert_eq!(a.cache_write, Some(50));

    // DeepSeek: prompt_cache_hit_tokens / prompt_cache_miss_tokens
    let mut d = Usage::default();
    collect_usage(
        "openai",
        &json!({"usage":{
            "prompt_tokens": 1000,
            "completion_tokens": 20,
            "prompt_cache_hit_tokens": 750,
            "prompt_cache_miss_tokens": 250
        }}),
        &mut d,
    );
    assert_eq!(d.cache_read, Some(750));
    assert_eq!(d.cache_write, Some(250));

    // OpenAI: 只有 prompt_tokens_details.cached_tokens,没有写入侧
    let mut o = Usage::default();
    collect_usage(
        "openai",
        &json!({"usage":{
            "prompt_tokens": 500,
            "prompt_tokens_details": {"cached_tokens": 400}
        }}),
        &mut o,
    );
    assert_eq!(o.cache_read, Some(400));
    assert_eq!(o.cache_write, None);
}

#[test]
fn resolve_request_config_extracts_max_tokens_and_reasoning_params() {
    let saved = json!({
        "protocol": "openai",
        "baseUrl": "https://api.openai.com/v1",
        "model": "gpt-4o"
    });
    let override_ai = json!({
        "protocol": "openai",
        "baseUrl": "https://api.openai.com/v1",
        "model": "gpt-4o",
        "maxTokens": 8192,
        "reasoningParams": { "reasoning_effort": "high" }
    });
    let cfg = resolve_request_config(&saved, Some(&override_ai), "key123");
    assert_eq!(cfg.max_tokens, Some(8192));
    assert_eq!(
        cfg.reasoning_params,
        Some(json!({ "reasoning_effort": "high" }))
    );
}

fn mock_app() -> tauri::AppHandle<tauri::test::MockRuntime> {
    tauri::test::mock_builder()
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap()
        .handle()
        .clone()
}

#[tokio::test]
async fn local_sse_preserves_split_utf8_usage_and_finish_events() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    for protocol in ["openai", "anthropic"] {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = format!("http://{}/v1", listener.local_addr().unwrap());
        let body = if protocol == "openai" {
            "data: {\"choices\":[{\"delta\":{\"content\":\"中文\"}}]}\n\ndata: {\"usage\":{\"prompt_tokens\":10,\"completion_tokens\":2},\"choices\":[]}\n\ndata: [DONE]\n\n"
        } else {
            "data: {\"type\":\"message_start\",\"message\":{\"usage\":{\"input_tokens\":10}}}\n\ndata: {\"type\":\"content_block_delta\",\"delta\":{\"text\":\"中文\"}}\n\ndata: {\"type\":\"message_delta\",\"usage\":{\"output_tokens\":2}}\n\ndata: {\"type\":\"message_stop\"}\n\n"
        };
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = [0; 4096];
            socket.read(&mut request).await.unwrap();
            let headers = format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len());
            socket.write_all(headers.as_bytes()).await.unwrap();
            let split = body.find('中').unwrap() + 1;
            socket.write_all(&body.as_bytes()[..split]).await.unwrap();
            tokio::time::sleep(Duration::from_millis(5)).await;
            socket.write_all(&body.as_bytes()[split..]).await.unwrap();
        });
        let app = mock_app();
        let events = Arc::new(Mutex::new(Vec::<Value>::new()));
        let captured = events.clone();
        app.listen("ai__delta", move |evt| {
            captured
                .lock()
                .unwrap()
                .push(serde_json::from_str(evt.payload()).unwrap())
        });
        let captured = events.clone();
        app.listen("ai__done", move |evt| {
            captured
                .lock()
                .unwrap()
                .push(serde_json::from_str(evt.payload()).unwrap())
        });
        chat_stream(
            app,
            "request".into(),
            protocol.into(),
            endpoint,
            "".into(),
            "manual-model".into(),
            json!([{"role":"user","content":"test"}]),
            Arc::new(AtomicBool::new(false)),
        )
        .await
        .unwrap();
        server.await.unwrap();
        let events = events.lock().unwrap();
        assert_eq!(events.len(), 2);
        assert_eq!(events[0]["text"], "中文");
        assert_eq!(events[1]["finishReason"], "stop");
        assert_eq!(events[1]["usage"]["promptTokens"], 10);
        assert_eq!(events[1]["usage"]["completionTokens"], 2);
    }
}

#[tokio::test]
async fn reasoning_only_stream_emits_progress_and_thinking_not_idle_timeout() {
    // 回归:思考型模型纯推理期不产出正文,曾经一个事件都不转发,
    // 前端 60 秒空闲计时误判超时并 abort(服务端侧表现为 HTTP 499)。
    // 现在思考增量走 ai:thinking、role/usage/finish 帧走 ai:progress。
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!("http://{}/v1", listener.local_addr().unwrap());
    let body = "data: {\"choices\":[{\"delta\":{\"role\":\"assistant\",\"reasoning_content\":\"我想想\"}}]}\n\n\
                : keepalive\n\n\
                data: {\"choices\":[{\"delta\":{\"content\":\"答案\"}}]}\n\n\
                data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}],\"usage\":{\"prompt_tokens\":5,\"completion_tokens\":9}}\n\n\
                data: [DONE]\n\n";
    let server = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let mut request = [0; 4096];
        socket.read(&mut request).await.unwrap();
        let headers = format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len());
        socket.write_all(headers.as_bytes()).await.unwrap();
        socket.write_all(body.as_bytes()).await.unwrap();
    });
    let app = mock_app();
    let events = Arc::new(Mutex::new(Vec::<(String, Value)>::new()));
    for name in ["ai__progress", "ai__thinking", "ai__delta", "ai__done"] {
        let captured = events.clone();
        let name = name.to_string();
        let event_name = name.clone();
        app.listen(&event_name, move |evt| {
            captured
                .lock()
                .unwrap()
                .push((name.clone(), serde_json::from_str(evt.payload()).unwrap()))
        });
    }
    chat_stream(
        app,
        "think".into(),
        "openai".into(),
        endpoint,
        "".into(),
        "reasoner".into(),
        json!([{"role":"user","content":"test"}]),
        Arc::new(AtomicBool::new(false)),
    )
    .await
    .unwrap();
    server.await.unwrap();
    let events = events.lock().unwrap();
    let kinds: Vec<&str> = events.iter().map(|(k, _)| k.as_str()).collect();
    assert_eq!(
        kinds,
        vec![
            "ai__progress", // 响应头到达
            "ai__thinking", // role + reasoning 帧(思考增量)
            "ai__progress", // keep-alive 注释行
            "ai__delta",    // 正文
            "ai__progress", // finish_reason + usage 帧
            "ai__done",     // [DONE]
        ]
    );
}

#[tokio::test]
async fn anthropic_thinking_blocks_forward_as_thinking_events() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!("http://{}/v1", listener.local_addr().unwrap());
    let body = "data: {\"type\":\"content_block_delta\",\"delta\":{\"thinking\":\"推演中\"}}\n\n\
                data: {\"type\":\"content_block_delta\",\"delta\":{\"text\":\"结论\"}}\n\n\
                data: {\"type\":\"message_stop\"}\n\n";
    let server = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let mut request = [0; 4096];
        socket.read(&mut request).await.unwrap();
        let headers = format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len());
        socket.write_all(headers.as_bytes()).await.unwrap();
        socket.write_all(body.as_bytes()).await.unwrap();
    });
    let app = mock_app();
    let events = Arc::new(Mutex::new(Vec::<(String, Value)>::new()));
    for name in ["ai__thinking", "ai__delta", "ai__done"] {
        let captured = events.clone();
        let name = name.to_string();
        let event_name = name.clone();
        app.listen(&event_name, move |evt| {
            captured
                .lock()
                .unwrap()
                .push((name.clone(), serde_json::from_str(evt.payload()).unwrap()))
        });
    }
    chat_stream(
        app,
        "think".into(),
        "anthropic".into(),
        endpoint,
        "".into(),
        "claude".into(),
        json!([{"role":"user","content":"test"}]),
        Arc::new(AtomicBool::new(false)),
    )
    .await
    .unwrap();
    server.await.unwrap();
    let events = events.lock().unwrap();
    let kinds: Vec<&str> = events.iter().map(|(k, _)| k.as_str()).collect();
    assert_eq!(kinds, vec!["ai__thinking", "ai__delta", "ai__done"]);
    assert_eq!(events[0].1["text"], "推演中");
    assert_eq!(events[1].1["text"], "结论");
}

#[tokio::test]
async fn abort_before_headers_emits_done_without_waiting_for_server() {
    use tokio::io::AsyncReadExt;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!("http://{}/v1", listener.local_addr().unwrap());
    let flag = Arc::new(AtomicBool::new(false));
    let server_flag = flag.clone();
    let server = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let mut request = [0; 4096];
        socket.read(&mut request).await.unwrap();
        server_flag.store(true, Ordering::Relaxed);
        // Keep socket open without headers until chat cancels it.
        let _ = socket.read(&mut request).await;
    });
    let app = mock_app();
    let events = Arc::new(Mutex::new(Vec::<Value>::new()));
    let captured = events.clone();
    app.listen("ai__done", move |evt| {
        captured
            .lock()
            .unwrap()
            .push(serde_json::from_str(evt.payload()).unwrap())
    });
    tokio::time::timeout(
        Duration::from_secs(2),
        chat_stream(
            app,
            "cancel".into(),
            "openai".into(),
            endpoint,
            "".into(),
            "model".into(),
            json!([]),
            flag,
        ),
    )
    .await
    .unwrap()
    .unwrap();
    server.await.unwrap();
    assert_eq!(events.lock().unwrap()[0]["finishReason"], "aborted");
}

// ---- /models 上游能力字段解析 ----

// DeepSeek 新版 /models 直给 context_window / max_output_tokens / effort,
// 这些是供应商权威值,必须原样透传给前端(不能被按模型 ID 推导的默认值覆盖)。
#[test]
fn model_entries_carry_upstream_context_output_and_effort() {
    let list = vec![json!({
        "id": "deepseek-flash",
        "name": "deepseek-flash",
        "owned_by": "deepseek",
        "context_window": 1000000,
        "max_output_tokens": 384000,
        "effort": { "supported_levels": ["low", "medium", "high"], "default_level": "medium" },
        "input_modalities": ["text"]
    })];
    let out = crate::ai::parse_model_entries(&list);
    assert_eq!(out.len(), 1);
    let m = &out[0];
    assert_eq!(m["context"], json!(1000000));
    assert_eq!(m["maxOutput"], json!(384000));
    assert_eq!(m["effortLevels"], json!(["low", "medium", "high"]));
    assert_eq!(m["effortDefault"], json!("medium"));
    assert_eq!(m["vision"], json!(false));
}

// OpenRouter 用 context_length + architecture.input_modalities;
// 缺 max_output_tokens 时该字段必须是 null,让前端回落到本地推荐值。
#[test]
fn model_entries_fall_back_to_openrouter_aliases_and_null_output() {
    let list = vec![json!({
        "id": "openrouter/model",
        "name": "Model",
        "context_length": 128000,
        "architecture": { "input_modalities": ["text", "image"] }
    })];
    let out = crate::ai::parse_model_entries(&list);
    let m = &out[0];
    assert_eq!(m["context"], json!(128000));
    assert_eq!(m["maxOutput"], Value::Null);
    assert_eq!(m["effortLevels"], Value::Null);
    assert_eq!(m["vision"], json!(true));
}

// 重复 id 只保留一条;display_name 优先于 name。
#[test]
fn model_entries_dedupe_and_prefer_display_name() {
    let list = vec![
        json!({ "id": "dup", "display_name": "First", "name": "raw" }),
        json!({ "id": "dup", "name": "Second" }),
    ];
    let out = crate::ai::parse_model_entries(&list);
    assert_eq!(out.len(), 1);
    assert_eq!(out[0]["name"], json!("First"));
}
