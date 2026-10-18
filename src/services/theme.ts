/**
 * 主题（浅色 / 暗色 / 跟随系统）。
 *
 * 只碰 <html data-theme> 与 localStorage 两处，**不经过 UserSettings**：
 * `settings_save` 的入参是 Rust 侧反序列化出来的 UserSettings，加字段要前后端
 * 同时改（见 types/settings.ts 的 hardwareAcceleration 注释），而主题纯属前端
 * 表现，存 localStorage 就够了。
 *
 * dark.css 的全部规则都挂在 `html[data-theme='dark']` 上，所以切换只改这一个属性。
 *
 * ## 两层概念，别混用
 *
 * - `ThemePreference` —— **用户选了什么**，三个值，含 `system`。这是唯一落盘的。
 * - `ThemeMode`       —— **此刻实际生效什么**，只有 light/dark，由 preference 解析而来。
 *
 * 分开的理由：`system` 不是一个能写进 `data-theme` 的值（CSS 不认识它），而
 * 用户的选择又必须原样记住——否则下次启动时无法知道"该不该继续跟随系统"。
 * 任何写 `data-theme` 的地方都必须先经过 `resolveTheme()`。
 */
export type ThemeMode = 'light' | 'dark';
export type ThemePreference = ThemeMode | 'system';

const STORAGE_KEY = 'ttv:theme';

/** 系统配色偏好的媒体查询。Windows 11 的"应用模式"改的就是它。 */
const DARK_QUERY = '(prefers-color-scheme: dark)';

/** 系统此刻是否处于暗色。取不到 matchMedia（极老环境）时按浅色处理。 */
export function systemPrefersDark(): boolean {
  try {
    return window.matchMedia(DARK_QUERY).matches;
  } catch {
    return false;
  }
}

/**
 * 读出用户的选择。
 *
 * 默认值是 `'light'` 而不是 `'system'`：这个应用的浅色 Mica 是它的主视觉
 * （Windows 11 风格的白底 + 蓝色强调），暗色是"黑红配色"的另一种风格，
 * 属于用户主动选择的结果。默认跟随系统会让一半 Windows 用户第一次启动就看到
 * 一个和设计稿不同的界面——那不该是默认体验。
 */
export function readThemePreference(): ThemePreference {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === 'dark' || saved === 'light' || saved === 'system') return saved;
  } catch {
    // localStorage 不可用（隐私模式/配额满）：落到默认值。
  }
  return 'light';
}

/** 把"用户选择"解析成"实际生效的模式"。`system` 在这里才落到具体值。 */
export function resolveTheme(preference: ThemePreference): ThemeMode {
  if (preference === 'system') return systemPrefersDark() ? 'dark' : 'light';
  return preference;
}

/** 当前实际生效的主题。 */
export function readTheme(): ThemeMode {
  return resolveTheme(readThemePreference());
}

/** 写入 `data-theme`。**只接受实际模式**，传 preference 请先 `resolveTheme`。 */
export function applyTheme(mode: ThemeMode): void {
  document.documentElement.dataset.theme = mode;
}

/**
 * 保存并立即应用。
 *
 * 应用这一步走 `resolveTheme`，所以传 `'system'` 进来会当场落到系统当前的值，
 * 而不是把一个 CSS 不认识的 `"system"` 写进 `data-theme`。
 */
export function saveTheme(preference: ThemePreference): void {
  try {
    localStorage.setItem(STORAGE_KEY, preference);
  } catch {
    // 存不下只影响"下次启动记得住"，本次切换照常生效。
  }
  applyTheme(resolveTheme(preference));
}

/**
 * 开始监听系统配色变化。**整个进程只挂一次**，重复调用是空操作。
 *
 * 为什么需要它：选了「跟随系统」之后，用户在 Windows 设置里改应用模式，
 * 本应用必须立刻跟着变——否则"跟随"只在启动那一刻成立，之后就脱钩了。
 *
 * 监听器内部**每次都重新读 preference**，而不是闭包捕获一份：用户可能先选
 * 「跟随系统」再切到「暗色」，此时监听器仍然挂着（它不该被反复摘挂），
 * 但它必须能判断出"现在不该跟了"。读 localStorage 同步且极廉价，而这个回调
 * 只在系统配色变化时触发，不在热路径上。
 *
 * 在 `main.tsx` 首帧渲染前调用，与 `applyTheme` 配对。
 */
let systemWatcherAttached = false;

export function watchSystemTheme(): void {
  if (systemWatcherAttached) return;
  systemWatcherAttached = true;
  try {
    const media = window.matchMedia(DARK_QUERY);
    media.addEventListener('change', () => {
      // 只有"跟随系统"才响应。选了固定浅/暗的用户，不该被系统设置改掉。
      if (readThemePreference() !== 'system') return;
      applyTheme(resolveTheme('system'));
    });
  } catch {
    // 没有 matchMedia：固定主题照常工作，只是失去"跟随"能力。
  }
}