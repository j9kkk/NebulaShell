// 云厂商实例映射测试:重点回归"轻量与 CVM 字段名不同导致轻量 IP 读成空"的缺陷
use crate::cloud::map_tencent_instances;
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
