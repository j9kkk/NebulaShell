// 服务器资源监控:/proc 探测解析(与 Electron 版 parseProc 语义一致)
use serde_json::{json, Value};

pub const PROBE: &str =
    "cat /proc/stat /proc/meminfo /proc/net/dev /proc/diskstats 2>/dev/null; df -kP / 2>/dev/null | tail -1; echo __NB_DONE__";

pub fn parse_proc(text: &str, prev: Option<&Value>, interval_sec: f64) -> Value {
    let sections = text.split("__NB_DONE__").next().unwrap_or("");
    let has_stat = quick_match(sections, "cpu");
    let has_mem = sections.contains("MemTotal:");
    if !has_stat || !has_mem {
        return json!({ "supported": false });
    }

    // CPU:首行 cpu user nice system idle iowait irq softirq steal
    let mut cpu_total = 0u64;
    let mut cpu_idle = 0u64;
    let mut cpu_pct: Option<f64> = None;
    for line in sections.lines() {
        if let Some(rest) = line.strip_prefix("cpu ") {
            let cols: Vec<u64> = rest
                .split_whitespace()
                .filter_map(|x| x.parse::<u64>().ok())
                .collect();
            if cols.len() >= 4 {
                cpu_total = cols[..8.min(cols.len())].iter().sum();
                cpu_idle = cols[3] + cols.get(4).copied().unwrap_or(0);
                if let Some(p) = prev {
                    if let (Some(pt), Some(pi)) = (p["cpuTotal"].as_u64(), p["cpuIdle"].as_u64()) {
                        let d_total = cpu_total as f64 - pt as f64;
                        let d_idle = cpu_idle as f64 - pi as f64;
                        if d_total > 0.0 {
                            cpu_pct = Some(((1.0 - d_idle / d_total) * 100.0).clamp(0.0, 100.0));
                        }
                    }
                }
            }
            break;
        }
    }

    // 内存
    let mem_total = kb(sections, "MemTotal");
    let mem_avail = kb(sections, "MemAvailable").or_else(|| {
        let free = kb(sections, "MemFree").unwrap_or(0);
        let buffers = kb(sections, "Buffers").unwrap_or(0);
        let cached = kb(sections, "Cached").unwrap_or(0);
        let sum = free + buffers + cached;
        if sum > 0 { Some(sum) } else { None }
    });
    let (mem_pct, mem_used_mb, mem_total_mb) = match (mem_total, mem_avail) {
        (Some(total), Some(avail)) if total > 0 => (
            Some(((total - avail) as f64 / total as f64 * 1000.0).round() / 10.0),
            Some((total - avail) / 1024),
            Some(total / 1024),
        ),
        _ => (None, None, None),
    };

    // 网络:/proc/net/dev 排除 lo
    let mut rx: u64 = 0;
    let mut tx: u64 = 0;
    let mut has_net = false;
    for line in sections.lines() {
        if let Some(i) = line.find(':') {
            let iface = line[..i].trim();
            if iface.is_empty() || iface == "lo" {
                continue;
            }
            let f: Vec<u64> = line[i + 1..]
                .split_whitespace()
                .filter_map(|x| x.parse::<u64>().ok())
                .collect();
            if f.len() > 8 {
                rx += f[0];
                tx += f[8];
                has_net = true;
            }
        }
    }
    let (rx_bps, tx_bps) = match (has_net, prev.and_then(|p| p["rx"].as_u64())) {
        (true, Some(prev_rx)) => (
            Some(rx.saturating_sub(prev_rx) as f64 / interval_sec),
            Some(tx.saturating_sub(prev.and_then(|p| p["tx"].as_u64()).unwrap_or(0)) as f64 / interval_sec),
        ),
        _ => (None, None),
    };

    // 磁盘:df 根分区 + diskstats 扇区差分
    let mut disk_pct = None;
    let mut disk_used_gb = None;
    let mut disk_total_gb = None;
    for line in sections.lines() {
        let f: Vec<&str> = line.split_whitespace().collect();
        if f.len() >= 6 && f[4].ends_with('%') && f[5] == "/" && f[0] != "Filesystem" {
            disk_pct = f[4].trim_end_matches('%').parse::<f64>().ok();
            disk_total_gb = f[1].parse::<f64>().ok().map(|v| (v / 1024.0 / 1024.0 * 10.0).round() / 10.0);
            disk_used_gb = f[2].parse::<f64>().ok().map(|v| (v / 1024.0 / 1024.0 * 10.0).round() / 10.0);
        }
    }
    let mut sectors_r: u64 = 0;
    let mut sectors_w: u64 = 0;
    let mut has_disk = false;
    for line in sections.lines() {
        let f: Vec<&str> = line.split_whitespace().collect();
        if f.len() >= 14 {
            if let Some(name) = f.get(2) {
                let n: &str = name;
                let phys = (n.starts_with("sd")
                    || n.starts_with("vd")
                    || n.starts_with("nvme")
                    || n.starts_with("xvd")
                    || n.starts_with("hd"))
                    && !n.contains('p');
                if phys {
                    sectors_r += f[5].parse::<u64>().unwrap_or(0);
                    sectors_w += f[9].parse::<u64>().unwrap_or(0);
                    has_disk = true;
                }
            }
        }
    }
    let (disk_read_bps, disk_write_bps) = match (has_disk, prev.and_then(|p| p["sectorsR"].as_u64())) {
        (true, Some(pr)) => (
            Some(sectors_r.saturating_sub(pr) as f64 * 512.0 / interval_sec),
            Some(sectors_w.saturating_sub(prev.and_then(|p| p["sectorsW"].as_u64()).unwrap_or(0)) as f64 * 512.0 / interval_sec),
        ),
        _ => (None, None),
    };

    json!({
        "supported": true,
        "cpuPct": cpu_pct.map(|v| (v * 10.0).round() / 10.0),
        "memPct": mem_pct, "memUsedMB": mem_used_mb, "memTotalMB": mem_total_mb,
        "rxBps": rx_bps, "txBps": tx_bps,
        "diskPct": disk_pct, "diskUsedGB": disk_used_gb, "diskTotalGB": disk_total_gb,
        "diskReadBps": disk_read_bps, "diskWriteBps": disk_write_bps,
        "raw": { "cpuTotal": cpu_total, "cpuIdle": cpu_idle, "rx": if has_net { json!(rx) } else { json!(null) }, "tx": if has_net { json!(tx) } else { json!(null) }, "sectorsR": if has_disk { json!(sectors_r) } else { json!(null) }, "sectorsW": if has_disk { json!(sectors_w) } else { json!(null) } }
    })
}

fn quick_match(text: &str, word: &str) -> bool {
    for line in text.lines() {
        if let Some(rest) = line.strip_prefix(word) {
            if rest.starts_with(' ') && rest.trim_start().starts_with(|c: char| c.is_ascii_digit()) {
                return true;
            }
        }
    }
    false
}

fn kb(text: &str, key: &str) -> Option<u64> {
    for line in text.lines() {
        if let Some(rest) = line.strip_prefix(key) {
            let rest = rest.trim_start().strip_prefix(':').unwrap_or(rest.trim_start());
            if let Some(first) = rest.split_whitespace().next() {
                if let Ok(n) = first.parse::<u64>() {
                    return Some(n);
                }
            }
        }
    }
    None
}
