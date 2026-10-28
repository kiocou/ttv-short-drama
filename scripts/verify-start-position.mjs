// 验证"换集起播点"的判定。
//
// 运行：npm run verify:start
//
// ⚠️ 这个脚本只验证**判定本身**（`resolveStartTarget`）。"写进元素后浏览器是否真的
// 从那里起播"取决于 hls.js 的 `startPosition`，那件事由 `attachSource` 的形参保证
// （源码里显式传值），纯函数测不到。
//
// ## 这份用例守的是哪次故障（2026-10-24）
//
// 用户报告：「画中画里切集，进度条不会重置，而是回到之前的位置继续播，
// 导致这一集不能完整看完」。
//
// 两个根因各有一组用例：
//   ① hls.js 起播点继承元素残留值 → 由 `attachSource` 显式传参解决；
//   ② 调用方只在 `startPosition > 0` 时才写 `currentTime`，换集传 0 时
//      **整段不执行** → 本脚本的第 1 组用例。

import { resolveStartTarget, START_NEAR_END_SECONDS, START_DRIFT_LOG_SECONDS } from '../src/services/playbackStart.ts';

let pass = 0;
let fail = 0;

function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) pass += 1;
  else fail += 1;
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok ? '' : '  期望=' + JSON.stringify(expected) + ' 实际=' + JSON.stringify(actual)));
}

// ── 1. 换集必须回到 0（本次修复的核心回归） ────────────────────────────
//
// 上一集播到 40s、用户点"下一集"：`startPosition` 传 0，元素上还留着 40。
// 目标必须是 0，且必须判定为"有偏移"（否则调用方不会归位）。
check('换集：传 0、元素残留 40s → 目标 0 且判为偏移', resolveStartTarget({
  startPosition: 0,
  duration: 90,
  currentTime: 40,
}), { target: 0, clampedFromEnd: false, drifted: true });

check('换集：传 0、元素也已是 0 → 目标 0、不算偏移', resolveStartTarget({
  startPosition: 0,
  duration: 90,
  currentTime: 0,
}), { target: 0, clampedFromEnd: false, drifted: false });

// 偏移容差是 0.5 秒：换源后浏览器自己会落点调整零点几秒，那不该刷日志。
check('偏移 0.4 秒（浏览器落点噪声）→ 不记日志', resolveStartTarget({
  startPosition: 0,
  duration: 90,
  currentTime: 0.4,
}).drifted, false);
check('偏移 0.6 秒（超过容差）→ 记日志', resolveStartTarget({
  startPosition: 0,
  duration: 90,
  currentTime: 0.6,
}).drifted, true);

// ── 2. 负数 / 非有限 / 缺省一律按"从头" ────────────────────────────────
check('startPosition = -1（hls.js 的"用元素值"哨兵）→ 0', resolveStartTarget({
  startPosition: -1,
  duration: 90,
  currentTime: 0,
}).target, 0);
check('startPosition = NaN → 0', resolveStartTarget({
  startPosition: NaN,
  duration: 90,
  currentTime: 0,
}).target, 0);
check('startPosition = Infinity → 0', resolveStartTarget({
  startPosition: Infinity,
  duration: 90,
  currentTime: 0,
}).target, 0);

// ── 3. 越界起点改为从头（2026-10-23 那次"画面停在正在准备画面"） ──────
check('续播点贴着结尾（89.5 / 90）→ 改为从头', resolveStartTarget({
  startPosition: 89.5,
  duration: 90,
  currentTime: 0,
}), { target: 0, clampedFromEnd: true, drifted: false });

check('续播点正好等于时长 → 改为从头', resolveStartTarget({
  startPosition: 90,
  duration: 90,
  currentTime: 0,
}).target, 0);

check('续播点超出时长 → 改为从头', resolveStartTarget({
  startPosition: 120,
  duration: 90,
  currentTime: 0,
}).target, 0);

// 边界：容差是 1 秒且**闭区间** —— 89.0 / 90 差正好 1 秒，算"贴着结尾"，改为从头。
//
// 为什么是闭区间而不是开区间：这个判据的代价不对称。多夹一次只是"这一集从头播"
// （用户顶多手动拖回去），漏夹一次是"卡在结尾再也出不来"——后者正是 2026-10-23
// 那次「画面永远停在正在准备画面」。
check('续播点 89.0 / 90（差正好 1 秒）→ 算贴着结尾，夹到 0', resolveStartTarget({
  startPosition: 89,
  duration: 90,
  currentTime: 0,
}), { target: 0, clampedFromEnd: true, drifted: false });
check('续播点 88.9 / 90（差 1.1 秒）→ 照用，不夹取', resolveStartTarget({
  startPosition: 88.9,
  duration: 90,
  currentTime: 0,
}).clampedFromEnd, false);

// ── 4. 正常的断点续播必须原样保留 ──────────────────────────────────────
check('续播点 30 / 90 → 目标 30', resolveStartTarget({
  startPosition: 30,
  duration: 90,
  currentTime: 0,
}), { target: 30, clampedFromEnd: false, drifted: true });

check('续播点 0.5 / 90 → 目标 0.5', resolveStartTarget({
  startPosition: 0.5,
  duration: 90,
  currentTime: 0,
}).target, 0.5);

// ── 5. 时长不可信时不能乱夹取 ──────────────────────────────────────────
//
// 边转边播的整集 HLS 在 metadata 之前 `duration` 是 `NaN` / `Infinity`。
// 那种情况下**必须**照用调用方给的起点：拿一个不可信的分母去判"越界"，
// 会把每一次正常续播都改成从头播。
check('duration = NaN 时保留续播点 30', resolveStartTarget({
  startPosition: 30,
  duration: NaN,
  currentTime: 0,
}), { target: 30, clampedFromEnd: false, drifted: true });

check('duration = Infinity 时保留续播点 30', resolveStartTarget({
  startPosition: 30,
  duration: Infinity,
  currentTime: 0,
}).target, 30);

check('duration = 0 时保留续播点 30', resolveStartTarget({
  startPosition: 30,
  duration: 0,
  currentTime: 0,
}).target, 30);

// ── 6. 常量本身也钉住（改动它们等于改变行为，必须显式） ────────────────
check('末尾容差 = 1 秒', START_NEAR_END_SECONDS, 1);
check('偏移打点阈值 = 0.5 秒', START_DRIFT_LOG_SECONDS, 0.5);

console.log('');
// ── 6. 边转边播：越界判断必须用**权威时长**，不能用 video.duration ──────────
//
// 2026-10-27 用户报告：「点击进度条跳转后，画面会重复三四次」。
// 现场日志（ttv-playback.log）：
//
//   起播点越界（72.0s ≥ 时长 52.8s），改为从头播
//   起播点收敛 期望=0.00s 元素现值=3.23s（强制归位）
//   timeupdate 心跳 位置=76.73s
//
// 52.8s 是「当时已转码的长度」，不是这一集的长度（84s）。`alignPlayhead`
// 拿它当总长，于是合法的续播点 72s 被判成越界、强制归零；随后播放头又被
// 恢复到 72s，用户看到的就是画面在 0 与目标之间反复重播。
//
// 下面两条一组：同一次续播，喂不同的 duration 会得到相反的结论。
check('旧行为（误用已转码长度 52.8s 当总长）→ 72s 被误判越界', resolveStartTarget({
  startPosition: 72,
  duration: 52.8,
  currentTime: 0,
}), { target: 0, clampedFromEnd: true, drifted: false });

check('修复后（用权威时长 84s）→ 72s 正常保留', resolveStartTarget({
  startPosition: 72,
  duration: 84,
  currentTime: 0,
}), { target: 72, clampedFromEnd: false, drifted: true });

console.log(pass + ' passed, ' + fail + ' failed');
if (fail > 0) process.exit(1);
