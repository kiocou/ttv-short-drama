import React from 'react';
import { MicaCard } from './MicaCard';

/**
 * 网格卡（`SeriesCard`）的骨架：外壳 / 比例 / 内边距与真实卡片逐项对齐，骨架换成
 * 真实卡片时版面不跳，读起来是"同一张卡把内容填进来"。
 *
 * 灰块统一用 `.shimmer-loading`（内凹 + 扫光）：凸出的白色卡壳配凹进去的灰块，
 * 与卡片本身、列表骨架是同一套层次语汇。此前骨架是"裸灰块直接铺在页面上"，
 * 没有卡壳，和旁边浮起来的真实卡片是两种东西（用户报告：加载态没融进去）。
 */
export const SeriesCardSkeleton: React.FC = () => (
  <MicaCard className="flex flex-col rounded-2xl">
    <div className="w-full aspect-[3/4] rounded-t-2xl shimmer-loading" />
    <div className="p-3 flex flex-col gap-2">
      <div className="h-4 w-3/4 rounded shimmer-loading" />
      <div className="h-3.5 w-1/2 rounded shimmer-loading" />
    </div>
  </MicaCard>
);

export default SeriesCardSkeleton;
