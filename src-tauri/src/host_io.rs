//! 主机导入文件的解析与校验。
//!
//! 导入失败必须可解释:用户要能看到「第 X 行、字段 Y、原因 Z」,而不是一句
//! 「导入失败」。这一层只做纯文本/JSON 处理,不碰 Store,方便单测。
//!
//! 三条硬规则:
//! 1. 编码:UTF-8(可带 BOM)/ UTF-16 LE / UTF-16 BE 都能读;其它编码给出明确提示。
//! 2. 上限:单文件 16 MiB、单次 10000 台。超限直接拒绝并说明大小/数量,不做半截导入。
//! 3. 全量回滚:任何一行不合法就整份文件不写盘,并一次性列出所有问题行。
use serde_json::Value;
use std::collections::HashMap;

/// 单次导入文件字节上限(导出 10000 台主机约 3–5 MB,16 MiB 留足余量)。
pub const MAX_IMPORT_BYTES: usize = 16 * 1024 * 1024;
/// 单次导入主机数量上限。
pub const MAX_IMPORT_HOSTS: usize = 10_000;

#[derive(Debug, Clone)]
pub struct ImportIssue {
    /// 1-based 记录序号;0 表示文件级问题(空文件、超限等)。
    pub record: usize,
    /// 1-based 行号;压缩成一行的 JSON 无法区分时退化为 None。
    pub line: Option<usize>,
    pub field: &'static str,
    pub reason: String,
}

impl ImportIssue {
    fn row(
        record: usize,
        line: Option<usize>,
        field: &'static str,
        reason: impl Into<String>,
    ) -> Self {
        Self {
            record,
            line,
            field,
            reason: reason.into(),
        }
    }

    fn file(field: &'static str, reason: impl Into<String>) -> Self {
        Self {
            record: 0,
            line: None,
            field,
            reason: reason.into(),
        }
    }

    fn locate(&self) -> String {
        match (self.record, self.line) {
            (0, _) => "文件级".to_string(),
            (r, Some(l)) => format!("第 {} 行（第 {} 台）", l, r),
            (r, None) => format!("第 {} 台", r),
        }
    }
}

/// 去掉 UTF-8 BOM。BOM 会让 serde_json 在「第 1 行第 1 列」报错,
/// 而 Windows 记事本另存为 UTF-8 时默认带 BOM —— 必须兼容。
pub fn strip_bom(text: &str) -> &str {
    text.strip_prefix('\u{feff}').unwrap_or(text)
}

pub fn too_large_error(bytes: usize) -> String {
    format!(
        "导入文件过大（{:.1} MB），单次上限 {} MB，请拆分文件后分批导入",
        bytes as f64 / (1024.0 * 1024.0),
        MAX_IMPORT_BYTES / (1024 * 1024)
    )
}

/// 把读到的字节解码成文本,所有失败都带可执行的原因。
pub fn decode_import_bytes(path: &str, bytes: &[u8]) -> Result<String, String> {
    if bytes.len() > MAX_IMPORT_BYTES {
        return Err(too_large_error(bytes.len()));
    }
    if bytes.starts_with(&[0xFF, 0xFE]) {
        return decode_utf16(path, &bytes[2..], true);
    }
    if bytes.starts_with(&[0xFE, 0xFF]) {
        return decode_utf16(path, &bytes[2..], false);
    }
    let text = std::str::from_utf8(bytes).map_err(|e| {
        format!(
            "文件「{}」不是 UTF-8 编码（第 {} 字节无法解码），请另存为 UTF-8 或 UTF-16 后重试",
            file_name(path),
            e.valid_up_to() + 1
        )
    })?;
    Ok(strip_bom(text).to_string())
}

fn decode_utf16(path: &str, bytes: &[u8], little_endian: bool) -> Result<String, String> {
    if bytes.len() % 2 != 0 {
        return Err(format!(
            "文件「{}」是 UTF-16 编码但字节数为奇数，文件可能已损坏",
            file_name(path)
        ));
    }
    let units: Vec<u16> = bytes
        .chunks_exact(2)
        .map(|pair| {
            if little_endian {
                u16::from_le_bytes([pair[0], pair[1]])
            } else {
                u16::from_be_bytes([pair[0], pair[1]])
            }
        })
        .collect();
    String::from_utf16(&units)
        .map(|s| strip_bom(&s).to_string())
        .map_err(|_| {
            format!(
                "文件「{}」的 UTF-16 内容包含无效字符，文件可能已损坏",
                file_name(path)
            )
        })
}

fn file_name(path: &str) -> String {
    std::path::Path::new(path)
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| path.to_string())
}

/// 读取并解码导入文件。先看文件大小,避免把超大文件整个读进内存。
pub fn read_import_file(path: &str) -> Result<String, String> {
    let resolved = match path.strip_prefix("~/") {
        Some(rest) => dirs::home_dir()
            .map(|home| home.join(rest))
            .unwrap_or_else(|| std::path::PathBuf::from(path)),
        None => std::path::PathBuf::from(path),
    };
    let meta = std::fs::metadata(&resolved).map_err(|e| match e.kind() {
        std::io::ErrorKind::NotFound => format!("导入文件不存在：{}", path),
        std::io::ErrorKind::PermissionDenied => format!("没有读取该文件的权限：{}", path),
        _ => format!("无法读取导入文件「{}」：{}", path, e),
    })?;
    if meta.is_dir() {
        return Err(format!("选择的路径是文件夹，不是导入文件：{}", path));
    }
    if meta.len() > MAX_IMPORT_BYTES as u64 {
        return Err(too_large_error(meta.len() as usize));
    }
    let bytes =
        std::fs::read(&resolved).map_err(|e| format!("读取导入文件「{}」失败：{}", path, e))?;
    decode_import_bytes(path, &bytes)
}

/// JSON 语法错误:serde 自带行列,之前被整句丢掉,用户只看到「文件不是合法 JSON」。
pub fn json_error_message(err: &serde_json::Error) -> String {
    let raw = err.to_string();
    // serde 的 message 末尾带「 at line L column C」,外层已经给了中文行列,去掉避免重复。
    let detail = raw.split(" at line ").next().unwrap_or(&raw).trim();
    format!(
        "文件不是合法 JSON：第 {} 行第 {} 列：{}",
        err.line(),
        err.column(),
        detail
    )
}

/// 把一批问题渲染成给用户看的错误串。最多列 12 条,其余折成计数。
pub fn format_issues(issues: &[ImportIssue]) -> String {
    const MAX_SHOW: usize = 12;
    let mut out = format!(
        "导入文件校验失败（共 {} 处问题），已全部回滚，未写入任何主机：",
        issues.len()
    );
    for (i, issue) in issues.iter().take(MAX_SHOW).enumerate() {
        out.push('\n');
        out.push_str(&format!(
            "{}. {} · 字段 {}：{}",
            i + 1,
            issue.locate(),
            issue.field,
            issue.reason
        ));
    }
    if issues.len() > MAX_SHOW {
        out.push_str(&format!(
            "\n…另有 {} 处问题未显示，请修正后再导入",
            issues.len() - MAX_SHOW
        ));
    }
    out
}

/// 校验主机列表。`text` 用于把记录序号映射回文件行号。
pub fn validate_items(text: &str, items: &[Value], version: u64) -> Vec<ImportIssue> {
    let lines = item_lines(text);
    let mut issues = Vec::new();

    if items.is_empty() {
        issues.push(ImportIssue::file(
            "hosts",
            "文件里没有主机记录（hosts 为空），没有可导入的内容",
        ));
        return issues;
    }
    if items.len() > MAX_IMPORT_HOSTS {
        issues.push(ImportIssue::file(
            "hosts",
            format!(
                "文件包含 {} 台主机，超过单次导入上限 {} 台，请拆分后分批导入",
                items.len(),
                MAX_IMPORT_HOSTS
            ),
        ));
        return issues;
    }

    let mut seen_ids: HashMap<String, (usize, Option<usize>)> = HashMap::new();
    let mut seen_endpoints: HashMap<String, (usize, Option<usize>, String)> = HashMap::new();
    let mut seen_clouds: HashMap<String, (usize, Option<usize>, String)> = HashMap::new();
    // 跳板机引用集合先算一次,避免每行都遍历全表(10000 台时是 O(n²))。
    let known_ids: std::collections::HashSet<&str> = items
        .iter()
        .filter_map(|it| it["id"].as_str().filter(|s| !s.is_empty()))
        .collect();

    for (i, item) in items.iter().enumerate() {
        let record = i + 1;
        let line = lines.get(i).copied();
        let mut push = |field: &'static str, reason: String| {
            issues.push(ImportIssue::row(record, line, field, reason));
        };

        if !item.is_object() {
            push(
                "主机记录",
                "必须是 JSON 对象（形如 {\"host\": \"10.0.0.1\"}）".to_string(),
            );
            continue;
        }

        // ---- 必填与格式 ----
        match item["host"].as_str() {
            None if item["host"].is_null() => push("host", "缺少主机地址".to_string()),
            None => push("host", "主机地址必须是字符串".to_string()),
            Some(raw) => {
                let host = raw.trim();
                if host.is_empty() {
                    push("host", "主机地址不能为空".to_string());
                } else if host.chars().any(|c| c.is_whitespace() || c.is_control()) {
                    push("host", format!("主机地址不能包含空格或控制字符：{:?}", raw));
                } else if host.chars().count() > 255 {
                    push("host", "主机地址过长（上限 255 个字符）".to_string());
                }
            }
        }

        if !item["port"].is_null() {
            match item["port"].as_i64() {
                Some(p) if (1..=65535).contains(&p) => {}
                Some(p) => push("port", format!("端口必须在 1–65535 之间，当前为 {}", p)),
                None => push("port", "端口必须是 1–65535 的整数".to_string()),
            }
        }

        if !item["username"].is_null() {
            match item["username"].as_str() {
                None => push("username", "用户名必须是字符串".to_string()),
                Some(u) if u.trim().is_empty() => push("username", "用户名不能为空".to_string()),
                Some(u) if u.chars().any(|c| c.is_whitespace() || c.is_control()) => {
                    push("username", "用户名不能包含空格或控制字符".to_string())
                }
                Some(u) if u.chars().count() > 64 => {
                    push("username", "用户名过长（上限 64 个字符）".to_string())
                }
                Some(_) => {}
            }
        }

        if !item["name"].is_null() {
            match item["name"].as_str() {
                None => push("name", "名称必须是字符串".to_string()),
                Some(n) if n.trim().is_empty() => {
                    push("name", "名称不能为空（留空会回退成主机地址）".to_string())
                }
                Some(n) if n.chars().count() > 128 => {
                    push("name", "名称过长（上限 128 个字符）".to_string())
                }
                Some(_) => {}
            }
        }

        if !item["authType"].is_null() {
            match item["authType"].as_str() {
                Some("password") | Some("key") => {}
                Some(other) => push(
                    "authType",
                    format!("认证方式只能是 password 或 key，当前为 {}", other),
                ),
                None => push("authType", "认证方式必须是字符串".to_string()),
            }
        }

        if !item["sessionLog"].is_null() {
            match item["sessionLog"].as_str() {
                Some("default") | Some("always") | Some("never") => {}
                Some(other) => push(
                    "sessionLog",
                    format!("会话日志只能是 default / always / never，当前为 {}", other),
                ),
                None => push("sessionLog", "会话日志设置必须是字符串".to_string()),
            }
        }

        if !item["aiAccess"].is_null() {
            match item["aiAccess"].as_str() {
                Some("default") | Some("manual") | Some("deny") => {}
                Some(other) => push(
                    "aiAccess",
                    format!(
                        "AI 访问策略只能是 default / manual / deny，当前为 {}",
                        other
                    ),
                ),
                None => push("aiAccess", "AI 访问策略必须是字符串".to_string()),
            }
        }

        if !item["tags"].is_null() {
            match item["tags"].as_array() {
                None => push("tags", "标签必须是字符串数组".to_string()),
                Some(tags) if tags.len() > 50 => {
                    push("tags", "标签数量过多（上限 50 个）".to_string())
                }
                Some(tags) => {
                    for (k, tag) in tags.iter().enumerate() {
                        match tag.as_str() {
                            Some(t) if !t.trim().is_empty() && t.chars().count() <= 64 => {}
                            _ => push(
                                "tags",
                                format!("第 {} 个标签为空、不是字符串或超过 64 个字符", k + 1),
                            ),
                        }
                    }
                }
            }
        }

        for field in ["password", "privateKey", "passphrase"] {
            if !item[field].is_null() && !item[field].is_string() {
                push(
                    if field == "password" {
                        "password"
                    } else if field == "privateKey" {
                        "privateKey"
                    } else {
                        "passphrase"
                    },
                    "凭据字段必须是字符串".to_string(),
                );
            }
        }

        if !item["cloud"].is_null() {
            if !item["cloud"].is_object() {
                push("cloud", "云主机身份必须是对象或 null".to_string());
            } else {
                let provider = item["cloud"]["provider"].as_str().unwrap_or("").trim();
                let instance = item["cloud"]["instanceId"].as_str().unwrap_or("").trim();
                if provider.is_empty() != instance.is_empty() {
                    push(
                        "cloud",
                        "云主机身份需要 provider 与 instanceId 同时提供".to_string(),
                    );
                }
            }
        }

        // ---- 主机 ID ----
        let id = item["id"].as_str().filter(|s| !s.is_empty());
        if version >= 3 && id.is_none() {
            push(
                "id",
                "缺少主机 ID（v3 及以上的导出文件必须带 id）".to_string(),
            );
        }
        if let Some(id) = id {
            if let Some((prev, prev_line)) = seen_ids.get(id) {
                push(
                    "id",
                    format!(
                        "与{}的主机 ID 重复：{}",
                        location_text(*prev, *prev_line),
                        id
                    ),
                );
            } else {
                seen_ids.insert(id.to_string(), (record, line));
            }
        }

        // ---- 文件内重复条目 ----
        // 只有「同一端点 + 可见配置完全一致」才算重复(同一台机器配两份不同用途的主机
        // 是合法的,v3 往返测试里就有 jump/target 共用端点)。不同 id 但配置一模一样的
        // 两行,基本只会来自两份导出文件相加,落库就是脏数据。
        if let Some(dup_key) = duplicate_key(item) {
            if let Some((prev, prev_line, display)) = seen_endpoints.get(&dup_key) {
                push(
                    "host",
                    format!(
                        "与{}重复：同一主机 {} 的同名同配置记录",
                        location_text(*prev, *prev_line),
                        display
                    ),
                );
            } else {
                seen_endpoints.insert(dup_key, (record, line, endpoint_display(item)));
            }
        }
        if let Some(cloud) = cloud_key(item) {
            if let Some((prev, prev_line, display)) = seen_clouds.get(&cloud) {
                push(
                    "cloud",
                    format!(
                        "与{}重复：同一云实例 {}",
                        location_text(*prev, *prev_line),
                        display
                    ),
                );
            } else {
                seen_clouds.insert(cloud, (record, line, cloud_display(item)));
            }
        }

        // ---- 跳板机引用 ----
        if !item["jumpIds"].is_null() {
            match item["jumpIds"].as_array() {
                None => push("jumpIds", "跳板机列表必须是字符串数组".to_string()),
                Some(jumps) if !jumps.is_empty() && version < 3 => push(
                    "jumpIds",
                    "旧版（v1/v2）文件没有主机 ID，无法解析跳板机引用".to_string(),
                ),
                Some(jumps) => {
                    for (k, jump) in jumps.iter().enumerate() {
                        match jump.as_str().filter(|s| !s.is_empty()) {
                            None => push(
                                "jumpIds",
                                format!("第 {} 个跳板机引用为空或不是字符串", k + 1),
                            ),
                            Some(j) if !known_ids.contains(j) => push(
                                "jumpIds",
                                format!("第 {} 个悬空跳板机引用：{} 不在导入文件中", k + 1, j),
                            ),
                            Some(_) => {}
                        }
                    }
                }
            }
        }
    }

    issues
}

fn location_text(record: usize, line: Option<usize>) -> String {
    match line {
        Some(l) => format!("第 {} 行（第 {} 台）", l, record),
        None => format!("第 {} 台", record),
    }
}

fn endpoint_key(item: &Value) -> Option<String> {
    let host = item["host"].as_str()?.trim().to_lowercase();
    if host.is_empty() {
        return None;
    }
    let port = item["port"].as_i64().unwrap_or(22);
    let user = item["username"]
        .as_str()
        .unwrap_or("root")
        .trim()
        .to_lowercase();
    Some(format!("{}:{}:{}", host, port, user))
}

fn endpoint_display(item: &Value) -> String {
    format!(
        "{}:{}/{}",
        item["host"].as_str().unwrap_or("").trim(),
        item["port"].as_i64().unwrap_or(22),
        item["username"].as_str().unwrap_or("root").trim()
    )
}

/// 重复判定键:端点 + 用户可见配置。名称/分组/标签不同视为有意保留的两份配置。
fn duplicate_key(item: &Value) -> Option<String> {
    let endpoint = endpoint_key(item)?;
    let list = |field: &str| -> String {
        let mut names: Vec<&str> = item[field]
            .as_array()
            .map(|items| items.iter().filter_map(|v| v.as_str()).collect())
            .unwrap_or_default();
        names.sort_unstable();
        names.join("\u{1f}")
    };
    Some(format!(
        "{}|{}|{}|{}|{}|{}|{}|{}|{}|{}|{}",
        endpoint,
        item["name"].as_str().unwrap_or("").trim(),
        item["group"].as_str().unwrap_or("").trim(),
        item["authType"].as_str().unwrap_or(""),
        item["keyPath"].as_str().unwrap_or(""),
        item["initcmd"].as_str().unwrap_or(""),
        list("tags"),
        item["sessionLog"].as_str().unwrap_or(""),
        item["aiAccess"].as_str().unwrap_or(""),
        list("jumpIds"),
        cloud_key(item).unwrap_or_default()
    ))
}

fn cloud_key(item: &Value) -> Option<String> {
    let c = &item["cloud"];
    if !c.is_object() {
        return None;
    }
    let instance = c["instanceId"].as_str()?.trim();
    if instance.is_empty() {
        return None;
    }
    Some(format!(
        "{}|{}|{}|{}",
        c["provider"].as_str().unwrap_or("").trim().to_lowercase(),
        instance.to_lowercase(),
        c["accountId"].as_str().unwrap_or("").trim().to_lowercase(),
        c["region"].as_str().unwrap_or("").trim().to_lowercase()
    ))
}

fn cloud_display(item: &Value) -> String {
    let c = &item["cloud"];
    format!(
        "{} / {}",
        c["provider"].as_str().unwrap_or(""),
        c["instanceId"].as_str().unwrap_or("")
    )
}

/// 定位 `hosts` 数组(或根数组)里每条记录起始行,用于「第 X 行」反馈。
/// 找不到/数量对不上时返回空 Vec,调用方退化成「第 N 台」。
pub fn item_lines(text: &str) -> Vec<usize> {
    let Some(start) = hosts_array_start(text) else {
        return Vec::new();
    };
    let mut line = text[..start].matches('\n').count() + 1;
    let mut depth = 0i32;
    let mut in_str = false;
    let mut escaped = false;
    let mut expect_element = true;
    let mut lines = Vec::new();

    for ch in text[start..].chars() {
        if in_str {
            if escaped {
                escaped = false;
            } else if ch == '\\' {
                escaped = true;
            } else if ch == '"' {
                in_str = false;
            }
            if ch == '\n' {
                line += 1;
            }
            continue;
        }
        match ch {
            '"' => {
                if depth == 1 && expect_element {
                    lines.push(line);
                    expect_element = false;
                }
                in_str = true;
            }
            '{' | '[' => {
                if depth == 1 && expect_element {
                    lines.push(line);
                    expect_element = false;
                }
                depth += 1;
            }
            '}' => {
                if depth > 0 {
                    depth -= 1;
                }
            }
            ']' => {
                depth -= 1;
                if depth <= 0 {
                    break;
                }
            }
            ',' => {
                if depth == 1 {
                    expect_element = true;
                }
            }
            '\n' => line += 1,
            _ => {
                if depth == 1 && expect_element && !ch.is_whitespace() {
                    lines.push(line);
                    expect_element = false;
                }
            }
        }
    }
    lines
}

/// 返回 `hosts` 数组 `[` 的字节偏移:根数组直接返回,根对象则找顶层 "hosts" 键。
/// 按字节扫描(JSON 结构字符都是 ASCII,UTF-8 多字节序列里不会出现),避免为
/// 16 MiB 文件建一份 `Vec<(usize, char)>`。
fn hosts_array_start(text: &str) -> Option<usize> {
    let bytes = text.as_bytes();
    let mut i = 0usize;
    while i < bytes.len() && bytes[i].is_ascii_whitespace() {
        i += 1;
    }
    if i >= bytes.len() {
        return None;
    }
    if bytes[i] == b'[' {
        return Some(i);
    }
    if bytes[i] != b'{' {
        return None;
    }

    let mut depth = 1i32;
    i += 1;
    while i < bytes.len() {
        let byte = bytes[i];
        if byte == b'"' {
            // 整段跳过字符串,避免把字符串里的 { } [ ] 当成结构。
            let open = i;
            let mut j = i + 1;
            let mut escaped = false;
            while j < bytes.len() {
                let c = bytes[j];
                if escaped {
                    escaped = false;
                } else if c == b'\\' {
                    escaped = true;
                } else if c == b'"' {
                    break;
                }
                j += 1;
            }
            if j >= bytes.len() {
                return None;
            }
            if depth == 1 && &text[open + 1..j] == "hosts" {
                let mut k = j + 1;
                while k < bytes.len() && bytes[k].is_ascii_whitespace() {
                    k += 1;
                }
                if k < bytes.len() && bytes[k] == b':' {
                    k += 1;
                    while k < bytes.len() && bytes[k].is_ascii_whitespace() {
                        k += 1;
                    }
                    if k < bytes.len() && bytes[k] == b'[' {
                        return Some(k);
                    }
                }
            }
            i = j + 1;
            continue;
        }
        match byte {
            b'{' | b'[' => depth += 1,
            b'}' | b']' => depth -= 1,
            _ => {}
        }
        i += 1;
    }
    None
}
