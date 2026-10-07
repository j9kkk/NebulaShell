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

/// 解析 HTTP/1.1 chunked 请求体:每块为 `<十六进制长度>\r\n<数据>\r\n`,以 0 长度块结束。
fn decode_chunked(raw: &[u8]) -> String {
    let mut out = Vec::new();
    let mut pos = 0usize;
    loop {
        // 找块长度行
        let line_end = match raw[pos..].windows(2).position(|w| w == b"\r\n") {
            Some(i) => pos + i,
            None => break,
        };
        let size_str = String::from_utf8_lossy(&raw[pos..line_end]);
        let size_part = size_str.split(';').next().unwrap_or("").trim();
        let size = match usize::from_str_radix(size_part, 16) {
            Ok(v) => v,
            Err(_) => break,
        };
        if size == 0 {
            break;
        }
        let data_start = line_end + 2;
        let data_end = (data_start + size).min(raw.len());
        out.extend_from_slice(&raw[data_start..data_end]);
        pos = data_end + 2; // 跳过块尾 CRLF
        if pos >= raw.len() {
            break;
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
            let mut path = String::new();
            let mut head_end = 0usize; // 头部结束位置(指向空行之后)
            let mut content_length: Option<usize> = None;
            let mut chunked = false;
            loop {
                let n = match stream.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => n,
                };
                body.extend_from_slice(&buf[..n]);
                if head_end == 0 {
                    let text = String::from_utf8_lossy(&body).to_string();
                    if path.is_empty() {
                        if let Some(first) = text.lines().next() {
                            path = first.split(' ').nth(1).unwrap_or("").to_string();
                        }
                    }
                    if let Some(i) = text.find("\r\n\r\n") {
                        head_end = i + 4;
                        for line in text[..i].lines() {
                            let lower = line.to_lowercase();
                            if let Some(v) = lower.strip_prefix("content-length:") {
                                content_length = v.trim().parse().ok();
                            } else if let Some(v) = lower.strip_prefix("transfer-encoding:") {
                                if v.contains("chunked") {
                                    chunked = true;
                                }
                            }
                        }
                    }
                }
                if head_end > 0 {
                    let body_bytes = &body[head_end..];
                    if chunked {
                        // 结束标志是长度为 0 的块:0\r\n\r\n
                        if body_bytes.windows(5).any(|w| w == b"0\r\n\r\n") {
                            break;
                        }
                    } else if let Some(cl) = content_length {
                        if body_bytes.len() >= cl {
                            break;
                        }
                    } else {
                        break; // 无请求体的方法(如 GET)
                    }
                }
            }
            // 取请求体:Node 的 http 客户端默认用 chunked(不设 Content-Length),
            // 只认 Content-Length 会导致读到空 body、eval 永不执行。
            let raw_body = &body[head_end.min(body.len())..];
            let payload = if chunked {
                decode_chunked(raw_body)
            } else if let Some(cl) = content_length {
                String::from_utf8_lossy(&raw_body[..cl.min(raw_body.len())]).to_string()
            } else {
                String::new()
            };

            let (status, resp) = if path.starts_with("/eval") {
                let v: Value = serde_json::from_str(&payload).unwrap_or(json!(null));
                let id = v["id"].as_str().unwrap_or("").to_string();
                let js = v["js"].as_str().unwrap_or("");
                // 注入的 js 作为函数体执行。页面 CSP 禁止 eval/new Function,
                // 无法在页面内做"表达式 vs 语句"的自动判别,因此约定:
                //  - 需要取值时显式写 return(多语句块尤其如此)
                //  - 单表达式一行(不含分号)自动补 return,兼容 devtools 式写法
                let trimmed = js.trim();
                let starts_with_return = trimmed.starts_with("return ")
                    || trimmed.starts_with("return(")
                    || trimmed == "return";
                // auto_expr 的边界:多语句脚本即使不含分号/换行(如全在注释后),
                // 也不能贸然包 return —— 原样交给 body 保留完整语义。
                let auto_expr =
                    !starts_with_return && !trimmed.contains(';') && !trimmed.contains('\n');
                let body = if trimmed.is_empty() {
                    String::new()
                } else if auto_expr {
                    format!("return ({});", trimmed)
                } else {
                    js.to_string()
                };
                // id 经 JSON 编码内嵌 —— 天然处理引号、反斜杠与换行,避免拼接破坏语法。
                let id_literal = serde_json::to_string(&id).unwrap_or_else(|_| "\"\"".to_string());
                let wrapped = format!(
                    "(async () => {{\n  let v;\n  const report = () => window.__TAURI__.core.invoke('nebula_test_result', {{ id: {id_literal}, value: String(v) }}).catch(() => {{}});\n  try {{\n    const r = await (async () => {{ {body} }})();\n    v = (r === undefined) ? 'undefined' : JSON.stringify(r);\n  }} catch (e) {{ v = 'ERR: ' + String((e && e.message) || e); }}\n  await report();\n}})()",
                    body = body,
                    id_literal = id_literal
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
                    // value 里存的是 JS 结果的 JSON 文本;这里还原为原生 JSON 类型,
                    // 让测试脚本拿到的是真正的 string/number/bool/object,
                    // 而不是"再做一次 JSON.parse 才可用"的二次编码字符串。
                    Some(v) => match serde_json::from_str::<Value>(v) {
                        Ok(parsed) => (200, json!({ "value": parsed }).to_string()),
                        Err(_) => (200, json!({ "value": v }).to_string()),
                    },
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
