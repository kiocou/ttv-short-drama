import React, { useEffect, useRef } from 'react';

/**
 * ReactBits 风格的机械滚轮数字。
 *
 * 为什么不用纯声明式样式驱动：
 * 数字逐位滚动的本质是某一位从 d 滚到 d2，而 9 到 0 需要一个额外动作：
 * 先向前滚到列表末尾那个重复的 0，再瞬时归零（否则会倒着退回去，看起来像回放）。
 * 这种滚到位再悄悄瞬移必须命令式地控制 transform 与 transition，
 * 所以这里直接操作 DOM 节点，而不走 React 的声明式样式。
 *
 * 性能：每位的位移只写 transform（走合成层），不触发重排。
 */

/** 单字形高度（px）。必须与 styles/crystal.css 里的 --roller-h 保持一致。 */
const GLYPH_H = 18;

interface DigitProps {
  digit: number;
  /** 拖拽或寻道时立即到位，不播放滚动动画。 */
  instant: boolean;
  /** 音量百分比用更窄的列宽与更小的字号。 */
  percent?: boolean;
}

const Digit: React.FC<DigitProps> = ({ digit, instant, percent }) => {
  const listRef = useRef<HTMLDivElement | null>(null);
  const prevRef = useRef<number | null>(null);

  useEffect(() => {
    const el = listRef.current;
    if (!el) return;

    const prev = prevRef.current;
    // 首次挂载直接到位：让初始读数从 0 滚上来反而像故障。
    const first = prev === null;
    const atOnce = instant || first;

    if (!atOnce && prev === digit) return;

    // 9 到 0：向前滚过末尾那个额外的 0，再瞬时回到起点，形成自然进位。
    if (!atOnce && prev === 9 && digit === 0) {
      prevRef.current = digit;
      el.style.transition = '';
      el.style.transform = 'translateY(' + (-10 * GLYPH_H) + 'px)';
      const timer = window.setTimeout(() => {
        el.style.transition = 'none';
        el.style.transform = 'translateY(0px)';
        // 读一次布局，让瞬移真正落盘后再恢复过渡，
        // 否则浏览器会把两步合并成一次动画，变成往回滚。
        void el.offsetHeight;
        el.style.transition = '';
      }, 400);
      return () => window.clearTimeout(timer);
    }

    prevRef.current = digit;
    el.style.transition = atOnce ? 'none' : '';
    el.style.transform = 'translateY(' + (-digit * GLYPH_H) + 'px)';
  }, [digit, instant]);

  return (
    <div className={'roller-col' + (percent ? ' is-pct' : '')}>
      <div className="roller-list" ref={listRef}>
        {/* 0-9 之后再补一个 0，作为 9 到 0 的进位落点 */}
        {Array.from({ length: 11 }, (_, i) => (
          <span key={i}>{i % 10}</span>
        ))}
      </div>
    </div>
  );
};

interface RollingTimeProps {
  /** 秒数。 */
  value: number;
  /** duration 用更淡的配色，与已播放的读数区分。 */
  variant?: 'position' | 'duration';
  instant?: boolean;
}

/**
 * MM:SS 滚轮读数。
 *
 * 分钟位固定两位（上限 99 分钟）：短剧单集都在几分钟内，99 分钟足以覆盖任何
 * 异常长内容，同时保证读数宽度恒定，宽度一跳，整排控制按钮就会跟着挪位。
 */
export const RollingTime: React.FC<RollingTimeProps> = ({
  value,
  variant = 'position',
  instant = false,
}) => {
  const safe = Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
  const total = Math.min(safe, 99 * 60 + 59);
  const m = Math.floor(total / 60);
  const s = total % 60;
  const digits = [Math.floor(m / 10) % 10, m % 10, Math.floor(s / 10) % 10, s % 10];

  return (
    <div className={'rolling-counter' + (variant === 'duration' ? ' is-duration' : '')}>
      {digits.map((d, i) => (
        <React.Fragment key={i}>
          {i === 2 && <span className="roller-colon">:</span>}
          <Digit digit={d} instant={instant} />
        </React.Fragment>
      ))}
    </div>
  );
};

interface RollingPercentProps {
  /** 0-100 的数值。 */
  value: number;
  instant?: boolean;
}

/**
 * 百分比滚轮读数（音量柱）。
 * 只渲染实际需要的位数，避免 5% 被显示成 005%。
 */
export const RollingPercent: React.FC<RollingPercentProps> = ({ value, instant = false }) => {
  const pct = Math.max(0, Math.min(100, Math.round(Number.isFinite(value) ? value : 0)));
  const chars = String(pct).split('');

  return (
    <div className="rolling-counter">
      {chars.map((ch, i) => (
        <Digit key={i} digit={Number(ch)} instant={instant} percent />
      ))}
      <span className="roller-suffix">%</span>
    </div>
  );
};
