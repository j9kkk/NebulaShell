// 服务器资源监控:/proc (Linux)、Darwin (macOS) 与 Windows (CIM/WMI) 探测解析
use serde_json::{json, Value};

pub const PROBE: &str = "case $(uname -s 2>/dev/null) in \
Darwin) \
echo __NB_OS_DARWIN__; \
sysctl -n hw.logicalcpu hw.memsize 2>/dev/null; \
echo __NB_SEC__; \
ps -A -o %cpu 2>/dev/null; \
echo __NB_SEC__; \
vm_stat 2>/dev/null; \
echo __NB_SEC__; \
df -kP /System/Volumes/Data / 2>/dev/null; \
echo __NB_SEC__; \
netstat -ibn 2>/dev/null; \
echo __NB_SEC__; \
ioreg -c IOBlockStorageDriver -r -w0 2>/dev/null | grep '\"Statistics\"'; \
;; \
*) \
cat /proc/stat /proc/meminfo /proc/net/dev /proc/diskstats 2>/dev/null; \
df -kP / 2>/dev/null | tail -1; \
;; \
esac; echo __NB_DONE__";

/// Windows OpenSSH 监控探针（兼容 cmd.exe 与 PowerShell 默认 Shell）：
/// 单次拉起无 Profile PowerShell，并行读取 Win32_Processor、Win32_OperatingSystem、
/// Win32_LogicalDisk(DriveType=3)、Win32_PerfRawData_Tcpip_NetworkInterface 与
/// Win32_PerfRawData_PerfDisk_PhysicalDisk(_Total)。
pub const WIN_PROBE: &str = "powershell -NoLogo -NoProfile -NonInteractive -Command \"$ErrorActionPreference='SilentlyContinue'; Write-Output '__NB_OS_WINDOWS__'; $cpu=(Get-CimInstance Win32_Processor | Measure-Object -Property LoadPercentage -Average).Average; $os=Get-CimInstance Win32_OperatingSystem; Write-Output ('CPU=' + $cpu); Write-Output ('MEM=' + $os.TotalVisibleMemorySize + '|' + $os.FreePhysicalMemory); Write-Output '__NB_SEC__'; Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3' | ForEach-Object { Write-Output ($_.DeviceID + '|' + $_.Size + '|' + $_.FreeSpace) }; Write-Output '__NB_SEC__'; $rx=0; $tx=0; Get-CimInstance Win32_PerfRawData_Tcpip_NetworkInterface | Where-Object { $_.Name -notmatch 'Loopback|isatap|Teredo' } | ForEach-Object { $rx += [int64]$_.BytesReceivedPersec; $tx += [int64]$_.BytesSentPersec }; Write-Output ('NET=' + $rx + '|' + $tx); Write-Output '__NB_SEC__'; $d=Get-CimInstance Win32_PerfRawData_PerfDisk_PhysicalDisk -Filter \\\"Name='_Total'\\\"; if($d){ Write-Output ('DISKIO=' + $d.DiskReadBytesPersec + '|' + $d.DiskWriteBytesPersec) }; Write-Output '__NB_DONE__'\"";

pub fn parse_proc(text: &str, prev: Option<&Value>, interval_sec: f64) -> Value {
    let sections = text.split("__NB_DONE__").next().unwrap_or("");
    if let Some(win_body) = sections.strip_prefix("__NB_OS_WINDOWS__") {
        return parse_windows(win_body.trim_start(), prev, interval_sec);
    }
    if let Some((_, win_body)) = sections.split_once("__NB_OS_WINDOWS__\n") {
        return parse_windows(win_body, prev, interval_sec);
    }
    if let Some((_, win_body)) = sections.split_once("__NB_OS_WINDOWS__\r\n") {
        return parse_windows(win_body, prev, interval_sec);
    }
    if let Some(darwin_body) = sections.strip_prefix("__NB_OS_DARWIN__") {
        return parse_darwin(darwin_body.trim_start(), prev, interval_sec);
    }
    if let Some((_, darwin_body)) = sections.split_once("__NB_OS_DARWIN__\n") {
        return parse_darwin(darwin_body, prev, interval_sec);
    }
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
        if sum > 0 {
            Some(sum)
        } else {
            None
        }
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
            Some(
                tx.saturating_sub(prev.and_then(|p| p["tx"].as_u64()).unwrap_or(0)) as f64
                    / interval_sec,
            ),
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
            disk_total_gb = f[1]
                .parse::<f64>()
                .ok()
                .map(|v| (v / 1024.0 / 1024.0 * 10.0).round() / 10.0);
            disk_used_gb = f[2]
                .parse::<f64>()
                .ok()
                .map(|v| (v / 1024.0 / 1024.0 * 10.0).round() / 10.0);
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
    let (disk_read_bps, disk_write_bps) =
        match (has_disk, prev.and_then(|p| p["sectorsR"].as_u64())) {
            (true, Some(pr)) => (
                Some(sectors_r.saturating_sub(pr) as f64 * 512.0 / interval_sec),
                Some(
                    sectors_w.saturating_sub(prev.and_then(|p| p["sectorsW"].as_u64()).unwrap_or(0))
                        as f64
                        * 512.0
                        / interval_sec,
                ),
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
            if rest.starts_with(' ') && rest.trim_start().starts_with(|c: char| c.is_ascii_digit())
            {
                return true;
            }
        }
    }
    false
}

fn kb(text: &str, key: &str) -> Option<u64> {
    for line in text.lines() {
        if let Some(rest) = line.strip_prefix(key) {
            let rest = rest
                .trim_start()
                .strip_prefix(':')
                .unwrap_or(rest.trim_start());
            if let Some(first) = rest.split_whitespace().next() {
                if let Ok(n) = first.parse::<u64>() {
                    return Some(n);
                }
            }
        }
    }
    None
}

fn parse_darwin(body: &str, prev: Option<&Value>, interval_sec: f64) -> Value {
    let parts: Vec<&str> = body.split("__NB_SEC__").collect();
    if parts.len() < 3 {
        return json!({ "supported": false });
    }

    // 1. sysctl: hw.logicalcpu 与 hw.memsize (Bytes)
    let sysctl_nums: Vec<u64> = parts[0]
        .lines()
        .filter_map(|l| l.trim().parse::<u64>().ok())
        .collect();
    let logical_cpu = sysctl_nums.first().copied().unwrap_or(0);
    let mem_total_bytes = sysctl_nums.get(1).copied().unwrap_or(0);
    if logical_cpu == 0 || mem_total_bytes == 0 {
        return json!({ "supported": false });
    }

    // 2. CPU: ps -A -o %cpu 累加除以逻辑核数
    let mut cpu_sum = 0.0f64;
    let mut has_cpu = false;
    for line in parts[1].lines() {
        let s = line.trim().replace(',', ".");
        if s.is_empty() || s.eq_ignore_ascii_case("%cpu") {
            continue;
        }
        if let Ok(v) = s.parse::<f64>() {
            cpu_sum += v;
            has_cpu = true;
        }
    }
    if !has_cpu {
        return json!({ "supported": false });
    }
    let cpu_pct = Some(((cpu_sum / logical_cpu as f64).clamp(0.0, 100.0) * 10.0).round() / 10.0);

    // 3. 内存: vm_stat 页大小与各状态页数
    let vm_text = parts[2];
    let page_size = parse_vm_page_size(vm_text).unwrap_or(4096);
    let pages_anon = vm_pages(vm_text, "Anonymous pages");
    let pages_wired = vm_pages(vm_text, "Pages wired down");
    let pages_comp = vm_pages(vm_text, "Pages occupied by compressor").unwrap_or(0);
    let pages_active = vm_pages(vm_text, "Pages active");

    let used_pages = match (pages_anon, pages_wired) {
        (Some(anon), Some(wired)) => Some(anon + wired + pages_comp),
        (None, Some(wired)) => pages_active.map(|act| act + wired + pages_comp),
        _ => None,
    };

    let (mem_pct, mem_used_mb, mem_total_mb) = match used_pages {
        Some(up) => {
            let used_bytes = (up.saturating_mul(page_size)).min(mem_total_bytes);
            let total_mb = mem_total_bytes / 1024 / 1024;
            let used_mb = used_bytes / 1024 / 1024;
            let pct = ((used_bytes as f64 / mem_total_bytes as f64) * 1000.0).round() / 10.0;
            (Some(pct.clamp(0.0, 100.0)), Some(used_mb), Some(total_mb))
        }
        None => return json!({ "supported": false }),
    };

    // 4. 磁盘容量: 优先 /System/Volumes/Data (APFS 数据卷)，回退 /
    let mut disk_pct = None;
    let mut disk_used_gb = None;
    let mut disk_total_gb = None;
    if let Some(df_text) = parts.get(3) {
        let mut target_cols: Option<Vec<&str>> = None;
        for line in df_text.lines() {
            let f: Vec<&str> = line.split_whitespace().collect();
            if f.len() >= 6 && f[4].ends_with('%') && f[0] != "Filesystem" {
                let mount = f[5];
                if mount == "/System/Volumes/Data" {
                    target_cols = Some(f);
                    break;
                } else if mount == "/" && target_cols.is_none() {
                    target_cols = Some(f);
                }
            }
        }
        if let Some(f) = target_cols {
            let total_kb = f[1].parse::<f64>().ok();
            let used_col_kb = f[2].parse::<f64>().ok();
            let avail_kb = f[3].parse::<f64>().ok();
            if let (Some(total), Some(avail)) = (total_kb, avail_kb) {
                if total > 0.0 {
                    // APFS 容器多宗卷共享空间:根卷与 Data 卷的 Used 各自独立，
                    // total - avail 才能反映整个容器已被占用的真实空间。
                    let used = (total - avail)
                        .max(used_col_kb.unwrap_or(0.0))
                        .clamp(0.0, total);
                    disk_total_gb = Some((total / 1024.0 / 1024.0 * 10.0).round() / 10.0);
                    disk_used_gb = Some((used / 1024.0 / 1024.0 * 10.0).round() / 10.0);
                    disk_pct = Some(((used / total) * 1000.0).round() / 10.0);
                }
            }
        }
    }

    // 5. 网络速率: netstat -ibn 仅取 <Link# 链路层行并排除 lo*
    let mut rx: u64 = 0;
    let mut tx: u64 = 0;
    let mut has_net = false;
    if let Some(net_text) = parts.get(4) {
        for line in net_text.lines() {
            if !line.contains("<Link#") {
                continue;
            }
            let f: Vec<&str> = line.split_whitespace().collect();
            if f.len() < 7 {
                continue;
            }
            let iface = f[0];
            if iface.starts_with("lo") {
                continue;
            }
            // netstat -ibn 列尾固定为: Ipkts Ierrs Ibytes Opkts Oerrs Obytes Coll
            let ibytes_idx = f.len() - 5;
            let obytes_idx = f.len() - 2;
            if let (Ok(ib), Ok(ob)) = (f[ibytes_idx].parse::<u64>(), f[obytes_idx].parse::<u64>()) {
                rx = rx.saturating_add(ib);
                tx = tx.saturating_add(ob);
                has_net = true;
            }
        }
    }
    let (rx_bps, tx_bps) = match (has_net, prev.and_then(|p| p["rx"].as_u64())) {
        (true, Some(prev_rx)) => (
            Some(rx.saturating_sub(prev_rx) as f64 / interval_sec),
            Some(
                tx.saturating_sub(prev.and_then(|p| p["tx"].as_u64()).unwrap_or(0)) as f64
                    / interval_sec,
            ),
        ),
        _ => (None, None),
    };

    // 6. 磁盘 IO 速率: ioreg IOBlockStorageDriver Statistics Bytes (Read)/(Write)
    let mut disk_r_bytes: u64 = 0;
    let mut disk_w_bytes: u64 = 0;
    let mut has_disk = false;
    if let Some(io_text) = parts.get(5) {
        for line in io_text.lines() {
            let r = extract_ioreg_stat(line, "\"Bytes (Read)\"=");
            let w = extract_ioreg_stat(line, "\"Bytes (Write)\"=");
            if r.is_some() || w.is_some() {
                disk_r_bytes = disk_r_bytes.saturating_add(r.unwrap_or(0));
                disk_w_bytes = disk_w_bytes.saturating_add(w.unwrap_or(0));
                has_disk = true;
            }
        }
    }
    let (disk_read_bps, disk_write_bps) =
        match (has_disk, prev.and_then(|p| p["diskRBytes"].as_u64())) {
            (true, Some(pr)) => (
                Some(disk_r_bytes.saturating_sub(pr) as f64 / interval_sec),
                Some(
                    disk_w_bytes
                        .saturating_sub(prev.and_then(|p| p["diskWBytes"].as_u64()).unwrap_or(0))
                        as f64
                        / interval_sec,
                ),
            ),
            _ => (None, None),
        };

    json!({
        "supported": true,
        "cpuPct": cpu_pct,
        "memPct": mem_pct, "memUsedMB": mem_used_mb, "memTotalMB": mem_total_mb,
        "rxBps": rx_bps, "txBps": tx_bps,
        "diskPct": disk_pct, "diskUsedGB": disk_used_gb, "diskTotalGB": disk_total_gb,
        "diskReadBps": disk_read_bps, "diskWriteBps": disk_write_bps,
        "raw": {
            "rx": if has_net { json!(rx) } else { json!(null) },
            "tx": if has_net { json!(tx) } else { json!(null) },
            "diskRBytes": if has_disk { json!(disk_r_bytes) } else { json!(null) },
            "diskWBytes": if has_disk { json!(disk_w_bytes) } else { json!(null) }
        }
    })
}

fn parse_vm_page_size(text: &str) -> Option<u64> {
    let first_line = text.lines().map(str::trim).find(|l| !l.is_empty())?;
    let (_, after) = first_line.split_once("page size of ")?;
    let num_str = after.split_whitespace().next()?;
    num_str.parse::<u64>().ok()
}

fn vm_pages(text: &str, key: &str) -> Option<u64> {
    for line in text.lines() {
        let trimmed = line.trim_start();
        if let Some(rest) = trimmed.strip_prefix(key) {
            let rest = rest
                .trim_start()
                .strip_prefix(':')
                .unwrap_or(rest.trim_start());
            if let Some(first) = rest.split_whitespace().next() {
                let clean = first.trim_end_matches('.');
                if let Ok(n) = clean.parse::<u64>() {
                    return Some(n);
                }
            }
        }
    }
    None
}

fn extract_ioreg_stat(line: &str, marker: &str) -> Option<u64> {
    let (_, after) = line.split_once(marker)?;
    let digits: String = after.chars().take_while(|c| c.is_ascii_digit()).collect();
    if digits.is_empty() {
        None
    } else {
        digits.parse::<u64>().ok()
    }
}

fn parse_windows(body: &str, prev: Option<&Value>, interval_sec: f64) -> Value {
    let parts: Vec<&str> = body.split("__NB_SEC__").collect();
    if parts.is_empty() {
        return json!({ "supported": false });
    }

    let mut cpu_pct: Option<f64> = None;
    let mut mem_total_kb: Option<u64> = None;
    let mut mem_free_kb: Option<u64> = None;

    for line in parts[0].lines() {
        let l = line.trim();
        if let Some(v) = l.strip_prefix("CPU=") {
            let clean = v.trim().replace(',', ".");
            if let Ok(val) = clean.parse::<f64>() {
                cpu_pct = Some((val.clamp(0.0, 100.0) * 10.0).round() / 10.0);
            }
        } else if let Some(v) = l.strip_prefix("MEM=") {
            let mut sp = v.split('|');
            mem_total_kb = sp.next().and_then(|s| s.trim().parse::<u64>().ok());
            mem_free_kb = sp.next().and_then(|s| s.trim().parse::<u64>().ok());
        }
    }

    let (Some(total_kb), Some(free_kb)) = (mem_total_kb, mem_free_kb) else {
        return json!({ "supported": false });
    };
    if total_kb == 0 {
        return json!({ "supported": false });
    }
    let used_kb = total_kb.saturating_sub(free_kb);
    let mem_total_mb = Some(total_kb / 1024);
    let mem_used_mb = Some(used_kb / 1024);
    let mem_pct = Some(((used_kb as f64 / total_kb as f64) * 1000.0).round() / 10.0);

    // 2. 磁盘容量：优先 C: 盘，若无 C: 则取第一个固定磁盘，同时输出 drives 列表
    let mut disk_pct = None;
    let mut disk_used_gb = None;
    let mut disk_total_gb = None;
    let mut drives = Vec::new();
    if let Some(disk_text) = parts.get(1) {
        for line in disk_text.lines() {
            let cols: Vec<&str> = line.trim().split('|').collect();
            if cols.len() >= 3 {
                let dev = cols[0].trim().to_ascii_uppercase();
                let size_b = cols[1].trim().parse::<u64>().unwrap_or(0);
                let free_b = cols[2].trim().parse::<u64>().unwrap_or(0);
                if size_b == 0 {
                    continue;
                }
                let used_b = size_b.saturating_sub(free_b);
                let total_gb = ((size_b as f64 / 1073741824.0) * 10.0).round() / 10.0;
                let used_gb = ((used_b as f64 / 1073741824.0) * 10.0).round() / 10.0;
                let pct = ((used_b as f64 / size_b as f64) * 1000.0).round() / 10.0;
                if dev == "C:" || disk_pct.is_none() {
                    disk_pct = Some(pct);
                    disk_used_gb = Some(used_gb);
                    disk_total_gb = Some(total_gb);
                }
                drives.push(json!({
                    "name": dev,
                    "totalGB": total_gb,
                    "usedGB": used_gb,
                    "pct": pct,
                }));
            }
        }
    }

    // 3. 网络吞吐差分
    let mut rx = 0u64;
    let mut tx = 0u64;
    let mut has_net = false;
    if let Some(net_text) = parts.get(2) {
        for line in net_text.lines() {
            if let Some(rest) = line.trim().strip_prefix("NET=") {
                let mut sp = rest.split('|');
                if let (Some(r), Some(t)) = (
                    sp.next().and_then(|s| s.trim().parse::<u64>().ok()),
                    sp.next().and_then(|s| s.trim().parse::<u64>().ok()),
                ) {
                    rx = r;
                    tx = t;
                    has_net = true;
                }
            }
        }
    }
    let (rx_bps, tx_bps) = match (has_net, prev.and_then(|p| p["rx"].as_u64())) {
        (true, Some(prev_rx)) => (
            Some(rx.saturating_sub(prev_rx) as f64 / interval_sec),
            Some(
                tx.saturating_sub(prev.and_then(|p| p["tx"].as_u64()).unwrap_or(0)) as f64
                    / interval_sec,
            ),
        ),
        _ => (None, None),
    };

    // 4. 磁盘 IO 差分
    let mut disk_r_bytes = 0u64;
    let mut disk_w_bytes = 0u64;
    let mut has_disk = false;
    if let Some(io_text) = parts.get(3) {
        for line in io_text.lines() {
            if let Some(rest) = line.trim().strip_prefix("DISKIO=") {
                let mut sp = rest.split('|');
                if let (Some(r), Some(w)) = (
                    sp.next().and_then(|s| s.trim().parse::<u64>().ok()),
                    sp.next().and_then(|s| s.trim().parse::<u64>().ok()),
                ) {
                    disk_r_bytes = r;
                    disk_w_bytes = w;
                    has_disk = true;
                }
            }
        }
    }
    let (disk_read_bps, disk_write_bps) =
        match (has_disk, prev.and_then(|p| p["diskRBytes"].as_u64())) {
            (true, Some(pr)) => (
                Some(disk_r_bytes.saturating_sub(pr) as f64 / interval_sec),
                Some(
                    disk_w_bytes
                        .saturating_sub(prev.and_then(|p| p["diskWBytes"].as_u64()).unwrap_or(0))
                        as f64
                        / interval_sec,
                ),
            ),
            _ => (None, None),
        };

    json!({
        "supported": true,
        "os": "windows",
        "cpuPct": cpu_pct,
        "memPct": mem_pct, "memUsedMB": mem_used_mb, "memTotalMB": mem_total_mb,
        "rxBps": rx_bps, "txBps": tx_bps,
        "diskPct": disk_pct, "diskUsedGB": disk_used_gb, "diskTotalGB": disk_total_gb,
        "diskReadBps": disk_read_bps, "diskWriteBps": disk_write_bps,
        "drives": drives,
        "raw": {
            "rx": if has_net { json!(rx) } else { json!(null) },
            "tx": if has_net { json!(tx) } else { json!(null) },
            "diskRBytes": if has_disk { json!(disk_r_bytes) } else { json!(null) },
            "diskWBytes": if has_disk { json!(disk_w_bytes) } else { json!(null) }
        }
    })
}
