// 验证「点击进度条之后该怎么落位」。
//
// 运行：npm run verify:seek
//
// ## 守的是哪次故障（2026-10-24）
//
// 用户报告：「点击播放器任意位置（比如点击结尾），它会跳转到转码后的最后位置，
// 而不是跳到点击的对应位置。」
//
// 根因：进度条的分母是**源片真实时长**，而播放源是边转边播的整集 HLS ——
// `video.seekable.end()` 只到已转位置。MSE 会把超范围的 seek 静默夹到末端，
// 于是"点结尾"在浏览器看来等于"点已转到的位置"。
//
// 旧实现不但没有纠正这件事，还主动把播放头推到 `seekable.end - 0.05`，
// 把一次"还没转好"的等待表现成了"跳到末端"的**错误落位**；超时之后又推一次，
// 让这个错误变成永久的。
//
// 这份用例钉住正确语义：**目标永远是用户点的位置，绝不改成可寻址末端**。

import { planSeek, seekableReached, SEEK_SEEKABLE_TOLERANCE_SECONDS } from '../src/services/seekPlan.ts';

let pass = 0;
let fail = 0;

function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) pass += 1;
  else fail += 1;
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok ? '' : '  期望=' + JSON.stringify(expected) + ' 实际=' + JSON.stringify(actual)));
}

// ── 1. 核心回归：点结尾必须落到结尾，而不是可寻址末端 ──────────────────
check('点 90 秒（时长 90、已转 20）→ 等待，目标是 90 而不是 20', planSeek({
  requested: 90,
  duration: 90,
  seekableEnd: 20,
}), { kind: 'wait', target: 90, seekableEnd: 20 });

check('点 60 秒（时长 90、已转 20）→ 等待，目标是 60', planSeek({
  requested: 60,
  duration: 90,
  seekableEnd: 20,
}).target, 60);

// 这是旧实现最典型的错误：把目标改成 end - 0.05。用例直接钉住"不许这样做"。
check('等待时绝不把目标改成 seekableEnd - 0.05', planSeek({
  requested: 90,
  duration: 90,
  seekableEnd: 20,
}).target === 19.95, false);

// ── 2. 可寻址范围内：立即落位（绝大多数情况） ──────────────────────────
check('点 10 秒（已转 20）→ 立即落位到 10', planSeek({
  requested: 10,
  duration: 90,
  seekableEnd: 20,
}), { kind: 'immediate', target: 10 });

// ⚠️ 2026-10-27 第二次修正：**边界就是 seekableEnd，不扣任何安全余量**。
//
// 曾短暂加过"扣一片 4 秒余量"，想避免落位踩在正在写的分片上。但它把可落位边界
// 整体前移 4 秒，用户点在自己看得见已经转好的位置时被判成"未转码"、进入等待，
// 表现就是"点了进度条不跳"。日志实证：
//
//   拖动到未转码区域 目标=41.7s 可寻址末端=40.0s
//
// 踩到正在写的分片时本地服务会返 503、hls.js 自己重试，那是可恢复的；
// "点了完全不响应"不可接受。所以边界回到 seekable.end。
check('点正好等于可寻址末端 → 立即落位', planSeek({
  requested: 20,
  duration: 90,
  seekableEnd: 20,
}).kind, 'immediate');

check('目标比末端多 0.4 秒（分片边界误差）→ 仍立即落位', planSeek({
  requested: 20.4,
  duration: 90,
  seekableEnd: 20,
}).kind, 'immediate');

check('目标比末端多 0.6 秒（超出容差）→ 进入等待', planSeek({
  requested: 20.6,
  duration: 90,
  seekableEnd: 20,
}).kind, 'wait');

check('目标远小于末端 → 立即落位', planSeek({
  requested: 15,
  duration: 90,
  seekableEnd: 20,
}).kind, 'immediate');

check('点片尾（转码已完成）→ 立即落位', planSeek({
  requested: 89.5,
  duration: 90,
  seekableEnd: 90,
}).kind, 'immediate');

check('点比可寻址末端多 0.6 秒（超过容差）→ 进入等待', planSeek({
  requested: 20.6,
  duration: 90,
  seekableEnd: 20,
}).kind, 'wait');

// ── 3. 上界夹取：点到轨道之外不能得到超过时长的位置 ────────────────────
check('点 120 秒（时长 90）→ 夹到 90', planSeek({
  requested: 120,
  duration: 90,
  seekableEnd: 200,
}).target, 90);

check('点负数 → 归 0', planSeek({
  requested: -5,
  duration: 90,
  seekableEnd: 200,
}).target, 0);

check('点 NaN → 归 0', planSeek({
  requested: NaN,
  duration: 90,
  seekableEnd: 200,
}).target, 0);

// ── 4. 时长未知时不能乱夹取 ────────────────────────────────────────────
//
// 边转边播在 metadata 之前 `duration` 是 NaN/Infinity。拿不可信的分母去夹，
// 会把每一次正常拖动都改成从头播。
check('duration = NaN → 保留目标 60', planSeek({
  requested: 60,
  duration: NaN,
  seekableEnd: 200,
}).target, 60);

check('duration = Infinity → 保留目标 60', planSeek({
  requested: 60,
  duration: Infinity,
  seekableEnd: 200,
}).target, 60);

// ── 5. 读不到可寻址范围（普通文件源）→ 立即落位，交给浏览器 ────────────
check('seekableEnd = 0 → 立即落位', planSeek({
  requested: 60,
  duration: 90,
  seekableEnd: 0,
}).kind, 'immediate');

check('seekableEnd = NaN → 立即落位', planSeek({
  requested: 60,
  duration: 90,
  seekableEnd: NaN,
}).kind, 'immediate');

// ── 6. 等待期结束判据 ──────────────────────────────────────────────────
check('转码追上目标 → 可以落位', seekableReached(90, 90), true);
check('转码差 0.4 秒（分片边界）→ 也算追上', seekableReached(89.6, 90), true);
check('转码差 0.6 秒 → 还没追上', seekableReached(89.4, 90), false);
check('末端读不到 → 不算追上', seekableReached(0, 90), false);
check('末端 NaN → 不算追上', seekableReached(NaN, 90), false);

// ── 7. 常量钉住（改动等于改变行为） ────────────────────────────────────
check('可寻址容差 = 0.5 秒', SEEK_SEEKABLE_TOLERANCE_SECONDS, 0.5);

console.log('');
console.log(pass + ' passed, ' + fail + ' failed');
if (fail > 0) process.exit(1);
