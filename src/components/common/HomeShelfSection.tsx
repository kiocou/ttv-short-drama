import React from 'react';
import type { LucideIcon } from 'lucide-react';
import { HomeShelf } from './HomeShelf';
import { useShelfFeed } from '../../stores/useShelfFeed';
import type { ChannelType, ShelfKind, SeriesItem } from '../../types/catalog';

/**
 * 货架预览展示几条。完整列表在「更多」页。
 *
 * 从 6 提到 12：货架改成「平铺 + 只占一行 + 横向滚动」之后，一屏只露 5–6 张，
 * 剩下 6 张正好是"继续往右滑"的那一段。继续只给 6 条的话，横滚轴基本没有
 * 可滚的余量，用户会以为那一栏就这么点东西。
 *
 * 12 约等于后端一页（10–18 条）的量，不再多取：翻页要另一次 Python 冷启动，
 * 首屏不该为"可能没人右滑"的那一段付这笔钱。
 */
const PREVIEW_COUNT = 12;

interface HomeShelfSectionProps {
  kind: ShelfKind;
  channel: ChannelType;
  title: string;
  subtitle: string;
  accent?: 'rose' | 'blue';
  /** 标题徽章图标，透传给 `HomeShelf`（见那边注释）。 */
  icon?: LucideIcon;
  iconTone?: 'rose' | 'blue' | 'violet' | 'amber' | 'teal' | 'indigo';
  onMore: () => void;
  onClick: (seriesId: string) => void;
  /**
   * 排布形态，透传给 `HomeShelf`。
   *
   * 默认 `row`：首页这两栏是"热播榜 / 最新上架"，平铺成一行卡片、其余横向滚动，
   * 顺序即名次。动漫专区等仍用网格的地方显式传 `grid`。
   */
  variant?: 'grid' | 'row' | 'rank';
  metricOf?: (series: SeriesItem, index: number) => string | undefined;
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
  icon,
  iconTone,
  onMore,
  onClick,
  variant = 'row',
  metricOf,
}) => {
  const feed = useShelfFeed(kind, channel);

  return (
    <HomeShelf
      title={title}
      subtitle={subtitle}
      accent={accent}
      icon={icon}
      iconTone={iconTone}
      variant={variant}
      metricOf={metricOf}
      items={feed.items.slice(0, PREVIEW_COUNT)}
      loading={feed.isLoading}
      onMore={onMore}
      onClick={onClick}
    />
  );
};
