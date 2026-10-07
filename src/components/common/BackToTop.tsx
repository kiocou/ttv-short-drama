import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowUp } from 'lucide-react';

interface BackToTopProps {
  /** 监听的滚动容器。这三个视图各有一层自己的 `overflow-y-auto`，不是 window 滚动。 */
  targetRef: React.RefObject<HTMLElement | null>;
  /**
   * 出现阈值（px）。默认 320 —— 大约滚过三分之一屏才出现。
   * 一有滚动就弹出会让人以为界面在抖，阈值就是用来压掉这种噪音的。
   */
  threshold?: number;
}

/** 进度环几何。半径取 19.5 是为了让 2px 描边完全落在 44×44 按钮的内侧，不压到边框。 */
const RING_RADIUS = 19.5;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

/**
 * 回到顶部。
 *
 * ## 定位：`fixed`，与宿主布局彻底解耦
 *
 * 挂在**各个视图自己的滚动容器**里（`ExploreView` / `AnimeView` / `ShelfMoreView` /
 * `FavoritesView` / `HistoryView` / `SearchView`），靠 `targetRef` 监听那个容器的
 * 滚动量，而不是监听 window —— 这几个页面各自是 `overflow-y-auto`，window 根本不滚。
 *
 * 按钮本身用 `position: fixed`（理由见下面的 JSX 注释）：位置只跟内容区有关，
 * 与宿主是 `p-5` 全宽还是 `max-w-5xl mx-auto` 居中毫无关系，也不占布局高度。
 * 换一个宿主只需要给它一个 `targetRef`，别的都不用管。
 *
 * ## 性能：进度环不走 React state
 *
 * 滚动事件每帧都来。如果把进度写进 state，整块组件（连带它的 SVG）每帧重渲染一次，
 * 在一页上百张卡的发现页上这是纯粹的浪费。所以：
 *   - `visible` 才是 state —— 它只在跨越阈值那一下变化，React 对相同值会直接
 *     跳过重渲染，实际代价接近零；
 *   - 进度是**直接写 `stroke-dashoffset` 属性**，一个字节的 DOM 操作，不触发任何渲染。
 *
 * ## 动效全部用 transition，不用 keyframes
 *
 * 宿主视图是常驻 DOM + `display:none` 的（见 `App.tsx`）。在 `display:none` 的祖先里
 * 创建的 CSS **animation** 会永久卡在 0% 帧——`tailwind.config.js` 里那条关于
 * `fluent-card-in` 的长注释记的就是这个坑。transition 是状态变化时才跑的，
 * 而本组件只在视图可见时才会被交互触发，天然不受影响。所以这里刻意不用
 * `animate-fluent-scale-in` 之类。
 */
export const BackToTop: React.FC<BackToTopProps> = ({ targetRef, threshold = 320 }) => {
  const [visible, setVisible] = useState(false);
  const ringRef = useRef<SVGCircleElement | null>(null);

  useEffect(() => {
    const element = targetRef.current;
    if (!element) return;

    const sync = () => {
      const top = element.scrollTop;
      const max = Math.max(1, element.scrollHeight - element.clientHeight);
      setVisible(top > threshold);
      const ring = ringRef.current;
      if (ring) {
        const ratio = Math.min(1, Math.max(0, top / max));
        ring.style.strokeDashoffset = String(RING_CIRCUMFERENCE * (1 - ratio));
      }
    };

    // 先同步一次：视图切换回来、或内容高度变化后，状态可能已经过期。
    sync();
    element.addEventListener('scroll', sync, { passive: true });
    return () => element.removeEventListener('scroll', sync);
  }, [targetRef, threshold]);

  const scrollToTop = useCallback(() => {
    targetRef.current?.scrollTo({ top: 0, behavior: 'smooth' });
  }, [targetRef]);

  return (
    // 外壳铺满整行但不吃点击：只有按钮本身可交互，否则它会挡住卡片右下的点击。
    //
    // ## 为什么是 `fixed` 而不是 `sticky`
    //
    // 最初用 `position: sticky; bottom-*`：宿主是滚动容器，只要那个位置落在滚动口
    // 下沿之下就被"钉"住。能让它工作，但有两个副作用：
    //   1. 它必须作为**滚动容器的直接子元素**才成立，于是"按钮位置"这件事被绑死在
    //      宿主的布局上 —— 「我的追剧 / 观看历史 / 更多」这几个页面的滚动容器是
    //      `max-w-5xl mx-auto`，按钮会跟着缩到内容列右缘，在宽窗口上飘在偏中间的地方；
    //   2. 它为页面多加了一行高度（得靠 `-mt-5` 去抵宿主的 `gap-5` 才不显眼），
    //      而宿主换一个 gap 值这笔账就错 4px。
    //
    // `fixed` 两个问题一起消失：位置相对**内容区**（`<main>` 上有
    // `contain: layout paint`，它是 fixed 后代的包含块；就算哪天真没了这个属性，
    // 导航栏在左侧、main 一直顶到窗口右下角，锚到窗口右下角结果也一样），
    // 因此与宿主的 `max-width` / `gap` 全都无关；且完全不占布局高度。
    <div className="pointer-events-none fixed bottom-5 right-5 z-40">
      <button
        type="button"
        onClick={scrollToTop}
        title="回到顶部"
        aria-label="回到顶部"
        // 隐藏时移出 Tab 序列：透明但仍可聚焦的按钮是纯陷阱。
        tabIndex={visible ? 0 : -1}
        className={`group relative flex h-11 w-11 items-center justify-center rounded-full border border-white/95 bg-white/85 text-slate-500 shadow-fluent backdrop-blur-xl transition-all duration-300 ease-[cubic-bezier(.16,1,.3,1)] hover:-translate-y-1 hover:border-white hover:bg-white hover:text-blue-600 hover:shadow-fluent-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 active:scale-90 ${
          visible
            ? 'pointer-events-auto translate-y-0 scale-100 opacity-100'
            : 'pointer-events-none translate-y-4 scale-90 opacity-0'
        }`}
      >
        {/* 滚动进度环：外圈淡蓝底 + 蓝色进度。`-rotate-90` 让起点回到 12 点方向。 */}
        <svg aria-hidden="true" viewBox="0 0 44 44" className="absolute inset-0 h-full w-full -rotate-90">
          <circle
            cx="22"
            cy="22"
            r={RING_RADIUS}
            fill="none"
            stroke="rgba(0, 103, 192, 0.13)"
            strokeWidth="2"
          />
          <circle
            ref={ringRef}
            cx="22"
            cy="22"
            r={RING_RADIUS}
            fill="none"
            stroke="#0067c0"
            strokeWidth="2"
            strokeLinecap="round"
            strokeDasharray={RING_CIRCUMFERENCE}
            // 初值刻意不写在这里：JSX 里的属性会在每次重渲染时把命令式写入的值盖回去。
            // 首次同步由 effect 里那次 sync() 完成，而那会儿按钮还是 opacity-0，不会有闪烁。
            className="transition-[stroke-dashoffset] duration-200 ease-out"
          />
        </svg>
        <ArrowUp
          strokeWidth={2.6}
          className="relative h-[18px] w-[18px] transition-transform duration-300 group-hover:-translate-y-0.5"
        />
      </button>
    </div>
  );
};
