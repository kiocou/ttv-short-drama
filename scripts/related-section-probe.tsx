/**
 * 详情页「猜你喜欢」与「系列剧」弹窗的渲染契约探针
 * （由 `verify-related-section.mjs` 用 esbuild 打包后执行）。
 *
 * 用服务端渲染而不是开窗口点：这两块的契约都是**结构**——猜你喜欢里不该出现季号
 * 角标、系列剧弹窗的头部要标明"正在看第N季"且网格里不能有那一季、空态与骨架态各自
 * 长什么样。SSR 一次断言完，不依赖 Tauri 运行时，也不会因为窗口焦点被抢而失败。
 */
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { SeriesCard } from '../src/components/common/SeriesCard';
import { RelatedSeriesSection } from '../src/components/common/RelatedSeriesSection';
import { SeriesSeasonsDialog } from '../src/components/common/SeriesSeasonsDialog';
import type { SeriesItem } from '../src/types/catalog';
import type { SeriesDetail } from '../src/types/series';

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

function checkContains(name: string, haystack: string, needle: string): void {
  const ok = haystack.includes(needle);
  if (ok) pass += 1;
  else fail += 1;
  console.log(`${ok ? 'PASS ' : 'FAIL '}${name}${ok ? '' : `  未包含「${needle}」`}`);
}

function checkAbsent(name: string, haystack: string, needle: string): void {
  const ok = !haystack.includes(needle);
  if (ok) pass += 1;
  else fail += 1;
  console.log(`${ok ? 'PASS ' : 'FAIL '}${name}${ok ? '' : `  不应包含「${needle}」`}`);
}

const ITEM: SeriesItem = {
  id: '7001',
  title: '聚宝仙盆之杂灵根才是真BOSS第二季',
  cover: '',
  type: 'comic',
  episodesCount: 200,
  tags: ['玄幻', '逆袭'],
  origin: '红果',
  rating: 8.6,
};

const DETAIL: SeriesDetail = {
  id: '7001',
  title: '聚宝仙盆之杂灵根才是真BOSS第十四季',
  cover: '',
  type: 'comic',
  tags: ['玄幻'],
  origin: '红果',
  episodesCount: 222,
  description: '',
  episodes: [],
  availableQualities: [],
  sources: [],
};

// ── 1. 季号角标：接续季用强调色 ──────────────────────────────────────
{
  const html = renderToStaticMarkup(
    <SeriesCard series={ITEM} index={0} seasonBadge="第2季" seasonBadgeTone="next" onClick={() => {}} />,
  );
  checkContains('季号角标渲染出「第2季」', html, '第2季');
  checkContains('题材 chip 与角标并存', html, '玄幻');
  checkContains('接续季用强调色（emerald）', html, 'bg-emerald-600');
  checkContains('标题照常渲染', html, '聚宝仙盆');
}

// ── 2. 前作角标要弱化，不能与接续季撞色 ─────────────────────────────
{
  const html = renderToStaticMarkup(
    <SeriesCard series={ITEM} index={0} seasonBadge="第13季" seasonBadgeTone="previous" onClick={() => {}} />,
  );
  checkContains('前作角标用独立配色（indigo）', html, 'bg-indigo-600');
  checkAbsent('前作角标不用强调色', html, 'bg-emerald-600');
}

// ── 3. 不传角标（发现页/搜索页/猜你喜欢走的正是这条路）不该凭空多出角标 ──
{
  const html = renderToStaticMarkup(<SeriesCard series={ITEM} index={0} onClick={() => {}} />);
  checkAbsent('未传角标时不渲染季号', html, '第2季');
  checkContains('未传角标时题材照旧', html, '玄幻');
}

// ── 4. 既无角标又无题材：整块 chip 行不渲染（不编造「热门」） ────────
{
  const bare: SeriesItem = { ...ITEM, tags: [] };
  const html = renderToStaticMarkup(<SeriesCard series={bare} index={0} onClick={() => {}} />);
  checkAbsent('无角标无题材时不渲染 chip 行', html, 'inset-x-2 top-2');
}

// ── 5. 猜你喜欢：首次渲染是骨架态，标题必须是「猜你喜欢」 ────────────
{
  const html = renderToStaticMarkup(<RelatedSeriesSection detail={DETAIL} onOpen={() => {}} />);
  checkContains('首次渲染就显示「猜你喜欢」标题', html, '猜你喜欢');
  checkContains('骨架态占住版面（aria-busy）', html, 'aria-busy');
  // 旧面板的两句特征文案必须彻底消失。
  checkAbsent('不再出现「可用播放解析通道与健康度」', html, '可用播放解析通道与健康度');
  checkAbsent('不再出现「页面不会暴露签名 URL」', html, '页面不会暴露签名 URL');
  // 用户要求：猜你喜欢里不显示同系列 —— 骨架态下先给加载文案，且不该出现任何
  // 季号角标。「已排除同系列」那句要等数据到手才渲染，SSR 到不了那一帧。
  checkContains('骨架态副标题是加载文案', html, '正在匹配同频道好剧');
  checkAbsent('猜你喜欢不出季号角标', html, '第14季');
  checkAbsent('骨架态不含季卡角标配色', html, 'bg-emerald-600');
}

// ── 6. 系列剧弹窗：头部标明当前季、网格不含当前季 ──────────────────
{
  const html = renderToStaticMarkup(
    <SeriesSeasonsDialog detail={DETAIL} onOpen={() => {}} onClose={() => {}} />,
  );
  checkContains('弹窗标题是「系列剧」', html, '系列剧');
  checkContains('头部标明正在看第14季', html, '正在看第14');
  checkContains('头部给出系列名（摘掉季号）', html, '聚宝仙盆之杂灵根才是真BOSS');
  checkContains('首次渲染是骨架态', html, 'aria-busy');
  checkContains('弹窗带 dialog 语义', html, 'role="dialog"');
  checkContains('弹窗带关闭按钮', html, '关闭');
  // 头部徽章是「正在看第14季」，而**卡片网格**里不该有第14季的季卡。
  // 骨架态下网格里没有任何季卡，所以只要确认徽章之外没有第二处「第14季」。
  const badgeHits = html.split('第14').length - 1;
  check('第14季只出现在头部徽章里（网格无当前季卡）', badgeHits, 1);
  checkAbsent('弹窗骨架态不含季卡角标配色', html, 'bg-emerald-600');
}

// ── 7. 系列剧弹窗：裸名（无季号）的剧按第 1 季展示 ────────────────
{
  const plain: SeriesDetail = { ...DETAIL, title: '龙王出狱：镇世无双' };
  const html = renderToStaticMarkup(
    <SeriesSeasonsDialog detail={plain} onOpen={() => {}} onClose={() => {}} />,
  );
  checkContains('无季号时弹窗照常渲染标题', html, '系列剧');
  checkContains('无季号时头部退回完整剧名', html, '龙王出狱');
  // 2026-10-21 起：无季号按第 1 季处理，头部要明确标出来（用户原话：第一季
  // 实际名可能就是《聚宝盆》）。此前这里是"不显示徽章"，与截图里的困惑同源。
  checkContains('无季号时按第1季标注', html, '正在看第1');
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exitCode = 1;
