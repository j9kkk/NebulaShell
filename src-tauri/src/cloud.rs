// 云厂商实例查询:腾讯云 CVM/轻量(TC3 签名)+ 阿里云 ECS(RPC V1)
// - 区域自动探测(DescribeRegions),不再要求用户逐个选择;
//   腾讯云 CVM 与轻量各自探测自己的地域表,防两表不一致漏地域
// - 全区域并发分页拉取;单区域失败不阻断整体(结果里带 errors 供前端提示)
// - 腾讯云一次拉取 CVM + 轻量两类实例(lighthouse 与 CVM 共用密钥)
// - 凭据校验与"拉取全部"走同一条全量扫描路径,校验报出的数字即真实拉取结果
use crate::signing::*;
use serde_json::{json, Value};
use std::sync::Arc;
use tokio::sync::Semaphore;

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
    let mut req = http_client()
        .post(format!("{}/", base))
        .header("Content-Type", "application/json; charset=utf-8")
        .header("X-TC-Action", action)
        .header("X-TC-Version", version)
        .header("X-TC-Region", region)
        .header("X-TC-Timestamp", timestamp.to_string())
        .header("Authorization", authorization);
    // 自定义 endpoint(测试/私有化)时附带 service 标识:真实 API 忽略未知头
    // (TC3 签名只覆盖 content-type/host/x-tc-action),mock 依赖它区分服务。
    if !endpoint.trim().is_empty() {
        req = req.header("X-Mock-Service", service);
    }
    let res = req
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

/// 腾讯云区域探测(DescribeRegions):返回 (region, name) 列表。
/// CVM 与 Lighthouse 各有一张地域表且不保证一致,两侧必须分别探测
/// (见 tencent_lighthouse_regions),不能只沿用其中一张。
pub async fn tencent_regions(
    secret_id: &str,
    secret_key: &str,
    endpoint: &str,
) -> Result<Vec<(String, String)>, String> {
    let resp = tencent_call(
        secret_id,
        secret_key,
        "cvm",
        "DescribeRegions",
        "2017-03-12",
        "ap-guangzhou",
        json!({}),
        endpoint,
    )
    .await?;
    Ok(parse_tencent_regions(&resp))
}

/// 轻量应用服务器自己的地域表(DescribeRegions)。与 CVM 的地域表不保证
/// 一致 —— 只用 CVM 的列表可能漏掉仅轻量覆盖/售卖的地域(如部分海外地域)。
pub async fn tencent_lighthouse_regions(
    secret_id: &str,
    secret_key: &str,
    endpoint: &str,
) -> Result<Vec<(String, String)>, String> {
    let resp = tencent_call(
        secret_id,
        secret_key,
        "lighthouse",
        "DescribeRegions",
        "2020-03-24",
        "ap-guangzhou",
        json!({}),
        endpoint,
    )
    .await?;
    Ok(parse_tencent_regions(&resp))
}

/// 解析腾讯云 DescribeRegions 响应(CVM 与 Lighthouse 的响应同构:
/// RegionSet[] 里 Region/RegionName),空 region 条目丢弃。
pub(crate) fn parse_tencent_regions(resp: &Value) -> Vec<(String, String)> {
    resp["RegionSet"]
        .as_array()
        .cloned()
        .unwrap_or_default()
        .iter()
        .filter_map(|r| {
            let region = r["Region"].as_str().unwrap_or("").to_string();
            let name = r["RegionName"].as_str().unwrap_or("").to_string();
            if region.is_empty() {
                None
            } else {
                Some((region, name))
            }
        })
        .collect()
}

/// 两张地域表的并集大小(按 region id 去重),校验结果的地域数口径。
pub(crate) fn union_region_count(cvm: &[(String, String)], lh: &[(String, String)]) -> usize {
    cvm.iter()
        .chain(lh.iter())
        .map(|(r, _)| r.as_str())
        .collect::<std::collections::BTreeSet<_>>()
        .len()
}

/// 探测两侧地域表。轻量表探测失败不阻断整体 —— 退回用 CVM 的表
/// (与旧行为一致),轻量的逐区域调用会自行报错。
async fn tencent_region_lists(
    secret_id: &str,
    secret_key: &str,
    endpoint: &str,
) -> Result<(Vec<(String, String)>, Vec<(String, String)>), String> {
    let cvm = tencent_regions(secret_id, secret_key, endpoint).await?;
    let lh = tencent_lighthouse_regions(secret_id, secret_key, endpoint)
        .await
        .unwrap_or_else(|_| cvm.clone());
    Ok((cvm, lh))
}

/// 阿里云区域探测(DescribeRegions):返回 (region, name) 列表。
pub async fn aliyun_regions(
    access_key_id: &str,
    access_key_secret: &str,
    endpoint: &str,
) -> Result<Vec<(String, String)>, String> {
    let resp = aliyun_call(
        access_key_id,
        access_key_secret,
        "DescribeRegions",
        "cn-hangzhou",
        endpoint,
        json!({}),
    )
    .await?;
    let mut out = Vec::new();
    for r in resp["Regions"]["Region"]
        .as_array()
        .cloned()
        .unwrap_or_default()
    {
        let region = r["RegionId"].as_str().unwrap_or("").to_string();
        let name = r["LocalName"].as_str().unwrap_or("").to_string();
        if !region.is_empty() {
            out.push((region, name));
        }
    }
    Ok(out)
}

/// 腾讯云单区域拉全(分页;Limit 上限 100,防御性上限 50 页)
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
    let mut all: Vec<Value> = Vec::new();
    let mut offset: i64 = 0;
    loop {
        let resp = tencent_call(
            secret_id,
            secret_key,
            service,
            "DescribeInstances",
            version,
            region,
            json!({ "Limit": 100, "Offset": offset }),
            endpoint,
        )
        .await?;
        let page = resp["InstanceSet"].as_array().cloned().unwrap_or_default();
        let got = page.len() as i64;
        all.extend(map_tencent_instances(&resp, service, region));
        if got < 100 || offset > 5000 {
            break;
        }
        offset += got;
    }
    Ok(all)
}

/// 按服务各自的地域表并发分页拉取:返回 (实例, 错误, 至少一个区域成功过的服务)。
/// 凭据校验与"拉取全部"共用本函数,保证两处范围、过滤与行为完全一致。
async fn tencent_scan(
    secret_id: &str,
    secret_key: &str,
    cvm_regions: &[(String, String)],
    lh_regions: &[(String, String)],
    endpoint: &str,
) -> (Vec<Value>, Vec<String>, Vec<String>) {
    let sem = Arc::new(Semaphore::new(8)); // 并发限流,避免触发 API 限频
    let mut handles = Vec::new();
    for (svc, regions) in [("cvm", cvm_regions), ("lighthouse", lh_regions)] {
        for (region, _) in regions {
            let permit = sem.clone();
            let sid = secret_id.to_string();
            let skey = secret_key.to_string();
            let ep = endpoint.to_string();
            let region = region.clone();
            handles.push(tokio::spawn(async move {
                let _p = permit.acquire_owned().await;
                let r = tencent_describe_instances(&sid, &skey, svc, &region, &ep).await;
                (svc, region, r)
            }));
        }
    }
    let mut instances = Vec::new();
    let mut errors = Vec::new();
    let mut ok_services: Vec<String> = Vec::new();
    for h in handles {
        match h.await {
            Ok((svc, _, Ok(list))) => {
                if !ok_services.iter().any(|s| s == svc) {
                    ok_services.push(svc.to_string());
                }
                instances.extend(list);
            }
            Ok((svc, region, Err(e))) => {
                // 个别地域不支持对应服务(如 ap-osaka 无轻量)属正常情况,
                // 不作为错误提示用户。
                if e.contains("UnsupportedRegion") {
                    continue;
                }
                errors.push(format!("腾讯云 {} [{}]: {}", region, svc, e));
            }
            Err(e) => errors.push(format!("任务失败: {}", e)),
        }
    }
    (instances, errors, ok_services)
}

/// 腾讯云:全区域拉取 CVM + 轻量,结果带 provider/region。
/// CVM 与轻量各自探测地域表后按表拉取;单区域失败不阻断整体 ——
/// 错误收集进 errors 由前端汇总提示。
pub async fn tencent_fetch_all(
    secret_id: &str,
    secret_key: &str,
    endpoint: &str,
) -> Result<(Vec<Value>, Vec<String>), String> {
    let (cvm_regions, lh_regions) = tencent_region_lists(secret_id, secret_key, endpoint).await?;
    let (instances, errors, _) =
        tencent_scan(secret_id, secret_key, &cvm_regions, &lh_regions, endpoint).await;
    Ok((instances, errors))
}

pub fn map_tencent_instances(resp: &Value, provider: &str, region: &str) -> Vec<Value> {
    let list = resp["InstanceSet"].as_array().cloned().unwrap_or_default();
    list.iter()
        .map(|i| {
            // CVM 用 PublicIpAddresses/PrivateIpAddresses;
            // Lighthouse 用 PublicAddresses/PrivateAddresses(字段名不同,
            // 此前只读 CVM 字段导致轻量实例的 IP 恒为空、被前端整体过滤)。
            let host = i["PublicIpAddresses"][0]
                .as_str()
                .or_else(|| i["PublicAddresses"][0].as_str())
                .or_else(|| i["PrivateIpAddresses"][0].as_str())
                .or_else(|| i["PrivateAddresses"][0].as_str())
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

/// 阿里云:给定地域表并发分页拉取 ECS 实例,结果带 region。
/// 凭据校验与"拉取全部"共用本函数,保证两处行为一致。
async fn aliyun_scan_regions(
    access_key_id: &str,
    access_key_secret: &str,
    regions: &[(String, String)],
    endpoint: &str,
) -> (Vec<Value>, Vec<String>) {
    let sem = Arc::new(Semaphore::new(8));
    let mut handles = Vec::new();
    for (region, _) in regions {
        let ak = access_key_id.to_string();
        let sk = access_key_secret.to_string();
        let ep = endpoint.to_string();
        let region = region.clone();
        handles.push(tokio::spawn(async move {
            let mut all: Vec<Value> = Vec::new();
            let mut page: i64 = 1;
            loop {
                let r = aliyun_call(
                    &ak,
                    &sk,
                    "DescribeInstances",
                    &region,
                    &ep,
                    json!({ "PageSize": 100, "PageNumber": page }),
                )
                .await;
                match r {
                    Ok(j) => {
                        let list = j["Instances"]["Instance"]
                            .as_array()
                            .cloned()
                            .unwrap_or_default();
                        let got = list.len() as i64;
                        let total = j["TotalCount"].as_i64().unwrap_or(0);
                        all.extend(map_aliyun_instances(&j, &region));
                        if (page * 100) >= total || got == 0 || page > 50 {
                            break;
                        }
                        page += 1;
                    }
                    Err(e) => return (region, Err(e)),
                }
            }
            (region, Ok(all))
        }));
    }
    let mut instances = Vec::new();
    let mut errors = Vec::new();
    for h in handles {
        match h.await {
            Ok((_, Ok(list))) => instances.extend(list),
            Ok((region, Err(e))) => errors.push(format!("阿里云 {}: {}", region, e)),
            Err(e) => errors.push(format!("任务失败: {}", e)),
        }
    }
    (instances, errors)
}

/// 阿里云:全区域分页拉取 ECS 实例,结果带 region。
pub async fn aliyun_fetch_all(
    access_key_id: &str,
    access_key_secret: &str,
    endpoint: &str,
) -> Result<(Vec<Value>, Vec<String>), String> {
    let regions = aliyun_regions(access_key_id, access_key_secret, endpoint).await?;
    let (instances, errors) =
        aliyun_scan_regions(access_key_id, access_key_secret, &regions, endpoint).await;
    Ok((instances, errors))
}

fn map_aliyun_instances(resp: &Value, region: &str) -> Vec<Value> {
    let list = resp["Instances"]["Instance"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    list.iter()
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
        .collect()
}

/// 凭据校验(腾讯云):与"拉取全部"完全同路径的全量只读扫描,不落库。
/// 返回 (地域数(两表并集), 实例总数, 可用的服务名列表, 失败项数)。
/// 报出的数字即真实拉取结果 —— 不再只抽样首个地域。
pub async fn tencent_probe(
    secret_id: &str,
    secret_key: &str,
    endpoint: &str,
) -> Result<(usize, usize, Vec<String>, usize), String> {
    if secret_id.trim().is_empty() || secret_key.trim().is_empty() {
        return Err("请填写腾讯云 SecretId 与 SecretKey".into());
    }
    let (cvm_regions, lh_regions) = tencent_region_lists(secret_id, secret_key, endpoint).await?;
    if cvm_regions.is_empty() && lh_regions.is_empty() {
        return Err("该密钥未返回任何可用地域".into());
    }
    let (instances, errors, ok_services) =
        tencent_scan(secret_id, secret_key, &cvm_regions, &lh_regions, endpoint).await;
    if ok_services.is_empty() {
        // 没有任何一次调用成功过,凭据无效;给最后一条真实错误
        return Err(errors
            .last()
            .cloned()
            .unwrap_or_else(|| "所有地域调用均失败".into()));
    }
    Ok((
        union_region_count(&cvm_regions, &lh_regions),
        instances.len(),
        ok_services,
        errors.len(),
    ))
}

/// 凭据校验(阿里云):与"拉取全部"同路径的全量只读扫描,不落库。
/// 返回 (地域数, 实例总数, 可用的服务名列表, 失败项数)。
pub async fn aliyun_probe(
    access_key_id: &str,
    access_key_secret: &str,
    endpoint: &str,
) -> Result<(usize, usize, Vec<String>, usize), String> {
    if access_key_id.trim().is_empty() || access_key_secret.trim().is_empty() {
        return Err("请填写阿里云 AccessKeyId 与 AccessKeySecret".into());
    }
    let regions = aliyun_regions(access_key_id, access_key_secret, endpoint).await?;
    if regions.is_empty() {
        return Err("该密钥未返回任何可用地域".into());
    }
    let (instances, errors) =
        aliyun_scan_regions(access_key_id, access_key_secret, &regions, endpoint).await;
    // 每个区域一个任务:全部失败即凭据无效;个别区域失败不影响校验结论
    if errors.len() >= regions.len() {
        return Err(errors
            .last()
            .cloned()
            .unwrap_or_else(|| "所有地域调用均失败".into()));
    }
    Ok((
        regions.len(),
        instances.len(),
        vec!["ecs".into()],
        errors.len(),
    ))
}

// 保留单区域调用(旧签名兼容;mock 测试与既有调用方使用)
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
    Ok(map_aliyun_instances(&json, region))
}
