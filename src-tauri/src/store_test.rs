// 存储单元测试:主机 CRUD/凭据留空语义/设置校验/导入导出
use crate::config::Store;
use serde_json::json;

fn tmp_store(tag: &str) -> Store {
    let dir =
        std::env::temp_dir().join(format!("nebula-store-test-{}-{}", tag, std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    Store::load_plain(dir)
}

#[test]
fn save_and_list_host() {
    let store = tmp_store("save");
    let saved = store
        .save_host(&json!({ "name": "web-1", "host": "10.0.0.1", "port": 22, "username": "root", "password": "pw" }))
        .unwrap();
    assert!(!saved["id"].as_str().unwrap().is_empty());
    assert_eq!(saved["hasPassword"], json!(true));
    let list = store.list_hosts();
    assert_eq!(list.len(), 1);
    assert_eq!(list[0]["name"], json!("web-1"));
    // 公开形态不泄漏明文
    assert!(list[0]["password"].is_null() || list[0]["password"] == json!(""));
    let _ = std::fs::remove_dir_all(&store.dir);
}

#[test]
fn edit_blank_password_keeps_old() {
    let store = tmp_store("edit");
    let saved = store
        .save_host(&json!({ "name": "db", "host": "10.0.0.2", "password": "old-pw" }))
        .unwrap();
    let id = saved["id"].as_str().unwrap().to_string();
    store
        .save_host(&json!({ "id": id, "name": "db", "host": "10.0.0.2", "password": "" }))
        .unwrap();
    let full = store.host_full(&id).unwrap();
    assert_eq!(full["password"], json!("old-pw"), "留空应保持原密码");
    let _ = std::fs::remove_dir_all(&store.dir);
}

#[test]
fn clone_host_copies_credentials() {
    let store = tmp_store("clone");
    let saved = store
        .save_host(&json!({ "name": "src", "host": "10.0.0.3", "password": "secret" }))
        .unwrap();
    let cloned = store.clone_host(saved["id"].as_str().unwrap()).unwrap();
    assert!(cloned["name"].as_str().unwrap().ends_with(" 副本"));
    let full = store.host_full(cloned["id"].as_str().unwrap()).unwrap();
    assert_eq!(full["password"], json!("secret"), "克隆应保留凭据");
    let _ = std::fs::remove_dir_all(&store.dir);
}

#[test]
fn cloud_import_idempotent() {
    let store = tmp_store("cloud");
    let cloud = json!({ "provider": "cvm", "region": "ap-gz", "instanceId": "ins-1" });
    let first = store
        .save_host(&json!({ "name": "cvm-1", "host": "1.1.1.1", "cloud": cloud.clone() }))
        .unwrap();
    let again = store
        .save_host(&json!({ "name": "cvm-1-renamed", "host": "1.1.1.1", "cloud": cloud }))
        .unwrap();
    assert_eq!(first["id"], again["id"], "重复导入只更新不新增");
    assert_eq!(store.list_hosts().len(), 1);
    assert_eq!(again["name"], json!("cvm-1-renamed"));
    let _ = std::fs::remove_dir_all(&store.dir);
}

#[test]
fn settings_roundtrip_and_clamp() {
    let store = tmp_store("settings");
    let s = store.save_settings(&json!({
        "terminal": { "fontSize": 99, "theme": "forest", "scrollback": 1 },
        "ai": { "baseUrl": "http://x/v1", "model": "m1" }
    }));
    assert_eq!(s["terminal"]["fontSize"], json!(20.0), "字号上限 20");
    assert_eq!(s["terminal"]["scrollback"], json!(1000.0), "回滚下限 1000");
    assert_eq!(s["terminal"]["theme"], json!("forest"));
    assert_eq!(s["ai"]["baseUrl"], json!("http://x/v1"));
}

#[test]
fn snippets_persist() {
    let store = tmp_store("snips");
    store.save_settings(
        &json!({ "snippets": [ { "name": "df", "cmd": "df -h" }, { "name": "", "cmd": "bad" } ] }),
    );
    let s = store.get_settings();
    assert_eq!(s["snippets"].as_array().unwrap().len(), 1, "空名片段被过滤");
}

#[test]
fn import_export_roundtrip() {
    let store = tmp_store("io");
    store
        .save_host(&json!({ "name": "a", "host": "10.0.0.1", "password": "pa" }))
        .unwrap();
    // 带凭据导出必须提供口令
    let exported = store.export_hosts(Some("correct horse battery")).unwrap();
    let text = serde_json::to_string(&exported).unwrap();
    let store2 = tmp_store("io2");
    let r = store2
        .import_hosts(&text, Some("correct horse battery"))
        .unwrap();
    assert_eq!(r["added"], json!(1));
    assert_eq!(r["withCredentials"], json!(1), "应恢复凭据");
    let list = store2.list_hosts();
    assert_eq!(list.len(), 1);
    let full = store2.host_full(list[0]["id"].as_str().unwrap()).unwrap();
    assert_eq!(full["password"], json!("pa"));
    // 重复导入去重
    let r2 = store2
        .import_hosts(&text, Some("correct horse battery"))
        .unwrap();
    assert_eq!(r2["added"], json!(0));
    let _ = std::fs::remove_dir_all(&store.dir);
    let _ = std::fs::remove_dir_all(&store2.dir);
}

/// 安全回归:不带口令导出时,文件里**不得出现任何明文凭据**。
#[test]
fn export_without_passphrase_contains_no_credentials() {
    let store = tmp_store("io-nocred");
    store
        .save_host(&json!({
            "name": "a", "host": "10.0.0.1", "username": "root",
            "password": "SuperSecret123", "privateKey": "-----BEGIN OPENSSH PRIVATE KEY-----"
        }))
        .unwrap();
    let exported = store.export_hosts(None).unwrap();
    let text = serde_json::to_string(&exported).unwrap();

    assert!(
        !text.contains("SuperSecret123"),
        "导出文件泄漏了明文密码: {}",
        text
    );
    assert!(
        !text.contains("BEGIN OPENSSH PRIVATE KEY"),
        "导出文件泄漏了明文私钥"
    );
    assert_eq!(exported["credentialsIncluded"], json!(false));
    assert!(exported["credentials"].is_null());
    // 主机信息本身仍应导出
    assert_eq!(exported["hosts"].as_array().unwrap().len(), 1);
    assert_eq!(exported["hosts"][0]["host"], json!("10.0.0.1"));

    // 导入该文件:主机到位,但凭据应缺失(需用户重填)
    let store2 = tmp_store("io-nocred2");
    let r = store2.import_hosts(&text, None).unwrap();
    assert_eq!(r["added"], json!(1));
    assert_eq!(r["withCredentials"], json!(0));
    let full = store2
        .host_full(store2.list_hosts()[0]["id"].as_str().unwrap())
        .unwrap();
    assert_eq!(full["password"], json!(""), "无凭据导出不应恢复出密码");
    let _ = std::fs::remove_dir_all(&store.dir);
    let _ = std::fs::remove_dir_all(&store2.dir);
}

/// 加密导出:密文不得包含明文,且错误口令必须失败。
#[test]
fn encrypted_export_is_confidential_and_passphrase_checked() {
    let store = tmp_store("io-enc");
    store
        .save_host(&json!({ "name": "b", "host": "10.0.0.2", "password": "TopSecret!" }))
        .unwrap();
    let exported = store.export_hosts(Some("my-passphrase-1")).unwrap();
    let text = serde_json::to_string(&exported).unwrap();
    assert!(!text.contains("TopSecret!"), "加密导出不应含明文");
    assert_eq!(exported["credentialsIncluded"], json!(true));

    // 错误口令:必须报错,不能悄悄导入空凭据或 panic
    let wrong = tmp_store("io-enc-wrong");
    let e = wrong.import_hosts(&text, Some("not-the-passphrase"));
    assert!(e.is_err(), "错误口令应失败,实际: {:?}", e);
    assert!(wrong.list_hosts().is_empty(), "失败时不应写入任何主机");

    // 缺失口令:也应失败并提示
    let missing = tmp_store("io-enc-missing");
    assert!(missing.import_hosts(&text, None).is_err());

    // 正确口令:凭据完整恢复(含解密后的明文)
    let ok = tmp_store("io-enc-ok");
    let r = ok.import_hosts(&text, Some("my-passphrase-1")).unwrap();
    assert_eq!(r["added"], json!(1));
    assert_eq!(r["withCredentials"], json!(1));
    let full = ok
        .host_full(ok.list_hosts()[0]["id"].as_str().unwrap())
        .unwrap();
    assert_eq!(full["password"], json!("TopSecret!"));

    let _ = std::fs::remove_dir_all(&store.dir);
    let _ = std::fs::remove_dir_all(&wrong.dir);
    let _ = std::fs::remove_dir_all(&missing.dir);
    let _ = std::fs::remove_dir_all(&ok.dir);
}

/// 向后兼容:旧版(v1)明文导出仍可导入,并标记 legacyPlaintext 以便提示用户。
#[test]
fn legacy_plaintext_export_still_imports() {
    let legacy = json!({
        "app": "nebulashell", "version": 1,
        "hosts": [{
            "name": "old", "host": "10.0.0.9", "port": 22, "username": "root",
            "authType": "password", "password": "legacy-plain-pw"
        }]
    });
    let store = tmp_store("io-legacy");
    let r = store
        .import_hosts(&serde_json::to_string(&legacy).unwrap(), None)
        .unwrap();
    assert_eq!(r["added"], json!(1));
    assert_eq!(r["legacyPlaintext"], json!(true), "应识别并提示旧格式");
    let full = store
        .host_full(store.list_hosts()[0]["id"].as_str().unwrap())
        .unwrap();
    assert_eq!(full["password"], json!("legacy-plain-pw"));
    let _ = std::fs::remove_dir_all(&store.dir);
}

/// 同一口令/内容两次导出应产生不同密文(随机 salt+nonce,避免可被比对)。
#[test]
fn export_ciphertext_is_nondeterministic() {
    let store = tmp_store("io-rand");
    store
        .save_host(&json!({ "name": "c", "host": "10.0.0.3", "password": "pw" }))
        .unwrap();
    let a = store.export_hosts(Some("same-passphrase")).unwrap();
    let b = store.export_hosts(Some("same-passphrase")).unwrap();
    assert_ne!(
        a["credentials"], b["credentials"],
        "两次导出的密文不应相同(salt/nonce 必须随机)"
    );
    let _ = std::fs::remove_dir_all(&store.dir);
}

#[test]
fn fingerprint_tofu_store() {
    let store = tmp_store("fp");
    {
        let mut data = store.data.lock().unwrap();
        data["knownHosts"]["127.0.0.1:22"] = json!("fp-abc");
    }
    store.save().unwrap();
    let store2 = Store::load_plain(store.dir.clone());
    let list = store2.list_fingerprints_for_test();
    assert_eq!(list.len(), 1);
    assert_eq!(list[0]["fp"], json!("fp-abc"));
    let _ = std::fs::remove_dir_all(&store.dir);
}

#[test]
fn dirty_flag_debounces_persistence() {
    let store = tmp_store("dirty");
    // 初始不脏:flush_if_dirty 不应写盘
    assert!(!store.flush_if_dirty(), "无变更时不应写盘");

    // 模拟 history:add —— 只改内存 + 标脏,不立即落盘
    {
        let mut data = store.data.lock().unwrap();
        data["history"] = json!([{ "cmd": "ls -la", "at": 1 }]);
    }
    store.mark_dirty();

    // 磁盘上此刻还没有该变更(去抖生效)
    let file = store.dir.join("nebulashell-config.json");
    let on_disk = std::fs::read_to_string(&file).unwrap_or_default();
    assert!(
        !on_disk.contains("ls -la"),
        "标记脏位后不应立即落盘(去抖未生效)"
    );

    // 触发一次去抖周期:应写入且脏位被清除
    assert!(store.flush_if_dirty(), "有变更时应写盘");
    let on_disk = std::fs::read_to_string(&file).unwrap();
    assert!(on_disk.contains("ls -la"), "落盘后应包含历史命令");
    assert!(!store.flush_if_dirty(), "写盘后脏位应被清除");

    // flush_now 无论脏否都写盘(退出路径),且不丢数据
    {
        let mut data = store.data.lock().unwrap();
        data["history"] = json!([{ "cmd": "whoami", "at": 2 }]);
    }
    store.flush_now();
    let on_disk = std::fs::read_to_string(&file).unwrap();
    assert!(
        on_disk.contains("whoami"),
        "flush_now 应无条件写盘,避免退出时丢最后一次变更"
    );

    // 重启后仍能读到(真实持久化)
    let store2 = Store::load_plain(store.dir.clone());
    let data = store2.data.lock().unwrap();
    assert_eq!(data["history"][0]["cmd"], json!("whoami"));

    let _ = std::fs::remove_dir_all(&store.dir);
}

#[test]
fn diag_plain_enc() {
    let store = tmp_store("diag");
    let c = store.enc("pw", "diag.password");
    eprintln!("cipher={}", c);
    let d = store.dec(&c);
    eprintln!("dec={}", d);
    assert_eq!(d, "pw");
}
