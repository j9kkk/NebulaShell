// 凭据往返回归测试:无论 Keychain 可用与否,保存的凭据必须能读回。
// 背景:keyring 的 set_password 曾在部分环境返回 Ok 但实际未落盘 → 密码"保存成功却失效"。
use nebulashell_lib::config::Store;
use serde_json::json;

fn tmp(tag: &str) -> std::path::PathBuf {
    let d = std::env::temp_dir().join(format!("nb-cred-{}-{}", tag, std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    d
}

#[test]
fn credential_survives_regardless_of_keyring() {
    // 生产路径(use_keyring=true):无论 Keychain 是否可用,密码都必须能读回
    let store = Store::load(tmp("prod"));
    let saved = store
        .save_host(&json!({ "name": "cred-a", "host": "10.1.1.1", "password": "pw-roundtrip-秘密" }))
        .unwrap();
    assert_eq!(saved["hasPassword"], json!(true), "保存后应立即标记有密码");
    let full = store.host_full(saved["id"].as_str().unwrap()).unwrap();
    assert_eq!(full["password"], json!("pw-roundtrip-秘密"), "密码必须能完整读回(含非 ASCII)");

    // 重新加载(模拟重启)
    let store2 = Store::load(store.dir.clone());
    let full2 = store2.host_full(saved["id"].as_str().unwrap()).unwrap();
    assert_eq!(full2["password"], json!("pw-roundtrip-秘密"), "重启后密码仍可读回");
    let _ = std::fs::remove_dir_all(&store.dir);
}

#[test]
fn encrypted_field_never_reads_back_empty() {
    // 加密产物必须自洽:enc() 的结果用 dec() 必须还原(否则界面显示"待补全凭据")
    let store = Store::load(tmp("self"));
    for secret in ["a", "short", "a-very-long-password-with-特殊字符-0123456789"] {
        let cipher = store.enc(secret, "test.path");
        assert!(!cipher.is_empty(), "非空输入必须产出密文标记");
        assert!(
            cipher.starts_with("aes:") || cipher.starts_with("plain:"),
            "密文必须是受支持格式(aes: 主格式 / plain: 极端回退): {}",
            cipher
        );
        assert!(cipher.starts_with("aes:"), "正常环境应使用 AES-GCM 加密: {}", cipher);
        assert_eq!(store.dec(&cipher), secret, "往返必须还原: {}", secret);
    }
    let _ = std::fs::remove_dir_all(&store.dir);
}

#[test]
fn private_key_also_roundtrips() {
    let store = Store::load(tmp("key"));
    let pem = "-----BEGIN OPENSSH PRIVATE KEY-----\nAAAAB3NzaC1yc2E\n-----END OPENSSH PRIVATE KEY-----";
    let saved = store
        .save_host(&json!({ "name": "k", "host": "10.2.2.2", "authType": "key", "privateKey": pem }))
        .unwrap();
    assert_eq!(saved["hasKey"], json!(true));
    let full = store.host_full(saved["id"].as_str().unwrap()).unwrap();
    assert_eq!(full["privateKey"], json!(pem), "私钥必须能完整读回含换行");
    let _ = std::fs::remove_dir_all(&store.dir);
}
