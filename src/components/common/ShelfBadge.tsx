import React from 'react';
import type { LucideIcon } from 'lucide-react';

/**
 * 货架标题徽章：渐变圆角方块 + 白色图标。
 *
 * 与「热度排行榜」标题前的图标同一形态（用户 2026-11-07 指定这套样式并要求
 * 推广到其它货架标题）。色板按货架语义区分——扫一眼首页左缘就能分清哪栏是哪栏，
 * 与原有的细色标（color bar）叠加使用：色标管"高度对齐"，徽章管"语义识别"。
 */
const TONE_GRADIENTS = {
  rose: 'from-rose-500 to-orange-500',
  blue: 'from-sky-500 to-blue-600',
  violet: 'from-violet-500 to-purple-600',
  amber: 'from-amber-400 to-orange-500',
  teal: 'from-teal-500 to-emerald-500',
  indigo: 'from-indigo-500 to-blue-500',
} as const;

export type ShelfBadgeTone = keyof typeof TONE_GRADIENTS;

export const ShelfBadge: React.FC<{
  icon: LucideIcon;
  tone?: ShelfBadgeTone;
}> = ({ icon: Icon, tone = 'rose' }) => (
  <span
    className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br shadow-sm ${TONE_GRADIENTS[tone]}`}
    aria-hidden="true"
  >
    <Icon className="h-3.5 w-3.5 text-white" strokeWidth={2.5} />
  </span>
);
