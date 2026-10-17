import React, { useEffect, useState } from 'react';
import { BOOST_LEVELS, levelLabel, type BoostLevel } from '../../services/boostController';

/** 长按加速满这么久之后，提示条自己淡下去（毫秒）。 */
const DIM_AFTER_MS = 5000;

interface BoostToastProps {
  /** 当前档位。 */
  level: BoostLevel;
  /** 换档方向：-1 向上、+1 向下、0 首次进入。用来决定滚轮从哪边滚入。 */
  direction: number;
}

/**
 * 长按加速时的滚轮提示条（形态照红果 App）。
 *
 * 左边 `»` + 「倍速播放中」，右边是**竖向滚轮**：当前档居中、上下各露一个相邻档。
 * 只显示当前值的话，用户按 ↑ / ↓ 时看不出还有哪些档、也不知道按到第几个了。
 *
 * 两个节奏都写在下面，改任意一个都会直接改变手感：
 *   - 满 5 秒自动淡下去：提示条的任务在"用户知道自己在加速"那一刻就完成了，
 *     一直亮着反而是画面中央的一块遮挡。
 *   - 换档立刻重新点亮并重新计时：刚换了一档，先让人看清换成了什么，看够了再淡。
 */
export const BoostToast: React.FC<BoostToastProps> = ({ level, direction }) => {
  const [dimmed, setDimmed] = useState(false);

  // 组件只在加速期间存在，所以挂载那一刻就是"长按起点"；依赖档位 = 换档即重新计时。
  // 淡入淡出的方向由 CSS 决定：点亮快（0.12s）、变暗慢（0.9s）。
  useEffect(() => {
    setDimmed(false);
    const timer = setTimeout(() => setDimmed(true), DIM_AFTER_MS);
    return () => clearTimeout(timer);
  }, [level]);

  const count = BOOST_LEVELS.length;
  const index = BOOST_LEVELS.indexOf(level);
  const above = BOOST_LEVELS[(index - 1 + count) % count];
  const below = BOOST_LEVELS[(index + 1) % count];

  return (
    <div className={`ttv-boost-toast${dimmed ? ' is-dimmed' : ''}`} role="status" aria-live="polite">
      {/* 三个实心三角那种图标太尖锐，这里用双箭头，和"加速"的语义也更直白。 */}
      <span className="ttv-boost-icon" aria-hidden>
        <svg
          viewBox="0 0 19 14"
          width="19"
          height="14"
          fill="none"
          stroke="currentColor"
          strokeWidth="3"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M4 2 9 7 4 12" />
          <path d="M11 2 16 7 11 12" />
        </svg>
      </span>
      <span>倍速播放中</span>
      <span className="ttv-boost-wheel">
        {/*
          key 就是档位：换档即重挂，重挂才会重播滚动动画。
          档位只有 4 个、换档是离散事件，重挂一次的成本可以忽略；而"长期维护一个
          正确定位的滚动列表"要处理边界回绕、动画打断一堆状态。
        */}
        <span
          key={String(level)}
          className="ttv-boost-wheel-track ttv-boost-roll"
          style={{ '--roll-dir': direction } as React.CSSProperties}
        >
          <span className="ttv-boost-wheel-row">{levelLabel(above)}</span>
          <span className="ttv-boost-wheel-row is-current">{levelLabel(level)}</span>
          <span className="ttv-boost-wheel-row">{levelLabel(below)}</span>
        </span>
      </span>
    </div>
  );
};
