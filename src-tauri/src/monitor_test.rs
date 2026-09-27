// 资源监控解析测试:与 Electron 版 monitor.test.mjs 同一样本与断言
use crate::monitor::parse_proc;

const SAMPLE_1: &str = "cpu  1000 0 500 8000 200 0 100 0 0 0\nMemTotal:        4000000 kB\nMemFree:          800000 kB\nMemAvailable:    2000000 kB\nBuffers:          100000 kB\nCached:           600000 kB\neth0: 1000000  500 0 0 0 0 0 0  200000 400 0 0 0 0 0 0\nlo: 99999999 100 0 0 0 0 0 0  99999999 100 0 0 0 0 0 0\n__NB_DONE__\nLinux";

const SAMPLE_2: &str = "cpu  1500 0 700 9000 250 0 100 0 0 0\nMemTotal:        4000000 kB\nMemAvailable:    1000000 kB\neth0: 1600000  700 0 0 0 0 0 0  500000 600 0 0 0 0 0 0\n__NB_DONE__\nLinux";

#[test]
fn first_sample_no_delta() {
    let r = parse_proc(SAMPLE_1, None, 1.0);
    assert_eq!(r["supported"], serde_json::json!(true));
    assert!(r["cpuPct"].is_null(), "首次采样无差分基线");
    assert_eq!(r["memTotalMB"], serde_json::json!(3906));
    assert_eq!(r["memUsedMB"], serde_json::json!(1953));
    assert_eq!(r["memPct"], serde_json::json!(50.0));
    assert!(r["rxBps"].is_null());
}

#[test]
fn second_sample_delta_and_disk() {
    let first = parse_proc(SAMPLE_1, None, 1.0);
    let r = parse_proc(SAMPLE_2, Some(&first["raw"]), 1.0);
    assert_eq!(r["supported"], serde_json::json!(true));
    // cpu 总量样本1=9800 idle=8200;样本2=11550 idle=9250 → (1-1050/1750)*100 = 40%
    assert_eq!(r["cpuPct"], serde_json::json!(40.0));
    assert_eq!(r["memPct"], serde_json::json!(75.0));
    assert_eq!(r["rxBps"], serde_json::json!(600000.0), "网络速率应排除 lo");
    assert_eq!(r["txBps"], serde_json::json!(300000.0));
}

#[test]
fn unsupported_graceful() {
    let r = parse_proc("EXEC-OK echo __NB_DONE__\n__NB_DONE__\nDarwin", None, 1.0);
    assert_eq!(r["supported"], serde_json::json!(false));
    assert_eq!(parse_proc("", None, 1.0)["supported"], serde_json::json!(false));
}

#[test]
fn mem_available_fallback() {
    let text = SAMPLE_1.replace("MemAvailable:    2000000 kB\n", "");
    let r = parse_proc(&text, None, 1.0);
    // MemFree 800000 + Buffers 100000 + Cached 600000 = 1500000
    assert_eq!(r["memUsedMB"], serde_json::json!(2441));
}

#[test]
fn disk_parse() {
    let head = SAMPLE_1.replace("__NB_DONE__\nLinux", "");
    let text = format!(
        "{}sda 8 0 100 0 0 0 0 0 0 0 0\nFilesystem 1024-blocks Used Available Capacity Mounted on\n/dev/vda 408980 200000 190000 49% /\n__NB_DONE__",
        head
    );
    let r = parse_proc(&text, None, 1.0);
    assert_eq!(r["diskPct"], serde_json::json!(49.0));
}
