//! 红果短剧的原生客户端。
//!
//! 这个模块完整替代了原先的 Python worker（`resources/shortdrama-worker`）：
//! 设备匿名注册、六代请求签名、目录/搜索/分集读取、播放模型解析与 CENC
//! 内容密钥推导，全部在 Rust 内完成，不再需要 Python 运行时。
//!
//! 移植自 [openhongguo](https://github.com/beilunyang/openhongguo) 的 Go 实现
//! （Apache-2.0），逐位对齐其签名算法。正确性由 `vectors.rs` 里的黄金测试向量
//! 保证 —— 那些向量由 Go 实现直接生成，任何一位算错都会立刻失败。
//!
//! ## 分层
//!
//! ```text
//! prim / sm3        基础原语与 SM3 杂凑
//! proto             protobuf 线格式编码（medusa 的报文结构）
//! gorgon / f13      x-gorgon、以及被 medusa 复用的混淆哈希
//! helios            x-helios
//! aes_v3            medusa 用的自定义 AES 变体
//! medusa            x-medusa
//! sign              把上面几件组装成一次请求的签名头
//! tt_encrypt        注册报文的 tt-data 信封
//! device            匿名设备档案
//! ```
//!
//! ## 尚未接线的部分
//!
//! `catalog` 的搜索/发现接口、`client` 的部分辅助方法与 `consts` 的接口路径常量
//! 还没有接入 IPC 面板——它们是移植 Go 实现时保留下来的完整能力面，等后续版本
//! 逐个接上。在此之前它们不会触发 `-D warnings` 的 dead-code 硬门槛。
#![allow(dead_code)]

pub mod aes_v3;
pub mod catalog;
pub mod client;
pub mod consts;
pub mod device;
pub mod drm;
pub mod f13;
pub mod gorgon;
pub mod helios;
pub mod media;
pub mod medusa;
pub mod prim;
pub mod proto;
pub mod register;
pub mod sign;
pub mod sm3;
pub mod tt_encrypt;

#[cfg(test)]
mod live;
#[cfg(test)]
mod register_wire;
#[cfg(test)]
mod vectors;
