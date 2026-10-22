/**
 * 「后续季优先」的探针（由 `verify-season-priority.mjs` 打包执行）。
 *
 * ## 这条契约是什么、现在落在哪
 *
 * 用户原话：*如果我播放的是第5季，然后就展示第6、第7、第8、第9、第10季这样子的，
 * 优先展示后面*。
 *
 * 2026-10-21 之前这条契约落在详情页的「猜你喜欢」栏（一屏 6 张、按批翻）。用户随后
 * 要求把系列短剧整块移出那一栏，改由「系列剧」按钮弹窗**完整展示**，于是同一条
 * 排序契约搬到了弹窗的数据源（`fetchSeriesSeasons`）上，并且**不再分屏**：
 *
 * - 排序仍是「后续季在前、越近越前，然后前作、越近越前」；
 * - 但弹窗一次铺开全部季，没有"第二屏"这回事 —— 一个 14 季的系列不该点三次才看全；
 * - 当前季依旧排除在外（用户明确要求：看第 4 季，新窗口不显示第 4 季）。
 *
 * 这里刻意不复用 `pickSeasons` 的断言方式（那组验的是筛选口径），而是从**用户在
 * 弹窗里看到的卡片顺序**倒推：即使筛选正确，排序一旦退回升序，第 13 季就会被挤到
 * 第 2 季后面——那正是这条用例要防的回归。
 */
import { fetchSeriesSeasons } from '../src/services/relatedSeries';
import { parseSeasonLabel } from '../src/services/seasonLabel';
import type { SeriesItem } from '../src/types/catalog';
import type { SeriesDetail } from '../src/types/series';

declare global {
  // eslint-disable-next-line no-var
  var __FAKE__: { fast?: unknown[] | 'reject'; suggest?: unknown[] | 'reject'; catalog?: unknown[] | 'reject' };
}

let pass = 0;
let fail = 0;

function check(name: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) pass += 1;
  else fail += 1;
  console.log(
    `${ok ? 'PASS ' : 'FAIL '}${name}` +
      (ok ? '' : `  期望=${JSON.stringify(expected)} 实际=${JSON.stringify(actual)}`),
  );
}

function item(id: string, title: string): SeriesItem {
  return { id, title, cover: '', type: 'comic', episodesCount: 100, tags: ['玄幻'], origin: '红果' };
}

function detail(title: string, overrides: Partial<SeriesDetail> = {}): SeriesDetail {
  return {
    id: '1000',
    title,
    cover: '',
    type: 'comic',
    tags: ['玄幻'],
    origin: '红果',
    episodesCount: 222,
    description: '',
    episodes: [],
    availableQualities: [],
    sources: [],
    ...overrides,
  };
}

const BASE = '聚宝仙盆之杂灵根才是真BOSS';

/** 造一整组 1..N 季的候选条目。 */
function seasonsUpTo(count: number): SeriesItem[] {
  return Array.from({ length: count }, (_, index) => item(`s${index + 1}`, `${BASE}第${index + 1}季`));
}

/** 弹窗里季卡的季号序列（用户实际看到的顺序）。 */
function seasonNumbers(picks: { season: number }[]): number[] {
  return picks.map(pick => pick.season);
}

// ── 1. 核心场景：看第5季，顺序必须是 6,7,8,9,10… 再 4,3,2,1 ────────
{
  globalThis.__FAKE__ = { fast: seasonsUpTo(12), suggest: [], catalog: [] };
  const picks = await fetchSeriesSeasons(detail(`${BASE}第五季`));

  check('后续季 6,7,8,9,10,11,12 整体排在最前',
    seasonNumbers(picks).slice(0, 7), [6, 7, 8, 9, 10, 11, 12]);
  check('前作按越近越前接在后面', seasonNumbers(picks).slice(7), [4, 3, 2, 1]);
  check('当前季（第5季）不在弹窗里', seasonNumbers(picks).includes(5), false);
  check('弹窗一次给全（11 季，不分屏）', picks.length, 11);
}

// ── 1b. 用户原话的精确场景：站上共 10 季，看第5季 → 6,7,8,9,10 打头 ──
{
  globalThis.__FAKE__ = {
    fast: seasonsUpTo(10),
    suggest: [],
    catalog: [item('o1', '别的剧A'), item('o2', '别的剧B')],
  };
  const picks = await fetchSeriesSeasons(detail(`${BASE}第五季`));

  check('后续季 6,7,8,9,10 全部出现在最前面',
    seasonNumbers(picks).slice(0, 5), [6, 7, 8, 9, 10]);
  check('后续季占满前五个位置（不被别的剧插入）',
    seasonNumbers(picks).slice(0, 5).every(season => season > 5), true);
  check('弹窗不掺同频道的其它剧', picks.some(pick => pick.item.id === 'o1'), false);
}

// ── 2. 后续季不足：先接后续，再用前作补 ──────────────────────────
{
  globalThis.__FAKE__ = {
    fast: seasonsUpTo(8),
    suggest: [],
    catalog: [item('o1', '别的剧A')],
  };
  const picks = await fetchSeriesSeasons(detail(`${BASE}第五季`));

  check('后续季 6,7,8 排在最前', seasonNumbers(picks).slice(0, 3), [6, 7, 8]);
  check('前作按越近越前接在后面', seasonNumbers(picks).slice(3), [4, 3, 2, 1]);
  check('前作还没排完时不出别的剧', picks.some(pick => pick.item.id === 'o1'), false);
}

// ── 3. 只有前作可看（看最后一季）：前作按越近越前 ────────────────
{
  globalThis.__FAKE__ = { fast: seasonsUpTo(10), suggest: [], catalog: [item('o1', '别的剧A')] };
  const picks = await fetchSeriesSeasons(detail(`${BASE}第十季`));

  check('看第10季：前作 9,8,7,6,5,4,3,2,1', seasonNumbers(picks), [9, 8, 7, 6, 5, 4, 3, 2, 1]);
  check('没有后续季时不掺别的剧', picks.some(pick => pick.item.id === 'o1'), false);
}

// ── 4. 站上只有 3 季、看第 2 季：弹窗只有 3 与 1 ──────────────────
{
  globalThis.__FAKE__ = { fast: seasonsUpTo(3), suggest: [], catalog: [] };
  const picks = await fetchSeriesSeasons(detail(`${BASE}第二季`));

  check('只有第3季与第1季两张卡', seasonNumbers(picks), [3, 1]);
  check('两张卡都是同系列（不补别的剧凑数）', picks.length, 2);
}

// ── 5. 两路搜索结果合并后仍按同一套顺序排 ────────────────────────
{
  globalThis.__FAKE__ = {
    fast: [item('s2', `${BASE}第二季`), item('s6', `${BASE}第六季`)],
    suggest: [item('s3', `${BASE}第三季`), item('s4', `${BASE}第四季`)],
    catalog: [],
  };
  const picks = await fetchSeriesSeasons(detail(`${BASE}第五季`));

  // 看第5季：后续只有 6；前作 4,3,2。
  check('两路合并后：6 在前，4,3,2 在后', seasonNumbers(picks), [6, 4, 3, 2]);
}

// ── 6. 排序本身：后续季必须整体排在前作之前 ──────────────────────
{
  const label = parseSeasonLabel(`${BASE}第五季`)!;
  globalThis.__FAKE__ = { fast: seasonsUpTo(10), suggest: [], catalog: [] };
  const picks = await fetchSeriesSeasons(detail(`${BASE}第五季`));
  const all = seasonNumbers(picks);
  const splitIndex = all.findIndex(season => season < label.season);
  check('所有后续季都排在前作之前',
    splitIndex === -1 ? true : all.slice(splitIndex).every(season => season < label.season), true);
  check('弹窗里的季号序列（后续在前）', all, [6, 7, 8, 9, 10, 4, 3, 2, 1]);
}

// ── 7. 大系列：14 季看第 14 季，13 季全部铺开且从 13 起 ──────────
{
  globalThis.__FAKE__ = { fast: seasonsUpTo(14), suggest: [], catalog: [] };
  const picks = await fetchSeriesSeasons(detail(`${BASE}第十四季`));

  check('14 季里排除当前季 → 13 张卡', picks.length, 13);
  check('最近的接续季（第13季）排第一', seasonNumbers(picks)[0], 13);
  check('最远的前作（第1季）排最后', seasonNumbers(picks)[12], 1);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exitCode = 1;
