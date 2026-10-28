//! protobuf 线格式编码。
//!
//! medusa 的报文是一棵 protobuf 树。这里只实现签名用到的几种 wire type，
//! 语义与 Go 实现（`internal/protocol/sign/proto.go`）一致 —— 尤其是
//! `proto_bytes` 对空载荷**返回空切片**（Go 里 `if len(body)==0 { return nil }`），
//! 这条看似多余的规则会改变报文字节数，漏掉它签名就会错。

use crate::hongguo::prim::zigzag;

/// 无符号变长整数。
pub fn varint(mut value: u64) -> Vec<u8> {
    let mut out = Vec::new();
    while value > 127 {
        out.push((value as u8 & 127) | 128);
        value >>= 7;
    }
    out.push(value as u8);
    out
}

fn proto_key(tag: u32, wire: u8) -> Vec<u8> {
    varint(((tag as u64) << 3) | wire as u64)
}

/// 长度前缀的字节字段。空载荷不编码（与 Go 一致）。
pub fn proto_bytes(tag: u32, body: &[u8]) -> Vec<u8> {
    if body.is_empty() {
        return Vec::new();
    }
    let mut out = proto_key(tag, 2);
    out.extend_from_slice(&varint(body.len() as u64));
    out.extend_from_slice(body);
    out
}

pub fn proto_string(tag: u32, s: &str) -> Vec<u8> {
    proto_bytes(tag, s.as_bytes())
}

/// 有符号整数（zigzag 编码，wire type 0）。
pub fn proto_sint(tag: u32, value: i64) -> Vec<u8> {
    let mut out = proto_key(tag, 0);
    out.extend_from_slice(&varint(zigzag(value)));
    out
}

/// 32 位浮点（wire type 5）。
pub fn proto_float(tag: u32, value: f32) -> Vec<u8> {
    let mut out = proto_key(tag, 5);
    out.extend_from_slice(&value.to_le_bytes());
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn varint_boundaries() {
        assert_eq!(varint(0), vec![0]);
        assert_eq!(varint(127), vec![127]);
        assert_eq!(varint(128), vec![0x80, 0x01]);
        assert_eq!(varint(300), vec![0xac, 0x02]);
    }

    #[test]
    fn empty_bytes_encodes_nothing() {
        // 这条规则直接决定 medusa 报文长度，必须与 Go 一致
        assert!(proto_bytes(1, &[]).is_empty());
        assert_eq!(proto_bytes(1, &[0xab]), vec![0x0a, 0x01, 0xab]);
    }

    #[test]
    fn sint_uses_zigzag() {
        assert_eq!(proto_sint(1, -888888), {
            let mut v = proto_key(1, 0);
            v.extend_from_slice(&varint(zigzag(-888888)));
            v
        });
    }
}
