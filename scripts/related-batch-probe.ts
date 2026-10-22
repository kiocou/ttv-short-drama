/**
 * 「猜你喜欢 · 换一批」轮换契约的探针（由 `verify-related-batch.mjs` 打包执行）。
 *
 * ## 这里要防的是什么
 *
 * 用户报的 bug：「换一批」点了没反应。根因有两层，两层都必须被这组用例钉住：
 * 1. **数据层**：`fetchRelatedSeries` 对同一页目录是确定性的，重拉必然同一批；
 *    候选池若被硬截断到一屏，根本没有第二批。
 * 2. **切片层**：即使池子够大，若切片不随 batch 变化，屏幕照样不动。
 *
 * 所以这里的断言全是"相邻两批必须不同"，而不是"池子里有几条"——后者可以全对，
 * 而用户看到的仍然是同一屏。
 *
 * 2026-10-21 起这一栏**只出同频道其它剧**（同系列已移到「系列剧」弹窗），所以
 * 池子里不再有 `seasons` 段，切片也简化成"整屏兜底按批往后走 + 池尾回绕"。
 */
import {
  fetchRelatedSeries,
  relatedBatchCount,
  sliceRelatedBatch,
  SLOT_COUNT,
  type RelatedSeries,
} from '../src/services/relatedSeries';
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
function ids(slice: { others: SeriesItem[] }): string[] {
  return slice.others.map(o => o.id);
}

const BASE = '聚宝仙盆之杂灵根才是真BOSS';

/** 造 N 条"别的剧"的兜底条目。 */
function others(count: number): SeriesItem[] {
  return Array.from({ length: count }, (_, index) => item(`o${index}`, `别的剧${index}`));
}

// ── 1. 纯切片：整屏兜底按批往后走 ────────────────────────────────
{
  const pool: RelatedSeries = { others: others(12) };
  const b0 = ids(sliceRelatedBatch(pool, 0));
  const b1 = ids(sliceRelatedBatch(pool, 1));
  const b2 = ids(sliceRelatedBatch(pool, 2));

  check('第0批 = 前6条', b0, ['o0', 'o1', 'o2', 'o3', 'o4', 'o5']);
  check('第1批 = 接着的6条', b1, ['o6', 'o7', 'o8', 'o9', 'o10', 'o11']);
  check('第2批 = 池尾回绕（不是短屏）', b2, ['o0', 'o1', 'o2', 'o3', 'o4', 'o5']);
  check('第0批与第1批不同', JSON.stringify(b0) !== JSON.stringify(b1), true);
  check('第1批与第2批不同', JSON.stringify(b1) !== JSON.stringify(b2), true);
  check('可翻批数 = 2（12 条 / 每批 6）', relatedBatchCount(pool), 2);
  check('每批都恰好一屏', [b0, b1, b2].every(batch => batch.length === SLOT_COUNT), true);
}

// ── 2. 池子只够一屏：没有更多可翻时批数为 1，且不吐短屏 ──────────
{
  const pool: RelatedSeries = { others: others(6) };
  check('刚好一屏时只有 1 批', relatedBatchCount(pool), 1);
  // 池子不足两屏时第二屏回绕填满，而不是塌成 0 张（"换一批把推荐换没了"的观感）。
  check('池子刚好一屏时第二屏回绕填满', ids(sliceRelatedBatch(pool, 1)).length, SLOT_COUNT);
  check('回绕后与第0批一致（池子本来就只有这些）',
    JSON.stringify(ids(sliceRelatedBatch(pool, 1))), JSON.stringify(ids(sliceRelatedBatch(pool, 0))));
}

// ── 3. 池子不足一屏：回绕补齐，永远给完整一屏 ───────────────────
{
  const pool: RelatedSeries = { others: others(4) };
  check('可翻批数 = 1', relatedBatchCount(pool), 1);
  check('不足一屏时回绕填满 6 个座位', ids(sliceRelatedBatch(pool, 0)).length, SLOT_COUNT);
  check('回绕顺序正确', ids(sliceRelatedBatch(pool, 0)),
    ['o0', 'o1', 'o2', 'o3', 'o0', 'o1']);
}

// ── 4. 空池：什么都不出（组件整块不渲染，而不是给一屏空壳） ──────
{
  const pool: RelatedSeries = { others: [] };
  check('空池切片为空', ids(sliceRelatedBatch(pool, 0)), []);
  check('空池仍报 1 批（避免「换一批」被判成没得翻而卡死）', relatedBatchCount(pool), 1);
}

// ── 5. 确定性：同一 (pool, batch) 永远同一屏 ──────────────────────
{
  const pool: RelatedSeries = { others: others(9) };
  check('切片是纯函数（可重放）',
    ids(sliceRelatedBatch(pool, 2)), ids(sliceRelatedBatch(pool, 2)));
  check('可翻批数 = 2（9 条 / 每批 6）', relatedBatchCount(pool), 2);
  check('负数 batch 归一化到第0批',
    ids(sliceRelatedBatch(pool, -1)), ids(sliceRelatedBatch(pool, 0)));
  check('负数归一化后仍是完整一屏',
    ids(sliceRelatedBatch(pool, -1)).length, SLOT_COUNT);
}

// ── 6. 端到端：池子要装得下不止一屏（首屏就拉满兜底） ─────────────
{
  globalThis.__FAKE__ = {
    fast: [],
    suggest: [],
    catalog: others(24),
  };
  const pool = await fetchRelatedSeries(detail(`${BASE}第十四季`), { fallbackPage: 1 });
  check('兜底池远大于一屏（才有东西可换）', pool.others.length > SLOT_COUNT, true);
  const b0 = ids(sliceRelatedBatch(pool, 0));
  const b1 = ids(sliceRelatedBatch(pool, 1));
  check('端到端：相邻两批不同', JSON.stringify(b0) !== JSON.stringify(b1), true);
}

// ── 7. 端到端：换页能拉到真正新的兜底内容 ────────────────────────
{
  globalThis.__FAKE__ = { fast: [], suggest: [], catalog: [item('p1a', '第一页剧A'), item('p1b', '第一页剧B')] };
  const first = await fetchRelatedSeries(detail(`${BASE}第十四季`), { fallbackPage: 1 });
  globalThis.__FAKE__ = { fast: [], suggest: [], catalog: [item('p2a', '第二页剧A')] };
  const second = await fetchRelatedSeries(detail(`${BASE}第十四季`), { fallbackPage: 2 });
  check('第一页兜底', first.others.map(o => o.id), ['p1a', 'p1b']);
  check('第二页兜底是新剧', second.others.map(o => o.id), ['p2a']);
}

// ── 8. 端到端：同系列被剔除后，剩下的座位由别的剧补满 ────────────
{
  globalThis.__FAKE__ = {
    fast: [],
    suggest: [],
    catalog: [
      ...Array.from({ length: 7 }, (_, index) => item(`s${index + 1}`, `${BASE}第${index + 1}季`)),
      ...others(8),
    ],
  };
  const pool = await fetchRelatedSeries(detail(`${BASE}第十四季`), { fallbackPage: 1 });
  check('同系列的 7 季一条都没进猜你喜欢',
    pool.others.some(o => o.id.startsWith('s')), false);
  check('剩下的全是别的剧', pool.others.map(o => o.id), others(8).map(o => o.id));
  const b0 = sliceRelatedBatch(pool, 0);
  check('第0批铺满 6 条别的剧', b0.others.length, SLOT_COUNT);
  check('第0批不含同系列', b0.others.some(o => o.id.startsWith('s')), false);
  check('第1批接着往后走', ids(sliceRelatedBatch(pool, 1)), ['o6', 'o7', 'o0', 'o1', 'o2', 'o3']);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exitCode = 1;
