// 云厂商签名单元测试:与 Electron 版相同的标准测试向量(官方文档)
use crate::signing::*;

const TC3_DOC: (&str, &str, &str, &str, &str) = (
    // payloadStr, payloadHash, canonicalHash, kSigningHex, finalSignature
    "{\"Limit\": 1, \"Filters\": [{\"Values\": [\"\\u672a\\u547d\\u540d\"], \"Name\": \"instance-name\"}]}",
    "35e9c5b0e3ae67532d3c9f17ead6c90222632e5b1ff7f6e89887f1398934f064",
    "7019a55be8395899b900fb5564e4200d984910f34794a27cb3fb7d10ff6a1e84",
    "b596b923aad85185e2d1f6659d2a062e0a86731226e021e61bfe06f7ed05f5af",
    "10b1a37a7301a02ca19a647ad722d5e43b4b3cff309d421d85b46093f6ab6c4f",
);

#[test]
fn tencent_payload_hash() {
    assert_eq!(sha256_hex(TC3_DOC.0), TC3_DOC.1);
}

#[test]
fn tencent_canonical_request() {
    let canonical = tencent_build_canonical_request("cvm.tencentcloudapi.com", "DescribeInstances", TC3_DOC.0);
    assert_eq!(sha256_hex(&canonical), TC3_DOC.2);
}

#[test]
fn tencent_final_signature() {
    let canonical = tencent_build_canonical_request("cvm.tencentcloudapi.com", "DescribeInstances", TC3_DOC.0);
    let sts = tencent_string_to_sign(1551113065, "2019-02-25", "cvm", &canonical);
    let k_signing = hex(&[0xb5, 0x96, 0xb9, 0x23, 0xaa, 0xd8, 0x51, 0x85, 0xe2, 0xd1, 0xf6, 0x65, 0x9d, 0x2a, 0x06, 0x2e, 0x0a, 0x86, 0x73, 0x12, 0x26, 0xe0, 0x21, 0xe6, 0x1b, 0xfe, 0x06, 0xf7, 0xed, 0x05, 0xf5, 0xaf]);
    let sig = tencent_signature(&hex_to_bytes(&k_signing), &sts);
    assert_eq!(sig, TC3_DOC.4);
}

#[test]
fn tencent_signing_key_chain() {
    let k = tencent_signing_key("secret-test", "2026-09-26", "cvm");
    assert_eq!(k.len(), 32);
}

fn hex_to_bytes(h: &str) -> Vec<u8> {
    (0..h.len()).step_by(2).map(|i| u8::from_str_radix(&h[i..i + 2], 16).unwrap()).collect()
}

const ALI_CANONICAL: &str = "AccessKeyId=testid&Action=DescribeDedicatedHosts&Format=JSON&RegionId=cn-beijing&SignatureMethod=HMAC-SHA1&SignatureNonce=edb2b34af0af9a6d14deaf7c1a5315eb&SignatureVersion=1.0&Timestamp=2023-03-13T08%3A34%3A30Z&Version=2014-05-26";
const ALI_STS: &str = "GET&%2F&AccessKeyId%3Dtestid%26Action%3DDescribeDedicatedHosts%26Format%3DJSON%26RegionId%3Dcn-beijing%26SignatureMethod%3DHMAC-SHA1%26SignatureNonce%3Dedb2b34af0af9a6d14deaf7c1a5315eb%26SignatureVersion%3D1.0%26Timestamp%3D2023-03-13T08%253A34%253A30Z%26Version%3D2014-05-26";

#[test]
fn aliyun_percent_encode_rules() {
    assert_eq!(aliyun_percent_encode("a+b c!d(e)f*g~h"), "a%2Bb%20c%21d%28e%29f%2Ag~h");
    assert_eq!(aliyun_percent_encode("2023-03-13T08:34:30Z"), "2023-03-13T08%3A34%3A30Z");
    assert_eq!(aliyun_percent_encode("/"), "%2F");
}

#[test]
fn aliyun_canonical_and_signature() {
    let mut params = serde_json::Map::new();
    params.insert("AccessKeyId".into(), serde_json::json!("testid"));
    params.insert("Action".into(), serde_json::json!("DescribeDedicatedHosts"));
    params.insert("Format".into(), serde_json::json!("JSON"));
    params.insert("RegionId".into(), serde_json::json!("cn-beijing"));
    params.insert("SignatureMethod".into(), serde_json::json!("HMAC-SHA1"));
    params.insert("SignatureNonce".into(), serde_json::json!("edb2b34af0af9a6d14deaf7c1a5315eb"));
    params.insert("SignatureVersion".into(), serde_json::json!("1.0"));
    params.insert("Timestamp".into(), serde_json::json!("2023-03-13T08:34:30Z"));
    params.insert("Version".into(), serde_json::json!("2014-05-26"));
    let canonical = aliyun_canonical_query(&params);
    assert_eq!(canonical, ALI_CANONICAL);
    let sts = aliyun_string_to_sign(&canonical);
    assert_eq!(sts, ALI_STS);
    assert_eq!(aliyun_sign(&sts, "testsecret"), "9NaGiOspFP5UPcwX8Iwt2YJXXuk=");
}
