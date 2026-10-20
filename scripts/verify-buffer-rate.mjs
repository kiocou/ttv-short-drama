// 验证「按倍速放大缓冲目标」的换算规则。
//
// 运行：npm run verify:buffer-rate
//
// ⚠️ 这个脚本只验证换算函数本身（纯算术）。真实的缓冲补偿效果必须靠播放
// 日志验证（看 fragLoadError / waiting 是否随 3x 消失）——单测无法覆盖
// MSE 的实际填充行为。

let pass = 0;
let fail = 0;

function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) pass += 1;
  else fail += 1;
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok ? '' : '  期望=' + JSON.stringify(expected) + ' 实际=' + JSON.stringify(actual)));
}

/**
 * 与 `hlsAttach.ts` 里 `applyBufferTarget` 保持同一套算术。
 *
 * 抽出来单独验证的理由：这个换算错了**不会报错**，只会表现为"3x 时偶尔卡一下"。
 * 那是最难定位的一类缺陷——必须有断言钉住。
 */
const BASE_SECONDS = 20;
const MIN_SECONDS = 20;
const MAX_SECONDS = 120;

function bufferTargetFor(rate) {
  const r = Number.isFinite(rate) && rate > 0 ? rate : 1;
  return Math.min(MAX_SECONDS, Math.max(MIN_SECONDS, Math.round(BASE_SECONDS * r)));
}

// ── 1x：基准值 ────────────────────────────────────────────────
check('1x 正常倍速：20 秒媒体缓冲', bufferTargetFor(1), 20);

// ── 加速：必须随倍速线性放大 ──────────────────────────────────
//
// 这是本次修复的核心：`maxBufferLength` 单位是媒体时间，3x 下 20 秒缓冲
// 只够播 6.7 秒真实时间。实测 20 次 >0.5 秒的缓冲里 18 次发生在 3x。
check('2x：40 秒', bufferTargetFor(2), 40);
check('3x 长按加速：60 秒', bufferTargetFor(3), 60);
check('2.5x：50 秒', bufferTargetFor(2.5), 50);
check('1.5x：30 秒', bufferTargetFor(1.5), 30);

// ── 异常输入必须退化成 1x，不能算出 NaN/负数 ──────────────────
//
// `video.playbackRate` 在换源瞬间可能是 NaN 或 0。若直接把 NaN 塞进
// config，hls.js 的缓冲目标会变成 NaN，后续所有比较都是 false——
// 表现为"完全不再主动缓冲"，比放大不足更糟。
check('NaN 倍速：退化成 1x', bufferTargetFor(NaN), 20);
check('0 倍速：退化成 1x', bufferTargetFor(0), 20);
check('负倍速：退化成 1x', bufferTargetFor(-3), 20);
check('undefined：退化成 1x', bufferTargetFor(undefined), 20);

// ── 上限：极高倍速不能无限放大 ────────────────────────────────
//
// 缓冲堆到几百秒会把整集产物全锁在内存里，在 1GB 缓存预算下得不偿失。
check('5x：100 秒（未触及上限）', bufferTargetFor(5), 100);
check('10x：钳到 120 秒上限', bufferTargetFor(10), 120);

console.log('');
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
process.exit(fail === 0 ? 0 : 1);
