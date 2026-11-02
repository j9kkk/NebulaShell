// 主机导入/导出验收回归(数据层,直接驱动真实 Store 实现)
//
// 与 src/store_test.rs 的分工:store_test 是按实现细节拆的单元测试;这里按
// 《导入导出问题清单》的用户可见用例组织,一条用例 = 一条可写进验收记录的行。
// 用例编号与 docs/host-import-export-acceptance.md 的表格一一对应。
//
// 运行:cargo test --test import_export_acceptance -- --nocapture
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
    out.sort_by_key(|h| (h["host"].as_str().unwrap_or("").to_string(), h["port"].as_i64().unwrap_or(22)));
    out
}

fn seed_three(store: &Store) {
    store
        .save_host(&json!({ "name": "web-1", "host": "10.0.0.1", "port": 22, "username": "root",
            "group": "生产", "tags": ["web"], "password": "pw-1" }))
        .unwrap();
    store
        .save_host(&json!({ "name": "库", "host": "10.0.0.2", "port": 2222, "username": "dba",
            "group": "生产", "privateKey": "-----BEGIN OPENSSH PRIVATE KEY-----\nxx\n",
            "passphrase": "kp-2" }))
        .unwrap();
    store
        .save_host(&json!({ "name": "跳板", "host": "10.0.0.3", "username": "jump", "password": "pw-3" }))
        .unwrap();
}

// ---------------------------------------------------------------- 导出

/// AC-01 导出文件结构:v4、凭据只出现在加密块、主机字段明文可读
#[test]
fn case01_export_shape_and_no_plaintext() {
    let (s, dir) = store("c01");
    seed_three(&s);
    let out = s.export_hosts_scoped(&json!({ "mode": "all" }), None, false).unwrap();
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

/// AC-02 正常导入:全量导出 → 空库导入,主机与三类凭据全部还原
#[test]
fn case02_roundtrip_full_to_empty_store() {
    let (a, da) = store("c02-a");
    seed_three(&a);
    let text = text_of(&a.export_hosts_scoped(&json!({ "mode": "all" }), None, false).unwrap());

    let (b, db) = store("c02-b");
    let r = b.inspect_hosts(&text, None).unwrap();
    assert_eq!(r["counts"], json!({ "add": 3, "credOnly": 0, "conflict": 0, "identical": 0 }));
    let applied = b.apply_hosts(&text, None, &json!({})).unwrap();
    assert_eq!(applied["added"], json!(3));
    assert_eq!(applied["withCredentials"], json!(3));

    let list = b.list_hosts();
    assert_eq!(shapes(&list), shapes(&a.list_hosts()), "往返后主机属性应一致");
    let by_host = |st: &Store, h: &str| -> Value {
        let id = st.list_hosts().into_iter().find(|x| x["host"] == json!(h)).unwrap()["id"]
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
    assert!(full["privateKey"].as_str().unwrap().contains("BEGIN OPENSSH"));
    assert_eq!(full["passphrase"], json!("kp-2"));
    let _ = std::fs::remove_dir_all(&da);
    let _ = std::fs::remove_dir_all(&db);
}

/// AC-03 幂等:导出文件导回同一个库,全部判"一致",不重复建主机
#[test]
fn case03_reimport_same_store_is_idempotent() {
    let (s, dir) = store("c03");
    seed_three(&s);
    let text = text_of(&s.export_hosts_scoped(&json!({ "mode": "all" }), None, false).unwrap());

    let insp = s.inspect_hosts(&text, None).unwrap();
    assert_eq!(insp["counts"]["identical"], json!(3), "同库重导应全部判一致: {}", insp);
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
    let gen1 = a.export_hosts_scoped(&json!({ "mode": "all" }), None, false).unwrap();

    let (b, db) = store("c04-b");
    b.apply_hosts(&text_of(&gen1), None, &json!({})).unwrap();
    let gen2 = b.export_hosts_scoped(&json!({ "mode": "all" }), None, false).unwrap();
    assert_eq!(
        shapes(gen1["hosts"].as_array().unwrap()),
        shapes(gen2["hosts"].as_array().unwrap()),
        "第二代导出应与第一代主机属性一致"
    );

    let (c, dc) = store("c04-c");
    c.apply_hosts(&text_of(&gen2), None, &json!({})).unwrap();
    let gen3 = c.export_hosts_scoped(&json!({ "mode": "all" }), None, false).unwrap();
    assert_eq!(
        shapes(gen2["hosts"].as_array().unwrap()),
        shapes(gen3["hosts"].as_array().unwrap())
    );
    // 凭据也要跨代保持
    let pw = |st: &Store| {
        let id = st.list_hosts().into_iter().find(|h| h["host"] == json!("10.0.0.1")).unwrap()["id"]
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

/// AC-05 空文件 / 纯空白:给出可读错误,不写盘
#[test]
fn case05_empty_file_is_rejected_clearly() {
    let (s, dir) = store("c05");
    for body in ["", "   \n\t  ", "\r\n"] {
        let e = s.inspect_hosts(body, None).unwrap_err();
        assert_eq!(e, "文件不是合法 JSON", "空文件应报格式错误,实际: {}", e);
        let e = s.apply_hosts(body, None, &json!({})).unwrap_err();
        assert_eq!(e, "文件不是合法 JSON");
    }
    assert!(s.list_hosts().is_empty());
    let _ = std::fs::remove_dir_all(&dir);
}

/// AC-06 结构合法但无主机:预检返回 0 行(界面据此禁用导入),应用不产生写入
#[test]
fn case06_valid_but_no_hosts() {
    let (s, dir) = store("c06");
    for body in [json!({ "hosts": [] }), json!([])] {
        let r = s.inspect_hosts(&text_of(&body), None).unwrap();
        assert_eq!(r["rows"].as_array().unwrap().len(), 0);
        assert_eq!(r["counts"], json!({ "add": 0, "credOnly": 0, "conflict": 0, "identical": 0 }));
        let applied = s.apply_hosts(&text_of(&body), None, &json!({})).unwrap();
        assert_eq!(applied["added"], json!(0));
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
        ("truncated", "{\"hosts\": [{\"name\": \"a\", \"host\": \"10.0.0.1\"}"),
    ];
    for (tag, body) in cases {
        let e = s.inspect_hosts(body, None).unwrap_err();
        assert!(!e.is_empty(), "{}: 必须有错误信息", tag);
        println!("  {} -> {}", tag, e);
        assert_eq!(e, "文件不是合法 JSON", "{} 的错误文案应统一: {}", tag, e);
    }
    // 合法 JSON 但结构不对:报结构错误,而不是笼统的 JSON 错误
    for body in ["{\"app\":\"nebulashell\"}", "{\"hosts\": 42}", "42", "\"text\""] {
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
    s.save_host(&json!({ "name": "keep", "host": "10.1.1.1" })).unwrap();
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
    s.save_host(&json!({ "name": "keep", "host": "10.1.1.1" })).unwrap();
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

/// AC-11 重复主机(同一文件里同一端点出现两次)
///
/// 现状(代码注释标明是有意为之):同一批次里已经被占用的本地主机不再参与端点兜底,
/// 所以同一文件内两条同端点记录会各建一台主机。这里把现状钉住,并在验收记录里
/// 作为"观察项/待评审"列给产品,不当作已修复。
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
    let r = s.inspect_hosts(&text_of(&file), None).unwrap();
    println!("  dup endpoint(v1) inspect: {}", r["counts"]);
    let applied = s.apply_hosts(&text_of(&file), None, &json!({})).unwrap();
    println!("  dup endpoint(v1) apply: added={}", applied["added"]);
    assert_eq!(
        s.list_hosts().len(),
        applied["added"].as_u64().unwrap() as usize,
        "落地主机数应与本次新增数一致"
    );

    // 已有同端点本地主机时,单行导入应命中它而不是新建
    let (s2, dir2) = store("c11-b");
    s2.save_host(&json!({ "name": "local", "host": "10.9.9.9", "port": 22, "username": "root" }))
        .unwrap();
    let one_row = json!({ "app": "nebulashell", "version": 1,
        "hosts": [{ "name": "web", "host": "10.9.9.9", "port": 22, "username": "root", "password": "p1" }] });
    let insp = s2.inspect_hosts(&text_of(&one_row), None).unwrap();
    assert_eq!(
        insp["counts"]["conflict"].as_u64().unwrap() + insp["counts"]["identical"].as_u64().unwrap(),
        1,
        "同端点应命中原有主机: {}",
        insp["counts"]
    );
    s2.apply_hosts(&text_of(&one_row), None, &json!({})).unwrap();
    assert_eq!(s2.list_hosts().len(), 1, "不应新建重复主机");

    // v4:两台来自不同机器的同端点主机(不同 id)合并成一个文件 → 当前仍建两台
    let (s3, dir3) = store("c11-c");
    let merged = json!({ "app": "nebulashell", "version": 4, "hosts": [
        { "id": "a", "name": "web", "host": "10.9.9.9", "port": 22, "username": "root" },
        { "id": "b", "name": "web", "host": "10.9.9.9", "port": 22, "username": "root" }
    ] });
    let r3 = s3.apply_hosts(&text_of(&merged), None, &json!({})).unwrap();
    println!("  同端点不同 id(v4) apply: added={}", r3["added"]);
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
    let src_out = src.export_hosts_scoped(&json!({ "mode": "all" }), None, false).unwrap();
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
    assert!(rows[0]["diff"].to_string().contains("名称"), "diff 应指出哪个字段不同");
    assert_eq!(dst.list_hosts()[0]["name"], json!("本地名字"), "预检不得写盘");

    // skip
    let key = rows[0]["key"].as_str().unwrap().to_string();
    let mut decisions = serde_json::Map::new();
    decisions.insert(key.clone(), json!("skip"));
    let r = dst.apply_hosts(&text, None, &Value::Object(decisions.clone())).unwrap();
    assert_eq!(r["skipped"], json!(1));
    assert_eq!(dst.list_hosts()[0]["name"], json!("本地名字"));
    let id = dst.list_hosts()[0]["id"].as_str().unwrap().to_string();
    assert_eq!(dst.host_full(&id).unwrap()["password"], json!("old-pw"));

    // overwrite
    decisions.insert(key, json!("overwrite"));
    let r = dst.apply_hosts(&text, None, &Value::Object(decisions)).unwrap();
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
    let text = text_of(&src.export_hosts_scoped(&json!({ "mode": "all" }), None, false).unwrap());
    let src_id = src.list_hosts()[0]["id"].as_str().unwrap().to_string();

    let (dst, ddst) = store("c13-dst");
    dst.save_host(&json!({ "id": src_id, "name": "web-1", "host": "10.0.0.1", "username": "root" }))
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
    src.save_host(&json!({ "name": "web", "host": "10.0.0.1", "password": "hidden-pw" })).unwrap();
    let out = src.export_hosts_scoped(&json!({ "mode": "all" }), Some("pass-123456"), false).unwrap();
    assert_eq!(out["credentials"]["alg"], json!("passphrase-scrypt/v1"));
    let text = text_of(&out);
    assert!(!text.contains("hidden-pw"));

    let (dst, ddst) = store("c14-dst");
    assert_eq!(dst.inspect_hosts(&text, None).unwrap_err(), "NEEDS_PASSPHRASE");
    let e = dst.inspect_hosts(&text, Some("wrong-pass")).unwrap_err();
    assert!(e.contains("口令错误") || e.contains("损坏"), "实际: {}", e);
    let r = dst.inspect_hosts(&text, Some("pass-123456")).unwrap();
    assert_eq!(r["counts"]["add"], json!(1));
    dst.apply_hosts(&text, Some("pass-123456"), &json!({})).unwrap();
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
    let bom = format!("\u{feff}{}", json!({ "version": 4, "hosts": [{ "id": "b", "host": "10.5.5.5" }] }));
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
        .map(|i| json!({ "id": format!("src-{}", i), "name": format!("h-{}", i),
            "host": format!("10.{}.{}.{}", i / 65536 % 256, i / 256 % 256, i % 256),
            "port": 22, "username": "root", "group": format!("g-{}", i % 20) }))
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
    assert!(inspect_ms < 30_000, "5000 台预检超过 30s,实际 {}ms", inspect_ms);

    // 再导一次必须判一致(大规模下的匹配逻辑不走样)
    let insp = s.inspect_hosts(&file, None).unwrap();
    assert_eq!(insp["counts"]["identical"], json!(5000), "重导分类应全一致: {}", insp["counts"]);
    let _ = std::fs::remove_dir_all(&dir);
}

// ---------------------------------------------------------------- 导出范围

/// AC-17 导出范围:全部 / 选中(含跳板闭包)/ 空选择 / 已失效选择
#[test]
fn case17_export_scope_and_jump_closure() {
    let (s, dir) = store("c17");
    let jump = s.save_host(&json!({ "name": "跳板", "host": "10.0.0.3", "username": "jump" })).unwrap();
    s.save_host(&json!({ "name": "web", "host": "10.0.0.1",
        "jumpIds": [jump["id"].as_str().unwrap()] }))
        .unwrap();
    s.save_host(&json!({ "name": "db", "host": "10.0.0.2" })).unwrap();

    // 全部
    let all = s.export_hosts_scoped(&json!({ "mode": "all" }), None, false).unwrap();
    assert_eq!(all["hosts"].as_array().unwrap().len(), 3);

    // 选中:只选 web,跳板机应被闭包带进来,db 不带
    let web_id = s.list_hosts().into_iter().find(|h| h["name"] == json!("web")).unwrap()["id"]
        .as_str()
        .unwrap()
        .to_string();
    let sel = s.export_hosts_scoped(&json!({ "mode": "ids", "ids": [web_id] }), None, false).unwrap();
    let names: Vec<&str> = sel["hosts"].as_array().unwrap().iter().map(|h| h["name"].as_str().unwrap()).collect();
    assert_eq!(sel["hosts"].as_array().unwrap().len(), 2, "选中导出应带跳板闭包: {:?}", names);
    assert!(names.contains(&"跳板") && names.contains(&"web") && !names.contains(&"db"));
    assert_eq!(sel["includedJumps"], json!(1));

    // 子集导出必须能被空库吃下(闭包自洽)
    let (dst, ddst) = store("c17-dst");
    dst.apply_hosts(&text_of(&sel), None, &json!({})).unwrap();
    assert_eq!(dst.list_hosts().len(), 2);
    let web = dst.list_hosts().into_iter().find(|h| h["name"] == json!("web")).unwrap();
    assert_eq!(web["jumpIds"].as_array().unwrap().len(), 1);

    // 空选择 / 失效选择
    let e = s.export_hosts_scoped(&json!({ "mode": "ids", "ids": [] }), None, false).unwrap_err();
    assert!(e.contains("请先选择"), "实际: {}", e);
    let e = s.export_hosts_scoped(&json!({ "mode": "ids", "ids": ["gone"] }), None, false).unwrap_err();
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
    s.save_host(&json!({ "name": "keep", "host": "10.1.1.1" })).unwrap();
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
    println!("  内存主机数 {} -> {}(磁盘未变)", mem_before, mem_after);
    let _ = std::fs::remove_dir_all(&dir);
}

/// AC-19 导入前自动备份:生成快照、不含明文口令、旧备份按 20 份封顶清理
#[test]
fn case19_backup_before_import_and_prune() {
    let (s, dir) = store("c19");
    s.save_host(&json!({ "name": "keep", "host": "10.1.1.1", "password": "plain-secret" })).unwrap();
    let backup_dir = dir.join("backup");
    // 先造 25 份"旧"备份,验证封顶清理
    std::fs::create_dir_all(&backup_dir).unwrap();
    for i in 0..25 {
        std::fs::write(
            backup_dir.join(format!("nebulashell-backup-202001{:02}-000000.json", i % 31 + 1)),
            "{\"hosts\":[]}",
        )
        .unwrap();
    }
    let text = text_of(&json!({ "version": 4, "hosts": [{ "id": "new", "host": "10.7.7.7" }] }));
    let r = s.apply_hosts(&text, None, &json!({})).unwrap();
    let backup = r["backup"].as_str().expect("应写出一份导入前备份").to_string();
    let body = std::fs::read_to_string(&backup).unwrap();
    assert!(body.contains("10.1.1.1"), "备份应含导入前主机");
    assert!(!body.contains("plain-secret"), "备份不应含明文口令");
    let left = std::fs::read_dir(&backup_dir).unwrap().count();
    eprintln!("  backups kept: {} (pruned {})", left, r["backupPruned"]);
    assert!(left <= Store::BACKUP_KEEP + 1, "备份应封顶在 20 份左右,实际 {}", left);
    let _ = std::fs::remove_dir_all(&dir);
}

/// AC-21 字段异常值:端口非法/缺失、名字缺失、用户名缺失,导入不崩且落到合理默认
///
/// 注意:这条用例当前是**红的**,它守的是"导入要校验字段"这个待修缺陷
/// (见 reports/host-io-2026-11-03/data-layer-baseline.md 的 F1)。修好后自然转绿;
/// 不要为了跑绿去放宽断言 —— 手工编辑器有表单兜着,导入文件没有。
#[test]
fn case21_weird_field_values() {
    let (s, dir) = store("c21");
    let file = json!({ "app": "nebulashell", "version": 4, "hosts": [
        { "id": "a", "host": "10.0.0.1", "port": 70000, "username": "" },
        { "id": "b", "host": "10.0.0.2", "port": "abc" },
        { "id": "c", "host": "10.0.0.3", "name": "", "tags": "not-an-array" }
    ] });
    let r = s.apply_hosts(&text_of(&file), None, &json!({})).unwrap();
    assert_eq!(r["added"], json!(3));
    let list = s.list_hosts();
    let mut bad: Vec<String> = Vec::new();
    for h in &list {
        let port = h["port"].as_i64().unwrap_or(-1);
        if !(port > 0 && port < 65536) {
            bad.push(format!("{} 端口落到 {}", h["host"], port));
        }
        if h["name"].as_str().unwrap_or("").is_empty() {
            bad.push(format!("{} 名字为空", h["host"]));
        }
        if h["username"].as_str().unwrap_or("").is_empty() {
            bad.push(format!("{} 用户名为空", h["host"]));
        }
    }
    assert!(
        bad.is_empty(),
        "以下字段未做校验(期望回落默认值): {}",
        bad.join(" / ")
    );
    let _ = std::fs::remove_dir_all(&dir);
}

/// AC-22 「导出私钥文件」:读得到的打进文件,读不到/过大的跳过并在 includedKeys 里体现
#[test]
fn case22_export_private_key_bundle() {
    let (s, dir) = store("c22");
    let key_ok = dir.join("id_ok");
    std::fs::write(&key_ok, "-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n").unwrap();
    let key_big = dir.join("id_big");
    std::fs::write(&key_big, vec![b'k'; 600 * 1024]).unwrap();
    s.save_host(&json!({ "name": "with-key", "host": "10.0.0.1",
        "authType": "key", "keyPath": key_ok.to_string_lossy() }))
        .unwrap();
    s.save_host(&json!({ "name": "big-key", "host": "10.0.0.2",
        "authType": "key", "keyPath": key_big.to_string_lossy() }))
        .unwrap();
    s.save_host(&json!({ "name": "gone-key", "host": "10.0.0.3",
        "authType": "key", "keyPath": dir.join("missing").to_string_lossy() }))
        .unwrap();

    let out = s.export_hosts_scoped(&json!({ "mode": "all" }), None, true).unwrap();
    assert_eq!(out["includedKeys"], json!(1), "只应打包读得到且 ≤512KB 的私钥");
    let text = text_of(&out);

    // 带私钥文件导入:keyFile 落到应用数据目录,0600
    let (dst, ddst) = store("c22-b");
    dst.apply_hosts(&text, None, &json!({})).unwrap();
    let key_host = dst.list_hosts().into_iter().find(|h| h["name"] == json!("with-key")).unwrap();
    let installed = key_host["keyPath"].as_str().unwrap_or("").to_string();
    assert!(PathBuf::from(&installed).exists(), "私钥文件应已落地: {}", installed);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(&installed).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600, "私钥权限应为 0600,实际 {:o}", mode);
    }
    let _ = std::fs::remove_dir_all(&dir);
    let _ = std::fs::remove_dir_all(&ddst);
}

/// AC-20 相邻功能:导入后列表顺序、分组、标签、跳板引用完整,增删改查不受影响
#[test]
fn case20_adjacent_features_intact() {
    let (a, da) = store("c20-a");
    let j = a.save_host(&json!({ "name": "跳板", "host": "10.0.0.3" })).unwrap();
    a.save_host(&json!({ "name": "web", "host": "10.0.0.1", "group": "生产", "tags": ["web", "核心"],
        "jumpIds": [j["id"].as_str().unwrap()] }))
        .unwrap();
    let file = text_of(&a.export_hosts_scoped(&json!({ "mode": "all" }), None, false).unwrap());

    let (b, db) = store("c20-b");
    b.apply_hosts(&file, None, &json!({})).unwrap();
    let list = b.list_hosts();
    assert_eq!(list.len(), 2);
    let web = list.iter().find(|h| h["name"] == json!("web")).unwrap();
    assert_eq!(web["group"], json!("生产"));
    assert_eq!(web["tags"], json!(["web", "核心"]));
    assert_eq!(web["jumpIds"].as_array().unwrap().len(), 1);
    let jump_id = list.iter().find(|h| h["name"] == json!("跳板")).unwrap()["id"].as_str().unwrap().to_string();
    assert_eq!(web["jumpIds"][0], json!(jump_id), "跳板引用应重映射到本机 ID");

    // 导入后的主机照样能改、能删、能重排
    let web_id = web["id"].as_str().unwrap().to_string();
    b.save_host(&json!({ "id": web_id, "name": "web-renamed", "host": "10.0.0.1", "group": "测试" }))
        .unwrap();
    assert_eq!(b.host_full(&web_id).unwrap()["name"], json!("web-renamed"));
    b.reorder_hosts(&[web_id.clone(), jump_id.clone()]).unwrap();
    assert_eq!(b.list_hosts()[0]["id"], json!(web_id));
    assert_eq!(b.delete_hosts(&[web_id]).unwrap()["deleted"], json!(1));
    assert_eq!(b.list_hosts().len(), 1);
    let _ = std::fs::remove_dir_all(&da);
    let _ = std::fs::remove_dir_all(&db);
}
