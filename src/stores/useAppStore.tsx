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
