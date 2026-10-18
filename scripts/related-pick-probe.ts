/**
 * 「同系列筛选 + 接续排序」的探针（由 `verify-related-pick.mjs` 打包执行）。
 *
 * 断言的都是**容易悄悄错掉**的判断：错一条就会把别的剧混进"接续推荐"，而它在
 * 界面上表现为"偶尔多出一张不相干的卡"，肉眼几乎发现不了。
 */
import { fetchRelatedSeries, pickSeasons, SLOT_COUNT } from '../src/services/relatedSeries';
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
const label = parseSeasonLabel(`${BASE}第十四季`)!;

// ── 1. 只收同系列、同量词、非当前季 ────────────────────────────────
{
  const candidates = [
    item('a', `${BASE}第二季`),          // ✅ 后续季
    item('b', `${BASE}第十四季`),        // ❌ 当前季
    item('c', `${BASE}第一部`),          // ❌ 量词不同
    item('d', '别的剧第二季'),            // ❌ base 不同
    item('e', `${BASE}第十三季`),        // ✅ 前作
    item('f', '聚宝仙盆第二季'),          // ❌ 另一个系列（base 更短）
    item('g', `${BASE}第十六季`),        // ✅ 后续季
  ];
  const picks = pickSeasons(candidates, label, '1000');
  // 当前是第14季：16 是最近的后续季排第一，13 是最近的前作，2 离得最远。
  check('只留下同系列同量词的非当前季', picks.map(p => p.item.id), ['g', 'e', 'a']);
  check('后续季标记为 next', picks[0].relation, 'next');
  check('前作标记为 previous', picks[1].relation, 'previous');
  check('季号解析正确', picks.map(p => p.season), [16, 13, 2]);
}

// ── 2. 接续顺序：先往后接（近→远），再往前补（近→远） ──────────────
{
  const candidates = [
    item('s1', `${BASE}第一季`),
    item('s3', `${BASE}第三季`),
    item('s2', `${BASE}第二季`),
    item('s16', `${BASE}第十六季`),
    item('s15', `${BASE}第十五季`),
  ];
  const picks = pickSeasons(candidates, label, '1000');
  // 当前第14季：后续 15、16 先出；前面那批越近越前，所以是 3、2、1。
  check('当前第14季 → 15,16 接续，再 3,2,1 补番',
    picks.map(p => p.season), [15, 16, 3, 2, 1]);
}

// ── 3. 同一季有多个来源时只留一个（先到先得），不重复出卡 ──────────
{
  const candidates = [
    item('dup1', `${BASE}第二季`),
    item('dup2', `${BASE}第二季`),
  ];
  const picks = pickSeasons(candidates, label, '1000');
  check('同季重复只留一张', picks.map(p => p.item.id), ['dup1']);
}

// ── 4. 上限：候选池是 4 屏的量，不是一屏 ──────────────────────────
{
  const candidates = Array.from({ length: 20 }, (_, index) =>
    item(`x${index}`, `${BASE}第${index + 1}季`),
  );
  const picks = pickSeasons(candidates, label, '1000');
  // 20 季里排除当前的第 14 季 = 19 季，仍低于 4 屏上限（24），所以全收。
  check('同系列池子收全（19 季，未触上限）', picks.length, 19);
  check('池子严格大于一屏', picks.length > SLOT_COUNT, true);
}

// ── 5. 端到端：兜底池总是参与，但只补位、不挤掉同系列 ──────────────
{
  globalThis.__FAKE__ = {
    fast: [
      item('a', `${BASE}第二季`),
      item('b', `${BASE}第三季`),
      item('c', `${BASE}第四季`),
    ],
    suggest: [
      item('d', `${BASE}第五季`),
      item('e', `${BASE}第六季`),
      item('f', `${BASE}第七季`),
    ],
    catalog: [item('z', '不相干的剧')],
  };
  const result = await fetchRelatedSeries(detail(`${BASE}第十四季`), { fallbackPage: 1 });
  // 第14季视角：没有后续季，前作越近越前，所以是 7,6,5,4,3,2。
  check('两路合并后得到 6 季（越近越前）', result.seasons.map(p => p.season), [7, 6, 5, 4, 3, 2]);
  // 兜底总要拉：同系列"一屏多一点"时，第二批得靠它补位（实测塌成 1 张的根因）。
  check('兜底池一并返回（用于补位）', result.others.map(o => o.id), ['z']);
}

// ── 6. 端到端：同系列不足时才用同频道内容补位 ─────────────────────
{
  globalThis.__FAKE__ = {
    fast: [item('a', `${BASE}第二季`)],
    suggest: [],
    catalog: [item('z1', '别的剧A'), item('z2', '别的剧B'), item('1000', '当前剧自己')],
  };
  const result = await fetchRelatedSeries(detail(`${BASE}第十四季`));
  check('同系列只有 1 季', result.seasons.map(p => p.season), [2]);
  check('兜底补位排除当前剧', result.others.map(o => o.id), ['z1', 'z2']);
  check('合计不超过一屏', result.seasons.length + result.others.length <= SLOT_COUNT, true);
}

// ── 7. 端到端：搜索两路全挂时仍有兜底内容，不整块消失 ─────────────
{
  globalThis.__FAKE__ = {
    fast: 'reject',
    suggest: 'reject',
    catalog: [item('z1', '别的剧A')],
  };
  const result = await fetchRelatedSeries(detail(`${BASE}第十四季`));
  check('搜索全挂时同系列为空', result.seasons.length, 0);
  check('但兜底内容仍在', result.others.map(o => o.id), ['z1']);
}

// ── 8. guo 源跳过搜索段：它的剧在红果里不存在，搜了只会捞回同名别剧 ─
{
  globalThis.__FAKE__ = {
    fast: [item('a', `${BASE}第二季`)],
    suggest: [item('b', `${BASE}第三季`)],
    catalog: [item('z1', '别的剧A')],
  };
  const result = await fetchRelatedSeries(
    detail(`${BASE}第二季`, { id: 'guo:dsd:1234', type: 'drama' }),
  );
  check('guo 源不拿标题去搜索', result.seasons.length, 0);
  check('guo 源只给同频道兜底', result.others.map(o => o.id), ['z1']);
}

// ── 9. 无季号的普通剧：不做同系列匹配，直接走兜底 ─────────────────
{
  globalThis.__FAKE__ = {
    fast: [item('a', '龙王出狱第二季')],
    suggest: [],
    catalog: [item('z1', '别的剧A')],
  };
  const result = await fetchRelatedSeries(detail('龙王出狱：镇世无双'));
  check('普通剧没有同系列季', result.seasons.length, 0);
  check('普通剧走兜底', result.others.map(o => o.id), ['z1']);
}

// ── 10. 18+ 频道既不搜索也不拉公开目录（红果没有对应口径） ────────
{
  globalThis.__FAKE__ = {
    fast: [item('a', `${BASE}第二季`)],
    suggest: [],
    catalog: [item('z1', '别的剧A')],
  };
  const result = await fetchRelatedSeries(detail(`${BASE}第十四季`, { type: 'adult' }));
  check('18+ 频道不推荐（不拿公开剧填充）', result.seasons.length + result.others.length, 0);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exitCode = 1;
