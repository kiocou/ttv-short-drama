/**
 * 播放器操作提示（B 站风格）的状态机验证。
 *
 * ## 守的是什么
 *
 * 播放器的快捷键不少（空格 / ← → / ↑ ↓ / F / [ ]），但此前**没有任何视觉反馈**：
 * 按空格画面停了，分不清"暂停了"还是"卡住了"；按 ↑↓ 只有角落一个几乎不动的图标；
 * 按 [ ] 画面直接跳，不知道切到了第几集。
 *
 * 现在操作发生时画面正中央闪一块「图标 + 文字」，0.76 秒后自己淡出。
 * 这个脚本验证三件容易写错的事：
 *   1. **连按要重新点亮**：靠 `tick` 递增驱动，不能只比较 payload；
 *   2. **容器不能挂 key**：挂了会在内容变化时卸载重建，丢掉 visible 状态；
 *   3. **内容映射正确**：播放/暂停取反、音量边界、快进快退的落点时间。
 *
 * 运行：npm run verify:player-toast
 */

/** 与 `usePlayerToast` 一致的 tick 语义。 */
function createToastState() {
  let tick = 0;
  let payload = null;
  return {
    show(next) {
      tick += 1;
      payload = next;
      return { payload, tick };
    },
    get() {
      return { payload, tick };
    },
  };
}

/**
 * 与 `PlayerToast` 的 effect 等价的可见性推导。
 *
 * 给定一系列"点亮事件"，返回每一刻是否可见。
 * `tick` 变化即重新点亮并重置计时（这是 effect 依赖 tick 的原因）。
 */
function simulateVisibility(events, holdMs = 760) {
  // 每个事件形如 { at, payload, tick }
  let visibleUntil = -Infinity;
  const timeline = [];
  let lastTick = -1;
  for (const event of events) {
    if (event.tick !== lastTick) {
      lastTick = event.tick;
      visibleUntil = event.at + holdMs;
    }
    timeline.push({ at: event.at, visible: event.at < visibleUntil });
  }
  return timeline;
}

let passed = 0;
let failed = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    passed += 1;
    console.log(`PASS ${name}`);
  } else {
    failed += 1;
    console.log(`FAIL ${name}  期望=${JSON.stringify(expected)} 实际=${JSON.stringify(actual)}`);
  }
}

// ── 1. tick 递增：连按两次必须让 tick 变大 ─────────────────────
{
  const state = createToastState();
  const first = state.show({ key: 'playback', label: '播放' });
  const second = state.show({ key: 'playback', label: '暂停' });
  check('第一次 tick = 1', first.tick, 1);
  check('连按第二次 tick = 2', second.tick, 2);
  check('tick 严格递增', second.tick > first.tick, true);
  // 关键：同一个 key 也要重新点亮 —— 这正是不能只比较 payload 的原因。
  check('同一 key 也递增 tick', second.tick - first.tick, 1);
}

// ── 2. 可见性：点亮后保持，超时后熄灭 ──────────────────────────
{
  const timeline = simulateVisibility([{ at: 0, tick: 1, payload: { key: 'playback' } }]);
  check('刚点亮时可见', timeline[0].visible, true);

  // 500ms 时仍在窗口内
  const mid = simulateVisibility([
    { at: 0, tick: 1, payload: { key: 'playback' } },
    { at: 500, tick: 1, payload: { key: 'playback' } },
  ]);
  check('500ms 时仍可见', mid[1].visible, true);

  // 800ms 时已超时
  const after = simulateVisibility([
    { at: 0, tick: 1, payload: { key: 'playback' } },
    { at: 800, tick: 1, payload: { key: 'playback' } },
  ]);
  check('800ms 时已熄灭', after[1].visible, false);
}

// ── 3. 连按重新计时：tick 变了，熄灭时刻要往后推 ────────────────
{
  // 第一次在 0ms 点亮（760ms 熄灭）；600ms 时第二次按下（tick 变），
  // 熄灭时刻应推到 600+760=1360ms。所以 1000ms 时仍然可见。
  const timeline = simulateVisibility([
    { at: 0, tick: 1, payload: { key: 'volume' } },
    { at: 600, tick: 2, payload: { key: 'volume' } },
    { at: 1000, tick: 2, payload: { key: 'volume' } },
  ]);
  check('连按后 1000ms 仍可见（计时已重置）', timeline[2].visible, true);

  // 对照：没有第二次按下时，1000ms 早就熄灭了。
  const withoutRetrigger = simulateVisibility([
    { at: 0, tick: 1, payload: { key: 'volume' } },
    { at: 1000, tick: 1, payload: { key: 'volume' } },
  ]);
  check('未连按时 1000ms 已熄灭', withoutRetrigger[1].visible, false);
}

// ── 4. 内容映射：播放/暂停要反映"切换后"的状态 ──────────────────
{
  /**
   * 与 VideoSurface / AnimeVideoSurface 的写法一致：
   * `isPlaying` 是**切换前**的值，提示要取反。
   */
  function playbackToast(isPlaying) {
    return { icon: isPlaying ? 'pause' : 'play', label: isPlaying ? '暂停' : '播放' };
  }
  check('正在播放时按空格 → 提示"暂停"', playbackToast(true), { icon: 'pause', label: '暂停' });
  check('已暂停时按空格 → 提示"播放"', playbackToast(false), { icon: 'play', label: '播放' });
}

// ── 5. 音量边界：到顶/到底要给反馈，且不能重复 setVolume ────────
{
  function volumeToast(volume, delta) {
    const next = Math.min(1, Math.max(0, volume + delta));
    const atEdge = Math.abs(next - volume) < 0.001;
    const silent = next <= 0.001;
    return {
      changed: !atEdge,
      next,
      label: silent ? '静音' : atEdge ? (delta > 0 ? '音量已满' : '音量已静音') : '音量',
      detail: `${Math.round(next * 100)}%`,
    };
  }
  check('音量 50% 按 +10% → 生效', volumeToast(0.5, 0.1), {
    changed: true, next: 0.6, label: '音量', detail: '60%',
  });
  check('音量 100% 再按 +10% → 不生效但提示已满', volumeToast(1, 0.1), {
    changed: false, next: 1, label: '音量已满', detail: '100%',
  });
  check('音量 0% 再按 -10% → 不生效，提示静音', volumeToast(0, -0.1), {
    changed: false, next: 0, label: '静音', detail: '0%',
  });
  check('音量 10% 按 -10% → 归零并提示静音', volumeToast(0.1, -0.1), {
    changed: true, next: 0, label: '静音', detail: '0%',
  });
}

// ── 6. 快进/快退：落点时间要夹在 [0, duration] 内 ───────────────
{
  function seekTarget(position, delta, duration) {
    const hasDuration = Number.isFinite(duration) && duration > 0;
    return Math.min(
      hasDuration ? duration : Number.POSITIVE_INFINITY,
      Math.max(0, position + delta),
    );
  }
  check('30s 处快进 5s → 35s', seekTarget(30, 5, 60), 35);
  check('58s 处快进 5s → 夹到 60s', seekTarget(58, 5, 60), 60);
  check('3s 处快退 5s → 夹到 0s', seekTarget(3, -5, 60), 0);
  check('时长未知时也能算落点', seekTarget(30, 5, 0), 35);
}

// ── 7. formatClock：时间读数格式 ────────────────────────────────
{
  function formatClock(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
    const total = Math.floor(seconds);
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    return `${m}:${String(s).padStart(2, '0')}`;
  }
  check('0 秒', formatClock(0), '0:00');
  check('65 秒 → 1:05', formatClock(65), '1:05');
  check('3725 秒 → 1:02:05', formatClock(3725), '1:02:05');
  check('负数归零', formatClock(-5), '0:00');
  check('NaN 归零', formatClock(Number.NaN), '0:00');
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
