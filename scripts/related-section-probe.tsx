/**
 * 「猜你喜欢」渲染契约的探针（由 `verify-related-section.mjs` 用 esbuild 打包后执行）。
 *
 * 用服务端渲染而不是开窗口点：这一栏的契约是**结构**——季号角标文案、接续季与前作
 * 的配色区分、不传角标时不该凭空多出一个、两路都空时整块不渲染。SSR 一次断言完，
 * 不依赖 Tauri 运行时，也不会因为窗口焦点被抢而失败。
 */
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { SeriesCard } from '../src/components/common/SeriesCard';
import { RelatedSeriesSection } from '../src/components/common/RelatedSeriesSection';
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

// ── 3. 不传角标（发现页/搜索页走的正是这条路）不该凭空多出角标 ──────
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

// ── 5. 详情页那一栏：首次渲染是骨架态，标题必须是「猜你喜欢」 ────────
{
  const detail: SeriesDetail = {
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
  const html = renderToStaticMarkup(<RelatedSeriesSection detail={detail} onOpen={() => {}} />);
  checkContains('首次渲染就显示「猜你喜欢」标题', html, '猜你喜欢');
  checkContains('骨架态占住版面（aria-busy）', html, 'aria-busy');
  // 旧面板的两句特征文案必须彻底消失。
  checkAbsent('不再出现「可用播放解析通道与健康度」', html, '可用播放解析通道与健康度');
  checkAbsent('不再出现「页面不会暴露签名 URL」', html, '页面不会暴露签名 URL');
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exitCode = 1;
