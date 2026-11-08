import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { UserSettings } from '../types/settings';
import { ipcService, DEFAULT_SETTINGS } from '../services/ipc';
import { tracePlayback } from '../services/playbackTrace';

interface SettingsContextType {
  settings: UserSettings;
  updateSettings: (partial: Partial<UserSettings>) => void;
  clearCache: () => Promise<number>;
  /** 真实缓存占用（字节）与文件数，来自后端实际扫描，而非设置里的估算值。 */
  cacheUsage: { files: number; bytes: number };
  refreshCacheUsage: () => Promise<void>;
}

const SettingsContext = createContext<SettingsContextType | null>(null);

/** 数值设置的归一：非法/缺失回落 `fallback`，合法值夹进 `[min, max]`。 */
function normalizeRange(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

/** 弹幕颜色归一：只认 #RGB / #RRGGBB，其余（含 undefined）回落白色。 */
function normalizeHexColor(value: unknown, fallback = '#FFFFFF'): string {
  if (typeof value !== 'string') return fallback;
  return /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(value.trim()) ? value.trim() : fallback;
}

export const SettingsProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const [settings, setSettings] = useState<UserSettings>(DEFAULT_SETTINGS);
  const [cacheUsage, setCacheUsage] = useState<{ files: number; bytes: number }>({ files: 0, bytes: 0 });

  useEffect(() => {
    let active = true;
    ipcService.settings.get()
      .then(saved => {
        // 与默认值合并：旧设置记录可能没有新增字段（Web 模式的 localStorage
        // 与旧版后端都算），缺字段时回落到默认而不是 undefined。
        // 0.2.x 把 playbackCacheMb 归零表示"不统计读数"，不是"缓存上限为 0"。
        // 迁移成新的 1GB 默认值，否则旧设置会让自动清理永久清空所有缓存。
        if (active) setSettings({
          ...DEFAULT_SETTINGS,
          ...saved,
          playbackCacheMb: saved.playbackCacheMb > 0 ? saved.playbackCacheMb : DEFAULT_SETTINGS.playbackCacheMb,
          // 旧记录（localStorage / 旧版后端）没有 vsrEnabled 字段：展开后是
          // undefined，若原样透传，设置页的开关与 Rust 侧的默认值会各说各话。
          // 与 launchSound 同样的 `!== false` 判定——默认开，只有显式 false 才关。
          vsrEnabled: saved.vsrEnabled !== false,
          // 弹幕与 VSR 同一套归一：旧记录没有这个字段，默认开。
          danmakuEnabled: saved.danmakuEnabled !== false,
          frameInterpolationEnabled: saved.frameInterpolationEnabled === true,
          frameInterpolationMultiplier: [2, 3, 4, 5].includes(saved.frameInterpolationMultiplier)
            ? saved.frameInterpolationMultiplier as 2 | 3 | 4 | 5
            : 2,
          // 弹幕观感（2026-11-07 新增）：旧记录缺字段时展开后是 undefined，
          // 滑条会渲染成空值——逐项归一到默认，与 Rust 侧 serde default 对齐。
          // 速度档与描边类型同时做非法值回落，防止手改过的记录把面板卡死。
          danmakuArea: normalizeRange(saved.danmakuArea, 25, 25, 100),
          danmakuOpacity: normalizeRange(saved.danmakuOpacity, 100, 10, 100),
          danmakuFontScale: normalizeRange(saved.danmakuFontScale, 100, 50, 200),
          danmakuSpeed: [0, 1, 2].includes(saved.danmakuSpeed) ? saved.danmakuSpeed : 1,
          danmakuFont: typeof saved.danmakuFont === 'string' && saved.danmakuFont
            ? saved.danmakuFont
            : 'Microsoft YaHei',
          danmakuColor: normalizeHexColor(saved.danmakuColor),
          danmakuBold: saved.danmakuBold !== false,
          danmakuStroke: ['heavy', 'outline', 'shadow'].includes(saved.danmakuStroke)
            ? saved.danmakuStroke
            : 'heavy',
          // 代理模式同样要归一：旧记录没有这个字段（展开后是 undefined），
          // 直接透传会让设置页的分段控件没有任何一项被选中 —— 看起来像坏了。
          // 未知值也一并回落到 auto，与 Rust 侧 `normalize_proxy_mode` 一致。
          proxyMode: saved.proxyMode === 'direct' || saved.proxyMode === 'proxy'
            ? saved.proxyMode
            : 'auto',
        });
      })
      .catch(error => console.warn('Settings load failed:', error));
    return () => { active = false; };
  }, []);

  // 真实占用：此前界面显示的是 settings.catalogCacheMb + playbackCacheMb，
  // 而这两个字段被后端强制归零（"不做字节级统计，报 0 而不是编造数字"），
  // 于是设置页永远显示 0.0 MB，与实际占用完全脱节。现在改为直接向后端查询
  // 真实扫描结果。
  const refreshCacheUsage = useCallback(async (): Promise<void> => {
    try {
      setCacheUsage(await ipcService.settings.cacheUsage());
    } catch {
      // 查询失败不影响设置页其他功能。
    }
  }, []);

  const updateSettings = useCallback((partial: Partial<UserSettings>) => {
    setSettings(prev => {
      const next = { ...prev, ...partial };
      void ipcService.settings.save(next).catch(error => console.warn('Settings save failed:', error));
      return next;
    });
  }, []);

  /**
   * 运行中切换 VSR 开关要留痕。
   *
   * 启动时日志里只有一行「VSR 开关（当前值）：开」，用户中途去设置页改开关时
   * 什么都不写。于是排查「开关好像没用」时，无法区分到底是"开关没生效"还是
   * "开关生效了、但链路本身不对"。这里在值真正变化的那一刻补一行，
   * 日志里从此能看到切换时点，前后两次 resolve 的产物差异就能直接对上。
   *
   * 用 ref 记住上一个值而不是直接把 settings 列进依赖：这里要做的是"变化时上报"，
   * 挂载时不该重复上报（启动那行已由 Rust 侧写过）。
   */
  const lastVsrRef = useRef<boolean | null>(null);
  useEffect(() => {
    const value = settings.vsrEnabled !== false;
    if (lastVsrRef.current === null) {
      lastVsrRef.current = value;
      return;
    }
    if (lastVsrRef.current === value) return;
    lastVsrRef.current = value;
    tracePlayback(`VSR 开关切换为：${value ? '开（保留 VSR 增强链路）' : '关（回退到引入 VSR 之前的播放链路）'}`);
  }, [settings.vsrEnabled]);

  const clearCache = useCallback(async (): Promise<number> => {
    const res = await ipcService.settings.clearCache();
    await refreshCacheUsage();
    return res.freedMb;
  }, [refreshCacheUsage]);

  /**
   * context value 必须 memo：`settings` 被 `useCatalogStore` / `usePlaybackStore` /
   * `useAnimePlayerStore` 订阅，其中任意一个因上层重渲染而重渲染时，不 memo 的内联对象
   * 会把广播一路传到发现页的每张卡片。
   */
  const value = useMemo<SettingsContextType>(() => ({
    settings,
    updateSettings,
    clearCache,
    cacheUsage,
    refreshCacheUsage,
  }), [cacheUsage, clearCache, refreshCacheUsage, settings, updateSettings]);

  return (
    <SettingsContext.Provider value={value}>
      {children}
    </SettingsContext.Provider>
  );
};

export function useSettingsStore() {
  const ctx = useContext(SettingsContext);
  if (!ctx) throw new Error('useSettingsStore must be used within SettingsProvider');
  return ctx;
}
