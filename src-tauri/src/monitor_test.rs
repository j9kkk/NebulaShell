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
    assert_eq!(
        parse_proc("", None, 1.0)["supported"],
        serde_json::json!(false)
    );
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

const DARWIN_SAMPLE_1: &str = "\
__NB_OS_DARWIN__
8
17179869184
__NB_SEC__
%CPU
 80.0
 40.0
  0.0
__NB_SEC__
Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                                     4252.
Pages active:                                 224419.
Pages inactive:                               223212.
Pages speculative:                                52.
Pages wired down:                             150000.
Anonymous pages:                              250000.
Pages occupied by compressor:                 124288.
__NB_SEC__
Filesystem     1024-blocks      Used Available Capacity  Mounted on
/dev/disk3s1s1   482797652  13434728  82797652    14%    /
/dev/disk3s5     482797652 355711620  82797652    81%    /System/Volumes/Data
__NB_SEC__
Name       Mtu   Network       Address            Ipkts Ierrs     Ibytes    Opkts Oerrs     Obytes  Coll
lo0        16384 <Link#1>                      39019537     0 47738499991 39019537     0 47738499991     0
lo0        16384 127           127.0.0.1       39019537     - 47738499991 39019537     - 47738499991     -
en0        1500  <Link#14>   02:00:00:00:00:00    42000     0    1000000    49000     0    2000000     0
en0        1500  192.168.31    192.168.31.208     42000     -    1000000    49000     -    2000000     -
utun4      1500  <Link#27>                        15000     0     500000    12000     0     300000     0
utun4      1500  198.18.0/30   198.18.0.1         15000     -     500000    12000     -     300000     -
__NB_SEC__
  |   \"Statistics\" = {\"Operations (Write)\"=100,\"Bytes (Read)\"=10000000,\"Bytes (Write)\"=5000000,\"Operations (Read)\"=200}
__NB_DONE__";

const DARWIN_SAMPLE_2: &str = "\
__NB_OS_DARWIN__
8
17179869184
__NB_SEC__
%CPU
160.0
 80.0
__NB_SEC__
Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages wired down:                             200000.
Anonymous pages:                              300000.
Pages occupied by compressor:                 286432.
__NB_SEC__
Filesystem     1024-blocks      Used Available Capacity  Mounted on
/dev/disk3s1s1   482797652  13434728  82797652    14%    /
/dev/disk3s5     482797652 355711620  82797652    81%    /System/Volumes/Data
__NB_SEC__
Name       Mtu   Network       Address            Ipkts Ierrs     Ibytes    Opkts Oerrs     Obytes  Coll
lo0        16384 <Link#1>                      39020000     0 47999999999 39020000     0 47999999999     0
en0        1500  <Link#14>   02:00:00:00:00:00    43000     0    1600000    50000     0    2900000     0
en0        1500  192.168.31    192.168.31.208     43000     -    1600000    50000     -    2900000     -
utun4      1500  <Link#27>                        16000     0     800000    13000     0     600000     0
__NB_SEC__
  |   \"Statistics\" = {\"Operations (Write)\"=150,\"Bytes (Read)\"=13000000,\"Bytes (Write)\"=6500000,\"Operations (Read)\"=250}
__NB_DONE__";

#[test]
fn darwin_first_sample_and_apfs() {
    let r = parse_proc(DARWIN_SAMPLE_1, None, 3.0);
    assert_eq!(r["supported"], serde_json::json!(true));
    // CPU: (80 + 40) / 8 = 15.0%
    assert_eq!(r["cpuPct"], serde_json::json!(15.0));
    // 内存: (250000 + 150000 + 124288) * 16384 = 524288 * 16384 = 8GB / 16GB = 50%
    assert_eq!(r["memTotalMB"], serde_json::json!(16384));
    assert_eq!(r["memUsedMB"], serde_json::json!(8192));
    assert_eq!(r["memPct"], serde_json::json!(50.0));
    // 磁盘: 优先取 /System/Volumes/Data, total=482797652KB (460.4GB), used=total-avail=400000000KB (381.5GB, 82.9%)
    assert_eq!(r["diskTotalGB"], serde_json::json!(460.4));
    assert_eq!(r["diskUsedGB"], serde_json::json!(381.5));
    assert_eq!(r["diskPct"], serde_json::json!(82.9));
    // 首帧无差分基线
    assert!(r["rxBps"].is_null());
    assert!(r["txBps"].is_null());
    assert!(r["diskReadBps"].is_null());
}

#[test]
fn darwin_second_sample_delta_dedup_netstat() {
    let first = parse_proc(DARWIN_SAMPLE_1, None, 3.0);
    let r = parse_proc(DARWIN_SAMPLE_2, Some(&first["raw"]), 3.0);
    assert_eq!(r["supported"], serde_json::json!(true));
    // CPU: (160 + 80) / 8 = 30.0%
    assert_eq!(r["cpuPct"], serde_json::json!(30.0));
    // 内存: 786432 * 16384 = 12GB / 16GB = 75%
    assert_eq!(r["memPct"], serde_json::json!(75.0));
    // 网络: 样本1 rx=1000000+500000=1500000, tx=2000000+300000=2300000
    //       样本2 rx=1600000+800000=2400000, tx=2900000+600000=3500000
    //       3s 差分: rxBps = 900000 / 3 = 300000, txBps = 1200000 / 3 = 400000
    assert_eq!(r["rxBps"], serde_json::json!(300000.0));
    assert_eq!(r["txBps"], serde_json::json!(400000.0));
    // 磁盘 IO: read 差分 3000000 / 3 = 1000000, write 差分 1500000 / 3 = 500000
    assert_eq!(r["diskReadBps"], serde_json::json!(1000000.0));
    assert_eq!(r["diskWriteBps"], serde_json::json!(500000.0));
}

#[test]
fn darwin_hfs_root_fallback_and_intel_4k_pages() {
    let sample = "\
__NB_OS_DARWIN__
4
8589934592
__NB_SEC__
%CPU
40,0
__NB_SEC__
Mach Virtual Memory Statistics: (page size of 4096 bytes)
Pages active:                                 524288.
Pages wired down:                             524288.
__NB_SEC__
Filesystem     1024-blocks      Used Available Capacity  Mounted on
/dev/disk1       104857600  52428800  52428800    50%    /
__NB_SEC__
__NB_SEC__
__NB_DONE__";
    let r = parse_proc(sample, None, 1.0);
    assert_eq!(r["supported"], serde_json::json!(true));
    assert_eq!(r["cpuPct"], serde_json::json!(10.0));
    assert_eq!(r["memTotalMB"], serde_json::json!(8192));
    assert_eq!(r["memUsedMB"], serde_json::json!(4096));
    assert_eq!(r["memPct"], serde_json::json!(50.0));
    assert_eq!(r["diskTotalGB"], serde_json::json!(100.0));
    assert_eq!(r["diskUsedGB"], serde_json::json!(50.0));
    assert_eq!(r["diskPct"], serde_json::json!(50.0));
}

#[test]
fn darwin_live_probe_executes_and_parses() {
    if std::env::consts::OS != "macos" {
        return;
    }
    let out1 = std::process::Command::new("sh")
        .arg("-c")
        .arg(crate::monitor::PROBE)
        .output()
        .expect("run PROBE 1");
    let text1 = String::from_utf8_lossy(&out1.stdout);
    let r1 = parse_proc(&text1, None, 3.0);
    assert_eq!(r1["supported"], serde_json::json!(true));
    assert!(r1["cpuPct"]
        .as_f64()
        .is_some_and(|v| (0.0..=100.0).contains(&v)));
    assert!(r1["memPct"]
        .as_f64()
        .is_some_and(|v| (0.0..=100.0).contains(&v)));
    assert!(r1["memTotalMB"].as_u64().unwrap_or(0) > 1024);
    assert!(r1["diskTotalGB"].as_f64().unwrap_or(0.0) > 10.0);

    let out2 = std::process::Command::new("sh")
        .arg("-c")
        .arg(crate::monitor::PROBE)
        .output()
        .expect("run PROBE 2");
    let text2 = String::from_utf8_lossy(&out2.stdout);
    let r2 = parse_proc(&text2, Some(&r1["raw"]), 1.0);
    assert_eq!(r2["supported"], serde_json::json!(true));
    assert!(r2["rxBps"].as_f64().is_some_and(|v| v >= 0.0));
    assert!(r2["txBps"].as_f64().is_some_and(|v| v >= 0.0));
    assert!(r2["diskReadBps"].as_f64().is_some_and(|v| v >= 0.0));
    assert!(r2["diskWriteBps"].as_f64().is_some_and(|v| v >= 0.0));
}
