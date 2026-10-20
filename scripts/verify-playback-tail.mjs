// 验证“末尾可播末端”判定的位置语义，以及 1.2 秒复核所依赖的边界。
//
// 运行：npm run verify:tail
//
// ⚠️ 这个脚本只验证**位置判定**（`isPlayheadAtPlayableTail`）。"是否真的播完"
// 必须由调用方补时间维度（`usePlaybackStore` 里 1.2 秒的末尾复核、看门狗的
// 三信号停滞计时），单帧快照无法表达，也不该在这里断言。

import { isPlayheadAtPlayableTail } from '../src/services/playbackTail.ts';

let pass = 0;
let fail = 0;

function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) pass += 1;
  else fail += 1;
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok ? '' : '  期望=' + JSON.stringify(expected) + ' 实际=' + JSON.stringify(actual)));
}

const base = {
  currentTime: 98.6,
  duration: 100,
  bufferedEnd: 98.6,
  paused: false,
  seeking: false,
};

check('最后一小段未落地、播放头追上缓冲末端：命中', isPlayheadAtPlayableTail(base), true);

// 本次修复的核心回归用例（2026-10-19）。
// 旧实现 `bufferedEnd >= duration - 0.15 → return false` 在这里返回 false，
// 而实测产物 buffered.end 与 duration 只差 0.00~0.07 秒 —— 也就是这一格
// **必然命中**，于是"末段全部进缓冲、播放头走不到 duration"永远没有出口。
check('末段已全部进缓冲（buffered=duration）、播放头差 0.1 秒：位置判定必须命中', isPlayheadAtPlayableTail({
  ...base,
  currentTime: 99.9,
  bufferedEnd: 100,
}), true);
check('末段全部进缓冲、播放头卡在最后 2 秒：位置判定仍命中（交给复核确认）', isPlayheadAtPlayableTail({
  ...base,
  currentTime: 98,
  bufferedEnd: 100,
}), true);
check('播放头还没追上缓冲末端：先继续等数据', isPlayheadAtPlayableTail({
  ...base,
  currentTime: 98.2,
  bufferedEnd: 99.5,
}), false);
check('中段卡在缓冲末端：不能按播完处理', isPlayheadAtPlayableTail({
  ...base,
  currentTime: 30,
  bufferedEnd: 30,
}), false);
check('已经离开末尾区域（还差 4 秒）：默认窗口不命中', isPlayheadAtPlayableTail({
  ...base,
  currentTime: 96,
  bufferedEnd: 96,
}), false);
check('还差 4 秒但看门狗放宽到 5 秒窗口：命中', isPlayheadAtPlayableTail({
  ...base,
  currentTime: 96,
  bufferedEnd: 96,
}, 5), true);
check('正在 seek：不能按播完处理', isPlayheadAtPlayableTail({
  ...base,
  seeking: true,
}), false);
check('已暂停：不能按播完处理（逐帧看结尾）', isPlayheadAtPlayableTail({
  ...base,
  paused: true,
}), false);
check('已经派发过 ended：不再重复处理', isPlayheadAtPlayableTail({
  ...base,
  ended: true,
}), false);
check('时长未知：不能按播完处理', isPlayheadAtPlayableTail({
  ...base,
  duration: 0,
}), false);
check('没有缓冲信息：不能按播完处理', isPlayheadAtPlayableTail({
  ...base,
  bufferedEnd: 0,
}), false);

// 2026-10-20 复查补的回归用例：缓冲被清空 / 驱逐。
//
// 旧判据 `currentTime >= bufferedEnd - 0.3` 是单向不等式，于是"播放头停在末尾、
// 缓冲却退到 0.x 秒"同样命中 —— 而这正是 `recoverMediaError()` 清 MSE 之后、
// 或 MSE 驱逐之后的标准现场。误判成播完会提前跳集，并把这一集按 100% 写进历史。
check('缓冲被清空、播放头仍在末尾：不能按播完处理（等数据重新进来）', isPlayheadAtPlayableTail({
  ...base,
  currentTime: 97.6,
  bufferedEnd: 0.05,
}), false);
check('缓冲被驱逐到中段、播放头在末尾：不能按播完处理', isPlayheadAtPlayableTail({
  ...base,
  currentTime: 99,
  bufferedEnd: 60,
}), false);
check('缓冲末端略微落后播放头（几十毫秒）：仍算贴住，命中', isPlayheadAtPlayableTail({
  ...base,
  currentTime: 99.5,
  bufferedEnd: 99.35,
}), true);

console.log('');
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
process.exit(fail === 0 ? 0 : 1);
