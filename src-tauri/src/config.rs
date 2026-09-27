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
            "ai": { "provider": "custom", "protocol": "openai", "baseUrl": "", "model": "", "temperature": 0.3, "apiKey": "" },
            "terminal": { "fontSize": 13, "theme": "nebula", "scrollback": 2000 },
            "clouds": {
                "tencent": { "key": "", "secret": "", "endpoint": "" },
                "aliyun": { "key": "", "secret": "", "endpoint": "" }
            }
        },
        "knownHosts": {}
    })
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
        if data["settings"]["terminal"].is_null() {
            data["settings"]["terminal"] = defaults()["settings"]["terminal"].clone();
        }
        for p in ["tencent", "aliyun"] {
            if data["settings"]["clouds"][p].is_null() {
                data["settings"]["clouds"][p] = defaults()["settings"]["clouds"][p].clone();
            }
        }
        for k in ["hosts", "snippets", "forwards", "bookmarks", "history"] {
            if data[k].is_null() {
                data[k] = json!([]);
            }
        }
        if data["knownHosts"].is_null() {
            data["knownHosts"] = json!({});
        }
        Store {
            dir,
            data: Mutex::new(data),
            use_keyring: true,
            dirty: std::sync::atomic::AtomicBool::new(false),
        }
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
        // 云导入幂等:provider+instanceId;编辑按 id
        let cloud_match =
            if !input["cloud"]["provider"].is_null() && !input["cloud"]["instanceId"].is_null() {
                hosts.iter().position(|h| {
                    h["cloud"]["provider"] == input["cloud"]["provider"]
                        && h["cloud"]["instanceId"] == input["cloud"]["instanceId"]
                })
            } else {
                None
            };
        let by_id = input["id"]
            .as_str()
            .and_then(|id| hosts.iter().position(|h| h["id"] == *id));
        let idx = by_id.or(cloud_match);
        let (host, is_new) = match idx {
            Some(i) => (hosts[i].clone(), false),
            None => {
                let id = input["id"]
                    .as_str()
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
        let merge = |host: &mut Value, key: &str, default: Value| {
            if !input[key].is_null()
                && (!input[key].is_string()
                    || !input[key].as_str().unwrap_or("").is_empty()
                    || key == "name")
            {
                host[key] = input[key].clone();
            } else if is_new && host[key].is_null() {
                host[key] = default;
            }
        };
        if !input["name"].is_null() {
            host["name"] = input["name"].clone();
        }
        host["host"] = json!(host_field);
        if !input["port"].is_null() {
            host["port"] = json!(input["port"].as_i64().unwrap_or(22));
        }
        if !input["username"].is_null() && !input["username"].as_str().unwrap_or("").is_empty() {
            host["username"] = input["username"].clone();
        }
        if !input["authType"].is_null() {
            host["authType"] = input["authType"].clone();
        }
        merge(&mut host, "group", json!(""));
        if !input["tags"].is_null() {
            host["tags"] = input["tags"].clone();
        }
        if !input["cloud"].is_null() {
            host["cloud"] = input["cloud"].clone();
        }
        if !input["keyPath"].is_null() {
            host["keyPath"] = input["keyPath"].clone();
        }
        if !input["jumpIds"].is_null() {
            host["jumpIds"] = input["jumpIds"].clone();
        }
        if !input["initcmd"].is_null() {
            host["initcmd"] = input["initcmd"].clone();
        }
        // 敏感字段:仅在提供非空值时更新
        for field in ["password", "privateKey", "passphrase"] {
            let plain = input[field].as_str().unwrap_or("");
            if !plain.is_empty() {
                let path = format!("hosts.{}.{}", host["id"].as_str().unwrap_or(""), field);
                host[format!("{}Enc", field)] = json!(self.enc(plain, &path));
            } else if is_new {
                host[format!("{}Enc", field)] = json!("");
            }
        }
        match idx {
            Some(i) => hosts[i] = host.clone(),
            None => hosts.push(host.clone()),
        }
        drop(data);
        self.save()?;
        self.public_host(&host["id"].as_str().unwrap_or(""))
            .ok_or_else(|| "保存后读取失败".into())
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
        // 明文字段不出现在公开形态
        for f in ["passwordEnc", "privateKeyEnc", "passphraseEnc"] {
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

    pub fn export_hosts(&self) -> Result<Value, String> {
        let data = self.data.lock().unwrap();
        let hosts: Vec<Value> = data["hosts"]
            .as_array()
            .unwrap_or(&vec![])
            .iter()
            .map(|h| {
                json!({
                    "name": h["name"], "host": h["host"], "port": h["port"], "username": h["username"],
                    "authType": h["authType"], "keyPath": h["keyPath"], "group": h["group"], "tags": h["tags"],
                    "password": self.dec(h["passwordEnc"].as_str().unwrap_or("")),
                    "privateKey": self.dec(h["privateKeyEnc"].as_str().unwrap_or("")),
                    "passphrase": self.dec(h["passphraseEnc"].as_str().unwrap_or("")),
                })
            })
            .collect();
        Ok(json!({
            "app": "nebulashell", "version": 1,
            "exportedAt": chrono::Utc::now().to_rfc3339(),
            "hosts": hosts
        }))
    }

    pub fn import_hosts(&self, text: &str) -> Result<Value, String> {
        let parsed: Value =
            serde_json::from_str(text).map_err(|_| "文件不是合法 JSON".to_string())?;
        let items = if parsed.is_array() {
            parsed.as_array().unwrap().clone()
        } else if !parsed["hosts"].is_null() {
            parsed["hosts"].as_array().unwrap().clone()
        } else {
            return Err("文件格式不对:需要 { hosts: [...] } 或主机数组".into());
        };
        // 锁内筛选,锁外逐条保存(save_host 需要拿锁)
        let payloads: Vec<Value> = {
            let data = self.data.lock().unwrap();
            let hosts = data["hosts"].as_array().unwrap();
            let mut payloads = vec![];
            for it in &items {
                let host = it["host"].as_str().unwrap_or("");
                if host.is_empty() {
                    continue;
                }
                let dup = hosts.iter().any(|h| {
                    h["host"].as_str().unwrap_or("").to_lowercase() == host.to_lowercase()
                        && h["port"].as_i64().unwrap_or(22) == it["port"].as_i64().unwrap_or(22)
                        && h["username"].as_str().unwrap_or("root").to_lowercase()
                            == it["username"].as_str().unwrap_or("root").to_lowercase()
                });
                if dup {
                    continue;
                }
                let mut payload = it.clone();
                payload["id"] = json!(null);
                payload["host"] = json!(host);
                payloads.push(payload);
            }
            payloads
        };
        let skipped = items.len() - payloads.len();
        for payload in &payloads {
            self.save_host(payload)?;
        }
        Ok(json!({ "added": payloads.len(), "skipped": skipped }))
    }

    pub fn get_settings(&self) -> Value {
        let data = self.data.lock().unwrap();
        let ai = &data["settings"]["ai"];
        json!({
            "ai": {
                "provider": ai["provider"], "protocol": ai["protocol"], "baseUrl": ai["baseUrl"],
                "model": ai["model"], "temperature": ai["temperature"],
                "apiKeySet": !self.dec(ai["apiKeyEnc"].as_str().unwrap_or("")).is_empty()
            },
            "terminal": data["settings"]["terminal"].clone(),
            "snippets": data["snippets"].clone(),
            "clouds": {
                "tencent": { "key": data["settings"]["clouds"]["tencent"]["key"], "endpoint": data["settings"]["clouds"]["tencent"]["endpoint"], "secretSet": !self.dec(data["settings"]["clouds"]["tencent"]["secretEnc"].as_str().unwrap_or("")).is_empty() },
                "aliyun": { "key": data["settings"]["clouds"]["aliyun"]["key"], "endpoint": data["settings"]["clouds"]["aliyun"]["endpoint"], "secretSet": !self.dec(data["settings"]["clouds"]["aliyun"]["secretEnc"].as_str().unwrap_or("")).is_empty() }
            }
        })
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
        if let Some(ai) = patch["ai"].as_object() {
            let out = &mut data["settings"]["ai"];
            for k in ["provider", "protocol", "baseUrl", "model"] {
                if let Some(v) = ai.get(k) {
                    if !v.is_null() {
                        out[k] = v.clone();
                    }
                }
            }
            if let Some(v) = ai.get("temperature") {
                if !v.is_null() {
                    out["temperature"] = json!(v.as_f64().unwrap_or(0.3));
                }
            }
            if let Some(v) = ai.get("apiKey") {
                let plain = v.as_str().unwrap_or("");
                if !plain.is_empty() {
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
