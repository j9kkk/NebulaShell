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
    let exported = store.export_hosts().unwrap();
    let text = serde_json::to_string(&exported).unwrap();
    let store2 = tmp_store("io2");
    let r = store2.import_hosts(&text).unwrap();
    assert_eq!(r["added"], json!(1));
    let list = store2.list_hosts();
    assert_eq!(list.len(), 1);
    let full = store2.host_full(list[0]["id"].as_str().unwrap()).unwrap();
    assert_eq!(full["password"], json!("pa"));
    // 重复导入去重
    let r2 = store2.import_hosts(&text).unwrap();
    assert_eq!(r2["added"], json!(0));
    let _ = std::fs::remove_dir_all(&store.dir);
    let _ = std::fs::remove_dir_all(&store2.dir);
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
fn diag_plain_enc() {
    let store = tmp_store("diag");
    let c = store.enc("pw", "diag.password");
    eprintln!("cipher={}", c);
    let d = store.dec(&c);
    eprintln!("dec={}", d);
    assert_eq!(d, "pw");
}
