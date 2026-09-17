import React, { createContext, useContext, useState, useEffect, useCallback, ReactNode } from 'react';
import { FavoriteItem, FavoriteMark } from '../types/favorite';
import { ipcService } from '../services/ipc';
import { useAppStore } from './useAppStore';

interface FavoritesContextType {
  /** 全部收藏（不含 mark 筛选），按更新时间倒序。 */
  favorites: FavoriteItem[];
  /** seriesId → mark 快查表，供详情页 / 卡片判断当前收藏状态。 */
  markBySeriesId: Map<string, FavoriteMark>;
  loadFavorites: () => Promise<void>;
  /** 设置收藏状态；seriesId 已有其他状态时覆盖。mark 为 null 表示取消收藏。 */
  setMark: (seriesId: string, title: string, cover: string, mark: FavoriteMark | null, channel?: string | null) => Promise<void>;
}

const FavoritesContext = createContext<FavoritesContextType | null>(null);

export const FavoritesProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const [favorites, setFavorites] = useState<FavoriteItem[]>([]);
  const { showToast } = useAppStore();

  const loadFavorites = useCallback(async () => {
    try {
      setFavorites(await ipcService.favorites.list());
    } catch (error) {
      console.warn('[favorites] 收藏列表加载失败', error);
    }
  }, []);

  useEffect(() => {
    void loadFavorites();
  }, [loadFavorites]);

  const setMark = useCallback(async (
    seriesId: string,
    title: string,
    cover: string,
    mark: FavoriteMark | null,
    channel?: string | null,
  ) => {
    if (!mark) {
      // 取消收藏不删观看历史：两者本来就是独立的记录。
      try {
        await ipcService.favorites.remove(seriesId);
      } finally {
        setFavorites(prev => prev.filter(item => item.seriesId !== seriesId));
      }
      showToast('已取消收藏', 'info');
      return;
    }
    const item: FavoriteItem = {
      seriesId,
      title,
      cover,
      mark,
      channel: channel ?? null,
      updatedAt: Date.now(),
    };
    try {
      await ipcService.favorites.save(item);
    } finally {
      setFavorites(prev => [
        item,
        ...prev.filter(existing => existing.seriesId !== seriesId),
      ]);
    }
  }, [showToast]);

  const markBySeriesId = new Map(favorites.map(item => [item.seriesId, item.mark]));

  return (
    <FavoritesContext.Provider
      value={{
        favorites,
        markBySeriesId,
        loadFavorites,
        setMark,
      }}
    >
      {children}
    </FavoritesContext.Provider>
  );
};

export function useFavorites() {
  const ctx = useContext(FavoritesContext);
  if (!ctx) throw new Error('useFavorites must be used within FavoritesProvider');
  return ctx;
}
