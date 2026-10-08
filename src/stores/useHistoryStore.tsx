import React, { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { WatchHistoryItem } from '../types/history';
import { ipcService } from '../services/ipc';

interface HistoryContextType {
  records: WatchHistoryItem[];
  isLoading: boolean;
  loadHistory: () => Promise<void>;
  removeRecord: (seriesId: string) => Promise<void>;
  clearHistory: () => Promise<void>;
}

const HistoryContext = createContext<HistoryContextType | null>(null);

export const HistoryProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const [records, setRecords] = useState<WatchHistoryItem[]>([]);
  const [isLoading, setIsLoading] = useState<boolean>(true);

  const loadHistory = useCallback(async () => {
    setIsLoading(true);
    try {
      const list = await ipcService.history.list();
      setRecords(list);
    } catch (err) {
      console.warn('History load failed:', err);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    // 与收藏同理：历史列表不急在冷启动这一刻。挂到空闲回调，让设置与目录先走。
    // 进观看历史页时 HistoryView 自己还会按 `currentView === 'history'` 再拉一次，
    // 所以即使这里被推迟得很晚，用户看到的也不会有陈旧数据。
    const schedule: (cb: () => void) => void =
      typeof window.requestIdleCallback === 'function'
        ? cb => window.requestIdleCallback(() => cb())
        : cb => window.setTimeout(cb, 400);
    let cancelled = false;
    schedule(() => {
      if (!cancelled) void loadHistory();
    });
    return () => {
      cancelled = true;
    };
  }, [loadHistory]);

  const removeRecord = useCallback(async (seriesId: string) => {
    setRecords(prev => prev.filter(r => r.seriesId !== seriesId));
    await ipcService.history.remove(seriesId);
  }, []);

  const clearHistory = useCallback(async () => {
    setRecords([]);
    await ipcService.history.clear();
  }, []);

  /**
   * context value 必须 memo：内联对象字面量每次渲染都是新引用，`useHistoryStore()` 的
   * 所有消费者（历史页、播放落盘后的小窗回流）会跟着 provider 的任意重渲染一起重渲染。
   */
  const value = useMemo<HistoryContextType>(() => ({
    records,
    isLoading,
    loadHistory,
    removeRecord,
    clearHistory,
  }), [clearHistory, isLoading, loadHistory, records, removeRecord]);

  return (
    <HistoryContext.Provider value={value}>
      {children}
    </HistoryContext.Provider>
  );
};

export function useHistoryStore() {
  const ctx = useContext(HistoryContext);
  if (!ctx) throw new Error('useHistoryStore must be used within HistoryProvider');
  return ctx;
}
