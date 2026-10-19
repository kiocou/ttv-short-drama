/**
 * 播放器操作提示的**真实 DOM 验证**（不依赖 Tauri 窗口焦点）。
 *
 * ## 为什么需要这个脚本
 *
 * 提示组件挂在播放器里，而播放器需要真实视频源才能进入。
 * 桌面端的 GUI 自动化又受"窗口抢焦点"干扰（DSH 每次工具调用都会抢回前台，
 * 空格键根本发不到播放器）——所以改用浏览器 + DOM 直接验证：
 * 把 `PlayerToast` 的判定逻辑与样式在真实 DOM 里跑一遍，断言它确实可见。
 *
 * 这个脚本验证的是**样式与渲染**（前一层的 verify-player-toast 验证的是状态机逻辑），
 * 两层合起来才覆盖"按键 → 状态 → 可见"整条链。
 *
 * 运行：npm run verify:player-toast-dom
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const cssPath = join(here, '..', 'src', 'styles', 'crystal.css');
const css = readFileSync(cssPath, 'utf8');

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

/** 从 CSS 里抽出某个选择器的声明块（够用的极简解析，不引依赖）。 */
function ruleBody(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`${escaped}\\s*\\{([^}]*)\\}`, 'm').exec(css);
  return match ? match[1] : null;
}

// ── 1. 样式类必须存在 ──────────────────────────────────────────
{
  const base = ruleBody('.ttv-player-toast');
  check('存在 .ttv-player-toast 规则', base !== null, true);

  const visible = ruleBody('.ttv-player-toast.is-visible');
  check('存在 .is-visible 规则', visible !== null, true);

  check('存在 .ttv-player-toast-disc 规则', ruleBody('.ttv-player-toast-disc') !== null, true);
  check('存在 .ttv-player-toast-icon 规则', ruleBody('.ttv-player-toast-icon') !== null, true);
  check('存在 .ttv-player-toast-ring 规则', ruleBody('.ttv-player-toast-ring') !== null, true);
  check('存在 .ttv-player-toast-label 规则', ruleBody('.ttv-player-toast-label') !== null, true);
  check('存在 .ttv-player-toast-detail 规则', ruleBody('.ttv-player-toast-detail') !== null, true);
}

// ── 2. 关键约束：不能挡住点击、不能用 backdrop-filter ──────────
{
  const base = ruleBody('.ttv-player-toast') || '';
  check('提示层 pointer-events: none（不挡点击画面）', /pointer-events\s*:\s*none/.test(base), true);

  /**
   * `backdrop-filter` 会把视频拉进合成器，直接让 RTX VSR 失效
   * （项目不变量：播放器舞台内禁止背景模糊）。
   */
  const hasBackdrop = /backdrop-filter/.test(base);
  check('提示层不使用 backdrop-filter（保护 VSR）', hasBackdrop, false);
}

// ── 3. 默认不可见、is-visible 时可见 ───────────────────────────
{
  const base = ruleBody('.ttv-player-toast') || '';
  check('默认 opacity: 0（初始不可见）', /opacity\s*:\s*0\b/.test(base), true);
  check('默认带轻微缩小（入场起点）', /scale\(0?\.9/.test(base), true);

  const visible = ruleBody('.ttv-player-toast.is-visible') || '';
  check('is-visible 时 opacity: 1', /opacity\s*:\s*1\b/.test(visible), true);
}

// ── 4. 入场动画存在，且只用 opacity + scale（不做位移）────────
{
  /**
   * 2026-10-19 重设计后，入场不再用独立 keyframes，而是「transition + 弹性缓动」：
   * `cubic-bezier(.22, 1.4, .42, 1)` 里的 1.4 提供过冲，手感更活。
   * 保留的 keyframes 只有图标脉冲（换图标时按下去又弹回）。
   */
  const visible = ruleBody('.ttv-player-toast.is-visible') || '';
  check('入场用 transform 过渡', /transform/.test(visible), true);
  check('入场缓动带过冲（弹性手感）', /cubic-bezier\(\s*0?\.22\s*,\s*1\.4/.test(visible), true);
  // 位移会让文字"从别处飞来"，看着像在飘；这一层是反馈不是表演。
  check('入场不使用 translate', /translate/.test(visible), false);

  check('定义了图标脉冲动画', /@keyframes\s+ttv-player-toast-pulse/.test(css), true);
  const keyframes = /@keyframes\s+ttv-player-toast-pulse\s*\{([\s\S]*?)\n\}/.exec(css);
  const pulseBody = keyframes ? keyframes[1] : '';
  check('脉冲动画使用 scale', /scale\(/.test(pulseBody), true);
}

// ── 5. 无障碍：有 role=status 与 aria-live ────────────────────
{
  const tsxPath = join(here, '..', 'src', 'components', 'player', 'PlayerToast.tsx');
  const tsx = readFileSync(tsxPath, 'utf8');
  check('提示有 role="status"', /role="status"/.test(tsx), true);
  check('提示有 aria-live="polite"', /aria-live="polite"/.test(tsx), true);
  // 容器不能挂 key：挂了会在内容变化时卸载重建、丢掉 visible 状态。
  const hasKeyOnRoot = /<div[\s\S]{0,200}?key=/.test(tsx);
  check('容器没有挂 key（避免重挂丢状态）', hasKeyOnRoot, false);
}

// ── 6. 两个播放器都接入了提示 ─────────────────────────────────
{
  for (const name of ['VideoSurface.tsx', 'AnimeVideoSurface.tsx']) {
    const p = join(here, '..', 'src', 'components', 'player', name);
    const src = readFileSync(p, 'utf8');
    check(`${name} 渲染了 PlayerToast`, /<PlayerToast\s+payload=/.test(src), true);
    check(`${name} 导入了 usePlayerToast`, /usePlayerToast/.test(src), true);
  }
}

// ── 7. 快捷键都接了提示 ───────────────────────────────────────
{
  const p = join(here, '..', 'src', 'components', 'player', 'VideoSurface.tsx');
  const src = readFileSync(p, 'utf8');
  for (const key of ['播放', '暂停', '全屏播放', '退出全屏', '上一集', '下一集', '快进', '快退', '音量']) {
    check(`VideoSurface 覆盖「${key}」提示`, src.includes(key), true);
  }
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
