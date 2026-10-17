/**
 * 主题（浅色 / 暗色）。
 *
 * 只碰 <html data-theme> 与 localStorage 两处，**不经过 UserSettings**：
 * `settings_save` 的入参是 Rust 侧反序列化出来的 UserSettings，加字段要前后端
 * 同时改（见 types/settings.ts 的 hardwareAcceleration 注释），而主题纯属前端
 * 表现，存 localStorage 就够了。
 *
 * dark.css 的全部规则都挂在 `html[data-theme='dark']` 上，所以切换只改这一个属性。
 */
export type ThemeMode = 'light' | 'dark';

const STORAGE_KEY = 'ttv:theme';

export function readTheme(): ThemeMode {
  try {
    return localStorage.getItem(STORAGE_KEY) === 'dark' ? 'dark' : 'light';
  } catch {
    return 'light';
  }
}

export function applyTheme(mode: ThemeMode): void {
  document.documentElement.dataset.theme = mode;
}

export function saveTheme(mode: ThemeMode): void {
  try {
    localStorage.setItem(STORAGE_KEY, mode);
  } catch {
    // 存不下只影响"下次启动记得住"，本次切换照常生效。
  }
  applyTheme(mode);
}
