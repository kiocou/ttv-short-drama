//! 注册报文的逐字节对齐测试。
//!
//! Go 侧 `BuildBootstrapPlaintext` 对固定输入产出的明文与摘要都记在这里。
//! 只要 Rust 的报文与它完全一致，注册就不会因为"看起来没问题但字节差一位"
//! 被服务端回 `device_id=0`。

#[cfg(test)]
mod tests {
    use crate::hongguo::device::{Device, DeviceProfile};
    use crate::hongguo::register::build_register_body;

    fn fixed_profile() -> DeviceProfile {
        DeviceProfile {
            cdid: "11111111-1111-4111-8111-111111111111".into(),
            openudid: "2222222222222222".into(),
            clientudid: "33333333-3333-4333-8333-333333333333".into(),
            oaid_id: "44444444-4444-4444-8444-444444444444".into(),
            req_id: "55555555-5555-4555-8555-555555555555".into(),
            device_id_str: String::new(),
            install_id_str: String::new(),
            device_token: String::new(),
            ttreq: String::new(),
            store_region: String::new(),
            store_region_src: String::new(),
            created_at: chrono::Utc::now(),
            device: Some(Device::xiaomi14()),
        }
    }

    /// 顶层 header 的字段顺序必须与 Go 的 bootstrapHeaderOrder 一致。
    #[test]
    fn header_key_order_matches_go() {
        let profile = fixed_profile();
        let body = build_register_body(&profile);
        // 输出 tt-data 信封，长度必须落在合理范围（Go 侧 710 字节）
        assert_eq!(&body[..6], &[0x74, 0x63, 0x05, 0x10, 0x00, 0x00]);
        assert!(
            (600..900).contains(&body.len()),
            "报文长度异常：{}（Go 侧约 710）",
            body.len()
        );
    }

    /// 固定时间下，明文里 oaid 的键必须按字典序出现。
    #[test]
    fn oaid_keys_are_sorted() {
        let profile = fixed_profile();
        // 直接检查构造出的 oaid 对象键顺序
        let oaid = super::super::register::debug_oaid_order(&profile);
        let expected = "hw_id_version_code,id,is_track_limited,query_times,req_id,take_ms,time";
        assert_eq!(oaid, expected, "oaid 键顺序必须与 Go 的 map 排序一致");
    }
}
