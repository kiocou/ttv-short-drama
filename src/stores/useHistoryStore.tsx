import React, { createContext, useContext, useState, useEffect, useCallback, ReactNode } from 'react';
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
    loadHistory();
  }, [loadHistory]);

  const removeRecord = async (seriesId: string) => {
    setRecords(prev => prev.filter(r => r.seriesId !== seriesId));
    await ipcService.history.remove(seriesId);
  };

  const clearHistory = async () => {
    setRecords([]);
    await ipcService.history.clear();
  };

  return (
    <HistoryContext.Provider
      value={{
        records,
        isLoading,
        loadHistory,
        removeRecord,
        clearHistory,
      }}
    >
      {children}
    </HistoryContext.Provider>
  );
};

export function useHistoryStore() {
  const ctx = useContext(HistoryContext);
  if (!ctx) throw new Error('useHistoryStore must be used within HistoryProvider');
  return ctx;
}
