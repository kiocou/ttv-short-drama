import React, { ReactNode } from 'react';

interface MicaCardProps {
  children: ReactNode;
  className?: string;
  hoverable?: boolean;
  onClick?: (e: React.MouseEvent<HTMLDivElement>) => void;
  onMouseEnter?: (e: React.MouseEvent<HTMLDivElement>) => void;
  onFocus?: (e: React.FocusEvent<HTMLDivElement>) => void;
  tabIndex?: number;
  style?: React.CSSProperties;
}

export const MicaCard: React.FC<MicaCardProps> = ({
  children,
  className = '',
  hoverable = false,
  onClick,
  onMouseEnter,
  onFocus,
  tabIndex,
  style,
}) => {
  return (
    <div
      onClick={onClick}
      onMouseEnter={onMouseEnter}
      onFocus={onFocus}
      tabIndex={tabIndex}
      style={style}
      // 这里刻意不用 backdrop-filter：卡片是**成批重复**的高频元素，首屏就有
      // 24 张、滚动加载后可达上百张。每个 backdrop-filter 元素都会强制合成器
      // 单独截取并模糊其背后内容，实测 79 个模糊元素时滚动 p95 帧耗时 164.8ms、
      // 168 帧里 66 帧超过 33ms；禁用后 p95 降到 10.5ms、376 帧里仅 5 帧超标。
      // 卡片背后是本应用自己的浅色渐变（mica-backdrop），模糊一个平滑渐变
      // 在视觉上与纯色几乎无差别，因此用略高的白色不透明度等价替代。
      className={`relative rounded-xl border border-white/80 bg-white/88 shadow-fluent overflow-hidden transition-all duration-300 ease-[cubic-bezier(0.16,1,0.3,1)] ${
        hoverable
          // **不加 `will-change-transform`**：它会为每个元素强制分配一个合成层，而卡片
          // 是成批重复的高频元素（首屏 24 张、无限流后上百张）——上百个合成层的显存
          // 与合成开销远大于它想避免的那次重绘。`transform` 本身已经足够便宜，hover 的
          // 位移与缩放交给合成器按需临时提升即可（与上面 backdrop-filter 的实测同源）。
          ? 'cursor-pointer hover:bg-white/95 hover:-translate-y-1.5 hover:shadow-fluent-lg hover:border-white hover:ring-1 hover:ring-blue-400/20 active:scale-[0.98] active:translate-y-0 active:shadow-fluent active:duration-100'
          : ''
      } ${className}`}
    >
      {children}
    </div>
  );
};
