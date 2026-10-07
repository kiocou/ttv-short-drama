import React from 'react';
import { HomeShelf } from './HomeShelf';
import { useShelfFeed } from '../../stores/useShelfFeed';
import type { ChannelType, ShelfKind } from '../../types/catalog';

/** 货架预览展示几条。完整列表在「更多」页。 */
const PREVIEW_COUNT = 6;

interface HomeShelfSectionProps {
  kind: ShelfKind;
  channel: ChannelType;
  title: string;
  subtitle: string;
  accent?: 'rose' | 'blue';
  onMore: () => void;
  onClick: (seriesId: string) => void;
}

/**
 * 首页货架：数据直接来自红果 App 的榜单 / 最新上架。
 *
 * **为什么不再从发现页目录切一段**：切出来的那 6 条与它「更多」页里的内容毫无关系
 * —— 用户点进「更多」看到的完全是另一批剧（用户报告）。现在两者同源：
 * 货架就是「更多」页的第一页前 6 条，「更多」页接着那页的游标往下翻。
 *
 * 副作用之一：缓存是共享的（`useShelfFeed` 里的首页缓存），所以从货架点进
 * 「更多」是**秒开**的，不会再等一次 Python 冷启动。
 *
 * 频道限短剧 / 漫剧：18+ 没有对应的红果口径，那一路由 `ExploreView` 走本机
 * 启用源聚合（见 `shelfFeedSupports`）。
 *
 * 调用方必须传 `key={`${kind}-${channel}`}` —— 换频道要整体重挂，否则会有一帧
 * 显示上一个频道的内容。
 */
export const HomeShelfSection: React.FC<HomeShelfSectionProps> = ({
  kind,
  channel,
  title,
  subtitle,
  accent,
  onMore,
  onClick,
}) => {
  const feed = useShelfFeed(kind, channel);

  return (
    <HomeShelf
      title={title}
      subtitle={subtitle}
      accent={accent}
      items={feed.items.slice(0, PREVIEW_COUNT)}
      loading={feed.isLoading}
      onMore={onMore}
      onClick={onClick}
    />
  );
};
