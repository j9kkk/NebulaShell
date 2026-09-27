// 云厂商实例查询:腾讯云 CVM/轻量(TC3 签名)+ 阿里云 ECS(RPC V1)
use crate::signing::*;
use serde_json::{json, Value};

fn http_client() -> reqwest::Client {
    reqwest::Client::new()
}

pub async fn tencent_call(
    secret_id: &str,
    secret_key: &str,
    service: &str,
    action: &str,
    version: &str,
    region: &str,
    payload: Value,
    endpoint: &str,
) -> Result<Value, String> {
    let base = if !endpoint.trim().is_empty() {
        endpoint.trim().trim_end_matches('/').to_string()
    } else if service == "lighthouse" {
        "https://lighthouse.tencentcloudapi.com".to_string()
    } else {
        "https://cvm.tencentcloudapi.com".to_string()
    };
    let host = reqwest::Url::parse(&base)
        .map_err(|e| e.to_string())?
        .host_str()
        .unwrap_or("")
        .to_string();
    let timestamp = chrono::Utc::now().timestamp();
    let date = chrono::DateTime::from_timestamp(timestamp, 0)
        .unwrap_or_default()
        .format("%Y-%m-%d")
        .to_string();
    let payload_str = serde_json::to_string(&payload).unwrap_or_else(|_| "{}".into());
    let canonical = tencent_build_canonical_request(&host, action, &payload_str);
    let sts = tencent_string_to_sign(timestamp, &date, service, &canonical);
    let k = tencent_signing_key(secret_key, &date, service);
    let signature = tencent_signature(&k, &sts);
    let authorization = format!(
        "TC3-HMAC-SHA256 Credential={}/{}/{}/tc3_request, SignedHeaders=content-type;host;x-tc-action, Signature={}",
        secret_id, date, service, signature
    );
    let res = http_client()
        .post(format!("{}/", base))
        .header("Content-Type", "application/json; charset=utf-8")
        .header("X-TC-Action", action)
        .header("X-TC-Version", version)
        .header("X-TC-Region", region)
        .header("X-TC-Timestamp", timestamp.to_string())
        .header("Authorization", authorization)
        .body(payload_str)
        .send()
        .await
        .map_err(|e| format!("腾讯云请求失败: {}", e))?;
    let text = res.text().await.map_err(|e| e.to_string())?;
    let json: Value = serde_json::from_str(&text)
        .map_err(|_| format!("腾讯云响应解析失败: {}", &text[..text.len().min(200)]))?;
    if !json["Response"]["Error"].is_null() {
        return Err(format!(
            "腾讯云 API 错误 {}: {}",
            json["Response"]["Error"]["Code"].as_str().unwrap_or(""),
            json["Response"]["Error"]["Message"].as_str().unwrap_or("")
        ));
    }
    Ok(json["Response"].clone())
}

pub async fn tencent_describe_instances(
    secret_id: &str,
    secret_key: &str,
    service: &str,
    region: &str,
    endpoint: &str,
) -> Result<Vec<Value>, String> {
    let version = if service == "lighthouse" {
        "2020-03-24"
    } else {
        "2017-03-12"
    };
    let resp = tencent_call(
        secret_id,
        secret_key,
        service,
        "DescribeInstances",
        version,
        region,
        json!({ "Limit": 100, "Offset": 0 }),
        endpoint,
    )
    .await?;
    let provider = service.to_string();
    Ok(map_tencent_instances(&resp, &provider, region))
}

fn map_tencent_instances(resp: &Value, provider: &str, region: &str) -> Vec<Value> {
    let list = resp["InstanceSet"].as_array().cloned().unwrap_or_default();
    list.iter()
        .map(|i| {
            let host = i["PublicIpAddresses"][0]
                .as_str()
                .or_else(|| i["PrivateIpAddresses"][0].as_str())
                .unwrap_or("");
            let os = i["OsName"].as_str().unwrap_or("");
            json!({
                "name": i["InstanceName"].as_str().unwrap_or_else(|| i["InstanceId"].as_str().unwrap_or("")),
                "host": host, "port": 22,
                "username": if os.to_lowercase().contains("windows") { "Administrator" } else { "root" },
                "state": i["InstanceState"],
                "cloud": { "provider": provider, "region": region, "instanceId": i["InstanceId"], "os": os }
            })
        })
        .collect()
}

pub async fn aliyun_call(
    access_key_id: &str,
    access_key_secret: &str,
    action: &str,
    region: &str,
    endpoint: &str,
    extra: Value,
) -> Result<Value, String> {
    if access_key_id.is_empty() || access_key_secret.is_empty() {
        return Err("请填写阿里云 AccessKeyId / AccessKeySecret".into());
    }
    let mut params = serde_json::Map::new();
    params.insert("AccessKeyId".into(), json!(access_key_id));
    params.insert("Action".into(), json!(action));
    params.insert("Format".into(), json!("JSON"));
    params.insert("RegionId".into(), json!(region));
    params.insert("SignatureMethod".into(), json!("HMAC-SHA1"));
    params.insert(
        "SignatureNonce".into(),
        json!(uuid::Uuid::new_v4().to_string()),
    );
    params.insert("SignatureVersion".into(), json!("1.0"));
    params.insert(
        "Timestamp".into(),
        json!(chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true)),
    );
    params.insert("Version".into(), json!("2014-05-26"));
    if let Some(extra) = extra.as_object() {
        for (k, v) in extra {
            params.insert(k.clone(), v.clone());
        }
    }
    let canonical = aliyun_canonical_query(&params);
    let signature = aliyun_sign(&aliyun_string_to_sign(&canonical), access_key_secret);
    let qs = format!(
        "{}&Signature={}",
        canonical,
        aliyun_percent_encode(&signature)
    );
    let base = if endpoint.trim().is_empty() {
        "https://ecs.aliyuncs.com"
    } else {
        endpoint.trim().trim_end_matches('/')
    };
    let res = http_client()
        .get(format!("{}/?{}", base, qs))
        .send()
        .await
        .map_err(|e| format!("阿里云请求失败: {}", e))?;
    let text = res.text().await.map_err(|e| e.to_string())?;
    let json: Value = serde_json::from_str(&text)
        .map_err(|_| format!("阿里云响应解析失败: {}", &text[..text.len().min(200)]))?;
    if !json["Code"].is_null() {
        return Err(format!(
            "阿里云 API 错误 {}: {}",
            json["Code"].as_str().unwrap_or(""),
            json["Message"].as_str().unwrap_or("")
        ));
    }
    Ok(json)
}

pub async fn aliyun_describe_instances(
    access_key_id: &str,
    access_key_secret: &str,
    region: &str,
    endpoint: &str,
) -> Result<Vec<Value>, String> {
    let json = aliyun_call(
        access_key_id,
        access_key_secret,
        "DescribeInstances",
        region,
        endpoint,
        json!({ "PageSize": 100, "PageNumber": 1 }),
    )
    .await?;
    let list = json["Instances"]["Instance"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    Ok(list
        .iter()
        .map(|i| {
            let host = i["PublicIpAddress"]["IpAddress"][0]
                .as_str()
                .or_else(|| i["EipAddress"]["IpAddress"].as_str())
                .or_else(|| i["VpcAttributes"]["PrivateIpAddress"]["IpAddress"][0].as_str())
                .unwrap_or("");
            let os = i["OSName"].as_str().unwrap_or("");
            json!({
                "name": i["InstanceName"].as_str().unwrap_or_else(|| i["InstanceId"].as_str().unwrap_or("")),
                "host": host, "port": 22,
                "username": if os.to_lowercase().contains("windows") { "Administrator" } else { "root" },
                "state": i["Status"],
                "cloud": { "provider": "aliyun", "region": region, "instanceId": i["InstanceId"], "os": os }
            })
        })
        .collect())
}
