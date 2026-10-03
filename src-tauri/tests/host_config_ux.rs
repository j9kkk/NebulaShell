//! Focused UX regressions. All persistence is confined to unique temporary stores;
//! no SSH/cloud connections, native dialogs, or user configuration are touched.
use nebulashell_lib::config::Store;
use serde_json::{json, Value};

struct Fixture(Store);
impl Fixture {
    fn new() -> Self {
        Self(Store::load_plain(
            std::env::temp_dir().join(format!("nebula-host-ux-{}", uuid::Uuid::new_v4())),
        ))
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0.dir);
    }
}
fn id(host: &Value) -> &str {
    host["id"].as_str().unwrap()
}
fn text(value: &Value) -> String {
    serde_json::to_string(value).unwrap()
}
fn cloud(account: &str, region: &str) -> Value {
    json!({"accountId":account,"provider":"cvm","region":region,"instanceId":"ins-same","os":"Linux"})
}

#[test]
fn cloud_refresh_preserves_user_fields_and_credentials_but_refreshes_metadata() {
    let f = Fixture::new();
    let s = &f.0;
    let jump = s.save_host(&json!({"host":"jump.test"})).unwrap();
    let original = s
        .save_host(&json!({"host":"192.0.2.1","name":"discovered","cloud":cloud("a","r1")}))
        .unwrap();
    s.save_host(&json!({"id":id(&original),"host":"192.0.2.1","name":"my database","username":"alice","authType":"key","port":2222,"privateKey":"user-key","password":"user-password","passphrase":"user-phrase","keyPath":"/chosen/key","group":"production","tags":["owner"],"jumpIds":[id(&jump)],"initcmd":"tmux attach"})).unwrap();
    let mut metadata = cloud("a", "r1");
    metadata["os"] = json!("New Linux");
    metadata["status"] = json!("running");
    let refreshed = s.save_host(&json!({"host":"192.0.2.9","name":"cloud renamed","username":"root","authType":"password","port":22,"password":"cloud-password","privateKey":"cloud-key","passphrase":"cloud-phrase","group":"cloud","tags":["cvm"],"jumpIds":[],"initcmd":"","cloud":metadata})).unwrap();
    assert_eq!(original["id"], refreshed["id"]);
    let full = s.host_full(id(&original)).unwrap();
    for (field, expected) in [
        ("name", json!("my database")),
        ("username", json!("alice")),
        ("authType", json!("key")),
        ("port", json!(2222)),
        ("group", json!("production")),
        ("tags", json!(["owner"])),
        ("jumpIds", json!([id(&jump)])),
        ("initcmd", json!("tmux attach")),
        ("password", json!("user-password")),
        ("privateKey", json!("user-key")),
        ("passphrase", json!("user-phrase")),
        ("keyPath", json!("/chosen/key")),
    ] {
        assert_eq!(full[field], expected, "preserved {field}");
    }
    assert_eq!(full["host"], json!("192.0.2.9"));
    assert_eq!(full["cloud"]["os"], json!("New Linux"));
    assert_eq!(full["cloud"]["status"], json!("running"));
}

#[test]
fn cloud_identity_is_account_region_and_service_scoped_with_safe_legacy_upgrade() {
    let f = Fixture::new();
    let s = &f.0;
    for (account, region) in [("a", "r1"), ("b", "r1"), ("a", "r2")] {
        s.save_host(&json!({"host":"192.0.2.1","cloud":cloud(account,region)}))
            .unwrap();
    }
    assert_eq!(s.list_hosts().len(), 3);
    assert!(s
        .save_host(&json!({"host":"192.0.2.2","cloud":{"provider":"cvm","instanceId":"ins-same"}}))
        .is_err());
    let legacy = Fixture::new();
    let first = legacy
        .0
        .save_host(&json!({"host":"old.test","cloud":{"provider":"cvm","instanceId":"ins-same"}}))
        .unwrap();
    let second = legacy
        .0
        .save_host(&json!({"host":"new.test","cloud":cloud("a","r1")}))
        .unwrap();
    assert_eq!(first["id"], second["id"]);
    assert_eq!(second["cloud"]["accountId"], json!("a"));
}

#[test]
fn v3_full_roundtrip_remaps_forward_references_and_keeps_per_id_credentials() {
    let source = Fixture::new();
    let s = &source.0;
    let jump = s
        .save_host(&json!({"host":"shared.test","name":"jump","password":"jump-secret"}))
        .unwrap();
    // Same endpoint/login, independent host configuration and credentials.
    let target = s.save_host(&json!({"host":"shared.test","name":"target","password":"target-secret","jumpIds":[id(&jump)],"initcmd":"echo ready","cloud":cloud("a","r1"),"tags":["ops"]})).unwrap();
    let mut exported = s.export_hosts(Some("migration pass")).unwrap();
    assert_eq!(exported["version"], json!(3));
    assert_eq!(exported["hosts"][1]["id"], target["id"]);
    assert!(!text(&exported).contains("target-secret"));
    exported["hosts"].as_array_mut().unwrap().reverse();
    let destination = Fixture::new();
    let r = destination
        .0
        .import_hosts(&text(&exported), Some("migration pass"))
        .unwrap();
    assert_eq!(r["added"], json!(2));
    assert_eq!(r["withCredentials"], json!(2));
    let hosts = destination.0.list_hosts();
    let imported_jump = hosts.iter().find(|h| h["name"] == "jump").unwrap();
    let imported_target = hosts.iter().find(|h| h["name"] == "target").unwrap();
    assert_ne!(jump["id"], imported_jump["id"]);
    assert_ne!(target["id"], imported_target["id"]);
    assert_eq!(imported_target["jumpIds"], json!([id(imported_jump)]));
    assert_eq!(imported_target["initcmd"], json!("echo ready"));
    assert_eq!(imported_target["cloud"], cloud("a", "r1"));
    assert_eq!(
        destination.0.host_full(id(imported_target)).unwrap()["password"],
        json!("target-secret")
    );
    assert_eq!(
        destination.0.host_full(id(imported_jump)).unwrap()["password"],
        json!("jump-secret")
    );
    assert_eq!(
        destination
            .0
            .import_hosts(&text(&exported), Some("migration pass"))
            .unwrap()["added"],
        json!(0)
    );
    assert_eq!(destination.0.list_hosts().len(), 2);
}

#[test]
fn repeated_encrypted_import_fills_only_missing_credentials_and_preserves_edits() {
    let source = Fixture::new();
    source.0.save_host(&json!({"host":"example.test","password":"import-pw","privateKey":"import-key","passphrase":"import-phrase","name":"source","initcmd":"source command"})).unwrap();
    let public = source.0.export_hosts(None).unwrap();
    let encrypted = source.0.export_hosts(Some("pass")).unwrap();
    let dest = Fixture::new();
    dest.0.import_hosts(&text(&public), None).unwrap();
    let host = dest.0.list_hosts()[0].clone();
    dest.0.save_host(&json!({"id":id(&host),"host":"example.test","username":"custom-login","password":"local-pw","name":"custom","authType":"agent","group":"local","tags":["local"],"initcmd":"local command"})).unwrap();
    let r = dest
        .0
        .import_hosts(&text(&encrypted), Some("pass"))
        .unwrap();
    assert_eq!(r["added"], json!(0));
    assert_eq!(r["updated"], json!(1));
    assert_eq!(r["credentialsFilled"], json!(2));
    let full = dest.0.host_full(id(&host)).unwrap();
    assert_eq!(full["password"], json!("local-pw"));
    assert_eq!(full["privateKey"], json!("import-key"));
    assert_eq!(full["passphrase"], json!("import-phrase"));
    assert_eq!(full["username"], json!("custom-login"));
    assert_eq!(full["name"], json!("custom"));
    assert_eq!(full["authType"], json!("agent"));
    assert_eq!(full["initcmd"], json!("local command"));
    assert_eq!(full["group"], json!("local"));
    let again = dest
        .0
        .import_hosts(&text(&encrypted), Some("pass"))
        .unwrap();
    assert_eq!(again["updated"], json!(0));
    assert_eq!(again["credentialsFilled"], json!(0));
}

#[test]
fn invalid_import_graph_and_malformed_files_are_atomic_errors() {
    let f = Fixture::new();
    f.0.save_host(&json!({"host":"existing.test"})).unwrap();
    let before = f.0.list_hosts();
    let cases = [
        json!({"version":3,"hosts":[{"id":"a","host":"a.test","jumpIds":["missing"]}]}),
        json!({"version":3,"hosts":[{"id":"a","host":"a.test","jumpIds":["b"]},{"id":"b","host":"b.test","jumpIds":["a"]}]}),
        json!({"version":3,"hosts":[{"id":"a","host":"a.test","jumpIds":["a"]}]}),
        json!({"version":3,"hosts":[{"id":"a","host":"a.test"},{"id":"a","host":"b.test"}]}),
        json!({"version":3,"hosts":[{"host":"a.test"}]}),
        json!({"hosts":{}}),
        json!({"version":99,"hosts":[]}),
        json!({"hosts":[{"host":""}]}),
    ];
    for file in cases {
        assert!(f.0.import_hosts(&text(&file), None).is_err(), "{file}");
        assert_eq!(f.0.list_hosts(), before, "no partial write: {file}");
        assert_eq!(Store::load_plain(f.0.dir.clone()).list_hosts(), before);
    }
}

#[test]
fn explicit_secret_clear_is_persistent_independent_and_takes_precedence() {
    let f = Fixture::new();
    let host = f.0.save_host(&json!({"host":"clear.test","password":"pw","privateKey":"key","passphrase":"phrase","keyPath":"/key"})).unwrap();
    f.0.save_host(
        &json!({"id":id(&host),"host":"clear.test","password":"","privateKey":"","passphrase":""}),
    )
    .unwrap();
    assert_eq!(f.0.host_full(id(&host)).unwrap()["password"], json!("pw"));
    f.0.save_host(&json!({"id":id(&host),"host":"clear.test","clearSecrets":["password"],"password":"replacement"})).unwrap();
    let full = f.0.host_full(id(&host)).unwrap();
    assert_eq!(full["password"], json!(""));
    assert_eq!(full["privateKey"], json!("key"));
    assert_eq!(full["passphrase"], json!("phrase"));
    f.0.save_host(
        &json!({"id":id(&host),"host":"clear.test","clearSecrets":["privateKey","passphrase"]}),
    )
    .unwrap();
    let reloaded = Store::load_plain(f.0.dir.clone());
    let full = reloaded.host_full(id(&host)).unwrap();
    assert_eq!(full["privateKey"], json!(""));
    assert_eq!(full["passphrase"], json!(""));
    assert_eq!(full["keyPath"], json!(""));
    let public = reloaded.public_host(id(&host)).unwrap();
    assert_eq!(public["hasPassword"], json!(false));
    assert_eq!(public["hasKey"], json!(false));
    assert_eq!(public["hasPassphrase"], json!(false));
    assert!(f
        .0
        .save_host(&json!({"id":id(&host),"host":"clear.test","clearSecrets":["unknown"]}))
        .is_err());
}

#[test]
fn v1_and_v2_duplicate_imports_fill_missing_credentials_without_overwrite() {
    let f = Fixture::new();
    let h =
        f.0.save_host(&json!({"host":"LEGACY.test","password":"local"}))
            .unwrap();
    let legacy = json!({"version":1,"hosts":[{"host":"legacy.test","name":"source","password":"imported","privateKey":"legacy-key"}]});
    let r = f.0.import_hosts(&text(&legacy), None).unwrap();
    assert_eq!(r["added"], json!(0));
    assert_eq!(r["updated"], json!(1));
    assert_eq!(r["legacyPlaintext"], json!(true));
    assert_eq!(f.0.host_full(id(&h)).unwrap()["password"], json!("local"));
    assert_eq!(
        f.0.host_full(id(&h)).unwrap()["privateKey"],
        json!("legacy-key")
    );
    assert_eq!(
        f.0.import_hosts(
            &text(&json!({"version":2,"hosts":[{"host":"legacy.test"}]})),
            None
        )
        .unwrap()["skipped"],
        json!(1)
    );
}

#[test]
fn repeat_import_into_local_duplicate_remembers_source_after_user_changes_login() {
    let source = Fixture::new();
    source
        .0
        .save_host(&json!({"host":"local.test","password":"imported","cloud":cloud("a","r1")}))
        .unwrap();
    let public = source.0.export_hosts(None).unwrap();
    let encrypted = source.0.export_hosts(Some("pass")).unwrap();
    let dest = Fixture::new();
    let local = dest
        .0
        .save_host(&json!({"host":"local.test","name":"mine"}))
        .unwrap();
    assert_eq!(
        dest.0.import_hosts(&text(&public), None).unwrap()["added"],
        json!(0)
    );
    dest.0
        .save_host(&json!({"id":id(&local),"host":"moved.test","username":"alice"}))
        .unwrap();
    let result = dest
        .0
        .import_hosts(&text(&encrypted), Some("pass"))
        .unwrap();
    assert_eq!(result["added"], json!(0));
    assert_eq!(result["credentialsFilled"], json!(1));
    let full = dest.0.host_full(id(&local)).unwrap();
    assert_eq!(full["host"], json!("moved.test"));
    assert_eq!(full["username"], json!("alice"));
    assert_eq!(full["name"], json!("mine"));
    assert_eq!(full["password"], json!("imported"));
    assert_eq!(dest.0.list_hosts().len(), 1);
}

#[test]
fn jump_validation_on_save_and_delete_cleans_references() {
    let f = Fixture::new();
    let jump = f.0.save_host(&json!({"host":"jump.test"})).unwrap();
    let target =
        f.0.save_host(&json!({"host":"target.test","jumpIds":[id(&jump)]}))
            .unwrap();
    assert!(f
        .0
        .save_host(&json!({"id":id(&jump),"host":"jump.test","jumpIds":[id(&target)]}))
        .is_err());
    assert!(f
        .0
        .save_host(&json!({"host":"invalid.test","jumpIds":["missing"]}))
        .is_err());
    f.0.delete_host(id(&jump)).unwrap();
    assert_eq!(f.0.public_host(id(&target)).unwrap()["jumpIds"], json!([]));
    assert!(f.0.export_hosts(None).is_ok());
}

#[test]
fn ai_credentials_are_endpoint_and_protocol_scoped_and_explicitly_clearable() {
    let f = Fixture::new();
    let s = &f.0;
    s.save_settings(
        &json!({"ai":{"baseUrl":"https://one.test/v1/","protocol":"openai","apiKey":"one-key"}}),
    );
    let unchanged = s.save_settings(
        &json!({"ai":{"baseUrl":" https://one.test/v1 ","protocol":"openai","apiKey":""}}),
    );
    assert_eq!(unchanged["ai"]["apiKeySet"], json!(true));
    assert_eq!(
        s.save_settings(&json!({"ai":{"baseUrl":"https://two.test/v1","apiKey":""}}))["ai"]
            ["apiKeySet"],
        json!(false)
    );
    assert_eq!(
        s.save_settings(&json!({"ai":{"apiKey":"two-key"}}))["ai"]["apiKeySet"],
        json!(true)
    );
    assert_eq!(
        s.save_settings(&json!({"ai":{"protocol":"anthropic"}}))["ai"]["apiKeySet"],
        json!(false)
    );
    assert_eq!(
        s.save_settings(&json!({"ai":{"baseUrl":"https://three.test","apiKey":"three-key"}}))["ai"]
            ["apiKeySet"],
        json!(true)
    );
    assert_eq!(
        s.save_settings(&json!({"ai":{"clearApiKey":true,"apiKey":"must-not-win"}}))["ai"]
            ["apiKeySet"],
        json!(false)
    );
    assert_eq!(
        Store::load_plain(s.dir.clone()).get_settings()["ai"]["apiKeySet"],
        json!(false)
    );
}
