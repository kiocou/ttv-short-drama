/**
 * 「换一批」轮换契约的探针（由 `verify-related-batch.mjs` 打包执行）。
 *
 * ## 这里要防的是什么
 *
 * 用户报的 bug：「换一批」点了没反应。根因有两层，两层都必须被这组用例钉住：
 * 1. **数据层**：`fetchRelatedSeries` 是确定性函数，重拉必然同一批；早期候选池又被
 *    硬截断到一屏，根本没有第二批。
 * 2. **切片层**：即使池子够大，若切片不随 batch 变化，屏幕照样不动。
 *
 * 所以这里的断言全是"相邻两批必须不同"，而不是"池子里有几条"——后者可以全对，
 * 而用户看到的仍然是同一屏。
 */
import {
  fetchRelatedSeries,
  pickSeasons,
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

/** 一屏的 id 序列，用于比较两批是否真的不同。 */
function ids(slice: { seasons: { item: SeriesItem }[]; others: SeriesItem[] }): string[] {
  return [...slice.seasons.map(p => p.item.id), ...slice.others.map(o => o.id)];
}

const BASE = '聚宝仙盆之杂灵根才是真BOSS';
const label = parseSeasonLabel(`${BASE}第十四季`)!;

// ── 1. 池子必须比一屏大（早期 bug 的直接原因） ────────────────────
{
  const candidates = Array.from({ length: 20 }, (_, index) =>
    item(`s${index}`, `${BASE}第${index + 1}季`),
  );
  const picks = pickSeasons(candidates, label, '1000');
  check('同系列池子大于一屏（才能轮换）', picks.length > SLOT_COUNT, true);
}

// ── 2. 纯切片：季卡铺满首屏，之后兜底每屏往后推进 ─────────────────
{
  const pool: RelatedSeries = {
    seasons: [1, 2].map(season => ({
      item: item(`sea${season}`, `${BASE}第${season}季`),
      season,
      relation: 'previous' as const,
    })),
    others: Array.from({ length: 12 }, (_, index) => item(`o${index}`, `别的剧${index}`)),
  };
  const b0 = ids(sliceRelatedBatch(pool, 0));
  const b1 = ids(sliceRelatedBatch(pool, 1));
  const b2 = ids(sliceRelatedBatch(pool, 2));
  // 2 季不足以铺满一屏 → 第 0 批 2 季 + 4 条兜底。
  // 季卡**只展示一轮**：第 1 批起季卡已经全部展示完，整屏交给兜底。
  check('第0批 = 2季 + 兜底前4条', b0, ['sea1', 'sea2', 'o0', 'o1', 'o2', 'o3']);
  check('第1批 = 季卡已展示完，整屏兜底', b1, ['o4', 'o5', 'o6', 'o7', 'o8', 'o9']);
  check('第2批 = 继续整屏兜底', b2, ['o10', 'o11', 'o0', 'o1', 'o2', 'o3']);
  check('第0批与第1批不同', JSON.stringify(b0) !== JSON.stringify(b1), true);
  check('第1批与第2批不同', JSON.stringify(b1) !== JSON.stringify(b2), true);
  // 季卡铺 1 屏 + 12 条兜底被第 0 批用掉 4 条、剩 8 条 → 还能再撑 2 屏（6+2，最后一屏回绕）。
  check('可翻批数 = 3', relatedBatchCount(pool), 3);
  check('每批都恰好一屏', [b0, b1, b2].every(batch => batch.length === SLOT_COUNT), true);
  // 季卡只出现一次，不在后续批次里重复。
  check('季卡不会在后续批次重复', b1.some(id => id.startsWith('sea')), false);
}

// ── 3. 同系列超过一屏：季卡优先铺满，按批往后翻 ───────────────────
{
  const pool: RelatedSeries = {
    seasons: Array.from({ length: 10 }, (_, index) => ({
      item: item(`sea${index + 1}`, `${BASE}第${index + 1}季`),
      season: index + 1,
      relation: 'previous' as const,
    })),
    others: [],
  };
  const b0 = ids(sliceRelatedBatch(pool, 0));
  const b1 = ids(sliceRelatedBatch(pool, 1));
  // 10 季 → 每批铺满 6 季，第二屏是余下 4 季。
  check('10 季第0批 = 前6季', b0, ['sea1', 'sea2', 'sea3', 'sea4', 'sea5', 'sea6']);
  check('10 季第1批 = 余下4季', b1, ['sea7', 'sea8', 'sea9', 'sea10']);
  check('同系列两批不同（否则后几季永远看不到）',
    JSON.stringify(b0) !== JSON.stringify(b1), true);
  check('同系列可翻批数 = 2（10季 / 每批6）', relatedBatchCount(pool), 2);
}

// ── 4. 池子只够一屏：没有更多可翻时批数为 1 ───────────────────────
{
  const pool: RelatedSeries = {
    seasons: [1, 2, 3, 4, 5, 6].map(season => ({
      item: item(`sea${season}`, `${BASE}第${season}季`),
      season,
      relation: 'previous' as const,
    })),
    others: [],
  };
  check('刚好一屏时只有 1 批', relatedBatchCount(pool), 1);
  // 季卡只够一屏、没有兜底：第 1 批起已经没有内容可出（不是重复季卡）。
  // 这条守着"季卡是优先展示、不是固定占位"的语义。
  check('季卡展示完后不再重复', ids(sliceRelatedBatch(pool, 1)), []);
}

// ── 5. 端到端：池子要装得下不止一屏（首屏就拉满兜底） ──────────────
{
  globalThis.__FAKE__ = {
    fast: [item('a', `${BASE}第二季`)],
    suggest: [],
    catalog: Array.from({ length: 24 }, (_, index) => item(`o${index}`, `别的剧${index}`)),
  };
  const pool = await fetchRelatedSeries(detail(`${BASE}第十四季`), { fallbackPage: 1 });
  check('同系列 1 季', pool.seasons.length, 1);
  check('兜底池远大于一屏（才有东西可换）', pool.others.length > SLOT_COUNT, true);
  const b0 = ids(sliceRelatedBatch(pool, 0));
  const b1 = ids(sliceRelatedBatch(pool, 1));
  check('端到端：相邻两批不同', JSON.stringify(b0) !== JSON.stringify(b1), true);
}

// ── 6. 端到端：换页能拉到真正新的兜底内容 ────────────────────────
{
  globalThis.__FAKE__ = {
    fast: [],
    suggest: [],
    catalog: [item('p1a', '第一页剧A'), item('p1b', '第一页剧B')],
  };
  const first = await fetchRelatedSeries(detail(`${BASE}第十四季`), { fallbackPage: 1 });
  globalThis.__FAKE__ = {
    fast: [],
    suggest: [],
    catalog: [item('p2a', '第二页剧A')],
  };
  const second = await fetchRelatedSeries(detail(`${BASE}第十四季`), { fallbackPage: 2 });
  check('第一页兜底', first.others.map(o => o.id), ['p1a', 'p1b']);
  check('第二页兜底是新剧', second.others.map(o => o.id), ['p2a']);
}

// ── 7. 端到端：兜底池总是参与（同系列铺不满时补位） ────────────────
{
  globalThis.__FAKE__ = {
    fast: Array.from({ length: 7 }, (_, index) => item(`s${index + 1}`, `${BASE}第${index + 1}季`)),
    suggest: [],
    catalog: [item('o0', '别的剧0'), item('o1', '别的剧1')],
  };
  const pool = await fetchRelatedSeries(detail(`${BASE}第十四季`), { fallbackPage: 1 });
  check('同系列 7 季 + 兜底也拉到', pool.others.map(o => o.id), ['o0', 'o1']);

  // 7 季 → 第一屏铺满 6 季，第二屏钳制到最后一页：余 1 季 + 2 条兜底，
  // 剩下的座位用兜底回绕补满（兜底只有 2 条，所以会重复）。
  const b0 = sliceRelatedBatch(pool, 0);
  const b1 = sliceRelatedBatch(pool, 1);
  check('第0批铺满 6 季（后续季优先，不掺别的剧）', b0.seasons.length, 6);
  check('第0批不掺别的剧', b0.others.length, 0);
  check('第1批余下 1 季', b1.seasons.length, 1);
  check('第1批用兜底补满剩余 5 个座位', b1.others.length, 5);
  check('第1批仍是完整一屏', ids(b1).length, SLOT_COUNT);
  check('第1批与第0批不同', JSON.stringify(ids(b1)) !== JSON.stringify(ids(b0)), true);
}

// ── 8. 确定性：同一 (pool, batch) 永远同一屏 ──────────────────────
{
  const pool: RelatedSeries = {
    seasons: [],
    others: Array.from({ length: 9 }, (_, index) => item(`o${index}`, `别的剧${index}`)),
  };
  check('切片是纯函数（可重放）',
    ids(sliceRelatedBatch(pool, 2)), ids(sliceRelatedBatch(pool, 2)));
  // 没有季卡 → 每屏 6 条兜底；9 条能翻 2 屏。
  check('可翻批数 = 2', relatedBatchCount(pool), 2);
  check('负数 batch 归一化到第0批',
    ids(sliceRelatedBatch(pool, -1)), ids(sliceRelatedBatch(pool, 0)));
  check('负数归一化后仍是完整一屏',
    ids(sliceRelatedBatch(pool, -1)).length, SLOT_COUNT);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exitCode = 1;
