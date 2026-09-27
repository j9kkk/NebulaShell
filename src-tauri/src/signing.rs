// 云厂商签名:腾讯云 TC3-HMAC-SHA256 与 阿里云 RPC V1(HMAC-SHA1),纯函数可单测
use hmac::{Hmac, Mac};
use serde_json::Value;
use sha1::Sha1;
use sha2::{Digest, Sha256};

pub fn sha256_hex(s: &str) -> String {
    let mut h = Sha256::new();
    h.update(s.as_bytes());
    hex(&h.finalize())
}

pub fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{:02x}", x)).collect()
}

fn hmac_sha256(key: &[u8], msg: &[u8]) -> Vec<u8> {
    let mut m = Hmac::<Sha256>::new_from_slice(key).expect("hmac key");
    m.update(msg);
    m.finalize().into_bytes().to_vec()
}

fn hmac_sha1_b64(key: &[u8], msg: &[u8]) -> String {
    use base64::Engine;
    let mut m = Hmac::<Sha1>::new_from_slice(key).expect("hmac key");
    m.update(msg);
    base64::engine::general_purpose::STANDARD.encode(m.finalize().into_bytes())
}

// —— 腾讯云 TC3 —— 

pub fn tencent_build_canonical_request(host: &str, action: &str, payload_str: &str) -> String {
    let canonical_headers = format!(
        "content-type:application/json; charset=utf-8\nhost:{}\nx-tc-action:{}\n",
        host,
        action.to_lowercase()
    );
    [
        "POST",
        "/",
        "",
        &canonical_headers,
        "content-type;host;x-tc-action",
        &sha256_hex(payload_str),
    ]
    .join("\n")
}

pub fn tencent_string_to_sign(timestamp: i64, date: &str, service: &str, canonical_request: &str) -> String {
    [
        "TC3-HMAC-SHA256",
        &timestamp.to_string(),
        &format!("{}/{}/tc3_request", date, service),
        &sha256_hex(canonical_request),
    ]
    .join("\n")
}

pub fn tencent_signing_key(secret_key: &str, date: &str, service: &str) -> Vec<u8> {
    let k_date = hmac_sha256(format!("TC3{}", secret_key).as_bytes(), date.as_bytes());
    let k_service = hmac_sha256(&k_date, service.as_bytes());
    hmac_sha256(&k_service, b"tc3_request")
}

pub fn tencent_signature(k_signing: &[u8], string_to_sign: &str) -> String {
    hex(&hmac_sha256(k_signing, string_to_sign.as_bytes()))
}

// —— 阿里云 RPC V1 —— 

pub fn aliyun_percent_encode(s: &str) -> String {
    // RFC3986:保留 A-Za-z0-9-_.~,其余 percent-encode(!'()* 转大写十六进制,空格 %20)
    let mut out = String::new();
    for b in s.bytes() {
        let c = b as char;
        if c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | '~') {
            out.push(c);
        } else {
            out.push_str(&format!("%{:02X}", b));
        }
    }
    out
}

pub fn aliyun_canonical_query(params: &serde_json::Map<String, Value>) -> String {
    let mut pairs: Vec<(String, String)> = params
        .iter()
        .map(|(k, v)| (k.clone(), value_to_str(v)))
        .collect();
    pairs.sort();
    pairs
        .iter()
        .map(|(k, v)| format!("{}={}", aliyun_percent_encode(k), aliyun_percent_encode(v)))
        .collect::<Vec<_>>()
        .join("&")
}

pub fn aliyun_string_to_sign(canonical_query: &str) -> String {
    format!("GET&{}&{}", aliyun_percent_encode("/"), aliyun_percent_encode(canonical_query))
}

pub fn aliyun_sign(string_to_sign: &str, access_key_secret: &str) -> String {
    hmac_sha1_b64(format!("{}&", access_key_secret).as_bytes(), string_to_sign.as_bytes())
}

pub fn value_to_str(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Null => String::new(),
        other => other.to_string(),
    }
}
