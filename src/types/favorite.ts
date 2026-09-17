/**
 * 追剧收藏条目。
 *
 * mark 三态：want（想看）/ watching（在看）/ done（已看）。
 * 收藏与观看历史相互独立：取消收藏不删历史，取消历史不动收藏。
 */
export interface FavoriteItem {
  seriesId: string;
  title: string;
  cover: string;
  mark: 'want' | 'watching' | 'done';
  channel: string | null;
  updatedAt: number;
}

export type FavoriteMark = FavoriteItem['mark'];

/** 收藏状态 → 展示文案。 */
export const FAVORITE_MARK_LABEL: Record<FavoriteMark, string> = {
  want: '想看',
  watching: '在看',
  done: '已看',
};
