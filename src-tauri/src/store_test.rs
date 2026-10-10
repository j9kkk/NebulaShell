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

/// 多账号云凭据:从旧的单密钥结构(settings.clouds.*)自动迁移,
/// secretEnc 直接搬移(已是加密串,无需解密再加密)。
#[test]
fn cloud_accounts_migrate_from_legacy_single_key() {
    let dir = std::env::temp_dir().join(format!("nb-legacy-cloud-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    // 模拟"旧版应用留下的配置文件":直接写盘(含旧结构、无 cloudAccounts 标志),
    // 再用新版 load —— 与真实升级路径一致。secretEnc 用当前实现加密,
    // 保证格式与旧版兼容(同一段代码自 v1.0 起未变)。
    {
        let probe = Store::load_plain(dir.clone());
        let secret_enc = probe.enc("legacy-secret-1", "t");
        let legacy = json!({
            "version": 1, "hosts": [], "snippets": [], "forwards": [], "bookmarks": [], "history": [],
            "knownHosts": {},
            "settings": {
                "clouds": { "tencent": { "key": "AKID-legacy-1", "secretEnc": secret_enc, "endpoint": "" },
                            "aliyun": { "key": "", "secret": "", "endpoint": "" } }
            }
        });
        std::fs::write(
            dir.join("nebulashell-config.json"),
            serde_json::to_string_pretty(&legacy).unwrap(),
        )
        .unwrap();
    }
    let s2 = Store::load_plain(dir.clone());
    // 迁移发生(load 时 cloudAccounts 为空 → 从旧结构搬移)
    let accounts = {
        let data = s2.data.lock().unwrap();
        data["settings"]["cloudAccounts"]
            .as_array()
            .cloned()
            .unwrap_or_default()
    };
    assert_eq!(accounts.len(), 1, "应迁移出 1 个腾讯云账号");
    assert_eq!(accounts[0]["vendor"], json!("tencent"));
    assert_eq!(accounts[0]["keyId"], json!("AKID-legacy-1"));
    // 迁移后凭据应可解密回原值
    let (key, secret, _, vendor) = s2
        .cloud_account_creds(accounts[0]["id"].as_str().unwrap())
        .unwrap();
    assert_eq!(key, "AKID-legacy-1");
    assert_eq!(secret, "legacy-secret-1");
    assert_eq!(vendor, "tencent");
    let _ = std::fs::remove_dir_all(&dir);
}

/// 多账号 CRUD:保存(新增/编辑)、删除、凭据读取。
#[test]
fn cloud_accounts_crud() {
    let store = tmp_store("cloud-acct");
    // 新增腾讯云账号
    let r1 = store
        .save_cloud_account("", "公司主账号", "tencent", "AKID-aaa", "secret-one", "")
        .unwrap();
    let id1 = r1["id"].as_str().unwrap().to_string();
    // 新增阿里云账号
    let r2 = store
        .save_cloud_account(
            "",
            "测试账号",
            "aliyun",
            "LTAI-bbb",
            "secret-two",
            "https://ecs.example.com",
        )
        .unwrap();
    let id2 = r2["id"].as_str().unwrap().to_string();
    assert_ne!(id1, id2);

    let accounts = store.get_settings()["cloudAccounts"]
        .as_array()
        .cloned()
        .unwrap();
    assert_eq!(accounts.len(), 2);
    // 公开形态不得包含密文
    for a in &accounts {
        assert!(a["secretEnc"].is_null(), "公开形态泄漏了 secretEnc");
        assert_eq!(a["secretSet"], json!(true));
    }
    // 凭据可读回
    let (k, s, ep, v) = store.cloud_account_creds(&id2).unwrap();
    assert_eq!(
        (k.as_str(), s.as_str(), v.as_str()),
        ("LTAI-bbb", "secret-two", "aliyun")
    );
    assert_eq!(ep, "https://ecs.example.com");
    // 编辑:留空 secret 保持不变
    store
        .save_cloud_account(&id1, "改名了", "tencent", "AKID-aaa", "", "")
        .unwrap();
    let (_, s1, _, _) = store.cloud_account_creds(&id1).unwrap();
    assert_eq!(s1, "secret-one", "编辑时留空 Secret 不应清掉原密钥");
    // 删除
    let removed = store.delete_cloud_account(&id1).unwrap();
    assert_eq!(removed, 1);
    assert!(store.cloud_account_creds(&id1).is_err());
    // 非法输入
    assert!(
        store
            .save_cloud_account("", "x", "tencent", "", "s", "")
            .is_err(),
        "空 KeyId 应拒绝"
    );
    assert!(
        store
            .save_cloud_account("", "x", "tencent", "K", "", "")
            .is_err(),
        "新增缺 Secret 应拒绝"
    );
    // 编辑时改厂商:留空 Secret 必须被拒绝(否则旧厂商的密钥会被静默沿用)
    assert!(
        store
            .save_cloud_account(&id2, "改成腾讯", "tencent", "LTAI-bbb", "", "")
            .is_err(),
        "换厂商留空 Secret 应拒绝"
    );
    let (_, s2, _, v2) = store.cloud_account_creds(&id2).unwrap();
    assert_eq!(v2, "aliyun", "被拒的换厂商保存不应改动原账号");
    assert_eq!(s2, "secret-two");
    // 换厂商且重输了 Secret 则允许
    store
        .save_cloud_account(&id2, "改成腾讯", "tencent", "AKID-ccc", "secret-new", "")
        .unwrap();
    let (k2, s2b, _, v2b) = store.cloud_account_creds(&id2).unwrap();
    assert_eq!(
        (k2.as_str(), s2b.as_str(), v2b.as_str()),
        ("AKID-ccc", "secret-new", "tencent")
    );
    let _ = std::fs::remove_dir_all(&store.dir);
}

/// 命令历史条目清洗:去控制序列,并按行编辑语义重放旧版采集原样存下的按键。
#[test]
fn clean_command_strips_sequences_and_replays_line_edits() {
    use crate::config::clean_command;
    assert_eq!(
        clean_command("\u{1b}[200~ss -tulnp | grep -E '80|443'\u{1b}[201~"),
        "ss -tulnp | grep -E '80|443'"
    );
    assert_eq!(clean_command("\u{1b}[A"), "");
    assert_eq!(clean_command("\u{1b}[31mls\u{1b}[0m"), "ls");
    assert_eq!(clean_command("a\u{1b}OAb\u{1b}(Bc\u{1b}=d"), "abcd");
    assert_eq!(
        clean_command("x\u{1b}]0;title\u{7}y\u{1b}Pq\u{1b}\\z"),
        "xyz"
    );
    assert_eq!(clean_command("rm -rf /tmp/x\u{3}pwd"), "pwd");
    assert_eq!(clean_command("whoami\u{15}id"), "id");
    assert_eq!(clean_command("echo hello world\u{17}"), "echo hello");
    assert_eq!(clean_command("lss\u{7f} -la"), "ls -la");
    assert_eq!(clean_command("  echo a\r\n\techo b  "), "echo a\n\techo b");
    assert_eq!(clean_command("a\u{9b}b"), "ab");
    assert_eq!(clean_command("\u{1b}"), "");
    assert_eq!(clean_command("echo 你好"), "echo 你好");
}

/// 旧版命令历史在加载时清洗:删空条目与非对象、同一命令只留最新一条,并置脏落盘;
/// 清洗是幂等的,再次加载不再置脏。
#[test]
fn history_is_cleaned_on_load() {
    let dir = std::env::temp_dir().join(format!("nb-legacy-history-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let entry =
        |cmd: &str, at: i64| json!({ "hostId": "h1", "host": "root@a", "cmd": cmd, "at": at });
    let legacy = json!({
        "version": 1, "hosts": [], "snippets": [], "forwards": [], "bookmarks": [], "knownHosts": {},
        "history": [
            entry("ls -la", 1),
            entry("\u{1b}[200~ss -tulnp | grep -E '80|443'\u{1b}[201~", 2),
            entry("\u{1b}[A", 3),
            entry("rm -rf /tmp/x\u{3}pwd", 4),
            "not an object",
            entry("  ls -la  ", 5),
        ]
    });
    std::fs::write(
        dir.join("nebulashell-config.json"),
        serde_json::to_string_pretty(&legacy).unwrap(),
    )
    .unwrap();
    let store = Store::load_plain(dir.clone());
    {
        let data = store.data.lock().unwrap();
        let history = data["history"].as_array().unwrap();
        let cmds: Vec<&str> = history.iter().map(|h| h["cmd"].as_str().unwrap()).collect();
        assert_eq!(cmds, vec!["ss -tulnp | grep -E '80|443'", "pwd", "ls -la"]);
        assert_eq!(history[2]["at"], json!(5), "重复命令保留最新一条");
        assert_eq!(history[0]["host"], json!("root@a"), "其余字段原样保留");
    }
    assert!(store.flush_if_dirty(), "清洗有改动应置脏落盘");
    let again = Store::load_plain(dir.clone());
    assert!(!again.flush_if_dirty(), "已清洗的历史再次加载不应置脏");
    let _ = std::fs::remove_dir_all(&dir);
}

/// history:add:入库前清洗,清洗后为空不记;同一命令只留最新;history 字段被
/// 写坏(非数组)时重置而不是 panic。
#[test]
fn add_history_cleans_dedups_and_survives_corrupt_field() {
    let store = tmp_store("add-history");
    assert!(!store.add_history(json!("h1"), json!("root@a"), "\u{1b}[A"));
    assert!(!store.flush_if_dirty(), "没记录就不置脏");
    {
        let mut data = store.data.lock().unwrap();
        data["history"] = json!({ "broken": true });
    }
    assert!(store.add_history(json!("h1"), json!("root@a"), "\u{1b}[200~uptime\u{1b}[201~"));
    assert!(store.add_history(json!("h1"), json!("root@a"), "df -h"));
    assert!(store.add_history(json!("h1"), json!("root@a"), " uptime "));
    {
        let data = store.data.lock().unwrap();
        let cmds: Vec<&str> = data["history"]
            .as_array()
            .unwrap()
            .iter()
            .map(|h| h["cmd"].as_str().unwrap())
            .collect();
        assert_eq!(cmds, vec!["df -h", "uptime"]);
    }
    assert!(store.flush_if_dirty());
    let _ = std::fs::remove_dir_all(&store.dir);
}

/// 文件分屏书签:增删幂等,别名可设可清,重排只动该主机的条目(其他主机位置不变),
/// bookmarks 字段被写坏时重置而不是 panic。
#[test]
fn bookmarks_add_alias_reorder_are_host_scoped() {
    let store = tmp_store("bookmarks");
    let paths = |store: &Store| -> Vec<(String, String, String)> {
        let data = store.data.lock().unwrap();
        data["bookmarks"]
            .as_array()
            .unwrap()
            .iter()
            .map(|b| {
                (
                    b["hostId"].as_str().unwrap().to_string(),
                    b["path"].as_str().unwrap().to_string(),
                    b["name"].as_str().unwrap_or("").to_string(),
                )
            })
            .collect()
    };
    assert!(store.add_bookmark("h1", "/etc/nginx"));
    assert!(store.add_bookmark("h2", "/srv"));
    assert!(store.add_bookmark("h1", "/var/log"));
    assert!(store.add_bookmark("h1", "/opt/app"));
    assert!(!store.add_bookmark("h1", "/var/log"), "重复收藏不新增");
    assert!(!store.add_bookmark("h1", "relative/dir"), "只收藏绝对路径");
    assert!(!store.add_bookmark("", "/tmp"), "没有主机不收藏");

    assert!(store.update_bookmark("h1", "/var/log", "  日志  "));
    assert!(
        !store.update_bookmark("h1", "/nope", "x"),
        "找不到的书签返回 false"
    );
    assert_eq!(paths(&store)[2].2, "日志", "别名去首尾空白");
    let long = "长".repeat(80);
    assert!(store.update_bookmark("h1", "/etc/nginx", &long));
    assert_eq!(paths(&store)[0].2.chars().count(), 64, "别名最长 64 字符");
    assert!(store.update_bookmark("h1", "/etc/nginx", "   "));
    assert_eq!(paths(&store)[0].2, "", "空别名清除");

    // h1 的三条按新顺序填回原位置(0、2、3),h2 的 /srv 仍在第 1 位;
    // 未列出的 /etc/nginx 排在列出的之后,未知路径忽略
    store.reorder_bookmarks(
        "h1",
        &[
            "/opt/app".to_string(),
            "/var/log".to_string(),
            "/unknown".to_string(),
        ],
    );
    let after: Vec<(String, String)> = paths(&store).into_iter().map(|(h, p, _)| (h, p)).collect();
    assert_eq!(
        after,
        vec![
            ("h1".to_string(), "/opt/app".to_string()),
            ("h2".to_string(), "/srv".to_string()),
            ("h1".to_string(), "/var/log".to_string()),
            ("h1".to_string(), "/etc/nginx".to_string()),
        ]
    );
    assert_eq!(paths(&store)[2].2, "日志", "重排保留别名");

    assert!(store.remove_bookmark("h1", "/var/log"));
    assert!(!store.remove_bookmark("h1", "/var/log"));
    // 重启后顺序与别名仍在
    let reloaded = Store::load_plain(store.dir.clone());
    assert_eq!(paths(&reloaded).len(), 3);
    {
        let mut data = reloaded.data.lock().unwrap();
        data["bookmarks"] = json!({ "broken": true });
    }
    assert!(
        reloaded.add_bookmark("h1", "/tmp"),
        "字段被写坏时重置为空数组再收藏"
    );
    assert_eq!(paths(&reloaded).len(), 1);
    let _ = std::fs::remove_dir_all(&store.dir);
}
