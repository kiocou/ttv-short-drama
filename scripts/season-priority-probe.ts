/**
 * 「后续季优先铺满一屏」的探针（由 `verify-season-priority.mjs` 打包执行）。
 *
 * ## 这条契约是什么
 *
 * 用户原话：*如果我播放的是第5季，然后就展示第6、第7、第8、第9、第10季这样子的，
 * 优先展示后面*。
 *
 * 所以这组用例断言的全是**"第5季视角下第一屏长什么样"**：
 * - 第一屏必须是 6、7、8、9、10 连号铺满；
 * - 前作（第1~4季）只能排在后续季之后；
 * - 同频道其它剧只能在没有后续季可放时才出现。
 *
 * 这里刻意不复用 `pickSeasons` 的断言方式（那组验的是筛选口径），而是从**用户视角
 * 的屏内容**倒推：即使筛选与排序都正确，只要切片时给兜底留了座位，第10季就会被挤出
 * 屏幕——那正是这组用例要防的回归。
 */
import {
  fetchRelatedSeries,
  relatedBatchCount,
  sliceRelatedBatch,
  SLOT_COUNT,
  type RelatedSeries,
} from '../src/services/relatedSeries';
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

/** 一屏上季卡的季号序列（用户实际看到的连号）。 */
function seasonNumbers(slice: { seasons: { season: number }[] }): number[] {
  return slice.seasons.map(pick => pick.season);
}

// ── 1. 核心场景：看第5季，第一屏必须是 6,7,8,9,10 ─────────────────
{
  // 站上共 12 季，用户正在看第 5 季。
  globalThis.__FAKE__ = { fast: seasonsUpTo(12), suggest: [], catalog: [] };
  const pool = await fetchRelatedSeries(detail(`${BASE}第五季`), { fallbackPage: 1 });
  const first = sliceRelatedBatch(pool, 0);

  check('第一屏铺满一屏', first.seasons.length + first.others.length, SLOT_COUNT);
  check('第一屏全是后续季 6,7,8,9,10,11', seasonNumbers(first), [6, 7, 8, 9, 10, 11]);
  check('第一屏没有掺入别的剧', first.others.length, 0);
}

// ── 1b. 用户原话的精确场景：站上共 10 季，看第5季 → 6,7,8,9,10 ────
{
  globalThis.__FAKE__ = {
    fast: seasonsUpTo(10),
    suggest: [],
    catalog: [item('o1', '别的剧A'), item('o2', '别的剧B')],
  };
  const pool = await fetchRelatedSeries(detail(`${BASE}第五季`), { fallbackPage: 1 });
  const first = sliceRelatedBatch(pool, 0);

  // 后续只有 6..10 五季，第 6 个座位由最近的季补位。
  check('后续季 6,7,8,9,10 全部出现在第一屏',
    seasonNumbers(first).slice(0, 5), [6, 7, 8, 9, 10]);
  check('后续季占满前五个位置（不被别的剧插入）',
    seasonNumbers(first).slice(0, 5).every(season => season > 5), true);
  check('第一屏不含同频道其它剧', first.others.length, 0);
}

// ── 2. 后续季不足一屏：先接后续，再用前作补，最后才轮到别的剧 ──────
{
  // 站上只有 8 季，看第 5 季 → 后续只有 6,7,8 三季。
  globalThis.__FAKE__ = {
    fast: seasonsUpTo(8),
    suggest: [],
    catalog: [item('o1', '别的剧A'), item('o2', '别的剧B'), item('o3', '别的剧C')],
  };
  const pool = await fetchRelatedSeries(detail(`${BASE}第五季`), { fallbackPage: 1 });
  const first = sliceRelatedBatch(pool, 0);

  check('后续季 6,7,8 排在最前', seasonNumbers(first).slice(0, 3), [6, 7, 8]);
  check('前作按越近越前接在后面', seasonNumbers(first).slice(3), [4, 3, 2]);
  check('前作还没排完时不出别的剧', first.others.length, 0);
  check('第一屏仍是满的', first.seasons.length + first.others.length, SLOT_COUNT);
}

// ── 3. 只有前作可看（看最后一季）：前作按越近越前铺满 ──────────────
{
  globalThis.__FAKE__ = { fast: seasonsUpTo(10), suggest: [], catalog: [item('o1', '别的剧A')] };
  const pool = await fetchRelatedSeries(detail(`${BASE}第十季`), { fallbackPage: 1 });
  const first = sliceRelatedBatch(pool, 0);

  check('看第10季：前作 9,8,7,6,5,4 铺满', seasonNumbers(first), [9, 8, 7, 6, 5, 4]);
  check('没有后续季时不掺别的剧', first.others.length, 0);
}

// ── 4. 同系列不够一屏时才用别的剧补位 ─────────────────────────────
{
  // 站上只有 3 季，看第 2 季 → 后续 3 一季 + 前作 1 一季 = 2 张，需补 4 张。
  globalThis.__FAKE__ = {
    fast: seasonsUpTo(3),
    suggest: [],
    catalog: Array.from({ length: 8 }, (_, index) => item(`o${index}`, `别的剧${index}`)),
  };
  const pool = await fetchRelatedSeries(detail(`${BASE}第二季`), { fallbackPage: 1 });
  const first = sliceRelatedBatch(pool, 0);

  check('季卡只有 2 张（第3季 + 第1季）', seasonNumbers(first), [3, 1]);
  check('剩下的 4 个座位由别的剧补满', first.others.length, 4);
  check('补位后正好一屏', first.seasons.length + first.others.length, SLOT_COUNT);
}

// ── 5. 第二屏：季卡接着往后排，兜底内容接着往后走 ─────────────────
{
  globalThis.__FAKE__ = {
    fast: seasonsUpTo(10),
    suggest: [],
    catalog: Array.from({ length: 20 }, (_, index) => item(`o${index}`, `别的剧${index}`)),
  };
  const pool = await fetchRelatedSeries(detail(`${BASE}第二季`), { fallbackPage: 1 });
  const first = sliceRelatedBatch(pool, 0);
  const second = sliceRelatedBatch(pool, 1);

  // 看第 2 季、共 10 季：池子序列是 3,4,5,6,7,8,9,10,1。
  // 第一屏取前 6 个 → 3..8；第二屏取余下 3 个 → 9,10,1。
  check('第一屏 3,4,5,6,7,8', seasonNumbers(first), [3, 4, 5, 6, 7, 8]);
  check('第二屏接着 9,10,1', seasonNumbers(second), [9, 10, 1]);
  check('两屏季卡不重复',
    JSON.stringify(seasonNumbers(first)) !== JSON.stringify(seasonNumbers(second)), true);
}

// ── 6. 季卡页翻完之后：钳制在最后一页，兜底接着往后走 ─────────────
{
  globalThis.__FAKE__ = {
    fast: seasonsUpTo(10),
    suggest: [],
    catalog: Array.from({ length: 24 }, (_, index) => item(`o${index}`, `别的剧${index}`)),
  };
  const pool = await fetchRelatedSeries(detail(`${BASE}第二季`), { fallbackPage: 1 });
  const pages = Math.ceil(pool.seasons.length / SLOT_COUNT);
  const afterSeasons = sliceRelatedBatch(pool, pages);
  const lastPage = sliceRelatedBatch(pool, pages - 1);

  // 季卡只展示一轮：2 页铺完之后不再重复出季卡，整屏交给兜底。
  // （旧语义是"钳制在最后一页"，会让季卡永远占着主卡位不动 ——
  //  已按用户要求改为"优先展示但不固定"。）
  check('季卡页翻完后不再重复出季卡', afterSeasons.seasons.length, 0);
  check('季卡确实已经在前面展示过', lastPage.seasons.length > 0, true);
  check('仍是完整一屏', afterSeasons.seasons.length + afterSeasons.others.length, SLOT_COUNT);

  // 兜底内容必须接着往后走，不能每屏重复同一批。
  const firstIds = sliceRelatedBatch(pool, 0).others.map(o => o.id);
  const afterIds = afterSeasons.others.map(o => o.id);
  check('季卡页翻完后的兜底内容与第一屏不同',
    JSON.stringify(firstIds) !== JSON.stringify(afterIds), true);
}

// ── 7. 可翻批数：季卡页 + 兜底还能撑几屏 ─────────────────────────
{
  // 10 季 → 2 屏季卡：第一屏 6 季，第二屏 4 季 + 2 条兜底。
  // 季卡铺完之后不再占座，每屏满额消耗 6 条 → 20-2=18 条兜底撑 3 屏。
  // 合计 2 + 3 = 5 屏。
  const pool: RelatedSeries = {
    seasons: Array.from({ length: 10 }, (_, index) => ({
      item: item(`s${index + 1}`, `${BASE}第${index + 1}季`),
      season: index + 1,
      relation: 'previous' as const,
    })),
    others: Array.from({ length: 20 }, (_, index) => item(`o${index}`, `别的剧${index}`)),
  };
  check('可翻批数 = 2 屏季卡 + 3 屏兜底 = 5', relatedBatchCount(pool), 5);
}

// ── 8. 每屏都不超过一屏，且季卡排完后仍能翻 ─────────────────────
{
  const pool: RelatedSeries = {
    seasons: Array.from({ length: 7 }, (_, index) => ({
      item: item(`s${index + 1}`, `${BASE}第${index + 1}季`),
      season: index + 1,
      relation: 'previous' as const,
    })),
    others: Array.from({ length: 12 }, (_, index) => item(`o${index}`, `别的剧${index}`)),
  };
  const batches = relatedBatchCount(pool);
  const sizes: number[] = [];
  for (let batch = 0; batch < batches; batch += 1) {
    const slice = sliceRelatedBatch(pool, batch);
    sizes.push(slice.seasons.length + slice.others.length);
  }
  check('每屏都恰好一屏', sizes, Array.from({ length: batches }, () => SLOT_COUNT));
  check('可翻批数 > 1（「换一批」有东西可换）', batches > 1, true);
}

// ── 9. 排序本身：后续季必须整体排在前作之前 ──────────────────────
{
  const label = parseSeasonLabel(`${BASE}第五季`)!;
  globalThis.__FAKE__ = { fast: seasonsUpTo(10), suggest: [], catalog: [] };
  const pool = await fetchRelatedSeries(detail(`${BASE}第五季`), { fallbackPage: 1 });
  const all = pool.seasons.map(pick => pick.season);
  const splitIndex = all.findIndex(season => season < label.season);
  check('所有后续季都排在前作之前',
    splitIndex === -1 ? true : all.slice(splitIndex).every(season => season < label.season), true);
  check('池子里的季号序列（后续在前）', all, [6, 7, 8, 9, 10, 4, 3, 2, 1]);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exitCode = 1;
