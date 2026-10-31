// 配置存储:与 Electron 版 nebulashell-config.json 同构;敏感字段经 keyring(macOS Keychain)加密,
// keyring 不可用时回退 base64 'plain:' 前缀(与 Electron 版 fallback 行为一致)。
use crate::term_text::skip_escape;
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
            // 会话日志:自动记录默认关;dir 空 = 主目录下 NebulaShell-logs;
            // format: text(纯文本,可读) | raw(原始终端流,可回放);时间戳仅对 text 生效;
            // includeScreen:手动开始记录时先写入屏幕上已有的内容
            "sessionLog": { "auto": false, "dir": "", "format": "text", "timestamps": true, "includeScreen": true },
            // 文件「双击打开」临时副本的缓存根目录;空 = 默认(系统临时目录/NebulaShell-open)
            "openTempDir": "",
            // 自定义键位:动作名 → 键位 spec 数组;空对象 = 全部走内置默认。
            // 只存"覆盖项",设置页保存时整块替换。
            "keybindings": {},
            // 界面偏好:与主机数据无关的视图状态,单放一处避免污染 host 字段。
            // favoriteHostIds 存 id 而非写进 host —— 写进 host 要同步新建 shape /
            // merge_host 白名单 / 导出字段表 / 导入合并四处,漏任一处都是静默丢字段。
            "ui": { "favoriteHostIds": [], "collapsedGroups": [], "customGroups": [], "groupOrder": [], "hostDensity": "comfortable" },
            "clouds": {
                "tencent": { "key": "", "secret": "", "endpoint": "" },
                "aliyun": { "key": "", "secret": "", "endpoint": "" }
            }
        },
        "knownHosts": {}
    })
}

// ===== 命令历史清洗 =====

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

// Unix 原生 gethostname:零子进程。此前用 `hostname` 子进程取值,GUI 应用拉起
// CLI 工具会在部分 macOS 版本上闪出命令行窗口,而首次派生恰好落在"打开云账号
// 分区/点测试/存账号"这类交互时刻,非常突兀。字节兼容:CLI stdout 是
// "<hostname>\n",原生取值后补 '\n',既有密文无需迁移即可继续解开。
#[cfg(unix)]
extern "C" {
    fn gethostname(name: *mut std::ffi::c_char, len: usize) -> i32;
}

#[cfg(unix)]
fn hostname_material() -> Vec<u8> {
    const CAP: usize = 256;
    let mut buf = [0u8; CAP];
    // POSIX:名字超长会被截断且不保证 NUL 结尾,失败时返回非 0(与旧版子进程
    // 失败时不追加任何字节的行为一致)
    if unsafe { gethostname(buf.as_mut_ptr().cast(), CAP) } != 0 {
        return Vec::new();
    }
    let end = buf.iter().position(|&b| b == 0).unwrap_or(CAP);
    let mut out = buf[..end].to_vec();
    out.push(b'\n');
    out
}

// Windows 维持 hostname 子进程:CREATE_NO_WINDOW 下不会闪控制台;且其 stdout
// 换行为平台格式,改用环境变量重写会让旧密文解不开。
#[cfg(windows)]
fn hostname_material() -> Vec<u8> {
    let mut hostname_cmd = std::process::Command::new("hostname");
    crate::win32::no_window(&mut hostname_cmd);
    hostname_cmd.output().map(|o| o.stdout).unwrap_or_default()
}

fn machine_key_material() -> Vec<u8> {
    let mut material = Vec::new();
    material.extend_from_slice(b"nebulashell-v1");
    material.extend_from_slice(&hostname_material());
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
    static KEY: std::sync::OnceLock<[u8; 32]> = std::sync::OnceLock::new();
    *KEY.get_or_init(|| {
        use sha2::{Digest, Sha256};
        let mut hasher = Sha256::new();
        hasher.update(machine_key_material());
        hasher.update(b"credential-store-key");
        let d = hasher.finalize();
        let mut key = [0u8; 32];
        key.copy_from_slice(&d[..32]);
        key
    })
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
        // 会话日志(2026-10-11):老配置补默认值 —— 不自动记录、默认目录、纯文本、
        // 带时间戳、手动开始时写入屏幕已有内容
        if data["settings"]["sessionLog"].is_null() || !data["settings"]["sessionLog"].is_object() {
            data["settings"]["sessionLog"] = defaults()["settings"]["sessionLog"].clone();
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
                        "jumpIds": [], "initcmd": "", "sessionLog": "default",
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
            // 会话日志覆盖:default(跟随全局)/ always(总是自动记录)/ never(从不);
            // 非法值归一为 default,不报错 —— 编辑器之外的手改配置不该把保存卡死
            match input["sessionLog"].as_str() {
                Some("always") | Some("never") => {
                    host["sessionLog"] = input["sessionLog"].clone();
                }
                Some(_) | None => host["sessionLog"] = json!("default"),
            }
            // AI 访问策略:default / manual(只允许手动确认)/ deny(禁止);
            // 未传则保留原值,旧版编辑器保存时不会把策略冲掉
            match input["aiAccess"].as_str() {
                Some("manual") | Some("deny") => host["aiAccess"] = input["aiAccess"].clone(),
                Some(_) => host["aiAccess"] = json!("default"),
                None => {}
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

    /// 公开形态(不含明文凭据,带 hasPassword/passwordLen 等)
    pub fn public_host(&self, id: &str) -> Option<Value> {
        let data = self.data.lock().unwrap();
        let h = data["hosts"]
            .as_array()?
            .iter()
            .find(|h| h["id"] == *id)?
            .clone();
        let dec_stat = |f: &str| {
            let s = self.dec(h[format!("{}Enc", f)].as_str().unwrap_or(""));
            (!s.is_empty(), s.chars().count())
        };
        let (has_pw, pw_len) = dec_stat("password");
        let (has_key, _) = dec_stat("privateKey");
        let (has_pp, pp_len) = dec_stat("passphrase");
        let mut out = h.clone();
        out["hasPassword"] = json!(has_pw);
        out["passwordLen"] = json!(pw_len);
        out["hasKey"] = json!(has_key);
        out["hasPassphrase"] = json!(has_pp);
        out["passphraseLen"] = json!(pp_len);
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

    /// 批量删除:一次加锁、一次落盘,并清理跳板机对这种主机的悬空引用。
    /// 与 delete_host 的区别只是不重复写盘(100 台 = 1 次全量写而非 100 次)。
    pub fn delete_hosts(&self, ids: &[String]) -> Result<Value, String> {
        if ids.is_empty() {
            return Ok(json!({ "deleted": 0, "skipped": [] }));
        }
        let wanted: std::collections::HashSet<&str> = ids.iter().map(|s| s.as_str()).collect();
        let mut data = self.data.lock().unwrap();
        let hosts = data["hosts"].as_array_mut().ok_or("主机列表损坏")?;
        let before = hosts.len();
        let found: std::collections::HashSet<String> = hosts
            .iter()
            .filter_map(|h| h["id"].as_str())
            .filter(|id| wanted.contains(id))
            .map(String::from)
            .collect();
        hosts.retain(|h| {
            h["id"]
                .as_str()
                .map(|id| !wanted.contains(id))
                .unwrap_or(true)
        });
        let deleted = before - hosts.len();
        // 被删的主机可能还挂在别人的跳板链上:一并摘掉,且保持跳板图无环。
        if !found.is_empty() {
            for host in hosts.iter_mut() {
                if let Some(jumps) = host["jumpIds"].as_array_mut() {
                    jumps
                        .retain(|jump| jump.as_str().map(|id| !found.contains(id)).unwrap_or(true));
                }
            }
        }
        let skipped: Vec<Value> = ids
            .iter()
            .filter(|id| !found.contains(*id))
            .map(|id| json!({ "id": id, "reason": "主机不存在" }))
            .collect();
        drop(data);
        self.save()?;
        Ok(json!({ "deleted": deleted, "skipped": skipped }))
    }

    /// 重排主机顺序。顺序没有独立字段 —— 它就是 hosts 数组本身的次序
    /// (list_hosts 直接返回该数组,且没有任何逻辑依赖下标做持久化引用:
    /// 云端实例匹配用 provider+instanceId,跳板机引用用 id 字符串)。
    /// `ordered_ids` 里未出现的主机保持相对次序追加到末尾,保证不丢主机。
    pub fn reorder_hosts(&self, ordered_ids: &[String]) -> Result<usize, String> {
        let mut data = self.data.lock().unwrap();
        let hosts = data["hosts"].as_array().ok_or("主机列表损坏")?.clone();
        let mut by_id: std::collections::HashMap<&str, &Value> = std::collections::HashMap::new();
        for h in &hosts {
            if let Some(id) = h["id"].as_str() {
                by_id.insert(id, h);
            }
        }
        let mut out: Vec<Value> = Vec::with_capacity(hosts.len());
        let mut used: std::collections::HashSet<&str> = std::collections::HashSet::new();
        for id in ordered_ids {
            if let Some(host) = by_id.get(id.as_str()) {
                if used.insert(id.as_str()) {
                    out.push((*host).clone());
                }
            }
        }
        for h in &hosts {
            let keep = match h["id"].as_str() {
                Some(id) => !used.contains(id),
                None => true,
            };
            if keep {
                out.push(h.clone());
            }
        }
        let changed = out.len() == hosts.len()
            && out
                .iter()
                .zip(hosts.iter())
                .any(|(a, b)| a["id"] != b["id"]);
        data["hosts"] = json!(out);
        drop(data);
        if changed {
            self.save()?;
        }
        Ok(if changed { out.len() } else { 0 })
    }

    /// 批量更新分组 / 标签。一次加锁一次落盘 —— 循环调 save_host 会为每台主机
    /// 全量重写整份配置(含全部加密凭据),100 台即 100 次全量落盘。
    /// patch: { group?: string, addTags?: [string], removeTags?: [string] }
    /// 同一次调用里 add 先于 remove 应用,便于"打新标签并摘旧标签"。
    pub fn bulk_update_hosts(&self, ids: &[String], patch: &Value) -> Result<Value, String> {
        let group = patch["group"].as_str();
        let add_tags: Vec<String> = patch["addTags"]
            .as_array()
            .map(|a| {
                a.iter()
                    .filter_map(|t| t.as_str())
                    .map(str::trim)
                    .filter(|t| !t.is_empty())
                    .map(String::from)
                    .collect()
            })
            .unwrap_or_default();
        let remove_tags: Vec<String> = patch["removeTags"]
            .as_array()
            .map(|a| {
                a.iter()
                    .filter_map(|t| t.as_str())
                    .map(str::trim)
                    .filter(|t| !t.is_empty())
                    .map(String::from)
                    .collect()
            })
            .unwrap_or_default();
        if group.is_none() && add_tags.is_empty() && remove_tags.is_empty() {
            return Err("没有要更新的字段".into());
        }
        let wanted: std::collections::HashSet<&str> = ids.iter().map(|s| s.as_str()).collect();
        let mut data = self.data.lock().unwrap();
        let hosts = data["hosts"].as_array_mut().ok_or("主机列表损坏")?;
        let mut updated = 0;
        let mut found: std::collections::HashSet<String> = std::collections::HashSet::new();
        for host in hosts.iter_mut() {
            let id = match host["id"].as_str() {
                Some(id) if wanted.contains(id) => id.to_owned(),
                _ => continue,
            };
            found.insert(id);
            if let Some(g) = group {
                host["group"] = json!(g.trim());
            }
            if !add_tags.is_empty() || !remove_tags.is_empty() {
                let mut tags: Vec<String> = host["tags"]
                    .as_array()
                    .map(|a| {
                        a.iter()
                            .filter_map(|t| t.as_str())
                            .map(String::from)
                            .collect()
                    })
                    .unwrap_or_default();
                for t in &add_tags {
                    if !tags.iter().any(|x| x == t) {
                        tags.push(t.clone());
                    }
                }
                tags.retain(|t| !remove_tags.iter().any(|r| r == t));
                host["tags"] = json!(tags);
            }
            updated += 1;
        }
        let skipped: Vec<Value> = ids
            .iter()
            .filter(|id| !found.contains(*id))
            .map(|id| json!({ "id": id, "reason": "主机不存在" }))
            .collect();
        drop(data);
        if updated > 0 {
            self.save()?;
        }
        Ok(json!({ "updated": updated, "skipped": skipped }))
    }

    /// 克隆主机:副本**紧跟在原主机之后**,而不是追加到列表末尾 ——
    /// 侧栏与主机库里点「复制」后,新行应该就出现在眼皮底下。
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
        let created = self.save_host(&payload)?;
        // save_host 已 append 到末尾;这里把它挪到原主机身后。
        let new_id = created["id"].as_str().unwrap_or("").to_owned();
        if !new_id.is_empty() {
            let mut data = self.data.lock().unwrap();
            if let Some(hosts) = data["hosts"].as_array_mut() {
                if let Some(from) = hosts.iter().position(|h| h["id"] == json!(new_id)) {
                    let host = hosts.remove(from);
                    let at = hosts
                        .iter()
                        .position(|h| h["id"] == json!(id))
                        .map(|i| i + 1)
                        .unwrap_or(hosts.len());
                    hosts.insert(at, host);
                }
            }
            drop(data);
            self.save()?;
        }
        self.public_host(&new_id)
            .ok_or_else(|| "克隆后读取失败".to_string())
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
                        "sessionLog": h["sessionLog"].as_str().unwrap_or("default"),
                        "aiAccess": h["aiAccess"].as_str().unwrap_or("default"),
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
        let api_key = self.dec(ai["apiKeyEnc"].as_str().unwrap_or(""));
        let api_key_set = !api_key.is_empty();
        let api_key_len = api_key.chars().count();
        json!({
            "ai": {
                "provider": ai["provider"], "protocol": ai["protocol"], "baseUrl": ai["baseUrl"],
                "model": ai["model"], "models": ai["models"], "toolSupport": ai["toolSupport"],
                "apiKeySet": api_key_set,
                "apiKeyLen": api_key_len
            },
            "terminal": data["settings"]["terminal"].clone(),
            "openTempDir": data["settings"]["openTempDir"].clone(),
            // 设置页默认目录提示用(空 = 系统临时目录,与 open_temp_dir 的兜底一致)
            "openTempDirDefaultDir": std::env::temp_dir().to_string_lossy().to_string(),
            "sessionLog": data["settings"]["sessionLog"].clone(),
            // 自定义键位(动作名 → 键位数组);空对象 = 全部走内置默认
            "keybindings": data["settings"]["keybindings"].clone(),
            // 界面偏好(收藏主机 / 折叠的分组 / 列表密度)。旧配置文件没有该键时
            // 给默认值,避免前端拿到 null 后各处判空。
            "ui": if data["settings"]["ui"].is_object() {
                data["settings"]["ui"].clone()
            } else {
                json!({ "favoriteHostIds": [], "collapsedGroups": [], "hostDensity": "comfortable", "groupOrder": [] })
            },
            // 设置页默认目录提示用(实际取目录走 commands 的 default_log_dir,
            // 那里还要考虑测试模式隔离)
            "sessionLogDefaultDir": dirs::home_dir()
                .map(|h| h.join("NebulaShell-logs").to_string_lossy().to_string())
                .unwrap_or_default(),
            "snippets": data["snippets"].clone(),
            // 多账号云凭据:公开形态不回传 Secret,只给 keyId/是否已存/长度
            // (前端按实际长度渲染 • 掩码,与主机弹窗密钥显示规范一致;
            // 明文只在用户点眼睛时经 cloud:revealSecret 按需单取)
            "cloudAccounts": data["settings"]["cloudAccounts"]
                .as_array()
                .cloned()
                .unwrap_or_default()
                .iter()
                .map(|a| {
                    let secret_len = self.dec(a["secretEnc"].as_str().unwrap_or("")).len();
                    json!({
                        "id": a["id"], "label": a["label"], "vendor": a["vendor"],
                        "keyId": a["keyId"], "endpoint": a["endpoint"],
                        "secretSet": secret_len > 0,
                        "secretLen": secret_len,
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
        let removed = (before - accounts.len()) as i64;
        if removed > 0 {
            // P2: 清理主机对已删除账号的绑定引用，避免换号重新导入时因旧 accountId 导致实例被当成不同机器而重复创建
            if let Some(hosts) = data["hosts"].as_array_mut() {
                for h in hosts.iter_mut() {
                    if let Some(cloud) = h.get_mut("cloud") {
                        if cloud.get("accountId").and_then(|v| v.as_str()) == Some(id) {
                            cloud["accountId"] = json!(null);
                        }
                    }
                }
            }
        }
        Ok(removed)
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

    /// 校验并规范化 sessionLog 设置里需要先验证的字段:
    /// 目录展开 `~` 并要求绝对路径,format 只接受 text/raw。
    /// 返回可安全合并的键值(其余布尔键原样放行)。
    fn sanitize_session_log_patch(patch: &Value) -> Result<Value, String> {
        let Some(sl) = patch["sessionLog"].as_object() else {
            return Ok(json!(null));
        };
        let mut out = serde_json::Map::new();
        for key in ["auto", "timestamps", "includeScreen"] {
            if let Some(v) = sl.get(key) {
                if !v.is_null() {
                    out.insert(key.to_string(), json!(v.as_bool().unwrap_or(false)));
                }
            }
        }
        if let Some(v) = sl.get("dir") {
            if !v.is_null() {
                let raw = v.as_str().unwrap_or("").trim().to_string();
                let dir = if raw == "~" {
                    dirs::home_dir()
                        .map(|h| h.to_string_lossy().to_string())
                        .unwrap_or_default()
                } else if let Some(rest) = raw.strip_prefix("~/") {
                    match dirs::home_dir() {
                        Some(h) => h.join(rest).to_string_lossy().to_string(),
                        None => raw,
                    }
                } else {
                    raw
                };
                if !dir.is_empty() && !std::path::Path::new(&dir).is_absolute() {
                    return Err("日志目录必须是绝对路径".into());
                }
                out.insert("dir".to_string(), json!(dir));
            }
        }
        if let Some(v) = sl.get("format") {
            if !v.is_null() {
                match v.as_str() {
                    Some("text") | Some("raw") => out.insert("format".to_string(), v.clone()),
                    _ => return Err("内容格式只支持 text（纯文本）或 raw（原始终端流）".into()),
                };
            }
        }
        Ok(json!(out))
    }

    /// 校验并规范化 keybindings 补丁:动作名 → 键位 spec(单个字符串或数组)。
    /// 按项合并:有合法键位的项写入覆盖,null / 空数组 / 全是非法键位表示
    /// 恢复该项默认(从存储里删掉)。未提及的动作保持原样,避免其它调用方
    /// 传局部补丁时误清数据。
    /// 这里只做字符与长度层面的白名单——动作名是否有效、键位是否冲突属于
    /// 前端的语义校验(后端不认识命令注册表),只保证坏数据进不了磁盘。
    /// 返回 None 表示补丁里没有该分区。
    fn sanitize_keybindings_patch(patch: &Value) -> Option<Vec<(String, Option<Value>)>> {
        let kb = patch.get("keybindings")?.as_object()?;
        let mut out: Vec<(String, Option<Value>)> = Vec::new();
        for (action, raw) in kb.iter().take(200) {
            // 动作名形如 'tab.new' / 'session.log.folder'
            let valid_id = action.len() <= 64
                && action.starts_with(|c: char| c.is_ascii_lowercase())
                && action
                    .chars()
                    .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '.' || c == '-');
            if !valid_id {
                continue;
            }
            let list: Vec<&Value> = match raw {
                Value::Array(a) => a.iter().collect(),
                Value::Null => vec![],
                other => vec![other],
            };
            let mut specs: Vec<String> = Vec::new();
            for item in list {
                let Some(text) = item.as_str() else { continue };
                let spec = text.trim().to_lowercase();
                let ok = !spec.is_empty()
                    && spec.len() <= 40
                    && spec.chars().all(|c| {
                        c.is_ascii_lowercase() || c.is_ascii_digit() || "+-.,;'[]/=\\` ".contains(c)
                    });
                if ok && !specs.contains(&spec) {
                    specs.push(spec);
                }
                if specs.len() == 3 {
                    break;
                }
            }
            // 空结果 = 恢复默认(删除该覆盖项)
            out.push((action.clone(), (!specs.is_empty()).then(|| json!(specs))));
        }
        Some(out)
    }

    pub fn save_settings(&self, patch: &Value) -> Result<Value, String> {
        let session_log = Self::sanitize_session_log_patch(patch)?;
        let keybindings = Self::sanitize_keybindings_patch(patch);
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
                if ["nebula", "light"].contains(&v.as_str().unwrap_or("")) {
                    term["theme"] = v.clone();
                }
            }
        }
        // 双击打开临时目录:trim 后存;留空表示恢复默认(系统临时目录)
        if let Some(v) = patch["openTempDir"].as_str() {
            data["settings"]["openTempDir"] = json!(v.trim());
        }
        // 会话日志:先经 sanitize(见上),null 表示未传该分区
        if !session_log.is_null() {
            for (key, value) in session_log.as_object().unwrap() {
                data["settings"]["sessionLog"][key] = value.clone();
            }
        }
        // 自定义键位:按项合并,null/空 = 恢复该项默认(删掉覆盖项)。
        if let Some(kb) = keybindings {
            for (action, value) in kb {
                match value {
                    Some(specs) => data["settings"]["keybindings"][&action] = specs,
                    None => {
                        if let Some(map) = data["settings"]["keybindings"].as_object_mut() {
                            map.remove(&action);
                        }
                    }
                }
            }
        }
        // 界面偏好:逐键按白名单清洗后合并。数组去重并限长(收藏/折叠都是 UI 状态,
        // 无限增长只会让配置变大);hostDensity 只接受两个合法值,其余归一为默认。
        if let Some(ui) = patch["ui"].as_object() {
            if data["settings"]["ui"].is_null() || !data["settings"]["ui"].is_object() {
                data["settings"]["ui"] = json!({ "favoriteHostIds": [], "collapsedGroups": [], "customGroups": [], "groupOrder": [], "hostDensity": "comfortable" });
            }
            for key in ["favoriteHostIds", "collapsedGroups", "customGroups", "groupOrder"] {
                if let Some(arr) = ui.get(key).and_then(Value::as_array) {
                    let mut seen = std::collections::HashSet::new();
                    let cleaned: Vec<Value> = arr
                        .iter()
                        .filter_map(|v| v.as_str())
                        .filter(|s| !s.is_empty())
                        .filter(|s| seen.insert((*s).to_owned()))
                        .take(2000)
                        .map(|s| json!(s))
                        .collect();
                    data["settings"]["ui"][key] = json!(cleaned);
                }
            }
            if let Some(v) = ui.get("hostDensity") {
                let density = match v.as_str() {
                    Some("compact") => "compact",
                    _ => "comfortable",
                };
                data["settings"]["ui"]["hostDensity"] = json!(density);
            }
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
            // 各模型是否支持工具调用(键为 "baseUrl::model"),由前端探测后回写。
            if let Some(v) = ai.get("toolSupport").filter(|v| v.is_object()) {
                out["toolSupport"] = v.clone();
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
        drop(data);
        self.save().ok();
        Ok(self.get_settings())
    }

    pub fn list_fingerprints_for_test(&self) -> Vec<Value> {
        let data = self.data.lock().unwrap();
        data["knownHosts"]
            .as_object()
            .map(|m| m.iter().map(|(k, v)| json!({ "id": k, "fp": v })).collect())
            .unwrap_or_default()
    }
}
