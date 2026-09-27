// NEBULA_TEST 测试桥:本地 HTTP 服务。
// 协议:POST /eval {id, js} → 在 webview 执行 JS(结果写入 document.title='R:'+json),
//       服务端同步轮询 title 提取结果(绕开 WKWebView 的 ATS/fetch 限制);
//       GET /result/{id} → 取回结果。
use serde_json::{json, Value};
use std::io::{Read, Write};
use std::net::TcpListener;
use tauri::Manager;

fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    while i < b.len() {
        match b[i] {
            b'%' if i + 2 < b.len() => {
                let hex = std::str::from_utf8(&b[i + 1..i + 3]).unwrap_or("");
                if let Ok(v) = u8::from_str_radix(hex, 16) {
                    out.push(v);
                    i += 3;
                } else {
                    out.push(b[i]);
                    i += 1;
                }
            }
            b'+' => {
                out.push(b' ');
                i += 1;
            }
            c => {
                out.push(c);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).to_string()
}

pub async fn start_bridge(
    app: tauri::AppHandle,
    port_file: String,
    results: std::sync::Arc<std::sync::Mutex<std::collections::HashMap<String, String>>>,
) {
    let listener = match TcpListener::bind("127.0.0.1:0") {
        Ok(l) => l,
        Err(e) => {
            eprintln!("[bridge] bind failed: {}", e);
            return;
        }
    };
    let port = listener.local_addr().map(|a| a.port()).unwrap_or(0);
    std::fs::write(&port_file, port.to_string()).ok();
    eprintln!("[bridge] listening on 127.0.0.1:{}", port);

    for stream in listener.incoming() {
        let mut stream = match stream {
            Ok(s) => s,
            Err(_) => continue,
        };
        let app = app.clone();
        let results = results.clone();
        tokio::task::spawn_blocking(move || {
            let mut buf = vec![0u8; 65536];
            let mut body = Vec::new();
            let mut content_length = 0usize;
            let mut path = String::new();
            loop {
                let n = match stream.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => n,
                };
                body.extend_from_slice(&buf[..n]);
                let text = String::from_utf8_lossy(&body).to_string();
                if path.is_empty() {
                    if let Some(first) = text.lines().next() {
                        path = first.split(' ').nth(1).unwrap_or("").to_string();
                    }
                }
                if let Some(i) = text.find("\r\n\r\n") {
                    if content_length == 0 {
                        for line in text[..i].lines() {
                            let lower = line.to_lowercase();
                            if let Some(v) = lower.strip_prefix("content-length:") {
                                content_length = v.trim().parse().unwrap_or(0);
                            }
                        }
                    }
                    if body.len() >= i + 4 + content_length {
                        break;
                    }
                }
            }
            let payload = String::from_utf8_lossy(&body)
                .split("\r\n\r\n")
                .nth(1)
                .unwrap_or("")
                .to_string();

            let (status, resp) = if path.starts_with("/eval") {
                let v: Value = serde_json::from_str(&payload).unwrap_or(json!(null));
                let id = v["id"].as_str().unwrap_or("").to_string();
                let js = v["js"].as_str().unwrap_or("");
                // 原样内嵌 js(绝不能转义引号/换行 —— 那会破坏注入代码的语法,是此前的 bug)
                // 结果经 Tauri invoke 回传(命令已在 lib.rs 注册,preload 无需权限)
                let wrapped = format!(
                    "(async () => {{\n  let v;\n  try {{\n    const r = await (async () => {{ {} }})();\n    v = (r === undefined) ? 'undefined' : JSON.stringify(r);\n  }} catch (e) {{ v = 'ERR: ' + String((e && e.message) || e); }}\n  try {{ await window.__TAURI__.core.invoke('nebula_test_result', {{ id: '{}', value: String(v) }}); }} catch (e2) {{}}\n}})()",
                    js, id
                );
                if let Some(w) = app.get_webview_window("main") {
                    w.eval(&wrapped).ok();
                }
                (200, json!({ "ok": true }).to_string())
            } else if path.starts_with("/post") {
                let body = payload.strip_prefix("id=").unwrap_or("");
                let mut parts = body.splitn(2, "&value=");
                let id = parts.next().unwrap_or("").to_string();
                let value = parts.next().map(percent_decode).unwrap_or_default();
                if !id.is_empty() {
                    results.lock().unwrap().insert(id, value);
                }
                (200, json!({ "ok": true }).to_string())
            } else if let Some(id) = path.strip_prefix("/result/") {
                let id = id.to_string();
                match results.lock().unwrap().get(&id) {
                    Some(v) => (200, json!({ "value": v }).to_string()),
                    None => (404, json!({ "error": "pending" }).to_string()),
                }
            } else if path.starts_with("/ping") {
                (200, json!({ "ok": true }).to_string())
            } else {
                (404, json!({ "error": "not found" }).to_string())
            };

            let http = format!(
                "HTTP/1.1 {} {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nAccess-Control-Allow-Origin: *\r\nConnection: close\r\n\r\n{}",
                status,
                if status == 200 { "OK" } else { "ERR" },
                resp.len(),
                resp
            );
            stream.write_all(http.as_bytes()).ok();
            stream.flush().ok();
        });
    }
}
