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
  /**
   * 量词：`季` / `部` / `期`。
   *
   * 「期」是 2026-10-29 补的：实测《烬九州》第 1~31 季写作「第N季」，而第 32~35 季
   * 写作「第三十二期」……「第三十五期」—— 同一系列内部就混用了两种量词。此前只认
   * 「季/部」，那 4 季会被当成"无季号条目"直接丢掉，35 季的系列永远只能铺 31 张卡。
   *
   * 两者的分组关系见 `seasonUnitGroup`：`季` 与 `期` 是同一套编号，`部` 是另一套。
   */
  unit: '季' | '部' | '期';
}

/**
 * 量词的**组别**：同组的季号才能互相编号、互相比较。
 *
 * ## 为什么「季」与「期」必须同组
 *
 * 站方对同一系列会混用这两个字（实测《烬九州》：前 31 季是「第N季」，后 4 季是
 * 「第N期」）。它们是同一套连续编号，「第三十五期」就是第 35 季；分开成两组的话，
 * 从「第31季」视角看过去，32~35 期全部被量词判定拒掉，弹窗还是缺最后 4 季。
 *
 * ## 为什么「部」不能并进来
 *
 * 「部」是另一种分卷习惯（《镇世无双第三部》），它和「季」是两套独立编号。并组后
 * 「第2部」会排到「第2季」旁边，用户看到的是两套编号撞在一起 —— 既有断言
 * `scripts/related-pick-probe.ts:77`（`${BASE}第一部` 必须被排除）正是钉这条。
 */
export function seasonUnitGroup(unit: SeasonLabel['unit']): 'season' | 'volume' {
  return unit === '部' ? 'volume' : 'season';
}

/**
 * **省略「第」时**允许紧邻在季号前面的分隔符（2026-10-29，实测《烬九州》）。
 *
 * ## 为什么需要这份集合
 *
 * 站方并不总是写「第N季」：`7700456247924886553` 的标题是「烬九州：三十四季」，
 * 季号前是一个全角冒号。`parseSeasonLabel` 原本硬性要求紧邻「第」，于是这条解析
 * 不出来 —— 搜索页认不出这是哪个系列（锚点跑偏），详情页 `currentSeasonLabel`
 * 更会兜底成"第 1 季 + base=整个标题"，系列剧弹窗的排除与接续排序全错。
 *
 * ## 边界为什么收死在这几个字符
 *
 * 放宽成"任意位置出现数字+量词"会把不相干的剧并进同一个系列（`第二季的逆袭` 尾部
 * 不是量词会被误读、`三十四季` 没有 base 会造出空组）。**只允许**数字前紧邻下列
 * 分隔符之一，其余情形仍然必须紧邻「第」—— 这是唯一的闸门。
 *
 * ⚠️ **与 `provider.rs::SEASON_SEPARATORS` 逐字对齐**，两处判定必须一致：后端靠它
 * 决定"这一条属于哪个系列"，前端靠它决定"这批结果里出现了哪个系列"。一边认一边不认，
 * 表现就是"后端补了那一季、前端却认不出来"。改这里请同时改 Rust 侧（反之亦然）。
 *
 * 空白另外算（看 `isSeasonSeparator`）：`烬九州 三十四季` 也是站方真实写法。
 */
export const SEASON_SEPARATORS = '：:·-—｜|/、';

/**
 * 是不是"可以替代「第」"的那个字符。
 *
 * 集合本身 + 任意空白（半角/全角空格、制表符）。分开判而不是把空白塞进常量：常量
 * 要能与 Rust 侧逐字对照，而空白在 Rust 里是 `ch.is_whitespace()`，不是字面量字符。
 */
function isSeasonSeparator(ch: string | undefined): boolean {
  if (ch === undefined) return false;
  return SEASON_SEPARATORS.includes(ch) || /\s/.test(ch);
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
 * 解析标题尾部的「第N季 / 第N部 / 第N期」，返回 `(base, 季号, 量词)`。
 *
 * 只认**尾部**后缀，理由与 Rust 侧一致：「第三季」这种本身就叫这个名字的片子
 * 没有 base，认下来只会造出一个空组，把不相关的剧凑成"同系列"。
 * base 两端的标点要摘掉（实测有「《聚宝仙盆》第二季」这类写法），否则 base 不等于
 * 用户会输入的剧名，拿去当关键词搜就搜不到。
 *
 * 「期」是后补的第三种量词（2026-10-29，实测《烬九州》第 32~35 季写作「第N期」）。
 * 同一天还补了**省略「第」**的写法（「烬九州：三十四季」）：季号前可以是
 * `第`，也可以是 `SEASON_PREFIX_SEPARATORS` 里的分隔符之一。两条规则的收口点就是
 * "数字串必须紧邻 `第` 或一个分隔符"，其余一律拒绝。
 *
 * ⚠️ 与 `provider.rs` 的对齐因此有两处**待同步**：Rust 侧的 `search_season` 还只认
 * 「第」和「季/部」，所以搜索回退链路仍可能漏掉「第N期」「：N季」这几条。这不影响
 * 权威链路 —— 详情页弹窗与搜索页聚合都走后端 `catalog_series_seasons`，季号由后端
 * 结构化给出（见 `relatedSeries.ts` 的 `seasonsFromApi`），完全不解析标题。
 */
export function parseSeasonLabel(title: string): SeasonLabel | null {
  const chars = [...title.trim().replace(/[^\p{L}\p{N}]+$/u, '')];
  if (chars.length === 0) return null;
  const unit = chars[chars.length - 1];
  // 「期」与「季」同义（见 `seasonUnitGroup`）：实测《烬九州》第 32~35 季就写作
  // 「第三十二期」……「第三十五期」。不认它，那几季在纯搜索链路里等于不存在。
  if (unit !== '季' && unit !== '部' && unit !== '期') return null;

  let labelEnd = chars.length - 1;
  // 「第 2 季」在实测数据里出现过，数字与量词之间也要容空白。
  while (labelEnd > 0 && /\s/.test(chars[labelEnd - 1])) labelEnd -= 1;
  let start = labelEnd;
  while (start > 0 && isSeasonDigit(chars[start - 1])) start -= 1;
  if (start === labelEnd) return null;

  /**
   * 前缀判定：`第`，或一个分隔符（省略「第」的写法，见 `SEASON_SEPARATORS`）。
   *
   * 有「第」时兼容数字与「第」之间的空白（「第 2 季」）；没有「第」时要求数字**紧邻**
   * 分隔符或空白，`start === 0`（标题以季号开头，如「三十四季」）直接拒绝 —— 这既是
   * 边界，也是"base 为空"的同一件事。
   *
   * base 在两种情形下都只切到「数字起点之前」：有「第」时切到「第」之前，无「第」时
   * 切到数字之前，剩下的分隔符交给下面那两条首尾 trim 摘掉（冒号、破折号、空白都
   * 不是 `\p{L}\p{N}`，自然被摘）。
   */
  let marker = start;
  while (marker > 0 && /\s/.test(chars[marker - 1])) marker -= 1;

  let baseEnd: number;
  if (marker > 0 && chars[marker - 1] === '第') {
    baseEnd = marker - 1;
  } else {
    if (!isSeasonSeparator(start > 0 ? chars[start - 1] : undefined)) return null;
    baseEnd = start;
  }

  const season = parseSeasonNumber(chars.slice(start, labelEnd).join(''));
  if (season === null || season < 1 || season > SEASON_LIMIT) return null;

  const base = chars
    .slice(0, baseEnd)
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
