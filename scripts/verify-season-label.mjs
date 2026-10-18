// 分季标题解析与接续排序的确定性验证。
//
// 为什么单独跑纯函数：`seasonLabel.ts` 里的规则要与 Rust 侧
// `provider.rs::search_season` / `parse_season_number` / `search_text` 逐条对齐，
// 两边判出的"同一系列"必须一致——不一致就会出现"后端补了那一季、前端却认不出来"
// 的错位。这类判等性质在界面上点卡片验证既慢又不可靠；这里直接把纯函数当黑盒，
// 用实测过的真实标题（含脏数据）穷举。
//
// 运行：npm run verify:season-label

import {
  normalizeTitle,
  parseSeasonLabel,
  parseSeasonNumber,
  seasonOrder,
} from '../src/services/seasonLabel.ts';

let pass = 0;
let fail = 0;

function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) pass += 1;
  else fail += 1;
  console.log(
    (ok ? 'PASS ' : 'FAIL ') + name +
    (ok ? '' : '  期望=' + JSON.stringify(expected) + ' 实际=' + JSON.stringify(actual)),
  );
}

// ── 1. 中文数字进位 ────────────────────────────────────────────────
check('一位数「二」', parseSeasonNumber('二'), 2);
check('「十」= 10', parseSeasonNumber('十'), 10);
check('「十二」= 12', parseSeasonNumber('十二'), 12);
check('「二十」= 20', parseSeasonNumber('二十'), 20);
check('「二十三」= 23', parseSeasonNumber('二十三'), 23);
check('「一百零八」= 108', parseSeasonNumber('一百零八'), 108);
check('「一百一十八」= 118', parseSeasonNumber('一百一十八'), 118);
check('阿拉伯「14」', parseSeasonNumber('14'), 14);
// 拒绝优先于硬凑：这些写法看着像季号，其实来自被误读的标题。
check('「十十」拒绝', parseSeasonNumber('十十'), null);
check('「十二三」拒绝', parseSeasonNumber('十二三'), null);
check('「百十」拒绝', parseSeasonNumber('百十'), null);
check('空串拒绝', parseSeasonNumber(''), null);

// ── 2. 尾部季号解析 ────────────────────────────────────────────────
check('「聚宝仙盆之杂灵根才是真BOSS第十四季」',
  parseSeasonLabel('聚宝仙盆之杂灵根才是真BOSS第十四季'),
  { base: '聚宝仙盆之杂灵根才是真BOSS', season: 14, unit: '季' });
check('书名号包裹的 base 要摘掉',
  parseSeasonLabel('《聚宝仙盆》第二季'),
  { base: '聚宝仙盆', season: 2, unit: '季' });
check('尾部标点先摘再数',
  parseSeasonLabel('聚宝仙盆第二季·'),
  { base: '聚宝仙盆', season: 2, unit: '季' });
check('数字与量词之间容空白',
  parseSeasonLabel('聚宝仙盆第 2 季'),
  { base: '聚宝仙盆', season: 2, unit: '季' });
check('量词「部」独立成组',
  parseSeasonLabel('镇世无双第三部'),
  { base: '镇世无双', season: 3, unit: '部' });
// 只认尾部：「第三季」这种本身就是片名的，没有 base，不该造出一个空组。
check('片名本身叫「第三季」→ 无 base，拒绝', parseSeasonLabel('第三季'), null);
check('季号不在尾部 → 拒绝', parseSeasonLabel('第二季的逆袭'), null);
check('无季号的普通标题 → 拒绝', parseSeasonLabel('龙王出狱：镇世无双'), null);
check('季号超上限 → 拒绝', parseSeasonLabel('聚宝仙盆第二百零一季'), null);

// ── 3. 归一化 ──────────────────────────────────────────────────────
check('全角空格与标点被抹平',
  normalizeTitle('聚宝仙盆　第二季'),
  normalizeTitle('聚宝仙盆第二季'));
check('全角数字转半角',
  normalizeTitle('第２季'),
  '第2季');
check('大小写归一', normalizeTitle('Re:BOSS'), 'reboss');
check('全是标点时退回 trim+小写', normalizeTitle('  ---  '), '---');

// ── 4. 接续排序 ────────────────────────────────────────────────────
// 用户要的是「刚看第1季 → 推荐第2、3、4…季」。
{
  const current = 1;
  const seasons = [1, 3, 2, 7, 5, 4, 6, 14];
  const ordered = seasons
    .filter(season => season !== current)
    .sort((a, b) => seasonOrder(a, current) - seasonOrder(b, current));
  check('看第1季 → 后续季按 2,3,4… 接续',
    ordered, [2, 3, 4, 5, 6, 7, 14]);
}
// 当前季已是最后一季：前面的季同样越近越前（看完第14季，第13季才是最近接续）。
{
  const current = 14;
  const seasons = [1, 3, 2, 14, 13];
  const ordered = seasons
    .filter(season => season !== current)
    .sort((a, b) => seasonOrder(a, current) - seasonOrder(b, current));
  check('看最后一季 → 前面的季按 13,3,2,1 越近越前',
    ordered, [13, 3, 2, 1]);
}
// 中间季：先往后接（近→远），再往前补（近→远）。
{
  const current = 3;
  const seasons = [1, 2, 3, 5, 4];
  const ordered = seasons
    .filter(season => season !== current)
    .sort((a, b) => seasonOrder(a, current) - seasonOrder(b, current));
  check('看中间季 → 先 4,5 再接 2,1',
    ordered, [4, 5, 2, 1]);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exitCode = 1;
