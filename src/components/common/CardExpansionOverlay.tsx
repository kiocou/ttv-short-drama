import React, { useEffect, useState } from 'react';
import { useAppStore } from '../../stores/useAppStore';
import { CoverImage } from './CoverImage';

export const CardExpansionOverlay: React.FC = () => {
  const { cardTransition, clearCardTransition, navigateTo, isNavCollapsed } = useAppStore();
  const [phase, setPhase] = useState<'initial' | 'expanding' | 'fading'>('initial');

  useEffect(() => {
    if (!cardTransition) {
      setPhase('initial');
      return;
    }

    // 第一阶段：在初始卡片位置渲染
    setPhase('initial');

    // 第二阶段：在下一帧立即激活动画向视频详情页顶部大画幅铺满展开
    const expandTimer = requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        setPhase('expanding');
      });
    });

    // 第三阶段：在展开到 240ms 时切换路由至详情页，形成平滑视觉衔接
    const navTimer = setTimeout(() => {
      navigateTo('detail', cardTransition.seriesId);
    }, 240);

    // 第四阶段：淡出并清理转场状态
    const fadeTimer = setTimeout(() => {
      setPhase('fading');
    }, 360);

    const cleanupTimer = setTimeout(() => {
      clearCardTransition();
      setPhase('initial');
    }, 480);

    return () => {
      cancelAnimationFrame(expandTimer);
      clearTimeout(navTimer);
      clearTimeout(fadeTimer);
      clearTimeout(cleanupTimer);
    };
  }, [cardTransition, navigateTo, clearCardTransition]);

  if (!cardTransition) return null;

  const { rect, cover, title } = cardTransition;
  const navWidth = isNavCollapsed ? 64 : 224;

  const isExpanded = phase === 'expanding' || phase === 'fading';
  const isFading = phase === 'fading';

  // 目标展开尺寸：对齐详情页顶部高规格 Cinematic Hero Banner (高 380px)
  const targetStyle: React.CSSProperties = isExpanded
    ? {
        position: 'fixed',
        top: 40, // 标题栏高度
        left: navWidth,
        width: `calc(100vw - ${navWidth}px)`,
        height: 380,
        borderRadius: '0px',
        opacity: isFading ? 0 : 1,
        transition: 'all 350ms cubic-bezier(0.16, 1, 0.3, 1), opacity 140ms ease-out',
      }
    : {
        position: 'fixed',
        top: rect.top,
        left: rect.left,
        width: rect.width,
        height: rect.height,
        borderRadius: '16px',
        opacity: 1,
        transition: 'none',
      };

  return (
    <div
      style={targetStyle}
      className="z-50 overflow-hidden shadow-fluent-hud pointer-events-none select-none bg-slate-900"
    >
      {/* 展开的背景磨砂大图 */}
      <img
        src={cover}
        alt={title}
        className={`w-full h-full object-cover transition-all duration-500 ease-out ${
          isExpanded ? 'scale-110 opacity-40 blur-md' : 'scale-100 opacity-90'
        }`}
      />

      {/* 渐变遮罩：由卡片暗角平滑渐变到详情页画卷底层 */}
      <div
        className={`absolute inset-0 transition-opacity duration-350 ${
          isExpanded
            ? 'bg-gradient-to-t from-[#f3f5f8] via-[#f3f5f8]/60 to-black/40 opacity-100'
            : 'bg-gradient-to-t from-black/70 via-transparent to-transparent opacity-90'
        }`}
      />

      {/* 展开过程中的中心海报视差定位，与详情页 Hero Poster 精准重合 */}
      {isExpanded && (
        <div className="absolute inset-0 flex items-start max-w-6xl mx-auto px-8 gap-8 pt-14 animate-fade-in pointer-events-none">
          <div className="relative w-48 sm:w-56 aspect-[3/4] rounded-2xl overflow-hidden shadow-fluent-hud border-2 border-white flex-shrink-0 bg-white">
            <CoverImage src={cover} title={title} placeholderTextClassName="text-5xl" loading="eager" />
          </div>
          <div className="flex flex-col gap-3 pt-1">
            <h1 className="text-2xl sm:text-3xl font-black text-slate-900 tracking-tight leading-tight">
              {title}
            </h1>
            <div className="w-28 h-3 rounded bg-blue-600/30 shimmer-loading" />
          </div>
        </div>
      )}
    </div>
  );
};
