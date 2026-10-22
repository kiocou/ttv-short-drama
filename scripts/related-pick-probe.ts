/**
 * 「同系列筛选 + 接续排序 + 系列剧弹窗取数」的探针
 * （由 `verify-related-pick.mjs` 打包执行）。
 *
 * 断言的都是**容易悄悄错掉**的判断：错一条就会把别的剧混进"接续推荐"，或把当前季
 * 混进「系列剧」弹窗——而它们在界面上表现为"偶尔多出一张不相干的卡"、"新窗口里
 * 居然有正在看的这一季"，肉眼几乎发现不了。
 */
import {
  canLookupSeasons,
  currentSeasonLabel,
  fetchRelatedSeries,
  fetchSeriesSeasons,
  pickSeasons,
  SEASON_POOL_LIMIT,
  SLOT_COUNT,
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

// ── 1b. 用户原话场景：看《聚宝盆》第4季，新窗口里没有第4季 ─────────
{
  const show = '聚宝盆';
  const showLabel = parseSeasonLabel(`${show}第四季`)!;
  const candidates = [
    item('s1', `${show}第一季`),
    item('s2', `${show}第二季`),
    item('s3', `${show}第三季`),
    item('s4', `${show}第四季`),   // ❌ 正在看的这一季
    item('s5', `${show}第五季`),
    // 同一季的另一个来源条目：按 id 排除会漏掉它，必须按季号排除。
    item('s4-alt', `${show}第四季`),
  ];
  const picks = pickSeasons(candidates, showLabel, 's4');
  check('第4季视角：窗口里不含第4季（含另一个来源的第4季条目）',
    picks.some(pick => pick.season === 4), false);
  check('第4季视角：后续季在前（5），前作越近越前（3,2,1）',
    picks.map(pick => pick.season), [5, 3, 2, 1]);
  check('第4季视角：排除的是整季，不是单个 id',
    picks.some(pick => pick.item.id === 's4-alt'), false);
}

// ── 1c. 无季号的第 1 季（用户原话：《聚宝盆》与《聚宝盆 第1季》两种命名） ──
{
  const show = '聚宝盆';
  const bareLabel = parseSeasonLabel(show); // null：裸名解析不出季号
  check('裸剧名解析不出季号', bareLabel, null);

  // 场景 A：从第 2 季往前看，裸名的第 1 季必须被收进来。
  const fromSeason2 = parseSeasonLabel(`${show}第二季`)!;
  const candidates = [
    item('bare', show),              // ✅ 裸名 = 第 1 季
    item('s2', `${show}第二季`),      // ❌ 当前季
    item('s3', `${show}第三季`),      // ✅ 后续季
    item('other', `${show}外传`),     // ❌ base 不同（多一个字）
  ];
  const picks = pickSeasons(candidates, fromSeason2, 's2');
  check('第2季视角：裸名第1季被认出', picks.some(p => p.item.id === 'bare'), true);
  check('第2季视角：裸名归到第 1 季', picks.find(p => p.item.id === 'bare')?.season, 1);
  check('第2季视角：顺序是 3 然后 1', picks.map(p => p.season), [3, 1]);
  check('第2季视角：外传不算同系列', picks.some(p => p.item.id === 'other'), false);

  // 场景 B：裸名第 2 季（不同 id）不应被当成"第 1 季"重复收进来。
  const bareWithDup = [
    item('bare', show),
    item('bareDup', show),           // 同名的另一个来源
    item('s3', `${show}第三季`),
  ];
  const dupPicks = pickSeasons(bareWithDup, fromSeason2, 's2');
  check('同名裸名条目只收一张', dupPicks.filter(p => p.season === 1).length, 1);
}

// ── 1d. 当前剧就是裸名（第 1 季）：入口要能用，且不把自己推出来 ──────
{
  const show = '聚宝盆';
  const self = detail(show);
  check('裸名剧也显示系列剧入口', canLookupSeasons(self), true);
  check('裸名剧按第 1 季取基准', currentSeasonLabel(self), { base: show, season: 1, unit: '季' });

  globalThis.__FAKE__ = {
    fast: [
      item('self', show),            // ❌ 他自己（同名裸名）
      item('s2', `${show}第二季`),    // ✅
      item('s3', `${show}第三季`),    // ✅
    ],
    suggest: [],
    catalog: [],
  };
  const seasons = await fetchSeriesSeasons(self);
  check('裸名第1季视角：不把自己当"其它季"', seasons.some(p => p.item.id === 'self'), false);
  check('裸名第1季视角：后续季按顺序来', seasons.map(p => p.season), [2, 3]);
}


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

// ── 4. 上限：弹窗要能装下"完整一个系列"，比一屏宽得多 ────────────
{
  const candidates = Array.from({ length: 20 }, (_, index) =>
    item(`x${index}`, `${BASE}第${index + 1}季`),
  );
  const picks = pickSeasons(candidates, label, '1000');
  // 20 季里排除当前的第 14 季 = 19 季，低于弹窗上限（48），所以全收。
  check('弹窗池子收全（19 季，未触上限）', picks.length, 19);
  check('弹窗上限远大于一屏', SEASON_POOL_LIMIT > SLOT_COUNT, true);

  // 超过上限时按接续顺序截断，留下的正是最该看的那些季。
  const many = Array.from({ length: 60 }, (_, index) =>
    item(`y${index}`, `${BASE}第${index + 1}季`),
  );
  const capped = pickSeasons(many, label, '1000');
  check('超过上限时截断到上限', capped.length, SEASON_POOL_LIMIT);
  check('截断后仍以接续季打头', capped[0].season, 15);
}

// ── 5. 端到端：系列剧取数把两路搜索结果并起来 ────────────────────
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
  const seasons = await fetchSeriesSeasons(detail(`${BASE}第十四季`));
  // 第14季视角：没有后续季，前作越近越前，所以是 7,6,5,4,3,2。
  check('系列剧取数：两路合并后 6 季（越近越前）', seasons.map(p => p.season), [7, 6, 5, 4, 3, 2]);
  check('系列剧取数：不掺兜底目录里的其它剧',
    seasons.some(pick => pick.item.id === 'z'), false);
}

// ── 6. 端到端：搜索两路全挂时系列剧为空（弹窗给空态，不编内容） ──
{
  globalThis.__FAKE__ = { fast: 'reject', suggest: 'reject', catalog: [item('z1', '别的剧A')] };
  const seasons = await fetchSeriesSeasons(detail(`${BASE}第十四季`));
  check('搜索全挂时系列剧为空', seasons.length, 0);
}

// ── 7. guo 源跳过搜索段：它的剧在红果里不存在，搜了只会捞回同名别剧 ─
{
  globalThis.__FAKE__ = {
    fast: [item('a', `${BASE}第二季`)],
    suggest: [item('b', `${BASE}第三季`)],
    catalog: [item('z1', '别的剧A')],
  };
  const guoDetail = detail(`${BASE}第二季`, { id: 'guo:dsd:1234', type: 'drama' });
  const seasons = await fetchSeriesSeasons(guoDetail);
  check('guo 源不拿标题去搜索', seasons.length, 0);
  check('guo 源不显示系列剧入口', canLookupSeasons(guoDetail), false);
}

// ── 8. 无季号的普通剧：入口仍然给，但没有其它季时弹窗给空态 ────────
{
  globalThis.__FAKE__ = {
    fast: [item('a', '龙王出狱第二季')],
    suggest: [],
    catalog: [item('z1', '别的剧A')],
  };
  const plain = detail('龙王出狱：镇世无双');
  const seasons = await fetchSeriesSeasons(plain);
  check('普通剧没有同系列季', seasons.length, 0);
  // 2026-10-21 起：无季号的剧按"第 1 季"处理，入口要给（它可能真是某系列的第 1 季，
  // 站方对第一季常常只写裸剧名）。真没有其它季时由弹窗给空态文案，代价只是多点一次。
  check('普通剧也显示系列剧入口（按第1季理解）', canLookupSeasons(plain), true);
}

// ── 9. 18+ 频道既不搜索也不显示入口 ──────────────────────────────
{
  globalThis.__FAKE__ = {
    fast: [item('a', `${BASE}第二季`)],
    suggest: [],
    catalog: [item('z1', '别的剧A')],
  };
  const adult = detail(`${BASE}第十四季`, { type: 'adult' });
  const seasons = await fetchSeriesSeasons(adult);
  check('18+ 频道没有系列剧季卡', seasons.length, 0);
  check('18+ 频道不显示系列剧入口', canLookupSeasons(adult), false);
}

// ── 10. 猜你喜欢：同系列一条都不能出（含未标季、不同分卷量词的同名条目） ──
{
  globalThis.__FAKE__ = {
    fast: [],
    suggest: [],
    catalog: [
      item('same2', `${BASE}第二季`),
      item('same14', `${BASE}第十四季`),
      item('samePlain', BASE),
      item('sameOtherUnit', `${BASE}第一部`),
      item('z1', '别的剧A'),
      item('z2', '别的剧B'),
    ],
  };
  const pool = await fetchRelatedSeries(detail(`${BASE}第十四季`), { fallbackPage: 1 });
  // 「第一部」也要剔除：猜你喜欢只回答"这一条是不是同一部剧"，不比量词。
  // （弹窗那边 `pickSeasons` 反而要求量词一致，因为两套编号混在一组会撞车。）
  check('猜你喜欢剔除同系列（含当前季、未标季、不同量词的同名条目）',
    pool.others.map(o => o.id), ['z1', 'z2']);
}

// ── 11. 猜你喜欢：不分季的剧不做同系列剔除（没有 base 可比） ──────
{
  globalThis.__FAKE__ = {
    fast: [],
    suggest: [],
    catalog: [item('z1', '别的剧A'), item('z2', '别的剧B')],
  };
  const pool = await fetchRelatedSeries(detail('龙王出狱：镇世无双'), { fallbackPage: 1 });
  check('普通剧照常给同频道推荐', pool.others.map(o => o.id), ['z1', 'z2']);
}

// ── 12. 猜你喜欢：18+ 频道不拉公开目录 ───────────────────────────
{
  globalThis.__FAKE__ = { fast: [], suggest: [], catalog: [item('z1', '别的剧A')] };
  const pool = await fetchRelatedSeries(detail(`${BASE}第十四季`, { type: 'adult' }));
  check('18+ 频道猜你喜欢为空（不拿公开剧填充）', pool.others.length, 0);
}

// ── 13. 猜你喜欢：目录失败时返回空池，不抛错 ─────────────────────
{
  globalThis.__FAKE__ = { fast: [], suggest: [], catalog: 'reject' };
  const pool = await fetchRelatedSeries(detail(`${BASE}第十四季`), { fallbackPage: 1 });
  check('目录失败时池子为空且不抛错', pool.others.length, 0);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exitCode = 1;
