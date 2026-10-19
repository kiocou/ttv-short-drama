import React, { useEffect, useRef, useState } from 'react';

/**
 * 一次操作提示的内容。
 *
 * `key` 用来做「同一个提示重复触发时不重挂」的判断：连续按两次空格，
 * 应该把已有的提示**重新点亮并重置计时**，而不是销毁重建——
 * 重建会让动画从第一帧重播，连按两次会看到图标闪一下，像卡了。
 */
export interface PlayerToastPayload {
  /** 图标（16–28px 的 svg 或字符）。 */
  icon: React.ReactNode;
  /** 主文案，例如「播放」「音量 60%」。 */
  label: string;
  /** 补充说明，可省略。例如「1:23 / 45:00」。 */
  detail?: string;
  /** 提示的唯一标识，用于判重。 */
  key: string;
  /**
   * 音量进度弧的占比（0–1）。
   *
   * 只有音量类提示才传：圆底外圈会画一道弧，直观表达"现在多大音量"。
   * 纯 CSS 的 `conic-gradient` + `mask` 画环，不增加 DOM 层级、
   * 也不用 `backdrop-filter`（那会打掉 RTX VSR）。
   */
  volume?: number;
}

interface PlayerToastProps {
  payload: PlayerToastPayload | null;
  /** 每次「触发」递增的序号：即使 payload.key 相同，也要重新点亮。 */
  tick: number;
}

/** 提示停留时长（毫秒）。 */
const HOLD_MS = 760;

/**
 * 播放器中央的操作提示（形态对齐 B 站播放器）。
 *
 * ## 为什么需要它
 *
 * 播放器的快捷键不少：空格暂停、← → 快退快进、↑ ↓ 音量、F 全屏、[ ] 切集。
 * 但这些操作**没有任何视觉反馈**——
 *   - 按空格，画面停了，但你分不清是"暂停了"还是"卡住了"；
 *   - 按 ↑ ↓ 调音量，只有右下角一个几乎不动的图标；
 *   - 按 [ ] 切集，画面直接跳，不知道切到了第几集。
 *
 * B 站的做法是：操作发生的那一刻，在画面**正中央**闪一个「图标 + 文字」，
 * 短暂停留后自己淡出。它不遮挡内容（停留不到 1 秒、且半透明），
 * 却把"我刚才那下到底生效没有"这件事一次说清。
 *
 * ## 形态（2026-10-19 重设计）
 *
 * 圆形半透明底 + 图标 + 主文案 + 副文案。圆底比方块轻，压画面的感觉小；
 * 副文案只在有数值时出现（音量%、落点时间、集号），不堆信息。
 *
 * ## 四个设计约束
 *
 * 1. **只做 opacity + scale，不做位移**。播放器里任何常驻的
 *    transform/filter 都会把 video 祖先钉成合成层，让 NVIDIA VSR 失效
 *    （项目不变量 26）。这里虽然只存在 0.76 秒、也不是 video 祖先，
 *    但既然淡入淡出就够表达"出现"，就不引入第二个变量。
 * 2. **不用 backdrop-filter**。本舞台内所有背景模糊都会把视频拉进合成器，
 *    同样会打掉 VSR。圆底用纯色半透明。
 * 3. **`pointer-events: none`**。它盖在画面中央，绝不能挡住点击画面暂停。
 * 4. **容器不挂 key**。挂 key 会在内容变化时卸载重建，丢掉 `visible` 状态。
 *
 * ## 动效
 *
 * - **弹性入场**：`cubic-bezier(.22, 1.4, .42, 1)` 带一点过冲，
 *   图标像被"弹"到位，比线性缩放有生命感。
 * - **图标脉冲**：换图标时做一次 `scale .82 → 1.06 → 1`，
 *   像按下去又弹回。这是最关键的细节——硬切图标会显得很机械。
 * - **连按重置**：同一个提示连按会重新点亮并把停留时间推后，
 *   不会闪一下就没。
 */
export const PlayerToast: React.FC<PlayerToastProps> = ({ payload, tick }) => {
  /** 当前是否可见。由 tick 点亮、由定时器熄灭。 */
  const [visible, setVisible] = useState(false);
  /** 每次点亮递增，用来让图标脉冲动画重播（CSS 动画只在节点重挂或类名切换时重放）。 */
  const [pulseId, setPulseId] = useState(0);
  /** 上一次的 key：key 变了说明换了操作类型，值得给一次脉冲。 */
  const lastKeyRef = useRef<string | null>(null);

  useEffect(() => {
    if (!payload) return;

    /**
     * 先移除 `is-visible` 再在下一帧加回来，否则**同一帧内连续点亮不会重播动画**
     * （浏览器认为类名没变过）。用 `requestAnimationFrame` 让出一帧最稳。
     *
     * 这里没有用「先 setVisible(false) 再 true」的双次 setState：那会多一次渲染，
     * 且在快速连按时可能与定时器竞争。直接操作类名更直接。
     */
    setVisible(false);
    const raf = window.requestAnimationFrame(() => {
      setVisible(true);
      setPulseId(current => current + 1);
    });

    const timer = window.setTimeout(() => setVisible(false), HOLD_MS);
    lastKeyRef.current = payload.key;
    return () => {
      window.cancelAnimationFrame(raf);
      window.clearTimeout(timer);
    };
    // 依赖 tick 而不是 payload：同一个提示重复触发时 payload 对象可能是新的，
    // 但真正驱动"重新点亮"的是 tick 递增。
  }, [payload, tick]);

  // 没有 payload（从未触发过）时什么都不渲染，避免留一个空层。
  if (!payload) return null;

  const hasVolume = typeof payload.volume === 'number' && Number.isFinite(payload.volume);
  const volumePercent = hasVolume ? Math.round(Math.min(1, Math.max(0, payload.volume!)) * 100) : 0;

  return (
    <div
      className={`ttv-player-toast${visible ? ' is-visible' : ''}${hasVolume ? ' has-volume' : ''}`}
      role="status"
      aria-live="polite"
    >
      {/*
        ⚠️ 这里**不能**给容器挂 key。挂 key 会让 React 在提示内容变化时
        卸载重建整棵子树，连带丢掉 `visible` 状态——表现是连按两次时
        图标闪一下、动画从第一帧重播。容器稳定、只换内容，才是对的。
      */}
      <span className="ttv-player-toast-disc">
        {hasVolume && (
          <span
            className="ttv-player-toast-ring"
            style={{ ['--ttv-toast-volume' as string]: `${volumePercent}%` }}
            aria-hidden
          />
        )}
        {/*
          `pulseId` 进 key：每次点亮都重挂这一个 span，让图标脉冲动画重播。
          只重挂图标（不是整个提示），所以 `visible` 状态不受影响。
        */}
        <span key={pulseId} className="ttv-player-toast-icon" aria-hidden>
          {payload.icon}
        </span>
      </span>
      <span className="ttv-player-toast-label">{payload.label}</span>
      {payload.detail && <span className="ttv-player-toast-detail">{payload.detail}</span>}
    </div>
  );
};
