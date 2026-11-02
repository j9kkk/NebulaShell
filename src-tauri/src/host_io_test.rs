//! 导入/导出回归:解析、校验、行号反馈、幂等与字段对齐。
use crate::config::Store;
use crate::host_io::{
    decode_import_bytes, item_lines, read_import_file, MAX_IMPORT_BYTES, MAX_IMPORT_HOSTS,
};
use serde_json::{json, Value};

fn tmp_store(tag: &str) -> Store {
    let dir = std::env::temp_dir().join(format!(
        "nebula-host-io-test-{}-{}",
        tag,
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&dir);
    Store::load_plain(dir)
}

fn pretty(value: &Value) -> String {
    serde_json::to_string_pretty(value).unwrap()
}

fn line_of(text: &str, needle: &str) -> usize {
    text.lines()
        .position(|l| l.contains(needle))
        .map(|i| i + 1)
        .unwrap_or_else(|| panic!("找不到 {}:\n{}", needle, text))
}

// ---------------- 解析:编码 / BOM / 超限 ----------------

#[test]
fn import_accepts_utf8_bom_utf16_and_rejects_non_utf8() {
    let plain = "{\n  \"version\": 4,\n  \"hosts\": [{\"id\": \"a\", \"host\": \"10.0.0.1\"}]\n}";

    let mut utf8_bom = vec![0xEF, 0xBB, 0xBF];
    utf8_bom.extend_from_slice(plain.as_bytes());
    assert_eq!(decode_import_bytes("bom.json", &utf8_bom).unwrap(), plain);

    let mut utf16_le = vec![0xFF, 0xFE];
    for unit in plain.encode_utf16() {
        utf16_le.extend_from_slice(&unit.to_le_bytes());
    }
    assert_eq!(decode_import_bytes("le.json", &utf16_le).unwrap(), plain);

    let mut utf16_be = vec![0xFE, 0xFF];
    for unit in plain.encode_utf16() {
        utf16_be.extend_from_slice(&unit.to_be_bytes());
    }
    assert_eq!(decode_import_bytes("be.json", &utf16_be).unwrap(), plain);

    let err = decode_import_bytes("gbk.json", &[0x7B, 0xFF, 0x00]).unwrap_err();
    assert!(err.contains("不是 UTF-8"), "错误应说明编码问题: {}", err);
    assert!(err.contains("gbk.json"), "错误应带文件名: {}", err);

    let huge = vec![b' '; MAX_IMPORT_BYTES + 1];
    let err = decode_import_bytes("huge.json", &huge).unwrap_err();
    assert!(err.contains("导入文件过大"), "{}", err);
}

#[test]
fn import_read_file_reports_missing_and_oversized() {
    let err = read_import_file("/definitely/not/here.json").unwrap_err();
    assert!(err.contains("不存在"), "{}", err);

    let dir = std::env::temp_dir().join(format!("nebula-host-io-big-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("big.json");
    std::fs::write(&path, vec![b' '; MAX_IMPORT_BYTES + 1]).unwrap();
    let err = read_import_file(path.to_str().unwrap()).unwrap_err();
    assert!(err.contains("过大"), "{}", err);
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn item_lines_maps_records_to_real_lines() {
    let text = pretty(&json!({
        "app": "nebulashell", "version": 4,
        "hosts": [
            { "id": "a", "host": "10.0.0.1" },
            { "id": "b", "host": "10.0.0.2" }
        ],
        "credentials": null
    }));
    let lines = item_lines(&text);
    assert_eq!(lines.len(), 2, "{:?}", lines);
    assert_eq!(lines[0], record_line(&text, "a"));
    assert_eq!(lines[1], record_line(&text, "b"));

    // 根数组(旧格式)也要能定位
    let root = pretty(&json!([{ "host": "a" }, { "host": "b" }]));
    let lines = item_lines(&root);
    assert_eq!(lines.len(), 2);
    assert_eq!(root.lines().nth(lines[0] - 1).unwrap().trim(), "{");
    assert_eq!(root.lines().nth(lines[1] - 1).unwrap().trim(), "{");
}

/// 记录起始行 = 该记录 `{` 所在行(serde 会把对象按键排序,不能假设 id 在第一行)。
fn record_line(text: &str, id: &str) -> usize {
    let id_line = line_of(text, &format!("\"id\": \"{}\"", id));
    let lines: Vec<&str> = text.lines().collect();
    for i in (0..id_line.saturating_sub(1)).rev() {
        if lines[i].trim() == "{" {
            return i + 1;
        }
    }
    id_line
}

#[test]
fn json_syntax_error_keeps_line_and_column() {
    let store = tmp_store("syntax");
    let text = "{\n  \"hosts\": [\n    {\"id\": \"a\",}\n  ]\n}";
    let err = store.import_hosts(text, None).unwrap_err();
    assert!(err.contains("第 3 行"), "{}", err);
    assert!(err.contains("列"), "{}", err);
    assert!(
        !err.contains(" at line "),
        "不应重复 serde 的英文位置: {}",
        err
    );
}

#[test]
fn import_accepts_bom_prefixed_text_directly() {
    let store = tmp_store("bom-import");
    let text = format!(
        "\u{feff}{}",
        pretty(&json!({
            "version": 4,
            "hosts": [{ "id": "a", "name": "a", "host": "10.0.0.1" }]
        }))
    );
    let r = store.import_hosts(&text, None).unwrap();
    assert_eq!(r["added"], json!(1));
    assert_eq!(store.list_hosts().len(), 1);
}

// ---------------- 校验:行号 + 字段 + 原因 ----------------

#[test]
fn invalid_rows_report_line_field_reason_and_rollback_everything() {
    let store = tmp_store("invalid-rows");
    let text = pretty(&json!({
        "version": 4,
        "hosts": [
            { "id": "ok", "name": "ok", "host": "10.0.0.1" },
            { "id": "blank", "name": "blank", "host": "   " },
            { "id": "port", "name": "port", "host": "10.0.0.2", "port": 70000 }
        ]
    }));
    let err = store.import_hosts(&text, None).unwrap_err();
    let bad_line = record_line(&text, "blank");
    let port_line = record_line(&text, "port");
    assert!(err.contains(&format!("第 {} 行", bad_line)), "{}", err);
    assert!(err.contains("字段 host"), "{}", err);
    assert!(err.contains("主机地址不能为空"), "{}", err);
    assert!(err.contains(&format!("第 {} 行", port_line)), "{}", err);
    assert!(err.contains("字段 port"), "{}", err);
    assert!(err.contains("70000"), "{}", err);
    assert!(err.contains("共 2 处问题"), "{}", err);
    assert!(err.contains("已全部回滚"), "{}", err);
    assert_eq!(store.list_hosts().len(), 0, "校验失败必须整份回滚");
}

#[test]
fn duplicate_host_and_duplicate_id_are_rejected_with_both_lines() {
    let store = tmp_store("dupes");
    let text = pretty(&json!({
        "version": 4,
        "hosts": [
            { "id": "a", "name": "a", "host": "10.0.0.1", "port": 22, "username": "root" },
            { "id": "a", "name": "b", "host": "10.0.0.2" },
            { "id": "c", "name": "a", "host": "10.0.0.1", "port": 22, "username": "root" }
        ]
    }));
    let err = store.import_hosts(&text, None).unwrap_err();
    let first = record_line(&text, "a");
    let third = record_line(&text, "c");
    assert!(err.contains("字段 id"), "{}", err);
    assert!(err.contains("主机 ID 重复"), "{}", err);
    assert!(err.contains(&format!("第 {} 行", first)), "{}", err);
    assert!(err.contains("字段 host"), "{}", err);
    assert!(err.contains("同一主机"), "{}", err);
    assert!(err.contains(&format!("第 {} 行", third)), "{}", err);
    assert_eq!(store.list_hosts().len(), 0);
}

#[test]
fn same_endpoint_with_different_config_is_allowed() {
    // 同一台机器上的跳板机与目标机可以是两条独立配置(名称/标签/跳板不同)。
    let store = tmp_store("same-endpoint");
    let text = pretty(&json!({
        "version": 4,
        "hosts": [
            { "id": "a", "name": "jump", "host": "10.9.9.9", "username": "root" },
            { "id": "b", "name": "target", "host": "10.9.9.9", "username": "root",
              "jumpIds": ["a"], "initcmd": "echo ready", "tags": ["ops"] }
        ]
    }));
    let r = store.import_hosts(&text, None).unwrap();
    assert_eq!(r["added"], json!(2));
    assert_eq!(store.list_hosts().len(), 2);
}

#[test]
fn dangling_jump_reference_is_rejected_per_line() {
    let store = tmp_store("jump-dangling");
    let text = pretty(&json!({
        "version": 4,
        "hosts": [
            { "id": "a", "name": "a", "host": "10.0.0.1", "jumpIds": ["ghost"] }
        ]
    }));
    let err = store.import_hosts(&text, None).unwrap_err();
    assert!(err.contains("字段 jumpIds"), "{}", err);
    assert!(err.contains("ghost"), "{}", err);
    assert!(
        err.contains(&format!("第 {} 行", record_line(&text, "a"))),
        "{}",
        err
    );
}

#[test]
fn field_level_validation_covers_name_auth_session_ai_tags_cloud() {
    let store = tmp_store("fields");
    let text = pretty(&json!({
        "version": 4,
        "hosts": [{
            "id": "a", "host": "10.0.0.1", "name": "",
            "authType": "telnet", "sessionLog": "sometimes", "aiAccess": "always",
            "tags": [""],
            "cloud": { "provider": "tencent" }
        }]
    }));
    let err = store.import_hosts(&text, None).unwrap_err();
    for field in [
        "name",
        "authType",
        "sessionLog",
        "aiAccess",
        "tags",
        "cloud",
    ] {
        assert!(
            err.contains(&format!("字段 {}", field)),
            "缺少 {}: {}",
            field,
            err
        );
    }
}

#[test]
fn empty_and_oversized_host_lists_are_rejected() {
    let store = tmp_store("empty");
    let err = store
        .import_hosts(&pretty(&json!({ "version": 4, "hosts": [] })), None)
        .unwrap_err();
    assert!(err.contains("没有主机记录"), "{}", err);

    let hosts: Vec<Value> = (0..=MAX_IMPORT_HOSTS)
        .map(|i| json!({ "id": format!("h{}", i), "host": "10.0.0.1" }))
        .collect();
    let err = store
        .import_hosts(&pretty(&json!({ "version": 4, "hosts": hosts })), None)
        .unwrap_err();
    assert!(err.contains("超过单次导入上限"), "{}", err);
}

/// 问题很多时只列前 12 条,其余给计数 —— 错误串不能被 100 行坏数据撑爆。
#[test]
fn issue_list_is_capped() {
    let store = tmp_store("cap");
    let hosts: Vec<Value> = (0..20)
        .map(|i| json!({ "id": format!("h{}", i), "host": "" }))
        .collect();
    let err = store
        .import_hosts(&pretty(&json!({ "version": 4, "hosts": hosts })), None)
        .unwrap_err();
    assert!(err.contains("共 20 处问题"), "{}", err);
    assert!(err.contains("另有 8 处"), "{}", err);
}

// ---------------- 字段对齐:导出 → 导入 ----------------

#[test]
fn export_fields_roundtrip_through_import() {
    let store = tmp_store("parity");
    let jump = store
        .save_host(&json!({ "name": "jump", "host": "10.0.0.9", "port": 2200, "username": "ops" }))
        .unwrap();
    let jump_id = jump["id"].as_str().unwrap().to_string();
    store
        .save_host(&json!({
            "name": "web", "host": "10.0.0.10", "port": 2222, "username": "admin",
            "authType": "key", "keyPath": "/tmp/id_ed25519", "group": "prod",
            "tags": ["a", "b"], "jumpIds": [jump_id], "initcmd": "uptime",
            "sessionLog": "always", "aiAccess": "deny"
        }))
        .unwrap();

    let exported = store.export_hosts().unwrap();
    let expected_keys: std::collections::BTreeSet<&str> = [
        "id",
        "name",
        "host",
        "port",
        "username",
        "authType",
        "keyPath",
        "group",
        "tags",
        "jumpIds",
        "initcmd",
        "cloud",
        "sessionLog",
        "aiAccess",
    ]
    .into_iter()
    .collect();
    for host in exported["hosts"].as_array().unwrap() {
        let keys: std::collections::BTreeSet<&str> = host
            .as_object()
            .unwrap()
            .keys()
            .map(|k| k.as_str())
            .collect();
        assert_eq!(keys, expected_keys, "导出字段集合漂移: {:?}", keys);
    }

    let text = pretty(&exported);
    let fresh = tmp_store("parity-2");
    let r = fresh.import_hosts(&text, None).unwrap();
    assert_eq!(r["added"], json!(2));
    let web = fresh
        .list_hosts()
        .into_iter()
        .find(|h| h["name"] == json!("web"))
        .unwrap();
    let full = fresh.host_full(web["id"].as_str().unwrap()).unwrap();
    let source = exported["hosts"]
        .as_array()
        .unwrap()
        .iter()
        .find(|h| h["name"] == json!("web"))
        .unwrap();
    for field in [
        "name",
        "host",
        "port",
        "username",
        "authType",
        "keyPath",
        "group",
        "tags",
        "initcmd",
        "sessionLog",
        "aiAccess",
    ] {
        assert_eq!(full[field], source[field], "字段 {} 导入后不一致", field);
    }
    assert_eq!(
        full["jumpIds"].as_array().unwrap().len(),
        1,
        "跳板引用应保留"
    );
    let jump_new = fresh
        .list_hosts()
        .into_iter()
        .find(|h| h["name"] == json!("jump"))
        .unwrap();
    assert_eq!(
        full["jumpIds"][0], jump_new["id"],
        "跳板应重新映射到新库的 ID"
    );
}

/// 导出后手改地址再导入:必须被识别成冲突(而不是「一致」被静默忽略),
/// 选 overwrite 后地址要真的更新。
#[test]
fn address_change_is_detected_and_overwritten() {
    let source = tmp_store("addr-src");
    source
        .save_host(&json!({ "name": "web", "host": "10.0.0.10", "port": 22, "username": "root" }))
        .unwrap();
    let exported = source.export_hosts().unwrap();
    let text = pretty(&exported);

    let target = tmp_store("addr-dst");
    target.import_hosts(&text, None).unwrap();

    let mut changed = exported.clone();
    changed["hosts"][0]["host"] = json!("10.0.0.11");
    let changed_text = pretty(&changed);
    let inspect = target.inspect_hosts(&changed_text, None).unwrap();
    let row = &inspect["rows"][0];
    assert_eq!(
        row["kind"],
        json!("conflict"),
        "改地址应识别为冲突: {}",
        row
    );
    let diff = row["diff"].as_array().unwrap();
    assert!(
        diff.iter()
            .any(|d| d.as_str().unwrap_or("").contains("10.0.0.10 → 10.0.0.11")),
        "diff 应显示地址变化: {:?}",
        diff
    );

    let key = row["key"].as_str().unwrap();
    let decisions = json!({ key: "overwrite" });
    target.apply_hosts(&changed_text, None, &decisions).unwrap();
    let host = target
        .list_hosts()
        .into_iter()
        .find(|h| h["name"] == json!("web"))
        .unwrap();
    let full = target.host_full(host["id"].as_str().unwrap()).unwrap();
    assert_eq!(full["host"], json!("10.0.0.11"));
}

// ---------------- 幂等与并发 ----------------

#[test]
fn importing_same_file_twice_adds_nothing_and_keeps_credentials() {
    let source = tmp_store("idem-src");
    source
        .save_host(&json!({ "name": "a", "host": "10.0.0.1", "password": "pw-a" }))
        .unwrap();
    let text = pretty(&source.export_hosts().unwrap());

    let target = tmp_store("idem-dst");
    let first = target.import_hosts(&text, None).unwrap();
    assert_eq!(first["added"], json!(1));
    let second = target.import_hosts(&text, None).unwrap();
    assert_eq!(second["added"], json!(0), "重复导入不应新增: {}", second);
    assert_eq!(target.list_hosts().len(), 1);
    let full = target
        .host_full(target.list_hosts()[0]["id"].as_str().unwrap())
        .unwrap();
    assert_eq!(full["password"], json!("pw-a"));
}

#[test]
fn concurrent_import_of_same_file_creates_no_duplicates() {
    let source = tmp_store("conc-src");
    source
        .save_host(&json!({ "name": "a", "host": "10.0.0.1", "username": "root" }))
        .unwrap();
    source
        .save_host(&json!({ "name": "b", "host": "10.0.0.2", "username": "root" }))
        .unwrap();
    let text = pretty(&source.export_hosts().unwrap());

    let target = tmp_store("conc-dst");
    let added = std::thread::scope(|scope| {
        let a = scope.spawn(|| {
            target.import_hosts(&text, None).unwrap()["added"]
                .as_u64()
                .unwrap_or(0)
        });
        let b = scope.spawn(|| {
            target.import_hosts(&text, None).unwrap()["added"]
                .as_u64()
                .unwrap_or(0)
        });
        a.join().unwrap() + b.join().unwrap()
    });

    assert_eq!(added, 2, "两线程重复导入同一文件,总新增应等于文件主机数");
    assert_eq!(target.list_hosts().len(), 2, "并发导入产生了重复主机");
}
