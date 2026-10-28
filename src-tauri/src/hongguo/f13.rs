//! 被 medusa 复用的混淆哈希（Go 里叫 `hashF13`）。
//!
//! 它按状态 IV 的低 4 位选择三条分支，其中分支 0 是自定义的 8 字状态混合，
//! 分支 2 是带置换表与旋转常量的 MD5 变体，分支 1 是简单的拼接摘要。
//!
//! 移植要点：
//! * Go 的 `state = append([]uint32{last}, state[:len-1]...)` 是把**最后一个字
//!   搬到最前面**（右旋一位），不是左旋。
//! * 所有 `+` 都必须 `wrapping_add`：这些常量设计上就会溢出 32 位。
//! * `byte((combined >> n0) & 255)` 里 `combined` 是 uint16，先拼成 16 位再右移。

use crate::hongguo::consts::{
    BRANCH0_INIT, BRANCH0_IV, BRANCH0_ROUNDS, BRANCH0_TT, BRANCH2_ORDERS, BRANCH2_SV,
};
use crate::hongguo::prim::{get_iv, le32, rol32, ror32, sum_md5};

const IV_SEED: u32 = 0x20230928;

/// 由三段材料算出分支号（0/1/2）。
pub fn branch_of(query: &[u8], body_md5: &[u8], ts: &[u8]) -> u32 {
    let iv = get_iv(get_iv(get_iv(IV_SEED, query), body_md5), ts);
    let low = iv & 15;
    // Go: low - ((low*171)>>9)*3 —— 等价于 low % 3 的一种混淆写法
    low.wrapping_sub((low.wrapping_mul(171) >> 9).wrapping_mul(3))
}

/// 计算混淆哈希。
///
/// * `query_sm3` —— 查询串的 32 字节 SM3
/// * `body_md5` —— 请求体的 16 字节 MD5（无 body 时全 0）
/// * `ts` —— `khronos` 的小端 4 字节
pub fn hash_f13(query_sm3: &[u8], body_md5: &[u8], ts: &[u8], khronos: u32) -> Vec<u8> {
    let iv = get_iv(get_iv(get_iv(IV_SEED, query_sm3), body_md5), ts);
    let low = iv & 15;
    let iv_v0 = low.wrapping_mul(171) >> 9;
    let branch = low.wrapping_sub(iv_v0.wrapping_mul(3));

    if branch == 2 {
        return branch2_f13(iv, query_sm3, body_md5, ts, khronos);
    }
    if branch != 0 {
        // 分支 1：query_sm3 前 16 字节 + body_md5 + 二者拼接的 sum_md5
        let mut out = query_sm3[..16].to_vec();
        out.extend_from_slice(body_md5);
        let mut summed = query_sm3.to_vec();
        summed.extend_from_slice(body_md5);
        out.extend_from_slice(&le32(sum_md5(&summed)));
        return out;
    }
    branch0_f13(query_sm3, body_md5, ts, khronos, iv_v0)
}

/// 把 64 字节输入扩成 128 个 32 位字（前 16 个来自输入，其余递推）。
fn expand_words(data: &[u8]) -> Vec<u32> {
    let mut di: Vec<u32> = data
        .chunks_exact(4)
        .map(|c| u32::from_be_bytes([c[0], c[1], c[2], c[3]]))
        .collect();
    let mut di0 = di[0];
    for i in 0..112 {
        let di1 = di[i + 1];
        let di14 = di[i + 14];
        let r1 = rol32(di1, 14) ^ rol32(di1, 25) ^ (di1 >> 3);
        let r2 = rol32(di14, 13) ^ rol32(di14, 15) ^ (di14 >> 10);
        let next = di0
            .wrapping_add(di[i + 9])
            .wrapping_add(r1)
            .wrapping_add(r2);
        di.push(next);
        di0 = di1;
    }
    di
}

/// 分支 0 的 8 字状态混合。
fn mix_rounds(
    mut state: Vec<u32>,
    rounds: &[u32; 11],
    di: &[u32],
    tt: &[u32],
    iv_v1: u32,
) -> Vec<u32> {
    let idx = |k: usize| rounds[k] as usize;
    for i in 0..rounds[0] {
        let base = iv_v1.wrapping_add(i);
        let w = di[(base & 127) as usize];

        let n1 = ((state[idx(3)] ^ state[idx(4)]) & state[idx(1)]) ^ state[idx(3)];
        let n2 = rol32(state[idx(1)], 26) ^ rol32(state[idx(1)], 21) ^ rol32(state[idx(1)], 7);
        let n4 = w
            .wrapping_add(n1)
            .wrapping_add(n2)
            .wrapping_add(tt[(base & 63) as usize])
            .wrapping_add(state[idx(5)]);
        let n5 = rol32(state[idx(2)], 30) ^ rol32(state[idx(2)], 19) ^ rol32(state[idx(2)], 10);
        let n6 =
            (state[idx(2)] & state[idx(6)]) | ((state[idx(2)] | state[idx(6)]) & state[idx(7)]);
        let n7 = n5.wrapping_add(n6);

        let old = state[idx(9)];
        let last = state[state.len() - 1];
        // 右旋一位：最后一个字搬到最前
        let mut rotated = Vec::with_capacity(state.len());
        rotated.push(last);
        rotated.extend_from_slice(&state[..state.len() - 1]);
        state = rotated;

        state[idx(10)] = n7.wrapping_add(n4);
        state[idx(8)] = old.wrapping_add(n4);
    }
    state
}

fn branch0_f13(query_sm3: &[u8], body_md5: &[u8], ts: &[u8], khronos: u32, iv_v0: u32) -> Vec<u8> {
    let iv_v1 = BRANCH0_IV[(iv_v0 as usize).min(BRANCH0_IV.len() - 1)];
    let count_v1 = iv_v1.wrapping_add(khronos).wrapping_add(1) & 255;
    let count_v2 = iv_v1.wrapping_add(khronos);

    let tt: Vec<u32> = BRANCH0_TT.iter().map(|v| ror32(*v, count_v1)).collect();

    let n0 = count_v2.wrapping_add(2) & 7;
    let seed = [0xfau8, 0x45, 0x61, 0xd7];
    let pad: Vec<u8> = seed
        .iter()
        .map(|v| {
            let combined = (*v as u16) | ((*v as u16) << 8);
            ((combined >> n0) & 255) as u8
        })
        .collect();

    let mut data = query_sm3.to_vec();
    data.extend_from_slice(body_md5);
    data.extend_from_slice(ts);
    data.extend_from_slice(&pad);
    data.extend_from_slice(&[0, 0, 0, 0, 0, 0, 0x01, 0xa0]);

    let di = expand_words(&data);

    let init: Vec<u32> = BRANCH0_INIT
        .iter()
        .map(|v| ror32(*v, count_v2 & 31))
        .collect();

    let rounds = &BRANCH0_ROUNDS[(iv_v0 as usize).min(BRANCH0_ROUNDS.len() - 1)];
    let d = mix_rounds(init.clone(), rounds, &di, &tt, iv_v1);

    let mut ret = Vec::with_capacity(32);
    for i in 0..8 {
        ret.extend_from_slice(&d[i].wrapping_add(init[i]).to_be_bytes());
    }
    for i in 0..16 {
        ret[i] ^= ret[16 + i];
    }
    let mut out = ret[..16].to_vec();
    out.extend_from_slice(&le32(sum_md5(&ret[..16])));
    out
}

/// 自定义 MD5 的 32 位步函数。（参数即 MD5 轮函数的固有输入，减一个都没法算。）
#[allow(clippy::too_many_arguments)]
fn md5_v3_step(
    kind: u32,
    a: u32,
    b: u32,
    c: u32,
    d: u32,
    m: u32,
    shift: u32,
    constant: u32,
) -> u32 {
    let f = match kind {
        0 => (b & c) | (!b & d),
        1 => (b & d) | (c & !d),
        2 => b ^ c ^ d,
        _ => c ^ (b | !d),
    };
    b.wrapping_add(rol32(
        a.wrapping_add(f).wrapping_add(m).wrapping_add(constant),
        shift,
    ))
}

/// 带置换表与旋转常量的 MD5 变体，输出 20 字节。
fn md5_sum_v3(message: &[u8], count_v2: u32, orders: &[u8], count_v1: u32) -> Vec<u8> {
    let sv: Vec<u32> = BRANCH2_SV.iter().map(|v| ror32(*v, count_v1)).collect();
    let start = [
        ror32(0x79e0_f2fb, count_v2),
        ror32(0xc8b5_2570, count_v2),
        ror32(0xebc2_f8cd, count_v2),
        ror32(0x7c10_4d93, count_v2),
    ];
    let end_count = count_v2.wrapping_add(6) & 255;
    let end = [
        ror32(0x19be_4866, end_count),
        ror32(0xe859_86b4, end_count),
        ror32(0xe19b_326e, end_count),
        ror32(0x71d1_d7d4, end_count),
    ];

    let m: Vec<u32> = message
        .chunks_exact(4)
        .map(|c| u32::from_le_bytes([c[0], c[1], c[2], c[3]]))
        .collect();

    let (mut a, mut b, mut c, mut d) = (start[0], start[1], start[2], start[3]);

    let phases: [(u32, [u32; 16], usize); 4] = [
        (
            0,
            [7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22],
            0,
        ),
        (
            1,
            [5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20],
            16,
        ),
        (
            2,
            [4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23],
            32,
        ),
        (
            3,
            [6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21],
            48,
        ),
    ];

    for (kind, shifts, offset) in phases {
        for i in 0..16 {
            let w = m[orders[offset + i] as usize];
            let k = sv[offset + i];
            match i & 3 {
                0 => a = md5_v3_step(kind, a, b, c, d, w, shifts[i], k),
                1 => d = md5_v3_step(kind, d, a, b, c, w, shifts[i], k),
                2 => c = md5_v3_step(kind, c, d, a, b, w, shifts[i], k),
                _ => b = md5_v3_step(kind, b, c, d, a, w, shifts[i], k),
            }
        }
    }

    let mut ret = Vec::with_capacity(20);
    ret.extend_from_slice(&le32(start[0].wrapping_add(a) ^ end[0]));
    ret.extend_from_slice(&le32(start[1].wrapping_add(b) ^ end[1]));
    ret.extend_from_slice(&le32(start[2].wrapping_add(c) ^ end[2]));
    ret.extend_from_slice(&le32(start[3].wrapping_add(d) ^ end[3]));
    ret.extend_from_slice(&le32(sum_md5(&ret)));
    ret
}

fn branch2_f13(iv: u32, query_sm3: &[u8], body_md5: &[u8], ts: &[u8], khronos: u32) -> Vec<u8> {
    let v = (iv & 13).wrapping_mul(86);
    let iv_v0 = ((v >> 15) & 255).wrapping_add((v >> 8) & 255);

    let n1s = [
        0x8980_f29bu32,
        0xeb54_9c7f,
        0xb087_26db,
        0xd40c_b5e6,
        0xe8f5_59e4,
    ];
    let n1 = n1s[(iv_v0 as usize).min(n1s.len() - 1)];

    let count_v1 = n1.wrapping_add(khronos).wrapping_add(1) & 255;
    let count_v2 = n1.wrapping_add(khronos);
    let shift = count_v2.wrapping_add(5) & 7;

    let seed = [0x84u8, 0x96, 0x77, 0x9d, 0xd4, 0x15, 0x0b, 0xf8];
    let pad: Vec<u8> = seed
        .iter()
        .map(|v| {
            let combined = (*v as u16) | ((*v as u16) << 8);
            ((combined >> shift) & 255) as u8
        })
        .collect();

    let mut input = query_sm3.to_vec();
    input.extend_from_slice(body_md5);
    input.extend_from_slice(ts);
    input.extend_from_slice(&pad);
    input.extend_from_slice(&[0xa0, 0x01, 0x00, 0x00]);

    let begin = (iv_v0 as usize) << 6;
    let orders = &BRANCH2_ORDERS[begin..begin + 64];
    md5_sum_v3(&input, count_v2, orders, count_v1)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn branch_selection_is_0_1_or_2() {
        for i in 0..64u8 {
            let q = crate::hongguo::sm3::sm3(&[i, i.wrapping_mul(7)]);
            let b = branch_of(&q, &[i; 16], &le32(i as u32));
            assert!(b < 3, "分支号必须落在 0..2，实际 {b}");
        }
    }
}
