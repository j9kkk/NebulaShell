// 主机导入/导出验收回归(数据层,直接驱动真实 Store 实现)
//
// 与 src/store_test.rs 的分工:store_test 是按实现细节拆的单元测试;这里按
// 《导入导出问题清单》的用户可见用例组织,一条用例 = 一条可写进验收记录的行。
// 用例编号与 docs/host-import-export-acceptance.md 的表格一一对应。
//
// 运行:cargo test --test import_export_acceptance -- --nocapture
use nebulashell_lib::commands::{import_apply_path, import_inspect_path};
use nebulashell_lib::config::Store;
use serde_json::{json, Value};
use std::path::PathBuf;

/// 独立的临时 store(不碰用户真实配置,禁用 keyring 走 base64 回退)
fn store(tag: &str) -> (Store, PathBuf) {
    let dir = std::env::temp_dir().join(format!("nbs-accept-{}-{}", tag, std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    (Store::load_plain(dir.clone()), dir)
}

fn text_of(v: &Value) -> String {
    serde_json::to_string(v).unwrap()
}

/// 只保留"用户能看见、跨机器应保持不变"的主机属性,用于往返比对
fn shape(h: &Value) -> Value {
    json!({
        "name": h["name"], "host": h["host"], "port": h["port"], "username": h["username"],
        "authType": h["authType"], "keyPath": h["keyPath"], "group": h["group"],
        "tags": h["tags"], "initcmd": h["initcmd"],
    })
}

fn shapes(v: &[Value]) -> Vec<Value> {
    let mut out: Vec<Value> = v.iter().map(shape).collect();
    out.sort_by_key(|h| {
        (
            h["host"].as_str().unwrap_or("").to_string(),
            h["port"].as_i64().unwrap_or(22),
        )
    });
    out
}

fn seed_three(store: &Store) {
    store
        .save_host(
            &json!({ "name": "web-1", "host": "10.0.0.1", "port": 22, "username": "root",
            "group": "生产", "tags": ["web"], "password": "pw-1" }),
        )
        .unwrap();
    store
        .save_host(
            &json!({ "name": "库", "host": "10.0.0.2", "port": 2222, "username": "dba",
            "group": "生产", "privateKey": "-----BEGIN OPENSSH PRIVATE KEY-----\nxx\n",
            "passphrase": "kp-2" }),
        )
        .unwrap();
    store
        .save_host(
            &json!({ "name": "跳板", "host": "10.0.0.3", "username": "jump", "password": "pw-3" }),
        )
        .unwrap();
}

// ---------------------------------------------------------------- 导出

/// AC-01 导出文件结构:v4、凭据只出现在加密块、主机字段明文可读
#[test]
fn case01_export_shape_and_no_plaintext() {
    let (s, dir) = store("c01");
    seed_three(&s);
    let out = s
        .export_hosts_scoped(&json!({ "mode": "all" }), None, true, true)
        .unwrap();
    let text = text_of(&out);
    assert_eq!(out["version"], json!(4));
    assert_eq!(out["app"], json!("nebulashell"));
    assert_eq!(out["hosts"].as_array().unwrap().len(), 3);
    assert_eq!(out["credentials"]["alg"], json!("builtin-aes-256-gcm/v1"));
    for leak in ["pw-1", "pw-3", "kp-2", "BEGIN OPENSSH"] {
        assert!(!text.contains(leak), "导出文件出现明文凭据: {}", leak);
    }
    // 非敏感字段必须明文可读(否则导入端无从匹配)
    assert!(text.contains("10.0.0.1"));
    assert!(text.contains("生产"));
    let _ = std::fs::remove_dir_all(&dir);
}

/// AC-02 正常导入:全量导出 → 空库导入,主机与密码凭据还原(私钥正文不随导出打包)
#[test]
fn case02_roundtrip_full_to_empty_store() {
    let (a, da) = store("c02-a");
    seed_three(&a);
    let text = text_of(
        &a.export_hosts_scoped(&json!({ "mode": "all" }), None, true, true)
            .unwrap(),
    );

    let (b, db) = store("c02-b");
    let r = b.inspect_hosts(&text, None).unwrap();
    assert_eq!(
        r["counts"],
        json!({ "add": 3, "credOnly": 0, "conflict": 0, "identical": 0, "invalid": 0 })
    );
    let applied = b.apply_hosts(&text, None, &json!({})).unwrap();
    assert_eq!(applied["added"], json!(3));
    assert_eq!(applied["withCredentials"], json!(2));

    let list = b.list_hosts();
    assert_eq!(
        shapes(&list),
        shapes(&a.list_hosts()),
        "往返后主机属性应一致"
    );
    let by_host = |st: &Store, h: &str| -> Value {
        let id = st
            .list_hosts()
            .into_iter()
            .find(|x| x["host"] == json!(h))
            .unwrap()["id"]
            .as_str()
            .unwrap()
            .to_string();
        st.host_full(&id).unwrap()
    };
    let full = by_host(&b, "10.0.0.1");
    assert_eq!(full["password"], json!("pw-1"));
    assert_eq!(full["name"], json!("web-1"));
    assert_eq!(full["group"], json!("生产"));
    let full = by_host(&b, "10.0.0.2");
    assert_eq!(full["privateKey"], json!(""));
    assert_eq!(full["passphrase"], json!(""));
    let _ = std::fs::remove_dir_all(&da);
    let _ = std::fs::remove_dir_all(&db);
}

/// AC-03 幂等:导出文件导回同一个库,全部判"一致",不重复建主机
#[test]
fn case03_reimport_same_store_is_idempotent() {
    let (s, dir) = store("c03");
    seed_three(&s);
    let text = text_of(
        &s.export_hosts_scoped(&json!({ "mode": "all" }), None, true, true)
            .unwrap(),
    );

    let insp = s.inspect_hosts(&text, None).unwrap();
    assert_eq!(
        insp["counts"]["identical"],
        json!(3),
        "同库重导应全部判一致: {}",
        insp
    );
    assert_eq!(insp["counts"]["conflict"], json!(0));
    let r = s.apply_hosts(&text, None, &json!({})).unwrap();
    assert_eq!(r["added"], json!(0));
    assert_eq!(s.list_hosts().len(), 3, "不应新增主机");

    // 连做三次,主机数与内容都不许漂移
    for _ in 0..3 {
        s.apply_hosts(&text, None, &json!({})).unwrap();
    }
    assert_eq!(s.list_hosts().len(), 3);
    let _ = std::fs::remove_dir_all(&dir);
}

/// AC-04 三轮往返(导出→导入→再导出)稳定:第二、三代导出内容除时间戳外一致
#[test]
fn case04_roundtrip_three_generations_stable() {
    let (a, da) = store("c04-a");
    seed_three(&a);
    let gen1 = a
        .export_hosts_scoped(&json!({ "mode": "all" }), None, true, true)
        .unwrap();

    let (b, db) = store("c04-b");
    b.apply_hosts(&text_of(&gen1), None, &json!({})).unwrap();
    let gen2 = b
        .export_hosts_scoped(&json!({ "mode": "all" }), None, true, true)
        .unwrap();
    assert_eq!(
        shapes(gen1["hosts"].as_array().unwrap()),
        shapes(gen2["hosts"].as_array().unwrap()),
        "第二代导出应与第一代主机属性一致"
    );

    let (c, dc) = store("c04-c");
    c.apply_hosts(&text_of(&gen2), None, &json!({})).unwrap();
    let gen3 = c
        .export_hosts_scoped(&json!({ "mode": "all" }), None, true, true)
        .unwrap();
    assert_eq!(
        shapes(gen2["hosts"].as_array().unwrap()),
        shapes(gen3["hosts"].as_array().unwrap())
    );
    // 凭据也要跨代保持
    let pw = |st: &Store| {
        let id = st
            .list_hosts()
            .into_iter()
            .find(|h| h["host"] == json!("10.0.0.1"))
            .unwrap()["id"]
            .as_str()
            .unwrap()
            .to_string();
        st.host_full(&id).unwrap()["password"].clone()
    };
    assert_eq!(pw(&c), json!("pw-1"));
    let _ = std::fs::remove_dir_all(&da);
    let _ = std::fs::remove_dir_all(&db);
    let _ = std::fs::remove_dir_all(&dc);
}

// ---------------------------------------------------------------- 异常输入

/// AC-05 空文件/纯空白:报 JSON 格式错误(带行列),库不变
#[test]
fn case05_empty_file_is_rejected_clearly() {
    let (s, dir) = store("c05");
    for body in ["", "   \n\t  ", "\r\n"] {
        let e = s.inspect_hosts(body, None).unwrap_err();
        assert!(
            e.starts_with("文件不是合法 JSON"),
            "空文件应报格式错误,实际: {}",
            e
        );
        let e = s.apply_hosts(body, None, &json!({})).unwrap_err();
        assert!(e.starts_with("文件不是合法 JSON"));
    }
    assert!(s.list_hosts().is_empty());
    let _ = std::fs::remove_dir_all(&dir);
}

/// AC-06 结构合法但无主机:拒绝并说明没有可导入内容(不再静默成功 0 台)
#[test]
fn case06_valid_but_no_hosts() {
    let (s, dir) = store("c06");
    for body in [json!({ "hosts": [] }), json!([])] {
        let e = s.inspect_hosts(&text_of(&body), None).unwrap_err();
        assert!(e.contains("没有主机记录"), "实际: {}", e);
        let e = s
            .apply_hosts(&text_of(&body), None, &json!({}))
            .unwrap_err();
        assert!(e.contains("没有主机记录"), "实际: {}", e);
    }
    assert!(s.list_hosts().is_empty());
    let _ = std::fs::remove_dir_all(&dir);
}

/// AC-07 错误格式(CSV / YAML / HTML / 截断 JSON / 只给对象没有 hosts)
#[test]
fn case07_wrong_format_files() {
    let (s, dir) = store("c07");
    let cases = [
        ("csv", "name,host,port\nweb,10.0.0.1,22\n"),
        ("tsv", "name\thost\nweb\t10.0.0.1\n"),
        ("yaml", "hosts:\n  - name: web\n    host: 10.0.0.1\n"),
        ("html", "<html><body>not a config</body></html>"),
        (
            "truncated",
            "{\"hosts\": [{\"name\": \"a\", \"host\": \"10.0.0.1\"}",
        ),
    ];
    for (tag, body) in cases {
        let e = s.inspect_hosts(body, None).unwrap_err();
        assert!(!e.is_empty(), "{}: 必须有错误信息", tag);
        println!("  {} -> {}", tag, e);
        assert!(
            e.starts_with("文件不是合法 JSON"),
            "{} 的错误文案应统一: {}",
            tag,
            e
        );
    }
    // 合法 JSON 但结构不对:报结构错误,而不是笼统的 JSON 错误
    for body in [
        "{\"app\":\"nebulashell\"}",
        "{\"hosts\": 42}",
        "42",
        "\"text\"",
    ] {
        let e = s.inspect_hosts(body, None).unwrap_err();
        println!("  {} -> {}", body, e);
        assert!(!e.is_empty());
    }
    assert!(s.list_hosts().is_empty());
    let _ = std::fs::remove_dir_all(&dir);
}

/// AC-08 含错误行的导入:整批拒绝、库不被部分写入(原子性)
#[test]
fn case08_bad_row_rejects_whole_batch() {
    let (s, dir) = store("c08");
    s.save_host(&json!({ "name": "keep", "host": "10.1.1.1" }))
        .unwrap();
    let before = s.list_hosts();

    let bad = json!({
        "app": "nebulashell", "version": 4,
        "hosts": [
            { "id": "ok", "name": "good", "host": "10.2.2.2" },
            { "id": "bad", "name": "no-address", "host": "" }
        ]
    });
    let e = s.apply_hosts(&text_of(&bad), None, &json!({})).unwrap_err();
    assert!(e.contains("主机地址不能为空"), "实际: {}", e);
    assert_eq!(s.list_hosts(), before, "失败后库内容必须原样");
    let _ = std::fs::remove_dir_all(&dir);
}

/// AC-09 悬空跳板机:整批拒绝,库不变
#[test]
fn case09_dangling_jump_rejected() {
    let (s, dir) = store("c09");
    s.save_host(&json!({ "name": "keep", "host": "10.1.1.1" }))
        .unwrap();
    let bad = json!({
        "app": "nebulashell", "version": 4,
        "hosts": [{ "id": "a", "name": "a", "host": "10.2.2.2", "jumpIds": ["nope"] }]
    });
    let e = s.apply_hosts(&text_of(&bad), None, &json!({})).unwrap_err();
    assert!(e.contains("悬空跳板机"), "实际: {}", e);
    assert_eq!(s.list_hosts().len(), 1);
    let _ = std::fs::remove_dir_all(&dir);
}

/// AC-10 文件内主机 ID 重复:明确报错而不是静默合并
#[test]
fn case10_duplicate_ids_rejected() {
    let (s, dir) = store("c10");
    let dup = json!({
        "app": "nebulashell", "version": 4,
        "hosts": [
            { "id": "same", "name": "a", "host": "10.2.2.2" },
            { "id": "same", "name": "b", "host": "10.3.3.3" }
        ]
    });
    let e = s.inspect_hosts(&text_of(&dup), None).unwrap_err();
    assert!(e.contains("主机 ID 重复"), "实际: {}", e);
    let _ = std::fs::remove_dir_all(&dir);
}

/// AC-11 重复主机(同一文件里同一端点且同名同配置出现两次):整份拒绝并指出重复的两行,
/// 不再各建一台;同端点但配置不同的两条(如同一台机器的跳板机与目标机)仍然允许。
#[test]
fn case11_duplicate_endpoint_not_duplicated() {
    let (s, dir) = store("c11");
    // v1(无 id):两行完全相同
    let file = json!({
        "app": "nebulashell", "version": 1,
        "hosts": [
            { "name": "web", "host": "10.9.9.9", "port": 22, "username": "root", "password": "p1" },
            { "name": "web", "host": "10.9.9.9", "port": 22, "username": "root", "password": "p1" }
        ]
    });
    let e = s.inspect_hosts(&text_of(&file), None).unwrap_err();
    assert!(e.contains("同一主机"), "重复端点必须报错: {}", e);
    assert!(e.contains("第 1 台"), "错误要指出重复的两条: {}", e);
    assert_eq!(s.list_hosts().len(), 0, "重复文件不得落一半");
    assert!(s.apply_hosts(&text_of(&file), None, &json!({})).is_err());

    // 已有同端点本地主机时,单行导入应命中它而不是新建
    let (s2, dir2) = store("c11-b");
    s2.save_host(&json!({ "name": "local", "host": "10.9.9.9", "port": 22, "username": "root" }))
        .unwrap();
    let one_row = json!({ "app": "nebulashell", "version": 1,
        "hosts": [{ "name": "web", "host": "10.9.9.9", "port": 22, "username": "root", "password": "p1" }] });
    let insp = s2.inspect_hosts(&text_of(&one_row), None).unwrap();
    assert_eq!(
        insp["counts"]["conflict"].as_u64().unwrap()
            + insp["counts"]["identical"].as_u64().unwrap(),
        1,
        "同端点应命中原有主机: {}",
        insp["counts"]
    );
    s2.apply_hosts(&text_of(&one_row), None, &json!({}))
        .unwrap();
    assert_eq!(s2.list_hosts().len(), 1, "不应新建重复主机");

    // v4:两台来自不同机器的同端点主机(不同 id)合并成一个文件 → 同样整份拒绝
    let (s3, dir3) = store("c11-c");
    let merged = json!({ "app": "nebulashell", "version": 4, "hosts": [
        { "id": "a", "name": "web", "host": "10.9.9.9", "port": 22, "username": "root" },
        { "id": "b", "name": "web", "host": "10.9.9.9", "port": 22, "username": "root" }
    ] });
    let e3 = s3
        .apply_hosts(&text_of(&merged), None, &json!({}))
        .unwrap_err();
    assert!(e3.contains("同一主机"), "{}", e3);
    assert_eq!(s3.list_hosts().len(), 0);
    let _ = std::fs::remove_dir_all(&dir);
    let _ = std::fs::remove_dir_all(&dir2);
    let _ = std::fs::remove_dir_all(&dir3);
}

// ---------------------------------------------------------------- 冲突决策

/// AC-12 冲突:预检只标冲突不写盘;skip 保留本地、overwrite 覆盖
#[test]
fn case12_conflict_skip_and_overwrite() {
    let (src, dsrc) = store("c12-src");
    src.save_host(&json!({ "name": "改后名字", "host": "10.0.0.1", "username": "root", "password": "new-pw" }))
        .unwrap();
    let src_out = src
        .export_hosts_scoped(&json!({ "mode": "all" }), None, true, true)
        .unwrap();
    let src_id = src.list_hosts()[0]["id"].as_str().unwrap().to_string();

    // 本地同名 id、不同名字
    let (dst, ddst) = store("c12-dst");
    dst.save_host(&json!({ "id": src_id, "name": "本地名字", "host": "10.0.0.1", "username": "root", "password": "old-pw" }))
        .unwrap();
    let text = text_of(&src_out);

    let insp = dst.inspect_hosts(&text, None).unwrap();
    assert_eq!(insp["counts"]["conflict"], json!(1));
    let rows = insp["rows"].as_array().unwrap();
    assert_eq!(rows[0]["kind"], json!("conflict"));
    assert!(
        rows[0]["diff"].to_string().contains("名称"),
        "diff 应指出哪个字段不同"
    );
    assert_eq!(
        dst.list_hosts()[0]["name"],
        json!("本地名字"),
        "预检不得写盘"
    );

    // skip
    let key = rows[0]["key"].as_str().unwrap().to_string();
    let mut decisions = serde_json::Map::new();
    decisions.insert(key.clone(), json!("skip"));
    let r = dst
        .apply_hosts(&text, None, &Value::Object(decisions.clone()))
        .unwrap();
    assert_eq!(r["skipped"], json!(1));
    assert_eq!(dst.list_hosts()[0]["name"], json!("本地名字"));
    let id = dst.list_hosts()[0]["id"].as_str().unwrap().to_string();
    assert_eq!(dst.host_full(&id).unwrap()["password"], json!("old-pw"));

    // overwrite
    decisions.insert(key, json!("overwrite"));
    let r = dst
        .apply_hosts(&text, None, &Value::Object(decisions))
        .unwrap();
    assert_eq!(r["overwritten"], json!(1));
    assert_eq!(dst.list_hosts()[0]["name"], json!("改后名字"));
    assert_eq!(dst.host_full(&id).unwrap()["password"], json!("new-pw"));
    assert_eq!(dst.list_hosts().len(), 1, "覆盖不应新增主机");
    let _ = std::fs::remove_dir_all(&dsrc);
    let _ = std::fs::remove_dir_all(&ddst);
}

/// AC-13 补凭据:本地有主机但没凭据,文件里有 → 判 credOnly 并补齐
#[test]
fn case13_credentials_only_fill() {
    let (src, dsrc) = store("c13-src");
    src.save_host(&json!({ "name": "web-1", "host": "10.0.0.1", "username": "root", "password": "from-file" }))
        .unwrap();
    let text = text_of(
        &src.export_hosts_scoped(&json!({ "mode": "all" }), None, true, true)
            .unwrap(),
    );
    let src_id = src.list_hosts()[0]["id"].as_str().unwrap().to_string();

    let (dst, ddst) = store("c13-dst");
    dst.save_host(
        &json!({ "id": src_id, "name": "web-1", "host": "10.0.0.1", "username": "root" }),
    )
    .unwrap();
    let insp = dst.inspect_hosts(&text, None).unwrap();
    assert_eq!(insp["counts"]["credOnly"], json!(1), "实际: {}", insp);
    let r = dst.apply_hosts(&text, None, &json!({})).unwrap();
    assert!(r["updated"].as_u64().unwrap() >= 1);
    let id = dst.list_hosts()[0]["id"].as_str().unwrap().to_string();
    assert_eq!(dst.host_full(&id).unwrap()["password"], json!("from-file"));
    assert_eq!(dst.list_hosts().len(), 1);
    let _ = std::fs::remove_dir_all(&dsrc);
    let _ = std::fs::remove_dir_all(&ddst);
}

// ---------------------------------------------------------------- 口令通道

/// AC-14 口令加固导出:无口令/错口令/对口令三条路径
#[test]
fn case14_passphrase_channel() {
    let (src, dsrc) = store("c14-src");
    src.save_host(&json!({ "name": "web", "host": "10.0.0.1", "password": "hidden-pw" }))
        .unwrap();
    let out = src
        .export_hosts_scoped(&json!({ "mode": "all" }), Some("pass-123456"), true, true)
        .unwrap();
    assert_eq!(out["credentials"]["alg"], json!("passphrase-scrypt/v1"));
    let text = text_of(&out);
    assert!(!text.contains("hidden-pw"));

    let (dst, ddst) = store("c14-dst");
    assert_eq!(
        dst.inspect_hosts(&text, None).unwrap_err(),
        "NEEDS_PASSPHRASE"
    );
    let e = dst.inspect_hosts(&text, Some("wrong-pass")).unwrap_err();
    assert!(e.contains("口令错误") || e.contains("损坏"), "实际: {}", e);
    let r = dst.inspect_hosts(&text, Some("pass-123456")).unwrap();
    assert_eq!(r["counts"]["add"], json!(1));
    dst.apply_hosts(&text, Some("pass-123456"), &json!({}))
        .unwrap();
    let id = dst.list_hosts()[0]["id"].as_str().unwrap().to_string();
    assert_eq!(dst.host_full(&id).unwrap()["password"], json!("hidden-pw"));
    let _ = std::fs::remove_dir_all(&dsrc);
    let _ = std::fs::remove_dir_all(&ddst);
}

// ---------------------------------------------------------------- 编码/体积

/// AC-15 编码与换行:中文名、CRLF、UTF-8 BOM、GBK 字节
#[test]
fn case15_encoding_and_line_endings() {
    let (s, dir) = store("c15");
    // 中文 + CRLF + 结尾换行
    let crlf = "{\r\n  \"app\": \"nebulashell\", \"version\": 4,\r\n  \"hosts\": [\r\n    { \"id\": \"a\", \"name\": \"生产-网关\", \"host\": \"10.4.4.4\" }\r\n  ]\r\n}\r\n";
    let r = s.inspect_hosts(crlf, None).unwrap();
    assert_eq!(r["counts"]["add"], json!(1));
    s.apply_hosts(crlf, None, &json!({})).unwrap();
    assert_eq!(s.list_hosts()[0]["name"], json!("生产-网关"));

    // UTF-8 BOM:Windows 记事本另存常见,当前行为要记录在案
    let bom = format!(
        "\u{feff}{}",
        json!({ "version": 4, "hosts": [{ "id": "b", "host": "10.5.5.5" }] })
    );
    let bom_err = s.inspect_hosts(&bom, None);
    println!("  UTF-8 BOM -> {:?}", bom_err.as_ref().err());

    // GBK 字节:不是合法 UTF-8,store 层进不来(命令层 read_to_string 先失败)
    let gbk = [0xD6, 0xD0, 0xCE, 0xC4]; // "中文" 的 GBK 编码
    let non_utf8 = String::from_utf8(gbk.to_vec());
    assert!(non_utf8.is_err(), "GBK 字节不是合法 UTF-8");
    println!("  GBK -> 命令层 read_to_string 报 invalid utf-8(见验收记录备注)");
    let _ = std::fs::remove_dir_all(&dir);
}

/// AC-16 超大文件:5000 台主机的预检与落盘耗时/正确性
#[test]
fn case16_large_file_5000_hosts() {
    let (s, dir) = store("c16");
    let hosts: Vec<Value> = (0..5000)
        .map(|i| {
            json!({ "id": format!("src-{}", i), "name": format!("h-{}", i),
            "host": format!("10.{}.{}.{}", i / 65536 % 256, i / 256 % 256, i % 256),
            "port": 22, "username": "root", "group": format!("g-{}", i % 20) })
        })
        .collect();
    let file = text_of(&json!({ "app": "nebulashell", "version": 4, "hosts": hosts }));
    eprintln!("  fixture: {} KB / 5000 hosts", file.len() / 1024);

    let t = std::time::Instant::now();
    let insp = s.inspect_hosts(&file, None).unwrap();
    let inspect_ms = t.elapsed().as_millis();
    assert_eq!(insp["counts"]["add"], json!(5000));

    let t = std::time::Instant::now();
    let r = s.apply_hosts(&file, None, &json!({})).unwrap();
    let apply_ms = t.elapsed().as_millis();
    eprintln!("  inspect {} ms / apply {} ms", inspect_ms, apply_ms);
    assert_eq!(r["added"], json!(5000));
    assert_eq!(s.list_hosts().len(), 5000);
    assert!(apply_ms < 60_000, "5000 台落盘超过 60s,实际 {}ms", apply_ms);
    assert!(
        inspect_ms < 30_000,
        "5000 台预检超过 30s,实际 {}ms",
        inspect_ms
    );

    // 再导一次必须判一致(大规模下的匹配逻辑不走样)
    let insp = s.inspect_hosts(&file, None).unwrap();
    assert_eq!(
        insp["counts"]["identical"],
        json!(5000),
        "重导分类应全一致: {}",
        insp["counts"]
    );

    // F-16 回归:二次导入(全部一致)是最坏路径 —— 旧实现每台都要全量扫 staged
    // (5000² 次 cred_key 分配),落盘 10.4s;现在走匹配索引,必须仍是线性。
    let t = std::time::Instant::now();
    let again = s.apply_hosts(&file, None, &json!({})).unwrap();
    let reapply_ms = t.elapsed().as_millis();
    eprintln!("  reapply {} ms", reapply_ms);
    assert_eq!(
        again["added"],
        json!(0),
        "重导不应新增主机: {}",
        again["added"]
    );
    assert_eq!(s.list_hosts().len(), 5000);
    assert!(
        reapply_ms < 5_000,
        "5000 台重导超过 5s,实际 {}ms(匹配又退回全表扫描?)",
        reapply_ms
    );
    let _ = std::fs::remove_dir_all(&dir);
}

// ---------------------------------------------------------------- 导出范围

/// AC-17 导出范围:全部 / 选中(含跳板闭包)/ 空选择 / 已失效选择
#[test]
fn case17_export_scope_and_jump_closure() {
    let (s, dir) = store("c17");
    let jump = s
        .save_host(&json!({ "name": "跳板", "host": "10.0.0.3", "username": "jump" }))
        .unwrap();
    s.save_host(&json!({ "name": "web", "host": "10.0.0.1",
        "jumpIds": [jump["id"].as_str().unwrap()] }))
        .unwrap();
    s.save_host(&json!({ "name": "db", "host": "10.0.0.2" }))
        .unwrap();

    // 全部
    let all = s
        .export_hosts_scoped(&json!({ "mode": "all" }), None, true, true)
        .unwrap();
    assert_eq!(all["hosts"].as_array().unwrap().len(), 3);

    // 选中:只选 web,跳板机应被闭包带进来,db 不带
    let web_id = s
        .list_hosts()
        .into_iter()
        .find(|h| h["name"] == json!("web"))
        .unwrap()["id"]
        .as_str()
        .unwrap()
        .to_string();
    let sel = s
        .export_hosts_scoped(&json!({ "mode": "ids", "ids": [web_id] }), None, true, true)
        .unwrap();
    let names: Vec<&str> = sel["hosts"]
        .as_array()
        .unwrap()
        .iter()
        .map(|h| h["name"].as_str().unwrap())
        .collect();
    assert_eq!(
        sel["hosts"].as_array().unwrap().len(),
        2,
        "选中导出应带跳板闭包: {:?}",
        names
    );
    assert!(names.contains(&"跳板") && names.contains(&"web") && !names.contains(&"db"));
    assert_eq!(sel["includedJumps"], json!(1));

    // 子集导出必须能被空库吃下(闭包自洽)
    let (dst, ddst) = store("c17-dst");
    dst.apply_hosts(&text_of(&sel), None, &json!({})).unwrap();
    assert_eq!(dst.list_hosts().len(), 2);
    let web = dst
        .list_hosts()
        .into_iter()
        .find(|h| h["name"] == json!("web"))
        .unwrap();
    assert_eq!(web["jumpIds"].as_array().unwrap().len(), 1);

    // 空选择 / 失效选择
    let e = s
        .export_hosts_scoped(&json!({ "mode": "ids", "ids": [] }), None, false, false)
        .unwrap_err();
    assert!(e.contains("请先选择"), "实际: {}", e);
    let e = s
        .export_hosts_scoped(&json!({ "mode": "ids", "ids": ["gone"] }), None, false, false)
        .unwrap_err();
    assert!(e.contains("已不存在"), "实际: {}", e);
    let _ = std::fs::remove_dir_all(&dir);
    let _ = std::fs::remove_dir_all(&ddst);
}

// ---------------------------------------------------------------- 落盘健壮性

/// AC-18 目录不可写:导入报错、磁盘不变量(内存态见验收记录遗留项)
#[cfg(unix)]
#[test]
fn case18_readonly_dir_save_failure() {
    use std::os::unix::fs::PermissionsExt;
    let (s, dir) = store("c18");
    s.save_host(&json!({ "name": "keep", "host": "10.1.1.1" }))
        .unwrap();
    let file = dir.join("nebulashell-config.json");
    let before = std::fs::read_to_string(&file).unwrap();
    let mem_before = s.list_hosts().len();

    std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o500)).unwrap();
    let text = text_of(&json!({ "version": 4, "hosts": [{ "id": "new", "host": "10.7.7.7" }] }));
    let res = s.apply_hosts(&text, None, &json!({}));
    let mem_after = s.list_hosts().len();
    std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700)).unwrap();

    let err = res.expect_err("只读目录下导入应失败");
    eprintln!("  readonly import -> {}", err);
    assert_eq!(
        std::fs::read_to_string(&file).unwrap(),
        before,
        "失败时配置文件必须保持原样(不能半写)"
    );
    // F-05:写盘失败时内存态也不能改 —— 否则下一次任何 save() 都会把失败的那批落盘,
    // 界面说的「本次没有写入任何主机」就不成立。
    assert_eq!(
        mem_after, mem_before,
        "落盘失败后内存主机数必须保持 {},实际 {}",
        mem_before, mem_after
    );
    println!(
        "  内存主机数 {} -> {}(磁盘与内存都未变)",
        mem_before, mem_after
    );
    let _ = std::fs::remove_dir_all(&dir);
}

/// AC-19 导入前自动备份:生成快照、不含明文口令、旧备份按 20 份封顶清理
#[test]
fn case19_backup_before_import_and_prune() {
    let (s, dir) = store("c19");
    s.save_host(&json!({ "name": "keep", "host": "10.1.1.1", "password": "plain-secret" }))
        .unwrap();
    let backup_dir = dir.join("backup");
    // 先造 25 份"旧"备份,验证封顶清理
    std::fs::create_dir_all(&backup_dir).unwrap();
    for i in 0..25 {
        std::fs::write(
            backup_dir.join(format!(
                "nebulashell-backup-202001{:02}-000000.json",
                i % 31 + 1
            )),
            "{\"hosts\":[]}",
        )
        .unwrap();
    }
    let text = text_of(&json!({ "version": 4, "hosts": [{ "id": "new", "host": "10.7.7.7" }] }));
    let r = s.apply_hosts(&text, None, &json!({})).unwrap();
    let backup = r["backup"]
        .as_str()
        .expect("应写出一份导入前备份")
        .to_string();
    let body = std::fs::read_to_string(&backup).unwrap();
    assert!(body.contains("10.1.1.1"), "备份应含导入前主机");
    assert!(!body.contains("plain-secret"), "备份不应含明文口令");
    let left = std::fs::read_dir(&backup_dir).unwrap().count();
    eprintln!("  backups kept: {} (pruned {})", left, r["backupPruned"]);
    assert!(
        left <= Store::BACKUP_KEEP + 1,
        "备份应封顶在 20 份左右,实际 {}",
        left
    );
    let _ = std::fs::remove_dir_all(&dir);
}

/// AC-21 字段异常值:端口非法/缺失、名字缺失、用户名缺失、标签类型错误
///
/// 修复策略:导入文件没有表单兜底,非法值一律**整批拒绝并逐行说明**
/// (行号 + 字段 + 原因),不静默改成默认值 —— 悄悄把 70000 改成 22 会让用户
/// 以为数据没错。断言:库不变,且错误里能定位到每个坏字段。
#[test]
fn case21_weird_field_values() {
    let (s, dir) = store("c21");
    let file = json!({ "app": "nebulashell", "version": 4, "hosts": [
        { "id": "a", "host": "10.0.0.1", "port": 70000, "username": "" },
        { "id": "b", "host": "10.0.0.2", "port": "abc" },
        { "id": "c", "host": "10.0.0.3", "name": "", "tags": "not-an-array" }
    ] });
    let e = s
        .apply_hosts(&text_of(&file), None, &json!({}))
        .unwrap_err();
    assert!(e.contains("共 5 处问题"), "应一次列出全部坏字段: {}", e);
    assert!(e.contains("字段 port") && e.contains("70000"), "{}", e);
    assert!(e.contains("字段 username"), "{}", e);
    assert!(e.contains("字段 name"), "{}", e);
    assert!(e.contains("字段 tags"), "{}", e);
    assert!(e.contains("已全部回滚"), "{}", e);
    assert!(s.list_hosts().is_empty(), "非法文件不得写入任何主机");
    let _ = std::fs::remove_dir_all(&dir);
}

/// AC-22 「包含密钥路径」:开启时原样写出 keyPath,关闭时置空,且不打包私钥正文
#[test]
fn case22_export_private_key_bundle() {
    let (s, dir) = store("c22");
    let key_ok = dir.join("id_ok");
    std::fs::write(&key_ok, "KEYBODY-DO-NOT-PACK\n").unwrap();
    s.save_host(&json!({ "name": "with-key", "host": "10.0.0.1",
        "authType": "key", "keyPath": key_ok.to_string_lossy() }))
        .unwrap();

    let off = s
        .export_hosts_scoped(&json!({ "mode": "all" }), None, false, false)
        .unwrap();
    assert_eq!(off["keyPathsIncluded"], json!(false));
    assert_eq!(off["hosts"][0]["keyPath"], json!(""));

    let out = s
        .export_hosts_scoped(&json!({ "mode": "all" }), None, false, true)
        .unwrap();
    assert_eq!(out["keyPathsIncluded"], json!(true));
    assert_eq!(out["hosts"][0]["keyPath"], json!(key_ok.to_string_lossy()));
    let text = text_of(&out);
    assert!(!text.contains("KEYBODY-DO-NOT-PACK"));

    let (dst, ddst) = store("c22-b");
    dst.apply_hosts(&text, None, &json!({})).unwrap();
    let key_host = dst
        .list_hosts()
        .into_iter()
        .find(|h| h["name"] == json!("with-key"))
        .unwrap();
    assert_eq!(key_host["keyPath"], json!(key_ok.to_string_lossy()));
    let _ = std::fs::remove_dir_all(&dir);
    let _ = std::fs::remove_dir_all(&ddst);
}

/// AC-20 相邻功能:导入后列表顺序、分组、标签、跳板引用完整,增删改查不受影响
#[test]
fn case20_adjacent_features_intact() {
    let (a, da) = store("c20-a");
    let j = a
        .save_host(&json!({ "name": "跳板", "host": "10.0.0.3" }))
        .unwrap();
    a.save_host(
        &json!({ "name": "web", "host": "10.0.0.1", "group": "生产", "tags": ["web", "核心"],
        "jumpIds": [j["id"].as_str().unwrap()] }),
    )
    .unwrap();
    let file = text_of(
        &a.export_hosts_scoped(&json!({ "mode": "all" }), None, true, true)
            .unwrap(),
    );

    let (b, db) = store("c20-b");
    b.apply_hosts(&file, None, &json!({})).unwrap();
    let list = b.list_hosts();
    assert_eq!(list.len(), 2);
    let web = list.iter().find(|h| h["name"] == json!("web")).unwrap();
    assert_eq!(web["group"], json!("生产"));
    assert_eq!(web["tags"], json!(["web", "核心"]));
    assert_eq!(web["jumpIds"].as_array().unwrap().len(), 1);
    let jump_id = list.iter().find(|h| h["name"] == json!("跳板")).unwrap()["id"]
        .as_str()
        .unwrap()
        .to_string();
    assert_eq!(
        web["jumpIds"][0],
        json!(jump_id),
        "跳板引用应重映射到本机 ID"
    );

    // 导入后的主机照样能改、能删、能重排
    let web_id = web["id"].as_str().unwrap().to_string();
    b.save_host(
        &json!({ "id": web_id, "name": "web-renamed", "host": "10.0.0.1", "group": "测试" }),
    )
    .unwrap();
    assert_eq!(b.host_full(&web_id).unwrap()["name"], json!("web-renamed"));
    b.reorder_hosts(&[web_id.clone(), jump_id.clone()]).unwrap();
    assert_eq!(b.list_hosts()[0]["id"], json!(web_id));
    assert_eq!(b.delete_hosts(&[web_id]).unwrap()["deleted"], json!(1));
    assert_eq!(b.list_hosts().len(), 1);
    let _ = std::fs::remove_dir_all(&da);
    let _ = std::fs::remove_dir_all(&db);
}

// ---------------------------------------------------------------- F-04 文件指纹

/// AC-23 预检 → 落盘之间文件被替换:apply 必须拒绝,且主机库一个字节都不动。
/// 走的是命令层的真实时序(commands::import_inspect_path / import_apply_path),
/// 不是只测摘要函数。
#[test]
fn case23_file_changed_between_inspect_and_apply_is_rejected() {
    let (src, dsrc) = store("c23-src");
    seed_three(&src);
    let good = text_of(
        &src.export_hosts_scoped(&json!({ "mode": "all" }), None, true, true)
            .unwrap(),
    );

    let (dst, ddst) = store("c23-dst");
    let file = ddst.join("import.json");
    std::fs::write(&file, &good).unwrap();
    let p = file.to_string_lossy().to_string();

    // 1) 预检:返回内容指纹 + 字节数,用户看到的 rows 就是这份文件的
    let inspected = import_inspect_path(&dst, &p, None).unwrap();
    let digest = inspected["digest"].as_str().unwrap().to_string();
    assert!(
        digest.starts_with("sha256:"),
        "指纹要带算法前缀: {}",
        digest
    );
    assert_eq!(
        digest.len(),
        "sha256:".len() + 32,
        "sha256 前 16 字节 = 32 位十六进制"
    );
    assert_eq!(inspected["bytes"], json!(good.len()));
    assert_eq!(inspected["inspect"]["rows"].as_array().unwrap().len(), 3);

    // 2) 用户确认之后,同一个路径的文件被换成另一份(模拟导出文件被覆盖/同步工具改写)
    let mut other = src
        .export_hosts_scoped(&json!({ "mode": "all" }), None, true, true)
        .unwrap();
    other["hosts"][0]["host"] = json!("10.9.9.9");
    std::fs::write(&file, text_of(&other)).unwrap();

    // 3) 拿旧指纹落盘 → E_FILE_CHANGED,库保持为空
    let e = import_apply_path(&dst, &p, None, &json!({}), false, Some(&digest)).unwrap_err();
    assert!(e.starts_with("E_FILE_CHANGED"), "应返回文件已变化: {}", e);
    assert_eq!(dst.list_hosts().len(), 0, "指纹不符时不允许写入任何主机");

    // 不带指纹同样拒绝:允许省略就等于给 TOCTOU 留后门
    let e2 = import_apply_path(&dst, &p, None, &json!({}), false, None).unwrap_err();
    assert!(e2.starts_with("E_FILE_CHANGED"), "缺少指纹也要拒绝: {}", e2);
    assert_eq!(dst.list_hosts().len(), 0);

    // 4) 重新校验 → 新指纹生效,写入的是「现在这份」的内容
    let again = import_inspect_path(&dst, &p, None).unwrap();
    let digest2 = again["digest"].as_str().unwrap().to_string();
    assert_ne!(digest, digest2, "文件换了,指纹必须变");
    let r = import_apply_path(&dst, &p, None, &json!({}), false, Some(&digest2)).unwrap();
    assert_eq!(r["result"]["added"], json!(3));
    let hosts = dst.list_hosts();
    assert_eq!(hosts.len(), 3);
    assert!(
        hosts.iter().any(|h| h["host"] == json!("10.9.9.9")),
        "写入的应是修改后的那份文件"
    );

    let _ = std::fs::remove_dir_all(&dsrc);
    let _ = std::fs::remove_dir_all(&ddst);
}

// ---------------------------------------------------------------- F-09 问题行

/// 一份「两条有效 + 一条端口越界」的文件(pretty 打印,行号稳定)
fn mixed_file() -> String {
    serde_json::to_string_pretty(&json!({
        "app": "nebulashell", "version": 4,
        "hosts": [
            { "id": "a", "name": "好行1", "host": "10.0.0.1", "port": 22, "username": "root" },
            { "id": "b", "name": "坏行", "host": "10.0.0.2", "port": 70000, "username": "root" },
            { "id": "c", "name": "好行2", "host": "10.0.0.3", "port": 22, "username": "root" },
        ],
    }))
    .unwrap()
}

/// AC-24 预检返回结构化问题行;默认行为仍是「整份拒绝」
#[test]
fn case24_invalid_rows_are_structured_and_default_rejects() {
    let (s, dir) = store("c24");
    let text = mixed_file();

    // 旧通道(hosts:importFile / 既有断言):整段中文问题串
    let e = s.inspect_hosts(&text, None).unwrap_err();
    assert!(
        e.contains("导入文件校验失败") && e.contains("端口"),
        "{}",
        e
    );

    // 结构化预检:不 Err,给出 invalidRows + 可预览的 rows
    let insp = s.inspect_hosts_detailed(&text, None).unwrap();
    assert_eq!(insp["rejected"], json!(true));
    assert_eq!(insp["code"], json!("E_INVALID_PRESENT"));
    let invalid = insp["invalidRows"].as_array().unwrap();
    assert_eq!(invalid.len(), 1, "只有 1 行端口越界");
    assert_eq!(invalid[0]["index"], json!(2), "index 是 1-based 记录序号");
    assert_eq!(invalid[0]["name"], json!("坏行"));
    assert_eq!(invalid[0]["field"], json!("port"));
    assert_eq!(invalid[0]["code"], json!("E_PORT"));
    assert!(invalid[0]["reason"].as_str().unwrap().contains("70000"));
    // 行号必须指向文件里那一条记录(记录起始行,不是记录序号)
    let line_no = invalid[0]["line"].as_u64().expect("行号应有值") as usize;
    let record_text = text
        .lines()
        .skip(line_no - 1)
        .take(4)
        .collect::<Vec<_>>()
        .join("\n");
    assert!(
        record_text.contains("坏行"),
        "第 {} 行起的记录应包含问题行: {}",
        line_no,
        record_text
    );

    // 预览行:两条有效 + 一条问题行(kind=invalid,前端不可勾选)
    let rows = insp["rows"].as_array().unwrap();
    assert_eq!(rows.len(), 3);
    assert_eq!(
        rows.iter()
            .filter(|r| r["kind"] == json!("invalid"))
            .count(),
        1
    );
    assert_eq!(rows.iter().filter(|r| r["kind"] == json!("add")).count(), 2);
    assert_eq!(insp["counts"]["invalid"], json!(1));

    // 默认落盘 = 整份拒绝,库不变
    let e = s.apply_hosts(&text, None, &json!({})).unwrap_err();
    assert!(e.contains("端口"), "{}", e);
    assert_eq!(s.list_hosts().len(), 0, "默认必须整份拒绝");

    let _ = std::fs::remove_dir_all(&dir);
}

/// AC-25 用户明确「只导有效行」:好行写入,坏行进结果行(result=invalid)
#[test]
fn case25_allow_partial_writes_valid_rows_and_reports_invalid() {
    let (s, dir) = store("c25");
    let text = mixed_file();

    let r = s.apply_hosts_with(&text, None, &json!({}), true).unwrap();
    assert_eq!(r["added"], json!(2));
    assert_eq!(r["invalid"], json!(1));
    let rows = r["rows"].as_array().unwrap();
    let bad = rows
        .iter()
        .find(|row| row["result"] == json!("invalid"))
        .unwrap();
    assert_eq!(bad["name"], json!("坏行"));
    assert!(
        bad["reason"].as_str().unwrap().contains("端口"),
        "结果行要带原因: {}",
        bad
    );
    assert_eq!(
        rows.iter()
            .filter(|row| row["result"] == json!("written"))
            .count(),
        2
    );

    let hosts = s.list_hosts();
    assert_eq!(hosts.len(), 2, "只有有效行落库");
    assert!(hosts.iter().all(|h| h["name"] != json!("坏行")));
    assert!(hosts.iter().any(|h| h["host"] == json!("10.0.0.3")));

    // 再导一次(仍 allow_partial)应幂等:一致行不重复写
    let again = s.apply_hosts_with(&text, None, &json!({}), true).unwrap();
    assert_eq!(again["added"], json!(0));
    assert_eq!(s.list_hosts().len(), 2);

    let _ = std::fs::remove_dir_all(&dir);
}

/// AC-26 文件级问题(空主机列表)不受 allow_partial 影响,仍然整份拒绝
#[test]
fn case26_file_level_issues_ignore_allow_partial() {
    let (s, dir) = store("c26");
    let text = serde_json::to_string(&json!({ "version": 4, "hosts": [] })).unwrap();
    let e = s
        .apply_hosts_with(&text, None, &json!({}), true)
        .unwrap_err();
    assert!(
        e.contains("没有主机记录"),
        "空文件即使 allowPartial 也要拒绝: {}",
        e
    );
    let insp = s.inspect_hosts_detailed(&text, None).unwrap_err();
    assert!(insp.contains("没有主机记录"), "预检也要整份拒绝: {}", insp);
    assert_eq!(s.list_hosts().len(), 0);
    let _ = std::fs::remove_dir_all(&dir);
}

/// AC-27 只导有效行时,被跳板引用的坏行必须明确拒绝(不能静默丢掉跳板关系)
#[test]
fn case27_partial_import_rejects_jump_pointing_at_invalid_row() {
    let (s, dir) = store("c27");
    let text = serde_json::to_string(&json!({
        "version": 4,
        "hosts": [
            { "id": "j1", "name": "跳板", "host": "10.0.0.1", "port": 70000 },
            { "id": "t1", "name": "目标", "host": "10.0.0.2", "jumpIds": ["j1"] },
        ],
    }))
    .unwrap();
    let e = s
        .apply_hosts_with(&text, None, &json!({}), true)
        .unwrap_err();
    assert!(
        e.contains("所在的行校验失败"),
        "应指出跳板所在行校验失败,而不是含糊的悬空跳板: {}",
        e
    );
    assert_eq!(s.list_hosts().len(), 0, "整批未写入");
    let _ = std::fs::remove_dir_all(&dir);
}

// ---------------------------------------------------------------- 落盘健壮性

/// F-15 私钥写盘失败不再静默:结果行带 `warnings[]`,主机本身照常写入,
/// `keyPath` 也不会被改成一个没写成功的路径。
#[test]
fn case28_key_install_failure_is_reported() {
    // 构造一份含 keyFile 的口令加密块,验证导入端的 keyFile 落地失败告警
    let (dsrc_store, dsrc) = store("c28-src");
    let key_path = dsrc.join("id_rsa");
    let cred_plain = serde_json::to_vec(&json!([
        {
            "id": "src-k1",
            "host": "10.9.9.9",
            "port": 22,
            "username": "root",
            "keyFile": { "name": "id_rsa", "content": "KEYBODY\n" }
        }
    ]))
    .unwrap();
    let blob = nebulashell_lib::config::encrypt_with_passphrase("pass1234", &cred_plain).unwrap();
    let out = json!({
        "app": "nebulashell",
        "version": 4,
        "hosts": [{
            "id": "src-k1",
            "name": "keyed",
            "host": "10.9.9.9",
            "port": 22,
            "username": "root",
            "authType": "key",
            "keyPath": key_path.to_string_lossy()
        }],
        "credentials": {
            "alg": "passphrase-scrypt/v1",
            "blob": blob
        }
    });
    let text = text_of(&out);
    drop(dsrc_store);

    // 目标库:把 keys 目录的位置占成普通文件 → 私钥写盘必然失败
    let (dst, ddst) = store("c28-dst");
    std::fs::write(ddst.join("keys"), b"occupied").unwrap();
    let r = dst.apply_hosts(&text, Some("pass1234"), &json!({})).unwrap();
    let row = &r["rows"][0];
    assert_eq!(
        row["result"],
        json!("written"),
        "私钥装不上不该阻断主机写入: {}",
        row
    );
    let warn = row["warnings"][0].as_str().unwrap_or("");
    assert!(
        warn.contains("私钥写入失败"),
        "私钥写失败必须写进结果行(warnings),实际 {}",
        row
    );
    // 主机已入库,keyPath 仍是文件里给的原路径(没被换成写不进去的 keys/ 路径)
    let host = dst
        .list_hosts()
        .into_iter()
        .find(|h| h["name"] == json!("keyed"))
        .expect("主机应已写入");
    assert_eq!(host["keyPath"], json!(key_path.to_string_lossy()));
    let _ = std::fs::remove_dir_all(&dsrc);
    let _ = std::fs::remove_dir_all(&ddst);
}
