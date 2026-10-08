import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import { FavoriteItem, FavoriteMark } from '../types/favorite';
import { ipcService } from '../services/ipc';
import { useAppStore } from './useAppStore';

interface FavoritesContextType {
  /** 全部收藏（不含 mark 筛选），按更新时间倒序。 */
  favorites: FavoriteItem[];
  /** seriesId → mark 快查表，供详情页判断当前收藏状态。 */
  markBySeriesId: Map<string, FavoriteMark>;
  loadFavorites: () => Promise<void>;
  /** 设置收藏状态；seriesId 已有其他状态时覆盖。mark 为 null 表示取消收藏。 */
  setMark: (seriesId: string, title: string, cover: string, mark: FavoriteMark | null, channel?: string | null) => Promise<void>;
}

const FavoritesContext = createContext<FavoritesContextType | null>(null);

/**
 * 按 seriesId 的**单条订阅表**。
 *
 * 为什么不让卡片直接订阅整张 `markBySeriesId`：改一处收藏会让 Map 换引用，于是**首页
 * 上百张卡片**全部重渲染，而其中只有一张的状态真的变了。这不是理论开销——卡片列表是本
 * 项目最大的渲染面，而收藏操作在详情页随手就能做。
 *
 * 于是把"谁的收藏变了"这件事在 store 里算清楚，只通知那一张的订阅者。每张卡挂一个
 * listener，改动是 O(变更条数) 而不是 O(卡片总数)。
 *
 * 模块级单例：本应用只有一个 FavoritesProvider（App.tsx 里挂一次）。
 */
const markListeners = new Map<string, Set<() => void>>();
let markSnapshot = new Map<string, FavoriteMark>();

function subscribeMark(seriesId: string, listener: () => void): () => void {
  let listeners = markListeners.get(seriesId);
  if (!listeners) {
    listeners = new Set();
    markListeners.set(seriesId, listeners);
  }
  listeners.add(listener);
  return () => {
    const current = markListeners.get(seriesId);
    if (!current) return;
    current.delete(listener);
    if (current.size === 0) markListeners.delete(seriesId);
  };
}

/** `useSyncExternalStore` 的快照必须是引用稳定的，这里返回的是 Map 里的原始值。 */
function getMarkSnapshot(seriesId: string): FavoriteMark | undefined {
  return markSnapshot.get(seriesId);
}

/**
 * 只订阅**这一部剧**的收藏状态。
 *
 * 收藏变化时只重渲染调用方这一张卡，其余卡片完全不受影响。
 */
export function useFavoriteMark(seriesId: string): FavoriteMark | undefined {
  return useSyncExternalStore(
    listener => subscribeMark(seriesId, listener),
    () => getMarkSnapshot(seriesId),
  );
}

export const FavoritesProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const [favorites, setFavorites] = useState<FavoriteItem[]>([]);
  const { showToast } = useAppStore();

  /**
   * `showToast` 从 App store 来，而 App store 的 context value 会随切视图、弹提示等
   * 变化。用 ref 存住最新实现，把 `setMark` 的身份钉死 —— 否则每次弹个 toast 都会
   * 重建 setMark，进而重建收藏 context，把广播再传一遍。
   */
  const showToastRef = useRef(showToast);
  showToastRef.current = showToast;

  const loadFavorites = useCallback(async () => {
    try {
      setFavorites(await ipcService.favorites.list());
    } catch (error) {
      console.warn('[favorites] 收藏列表加载失败', error);
    }
  }, []);

  useEffect(() => {
    // 冷启动窗口里让路：设置/目录才是首屏必需的两条 IPC，而收藏列表要等用户
    // 真的进收藏页才有用。挂到空闲回调上，既不与首屏抢窗口，也不改变语义——
    // 用户点进收藏页时它几乎总是已经加载好了（空闲回调通常在几百毫秒内就跑到）。
    //
    // 兜底用 setTimeout：`requestIdleCallback` 在部分 WebView 版本里不存在，
    // 而这里绝不能因为缺一个 API 就不加载（收藏页会永远空着）。
    const schedule: (cb: () => void) => void =
      typeof window.requestIdleCallback === 'function'
        ? cb => window.requestIdleCallback(() => cb())
        : cb => window.setTimeout(cb, 400);
    let cancelled = false;
    schedule(() => {
      if (!cancelled) void loadFavorites();
    });
    return () => {
      cancelled = true;
    };
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
      showToastRef.current('已取消收藏', 'info');
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
  }, []);

/**
   * 由 `favorites` 派生快查表。必须 `useMemo`：否则每次渲染都换引用，等于告诉所有
   * 消费者"收藏全变了"。
   */
  const markBySeriesId = useMemo(
    () => new Map(favorites.map(item => [item.seriesId, item.mark])),
    [favorites],
  );

  /**
   * **逐条**通知订阅者：只叫醒 mark 真的变了的那几个 id。
   *
   * 新增一条收藏不该把其余上百张卡叫醒——这正是引入 `useFavoriteMark` 的意义。
   *
   * 刻意放在 effect 里而不是 `useMemo` 里：`useSyncExternalStore` 的 listener 约定是
   * 在渲染**之外**被调用，在渲染期间同步调用会触发 React 的
   * "Cannot update a component while rendering a different component" 警告。
   */
  useEffect(() => {
    const changed = new Set<string>();
    for (const [seriesId, mark] of markBySeriesId) {
      if (markSnapshot.get(seriesId) !== mark) changed.add(seriesId);
    }
    for (const seriesId of markSnapshot.keys()) {
      if (!markBySeriesId.has(seriesId)) changed.add(seriesId);
    }
    markSnapshot = markBySeriesId;
    if (changed.size === 0) return;
    for (const seriesId of changed) {
      const listeners = markListeners.get(seriesId);
      if (!listeners) continue;
      // 复制一份再遍历：回调里若有订阅/退订会改动这个 Set。
      for (const listener of [...listeners]) listener();
    }
  }, [markBySeriesId]);

  /**
   * context value 必须 memo：内联对象字面量每次渲染都是新引用，会让所有
   * `useFavorites()` 消费者（详情页、收藏页、以及**每一张卡片**）跟着重渲染。
   */
  const value = useMemo<FavoritesContextType>(() => ({
    favorites,
    markBySeriesId,
    loadFavorites,
    setMark,
  }), [favorites, loadFavorites, markBySeriesId, setMark]);

  return (
    <FavoritesContext.Provider value={value}>
      {children}
    </FavoritesContext.Provider>
  );
};

export function useFavorites() {
  const ctx = useContext(FavoritesContext);
  if (!ctx) throw new Error('useFavorites must be used within FavoritesProvider');
  return ctx;
}
