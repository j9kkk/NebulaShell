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
    let (mut input, mut output) = (None, None);
    collect_usage(
        "openai",
        &json!({"usage":{"prompt_tokens":12,"completion_tokens":3}}),
        &mut input,
        &mut output,
    );
    assert_eq!((input, output), (Some(12), Some(3)));
    collect_usage(
        "anthropic",
        &json!({"type":"message_start","message":{"usage":{"input_tokens":20}}}),
        &mut input,
        &mut output,
    );
    collect_usage(
        "anthropic",
        &json!({"type":"message_delta","usage":{"output_tokens":7}}),
        &mut input,
        &mut output,
    );
    assert_eq!((input, output), (Some(20), Some(7)));
    let done = done_payload("request", "aborted", input, output, Instant::now());
    assert_eq!(done["requestId"], "request");
    assert_eq!(done["finishReason"], "aborted");
    assert_eq!(done["usage"]["completionTokens"], 7);
    assert!(done["elapsedMs"].is_number());
    assert_eq!(error_excerpt(&"中".repeat(400), 200), "中".repeat(200));
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
