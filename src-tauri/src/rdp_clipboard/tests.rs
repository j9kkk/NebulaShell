use super::*;

#[test]
fn build_response_answers_utf16_and_refuses_other_formats() {
    let ok = build_format_data_response(ClipboardFormatId::CF_UNICODETEXT.0, "你好 world");
    assert!(!ok.is_error());
    assert_eq!(ok.to_unicode_string().expect("解回 UTF-16"), "你好 world");

    let err = build_format_data_response(ClipboardFormatId::CF_DIB.0, "x");
    assert!(err.is_error(), "没广告过的图片格式必须回失败帧,不能空发");
}

#[test]
fn state_starts_idle_and_not_ready() {
    let st = ClipState::default();
    assert!(!st.ready);
    assert!(st.pending_request.is_none());
    assert!(!st.pending_paste);
    assert_eq!(st.local_seq, st.advertised_seq);
}

#[test]
fn bridge_only_keeps_text_formats() {
    let shared: SharedClip = Arc::new(Mutex::new(ClipState::default()));
    let bridge = ClipboardBridge::new(shared.clone());
    assert_eq!(
        bridge.client_capabilities(),
        ClipboardGeneralCapabilityFlags::empty()
    );
    assert!(!bridge.temp_dir.is_empty());
}

#[test]
fn remote_copy_sets_pending_paste_only_for_text() {
    let shared: SharedClip = Arc::new(Mutex::new(ClipState::default()));
    let mut bridge = ClipboardBridge::new(shared.clone());

    bridge.on_remote_copy(&[ClipboardFormat::new(ClipboardFormatId::CF_DIB)]);
    assert!(!shared.lock().unwrap().pending_paste, "只有图片时不去拉");

    bridge.on_remote_copy(&[ClipboardFormat::new(ClipboardFormatId::CF_UNICODETEXT)]);
    assert!(shared.lock().unwrap().pending_paste);
}

#[test]
fn format_data_request_is_recorded_for_the_session_loop() {
    let shared: SharedClip = Arc::new(Mutex::new(ClipState::default()));
    let mut bridge = ClipboardBridge::new(shared.clone());
    bridge.on_format_data_request(FormatDataRequest {
        format: ClipboardFormatId::CF_UNICODETEXT,
    });
    assert_eq!(
        shared.lock().unwrap().pending_request,
        Some(ClipboardFormatId::CF_UNICODETEXT.0)
    );
}

#[test]
fn error_and_empty_responses_never_reach_the_local_clipboard() {
    let shared: SharedClip = Arc::new(Mutex::new(ClipState::default()));
    let mut bridge = ClipboardBridge::new(shared.clone());
    bridge.on_format_data_response(FormatDataResponse::new_error());
    assert!(shared.lock().unwrap().incoming_text.is_none());
    bridge.on_format_data_response(FormatDataResponse::new_unicode_string(""));
    assert!(shared.lock().unwrap().incoming_text.is_none());
    bridge.on_format_data_response(FormatDataResponse::new_unicode_string("hello"));
    assert_eq!(
        shared.lock().unwrap().incoming_text.as_deref(),
        Some("hello")
    );
}
