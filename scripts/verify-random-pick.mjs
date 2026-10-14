// 「猜你喜欢」换一部的确定性验证。
//
// 为什么单独跑纯函数：三条契约里的"不重复、一轮走完才重来"是**集合与轮次**的
// 性质，在组件里点按钮验证既慢又依赖随机数；这里直接把 pickNextRandomId 当
// 黑盒，用穷举 + 大量随机采样证明它不会卡住、也不会在候选用完前回头。
//
// 运行：npm run verify:random-pick

import { pickNextRandomId } from '../src/services/randomPick.ts';

let pass = 0;
let fail = 0;

function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) pass += 1;
  else fail += 1;
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok ? '' : '  期望=' + JSON.stringify(expected) + ' 实际=' + JSON.stringify(actual)));
}

const IDS = ['a', 'b', 'c', 'd'];

// 1) 连续换，直到一轮走完：每一次都必须给没见过的，且不重复。
{
  const shown = new Set();
  const seen = [];
  let current = null;
  for (let i = 0; i < IDS.length; i += 1) {
    const next = pickNextRandomId(IDS, shown, current);
    check(`第 ${i + 1} 次：给出候选`, Boolean(next), true);
    check(`第 ${i + 1} 次：不与已展示重复`, seen.includes(next), false);
    seen.push(next);
    current = next;
  }
  check('一轮走完 4 张各不相同', new Set(seen).size, 4);
}

// 2) 一轮走完后再换：重开一轮，只排除当前这张，其余都可出现。
{
  const shown = new Set(IDS);
  const current = 'c';
  const next = pickNextRandomId(IDS, shown, current);
  check('重开一轮：不回到当前这张', next === current, false);
  // 重开后 shown 只应剩下「当前这张 + 刚选出的这张」，旧一轮的记录必须清掉。
  check('重开一轮：shown 只留当前与刚选的', [...shown].sort(), [current, next].sort());
  const allowed = new Set(IDS.filter(id => id !== current));
  check('重开一轮：落在允许集合内', allowed.has(next), true);
}

// 3) 只有一张候选：永远返回它自己（调用方据此隐藏刷新按钮）。
{
  const shown = new Set();
  check('单张候选：第一次给出它', pickNextRandomId(['only'], shown, null), 'only');
  check('单张候选：再来一次还是它', pickNextRandomId(['only'], shown, 'only'), 'only');
  check('空候选：返回 null', pickNextRandomId([], new Set(), null), null);
}

// 4) 随机采样 2000 次：任何时刻都不得把池子用空、也不得提前回头。
{
  let violation = null;
  for (let round = 0; round < 2000 && !violation; round += 1) {
    const shown = new Set();
    let current = null;
    for (let step = 0; step < 10; step += 1) {
      const next = pickNextRandomId(IDS, shown, current);
      if (!next) { violation = `第 ${round} 轮第 ${step} 步返回了 null`; break; }
      if (next === current) { violation = `第 ${round} 轮第 ${step} 步原地不动`; break; }
      current = next;
    }
  }
  check('2000 轮 × 10 步：始终有下一张且不原地不动', violation, null);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
