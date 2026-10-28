//! 匿名设备档案。
//!
//! 移植自 `sdk/device.go` 与 `sdk/model/device.go`。
//!
//! SDK 不要求登录：首次请求时用密码学随机数生成 5 个安装标识符，向注册接口
//! 换回 `device_id` / `install_id` 与服务端下发的 cookie，之后每次请求都出示它们。
//! 服务端若判定设备不可用（`DEVICE_REJECTED`），重置档案重新注册即可换一台。

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

/// 匿名设备的机型信息。空字段在 `or_default` 里补齐。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Device {
    pub brand: String,
    pub model: String,
    pub os_version: String,
    pub os_api: i32,
    pub build: String,
    pub resolution: String,
    pub dpi: i32,
    #[serde(default)]
    pub pad: bool,
    pub channel: String,
}

impl Device {
    /// 生成一台具体的默认设备（常量无法直接构造 String，这里走函数）。
    pub fn xiaomi14() -> Self {
        Self {
            brand: "Xiaomi".into(),
            model: "23127PN0CC".into(),
            os_version: "14".into(),
            os_api: 34,
            build: "UKQ1.230804.001".into(),
            resolution: "1200*2670".into(),
            dpi: 460,
            pad: false,
            channel: "xiaomi_8662_64".into(),
        }
    }

    /// 用默认机型补齐空字段（`pad` 保持原值）。
    pub fn or_default(self) -> Self {
        let def = Self::xiaomi14();
        Self {
            brand: if self.brand.is_empty() {
                def.brand
            } else {
                self.brand
            },
            model: if self.model.is_empty() {
                def.model
            } else {
                self.model
            },
            os_version: if self.os_version.is_empty() {
                def.os_version
            } else {
                self.os_version
            },
            os_api: if self.os_api == 0 {
                def.os_api
            } else {
                self.os_api
            },
            build: if self.build.is_empty() {
                def.build
            } else {
                self.build
            },
            resolution: if self.resolution.is_empty() {
                def.resolution
            } else {
                self.resolution
            },
            dpi: if self.dpi == 0 { def.dpi } else { self.dpi },
            pad: self.pad,
            channel: if self.channel.is_empty() {
                def.channel
            } else {
                self.channel
            },
        }
    }
}

/// 匿名设备档案。`device_id` / `install_id` 在注册成功前为空。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeviceProfile {
    pub cdid: String,
    pub openudid: String,
    pub clientudid: String,
    pub oaid_id: String,
    pub req_id: String,

    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub device_id_str: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub install_id_str: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub device_token: String,

    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub ttreq: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub store_region: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub store_region_src: String,

    pub created_at: DateTime<Utc>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub device: Option<Device>,
}

impl DeviceProfile {
    /// 用随机数生成一台匿名安装。
    pub fn new_anonymous() -> Self {
        let mut raw = [0u8; 72];
        fill_random(&mut raw);
        Self {
            cdid: uuid_from(&raw[0..16]),
            openudid: hex_lower(&raw[16..24]),
            clientudid: uuid_from(&raw[24..40]),
            oaid_id: uuid_from(&raw[40..56]),
            req_id: uuid_from(&raw[56..72]),
            device_id_str: String::new(),
            install_id_str: String::new(),
            device_token: String::new(),
            ttreq: String::new(),
            store_region: String::new(),
            store_region_src: String::new(),
            created_at: Utc::now(),
            device: Some(Device::xiaomi14()),
        }
    }

    /// 注册是否已完成（两个 id 都非空且非 0）。
    pub fn is_ready(&self) -> bool {
        !self.device_id_str.is_empty()
            && !self.install_id_str.is_empty()
            && self.device_id_str != "0"
            && self.install_id_str != "0"
    }

    /// 该档案注册时使用的设备。
    pub fn device_or_default(&self) -> Device {
        self.device.clone().unwrap_or_default().or_default()
    }

    /// 游客 cookie（注册后每次请求都带）。
    pub fn guest_cookie(&self) -> String {
        format!(
            "passport_csrf_token=; passport_csrf_token_default=; store-region={}; store-region-src={}; install_id={}; ttreq={}",
            self.store_region, self.store_region_src, self.install_id_str, self.ttreq
        )
    }
}

fn fill_random(buf: &mut [u8]) {
    let mut filled = 0;
    while filled < buf.len() {
        let id = uuid::Uuid::new_v4();
        let bytes = id.as_bytes();
        let take = (buf.len() - filled).min(bytes.len());
        buf[filled..filled + take].copy_from_slice(&bytes[..take]);
        filled += take;
    }
}

/// 把 16 字节渲染成 v4 UUID 字符串。
fn uuid_from(b: &[u8]) -> String {
    let mut id = [0u8; 16];
    id.copy_from_slice(&b[..16]);
    id[6] = (id[6] & 0x0f) | 0x40;
    id[8] = (id[8] & 0x3f) | 0x80;
    uuid::Uuid::from_bytes(id).to_string()
}

fn hex_lower(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn anonymous_profile_is_ready_only_after_register() {
        let p = DeviceProfile::new_anonymous();
        assert!(!p.is_ready(), "刚生成的档案还没有服务端 id");
        assert_eq!(p.cdid.len(), 36);
        assert_eq!(p.openudid.len(), 16);

        let mut p2 = p.clone();
        p2.device_id_str = "123".into();
        p2.install_id_str = "456".into();
        assert!(p2.is_ready());
    }

    #[test]
    fn device_defaults_fill_empty_fields() {
        let d = Device::default().or_default();
        assert_eq!(d.model, "23127PN0CC");
        assert_eq!(d.os_api, 34);
        assert_eq!(d.channel, "xiaomi_8662_64");
    }
}
