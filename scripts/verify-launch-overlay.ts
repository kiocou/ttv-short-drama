/**
 * 启动动画层的**事件穿透**验证。
 *
 * ## 守的是什么
 *
 * 用户报「首页的鼠标滚轮没效果，刚打开的时候，过一会儿又好了」。
 *
 * 根因：`.ttv-launch` 是 `position: absolute; inset: 0; z-index: 70`，
 * 铺满整个应用、盖在所有内容之上，而它**没有** `pointer-events: none`。
 * 于是在它存活的 1.7–3.2 秒里，所有指针与滚轮事件都被它接住 ——
 * 首页的 `overflow-y-auto` 容器根本收不到 wheel。
 *
 * "过一会儿又好了"正是这一层卸载的时刻。
 *
 * 这个脚本读真实 CSS 与组件源码来断言这条约束，防止以后有人把
 * `pointer-events: auto` 加回去（那会让启动期间再次变成"滚不动"）。
 *
 * 运行：npm run verify-launch-overlay
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

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

/** 去掉 CSS 注释：注释里会写「不要加回 pointer-events: auto」这类说明，直接断言会误匹配。 */
function stripComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

/** 抽出某个选择器的声明块（已剥离注释）。 */
function ruleBody(rawCss, selector) {
  const css = stripComments(rawCss);
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`(^|\\})\\s*${escaped}\\s*\\{([^}]*)\\}`, 'm').exec(css);
  return match ? match[2] : null;
}

/** 去掉 TSX 注释：注释里提到 onPointerDown 同样会误匹配。 */
function stripTsxComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');
}

const launchCss = readFileSync(join(root, 'src', 'styles', 'launch.css'), 'utf8');
const launchTsx = readFileSync(join(root, 'src', 'components', 'layout', 'LaunchAnimation.tsx'), 'utf8');

// ── 1. 核心：覆盖层必须让事件穿透 ─────────────────────────────
{
  const body = ruleBody(launchCss, '.ttv-launch');
  check('存在 .ttv-launch 规则', body !== null, true);
  check(
    '覆盖层 pointer-events: none（滚轮能落到首页）',
    /pointer-events\s*:\s*none/.test(body || ''),
    true,
  );
  // 反向断言：绝不能是 auto（那会把整层变成吃事件的遮罩）
  check(
    '覆盖层不是 pointer-events: auto',
    /pointer-events\s*:\s*auto/.test(body || ''),
    false,
  );
  check('覆盖层仍然铺满全屏（inset: 0）', /inset\s*:\s*0/.test(body || ''), true);
  check('覆盖层仍然在最高层（z-index: 70）', /z-index\s*:\s*70/.test(body || ''), true);
}

// ── 2. 跳过入口必须仍然可点 ──────────────────────────────────
{
  const body = ruleBody(launchCss, '.ttv-launch-hint');
  check('存在 .ttv-launch-hint 规则', body !== null, true);
  check(
    '提示条恢复 pointer-events: auto（鼠标能跳过）',
    /pointer-events\s*:\s*auto/.test(body || ''),
    true,
  );
  check('提示条是按钮（有 appearance 复位）', /appearance\s*:\s*none/.test(body || ''), true);
  check('提示条有键盘焦点轮廓', /focus-visible/.test(launchCss), true);
}

// ── 3. 组件侧：整层不能再挂 onPointerDown 跳过 ─────────────────
{
  /**
   * 整层 `pointer-events: none` 之后，挂在它上面的 `onPointerDown` 永远不会触发。
   * 留着会误导后来者以为"点任意处能跳过"，实际点不到。
   */
  const launchTsxCode = stripTsxComments(launchTsx);
  const hasLayerPointerHandler = /className="ttv-launch"[\s\S]{0,400}?onPointerDown/.test(launchTsxCode);
  check('整层没有残留的 onPointerDown 跳过', hasLayerPointerHandler, false);

  // 跳过入口改成了按钮
  check('提示条改成了 <button>', /<button[\s\S]{0,200}?ttv-launch-hint/.test(launchTsx), true);
  check('按钮 onClick 调用 skip()', /onClick=\{\(\)\s*=>\s*skip\(\)\}/.test(launchTsx), true);
  check('按钮有 type="button"（不会误提交表单）', /type="button"/.test(launchTsx), true);

  // 键盘入口仍在
  check('保留键盘跳过（Esc/空格/回车）', /keydown/.test(launchTsx) && /skip\(\)/.test(launchTsx), true);
}

// ── 4. 首页滚动容器本身没有 wheel 拦截 ────────────────────────
{
  const explore = readFileSync(join(root, 'src', 'components', 'views', 'ExploreView.tsx'), 'utf8');
  check('首页用原生 overflow-y-auto 滚动', /overflow-y-auto/.test(explore), true);
  // 若有人在容器上挂 onWheel 并 preventDefault，滚轮同样会失效
  check('首页没有拦截 wheel 事件', /onWheel/.test(explore), false);
}

// ── 5. 全局层面没有其它 wheel 拦截 ────────────────────────────
{
  const app = readFileSync(join(root, 'src', 'App.tsx'), 'utf8');
  check('App 没有全局 wheel 拦截', /addEventListener\(\s*['"]wheel/.test(app), false);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
