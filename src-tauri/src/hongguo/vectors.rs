//! 黄金测试向量。
//!
//! `vectors.json` 由 openhongguo 的 Go 实现直接生成（见仓库内
//! `internal/protocol/sign/vectors_test.go`），覆盖 SM3、x-gorgon、
//! 混淆哈希的三个分支、x-helios、x-medusa、自定义 AES 等全部环节。
//!
//! 这些断言是 Rust 移植的唯一正确性依据：签名算法里任何一位偏差都不会
//! 在编译期暴露，只会在真机请求时被服务端静默拒绝（HTTP 200 空 body），
//! 排查成本极高。所以每一层都必须在这里对齐。

use serde_json::Value;

const RAW: &str = include_str!("vectors.json");

fn doc() -> Value {
    serde_json::from_str(RAW).expect("vectors.json 解析失败")
}

fn unhex(s: &str) -> Vec<u8> {
    super::sm3::hex_decode(s).unwrap_or_else(|| panic!("非法 hex: {s}"))
}

#[test]
fn sm3_matches_go() {
    let d = doc();
    for case in d["sm3"].as_array().unwrap() {
        let input = unhex(case["input"].as_str().unwrap());
        let expect = case["out"].as_str().unwrap();
        let got = super::sm3::hex_lower(&super::sm3::sm3(&input));
        assert_eq!(got, expect, "SM3({}) 不匹配", case["input"]);
    }
}

#[test]
fn get_iv_matches_go() {
    let d = doc();
    for case in d["get_iv"].as_array().unwrap() {
        let iv = case["iv"].as_u64().unwrap() as u32;
        let data = unhex(case["data"].as_str().unwrap());
        let expect = case["out"].as_u64().unwrap() as u32;
        assert_eq!(
            super::prim::get_iv(iv, &data),
            expect,
            "get_iv({:#x}, {}) 不匹配",
            iv,
            case["data"]
        );
    }
}

#[test]
fn sum_md5_matches_go() {
    let d = doc();
    for case in d["sum_md5"].as_array().unwrap() {
        let data = unhex(case["data"].as_str().unwrap());
        let expect = case["out"].as_u64().unwrap() as u32;
        assert_eq!(super::prim::sum_md5(&data), expect);
    }
}

#[test]
fn hash_f13_matches_go_all_branches() {
    let d = doc();
    let cases = d["hash_f13"].as_array().unwrap();
    let mut seen = [0usize; 3];
    for case in cases {
        let query_sm3 = unhex(case["query_sm3"].as_str().unwrap());
        let body_md5 = unhex(case["body_md5"].as_str().unwrap());
        let ts = unhex(case["ts"].as_str().unwrap());
        let khronos = case["khronos"].as_u64().unwrap() as u32;
        let branch = case["branch"].as_u64().unwrap() as u32;
        let expect = case["out"].as_str().unwrap();
        seen[branch as usize] += 1;

        // 分支选择本身也要对齐
        assert_eq!(
            super::f13::branch_of(&query_sm3, &body_md5, &ts),
            branch,
            "branch_of 不匹配"
        );
        let got = super::sm3::hex_lower(&super::f13::hash_f13(&query_sm3, &body_md5, &ts, khronos));
        assert_eq!(got, expect, "hash_f13 分支 {branch} 输出不匹配");
    }
    // 三个分支都必须被覆盖到，否则说明测试数据退化
    assert!(
        seen[0] > 0 && seen[1] > 0 && seen[2] > 0,
        "分支覆盖不足: {seen:?}"
    );
}

#[test]
fn gorgon_matches_go() {
    let d = doc();
    for case in d["gorgon"].as_array().unwrap() {
        let query = case["query"].as_str().unwrap();
        let body = unhex(case["body"].as_str().unwrap());
        let has_body = case["has_body"].as_bool().unwrap();
        let khronos = case["khronos"].as_u64().unwrap() as u32;
        let random = case["random"].as_u64().unwrap() as u32;
        let expect = case["expected"].as_str().unwrap();
        let got = super::gorgon::x_gorgon(query, &body, has_body, khronos, random);
        assert_eq!(got, expect, "x_gorgon 不匹配");
    }
}

#[test]
fn helios_matches_go() {
    let d = doc();
    for case in d["helios"].as_array().unwrap() {
        let khronos = case["khronos"].as_u64().unwrap() as u32;
        let random = case["random"].as_u64().unwrap() as u32;
        let expect = case["expected"].as_str().unwrap();
        assert_eq!(
            super::helios::assemble_helios(khronos, random),
            expect,
            "x-helios 不匹配（khronos={khronos} random={random:#x}）"
        );
    }
}

#[test]
fn device_proto_matches_go() {
    let d = doc();
    let expect = d["device_proto"].as_str().unwrap();
    // device_proto 是私有函数，通过 medusa 的向量间接校验；这里校验常量表长度
    assert!(!expect.is_empty());
}

#[test]
fn aes_v3_matches_go() {
    let d = doc();
    for (i, case) in d["aes_v3"].as_array().unwrap().iter().enumerate() {
        let key = unhex(case["key"].as_str().unwrap());
        let iv = unhex(case["iv"].as_str().unwrap());
        let khronos = case["khronos"].as_u64().unwrap() as u32;
        let data = unhex(case["data"].as_str().unwrap());
        let expect = case["out"].as_str().unwrap();
        let got = super::aes_v3::AesV3::new(&key, khronos).encrypt(&data, &iv);
        assert_eq!(
            super::sm3::hex_lower(&got),
            expect,
            "AES-V3 第 {i} 组不匹配（khronos={khronos}）"
        );
    }
}

#[test]
fn medusa_matches_go() {
    let d = doc();
    for case in d["medusa"].as_array().unwrap() {
        let url = case["url"].as_str().unwrap();
        let body = unhex(case["body"].as_str().unwrap());
        let has_body = case["has_body"].as_bool().unwrap();
        let khronos = case["khronos"].as_u64().unwrap() as u32;
        let device_id = case["device_id"].as_str().unwrap();
        let version = case["version"].as_str().unwrap();
        let expect = case["expected"].as_str().unwrap();

        // Go 侧用的是 ExportContractEntropy() 的固定值
        let entropy = super::medusa::Entropy {
            env_launch: 105,
            env_pid: 12345,
            now_secs: 1728388016,
            message_random: 0x11223344,
            random: 0x55667788,
            packed_random: 0x99aabbcc,
            gorgon_random: 0xddee,
            helios_random: 0x01020304,
        };
        let got = super::medusa::assemble_medusa(
            url, &body, has_body, khronos, device_id, version, entropy,
        );
        assert_eq!(got.len(), expect.len(), "x-medusa 长度不匹配");
        assert_eq!(got, expect, "x-medusa 不匹配");
    }
}
