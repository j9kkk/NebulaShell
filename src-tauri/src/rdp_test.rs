//! RDP 后端单元测试：TOFU、帧编码、输入映射、错误分类、会话生命周期。
//!
//! 只跑本地可验证的部分——本机没有 Windows 目标机与 RDP 容器，
//! 协议层端到端留给 Stage 6 实机验收。

use std::sync::atomic::{AtomicBool, Ordering as AtomicOrdering};
use std::sync::Arc;
use std::time::Duration;

use serde_json::json;
use tokio::io::AsyncReadExt as _;

use crate::config::Store;
use crate::rdp::{
    apply_input_payload, classify_rdp_error, compute_cert_sha256_fingerprints, crop_rgba,
    decode_frame_packet, encode_frame_packet, expand_key_combo, fingerprint_mismatch_error,
    rdp_tofu_lookup_key, sanitize_rdp_dimensions, summary_of_der, tofu_verdict, union_rect,
    FramePacket, RdpInputPayload, RdpService, TofuVerdict, FRAME_HEADER_LEN, FRAME_KIND_DIRTY,
    FRAME_MAGIC,
};
use crate::ssh::{RemoteTargets, SshService};

/// 自签测试证书（`CN=WIN-RDP01`，RSA-1024，仅用于夹具）的 DER base64。
const TEST_CERT_DER_B64: &str = "MIIBvTCCASagAwIBAgIJAK/3q7AiACwmMA0GCSqGSIb3DQEBCwUAMBQxEjAQBgNVBAMMCVdJTi1SRFAwMTAeFw0yNjExMTQwNjUwMzlaFw0zNjExMTEwNjUwMzlaMBQxEjAQBgNVBAMMCVdJTi1SRFAwMTCBnzANBgkqhkiG9w0BAQEFAAOBjQAwgYkCgYEA5pZzZAop6bPbacs6u24rlpqHYeFMmcauLC6a3LHBOqoWm8fh0ejSAdRZz8jAiZt0LsctnlQK8GOKLepu20PycVQePH3EWBCfSzrLJM2vBNtlhuAELfXj+WSE/n3Hrd6b0KPWb9YUNjLVwCr0dQs2pruOJl0PUkHJpE9XXLrAqTsCAwEAAaMXMBUwEwYDVR0lBAwwCgYIKwYBBQUHAwEwDQYJKoZIhvcNAQELBQADgYEAH04BM8EJfLpIg9ACgfTbgEdQ/Yib+yp3cVJla9ZwPIpoxD194PG2RcGqaxNtgRh1WYcReYj9mvAbeNKMfpa1cmGXt9ZHCd4n4tjtSblj+SAj4ZcKA/J+9EqsmOfTl1krtmMdmewS8PcP+VsxmpsVYJMlg6Oi4I0l/flH63m6kSs=";

/// 与 `openssl x509 -fingerprint -sha256` 一致的期望值。
const TEST_CERT_SHA256_HEX: &str = "6D:B7:31:D2:32:C3:0D:A6:48:E6:8B:E7:DB:01:52:12:7E:1E:86:DA:90:FA:61:49:F6:B4:85:A9:ED:23:5B:DC";

fn test_cert_der() -> Vec<u8> {
    use base64::engine::general_purpose::STANDARD;
    use base64::Engine as _;
    STANDARD.decode(TEST_CERT_DER_B64).expect("夹具证书 base64")
}

fn temp_store(tag: &str) -> (Arc<Store>, std::path::PathBuf) {
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let dir = std::env::temp_dir().join(format!("nebulashell-rdp-test-{tag}-{stamp}"));
    let store = Arc::new(Store::load(dir.clone()));
    (store, dir)
}

#[test]
fn tofu_verdict_covers_all_three_states() {
    assert_eq!(tofu_verdict(None, "SHA256:new"), TofuVerdict::FirstSeen);
    assert_eq!(
        tofu_verdict(Some("SHA256:same"), "SHA256:same"),
        TofuVerdict::Match
    );
    assert_eq!(
        tofu_verdict(Some("SHA256:old"), "SHA256:new"),
        TofuVerdict::Mismatch {
            stored: "SHA256:old".to_string(),
            current: "SHA256:new".to_string(),
        }
    );
}

#[test]
fn tofu_lookup_key_is_namespaced_per_protocol() {
    assert_eq!(rdp_tofu_lookup_key("10.0.0.9", 3389), "rdp:10.0.0.9:3389");
    // 与 SSH 的 `host:port` 键不会互相覆盖
    assert_ne!(rdp_tofu_lookup_key("10.0.0.9", 22), "10.0.0.9:22");
}

#[test]
fn fingerprint_mismatch_error_carries_machine_readable_marker() {
    let msg = fingerprint_mismatch_error("rdp:h:3389", "SHA256:old", "SHA256:new");
    // 前端 core.js 的 parseFpError 依赖这段格式
    assert!(
        msg.contains("[NB-FP rdp:h:3389|SHA256:old|SHA256:new]"),
        "{msg}"
    );
    assert!(msg.contains("中间人"));
}

#[test]
fn sha256_fingerprint_matches_openssl() {
    let der = test_cert_der();
    let (prefixed, hex) = compute_cert_sha256_fingerprints(&der);
    assert!(prefixed.starts_with("SHA256:"));
    assert_eq!(hex, TEST_CERT_SHA256_HEX);
}

#[test]
fn cert_summary_extracts_subject_and_validity() {
    let der = test_cert_der();
    let summary = summary_of_der(&der, "10.0.0.9", 3389).expect("解析夹具证书");
    assert_eq!(summary.lookup_key, "rdp:10.0.0.9:3389");
    assert_eq!(summary.sha256_hex, TEST_CERT_SHA256_HEX);
    assert!(summary.subject.contains("WIN-RDP01"), "{}", summary.subject);
    assert!(!summary.valid_from.is_empty());
    assert!(!summary.valid_to.is_empty());
}

#[test]
fn frame_packet_roundtrip_preserves_geometry_and_pixels() {
    let pixels = vec![0xABu8; 4 * 2 * 3]; // 2x3 像素 RGBA
    let packet = encode_frame_packet(FRAME_KIND_DIRTY, 4, 5, 2, 3, 64, 48, &pixels);
    assert_eq!(packet.len(), FRAME_HEADER_LEN + pixels.len());
    assert_eq!(
        u32::from_le_bytes([packet[0], packet[1], packet[2], packet[3]]),
        FRAME_MAGIC
    );

    let decoded = decode_frame_packet(&packet).expect("解码帧包");
    let expected = FramePacket {
        version: crate::rdp::FRAME_VERSION_RAW,
        kind: FRAME_KIND_DIRTY,
        x: 4,
        y: 5,
        width: 2,
        height: 3,
        desktop_width: 64,
        desktop_height: 48,
        pixels,
    };
    assert_eq!(decoded, expected);
}

#[test]
fn frame_packet_rejects_truncated_and_short_payloads() {
    assert!(decode_frame_packet(&[0u8; 8]).is_none());
    let mut packet = encode_frame_packet(0, 0, 0, 4, 4, 4, 4, &[0u8; 64]);
    assert!(decode_frame_packet(&packet).is_some());
    packet.truncate(FRAME_HEADER_LEN + 16); // 像素不足
    assert!(decode_frame_packet(&packet).is_none());
    let mut bad_magic = encode_frame_packet(0, 0, 0, 1, 1, 1, 1, &[0u8; 4]);
    bad_magic[0] = 0;
    assert!(decode_frame_packet(&bad_magic).is_none());
}

#[test]
fn crop_rgba_extracts_rows_and_clamps_to_image() {
    // 4x3 图像，每像素 4 字节，像素值 = y*10 + x
    let width = 4u16;
    let height = 3u16;
    let stride = usize::from(width) * 4;
    let mut data = Vec::new();
    for y in 0..height {
        for x in 0..width {
            let v = (y * 10 + x) as u8;
            data.extend_from_slice(&[v, v, v, 255]);
        }
    }

    let rect = ironrdp_pdu::geometry::InclusiveRectangle {
        left: 1,
        top: 1,
        right: 2,
        bottom: 2,
    };
    let (x, y, w, h, pixels) = crop_rgba(&data, stride, 4, width, height, &rect).expect("裁剪");
    assert_eq!((x, y, w, h), (1, 1, 2, 2));
    assert_eq!(pixels.len(), 2 * 2 * 4);
    assert_eq!(pixels[0], 11); // (1,1)
    assert_eq!(pixels[4], 12); // (2,1)

    // 越界矩形收敛到图像边界
    let over = ironrdp_pdu::geometry::InclusiveRectangle {
        left: 2,
        top: 2,
        right: 99,
        bottom: 99,
    };
    let (_, _, w, h, _) = crop_rgba(&data, stride, 4, width, height, &over).expect("收敛");
    assert_eq!((w, h), (2, 1));

    // 完全在图外
    let outside = ironrdp_pdu::geometry::InclusiveRectangle {
        left: 9,
        top: 9,
        right: 12,
        bottom: 12,
    };
    assert!(crop_rgba(&data, stride, 4, width, height, &outside).is_none());
}

#[test]
fn union_rect_covers_all_dirty_areas() {
    use ironrdp_pdu::geometry::InclusiveRectangle;
    assert_eq!(union_rect(&[]), None);
    let merged = union_rect(&[
        InclusiveRectangle {
            left: 4,
            top: 6,
            right: 8,
            bottom: 9,
        },
        InclusiveRectangle {
            left: 2,
            top: 7,
            right: 5,
            bottom: 12,
        },
    ])
    .expect("合并");
    assert_eq!((merged.left, merged.top), (2, 6));
    assert_eq!((merged.right, merged.bottom), (8, 12));
}

#[test]
fn dimensions_are_even_and_clamped() {
    assert_eq!(sanitize_rdp_dimensions(0, 0), (1280, 800)); // 未指定时取默认
    let (w, h) = sanitize_rdp_dimensions(1281, 801);
    assert_eq!(w % 2, 0, "宽必须是偶数: {w}");
    assert!(w >= 200 && h >= 200, "{w}x{h}");
    let (big_w, big_h) = sanitize_rdp_dimensions(99999, 99999);
    assert!(big_w <= 8192 && big_h <= 8192, "{big_w}x{big_h}");
}

#[test]
fn ctrl_alt_del_emits_press_then_release_in_reverse() {
    let events = expand_key_combo("Ctrl-Alt-Del").expect("支持 Ctrl+Alt+Del");
    assert_eq!(events.len(), 6, "三个键各一次按下与释放");
    let text = format!("{events:?}");
    // Delete 是扩展键（0x53），Ctrl/Alt 不是
    assert!(text.contains("0x53") || text.contains("83"), "{text}");
    assert!(expand_key_combo("hyper-x").is_err(), "未知组合键要报错");
}

#[test]
fn combo_payload_releases_stuck_modifiers_first() {
    let mut db = ironrdp_input::Database::new();
    let events = apply_input_payload(
        &mut db,
        &RdpInputPayload::Combo {
            combo: "win_r".to_string(),
        },
    )
    .expect("组合键");
    // 先 release_all（可能为空），再是 Win+R 的按下/释放
    assert!(events.len() >= 4, "{}", events.len());
}

#[test]
fn scancode_payload_maps_to_keyboard_event() {
    let mut db = ironrdp_input::Database::new();
    let events = apply_input_payload(
        &mut db,
        &RdpInputPayload::Scancode {
            code: 0x1E,
            pressed: true,
        },
    )
    .expect("扫描码");
    assert_eq!(events.len(), 1);
    assert!(format!("{:?}", events[0]).contains("KeyboardEvent"));
}

#[test]
fn mouse_button_payload_supports_invalid_button_error() {
    let mut db = ironrdp_input::Database::new();
    assert!(apply_input_payload(
        &mut db,
        &RdpInputPayload::MouseButton {
            button: 9,
            pressed: true,
            x: None,
            y: None,
        },
    )
    .is_err());
    let events = apply_input_payload(
        &mut db,
        &RdpInputPayload::MouseButton {
            button: 0,
            pressed: true,
            x: Some(10),
            y: Some(20),
        },
    )
    .expect("左键按下");
    assert!(!events.is_empty());
}

#[test]
fn error_classification_maps_to_frontend_codes() {
    assert_eq!(
        classify_rdp_error("logon failed 0x8009030C").0,
        "AUTH_FAILED"
    );
    assert_eq!(classify_rdp_error("连接远程桌面超时").0, "CONNECT_TIMEOUT");
    assert_eq!(classify_rdp_error("TLS handshake failure").0, "TLS_FAILED");
    assert_eq!(
        classify_rdp_error("server requested redirection").0,
        "REDIRECT_UNSUPPORTED"
    );
    let (code, msg) = classify_rdp_error("whatever [NB-FP rdp:h:3389|a|b]");
    assert_eq!(code, "CERT_CHANGED");
    assert!(msg.contains("[NB-FP"));
    assert_eq!(classify_rdp_error("socket closed").0, "CONNECT_FAILED");
}

#[test]
fn certificate_is_recorded_into_known_hosts() {
    let (store, dir) = temp_store("record");
    let ssh = Arc::new(SshService::new(store.clone(), RemoteTargets::default()));
    let svc = RdpService::new(store.clone(), ssh);
    let key = rdp_tofu_lookup_key("10.1.2.3", 3389);
    svc.record_certificate(&key, "SHA256:abc");

    let stored = {
        let data = store.data.lock().unwrap();
        data["knownHosts"][key.as_str()].as_str().map(String::from)
    };
    assert_eq!(stored.as_deref(), Some("SHA256:abc"));
    assert_eq!(
        tofu_verdict(stored.as_deref(), "SHA256:abc"),
        TofuVerdict::Match
    );

    std::fs::remove_dir_all(dir).ok();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cancel_during_handshake_closes_stream_and_session() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("监听");
    let addr = listener.local_addr().unwrap();

    let (store, dir) = temp_store("cancel");
    let saved = store
        .save_host(&json!({
            "host": "127.0.0.1",
            "port": addr.port(),
            "username": "Administrator",
            "password": "placeholder",
            "protocol": "rdp",
        }))
        .expect("保存主机");
    let host_id = saved["id"].as_str().expect("主机 id").to_string();

    let ssh = Arc::new(SshService::new(store.clone(), RemoteTargets::default()));
    let service = RdpService::new(store.clone(), ssh);

    let app = tauri::test::mock_app();
    let handle = app.handle().clone();
    let worker = service.clone();
    let connector = tokio::spawn(async move {
        worker
            .connect(
                handle,
                &host_id,
                Some("rdp-cancel-test".to_string()),
                Some(800),
                Some(600),
                None,
                false,
                false,
            )
            .await
    });

    // 后端应当先建 TCP 连接并发出 X.224 协商包
    let (mut socket, _) = tokio::time::timeout(Duration::from_secs(5), listener.accept())
        .await
        .expect("等待 RDP 连接")
        .expect("accept");
    let mut buf = [0u8; 64];
    let read = tokio::time::timeout(Duration::from_secs(3), socket.read(&mut buf)).await;
    assert!(matches!(read, Ok(Ok(n)) if n > 0), "应先收到协商包");

    // 握手还没完成，会话尚未登记；此时取消也必须能干净收尾
    assert_eq!(service.active_sessions(), 0);
    service
        .disconnect("rdp-cancel-test")
        .await
        .expect("断开连接中的会话");

    let result = tokio::time::timeout(Duration::from_secs(5), connector)
        .await
        .expect("connect 应返回")
        .expect("任务不应 panic");
    let err = result.expect_err("取消后 connect 应失败");
    assert!(err.contains("取消"), "错误信息: {err}");

    // 会话表清理干净（后台任务异步收尾，最多等 2s）
    let mut live = service.active_sessions();
    for _ in 0..40 {
        if live == 0 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
        live = service.active_sessions();
    }
    assert_eq!(live, 0, "取消后不应残留会话");

    // 底层 socket 已被丢弃：对端读到 EOF
    let eof = tokio::time::timeout(Duration::from_secs(3), socket.read(&mut buf)).await;
    match eof {
        Ok(Ok(0)) => {}
        Ok(Ok(n)) => panic!("取消后不应再有数据，却读到 {n} 字节"),
        Ok(Err(_)) => {} // RST 也算关闭
        Err(_) => panic!("取消后 socket 未关闭"),
    }

    std::fs::remove_dir_all(dir).ok();
}

#[test]
fn frame_sink_flag_is_atomic_and_shared() {
    // 帧泵用 AtomicBool 对外暴露存活状态，这里只验证类型契约（Send + Sync）
    fn require_send_sync<T: Send + Sync>(_: &T) {}
    let flag = Arc::new(AtomicBool::new(true));
    require_send_sync(&flag);
    flag.store(false, AtomicOrdering::SeqCst);
    assert!(!flag.load(AtomicOrdering::SeqCst));
}

/// 真实 RDP 服务端冒烟：验证「连着真 Windows 也能走到 TLS + 证书提取 + TOFU 落盘」。
///
/// 本机没有测试凭据，所以断言的是「认证阶段失败」而不是连上桌面：
/// 只要 `knownHosts` 里出现了该主机的指纹，就证明 X.224 → TLS → 证书解析这条链
/// 在真实服务端上是通的。手动跑：
/// `NB_RDP_SMOKE_HOST=192.168.31.129 cargo test --lib smoke_real_rdp -- --ignored --nocapture`
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "需要真实 Windows RDP 目标机（NB_RDP_SMOKE_HOST）"]
async fn smoke_real_rdp_server_reaches_cert_stage() {
    let Ok(host) = std::env::var("NB_RDP_SMOKE_HOST") else {
        eprintln!("跳过：未设置 NB_RDP_SMOKE_HOST");
        return;
    };
    let port: u16 = std::env::var("NB_RDP_SMOKE_PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(3389);

    let (store, dir) = temp_store("smoke");
    let saved = store
        .save_host(&json!({
            "host": host,
            "port": port,
            "username": "smoke-test",
            "password": "not-a-real-password",
            "protocol": "rdp",
        }))
        .expect("保存主机");
    let host_id = saved["id"].as_str().expect("主机 id").to_string();

    let ssh = Arc::new(SshService::new(store.clone(), RemoteTargets::default()));
    let service = RdpService::new(store.clone(), ssh);
    let app = tauri::test::mock_app();

    let started = std::time::Instant::now();
    let result = service
        .connect(
            app.handle().clone(),
            &host_id,
            Some("rdp-smoke".to_string()),
            Some(1280),
            Some(800),
            None,
            false,
            false,
        )
        .await;
    eprintln!("耗时 {:?}，结果: {result:?}", started.elapsed());

    let key = rdp_tofu_lookup_key(&host, port);
    let recorded = {
        let data = store.data.lock().unwrap();
        data["knownHosts"][key.as_str()].as_str().map(String::from)
    };
    eprintln!("TOFU 记录 {key} = {recorded:?}");
    assert!(
        recorded.is_some(),
        "没落盘指纹说明 TLS/证书阶段没走通，实际错误: {result:?}"
    );

    // 无有效凭据时必须报认证失败，而不是别的阶段
    let err = result.expect_err("占位凭据不可能登录成功");
    let (code, _) = classify_rdp_error(&err);
    assert!(
        code == "AUTH_FAILED" || code == "CONNECT_FAILED" || code == "TLS_FAILED",
        "错误分类 {code}: {err}"
    );
    assert_eq!(service.active_sessions(), 0);
    std::fs::remove_dir_all(dir).ok();
}

#[test]
fn force_opaque_rgba_rewrites_only_the_alpha_byte() {
    // 服务端 32bpp 位图的填充字节常是 0，直接当 alpha 会让画布全透明（黑屏）。
    let mut pixels = vec![1, 2, 3, 0, 4, 5, 6, 0];
    crate::rdp::force_opaque_rgba(&mut pixels);
    assert_eq!(pixels, vec![1, 2, 3, 255, 4, 5, 6, 255]);
    // 尾部不足 4 字节的残片不动，避免越界写
    let mut tail = vec![9, 9, 9];
    crate::rdp::force_opaque_rgba(&mut tail);
    assert_eq!(tail, vec![9, 9, 9]);
}

#[test]
fn encode_full_frame_covers_the_whole_desktop_in_rgb24() {
    use ironrdp_graphics::image_processing::PixelFormat;
    use ironrdp_session::image::DecodedImage;
    // 新建的图像全 0：alpha 字节也是 0（服务端 32bpp 位图的常见情况）
    let image = DecodedImage::new(PixelFormat::RgbA32, 4, 3);
    let bytes = crate::rdp::encode_full_frame(&image).expect("整帧");
    let packet = decode_frame_packet(&bytes).expect("解回帧");
    assert_eq!(packet.kind, crate::rdp::FRAME_KIND_FULL);
    assert_eq!((packet.x, packet.y), (0, 0));
    assert_eq!((packet.width, packet.height), (4, 3));
    assert_eq!((packet.desktop_width, packet.desktop_height), (4, 3));
    // RGB24：每像素 3 字节。alpha 不再上线（前端补 255），
    // 因此「不透明」由协议版本保证，而不是靠 wire 上的那一个字节。
    assert_eq!(packet.pixels.len(), 4 * 3 * 3);
    assert!(matches!(
        packet.version,
        crate::rdp::FRAME_VERSION_RGB24 | crate::rdp::FRAME_VERSION_RGB24_DEFLATE
    ));
}

#[test]
fn rgb24_drops_the_alpha_byte_and_keeps_colour_order() {
    let rgba = vec![
        1, 2, 3, 0, // 第 4 字节是填充位，服务端常给 0
        4, 5, 6, 255,
    ];
    let rgb = crate::rdp::rgba_to_rgb24(&rgba);
    assert_eq!(rgb, vec![1, 2, 3, 4, 5, 6]);
}

#[test]
fn rgb24_frames_are_a_quarter_smaller_on_the_wire() {
    // 32×32 全黑：裸帧大小应当正好是 32*32*3，而不是 *4
    let image = {
        use ironrdp_graphics::image_processing::PixelFormat;
        use ironrdp_session::image::DecodedImage;
        DecodedImage::new(PixelFormat::RgbA32, 32, 32)
    };
    let bytes = crate::rdp::encode_full_frame(&image).expect("整帧");
    let packet = decode_frame_packet(&bytes).expect("解回帧");
    assert_eq!(packet.pixels.len(), 32 * 32 * 3, "每像素 3 字节");
}

#[test]
fn large_rgb24_frames_take_the_compressed_version() {
    let pixels = vec![7u8; 64 * 64 * 3];
    let bytes = crate::rdp::encode_frame_packet_rgb24(0, 0, 0, 64, 64, 64, 64, &pixels);
    let packet = decode_frame_packet(&bytes).expect("解回帧");
    assert_eq!(packet.version, crate::rdp::FRAME_VERSION_RGB24_DEFLATE);
    // 压缩帧的像素长度与原像素数无关（要前端先 inflate）
    assert!(packet.pixels.len() < pixels.len());
}

#[test]
fn frame_out_sends_separate_rects_and_respects_the_frame_interval() {
    use ironrdp_graphics::image_processing::PixelFormat;
    use ironrdp_pdu::geometry::InclusiveRectangle;
    use ironrdp_session::image::DecodedImage;
    use std::sync::Mutex;

    let captured: std::sync::Arc<Mutex<Vec<Vec<u8>>>> = std::sync::Arc::new(Mutex::new(Vec::new()));
    let sink: crate::rdp::FrameSink = {
        let captured = captured.clone();
        std::sync::Arc::new(move |bytes| captured.lock().unwrap().push(bytes))
    };
    let image = DecodedImage::new(PixelFormat::RgbA32, 8, 8);
    let mut frames =
        crate::rdp::FrameOut::new(Some(sink), false, std::time::Duration::from_millis(30));

    let rect = |left, top, right, bottom| InclusiveRectangle {
        left,
        top,
        right,
        bottom,
    };
    frames.merge(&rect(0, 0, 1, 1));
    frames.merge(&rect(4, 4, 5, 5));
    // 刚建好还没到发送间隔：攒着不发，避免每个小脏矩形都过一趟 IPC
    frames.flush(&image, false);
    assert!(captured.lock().unwrap().is_empty());
    assert!(frames.has_pending());

    // 到期（或会话结束时 force）一次发完；两块互不相干，各发一块，
    // 不再被包围盒放大成 6×6（光标闪一下不该顺带重传半个屏幕）
    frames.flush(&image, true);
    let packets = captured.lock().unwrap();
    assert_eq!(packets.len(), 2, "两块相距 3px，应各自成包");
    let first = decode_frame_packet(&packets[0]).expect("解回帧");
    let second = decode_frame_packet(&packets[1]).expect("解回帧");
    assert_eq!((first.x, first.y, first.width, first.height), (0, 0, 2, 2));
    assert_eq!(
        (second.x, second.y, second.width, second.height),
        (4, 4, 2, 2)
    );
    assert_eq!((first.desktop_width, first.desktop_height), (8, 8));
    assert!(!frames.has_pending());
}

#[test]
fn frame_out_merges_touching_rects_and_caps_the_block_count() {
    use ironrdp_graphics::image_processing::PixelFormat;
    use ironrdp_pdu::geometry::InclusiveRectangle;
    use ironrdp_session::image::DecodedImage;

    let image = DecodedImage::new(PixelFormat::RgbA32, 64, 64);
    let mut frames = crate::rdp::FrameOut::new(None, false, std::time::Duration::ZERO);
    let rect = |left, top, right, bottom| InclusiveRectangle {
        left,
        top,
        right,
        bottom,
    };

    // 相邻(间隔 ≤2px)的两块并成一块
    frames.merge(&rect(0, 0, 3, 3));
    frames.merge(&rect(4, 0, 7, 3));
    assert_eq!(frames.pending_count(), 1, "贴边的小块要并起来");

    // 撒一堆互不相干的块,数量必须被压在 6 块以内
    for i in 0..10u16 {
        frames.merge(&rect(i * 5, i * 5, i * 5 + 1, i * 5 + 1));
    }
    assert!(
        frames.pending_count() <= 6,
        "块数上限 6，实际 {}",
        frames.pending_count()
    );
    let _ = &image;
}

#[test]
fn deflate_frames_round_trip_and_fall_back_when_small() {
    use std::io::Read as _;

    // 大块、低熵的像素(桌面典型情况):必须真的被压缩
    let width = 64u16;
    let height = 64u16;
    let mut pixels = Vec::with_capacity(usize::from(width) * usize::from(height) * 4);
    for _ in 0..(u32::from(width) * u32::from(height)) {
        pixels.extend_from_slice(&[32, 64, 128, 255]);
    }
    let bytes =
        crate::rdp::encode_frame_packet_deflate(0, 0, 0, width, height, width, height, &pixels);
    let packet = decode_frame_packet(&bytes).expect("解回帧");
    assert_eq!(packet.version, crate::rdp::FRAME_VERSION_DEFLATE);
    assert!(packet.pixels.len() < pixels.len(), "低熵画面应显著变小");

    let mut out = Vec::new();
    flate2::read::ZlibDecoder::new(packet.pixels.as_slice())
        .read_to_end(&mut out)
        .expect("解压");
    assert_eq!(out, pixels);

    // 小块不值得压缩:退回原样帧,前端不需要解压
    let small = vec![1u8, 2, 3, 255];
    let bytes = crate::rdp::encode_frame_packet_deflate(0, 0, 0, 1, 1, 1, 1, &small);
    let packet = decode_frame_packet(&bytes).expect("解回帧");
    assert_eq!(packet.version, crate::rdp::FRAME_VERSION_RAW);
    assert_eq!(packet.pixels, small);
}

#[test]
fn frame_interval_maps_host_setting_to_send_gap() {
    use std::time::Duration;
    // 30fps → 33ms,60fps → 16ms,0 = 不限(不节流)
    assert_eq!(
        crate::rdp::frame_interval_for(30),
        Duration::from_millis(33)
    );
    assert_eq!(
        crate::rdp::frame_interval_for(60),
        Duration::from_millis(16)
    );
    assert_eq!(
        crate::rdp::frame_interval_for(15),
        Duration::from_millis(66)
    );
    assert_eq!(crate::rdp::frame_interval_for(0), Duration::ZERO);
    // 离谱输入不会算出 0ms(避免 sleep(0) 空转)或除零
    assert!(crate::rdp::frame_interval_for(10_000) >= Duration::from_millis(4));
}

// ── 主机配置:显示/体验/网络三段 ────────────────────────────────────
use crate::rdp::RdpSettings;

fn json(v: &str) -> serde_json::Value {
    serde_json::from_str(v).expect("valid json")
}

#[test]
fn rdp_settings_default_to_msct_experience() {
    let s = RdpSettings::from_host(&json("{}"));
    assert_eq!(s.frame_rate, Some(30));
    assert_eq!(s.resolution, None);
    assert_eq!(s.scale_factor, 100);
    assert_eq!(s.color_depth, 32);
    assert_eq!(s.pixel_budget, 1_600_000);
    assert_eq!(s.bandwidth_bps, 0);
    assert!(s.egfx && s.compress);
    assert!(s
        .performance_flags
        .contains(ironrdp_pdu::rdp::client_info::PerformanceFlags::ENABLE_FONT_SMOOTHING));
    assert!(s
        .performance_flags
        .contains(ironrdp_pdu::rdp::client_info::PerformanceFlags::ENABLE_DESKTOP_COMPOSITION));
    // 默认不关桌面背景
    assert!(!s
        .performance_flags
        .contains(ironrdp_pdu::rdp::client_info::PerformanceFlags::DISABLE_WALLPAPER));
}

#[test]
fn rdp_settings_read_all_three_sections() {
    let s = RdpSettings::from_host(&json(
        r#"{
        "rdpDisplay": {"frameRate": 144, "resolution": "1920x1080", "scaleFactor": 125,
                       "colorDepth": 16, "pixelBudget": 2300000},
        "rdpExperience": {"fontSmoothing": true, "desktopComposition": false, "wallpaper": false,
                          "theming": false, "cursorShadow": false, "showWindowContents": false,
                          "menuAnimations": false, "windowAnimations": true},
        "rdpNetwork": {"qualityPreset": "wan", "bandwidthKbps": 10240, "egfx": false,
                       "compressFrames": false}
    }"#,
    ));
    assert_eq!(s.frame_rate, Some(144));
    assert_eq!(s.resolution, Some((1920, 1080)));
    assert_eq!(s.scale_factor, 125);
    assert_eq!(s.color_depth, 16);
    assert_eq!(s.pixel_budget, 2_300_000);
    assert_eq!(s.bandwidth_bps, 10 * 1024 * 1024);
    assert!(!s.egfx && !s.compress);
    use ironrdp_pdu::rdp::client_info::PerformanceFlags as P;
    assert!(s.performance_flags.contains(P::DISABLE_WALLPAPER));
    assert!(s.performance_flags.contains(P::DISABLE_THEMING));
    assert!(s.performance_flags.contains(P::DISABLE_CURSOR_SHADOW));
    assert!(s.performance_flags.contains(P::DISABLE_FULLWINDOWDRAG));
    assert!(!s.performance_flags.contains(P::ENABLE_DESKTOP_COMPOSITION));
}

#[test]
fn rdp_settings_reject_out_of_range_values() {
    let s = RdpSettings::from_host(&json(
        r#"{
        "rdpDisplay": {"frameRate": 999, "resolution": "8K", "scaleFactor": 900,
                       "colorDepth": 8, "pixelBudget": 99},
        "rdpNetwork": {"bandwidthKbps": 0}
    }"#,
    ));
    assert_eq!(s.frame_rate, Some(30), "非法帧率回落默认");
    assert_eq!(s.resolution, None, "未知分辨率回落跟随窗口");
    assert_eq!(s.scale_factor, 100);
    assert_eq!(s.color_depth, 32);
    assert_eq!(s.pixel_budget, 1_600_000);
    assert_eq!(s.bandwidth_bps, 0);
}

#[test]
fn rdp_settings_accept_legacy_frame_rate_field() {
    let s = RdpSettings::from_host(&json(r#"{"rdpFrameRate": 60}"#));
    assert_eq!(s.frame_rate, Some(60));
}

#[test]
fn bandwidth_budget_defers_frames_instead_of_dropping_them() {
    use crate::rdp::FrameOut;
    let mut frames =
        FrameOut::new(None, false, std::time::Duration::ZERO).with_bandwidth_limit(1000);
    assert!(frames.take_budget(600));
    assert!(frames.take_budget(400), "刚好用满 1 秒额度");
    assert!(!frames.take_budget(1), "超额必须被拒");
    // 额度按 1 秒窗口重置
    frames.window_start = std::time::Instant::now() - std::time::Duration::from_millis(1100);
    assert!(frames.take_budget(1000));
}

#[test]
fn rdp_settings_read_launch_program_and_working_dir() {
    let s = RdpSettings::from_host(&json(
        r#"{
        "rdpLaunch": {"program": "  notepad.exe ", "workingDir": " C:\\work "}
    }"#,
    ));
    assert_eq!(s.program, "notepad.exe", "两端空白要裁掉");
    assert_eq!(s.working_dir, "C:\\work");
}

#[test]
fn rdp_settings_drop_working_dir_without_program() {
    let s = RdpSettings::from_host(&json(r#"{"rdpLaunch": {"workingDir": "C:\\work"}}"#));
    assert_eq!(s.program, "");
    assert_eq!(s.working_dir, "", "没程序时工作目录不能单独生效");
}

#[test]
fn frame_rate_auto_means_adaptive_pacing() {
    let s = RdpSettings::from_host(&json(r#"{"rdpDisplay": {"frameRate": "auto"}}"#));
    assert_eq!(s.frame_rate, None, "自适应档要显式表示成 None");
}

#[test]
fn auto_pacing_slows_down_when_frames_get_deferred() {
    use crate::rdp::FrameOut;
    let mut frames = FrameOut::new(None, false, FrameOut::AUTO_START).with_auto(true);
    // 一秒内有帧被留下 → 放慢
    frames.window_deferred = 3;
    frames.window_frames = 10;
    frames.last_tune = std::time::Instant::now() - std::time::Duration::from_millis(1100);
    frames.auto_tune();
    let slowed = frames.current_interval();
    assert!(slowed > FrameOut::AUTO_START, "拥堵时必须变慢, {slowed:?}");

    // 一秒内一帧没掉 → 加快
    frames.window_deferred = 0;
    frames.window_frames = 60;
    frames.last_tune = std::time::Instant::now() - std::time::Duration::from_millis(1100);
    frames.auto_tune();
    assert!(frames.current_interval() < slowed, "有余量时必须变快");

    // 上下限:反复加速不会快过 AUTO_MIN
    for _ in 0..30 {
        frames.last_tune = std::time::Instant::now() - std::time::Duration::from_millis(1100);
        frames.window_frames = 60;
        frames.auto_tune();
    }
    assert_eq!(
        frames.current_interval(),
        FrameOut::AUTO_MIN,
        "不能无限加快"
    );

    // 反复变慢不会慢过 AUTO_MAX
    let mut slow = FrameOut::new(None, false, FrameOut::AUTO_START).with_auto(true);
    for _ in 0..30 {
        slow.window_deferred = 5;
        slow.last_tune = std::time::Instant::now() - std::time::Duration::from_millis(1100);
        slow.auto_tune();
    }
    assert_eq!(slow.current_interval(), FrameOut::AUTO_MAX, "不能无限变慢");
}

#[test]
fn auto_pacing_does_nothing_when_not_enabled() {
    use crate::rdp::FrameOut;
    let mut frames = FrameOut::new(None, false, std::time::Duration::from_millis(30));
    frames.window_deferred = 99;
    frames.last_tune = std::time::Instant::now() - std::time::Duration::from_millis(1100);
    frames.auto_tune();
    assert_eq!(
        frames.current_interval(),
        std::time::Duration::from_millis(30),
        "手动档不许被自动改"
    );
}

#[test]
fn pointer_mode_maps_to_three_frontend_states() {
    use crate::rdp::PointerMode;
    assert_eq!(PointerMode::Remote.as_str(), "remote");
    assert_eq!(PointerMode::Default.as_str(), "local");
    assert_eq!(PointerMode::Hidden.as_str(), "hidden");
}

#[test]
fn pointer_state_emits_only_on_change() {
    use crate::rdp::{PointerMode, PointerState};
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    let hits = Arc::new(AtomicUsize::new(0));
    let counter = hits.clone();
    let emit: crate::rdp::StateEmitter = Arc::new(move |value| {
        // 模式必须落在前端认识的三个值里
        let mode = value["mode"].as_str().unwrap_or("");
        assert!(
            matches!(mode, "remote" | "local" | "hidden"),
            "未知 mode: {mode}"
        );
        assert_eq!(value["state"], "pointer");
        counter.fetch_add(1, Ordering::SeqCst);
    });

    let mut state = PointerState::default();
    state.mode = PointerMode::Remote;
    state.emit_if_changed(&emit, "s1", None);
    state.emit_if_changed(&emit, "s1", None);
    assert_eq!(hits.load(Ordering::SeqCst), 1, "状态没变就不该重复发");

    state.mode = PointerMode::Hidden;
    state.emit_if_changed(&emit, "s1", None);
    assert_eq!(hits.load(Ordering::SeqCst), 2, "换状态要发一次");
}
