// 配置存储:与 Electron 版 nebulashell-config.json 同构;敏感字段经 keyring(macOS Keychain)加密,
// keyring 不可用时回退 base64 'plain:' 前缀(与 Electron 版 fallback 行为一致)。
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::Mutex;

pub struct Store {
    pub dir: PathBuf,
    pub data: Mutex<Value>,
    pub use_keyring: bool,
    /// 是否有未落盘的变更(由后台去抖任务消费)
    dirty: std::sync::atomic::AtomicBool,
}

fn defaults() -> Value {
    json!({
        "version": 1,
        "hosts": [],
        "snippets": [],
        "forwards": [],
        "bookmarks": [],
        "history": [],
        "settings": {
            "ai": { "provider": "custom", "protocol": "openai", "baseUrl": "", "model": "", "models": [], "apiKey": "" },
            "terminal": { "fontSize": 13, "theme": "nebula", "scrollback": 2000 },
            // 文件「双击打开」临时副本的缓存根目录;空 = 默认(系统临时目录/NebulaShell-open)
            "openTempDir": "",
            "clouds": {
                "tencent": { "key": "", "secret": "", "endpoint": "" },
                "aliyun": { "key": "", "secret": "", "endpoint": "" }
            }
        },
        "knownHosts": {}
    })
}

// ===== 命令历史清洗 =====

/// 跳过 chars[i] 起的 ESC 序列,返回其后的位置。与前端 shared/term-text.js 的
/// stripTerminalNoise 覆盖同样的序列:CSI、OSC(BEL 或 ST 结尾)、DCS/SOS/PM/APC
/// (ST 结尾)、SS2/SS3 连同其后一个字符、字符集指定、其余两字节 ESC 序列。
fn skip_escape(chars: &[char], i: usize) -> usize {
    let n = chars.len();
    let st_end = |from: usize, bel: bool| {
        let mut j = from;
        while j < n {
            if bel && chars[j] == '\x07' {
                return j + 1;
            }
            if chars[j] == '\x1b' {
                return if chars.get(j + 1) == Some(&'\\') {
                    j + 2
                } else {
                    j
                };
            }
            j += 1;
        }
        n
    };
    let Some(&next) = chars.get(i + 1) else {
        return i + 1;
    };
    match next {
        '[' => {
            let mut j = i + 2;
            while j < n && ('\x30'..='\x3f').contains(&chars[j]) {
                j += 1;
            }
            while j < n && ('\x20'..='\x2f').contains(&chars[j]) {
                j += 1;
            }
            if j < n && ('\x40'..='\x7e').contains(&chars[j]) {
                j + 1
            } else {
                j
            }
        }
        ']' => st_end(i + 2, true),
        'P' | 'X' | '^' | '_' => st_end(i + 2, false),
        'N' | 'O' => match chars.get(i + 2) {
            Some(c) if *c != '\x1b' => i + 3,
            _ => i + 2,
        },
        '\x20'..='\x2f' => {
            let mut j = i + 2;
            while j < n && ('\x20'..='\x2f').contains(&chars[j]) {
                j += 1;
            }
            if j < n && ('\x30'..='\x7e').contains(&chars[j]) {
                j + 1
            } else {
                j
            }
        }
        '\x30'..='\x7e' => i + 2,
        _ => i + 1,
    }
}

/// 清洗一条命令历史:去控制序列;旧版采集把整串按键原样存下,这里按行编辑语义
/// 重放 Ctrl+C / Ctrl+G / Ctrl+U(丢弃此前内容)、Ctrl+W(删前一个词)与退格,
/// 保留换行与制表符,其余控制字符丢弃,最后去首尾空白。
pub fn clean_command(raw: &str) -> String {
    let chars: Vec<char> = raw.chars().collect();
    let mut out: Vec<char> = Vec::with_capacity(chars.len());
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        match c {
            '\x1b' => {
                i = skip_escape(&chars, i);
                continue;
            }
            '\x03' | '\x07' | '\x15' => out.clear(),
            '\x17' => {
                while out.last().is_some_and(|c| c.is_whitespace()) {
                    out.pop();
                }
                while out.last().is_some_and(|c| !c.is_whitespace()) {
                    out.pop();
                }
            }
            '\x08' | '\x7f' => {
                out.pop();
            }
            '\t' | '\n' => out.push(c),
            c if c < ' ' || ('\u{80}'..='\u{9f}').contains(&c) => {}
            c => out.push(c),
        }
        i += 1;
    }
    out.into_iter().collect::<String>().trim().to_string()
}

/// 清洗整份命令历史(数组按时间从旧到新):逐条 clean_command,丢掉空条目与非对象,
/// 同一命令只保留最新一条。幂等;返回是否有改动。
pub fn clean_history(history: &mut Vec<Value>) -> bool {
    let mut seen = std::collections::HashSet::new();
    let mut kept: Vec<Value> = Vec::with_capacity(history.len());
    for item in history.iter().rev() {
        let Some(raw) = item["cmd"].as_str() else {
            continue;
        };
        let cmd = clean_command(raw);
        if cmd.is_empty() || !seen.insert(cmd.clone()) {
            continue;
        }
        let mut item = item.clone();
        item["cmd"] = json!(cmd);
        kept.push(item);
    }
    kept.reverse();
    let changed = kept != *history;
    *history = kept;
    changed
}

// ===== 凭据加密 =====
// 设计取舍:不用 keyring 作为主存储。
// 原因:keyring 在未签名/无 entitlements 的 macOS 进程中 set_password+get_password 均返回 Ok,
// 但条目只存在于进程内的临时 keychain,进程结束即丢失 —— 表现为"密码保存成功却失效"。
// 改为:本地文件 AES-256-GCM 加密,密钥由 机器标识 + 用户 + 应用盐 经 HKDF 派生。
// 该方案无需系统授权、跨会话稳定、且密文与明文一样可随配置迁移(与 Electron 版 base64 回退同级,
// 但强度显著更高)。keyring 保留为可选增强:仅当显式设置 NEBULA_USE_KEYRING=1 时尝试。

fn machine_key_material() -> Vec<u8> {
    let mut material = Vec::new();
    material.extend_from_slice(b"nebulashell-v1");
    // 主机名
    if let Ok(h) = std::env::var("HOSTNAME").or_else(|_| std::env::var("COMPUTERNAME")) {
        material.extend_from_slice(h.as_bytes());
    }
    if let Ok(out) = std::process::Command::new("hostname").output() {
        material.extend_from_slice(&out.stdout);
    }
    // 用户名
    if let Ok(u) = std::env::var("USER").or_else(|_| std::env::var("USERNAME")) {
        material.extend_from_slice(u.as_bytes());
    }
    // 稳定路径(用户主目录)
    if let Some(home) = dirs::home_dir() {
        material.extend_from_slice(home.to_string_lossy().as_bytes());
    }
    material
}

fn derive_key() -> [u8; 32] {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(machine_key_material());
    hasher.update(b"credential-store-key");
    let d = hasher.finalize();
    let mut key = [0u8; 32];
    key.copy_from_slice(&d[..32]);
    key
}

fn aes_encrypt(plain: &str) -> Result<String, String> {
    use aes_gcm::aead::{Aead, KeyInit};
    use aes_gcm::{Aes256Gcm, Nonce};
    let key = derive_key();
    let cipher = Aes256Gcm::new_from_slice(&key).map_err(|e| e.to_string())?;
    let mut nonce_bytes = [0u8; 12];
    use rand::RngCore;
    rand::thread_rng().fill_bytes(&mut nonce_bytes);
    let nonce = Nonce::from_slice(&nonce_bytes);
    let ct = cipher
        .encrypt(nonce, plain.as_bytes())
        .map_err(|e| format!("加密失败: {}", e))?;
    use base64::Engine;
    let mut blob = nonce_bytes.to_vec();
    blob.extend_from_slice(&ct);
    Ok(base64::engine::general_purpose::STANDARD.encode(&blob))
}

fn aes_decrypt(b64: &str) -> Result<String, String> {
    use aes_gcm::aead::{Aead, KeyInit};
    use aes_gcm::{Aes256Gcm, Nonce};
    use base64::Engine;
    let blob = base64::engine::general_purpose::STANDARD
        .decode(b64)
        .map_err(|e| e.to_string())?;
    if blob.len() < 13 {
        return Err("密文过短".into());
    }
    let key = derive_key();
    let cipher = Aes256Gcm::new_from_slice(&key).map_err(|e| e.to_string())?;
    let nonce = Nonce::from_slice(&blob[..12]);
    let pt = cipher
        .decrypt(nonce, &blob[12..])
        .map_err(|e| format!("解密失败: {}", e))?;
    String::from_utf8(pt).map_err(|e| e.to_string())
}

// ===== 导出文件的口令加密 =====
// 导出文件会被复制/同步/转发,凭据绝不能明文落盘。这里用 scrypt 从口令派生密钥
// (故意慢,抵御离线暴力破解),再用 AES-256-GCM 加密并附认证标签。
// 文件格式(单行 base64):magic(4) | log_n(1) | r(4) | p(4) | salt(16) | nonce(12) | ciphertext
const EXPORT_MAGIC: &[u8; 4] = b"NBS1";
const EXPORT_LOG_N: u8 = 15; // N = 2^15,约 32MB 内存开销,单次派生 ~50ms 量级
const EXPORT_R: u32 = 8;
const EXPORT_P: u32 = 1;

fn scrypt_key(passphrase: &str, salt: &[u8]) -> Result<[u8; 32], String> {
    let params =
        scrypt::Params::new(EXPORT_LOG_N, EXPORT_R, EXPORT_P, 32).map_err(|e| e.to_string())?;
    let mut key = [0u8; 32];
    scrypt::scrypt(passphrase.as_bytes(), salt, &params, &mut key).map_err(|e| e.to_string())?;
    Ok(key)
}

fn encrypt_with_passphrase(passphrase: &str, plain: &[u8]) -> Result<String, String> {
    use aes_gcm::aead::{Aead, KeyInit};
    use aes_gcm::{Aes256Gcm, Nonce};
    use base64::Engine;
    use rand::RngCore;

    let mut salt = [0u8; 16];
    let mut nonce_bytes = [0u8; 12];
    {
        let mut rng = rand::thread_rng();
        rng.fill_bytes(&mut salt);
        rng.fill_bytes(&mut nonce_bytes);
    }
    let key = scrypt_key(passphrase, &salt)?;
    let cipher = Aes256Gcm::new_from_slice(&key).map_err(|e| e.to_string())?;
    let nonce = Nonce::from_slice(&nonce_bytes);
    let ct = cipher
        .encrypt(nonce, plain)
        .map_err(|e| format!("加密失败: {}", e))?;

    let mut blob = Vec::with_capacity(4 + 1 + 4 + 4 + 16 + 12 + ct.len());
    blob.extend_from_slice(EXPORT_MAGIC);
    blob.push(EXPORT_LOG_N);
    blob.extend_from_slice(&EXPORT_R.to_be_bytes());
    blob.extend_from_slice(&EXPORT_P.to_be_bytes());
    blob.extend_from_slice(&salt);
    blob.extend_from_slice(&nonce_bytes);
    blob.extend_from_slice(&ct);
    Ok(base64::engine::general_purpose::STANDARD.encode(&blob))
}

fn decrypt_with_passphrase(passphrase: &str, b64: &str) -> Result<Vec<u8>, String> {
    use aes_gcm::aead::{Aead, KeyInit};
    use aes_gcm::{Aes256Gcm, Nonce};
    use base64::Engine;

    let blob = base64::engine::general_purpose::STANDARD
        .decode(b64)
        .map_err(|e| e.to_string())?;
    // 先把头部参数读出来,再按文件里记录的 log_n/r/p 派生 ——
    // 这样以后调强参数也不会让旧文件失效。
    if blob.len() < 4 + 1 + 4 + 4 + 16 + 12 || &blob[..4] != EXPORT_MAGIC {
        return Err("凭据块格式不正确".into());
    }
    let log_n = blob[4];
    let r = u32::from_be_bytes([blob[5], blob[6], blob[7], blob[8]]);
    let p = u32::from_be_bytes([blob[9], blob[10], blob[11], blob[12]]);
    let salt = &blob[13..29];
    let nonce_bytes = &blob[29..41];
    let ct = &blob[41..];

    let params = scrypt::Params::new(log_n, r, p, 32).map_err(|e| e.to_string())?;
    let mut key = [0u8; 32];
    scrypt::scrypt(passphrase.as_bytes(), salt, &params, &mut key).map_err(|e| e.to_string())?;
    let cipher = Aes256Gcm::new_from_slice(&key).map_err(|e| e.to_string())?;
    cipher
        .decrypt(Nonce::from_slice(nonce_bytes), ct)
        .map_err(|_| "口令错误".to_string())
}

/// 凭据与主机的对应键(导出/导入两侧必须一致)
fn cred_key(v: &Value) -> String {
    format!(
        "{}:{}:{}",
        v["host"].as_str().unwrap_or("").to_lowercase(),
        v["port"].as_i64().unwrap_or(22),
        v["username"].as_str().unwrap_or("root").to_lowercase()
    )
}

// Account + service + region + instance ID form the cloud-managed identity. Older
// configs may lack account/region; only upgrade an unambiguous legacy match.
fn cloud_match(hosts: &[Value], cloud: &Value) -> Result<Option<usize>, String> {
    if cloud["provider"].as_str().unwrap_or("").is_empty()
        || cloud["instanceId"].as_str().unwrap_or("").is_empty()
    {
        return Ok(None);
    }
    let matches: Vec<usize> = hosts
        .iter()
        .enumerate()
        .filter_map(|(i, h)| {
            let old = &h["cloud"];
            let same = old["provider"] == cloud["provider"]
                && old["instanceId"] == cloud["instanceId"]
                && ["accountId", "region"].iter().all(|key| {
                    let a = old[*key].as_str().unwrap_or("");
                    let b = cloud[*key].as_str().unwrap_or("");
                    a.is_empty() || b.is_empty() || a == b
                });
            same.then_some(i)
        })
        .collect();
    match matches.as_slice() {
        [] => Ok(None),
        [i] => Ok(Some(*i)),
        _ => Err("云实例身份不明确，请指定账号、地域或主机 ID".into()),
    }
}

fn validate_jump_graph(hosts: &[Value]) -> Result<(), String> {
    use std::collections::{HashMap, HashSet};
    let mut graph = HashMap::new();
    for host in hosts {
        let id = host["id"]
            .as_str()
            .filter(|id| !id.is_empty())
            .ok_or("主机 ID 无效")?;
        if graph.insert(id, host).is_some() {
            return Err("主机 ID 重复".into());
        }
    }
    fn visit<'a>(
        id: &'a str,
        graph: &HashMap<&'a str, &'a Value>,
        active: &mut HashSet<&'a str>,
        done: &mut HashSet<&'a str>,
    ) -> Result<(), String> {
        if done.contains(id) {
            return Ok(());
        }
        if !active.insert(id) {
            return Err("跳板机链包含循环".into());
        }
        let host = graph
            .get(id)
            .ok_or_else(|| format!("跳板机不存在: {}", id))?;
        if !host["jumpIds"].is_null() {
            for jump in host["jumpIds"].as_array().ok_or("跳板机列表格式不正确")? {
                let jump = jump
                    .as_str()
                    .filter(|id| !id.is_empty())
                    .ok_or("跳板机 ID 无效")?;
                visit(jump, graph, active, done)?;
            }
        }
        active.remove(id);
        done.insert(id);
        Ok(())
    }
    let mut active = HashSet::new();
    let mut done = HashSet::new();
    for id in graph.keys() {
        visit(id, &graph, &mut active, &mut done)?;
    }
    Ok(())
}

impl Store {
    pub fn enc(&self, plain: &str, path: &str) -> String {
        if plain.is_empty() {
            return String::new();
        }
        match aes_encrypt(plain) {
            Ok(b64) => format!("aes:{}", b64),
            Err(_) => {
                // 极端回退:加密不可用时保留可读性(base64),保证功能不丢
                use base64::Engine;
                format!(
                    "plain:{}",
                    base64::engine::general_purpose::STANDARD.encode(plain.as_bytes())
                )
            }
        }
    }

    /// 双击打开临时副本的缓存根目录;空 = 系统临时目录(默认)。
    /// 仅做内存读取(data 锁很短),不做路径校验 —— 目录由 open_remote 兜底创建。
    pub fn open_temp_dir(&self) -> String {
        let data = self.data.lock().unwrap();
        data["settings"]["openTempDir"]
            .as_str()
            .unwrap_or("")
            .to_string()
    }

    /// 解密:enc: → keyring;plain: → base64;失败返回空串(与 Electron 版一致)
    pub fn dec(&self, cipher: &str) -> String {
        if cipher.is_empty() {
            return String::new();
        }
        // aes: 主格式
        if let Some(b64) = cipher.strip_prefix("aes:") {
            return aes_decrypt(b64).unwrap_or_default();
        }
        // plain: 兼容(旧版回退格式)
        if let Some(b64) = cipher.strip_prefix("plain:") {
            use base64::Engine;
            return String::from_utf8(
                base64::engine::general_purpose::STANDARD
                    .decode(b64)
                    .unwrap_or_default(),
            )
            .unwrap_or_default();
        }
        // enc: 旧版 keyring 格式:无法再读(条目已随进程消失),返回空并按需重新设置
        String::new()
    }

    pub fn load(dir: PathBuf) -> Store {
        std::fs::create_dir_all(&dir).ok();
        let file = dir.join("nebulashell-config.json");
        let mut data = std::fs::read_to_string(&file)
            .ok()
            .and_then(|s| serde_json::from_str::<Value>(&s).ok())
            .unwrap_or_else(defaults);
        // 归一化默认值(镜像 JS _load)
        if data["settings"].is_null() {
            data["settings"] = defaults()["settings"].clone();
        }
        if data["settings"]["ai"].is_null() {
            data["settings"]["ai"] = defaults()["settings"]["ai"].clone();
        }
        // 老配置里没有 models 字段(2026-10-01 引入):补空数组。
        // 旧的 temperature 字段一并清掉 —— 设置项已移除,留着只会让导出文件
        // 带一个界面上再也改不了的死字段。
        if data["settings"]["ai"]["models"].is_null() {
            data["settings"]["ai"]["models"] = json!([]);
        }
        if let Some(obj) = data["settings"]["ai"].as_object_mut() {
            obj.remove("temperature");
        }
        if data["settings"]["terminal"].is_null() {
            data["settings"]["terminal"] = defaults()["settings"]["terminal"].clone();
        }
        // 双击打开临时目录(2026-10-08):老配置补默认空值 = 用系统临时目录
        if data["settings"]["openTempDir"].is_null() {
            data["settings"]["openTempDir"] = json!("");
        }
        for p in ["tencent", "aliyun"] {
            if data["settings"]["clouds"][p].is_null() {
                data["settings"]["clouds"][p] = defaults()["settings"]["clouds"][p].clone();
            }
        }
        // 云账号多密钥(2026-09-28):settings.cloudAccounts = [{id,label,vendor,keyId,secretEnc,endpoint}]
        // 从旧的单密钥结构(settings.clouds.{tencent,aliyun})一次性迁移。
        // 旧 secretEnc 已是加密串,直接搬移即可,无需解密再加密。
        // 迁移标志:防止"用户删光所有账号"后,下次启动又从残留旧字段里复活。
        if data["settings"]["cloudAccountsMigrated"].is_null()
            && (data["settings"]["cloudAccounts"].is_null()
                || data["settings"]["cloudAccounts"]
                    .as_array()
                    .map(|a| a.is_empty())
                    .unwrap_or(false))
        {
            let mut migrated: Vec<Value> = Vec::new();
            for (vendor, label) in [("tencent", "腾讯云账号"), ("aliyun", "阿里云账号")] {
                let old = &data["settings"]["clouds"][vendor];
                let key = old["key"].as_str().unwrap_or("");
                let secret_enc = old["secretEnc"].as_str().unwrap_or("");
                if !key.is_empty() && !secret_enc.is_empty() {
                    migrated.push(json!({
                        "id": uuid::Uuid::new_v4().to_string(),
                        "label": label,
                        "vendor": vendor,
                        "keyId": key,
                        "secretEnc": secret_enc,
                        "endpoint": old["endpoint"].as_str().unwrap_or(""),
                    }));
                }
            }
            data["settings"]["cloudAccounts"] = json!(migrated);
            data["settings"]["cloudAccountsMigrated"] = json!(true);
        }
        for k in ["hosts", "snippets", "forwards", "bookmarks", "history"] {
            if data[k].is_null() {
                data[k] = json!([]);
            }
        }
        if data["knownHosts"].is_null() {
            data["knownHosts"] = json!({});
        }
        // 旧版命令历史把按键原样入库(bracketed paste 标记、方向键、Ctrl+C 拼接、
        // 甚至密码提示下的输入),每次加载都清洗一遍;有改动则置脏,由去抖任务落盘。
        let history_changed = match data["history"].as_array_mut() {
            Some(history) => clean_history(history),
            None => {
                data["history"] = json!([]);
                true
            }
        };
        Store {
            dir,
            data: Mutex::new(data),
            use_keyring: true,
            dirty: std::sync::atomic::AtomicBool::new(history_changed),
        }
    }

    /// 记一条命令历史:清洗后为空不记;同一命令只保留最新一条,最多 500 条。
    /// 返回是否记录了。只改内存并置脏,由去抖任务落盘。
    pub fn add_history(&self, host_id: Value, host: Value, raw: &str) -> bool {
        let cmd = clean_command(raw);
        if cmd.is_empty() {
            return false;
        }
        {
            let mut data = self.data.lock().unwrap();
            if !data["history"].is_array() {
                data["history"] = json!([]);
            }
            if let Some(history) = data["history"].as_array_mut() {
                history.retain(|h| h["cmd"].as_str() != Some(cmd.as_str()));
                history.push(json!({ "hostId": host_id, "host": host, "cmd": cmd, "at": chrono::Utc::now().timestamp_millis() }));
                let len = history.len();
                if len > 500 {
                    history.drain(..len - 500);
                }
            }
        }
        self.mark_dirty();
        true
    }

    // ===== 文件分屏书签:{ hostId, path, name?, at },按 hostId 共享,数组顺序即显示顺序 =====

    /// 书签数组;字段被写坏(非数组)时重置为空数组,而不是 panic。
    fn bookmarks_mut(data: &mut Value) -> &mut Vec<Value> {
        if !data["bookmarks"].is_array() {
            data["bookmarks"] = json!([]);
        }
        match data["bookmarks"].as_array_mut() {
            Some(list) => list,
            None => unreachable!("bookmarks was just reset to an array"),
        }
    }

    fn same_bookmark(b: &Value, host_id: &str, path: &str) -> bool {
        b["hostId"].as_str() == Some(host_id) && b["path"].as_str() == Some(path)
    }

    /// 收藏目录;已收藏则不重复。返回是否新增。
    pub fn add_bookmark(&self, host_id: &str, path: &str) -> bool {
        if host_id.is_empty() || !path.starts_with('/') {
            return false;
        }
        let added = {
            let mut data = self.data.lock().unwrap();
            let list = Self::bookmarks_mut(&mut data);
            let exists = list.iter().any(|b| Self::same_bookmark(b, host_id, path));
            if !exists {
                list.push(json!({ "hostId": host_id, "path": path, "at": chrono::Utc::now().timestamp_millis() }));
            }
            !exists
        };
        if added {
            self.save().ok();
        }
        added
    }

    /// 取消收藏。返回是否删除了。
    pub fn remove_bookmark(&self, host_id: &str, path: &str) -> bool {
        let removed = {
            let mut data = self.data.lock().unwrap();
            let list = Self::bookmarks_mut(&mut data);
            let before = list.len();
            list.retain(|b| !Self::same_bookmark(b, host_id, path));
            list.len() != before
        };
        if removed {
            self.save().ok();
        }
        removed
    }

    /// 设置书签别名(去首尾空白,最长 64 字符);空串清除别名。返回是否找到该书签。
    pub fn update_bookmark(&self, host_id: &str, path: &str, name: &str) -> bool {
        let found = {
            let mut data = self.data.lock().unwrap();
            let list = Self::bookmarks_mut(&mut data);
            match list
                .iter_mut()
                .find(|b| Self::same_bookmark(b, host_id, path))
            {
                Some(b) => {
                    let name: String = name.trim().chars().take(64).collect();
                    match b.as_object_mut() {
                        Some(obj) if name.is_empty() => {
                            obj.remove("name");
                        }
                        Some(obj) => {
                            obj.insert("name".into(), json!(name));
                        }
                        None => {}
                    }
                    true
                }
                None => false,
            }
        };
        if found {
            self.save().ok();
        }
        found
    }

    /// 按 paths 的顺序重排某主机的书签。只动该主机的条目:它们依次填回自己原来占的
    /// 位置,其他主机的条目位置不变;paths 里没有的书签保持原相对顺序排在后面。
    pub fn reorder_bookmarks(&self, host_id: &str, paths: &[String]) {
        {
            let mut data = self.data.lock().unwrap();
            let list = Self::bookmarks_mut(&mut data);
            let slots: Vec<usize> = list
                .iter()
                .enumerate()
                .filter(|(_, b)| b["hostId"].as_str() == Some(host_id))
                .map(|(i, _)| i)
                .collect();
            let mut mine: Vec<Value> = slots.iter().map(|&i| list[i].clone()).collect();
            // 稳定排序:不在 paths 里的条目同为 usize::MAX,保持原相对顺序
            mine.sort_by_key(|b| {
                paths
                    .iter()
                    .position(|p| b["path"].as_str() == Some(p.as_str()))
                    .unwrap_or(usize::MAX)
            });
            for (slot, b) in slots.into_iter().zip(mine) {
                list[slot] = b;
            }
        }
        self.save().ok();
    }

    /// 测试用:禁用 keyring,凭据走 base64 回退
    pub fn load_plain(dir: PathBuf) -> Store {
        let mut s = Store::load(dir);
        s.use_keyring = false;
        s
    }

    pub fn save(&self) -> Result<(), String> {
        let data = self.data.lock().unwrap();
        let file = self.dir.join("nebulashell-config.json");
        let tmp = self.dir.join("nebulashell-config.json.tmp");
        let body = serde_json::to_string_pretty(&*data).map_err(|e| e.to_string())?;
        std::fs::write(&tmp, body).map_err(|e| e.to_string())?;
        std::fs::rename(&tmp, &file).map_err(|e| e.to_string())
    }

    /// 标记配置已变更,交由后台去抖任务延迟落盘。
    ///
    /// 用于高频小写入(典型是命令历史:每敲一条命令都要更新)。旧实现每写一条
    /// 都 `to_string_pretty` 整份配置 + 临时文件 + rename,含加密凭据在内全量重写。
    /// 真正的持久化由 `flush_if_dirty` 在去抖周期到达时执行。
    pub fn mark_dirty(&self) {
        self.dirty.store(true, std::sync::atomic::Ordering::SeqCst);
    }

    /// 若有未落盘的变更则立即写入;返回是否真的写了。
    pub fn flush_if_dirty(&self) -> bool {
        if !self.dirty.swap(false, std::sync::atomic::Ordering::SeqCst) {
            return false;
        }
        if self.save().is_err() {
            // 写失败则重新置脏,下个周期重试(避免静默丢数据)
            self.dirty.store(true, std::sync::atomic::Ordering::SeqCst);
            return false;
        }
        true
    }

    /// 无论是否标记为脏都落盘一次(退出时调用,确保不丢数据)。
    pub fn flush_now(&self) {
        self.dirty.store(false, std::sync::atomic::Ordering::SeqCst);
        self.save().ok();
    }

    /// 运行时解密后的主机完整对象(含 password/privateKey/passphrase 明文)
    pub fn host_full(&self, id: &str) -> Result<Value, String> {
        let data = self.data.lock().unwrap();
        let hosts = data["hosts"].as_array().ok_or("主机列表损坏")?;
        let h = hosts
            .iter()
            .find(|h| h["id"] == *id)
            .cloned()
            .ok_or_else(|| {
                format!(
                    "主机不存在: 查询 {} 在 {:?} (store={:p}, use_keyring={})",
                    id,
                    hosts
                        .iter()
                        .map(|x| x["id"].as_str().unwrap_or(""))
                        .collect::<Vec<_>>(),
                    self,
                    self.use_keyring
                )
            })?;
        let mut out = h.clone();
        for field in ["password", "privateKey", "passphrase"] {
            let cipher = h[format!("{}Enc", field)].as_str().unwrap_or("");
            out[field] = json!(self.dec(cipher));
        }
        Ok(out)
    }

    /// 保存主机:敏感字段仅在显式提供非空值时更新(编辑留空保持不变,与 Electron 版一致)
    pub fn save_host(&self, input: &Value) -> Result<Value, String> {
        let mut data = self.data.lock().unwrap();
        let host_field = input["host"].as_str().unwrap_or("");
        if host_field.is_empty() {
            return Err("主机地址不能为空".into());
        }
        let hosts = data["hosts"].as_array_mut().unwrap();
        let by_id = input["id"]
            .as_str()
            .filter(|id| !id.is_empty())
            .and_then(|id| hosts.iter().position(|h| h["id"] == *id));
        let idx = if by_id.is_some() {
            by_id
        } else {
            cloud_match(hosts, &input["cloud"])?
        };
        // A cloud refresh owns IP/cloud metadata, not the user's login/preferences.
        let preserve = idx.is_some() && by_id.is_none() && !input["cloud"].is_null();
        let host = self.merge_host(input, idx.map(|i| &hosts[i]), preserve)?;
        let mut candidate = hosts.clone();
        match idx {
            Some(i) => candidate[i] = host.clone(),
            None => candidate.push(host.clone()),
        }
        validate_jump_graph(&candidate)?;
        *hosts = candidate;
        drop(data);
        self.save()?;
        self.public_host(host["id"].as_str().unwrap_or(""))
            .ok_or_else(|| "保存后读取失败".into())
    }

    fn merge_host(
        &self,
        input: &Value,
        existing: Option<&Value>,
        preserve: bool,
    ) -> Result<Value, String> {
        let host_field = input["host"]
            .as_str()
            .filter(|s| !s.trim().is_empty())
            .ok_or("主机地址不能为空")?;
        let (host, is_new) = match existing {
            Some(host) => (host.clone(), false),
            None => {
                let id = input["id"]
                    .as_str()
                    .filter(|id| !id.is_empty())
                    .map(String::from)
                    .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
                (
                    json!({
                        "id": id,
                        "name": input["name"].as_str().unwrap_or(host_field),
                        "host": host_field,
                        "port": input["port"].as_i64().unwrap_or(22),
                        "username": input["username"].as_str().unwrap_or("root"),
                        "authType": input["authType"].as_str().unwrap_or("password"),
                        "keyPath": "", "group": "", "tags": [],
                        "jumpIds": [], "initcmd": "",
                        "cloud": null, "createdAt": chrono::Utc::now().timestamp_millis(),
                        "password": "", "privateKey": "", "passphrase": ""
                    }),
                    true,
                )
            }
        };
        let mut host = host;
        // Track a discovered name until the user edits it. Legacy/file-imported
        // names have no baseline and are always preserved on cloud refresh.
        if is_new
            && input["id"].as_str().filter(|id| !id.is_empty()).is_none()
            && !input["cloud"].is_null()
        {
            host["cloudImportedName"] = host["name"].clone();
        } else if preserve
            && host["cloudNameEdited"] != json!(true)
            && !host["cloudImportedName"].is_null()
            && host["name"] == host["cloudImportedName"]
            && !input["name"].is_null()
        {
            host["name"] = input["name"].clone();
            host["cloudImportedName"] = input["name"].clone();
        } else if !is_new && !preserve && !host["cloud"].is_null() && !input["name"].is_null() {
            host["cloudNameEdited"] = json!(true);
        }
        host["host"] = json!(host_field);
        if !preserve {
            for field in [
                "name", "port", "username", "authType", "group", "tags", "keyPath", "jumpIds",
                "initcmd",
            ] {
                if !input[field].is_null() {
                    host[field] = input[field].clone();
                }
            }
        }
        if !input["cloud"].is_null() {
            host["cloud"] = input["cloud"].clone();
        }
        let clear = input["clearSecrets"].as_array();
        if !input["clearSecrets"].is_null() && clear.is_none() {
            return Err("clearSecrets 必须是凭据字段数组".into());
        }
        if let Some(fields) = clear {
            if fields
                .iter()
                .any(|f| !matches!(f.as_str(), Some("password" | "privateKey" | "passphrase")))
            {
                return Err("不能清除未知凭据字段".into());
            }
        }
        // 敏感字段:仅在提供非空值时更新
        for field in ["password", "privateKey", "passphrase"] {
            let plain = input[field].as_str().unwrap_or("");
            let cipher_field = format!("{}Enc", field);
            if clear
                .map(|fields| fields.iter().any(|f| f == field))
                .unwrap_or(false)
            {
                host[&cipher_field] = json!("");
                host.as_object_mut().unwrap().remove(field);
                if field == "privateKey" {
                    host["keyPath"] = json!("");
                }
            } else if !plain.is_empty()
                && (!preserve
                    || self
                        .dec(host[&cipher_field].as_str().unwrap_or(""))
                        .is_empty())
            {
                let path = format!("hosts.{}.{}", host["id"].as_str().unwrap_or(""), field);
                host[&cipher_field] = json!(self.enc(plain, &path));
            } else if is_new {
                host[format!("{}Enc", field)] = json!("");
            }
        }
        Ok(host)
    }

    /// 公开形态(不含明文凭据,带 hasPassword/hasKey)
    pub fn public_host(&self, id: &str) -> Option<Value> {
        let data = self.data.lock().unwrap();
        let h = data["hosts"]
            .as_array()?
            .iter()
            .find(|h| h["id"] == *id)?
            .clone();
        let has = |f: &str| {
            !self
                .dec(h[format!("{}Enc", f)].as_str().unwrap_or(""))
                .is_empty()
        };
        let mut out = h.clone();
        out["hasPassword"] = json!(has("password"));
        out["hasKey"] = json!(has("privateKey"));
        out["hasPassphrase"] = json!(has("passphrase"));
        // Never leak either encrypted or legacy plaintext credentials over IPC.
        for f in [
            "password",
            "privateKey",
            "passphrase",
            "passwordEnc",
            "privateKeyEnc",
            "passphraseEnc",
        ] {
            out.as_object_mut().unwrap().remove(f);
        }
        Some(out)
    }

    pub fn list_hosts(&self) -> Vec<Value> {
        // 先克隆再算公开形态:public_host 会再拿锁,std Mutex 不可重入
        let hosts: Vec<Value> = {
            let data = self.data.lock().unwrap();
            data["hosts"].as_array().cloned().unwrap_or_default()
        };
        hosts
            .iter()
            .map(|h| {
                self.public_host(h["id"].as_str().unwrap_or(""))
                    .unwrap_or_else(|| h.clone())
            })
            .collect()
    }

    pub fn delete_host(&self, id: &str) -> Result<i64, String> {
        let mut data = self.data.lock().unwrap();
        let hosts = data["hosts"].as_array_mut().unwrap();
        let before = hosts.len() as i64;
        hosts.retain(|h| h["id"] != *id);
        let removed = before - hosts.len() as i64;
        for host in hosts {
            if let Some(jumps) = host["jumpIds"].as_array_mut() {
                jumps.retain(|jump| jump != id);
            }
        }
        drop(data);
        self.save()?;
        Ok(removed)
    }

    pub fn clone_host(&self, id: &str) -> Result<Value, String> {
        let full = self.host_full(id)?;
        let mut payload = full.clone();
        payload["id"] = json!(null);
        payload["name"] = json!(format!(
            "{} 副本",
            full["name"]
                .as_str()
                .unwrap_or_else(|| full["host"].as_str().unwrap_or(""))
        ));
        payload["cloud"] = json!(null);
        self.save_host(&payload)
    }

    /// 导出主机。
    ///
    /// `passphrase` 为 None 时**只导出非敏感字段**(主机/端口/用户名/分组等),
    /// 凭据一律不写入 —— 导出文件常被复制、同步或随聊天工具转发,明文密码
    /// 一旦落盘就很难收回。需要连同凭据迁移时,调用方必须提供口令,
    /// 此时凭据用 scrypt 派生密钥 + AES-256-GCM 加密后单独放在 credentials 里。
    pub fn export_hosts(&self, passphrase: Option<&str>) -> Result<Value, String> {
        // 明文凭据先取出来,随即释放锁 —— 后面的 scrypt 派生是 CPU/内存密集操作
        // (N=2^15,debug 构建下可达数秒),若继续持锁会把**所有**其它命令一起
        // 卡住(实测并发 settings:get 被阻塞 3.1s)。锁只用来读数据,不用来算。
        let (hosts, creds) = {
            let data = self.data.lock().unwrap();
            let hosts: Vec<Value> = data["hosts"]
                .as_array()
                .unwrap_or(&vec![])
                .iter()
                .map(|h| {
                    json!({
                        "id": h["id"], "name": h["name"], "host": h["host"], "port": h["port"], "username": h["username"],
                        "authType": h["authType"], "keyPath": h["keyPath"], "group": h["group"], "tags": h["tags"],
                        "jumpIds": h["jumpIds"], "initcmd": h["initcmd"], "cloud": h["cloud"],
                    })
                })
                .collect();
            let creds: Option<Vec<Value>> = passphrase.map(|_| {
                data["hosts"]
                    .as_array()
                    .unwrap_or(&vec![])
                    .iter()
                    .map(|h| {
                        json!({
                            "id": h["id"], "host": h["host"], "port": h["port"], "username": h["username"],
                            "password": self.dec(h["passwordEnc"].as_str().unwrap_or("")),
                            "privateKey": self.dec(h["privateKeyEnc"].as_str().unwrap_or("")),
                            "passphrase": self.dec(h["passphraseEnc"].as_str().unwrap_or("")),
                        })
                    })
                    .collect()
            });
            (hosts, creds)
        };

        validate_jump_graph(&hosts)?;
        let mut out = json!({
            "app": "nebulashell", "version": 3,
            "exportedAt": chrono::Utc::now().to_rfc3339(),
            "hosts": hosts,
            // 明确标记:本文件不含明文凭据
            "credentialsIncluded": false,
        });

        if let Some(pass) = passphrase {
            if pass.trim().is_empty() {
                return Err("口令不能为空".into());
            }
            let creds = creds.unwrap_or_default();
            let plain = serde_json::to_string(&creds).map_err(|e| e.to_string())?;
            let blob = encrypt_with_passphrase(pass, plain.as_bytes())?;
            out["credentialsIncluded"] = json!(true);
            out["credentials"] = json!(blob);
        }
        Ok(out)
    }

    /// 导入 v1 明文、v2 端点凭据与 v3 完整拓扑导出。v3 先重映射 ID,
    /// 校验所有跳板引用/循环后整体提交。重复项保留用户配置,仅补缺失凭据;
    /// 加密凭据必须提供原导出口令。
    pub fn import_hosts(&self, text: &str, passphrase: Option<&str>) -> Result<Value, String> {
        let parsed: Value =
            serde_json::from_str(text).map_err(|_| "文件不是合法 JSON".to_string())?;
        let version = parsed["version"].as_u64().unwrap_or(1);
        if version > 3 {
            return Err("不支持该主机导出版本".into());
        }
        let items = if parsed.is_array() {
            parsed.as_array().unwrap().clone()
        } else {
            parsed["hosts"]
                .as_array()
                .ok_or("文件格式不对:需要 { hosts: [...] } 或主机数组")?
                .clone()
        };
        let mut source_ids = std::collections::HashSet::new();
        for item in &items {
            if !item.is_object() || item["host"].as_str().unwrap_or("").trim().is_empty() {
                return Err("导入主机地址不能为空".into());
            }
            if let Some(id) = item["id"].as_str().filter(|id| !id.is_empty()) {
                if !source_ids.insert(id.to_owned()) {
                    return Err("导入文件主机 ID 重复".into());
                }
            } else if version >= 3 {
                return Err("导入文件缺少主机 ID".into());
            }
        }

        // v3 credentials are keyed by source ID; v1/v2 use host:port:user.
        let mut creds: std::collections::HashMap<String, Value> = std::collections::HashMap::new();
        let mut legacy_plaintext = false;

        if !parsed["credentials"].is_null() {
            let pass = passphrase
                .filter(|p| !p.is_empty())
                .ok_or("该导出文件包含凭据,请输入导出时设置的口令")?;
            let blob = parsed["credentials"].as_str().ok_or("凭据字段格式不正确")?;
            let plain = decrypt_with_passphrase(pass, blob)
                .map_err(|_| "口令错误,或文件已损坏".to_string())?;
            let list: Vec<Value> = serde_json::from_slice(&plain)
                .map_err(|_| "凭据内容解析失败(口令是否正确?)".to_string())?;
            for c in &list {
                let key = if version >= 3 {
                    c["id"].as_str().ok_or("凭据缺少主机 ID")?.to_owned()
                } else {
                    cred_key(c)
                };
                if creds.insert(key, c.clone()).is_some() {
                    return Err("凭据身份重复".into());
                }
            }
        }

        // Stage a complete transaction: resolve every ID before validating jumps,
        // and never leave a partially imported graph after a bad file.
        let mut data = self.data.lock().unwrap();
        let mut staged = data["hosts"].as_array().ok_or("主机列表损坏")?.clone();
        let mut remap = std::collections::HashMap::new();
        let mut claimed = std::collections::HashSet::new();
        let mut plans = Vec::new();
        let mut added = 0;
        for item in &items {
            let source = item["id"].as_str().filter(|id| !id.is_empty());
            let by_source = source.and_then(|id| {
                staged.iter().position(|h| {
                    h["importSourceId"] == id
                        || h["id"] == id
                        || h["importSourceIds"]
                            .as_array()
                            .map(|ids| ids.iter().any(|source| source == id))
                            .unwrap_or(false)
                })
            });
            let by_cloud = if by_source.is_some() {
                None
            } else {
                cloud_match(&staged, &item["cloud"])?
            };
            let endpoints: Vec<usize> = staged
                .iter()
                .enumerate()
                .filter(|(i, h)| {
                    !claimed.contains(i)
                        && cred_key(h) == cred_key(item)
                        && (item["cloud"].is_null() || h["cloud"].is_null())
                })
                .map(|(i, _)| i)
                .collect();
            // Never collapse two independent v3 cloud identities merely because
            // they currently share an IP/login tuple.
            let by_endpoint = if endpoints.len() == 1 {
                Some(endpoints[0])
            } else {
                None
            };
            let (idx, is_new) = match by_source.or(by_cloud).or(by_endpoint) {
                Some(i) => (i, false),
                None => {
                    let i = staged.len();
                    let mut payload = item.clone();
                    payload["id"] = json!(uuid::Uuid::new_v4().to_string());
                    payload["jumpIds"] = json!([]);
                    payload.as_object_mut().unwrap().remove("clearSecrets");
                    for f in ["password", "privateKey", "passphrase"] {
                        payload.as_object_mut().unwrap().remove(f);
                    }
                    let mut host = self.merge_host(&payload, None, false)?;
                    if let Some(source) = source {
                        host["importSourceId"] = json!(source);
                    }
                    staged.push(host);
                    added += 1;
                    (i, true)
                }
            };
            if let Some(source) = source {
                remap.insert(source.to_owned(), staged[idx]["id"].clone());
                // Remember source identity even when the first import matched a
                // local host. Later user edits to IP/login must not create a new
                // host when reimporting its encrypted credentials.
                if staged[idx]["importSourceIds"].is_null() {
                    staged[idx]["importSourceIds"] = json!([]);
                }
                let ids = staged[idx]["importSourceIds"]
                    .as_array_mut()
                    .ok_or("导入身份记录损坏")?;
                if !ids.iter().any(|id| id == source) {
                    ids.push(json!(source));
                }
            }
            claimed.insert(idx);
            plans.push((idx, is_new));
        }
        let mut updated_hosts = std::collections::HashSet::new();
        let mut credential_hosts = std::collections::HashSet::new();
        let mut credentials_filled = 0;
        let mut imported_graph = Vec::new();
        for (item, (idx, is_new)) in items.iter().zip(plans) {
            let mut jumps = Vec::new();
            if !item["jumpIds"].is_null() {
                for jump in item["jumpIds"].as_array().ok_or("跳板机列表格式不正确")? {
                    let source = jump.as_str().ok_or("跳板机 ID 无效")?;
                    jumps.push(
                        remap
                            .get(source)
                            .cloned()
                            .ok_or_else(|| format!("导入文件含悬空跳板机: {}", source))?,
                    );
                }
            }
            let mut graph_host = staged[idx].clone();
            graph_host["jumpIds"] = json!(jumps);
            imported_graph.push(graph_host);
            if is_new {
                staged[idx]["jumpIds"] = json!(jumps);
            }
            let credential_key = if version >= 3 {
                item["id"].as_str().unwrap_or("").to_owned()
            } else {
                cred_key(item)
            };
            let encrypted = creds.get(&credential_key);
            for field in ["password", "privateKey", "passphrase"] {
                let inline = item[field].as_str().filter(|s| !s.is_empty());
                if inline.is_some() {
                    legacy_plaintext = true;
                }
                let plain = inline
                    .or_else(|| encrypted.and_then(|c| c[field].as_str()))
                    .unwrap_or("");
                let cipher = format!("{}Enc", field);
                // Default repeat import only fills a missing secret. Existing
                // credentials/preferences are never silently replaced.
                if !plain.is_empty()
                    && self
                        .dec(staged[idx][&cipher].as_str().unwrap_or(""))
                        .is_empty()
                {
                    staged[idx][&cipher] = json!(self.enc(
                        plain,
                        &format!(
                            "hosts.{}.{}",
                            staged[idx]["id"].as_str().unwrap_or(""),
                            field
                        )
                    ));
                    credential_hosts.insert(idx);
                    if !is_new {
                        updated_hosts.insert(idx);
                        credentials_filled += 1;
                    }
                }
            }
        }
        validate_jump_graph(&imported_graph)?;
        validate_jump_graph(&staged)?;
        let updated = updated_hosts.len();
        data["hosts"] = json!(staged);
        drop(data);
        self.save()?;
        Ok(json!({
            "added": added,
            "updated": updated,
            "skipped": items.len().saturating_sub(added + updated),
            "withCredentials": credential_hosts.len(),
            "credentialsFilled": credentials_filled,
            "legacyPlaintext": legacy_plaintext,
        }))
    }

    pub fn get_settings(&self) -> Value {
        let data = self.data.lock().unwrap();
        let ai = &data["settings"]["ai"];
        json!({
            "ai": {
                "provider": ai["provider"], "protocol": ai["protocol"], "baseUrl": ai["baseUrl"],
                "model": ai["model"], "models": ai["models"],
                "apiKeySet": !self.dec(ai["apiKeyEnc"].as_str().unwrap_or("")).is_empty()
            },
            "terminal": data["settings"]["terminal"].clone(),
            "openTempDir": data["settings"]["openTempDir"].clone(),
            "snippets": data["snippets"].clone(),
            // 多账号云凭据:公开形态不回传 Secret,只给 keyId 与"是否已存"
            "cloudAccounts": data["settings"]["cloudAccounts"]
                .as_array()
                .cloned()
                .unwrap_or_default()
                .iter()
                .map(|a| {
                    json!({
                        "id": a["id"], "label": a["label"], "vendor": a["vendor"],
                        "keyId": a["keyId"], "endpoint": a["endpoint"],
                        "secretSet": !self.dec(a["secretEnc"].as_str().unwrap_or("")).is_empty(),
                    })
                })
                .collect::<Vec<_>>(),
        })
    }

    /// 保存一个云账号(多 API Key)。带 id 即更新,否则新建。
    /// secret 为空表示保持原值不变(编辑但不重输密钥)。
    pub fn save_cloud_account(
        &self,
        id: &str,
        label: &str,
        vendor: &str,
        key_id: &str,
        secret: &str,
        endpoint: &str,
    ) -> Result<Value, String> {
        if key_id.trim().is_empty() {
            return Err("Key ID 不能为空".into());
        }
        let v = match vendor {
            "aliyun" => "aliyun",
            _ => "tencent",
        };
        let mut data = self.data.lock().unwrap();
        let accounts = data["settings"]["cloudAccounts"]
            .as_array_mut()
            .ok_or("云账号存储损坏")?;
        let existing = if id.is_empty() {
            None
        } else {
            accounts.iter().position(|a| a["id"] == json!(id))
        };
        match existing {
            Some(i) => {
                // 换厂商时必须重输 Secret:留空会沿用上一家的密钥,但那把密钥
                // 对新厂商必然无效(签名算法与凭据体系都不同),静默保留只会
                // 让"保存成功"变成下一次拉取的鉴权失败。
                if secret.is_empty() && accounts[i]["vendor"] != json!(v) {
                    return Err("更换厂商需重新填写 Secret".into());
                }
                accounts[i]["label"] = json!(label.chars().take(50).collect::<String>());
                accounts[i]["vendor"] = json!(v);
                accounts[i]["keyId"] = json!(key_id.trim());
                accounts[i]["endpoint"] = json!(endpoint.trim());
                if !secret.is_empty() {
                    accounts[i]["secretEnc"] = json!(self.enc(secret, "cloudAccounts.secret"));
                }
                Ok(json!({ "id": accounts[i]["id"] }))
            }
            None => {
                if secret.is_empty() {
                    return Err("请填写 Secret".into());
                }
                let new_id = uuid::Uuid::new_v4().to_string();
                accounts.push(json!({
                    "id": new_id,
                    "label": label.chars().take(50).collect::<String>(),
                    "vendor": v,
                    "keyId": key_id.trim(),
                    "secretEnc": self.enc(secret, "cloudAccounts.secret"),
                    "endpoint": endpoint.trim(),
                }));
                Ok(json!({ "id": new_id }))
            }
        }
    }

    pub fn delete_cloud_account(&self, id: &str) -> Result<i64, String> {
        let mut data = self.data.lock().unwrap();
        let accounts = data["settings"]["cloudAccounts"]
            .as_array_mut()
            .ok_or("云账号存储损坏")?;
        let before = accounts.len();
        accounts.retain(|a| a["id"] != json!(id));
        Ok((before - accounts.len()) as i64)
    }

    /// 取某账号的明文凭据(仅后端内部使用,不经过 IPC 返回)
    pub fn cloud_account_creds(
        &self,
        id: &str,
    ) -> Result<(String, String, String, String), String> {
        let data = self.data.lock().unwrap();
        let a = data["settings"]["cloudAccounts"]
            .as_array()
            .ok_or("云账号存储损坏")?
            .iter()
            .find(|a| a["id"] == json!(id))
            .ok_or_else(|| "云账号不存在".to_string())?;
        Ok((
            a["keyId"].as_str().unwrap_or("").to_string(),
            self.dec(a["secretEnc"].as_str().unwrap_or("")),
            a["endpoint"].as_str().unwrap_or("").to_string(),
            a["vendor"].as_str().unwrap_or("tencent").to_string(),
        ))
    }

    pub fn save_settings(&self, patch: &Value) -> Value {
        let mut data = self.data.lock().unwrap();
        if let Some(snips) = patch["snippets"].as_array() {
            let cleaned: Vec<Value> = snips
                .iter()
                .filter(|s| !s["name"].as_str().unwrap_or("").trim().is_empty())
                .map(|s| {
                    json!({
                        "name": s["name"].as_str().unwrap_or("").trim().chars().take(50).collect::<String>(),
                        "cmd": s["cmd"].as_str().unwrap_or("").chars().take(2000).collect::<String>()
                    })
                })
                .collect();
            data["snippets"] = json!(cleaned);
        }
        if let Some(t) = patch["terminal"].as_object() {
            let term = &mut data["settings"]["terminal"];
            if let Some(v) = t.get("fontSize") {
                let n = v.as_f64().unwrap_or(13.0).clamp(10.0, 20.0);
                term["fontSize"] = json!(n);
            }
            if let Some(v) = t.get("scrollback") {
                // 上限 20000:回滚缓冲是终端侧内存的主要可调项(实测 5k→50k
                // 让 WebContent footprint 增加约 105MB),上限收窄避免一键拉满。
                let n = v.as_f64().unwrap_or(2000.0).clamp(1000.0, 20000.0);
                term["scrollback"] = json!(n);
            }
            if let Some(v) = t.get("theme") {
                if ["nebula", "light", "forest"].contains(&v.as_str().unwrap_or("")) {
                    term["theme"] = v.clone();
                }
            }
        }
        // 双击打开临时目录:trim 后存;留空表示恢复默认(系统临时目录)
        if let Some(v) = patch["openTempDir"].as_str() {
            data["settings"]["openTempDir"] = json!(v.trim());
        }
        if let Some(ai) = patch["ai"].as_object() {
            let out = &mut data["settings"]["ai"];
            let normalize = |value: &Value| {
                value
                    .as_str()
                    .unwrap_or("")
                    .trim()
                    .trim_end_matches('/')
                    .to_owned()
            };
            let endpoint_changed = ai
                .get("baseUrl")
                .filter(|v| !v.is_null())
                .map(|url| normalize(url) != normalize(&out["baseUrl"]))
                .unwrap_or(false)
                || ai
                    .get("protocol")
                    .filter(|v| !v.is_null())
                    .map(|protocol| {
                        protocol.as_str().unwrap_or("openai")
                            != out["protocol"].as_str().unwrap_or("openai")
                    })
                    .unwrap_or(false);
            if ai
                .get("clearApiKey")
                .and_then(Value::as_bool)
                .unwrap_or(false)
                || endpoint_changed
            {
                out["apiKeyEnc"] = json!("");
                out.as_object_mut().unwrap().remove("apiKey");
            }
            for k in ["provider", "protocol", "baseUrl", "model"] {
                if let Some(v) = ai.get(k) {
                    if !v.is_null() {
                        out[k] = v.clone();
                    }
                }
            }
            // 已勾选的可用模型(对象数组,含 name/ownedBy/created)。空数组是合法值,
            // 表示"用户把勾选全取消了",不能用 is_null 判断后跳过。
            if let Some(v) = ai.get("models") {
                if let Some(arr) = v.as_array() {
                    out["models"] = json!(arr);
                }
            }
            if let Some(v) = ai.get("apiKey") {
                let plain = v.as_str().unwrap_or("");
                if !plain.is_empty()
                    && !ai
                        .get("clearApiKey")
                        .and_then(Value::as_bool)
                        .unwrap_or(false)
                {
                    out["apiKeyEnc"] = json!(self.enc(plain, "settings.ai.apiKey"));
                }
            }
        }
        if let Some(clouds) = patch["clouds"].as_object() {
            for p in ["tencent", "aliyun"] {
                if let Some(pc) = clouds.get(p) {
                    let c = &mut data["settings"]["clouds"][p];
                    if let Some(v) = pc.get("key") {
                        if !v.is_null() {
                            c["key"] = v.clone();
                        }
                    }
                    if let Some(v) = pc.get("endpoint") {
                        if !v.is_null() {
                            c["endpoint"] = v.clone();
                        }
                    }
                    if let Some(v) = pc.get("secret") {
                        let plain = v.as_str().unwrap_or("");
                        if !plain.is_empty() {
                            c["secretEnc"] =
                                json!(self.enc(plain, &format!("settings.clouds.{}.secret", p)));
                        }
                    }
                }
            }
        }
        drop(data);
        self.save().ok();
        self.get_settings()
    }

    pub fn list_fingerprints_for_test(&self) -> Vec<Value> {
        let data = self.data.lock().unwrap();
        data["knownHosts"]
            .as_object()
            .map(|m| m.iter().map(|(k, v)| json!({ "id": k, "fp": v })).collect())
            .unwrap_or_default()
    }

    pub fn save_cloud_creds(
        &self,
        provider: &str,
        key: &str,
        secret: &str,
        endpoint: &str,
    ) -> Value {
        let p = if provider == "aliyun" {
            "aliyun"
        } else {
            "tencent"
        };
        let mut patch = json!({ "clouds": { p: {} } });
        if !key.is_empty() {
            patch["clouds"][p]["key"] = json!(key);
        }
        if !secret.is_empty() {
            patch["clouds"][p]["secret"] = json!(secret);
        }
        patch["clouds"][p]["endpoint"] = json!(endpoint);
        self.save_settings(&patch)
    }
}
