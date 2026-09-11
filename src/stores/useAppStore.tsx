import React, { createContext, useContext, useState, ReactNode } from 'react';

export type AppView = 'explore' | 'detail' | 'player' | 'history' | 'settings';

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
  const [isNavCollapsed, setIsNavCollapsed] = useState<boolean>(false);
  const [isFullscreen, setIsFullscreen] = useState<boolean>(false);
  const [toasts, setToasts] = useState<ToastMessage[]>([]);
  const [cardTransition, setCardTransition] = useState<CardTransitionData | null>(null);

  const navigateTo = (view: AppView, seriesId?: string) => {
    if (view !== currentView) {
      setPreviousView(currentView);
    }
    if (seriesId) {
      setSelectedSeriesId(seriesId);
    }
    setCurrentView(view);
  };

  const triggerCardTransition = (data: CardTransitionData) => {
    setCardTransition(data);
    if (data.seriesId) {
      setSelectedSeriesId(data.seriesId);
    }
  };

  const clearCardTransition = () => {
    setCardTransition(null);
  };

  const goBack = () => {
    if (currentView === 'player') {
      navigateTo(previousView === 'player' ? 'explore' : previousView);
    } else if (currentView === 'detail') {
      navigateTo('explore');
    } else {
      navigateTo(previousView || 'explore');
    }
  };

  const toggleNavCollapsed = () => {
    setIsNavCollapsed(prev => !prev);
  };

  const showToast = (message: string, type: 'info' | 'success' | 'warning' | 'error' = 'info') => {
    const id = `${Date.now()}-${Math.random().toString(36).substr(2, 4)}`;
    setToasts(prev => [...prev, { id, message, type }]);
    setTimeout(() => {
      setToasts(prev => prev.filter(t => t.id !== id));
    }, 2800);
  };

  const removeToast = (id: string) => {
    setToasts(prev => prev.filter(t => t.id !== id));
  };

  return (
    <AppContext.Provider
      value={{
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
        toggleNavCollapsed,
        showToast,
        removeToast,
      }}
    >
      {children}
    </AppContext.Provider>
  );
};

export function useAppStore() {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('useAppStore must be used within AppProvider');
  return ctx;
}
