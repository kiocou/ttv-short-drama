/**
 * 长按方向键的行为验证：音量连续调节 vs 加速状态机。
 *
 * ## 守的是什么
 *
 * 用户报「长按上下方向键没有连续添加音量」。
 *
 * 根因是 `useBoostKeys` 在 switch 之前一刀切 `if (event.repeat) return;`。
 * 那条规则原本是为 ← / → 写的（长按加速的定时器不能被重复事件重置），
 * 但它同时把 ↑ / ↓ 的重复事件也挡掉了 —— 而 ↑↓ 是**离散步进**语义，
 * 按住时本来就该连续调节。
 *
 * 这个脚本把「按键事件 → 是否处理」的判定抽成纯函数来验证，
 * 覆盖两个方向的完整矩阵：repeat / 加速中 / 锁定 / 输入框。
 *
 * 运行：npm run verify-keyrepeat
 */

/** 与 `useBoostKeys` 一致的判定：返回 'handled' | 'ignored'。 */
function decideKey({ code, repeat = false, boosting = false, enabled = true, locked = false, inInput = false }) {
  if (inInput) return 'ignored';
  if (!enabled || locked) return 'ignored';

  switch (code) {
    case 'ArrowLeft':
    case 'ArrowRight':
      // 长按加速的按下只认一次：重复会重置长按定时器，加速永远起不来。
      if (repeat) return 'ignored';
      return 'press-boost';

    case 'ArrowUp':
    case 'ArrowDown':
      if (boosting) {
        // 加速期间换档是离散动作，重复会让它一次连跳好几档。
        if (repeat) return 'ignored';
        return 'cycle-level';
      }
      // 非加速时调音量：**放行重复**，按住才能连续调节。
      return 'step-volume';

    case 'Escape':
      if (repeat) return 'ignored';
      return 'cancel-boost';

    default:
      return 'ignored';
  }
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

// ── 1. 核心：↑↓ 的重复事件必须被处理（音量连续调节）────────────
{
  check('↑ 首次按下 → 调音量', decideKey({ code: 'ArrowUp' }), 'step-volume');
  check('↑ 重复按下 → 仍然调音量', decideKey({ code: 'ArrowUp', repeat: true }), 'step-volume');
  check('↓ 首次按下 → 调音量', decideKey({ code: 'ArrowDown' }), 'step-volume');
  check('↓ 重复按下 → 仍然调音量', decideKey({ code: 'ArrowDown', repeat: true }), 'step-volume');
}

// ── 2. ←→ 的重复事件必须被挡（加速定时器不能被重置）────────────
{
  check('← 首次按下 → 起长按计时', decideKey({ code: 'ArrowLeft' }), 'press-boost');
  check('← 重复按下 → 忽略', decideKey({ code: 'ArrowLeft', repeat: true }), 'ignored');
  check('→ 首次按下 → 起长按计时', decideKey({ code: 'ArrowRight' }), 'press-boost');
  check('→ 重复按下 → 忽略', decideKey({ code: 'ArrowRight', repeat: true }), 'ignored');
}

// ── 3. 加速期间 ↑↓ 变成换档，重复要挡 ──────────────────────────
{
  check('加速中 ↑ 首次 → 换档', decideKey({ code: 'ArrowUp', boosting: true }), 'cycle-level');
  check('加速中 ↑ 重复 → 忽略（避免连跳）', decideKey({ code: 'ArrowUp', boosting: true, repeat: true }), 'ignored');
  check('加速中 ↓ 重复 → 忽略', decideKey({ code: 'ArrowDown', boosting: true, repeat: true }), 'ignored');
}

// ── 4. Esc 重复要挡 ───────────────────────────────────────────
{
  check('Esc 首次 → 收加速', decideKey({ code: 'Escape' }), 'cancel-boost');
  check('Esc 重复 → 忽略', decideKey({ code: 'Escape', repeat: true }), 'ignored');
}

// ── 5. 前置条件：锁定 / 非播放器 / 输入框一律忽略 ───────────────
{
  check('锁定态 ↑ 不调音量', decideKey({ code: 'ArrowUp', locked: true }), 'ignored');
  check('锁定态 ↑ 重复也不调', decideKey({ code: 'ArrowUp', locked: true, repeat: true }), 'ignored');
  check('非播放器视图 ↑ 忽略', decideKey({ code: 'ArrowUp', enabled: false }), 'ignored');
  check('输入框内 ↑ 忽略（不抢输入）', decideKey({ code: 'ArrowUp', inInput: true }), 'ignored');
  check('输入框内 ↑ 重复也忽略', decideKey({ code: 'ArrowUp', inInput: true, repeat: true }), 'ignored');
}

// ── 6. 音量累积：连续按键必须真的涨上去 ───────────────────────
{
  /**
   * 模拟"按住 ↑"：系统每秒派发约 15 条 keydown。
   *
   * 关键差异在于基准值取哪里：
   *   - 旧实现取**闭包里的 state**（异步提交，同一帧内不变）→ 只涨一格；
   *   - 新实现取**媒体元素的真实音量**（同步写入）→ 每档都在上一档上累加。
   */
  function simulateHold({ startVolume, steps, delta, baseFromMedia }) {
    let mediaVolume = startVolume;   // video.volume，同步写
    let stateVolume = startVolume;   // React state，异步提交
    let pending = null;

    for (let i = 0; i < steps; i += 1) {
      const base = baseFromMedia ? mediaVolume : stateVolume;
      const next = Math.min(1, Math.max(0, base + delta));
      mediaVolume = next;
      pending = next;   // 本轮写入，但要等到"渲染"才成为 state
    }
    // 模拟一批事件结束后 state 才提交一次
    stateVolume = pending;
    return { mediaVolume, stateVolume };
  }

  // 从 0 开始按住 ↑ 三档，每档 +0.1
  const mediaBased = simulateHold({ startVolume: 0, steps: 3, delta: 0.1, baseFromMedia: true });
  check('以媒体音量为基准：三档后 = 0.3', Math.round(mediaBased.mediaVolume * 100), 30);

  const stateBased = simulateHold({ startVolume: 0, steps: 3, delta: 0.1, baseFromMedia: false });
  check('以 state 为基准：三档后仍是 0.1（旧 bug）', Math.round(stateBased.mediaVolume * 100), 10);

  // 边界：不会超过 100%
  const capped = simulateHold({ startVolume: 0.95, steps: 5, delta: 0.1, baseFromMedia: true });
  check('连续加不会超过 100%', Math.round(capped.mediaVolume * 100), 100);

  // 边界：不会低于 0%
  const floored = simulateHold({ startVolume: 0.05, steps: 5, delta: -0.1, baseFromMedia: true });
  check('连续减不会低于 0%', Math.round(floored.mediaVolume * 100), 0);
}

// ── 7. 边界提示：到顶/到底仍要给反馈 ───────────────────────────
{
  function volumeFeedback(base, delta) {
    const next = Math.min(1, Math.max(0, base + delta));
    const atEdge = Math.abs(next - base) < 0.001;
    const silent = next <= 0.001;
    return {
      changed: !atEdge,
      label: silent ? '静音' : atEdge ? (delta > 0 ? '音量已满' : '音量已静音') : '音量',
    };
  }
  check('100% 再按 ↑ → 不变化但提示已满', volumeFeedback(1, 0.1), { changed: false, label: '音量已满' });
  check('0% 再按 ↓ → 不变化但提示静音', volumeFeedback(0, -0.1), { changed: false, label: '静音' });
  check('50% 按 ↑ → 正常变化', volumeFeedback(0.5, 0.1), { changed: true, label: '音量' });
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
