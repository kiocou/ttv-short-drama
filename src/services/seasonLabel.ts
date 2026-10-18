/**
 * 分季标题的解析与排序。
 *
 * 抽成**无依赖的纯函数模块**（不 import ipc / React / tauri）：这些规则要能被
 * `scripts/verify-season-label.mjs` 直接当黑盒跑，而 `relatedSeries.ts` 那条
 * 链路会拉起 IPC 与 Tauri 运行时，在 Node 里跑不起来。
 *
 * 规则与 `src-tauri/src/provider.rs` 的 `search_season` / `parse_season_number` /
 * `search_text` 逐条对齐 —— 后端负责"把同一系列的各季捞回来"，前端负责"从捞回来
 * 的条目里认出哪些真属于这一系列"，两边判出来的结果必须一致，否则会出现
 * "后端补了那一季、前端却认不出来"的错位。
 */

/** 与 `provider.rs::SEARCH_SEASON_LIMIT` 一致：超过这个数的多半是「第1080集」被误认。 */
export const SEASON_LIMIT = 200;

export interface SeasonLabel {
  /** 摘掉季号后的剧名（比较与回查都用它）。 */
  base: string;
  /** 季号，1..=SEASON_LIMIT。 */
  season: number;
  /** 量词：`季` 或 `部`。同一系列的量词必须一致才算同组。 */
  unit: '季' | '部';
}

const CN_DIGITS: Record<string, number> = {
  零: 0,
  '〇': 0,
  一: 1,
  二: 2,
  两: 2,
  兩: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
};

const isAsciiDigit = (ch: string) => ch >= '0' && ch <= '9';

/** 与 Rust 侧 `is_season_digit` 同一份字符集（十/百只在进位里被解释）。 */
function isSeasonDigit(ch: string): boolean {
  return isAsciiDigit(ch) || ch in CN_DIGITS || ch === '十' || ch === '百';
}

/** 字母与数字（含中日韩汉字）都算有意义的标题字符；标点、空白、书名号不算。 */
const isWordChar = (ch: string) => /[\p{L}\p{N}]/u.test(ch);

/**
 * 中文/阿拉伯数字 → 季号。**拒绝优先于硬凑**。
 *
 * 照抄 `provider.rs::parse_season_number`：权值不降（「十十」）、个位堆了两位
 * （「十二三」）这类写法一律返回 null。它们看着像季号，其实来自被误读的标题；
 * 硬算出一个数字，界面就会去推荐一部根本不存在的「第33季」。
 */
export function parseSeasonNumber(label: string): number | null {
  const chars = [...label];
  if (chars.length === 0) return null;
  if (chars.every(isAsciiDigit)) {
    const value = Number.parseInt(label, 10);
    return Number.isFinite(value) ? value : null;
  }
  // 没有十/百的纯位值写法（实测基本只有单个「二」），逐位累加。
  if (!chars.some(ch => ch === '十' || ch === '百')) {
    let number = 0;
    for (const ch of chars) {
      const digit = CN_DIGITS[ch];
      if (digit === undefined) return null;
      number = number * 10 + digit;
      if (number > SEASON_LIMIT) return null;
    }
    return number;
  }
  let number = 0;
  let digit = 0;
  let previous = 1000;
  let carried = false;
  for (const ch of chars) {
    const value = CN_DIGITS[ch];
    if (value !== undefined) {
      digit = digit * 10 + value;
      // 个位只容得下一位，否则「十二三」会被硬算成 33。
      if (digit > 9) return null;
      continue;
    }
    const weight = ch === '十' ? 10 : ch === '百' ? 100 : null;
    if (weight === null) return null;
    if (weight >= previous || digit > 9 || (carried && digit === 0)) return null;
    // 「十」= 10、「百」= 100：首位空个位按 1 算，这是中文数字的省略写法。
    number += Math.max(digit, 1) * weight;
    digit = 0;
    previous = weight;
    carried = true;
  }
  return number + digit;
}

/**
 * 解析标题尾部的「第N季 / 第N部」，返回 `(base, 季号, 量词)`。
 *
 * 只认**尾部**后缀，理由与 Rust 侧一致：「第三季」这种本身就叫这个名字的片子
 * 没有 base，认下来只会造出一个空组，把不相关的剧凑成"同系列"。
 * base 两端的标点要摘掉（实测有「《聚宝仙盆》第二季」这类写法），否则 base 不等于
 * 用户会输入的剧名，拿去当关键词搜就搜不到。
 */
export function parseSeasonLabel(title: string): SeasonLabel | null {
  const chars = [...title.trim().replace(/[^\p{L}\p{N}]+$/u, '')];
  if (chars.length === 0) return null;
  const unit = chars[chars.length - 1];
  if (unit !== '季' && unit !== '部') return null;

  let labelEnd = chars.length - 1;
  // 「第 2 季」在实测数据里出现过，数字与量词之间也要容空白。
  while (labelEnd > 0 && /\s/.test(chars[labelEnd - 1])) labelEnd -= 1;
  let start = labelEnd;
  while (start > 0 && isSeasonDigit(chars[start - 1])) start -= 1;
  if (start === labelEnd) return null;

  let marker = start;
  while (marker > 0 && /\s/.test(chars[marker - 1])) marker -= 1;
  if (marker === 0 || chars[marker - 1] !== '第') return null;

  const season = parseSeasonNumber(chars.slice(start, labelEnd).join(''));
  if (season === null || season < 1 || season > SEASON_LIMIT) return null;

  const base = chars
    .slice(0, marker - 1)
    .join('')
    .replace(/^[^\p{L}\p{N}]+/u, '')
    .replace(/[^\p{L}\p{N}]+$/u, '');
  if (!base) return null;

  return { base, season, unit };
}

/**
 * 比较用的归一化文本：全角转半角 → 去掉所有非字母数字 → 转小写。
 *
 * 与 `provider.rs::search_text` 同一套规则。站点同一句话在不同位置写法不一致
 * （卡片标题中间会带 U+3000 全角空格，用户又会照着海报敲全角数字），不归一
 * 「聚宝仙盆」与「聚宝仙盆　第二季」就永远比不相等，同系列判定直接失灵。
 *
 * 归一后为空（标题全是标点）时退回「仅 trim + 小写」：否则空串会被任何标题
 * 判成同系列，整页结果都被认成一家人。
 */
export function normalizeTitle(input: string): string {
  let out = '';
  for (const ch of input) {
    let current = ch === '\u3000' ? ' ' : ch;
    const code = current.codePointAt(0) ?? 0;
    if (code >= 0xff01 && code <= 0xff5e) {
      current = String.fromCharCode(code - 0xfee0);
    }
    if (isWordChar(current)) out += current.toLowerCase();
  }
  return out || input.trim().toLowerCase();
}

/**
 * 同系列其它季的排序键：**后续季优先、越近越前**；前面的季排在后面、同样越近越前。
 *
 * ## 为什么两段都用「越近越前」
 *
 * 用户给的例子是「刚看第1季 → 推荐第2、3、4…季」，所以"往后接"是第一优先级，
 * 且按 2、3、4 递增——这本身就是"越近越前"。
 *
 * 后面没有了（当前已是最后一季）时，前面那批同样要越近越前：看完第14季，
 * 第13季才是最近的接续，第2季是十季之前的内容。此前这里用的是升序（1、2、3…，
 * 按"从头补番"的直觉写），实测在第14季上直接把第13、12季挤出了一屏——一屏只装
 * 6 张，升序时前 6 张全是 2、3、5、6、8、9，最近的两季反而看不到。
 *
 * 排前面的季用 `1000 +` 偏移而不是负数：偏移只用来把两段分开，段内顺序仍然是
 * `season` 本身，所以降序就是 `current - season`。
 */
export function seasonOrder(season: number, current: number): number {
  return season > current ? season - current : 1000 + (current - season);
}
