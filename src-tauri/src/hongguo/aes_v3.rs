//! medusa 用的自定义 AES 变体。
//!
//! 移植自 `internal/protocol/sign/aes.go`。它不是标准 AES：S-box 从 1024 字节表里
//! 按 `khronos & 3` 选 256 字节，列混淆用自定义 `con2` 置换，行移位用 `order` 表，
//! 而且 `encrypt` 做的是「把 31 字节的比特流藏进原文每个字节的空闲位」——
//! 这一步最容易写错，必须靠黄金向量校准。

use crate::hongguo::consts::{sbox, AES_CON2, AES_INIT_WORD, AES_ORDER};

pub struct AesV3 {
    boxed: &'static [u8; 256],
    con2: [usize; 4],
    order: [usize; 16],
    keys: [[u8; 4]; 12],
}

type State = [[u8; 4]; 4];

fn xor_bytes(a: &[u8], b: &[u8]) -> Vec<u8> {
    let mut out = a.to_vec();
    for (i, slot) in out.iter_mut().enumerate() {
        *slot ^= b[i % b.len()];
    }
    out
}

fn expand_aes(key: &[u8], word: usize) -> [[u8; 4]; 12] {
    let init = AES_INIT_WORD[word];
    let boxed = sbox(word);

    let mut initial = Vec::with_capacity(16);
    let le = init.to_le_bytes();
    for _ in 0..4 {
        initial.extend_from_slice(&le);
    }

    let mut expanded = xor_bytes(&initial, key);
    expanded.extend_from_slice(&[0u8; 32]);

    let mut rounds: u32 = 8;
    for i in 4..12usize {
        let at = 4 * (i - 1);
        let (mut a, mut b, mut c, mut d) = (
            expanded[at],
            expanded[at + 1],
            expanded[at + 2],
            expanded[at + 3],
        );
        if i & 3 == 0 {
            // Go: ((init >> (rounds & 24)) ^ uint32(box[b])) & 255
            let t = ((init >> (rounds & 24)) ^ boxed[b as usize] as u32) & 255;
            b = boxed[c as usize];
            c = boxed[d as usize];
            d = boxed[a as usize];
            a = t as u8;
        }
        rounds = rounds.wrapping_add(2);
        expanded[at + 4] = a ^ expanded[at - 12];
        expanded[at + 5] = b ^ expanded[at - 11];
        expanded[at + 6] = c ^ expanded[at - 10];
        expanded[at + 7] = d ^ expanded[at - 9];
    }

    let mut keys = [[0u8; 4]; 12];
    for (i, slot) in keys.iter_mut().enumerate() {
        slot.copy_from_slice(&expanded[i * 4..i * 4 + 4]);
    }
    keys
}

impl AesV3 {
    pub fn new(key: &[u8], khronos: u32) -> Self {
        let word = (khronos & 3) as usize;
        Self {
            boxed: sbox(word),
            con2: AES_CON2[word],
            order: AES_ORDER[word],
            keys: expand_aes(key, word),
        }
    }

    fn add_con(&self, state: &mut State, keys: &[[u8; 4]]) {
        for i in 0..4 {
            for j in 0..4 {
                state[i][j] ^= keys[i][self.con2[j]];
            }
        }
    }

    fn sub(&self, state: &mut State) {
        for row in state.iter_mut() {
            for cell in row.iter_mut() {
                *cell = self.boxed[*cell as usize];
            }
        }
        let old = *state;
        for i in 0..4 {
            state[i] = old[self.con2[i]];
        }
    }

    fn shift(&self, state: &mut State) {
        let mut flat = [0u8; 16];
        for i in 0..4 {
            for j in 0..4 {
                flat[i * 4 + j] = state[i][j];
            }
        }
        for i in 0..16 {
            state[i / 4][i % 4] = flat[self.order[i]];
        }
    }

    fn shift_con(&self, state: &mut State) {
        let old = *state;
        for i in 0..4 {
            for j in 0..4 {
                state[i][j] = old[i][self.con2[j]];
            }
        }
    }

    fn mix_columns(state: &mut State) {
        let xt = |x: u8| -> u8 {
            let v = x.wrapping_shl(1);
            if x & 128 != 0 {
                v ^ 0x1b
            } else {
                v
            }
        };
        // 索引写法是 Go 参考实现的直译，四位状态的行间交叉引用
        // （state[3][i] 依赖上一轮的 state[0][i]）不适合改成迭代器。
        #[allow(clippy::needless_range_loop)]
        for i in 0..4 {
            let t = state[0][i] ^ state[1][i] ^ state[2][i] ^ state[3][i];
            let u = state[0][i];
            state[0][i] ^= t ^ xt(state[0][i] ^ state[1][i]);
            state[1][i] ^= t ^ xt(state[1][i] ^ state[2][i]);
            state[2][i] ^= t ^ xt(state[2][i] ^ state[3][i]);
            state[3][i] ^= t ^ xt(state[3][i] ^ u);
        }
    }

    fn block(&self, value: &[u8]) -> Vec<u8> {
        let mut state: State = [[0u8; 4]; 4];
        for (i, row) in state.iter_mut().enumerate() {
            row.copy_from_slice(&value[i * 4..i * 4 + 4]);
        }
        self.add_con(&mut state, &self.keys[0..4]);
        for i in 1..3 {
            self.sub(&mut state);
            self.shift(&mut state);
            if i == 1 {
                self.shift_con(&mut state);
                Self::mix_columns(&mut state);
            }
            self.add_con(&mut state, &self.keys[i * 4..i * 4 + 4]);
        }
        for (row, key_row) in state.iter_mut().zip(self.keys[4..].iter()) {
            for (v, k) in row.iter_mut().zip(key_row.iter()) {
                *v ^= k;
            }
        }
        let mut out = Vec::with_capacity(16);
        for row in state.iter() {
            out.extend_from_slice(row);
        }
        out
    }

    /// 把 31 字节的信息比特藏进 `data` 各字节的空闲位，返回首字节 + 原文。
    pub fn encrypt(&self, data: &[u8], iv: &[u8]) -> Vec<u8> {
        let source = data.to_vec();
        let mut plaintext = [0u8; 32];
        for (i, slot) in plaintext.iter_mut().enumerate().take(31) {
            let at = i * 8;
            let n0 = (source[at] >> 4) & 2;
            let n1 = n0 | (source[at + 1] & 64);
            let n2 = n1 | ((source[at + 2] >> 2) & 1);
            let n3 = n2 | ((source[at + 3].wrapping_shl(3)) & 128);
            let n4 = n3 | ((source[at + 4] >> 1) & 4);
            let n5 = n4 | ((source[at + 5].wrapping_shl(3)) & 16);
            let n6 = n5 | ((source[at + 6].wrapping_shl(5)) & 32);
            *slot = n6 | ((source[at + 7] >> 4) & 8);
        }
        plaintext[31] = 1;

        let mut blocks: Vec<u8> = Vec::with_capacity(32);
        let mut previous = iv.to_vec();
        for off in (0..32).step_by(16) {
            let value = self.block(&xor_bytes(&plaintext[off..off + 16], &previous));
            blocks.extend_from_slice(&value);
            previous = value;
        }

        let mut out = source.clone();
        for (i, k) in blocks.iter().enumerate().take(31) {
            let k = *k;
            let at = i * 8;
            out[at] &= 0xdf;
            out[at] |= (k << 4) & 32;
            out[at + 1] &= 0xbf;
            out[at + 1] |= k & 64;
            out[at + 2] &= 0xfb;
            out[at + 2] |= (k << 2) & 4;
            out[at + 3] &= 0xef;
            out[at + 3] |= (k >> 3) & 16;
            out[at + 4] &= 0xf7;
            out[at + 4] |= k.wrapping_add(k) & 8;
            out[at + 5] &= 0xfd;
            out[at + 5] |= (k >> 3) & 2;
            out[at + 6] &= 0xfe;
            out[at + 6] |= (k >> 5) & 1;
            out[at + 7] &= 0x7f;
            out[at + 7] |= k.wrapping_shl(4) & 128;
        }

        let mut result = vec![blocks[31]];
        result.extend_from_slice(&out);
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encrypt_preserves_length() {
        let key = [0u8; 16];
        let iv = [0u8; 16];
        let data = vec![0x5au8; 256];
        let out = AesV3::new(&key, 0).encrypt(&data, &iv);
        // Go: 1 + len(source)
        assert_eq!(out.len(), data.len() + 1);
    }

    #[test]
    fn different_khronos_gives_different_output() {
        let key = [7u8; 16];
        let iv = [9u8; 16];
        let data = vec![0x11u8; 256];
        let a = AesV3::new(&key, 0).encrypt(&data, &iv);
        let b = AesV3::new(&key, 1).encrypt(&data, &iv);
        assert_ne!(a, b, "khronos & 3 决定 S-box 分片，输出必须不同");
    }
}
