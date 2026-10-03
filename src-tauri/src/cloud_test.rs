// 云厂商实例映射测试:重点回归"轻量与 CVM 字段名不同导致轻量 IP 读成空"的缺陷
use crate::cloud::{
    aliyun_probe, map_tencent_instances, parse_tencent_regions, tencent_probe, union_region_count,
};
use serde_json::{json, Value};

/// 回归:腾讯云轻量(Lighthouse)返回 PublicAddresses/PrivateAddresses,
/// 与 CVM 的 PublicIpAddresses/PrivateIpAddresses 不同。
/// 旧实现只读 CVM 字段 → 轻量实例 IP 恒为空 → 前端整体过滤 → "没有获取到可用实例"。
#[test]
fn lighthouse_public_addresses_are_mapped() {
    let resp = json!({
        "InstanceSet": [{
            "InstanceId": "lhins-1", "InstanceName": "lh-host",
            "PublicAddresses": ["124.221.200.38"],
            "PrivateAddresses": ["10.0.0.4"],
            "OsName": "OpenCloudOS 9", "InstanceState": "RUNNING",
        }]
    });
    let out = map_tencent_instances(&resp, "lighthouse", "ap-shanghai");
    assert_eq!(out.len(), 1);
    assert_eq!(
        out[0]["host"],
        json!("124.221.200.38"),
        "轻量公网 IP 必须被映射"
    );
    assert_eq!(out[0]["cloud"]["provider"], json!("lighthouse"));
    assert_eq!(out[0]["cloud"]["region"], json!("ap-shanghai"));
    assert_eq!(out[0]["username"], json!("root"), "非 Windows 默认 root");
}

/// CVM 字段不受影响(优先读 PublicIpAddresses)
#[test]
fn cvm_public_ip_addresses_still_mapped() {
    let resp = json!({
        "InstanceSet": [{
            "InstanceId": "ins-1", "InstanceName": "cvm-host",
            "PublicIpAddresses": ["203.0.113.10"],
            "PrivateIpAddresses": ["10.0.0.10"],
            "OsName": "Windows Server 2019", "InstanceState": "STOPPED",
        }]
    });
    let out = map_tencent_instances(&resp, "cvm", "ap-guangzhou");
    assert_eq!(out[0]["host"], json!("203.0.113.10"));
    assert_eq!(
        out[0]["username"],
        json!("Administrator"),
        "Windows 用 Administrator"
    );
}

/// 无公网 IP 时回退私网(轻量与 CVM 两种字段都要试)
#[test]
fn falls_back_to_private_addresses() {
    let lh = json!({ "InstanceSet": [{
        "InstanceId": "i", "PrivateAddresses": ["10.0.0.9"],
    }]});
    let cvm = json!({ "InstanceSet": [{
        "InstanceId": "i", "PrivateIpAddresses": ["10.0.0.8"],
    }]});
    assert_eq!(
        map_tencent_instances(&lh, "lighthouse", "r")[0]["host"],
        json!("10.0.0.9")
    );
    assert_eq!(
        map_tencent_instances(&cvm, "cvm", "r")[0]["host"],
        json!("10.0.0.8")
    );
}

/// 完全无 IP 时 host 为空串(由前端过滤),不 panic
#[test]
fn no_ip_yields_empty_host_without_panic() {
    let resp = json!({ "InstanceSet": [{ "InstanceId": "i" }] });
    let out: Vec<Value> = map_tencent_instances(&resp, "cvm", "r");
    assert_eq!(out[0]["host"], json!(""));
}

/// 凭据校验:空密钥在发请求前就被拦下(否则会拿空签名打网络)
#[tokio::test]
async fn probe_rejects_empty_credentials() {
    let e = tencent_probe("", "sk", "").await.unwrap_err();
    assert!(e.contains("SecretId"), "应提示填写 SecretId: {}", e);
    let e = tencent_probe("AKID", "  ", "").await.unwrap_err();
    assert!(e.contains("SecretKey"), "应提示填写 SecretKey: {}", e);
    let e = aliyun_probe("", "", "").await.unwrap_err();
    assert!(e.contains("AccessKeyId"), "应提示填写 AccessKeyId: {}", e);
}

/// 地域表解析:CVM 与轻量的 DescribeRegions 响应同构,
/// 空 region 条目丢弃、缺失 RegionSet 不 panic
#[test]
fn tencent_region_parse_filters_empty_entries() {
    let resp = json!({ "RegionSet": [
        { "Region": "ap-guangzhou", "RegionName": "广州", "RegionState": "AVAILABLE" },
        { "Region": "", "RegionName": "坏数据" },
        { "Region": "ap-singapore", "RegionName": "新加坡", "RegionState": "AVAILABLE" },
    ]});
    let out = parse_tencent_regions(&resp);
    assert_eq!(out.len(), 2, "空 region 条目必须被过滤");
    assert_eq!(out[0], ("ap-guangzhou".to_string(), "广州".to_string()));
    assert_eq!(out[1], ("ap-singapore".to_string(), "新加坡".to_string()));
    // 缺失/空响应返回空表
    assert!(parse_tencent_regions(&json!({})).is_empty());
    assert!(parse_tencent_regions(&json!({ "RegionSet": [] })).is_empty());
}

/// 回归:两张地域表不保证一致,地域数必须按并集口径统计
/// (只用 CVM 的表会漏掉仅轻量覆盖的地域,如部分海外地域)
#[test]
fn region_count_uses_union_of_divergent_tables() {
    let cvm = vec![
        ("ap-guangzhou".to_string(), "广州".to_string()),
        ("ap-shanghai".to_string(), "上海".to_string()),
    ];
    let lh = vec![
        ("ap-guangzhou".to_string(), "广州".to_string()),
        ("ap-singapore".to_string(), "新加坡".to_string()),
    ];
    assert_eq!(union_region_count(&cvm, &lh), 3, "广州去重,并集 3 个地域");
    assert_eq!(union_region_count(&cvm, &cvm), 2, "两表一致时等于单表数量");
    assert_eq!(
        union_region_count(&cvm, &[]),
        2,
        "轻量表为空时回退 CVM 口径"
    );
    assert_eq!(union_region_count(&[], &[]), 0);
}
