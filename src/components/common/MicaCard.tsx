import React, { ReactNode } from 'react';

interface MicaCardProps {
  children: ReactNode;
  className?: string;
  hoverable?: boolean;
  onClick?: (e: React.MouseEvent<HTMLDivElement>) => void;
  style?: React.CSSProperties;
}

export const MicaCard: React.FC<MicaCardProps> = ({
  children,
  className = '',
  hoverable = false,
  onClick,
  style,
}) => {
  return (
    <div
      onClick={onClick}
      style={style}
      // 这里刻意不用 backdrop-filter：卡片是**成批重复**的高频元素，首屏就有
      // 24 张、滚动加载后可达上百张。每个 backdrop-filter 元素都会强制合成器
      // 单独截取并模糊其背后内容，实测 79 个模糊元素时滚动 p95 帧耗时 164.8ms、
      // 168 帧里 66 帧超过 33ms；禁用后 p95 降到 10.5ms、376 帧里仅 5 帧超标。
      // 卡片背后是本应用自己的浅色渐变（mica-backdrop），模糊一个平滑渐变
      // 在视觉上与纯色几乎无差别，因此用略高的白色不透明度等价替代。
      className={`relative rounded-xl border border-white/80 bg-white/88 shadow-fluent overflow-hidden transition-all duration-300 ease-[cubic-bezier(0.16,1,0.3,1)] ${
        hoverable
          ? 'cursor-pointer hover:bg-white/95 hover:-translate-y-1.5 hover:shadow-fluent-lg hover:border-white hover:ring-1 hover:ring-blue-400/20 active:scale-[0.98] active:translate-y-0 active:shadow-fluent active:duration-100 will-change-transform'
          : ''
      } ${className}`}
    >
      {children}
    </div>
  );
};
