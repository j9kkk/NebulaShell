// SSH 层单测:流式 UTF-8 重组 + 服务器指纹格式兼容。
// 与 cloud_test.rs / store_test.rs 等保持一致 —— 单测一律独立成文件,
// 不在业务文件里夹带 #[cfg(test)] 模块。
use crate::ssh::{fp_digest, fp_matches, take_utf8, RemoteTargets, SshHandler};
use russh::client::Handler as _;
use serde_json::json;

// ---------- 流式 UTF-8 重组(中文跨包变乱码的根因) ----------

/// 完整的 ASCII 应立即全部取出
#[test]
fn ascii_passes_through() {
    let mut p = b"hello".to_vec();
    assert_eq!(take_utf8(&mut p), "hello");
    assert!(p.is_empty());
}

/// 多字节字符被切成两半时,前一半必须留在缓冲里等下一批,
/// 不能产出 U+FFFD(这正是"中文跨包变乱码"的根因)。
#[test]
fn split_multibyte_is_buffered_not_replaced() {
    let full = "中".as_bytes().to_vec(); // 3 字节
    let mut p = vec![full[0]];
    assert_eq!(take_utf8(&mut p), "", "不完整字符不应产出任何文本");
    assert_eq!(p, vec![full[0]], "不完整字节应留在缓冲");

    // 第二批补齐剩余字节 -> 拼出完整汉字
    p.extend_from_slice(&full[1..]);
    assert_eq!(take_utf8(&mut p), "中");
    assert!(p.is_empty());
}

/// 前缀完整 + 尾部残缺:只吐出完整部分,残缺留待下批
#[test]
fn partial_tail_is_retained() {
    let mut p = b"abc".to_vec();
    p.extend_from_slice(&"中".as_bytes()[..2]); // 只有 2/3 字节
    assert_eq!(take_utf8(&mut p), "abc");
    assert_eq!(p.len(), 2, "残缺的 2 字节应留存");

    p.push("中".as_bytes()[2]);
    assert_eq!(take_utf8(&mut p), "中");
}

/// 4 字节字符(emoji)同样不能被切断
#[test]
fn four_byte_sequence_is_buffered() {
    let e = "😀".as_bytes().to_vec(); // 4 字节
    let mut p = e[..3].to_vec();
    assert_eq!(take_utf8(&mut p), "", "3/4 字节时不应产出文本");
    p.push(e[3]);
    assert_eq!(take_utf8(&mut p), "😀");
}

/// 逐字节喂入完整字符串,最终结果必须与原文逐字一致
#[test]
fn byte_by_byte_reassembly_matches_original() {
    let text = "中文测试 emoji😀 混排 abc";
    let bytes = text.as_bytes();
    let mut p = Vec::new();
    let mut out = String::new();
    for b in bytes {
        p.push(*b);
        out.push_str(&take_utf8(&mut p));
    }
    assert_eq!(out, text, "逐字节重组结果应与原文一致");
    assert!(!out.contains('\u{FFFD}'), "不应出现替换字符");
}

// ---------- 服务器指纹格式兼容 ----------
// 回归:Electron 时代的 knownHosts 以 64 位 hex 存储,现行 russh 算的是
// 43 位 base64-nopad,直接字符串比较会把同一把密钥误判为"密钥已变更"。

/// 与用户被卡住的案例同构:同一把 ed25519 密钥,hex 存档 vs base64 现算
#[test]
fn legacy_hex_fingerprint_matches_base64() {
    let stored_hex = "e321c9b4e68d3c075f94eefc197cfa5078c57178ced217489fcf94d6a738efa5";
    let current_b64 = data_encoding::BASE64_NOPAD.encode(&fp_digest(stored_hex).unwrap());
    assert_eq!(current_b64.len(), 43, "base64-nopad 摘要应为 43 字符");
    assert!(
        fp_matches(stored_hex, &current_b64),
        "hex 遗留记录必须匹配 base64 现算指纹"
    );
    // 反向同样成立,且 OpenSSH 展示格式(SHA256:xxx)也兼容
    assert!(fp_matches(&current_b64, stored_hex));
    assert!(fp_matches(&format!("SHA256:{}", current_b64), stored_hex));
}

#[test]
fn different_digests_never_match() {
    let a = data_encoding::HEXLOWER.encode(&[1u8; 32]);
    let b = data_encoding::BASE64_NOPAD.encode(&[2u8; 32]);
    assert!(!fp_matches(&a, &b), "摘要不同不得通过校验");
    assert!(!fp_matches("", &b) && !fp_matches(&a, ""), "空值不得通过");
}

/// 端到端:配置里预置 hex 格式指纹,check_server_key 应放行,并把记录
/// 自愈升级为现行 base64 格式(之后无需再进兼容分支)
#[tokio::test]
async fn check_server_key_accepts_legacy_hex_and_upgrades_it() {
    let dir = std::env::temp_dir().join(format!("nb-fp-{}", uuid::Uuid::new_v4()));
    let store = crate::config::Store::load_plain(dir.clone());
    let kp = russh::keys::key::KeyPair::generate_ed25519();
    let pk = kp.clone_public_key().unwrap();
    let fp = pk.fingerprint();
    let digest = fp_digest(&fp).unwrap();
    let legacy_hex = data_encoding::HEXLOWER.encode(&digest);

    let mut handler = SshHandler {
        host_id: "h1".into(),
        key: "127.0.0.1:22".into(),
        password: String::new(),
        store: std::sync::Arc::new(store),
        remote_targets: RemoteTargets::default(),
        remote_pump: None,
    };
    // 预置 hex 遗留记录
    {
        let mut data = handler.store.data.lock().unwrap();
        data["knownHosts"]["127.0.0.1:22"] = json!(legacy_hex.clone());
    }
    assert!(
        handler.check_server_key(&pk).await.unwrap(),
        "同一把密钥的 hex 遗留指纹必须放行"
    );
    let upgraded = {
        let data = handler.store.data.lock().unwrap();
        data["knownHosts"]["127.0.0.1:22"]
            .as_str()
            .unwrap()
            .to_string()
    };
    assert_eq!(upgraded, fp, "放行的同时应把记录升级为现行 base64 格式");

    // 摘要真的不同 → 必须拒绝
    let other = russh::keys::key::KeyPair::generate_ed25519()
        .clone_public_key()
        .unwrap();
    assert!(
        !handler.check_server_key(&other).await.unwrap(),
        "不同密钥必须拒绝"
    );
    let _ = std::fs::remove_dir_all(&dir);
}
