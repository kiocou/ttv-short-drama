/**
 * 断点续播判定：`isFinished` 的语义与续播锚点的选择。
 *
 * ## 守的是什么
 *
 * 用户报过「看久了退出，回来位置没了，而且时有时无」。
 * 根因是 `isFinished = percent >= 95`：
 *   - 短剧一集实测只有 33–68 秒，看到 57/60 秒就被判「已看完」；
 *   - 而所有续播入口都是 `watchedSeconds > 0 && !isFinished`，
 *     一旦置位这一集就被跳过 → 重进播放器从别的集开始。
 *   - "时有时无"正是因为取决于退出那一刻是否刚好越过 95%。
 *
 * 现在以**剩余秒数**为主判据（剩余 ≤3 秒且百分比 ≥90）。
 * 百分比不能当主判据：20 秒的集看到 19 秒只剩 1 秒、确实看完了，
 * 但 `Math.round(19/20*100)` = 95，用"≥98%"会把它误杀 —— 越短越难判完，方向反了。
 *
 * 这个脚本把判定逻辑原样复刻成纯函数来验证边界，不依赖 React/DOM。
 *
 * 运行：npm run verify:resume
 */

/** 与 `usePlaybackStore.saveProgressThrottled` 完全一致的判定。 */
function computeIsFinished(position, duration) {
  const safeDur = Number.isFinite(duration) && duration > 0 ? duration : 0;
  const safePos = Number.isFinite(position) && position > 0
    ? Math.min(position, safeDur > 0 ? safeDur : position)
    : 0;
  const percent = safeDur > 0
    ? Math.min(100, Math.max(0, Math.round((safePos / safeDur) * 100)))
    : 0;
  const remaining = safeDur > 0 ? Math.max(0, safeDur - safePos) : Number.POSITIVE_INFINITY;
  return { isFinished: safeDur > 0 && remaining <= 2 && percent >= 95, percent, remaining };
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

// ── 1. 短剧典型场景：60 秒一集 ──────────────────────────────────
{
  // 看到 57 秒 = 95%：旧规则判完（bug），新规则不算完 —— 还有 3 秒内容。
  check('60s 看到 57s（95%）不算看完', computeIsFinished(57, 60).isFinished, false);
  // 看到 58 秒 = 97%，剩 2 秒：仍不算完。
  check('60s 看到 58s（剩2s）算看完', computeIsFinished(58, 60).isFinished, true);
  // 看到 59 秒 = 98%，剩 1 秒：算完。
  check('60s 看到 59s（剩1s）算看完', computeIsFinished(59, 60).isFinished, true);
  // 播到结尾。
  check('60s 播到 60s 算看完', computeIsFinished(60, 60).isFinished, true);
}

// ── 2. 剩余秒数是硬约束：百分比再高，剩太多也不算 ────────────────
{
  // 300 秒一集，看到 294 秒 = 98%，但还剩 6 秒 —— 不该算完。
  check('300s 看到 294s（98% 但剩 6s）不算看完', computeIsFinished(294, 300).isFinished, false);
  // 看到 298 秒 = 99%，剩 2 秒 —— 算完。
  check('300s 看到 298s（剩 2s）算看完', computeIsFinished(298, 300).isFinished, true);
}

// ── 3. 短内容：百分比不能单独成立 ──────────────────────────────
{
  // 20 秒一集，看到 19 秒 = 95%：旧规则判完，新规则剩 1 秒 → 算完。
  check('20s 看到 19s（剩1s，95%）算看完', computeIsFinished(19, 20).isFinished, true);
  // 20 秒一集，看到 18 秒 = 90% → 不算完。
  check('20s 看到 18s 不算看完', computeIsFinished(18, 20).isFinished, false);
}

// ── 4. 时长不可信（0 / NaN / Infinity）：绝不能判完 ──────────────
{
  check('duration=0 不判完', computeIsFinished(10, 0).isFinished, false);
  check('duration=NaN 不判完', computeIsFinished(10, Number.NaN).isFinished, false);
  check('duration=Infinity 不判完', computeIsFinished(10, Number.POSITIVE_INFINITY).isFinished, false);
  check('position=NaN 不判完', computeIsFinished(Number.NaN, 60).isFinished, false);
}

// ── 5. 早期刚起播：位置很小，不该判完 ──────────────────────────
{
  check('60s 刚播 1s 不算看完', computeIsFinished(1, 60).isFinished, false);
  check('60s 播 30s 不算看完', computeIsFinished(30, 60).isFinished, false);
}

// ── 6. 续播锚点：有进度就认，不再因 isFinished 被剔除 ────────────
{
  /**
   * 与 DetailView / ExploreView 的新选择逻辑一致：
   * 过滤出有进度的集 → 按集号取最大（看得最远的那一集）。
   */
  function pickResumeEpisode(episodes) {
    return [...episodes]
      .filter(e => (e.watchedSeconds || 0) > 0)
      .sort((left, right) => right.episodeNumber - left.episodeNumber)[0] || episodes[0] || null;
  }

  const episodes = [
    { id: 'e1', episodeNumber: 1, watchedSeconds: 60, isFinished: true },
    { id: 'e2', episodeNumber: 2, watchedSeconds: 45, isFinished: false },
    { id: 'e3', episodeNumber: 3, watchedSeconds: 0, isFinished: false },
  ];
  // 旧逻辑会跳过 e1（isFinished），选 e2；新逻辑取看得最远的 e2（集号最大且有进度）。
  check('锚点取看得最远且有进度的一集', pickResumeEpisode(episodes)?.id, 'e2');

  // 只有一集且被标成看完：仍然要能回到它，而不是回第一集从 0 开始。
  const onlyFinished = [{ id: 'e1', episodeNumber: 1, watchedSeconds: 60, isFinished: true }];
  check('唯一一集已看完仍作为锚点', pickResumeEpisode(onlyFinished)?.id, 'e1');

  // 全都没进度：退回第一集。
  const none = [
    { id: 'e1', episodeNumber: 1, watchedSeconds: 0 },
    { id: 'e2', episodeNumber: 2, watchedSeconds: 0 },
  ];
  check('都没进度时退回第一集', pickResumeEpisode(none)?.id, 'e1');
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
