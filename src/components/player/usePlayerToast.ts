import { useCallback, useMemo, useRef, useState } from 'react';
import type { PlayerToastPayload } from './PlayerToast';

/**
 * 播放器中央操作提示的状态管理。
 *
 * ## 为什么要单独抽一个 hook
 *
 * 短剧与动漫两个播放器**共用同一套键位**（见 `useBoostKeys` 的注释），
 * 提示也必须共用：否则同一个空格键，在短剧里会闪「播放」，在动漫里什么都不显示。
 * 把「谁触发、显示什么、什么时候消失」收在这里，两个宿主只负责调用
 * `show({...})` 和渲染 `<PlayerToast>`。
 *
 * ## tick 的作用
 *
 * `payload` 相同不代表不该重新点亮。连按两次空格时：
 *   - 若只比较 payload，React 认为状态没变，不会重渲染 → 提示不会重新计时；
 *   - 用递增的 `tick` 作为 effect 依赖，每次触发都能重新点亮并重置计时器。
 *
 * `tick` 与 `payload` 必须**同时**更新（同一个 setState 里），否则会出现
 * "tick 变了但内容还是上一条"的中间态。
 */
export function usePlayerToast() {
  const [state, setState] = useState<{ payload: PlayerToastPayload | null; tick: number }>({
    payload: null,
    tick: 0,
  });
  const tickRef = useRef(0);

  const show = useCallback((payload: PlayerToastPayload) => {
    tickRef.current += 1;
    setState({ payload, tick: tickRef.current });
  }, []);

  return useMemo(() => ({ toast: state.payload, tick: state.tick, show }), [state, show]);
}

/** 把秒数读成 `1:23` / `1:02:03`。 */
export function formatClock(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const total = Math.floor(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}
