import React, { createContext, useContext, useState, useRef, useMemo, useCallback, ReactNode } from 'react';

export type AppView = 'explore' | 'anime' | 'detail' | 'player' | 'history' | 'favorites' | 'settings' | 'search';

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

export interface CardTransitionData {
  seriesId: string;
  cover: string;
  title: string;
  rect: {
    top: number;
    left: number;
    width: number;
    height: number;
  };
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
  cardTransition: CardTransitionData | null;
  navigateTo: (view: AppView, seriesId?: string) => void;
  triggerCardTransition: (data: CardTransitionData) => void;
  clearCardTransition: () => void;
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
  const [cardTransition, setCardTransition] = useState<CardTransitionData | null>(null);

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

  const triggerCardTransition = useCallback((data: CardTransitionData) => {
    setCardTransition(data);
    if (data.seriesId) {
      setSelectedSeriesId(data.seriesId);
    }
  }, []);

  const clearCardTransition = useCallback(() => {
    setCardTransition(null);
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
    cardTransition,
    navigateTo,
    triggerCardTransition,
    clearCardTransition,
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
    cardTransition, clearCardTransition, clearSearchHistory, currentView, goBack, isFullscreen,
    isNavCollapsed, navigateTo, previousView, removeSearchHistory, removeToast, rememberSearch,
    searchHistory, searchKeyword, selectedSeriesId, showToast, toasts, toggleNavCollapsed,
    triggerCardTransition,
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
