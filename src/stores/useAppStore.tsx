import React, { createContext, useContext, useState, useRef, useMemo, useCallback, ReactNode } from 'react';
import type { ChannelType, ShelfKind } from '../types/catalog';

// 分区类型定义在 `types/catalog`（service 层也要用），这里只做转出，让既有的
// `import { ShelfKind } from '../../stores/useAppStore'` 保持有效。
export type { ShelfKind };

export type AppView = 'explore' | 'anime' | 'detail' | 'player' | 'history' | 'favorites' | 'settings' | 'search' | 'shelf';

/** 进入「更多」页时冻结下来的上下文：哪个分区、从哪个频道点进来的。 */
export interface ShelfViewState {
  kind: ShelfKind;
  channel: ChannelType;
}

/** 搜索历史：最多保留这么多条，最近搜索排在最前。 */
const MAX_SEARCH_HISTORY = 12;
const SEARCH_HISTORY_KEY = 'ttv_short_drama_search_history_v1';

function loadSearchHistory(): string[] {
  try {
    const raw = localStorage.getItem(SEARCH_HISTORY_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
      .slice(0, MAX_SEARCH_HISTORY);
  } catch {
    return [];
  }
}

export interface ToastMessage {
  id: string;
  message: string;
  type: 'info' | 'success' | 'warning' | 'error';
}

interface AppContextType {
  currentView: AppView;
  previousView: AppView;
  selectedSeriesId: string | null;
  searchKeyword: string;
  isNavCollapsed: boolean;
  /**
   * 是否处于全屏播放。
   *
   * 这里只描述**原生窗口是否全屏**，不再掺入 DOM 全屏状态。
   *
   * 历史教训：此前同时使用 Tauri 窗口全屏与 element.requestFullscreen()
   * 两套机制，它们各自独立、无法可靠同步，导致两类故障：
   *   1. 窗口确实进了全屏，但 DOM 全屏调用失败（await 之后用户手势已失效），
   *      视频仍被挤在标题栏下方的应用壳里 —— 表现为"全屏后视频不放大"；
   *   2. Esc 由 Chromium 处理退出 DOM 全屏，状态随之置为 false，
   *      但原生窗口仍停在全屏 —— 表现为"退出全屏后整个程序还是全屏"。
   *
   * 现在只用原生窗口全屏：窗口真正铺满屏幕，应用自身隐藏标题栏让播放器
   * 占满窗口。单一事实来源，不存在失步。
   */
  isFullscreen: boolean;
  setIsFullscreen: (value: boolean) => void;
  toasts: ToastMessage[];
  /**
   * 「更多」页的进入上下文。为 null 表示当前不在该页（视图仍常驻 DOM，只是 hidden）。
   *
   * 频道必须由**发现页点进来的那一刻**决定并冻结：更多页自己挂的是一份独立的
   * `CatalogProvider`，它不知道发现页的频道状态，事后也读不到（那是另一个
   * Provider 实例）。传参是唯一可靠的传递方式。
   */
  shelfView: ShelfViewState | null;
  openShelf: (kind: ShelfKind, channel: ChannelType) => void;
  navigateTo: (view: AppView, seriesId?: string) => void;
  goBack: () => void;
  setSearchKeyword: (kw: string) => void;
  /** 搜索历史（最近在前），持久化在 localStorage。 */
  searchHistory: string[];
  rememberSearch: (keyword: string) => void;
  removeSearchHistory: (keyword: string) => void;
  clearSearchHistory: () => void;
  toggleNavCollapsed: () => void;
  showToast: (message: string, type?: 'info' | 'success' | 'warning' | 'error') => void;
  removeToast: (id: string) => void;
}

const AppContext = createContext<AppContextType | null>(null);

export const AppProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const [currentView, setCurrentView] = useState<AppView>('explore');
  const [previousView, setPreviousView] = useState<AppView>('explore');
  const [selectedSeriesId, setSelectedSeriesId] = useState<string | null>(null);
  const [searchKeyword, setSearchKeyword] = useState<string>('');
  const [searchHistory, setSearchHistory] = useState<string[]>(loadSearchHistory);
  const [isNavCollapsed, setIsNavCollapsed] = useState<boolean>(false);
  const [isFullscreen, setIsFullscreen] = useState<boolean>(false);
  const [toasts, setToasts] = useState<ToastMessage[]>([]);
  const [shelfView, setShelfView] = useState<ShelfViewState | null>(null);

  /**
   * 所有 action 都用 `useCallback` + ref 读最新 state，而不是直接从闭包里取。
   *
   * 原因很具体：这些函数几乎都被视图里内联的 `onClick` 依赖。只要它们每次渲染换
   * 身份，下游所有 `React.memo` / `useMemo` 就全失效 —— 而本项目里“卡片很多”是常态。
   * 依赖 state 的正确姿势是 state 存 ref、函数读 ref.current。
   */
  const currentViewRef = useRef(currentView);
  currentViewRef.current = currentView;
  const previousViewRef = useRef(previousView);
  previousViewRef.current = previousView;
  const searchHistoryRef = useRef(searchHistory);
  searchHistoryRef.current = searchHistory;

  const navigateTo = useCallback((view: AppView, seriesId?: string) => {
    if (view !== currentViewRef.current) {
      setPreviousView(currentViewRef.current);
    }
    if (seriesId) {
      setSelectedSeriesId(seriesId);
    }
    setCurrentView(view);
  }, []);

  const goBack = useCallback(() => {
    const from = previousViewRef.current || 'explore';
    if (currentViewRef.current === 'player') {
      navigateTo(from === 'player' ? 'explore' : from);
    } else if (currentViewRef.current === 'detail') {
      navigateTo('explore');
    } else {
      navigateTo(from);
    }
  }, [navigateTo]);

  /**
   * 进入某个分区的「更多」页。
   *
   * 与 `navigateTo` 分开是因为它要**同时**带上 kind 与 channel —— 后者是发现页的
   * 瞬时状态，只能在这一刻由调用方交出来。走 `navigateTo('shelf')` 会把这个上下文
   * 丢掉，页面只能拿默认值，用户从漫剧专区点进去却看到短剧列表。
   *
   * `previousView` 只在**首次**离开非 shelf 视图时写入：在「更多」页里连点另一个
   * 分区的入口时，不能把 previousView 覆盖成 'shelf'，否则返回会原地打转。
   */
  const openShelf = useCallback((kind: ShelfKind, channel: ChannelType) => {
    if (currentViewRef.current !== 'shelf') {
      setPreviousView(currentViewRef.current);
    }
    setShelfView({ kind, channel });
    setCurrentView('shelf');
  }, []);

  const persistSearchHistory = useCallback((next: string[]) => {
    setSearchHistory(next);
    try {
      localStorage.setItem(SEARCH_HISTORY_KEY, JSON.stringify(next));
    } catch {
      // 存储配额或隐私模式失败：历史只是便利功能，不该影响搜索本身。
    }
  }, []);

  /** 记一条搜索：去重后置顶，超出上限截断。 */
  const rememberSearch = useCallback((keyword: string) => {
    const trimmed = keyword.trim();
    if (!trimmed) return;
    persistSearchHistory(
      [trimmed, ...searchHistoryRef.current.filter(item => item !== trimmed)].slice(0, MAX_SEARCH_HISTORY),
    );
  }, [persistSearchHistory]);

  const removeSearchHistory = useCallback((keyword: string) => {
    persistSearchHistory(searchHistoryRef.current.filter(item => item !== keyword));
  }, [persistSearchHistory]);

  const clearSearchHistory = useCallback(() => persistSearchHistory([]), [persistSearchHistory]);

  const toggleNavCollapsed = useCallback(() => {
    setIsNavCollapsed(prev => !prev);
  }, []);

  const showToast = useCallback((message: string, type: 'info' | 'success' | 'warning' | 'error' = 'info') => {
    const id = `${Date.now()}-${Math.random().toString(36).substr(2, 4)}`;
    setToasts(prev => [...prev, { id, message, type }]);
    setTimeout(() => {
      setToasts(prev => prev.filter(t => t.id !== id));
    }, 2800);
  }, []);

  const removeToast = useCallback((id: string) => {
    setToasts(prev => prev.filter(t => t.id !== id));
  }, []);

  /**
   * context value 必须 `useMemo`。
   *
   * 这是本次性能修复的核心一行：内联对象字面量每次渲染都是**新引用**，于是 AppProvider
   * 的任何一次 `setState`（切视图、弹个 toast、甚至搜索框敲一个字）都会广播给所有
   * `useAppStore()` 消费者。而卡片列表是本项目最大的渲染面（首页一页 30 张、无限流
   * 后上百张），叠加 App.tsx 把所有视图常驻 DOM（隐藏 ≠ 卸载），一次无关的状态变化
   * 会连带重渲染**隐藏视图里的全部卡片**。
   *
   * `setIsFullscreen` 是 `useState` 的 setter，本身身份稳定，直接放进依赖即可。
   */
  const value = useMemo<AppContextType>(() => ({
    currentView,
    previousView,
    selectedSeriesId,
    searchKeyword,
    isNavCollapsed,
    isFullscreen,
    setIsFullscreen,
    toasts,
    shelfView,
    openShelf,
    navigateTo,
    goBack,
    setSearchKeyword,
    searchHistory,
    rememberSearch,
    removeSearchHistory,
    clearSearchHistory,
    toggleNavCollapsed,
    showToast,
    removeToast,
  }), [
    clearSearchHistory, currentView, goBack, isFullscreen,
    isNavCollapsed, navigateTo, openShelf, previousView, removeSearchHistory, removeToast,
    rememberSearch, searchHistory, searchKeyword, selectedSeriesId, shelfView, showToast,
    toasts, toggleNavCollapsed,
  ]);

  return (
    <AppContext.Provider value={value}>
      {children}
    </AppContext.Provider>
  );
};

export function useAppStore() {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('useAppStore must be used within AppProvider');
  return ctx;
}
