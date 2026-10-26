import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ProgressBar } from './ProgressBar';
import { tracePlayback } from '../../services/playbackTrace';
import { RollingPercent, RollingTime } from './RollingNumber';
import {
  Play,
  Pause,
  SkipBack,
  SkipForward,
  RotateCcw,
  RotateCw,
  Volume2,
  VolumeX,
  Maximize,
  PictureInPicture2,
  Minimize,
  ArrowLeft,
  Layers,
  Lock,
  LockOpen,
  Sparkles,
} from 'lucide-react';

/**
 * 播放进度条。
 *
 * ⚠️ **数据必须由 props 传入，不能自己读 store**（2026-10-24 修「动漫进度条不动」）。
 *
 * ## 上一版错在哪
 *
 * 为了减少重渲染，曾让这里直接 `usePlaybackStore()` 订阅短剧的 store，理由是
 * "高频刷新限制在叶子组件里"。但 `PlayerHud` 是**短剧与动漫共用**的呈现层，
 * 而动漫的数据在 `useAnimePlayerStore` —— 于是动漫播放器的进度条读的永远是
 * 短剧 store 里的值（0 或上一次短剧的残留），**完全不动**。
 *
 * 这违反了这个组件文件头写明的边界：「本组件不读任何 store、不碰 `<video>`、
 * 不做会话判定。它渲染什么完全由 props 决定」。为了性能优化打破这条边界，
 * 代价是两个播放器串了数据 —— 不值得。
 *
 * ## 性能怎么办
 *
 * 交给调用方：短剧侧把 `position` 等高频字段包在一个只订阅这些字段的小组件里
 * 传进来（见 `VideoSurface` 的 `HudLiveData`），动漫侧传它自己的值。HUD 本身
 * 保持纯 props，两个播放器各喂各的。
 */
const LiveProgressBar: React.FC<{
  position: number;
  duration: number;
  buffered: number;
  onSeek: (seconds: number, previewing?: boolean) => void;
}> = ({ position, duration, buffered, onSeek }) => (
  <ProgressBar position={position} duration={duration} buffered={buffered} onSeek={onSeek} />
);

/** 滚轮时间读数：同样纯 props。 */
const LiveTimeReadout: React.FC<{ position: number; duration: number }> = ({ position, duration }) => (
  <div
    className="ttv-time"
    aria-label={`已播放 ${Math.floor(position)} 秒，共 ${Math.floor(duration)} 秒`}
  >
    <RollingTime value={position} />
    <span className="time-sep">/</span>
    <RollingTime value={duration} variant="duration" />
  </div>
);

/**
 * 播放器 HUD（顶部标题岛 + 底部操控坞）——短剧与动漫**共用同一套呈现层**。
 *
 * 为什么要有这一层：动漫专区原本自绘了一套紫色圆角控制条，与短剧的晶体材质
 * （`crystal.css` 的 `ttv-*` / `crystal-*`）是两套视觉语言，同一块画面两种手感。
 * 两套 markup 各自维护的结果必然是继续漂移，所以这里把外观抽成**纯 props 驱动**
 * 的组件：谁读 store、谁管会话、谁负责兜底都留在各自的 store 里，HUD 只认输入。
 *
 * 边界：本组件不读任何 store、不碰 `<video>`、不做会话判定。它渲染什么完全由
 * props 决定，因此"动漫播放器长成另一个样子"这类问题不会再出现。
 */

/** HUD 认的清晰度档位形状。`value` 必须是源端档位字面量（`auto` / `1080p`）。 */
export interface PlayerQualityOption {
  label: string;
  value: string;
  resolution: string;
}

/**
 * 源没探到任何档位时的唯一选项。
 *
 * 只给"自动"这一项——绝不虚构 4K/1080P 这类源里不存在的档位（那只会触发无意义
 * 的重复解析，见 CHANGELOG v0.2.x 的说明）。单档位时清晰度按钮自动禁用。
 */
export const FALLBACK_QUALITY_OPTIONS: PlayerQualityOption[] = [
  { label: '自动', value: 'auto', resolution: '由播放源自动选择' },
];

// 这里的档位是**基准倍速**，与长按加速的档位（智能 / 1.5x / 2x / 3x）互不影响：
// 松手后永远回到这里选的值。
// 慢速档（0.5/0.75）保留是因为慢看本身有用；高速档（3x）保留是因为有人就想一直快放。
const SPEED_OPTIONS = [0.5, 0.75, 1.0, 1.25, 1.5, 2.0, 3.0];

export interface PlayerHudProps {
  /** 顶部标题岛：剧名。 */
  title: string;
  /** 集数徽章文案（已格式化，例如"第 3 集 · 真相"）。 */
  episodeLabel: string;
  /** 返回按钮的 tooltip（短剧是"返回剧集列表"，动漫是"返回详情"）。 */
  backTitle?: string;

  /*
    `position` / `duration` / `buffered` 由调用方传入（2026-10-24 恢复）。

    曾经为了减少重渲染把这三项从 props 摘掉、改由叶子组件自己读 store，
    结果动漫播放器读到的是短剧 store 的值，进度条完全不动。这个组件是
    两个播放器共用的呈现层，数据必须由调用方喂——性能优化交给调用方做
    （短剧侧有 `HudLiveData` 只订阅高频字段），而不是在这里跨界读 store。
  */
  position: number;
  duration: number;
  buffered: number;

  isPlaying: boolean;
  isFullscreen: boolean;
  /** 控制条是否处于"该显示"的时间窗口（由宿主的静默计时器决定）。 */
  isVisible: boolean;
  /** 用户主动收起（锁定）控制器。 */
  isLocked: boolean;

  volume: number;
  isMuted: boolean;
  playbackRate: number;
  /**
   * 长按方向键加速时**实际生效**的速率（已按上限截断）；未加速时为 null。
   *
   * 由调用方算好传进来，而不是这里拿 playbackRate × 3 再算一遍：倍速菜单里那行
   * 「长按加速到 Nx」如果自己重算，一旦倍数或上限在别处调整，两处就会各说各话。
   */
  effectivePlaybackRate?: number | null;
  currentQuality: string;
  qualityOptions: PlayerQualityOption[];

  /**
   * 视频增强（RTX VSR）当前是否开启。
   *
   * ⚠️ 与 position / duration 同理：**必须由调用方喂**。短剧侧读
   * `usePlaybackStore`、动漫侧读 `useAnimePlayerStore` / 设置，HUD 自己不碰
   * 任何 store —— 动漫进度条读到短剧 store 那次事故就是打破这条边界的代价。
   */
  vsrEnabled: boolean;
  /**
   * 用户拨动 VSR 开关。
   *
   * 调用方负责真正的写设置与"让当前这一集立即走新链路"：短剧侧是
   * `usePlaybackStore().setVsrEnabled`（内部会按原位置重新解析），动漫侧直接写
   * 全局设置（动漫源不经过转码链路，见 `vsrAppliesToSource`）。
   */
  onToggleVsr: (enabled: boolean) => void;
  /**
   * 当前播放源是否真的受 VSR 链路影响。
   *
   * 动漫源是原生 H.264 直连，本来就走驱动侧增强，没有"转码才有 VSR"这回事。
   * 传 `false` 时浮层会如实写明"此开关作用于短剧/漫剧"，而不是让用户拨了
   * 一个在这块画面上看不出效果、还以为是坏了的开关（不变量 8：诚实报告边界）。
   *
   * 默认 `true`（短剧/漫剧）。
   */
  vsrAppliesToSource?: boolean;

  onToggleLock: () => void;
  /** 交给画中画小窗播放（独立置顶窗口，可拖动、可拉伸改大小）。 */
  onEnterPip: () => void;
  onToggleFullscreen: () => void;
  onUserActivity: () => void;
  /** 指针移动统一入口（带合成事件过滤），容器层已过滤后传入。 */
  onPointerMove?: (e: React.MouseEvent) => void;

  onTogglePlay: () => void;
  onSeek: (seconds: number, previewing?: boolean) => void;
  onSeekRelative: (deltaSeconds: number) => void;
  onVolumeChange: (value: number) => void;
  onToggleMute: () => void;
  onPlaybackRate: (rate: number) => void;
  onQualityChange: (value: string) => void;
  onPlayPrev: () => void;
  onPlayNext: () => void;
  onOpenEpisodes: () => void;
  onBack: () => void;
}

export const PlayerHud: React.FC<PlayerHudProps> = ({
  title,
  episodeLabel,
  backTitle = '返回剧集列表',
  position,
  duration,
  buffered,
  isPlaying,
  isFullscreen,
  isVisible,
  isLocked,
  volume,
  isMuted,
  playbackRate,
  effectivePlaybackRate = null,
  currentQuality,
  qualityOptions,
  vsrEnabled,
  onToggleVsr,
  vsrAppliesToSource = true,
  onToggleLock,
  onEnterPip,
  onToggleFullscreen,
  onUserActivity,
  onPointerMove,
  onTogglePlay,
  onSeek,
  onSeekRelative,
  onVolumeChange,
  onToggleMute,
  onPlaybackRate,
  onQualityChange,
  onPlayPrev,
  onPlayNext,
  onOpenEpisodes,
  onBack,
}) => {
  // 弹窗状态
  const [showVolumeSlider, setShowVolumeSlider] = useState(false);
  const [showQualityMenu, setShowQualityMenu] = useState(false);
  const [showSpeedMenu, setShowSpeedMenu] = useState(false);
  const [showEnhanceMenu, setShowEnhanceMenu] = useState(false);

  const controlsRef = useRef<HTMLDivElement | null>(null);

  // 点击外部自动关闭下拉菜单与音量条
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (controlsRef.current && !controlsRef.current.contains(e.target as Node)) {
        setShowQualityMenu(false);
        setShowSpeedMenu(false);
        setShowVolumeSlider(false);
        setShowEnhanceMenu(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // 收起控制器时把所有浮层一并关掉：留着悬空的气泡既无意义，也会被 .is-hidden 压住
  useEffect(() => {
    if (isLocked) {
      setShowQualityMenu(false);
      setShowSpeedMenu(false);
      setShowVolumeSlider(false);
      setShowEnhanceMenu(false);
    }
  }, [isLocked]);

  /**
   * Esc 收起增强浮层。
   *
   * 它是 `role="dialog"`，用户会预期 Esc 能退出（下面那条「锁定态 Esc 解锁」是
   * 另一回事，两者互不影响）。清晰度 / 倍速是纯气泡，没有这个预期，不在这里统一处理。
   */
  useEffect(() => {
    if (!showEnhanceMenu) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setShowEnhanceMenu(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [showEnhanceMenu]);

  // Esc 解锁：收起后鼠标若已停住，键盘是唯一的出口
  useEffect(() => {
    if (!isLocked) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onToggleLock();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isLocked, onToggleLock]);

  // 清晰度档位以「源流真实提供」为准；探测未完成或源只有一路时只显示"自动"。
  const resolvedQualities = qualityOptions.length > 0 ? qualityOptions : FALLBACK_QUALITY_OPTIONS;
  // 单档位时禁用切换（点了也没得选，徒增困惑）。
  const qualitySelectable = resolvedQualities.length > 1;

  // HUD 显示条件：既没到自动隐藏时间，也没被用户收起。
  // 锁按钮则多一条——收起后必须始终可见，否则用户没有出口把它叫回来。
  const hudShown = isVisible && !isLocked;
  const lockShown = isVisible || isLocked;

  return (
    <div
      className={`absolute inset-0 z-30 pointer-events-none${
        isLocked ? ' is-locked' : ''
      }${!hudShown && !isLocked ? ' is-auto-hidden' : ''}`}
    >
      {/*
        收起态的贴边迷你进度条已经**移到 VideoSurface 根部**（与 <video> 同级、
        z-40）。原因：它原来挂在这里，而这一层在自动隐藏 / 锁定态会整体淡出 ——
        子元素再怎么设 opacity 也救不回来；换集又恰好落在自动隐藏的时间窗里，
        于是表现为"第一集正常、切下一集进度条不见了"。
        现在由 VideoSurface 直接渲染 `<MiniProgress />`，位置与层叠都不受 HUD 影响。
      */}

      {/*
        右侧居中小锁：展开 / 收起播放控制器。
        键盘可达（Enter/Space 都能触发），收起后按 Esc 也能解锁。
      */}
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onToggleLock();
        }}
        className={`ttv-lock crystal-surface${lockShown ? ' is-shown' : ''}${isLocked ? ' is-locked' : ''}`}
        title={isLocked ? '展开播放控制器 (Esc)' : '收起播放控制器'}
        aria-label={isLocked ? '展开播放控制器' : '收起播放控制器'}
        aria-pressed={isLocked}
      >
        {isLocked ? <Lock className="w-[18px] h-[18px]" /> : <LockOpen className="w-[18px] h-[18px]" />}
      </button>

      {/* HUD 控制层：顶部标题岛 + 底部操控坞 */}
      <div
        className={`ttv-hud${hudShown ? '' : ' is-hidden'}`}
        onMouseMove={(e) => {
          // HUD 在光标下方时动画会派发合成 mousemove；有过滤版入口就优先用，
          // 避免合成事件反复重置自动隐藏定时器。
          if (onPointerMove) {
            onPointerMove(e);
          } else {
            onUserActivity();
          }
        }}
      >
        {/* 顶部标题岛 */}
        <div className="ttv-top-bar">
          <div className="title-crystal-island crystal-surface">
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onBack();
              }}
              className="btn-fluent-action"
              title={backTitle}
              aria-label={backTitle}
            >
              <ArrowLeft className="w-4 h-4" />
            </button>

            <div className="crystal-divider" />

            <div className="flex items-center gap-2 pr-1.5 min-w-0">
              <span className="drama-title">{title}</span>
              {/* 动漫播放器在详情返回前拿不到集数，此时不渲染空气泡。 */}
              {episodeLabel ? <span className="episode-badge">{episodeLabel}</span> : null}
            </div>
          </div>
        </div>

        {/* 底部操控坞：进度槽与控件同处一张晶体大卡片 */}
        <div className="ttv-dock" onClick={(e) => e.stopPropagation()}>
          <div ref={controlsRef} className="mica-crystal-card crystal-surface">
            {/* 进度槽内嵌于卡片顶部（数据由调用方传入，见 PlayerHudProps 的说明） */}
            <LiveProgressBar position={position} duration={duration} buffered={buffered} onSeek={onSeek} />

            <div className="controls-deck-row">
              {/* 左侧：集数切换、快进快退、播放主键、滚轮时间读数 */}
              <div className="flex items-center gap-3 min-w-0">
                <div className="flex items-center gap-0.5">
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      onPlayPrev();
                    }}
                    className="btn-fluent-action"
                    title="上一集 (快捷键 [ )"
                    aria-label="上一集"
                  >
                    <SkipBack className="w-4 h-4" />
                  </button>

                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      onSeekRelative(-5);
                    }}
                    className="btn-fluent-action"
                    title="后退 5 秒 (快捷键 ←)"
                    aria-label="后退 5 秒"
                  >
                    <RotateCcw className="w-4 h-4" />
                  </button>

                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      onTogglePlay();
                    }}
                    className="btn-play-hero"
                    title={isPlaying ? '暂停 (空格)' : '播放 (空格)'}
                    aria-label={isPlaying ? '暂停' : '播放'}
                  >
                    {isPlaying ? (
                      <Pause className="w-[18px] h-[18px] fill-current" />
                    ) : (
                      <Play className="w-[18px] h-[18px] fill-current ml-0.5" />
                    )}
                  </button>

                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      onSeekRelative(5);
                    }}
                    className="btn-fluent-action"
                    title="快进 5 秒 (快捷键 →)"
                    aria-label="快进 5 秒"
                  >
                    <RotateCw className="w-4 h-4" />
                  </button>

                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      onPlayNext();
                    }}
                    className="btn-fluent-action"
                    title="下一集 (快捷键 ] )"
                    aria-label="下一集"
                  >
                    <SkipForward className="w-4 h-4" />
                  </button>
                </div>

                <div className="crystal-divider" />

                {/* 机械滚轮时间读数（自己订阅 store，不吃 props 链的高频更新） */}
                <LiveTimeReadout position={position} duration={duration} />
              </div>

              {/* 右侧：音量、清晰度、倍速、选集、全屏 */}
              <div className="flex items-center gap-0.5">
                <VolumeControl
                  isMuted={isMuted}
                  volume={volume}
                  open={showVolumeSlider}
                  onToggle={() => {
                    setShowVolumeSlider(prev => !prev);
                    setShowQualityMenu(false);
                    setShowSpeedMenu(false);
                    // 四个浮层必须互斥：增强浮层宽 292px，叠在倍速/清晰度之上时
                    // 会把对方整个盖住（同 z-index 50，DOM 靠后者在上）。
                    setShowEnhanceMenu(false);
                  }}
                  onToggleMute={onToggleMute}
                  onVolumeChange={(v) => onVolumeChange(v)}
                />

                {/* 清晰度：仅当源真实提供多档时才可切换 */}
                <div className="relative">
                  <button
                    type="button"
                    disabled={!qualitySelectable}
                    onClick={(e) => {
                      e.stopPropagation();
                      if (!qualitySelectable) return;
                      setShowQualityMenu(prev => !prev);
                      setShowSpeedMenu(false);
                      setShowVolumeSlider(false);
                      setShowEnhanceMenu(false);
                    }}
                    title={qualitySelectable ? '切换清晰度' : '当前播放源仅提供单一画质'}
                    className="btn-text-action"
                  >
                    {resolvedQualities.find(q => q.value === currentQuality)?.label.split(' ')[0]
                      || resolvedQualities[0]?.label.split(' ')[0]
                      || '自动'}
                  </button>

                  {qualitySelectable && (
                    <div className={`crystal-flyout crystal-surface${showQualityMenu ? ' open' : ''}`}>
                      {resolvedQualities.map((opt, index) => (
                        <button
                          key={`${opt.value}-${index}`}
                          type="button"
                          onClick={() => {
                            onQualityChange(opt.value);
                            setShowQualityMenu(false);
                          }}
                          className={`crystal-menu-item${currentQuality === opt.value ? ' active' : ''}`}
                        >
                          {opt.label}
                        </button>
                      ))}
                    </div>
                  )}
                </div>

                {/* 倍速 */}
                <div className="relative">
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      setShowSpeedMenu(prev => !prev);
                      setShowQualityMenu(false);
                      setShowVolumeSlider(false);
                      setShowEnhanceMenu(false);
                    }}
                    className={`btn-text-action${effectivePlaybackRate !== null ? ' is-boosting' : ''}`}
                    title="切换播放倍速（长按 ← / → 临时加速，加速中按 ↑ / ↓ 换档）"
                  >
                    {effectivePlaybackRate !== null
                      ? `${effectivePlaybackRate}x 加速`
                      : playbackRate === 1
                        ? '倍速'
                        : `${playbackRate}x`}
                  </button>

                  <div className={`crystal-flyout crystal-surface${showSpeedMenu ? ' open' : ''}`}>
                    {SPEED_OPTIONS.map((rate) => (
                      <button
                        key={rate}
                        type="button"
                        onClick={() => {
                          onPlaybackRate(rate);
                          setShowSpeedMenu(false);
                        }}
                        className={`crystal-menu-item${playbackRate === rate ? ' active' : ''}`}
                      >
                        {rate === 1.0 ? '1.0x 正常' : `${rate}x`}
                      </button>
                    ))}
                    {/*
                      长按加速的落点写在这里：不看这行的话，用户根本不知道有这个手势。
                      加速档位是另一套（起点是"智能"），与上面选的基准倍速无关。
                    */}
                    <div className="crystal-menu-note">
                      长按 ← / → 临时加速，加速中按 ↑ / ↓ 换档（智能 / 1.5x / 2x / 3x）
                    </div>
                  </div>
                </div>

                {/*
                  视频增强：VSR 超分开关。**所有视频播放页共用**
                  （短剧 / 漫剧由 PlayerControls 接线，动漫由 AnimeVideoSurface 接线）。

                  ## 为什么放在这里而不是设置页
                  用户拨这个开关的时机永远是"正看着这一集"的时候。放在设置页等于
                  让人先退出播放器、改设置、再回来找进度 —— 而链路本身完全支持
                  原地重载（见 usePlaybackStore 里 `vsrSwitchRef` 那段）。

                  ## 视觉约束
                  浮层只用 `.crystal-flyout` / `.crystal-surface`，与清晰度、倍速
                  菜单同一套材质：`.ttv-video-stage` 内所有 backdrop-filter 被强制
                  关掉（crystal.css 第 122 行那条规则），所以这里不会把视频拉进
                  合成器、也不会再次踩到"增强失效"那个坑（不变量 26）。
                */}
                <div className="relative">
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      setShowEnhanceMenu(prev => !prev);
                      setShowQualityMenu(false);
                      setShowSpeedMenu(false);
                      setShowVolumeSlider(false);
                    }}
                    className={`btn-text-action${vsrEnabled ? ' is-on' : ''}`}
                    title="视频增强：VSR 超分（实时生效）"
                    aria-haspopup="dialog"
                    aria-expanded={showEnhanceMenu}
                    aria-controls="ttv-enhance-panel"
                  >
                    <Sparkles className="w-3.5 h-3.5" />
                    <span>增强</span>
                  </button>

                  <div
                    id="ttv-enhance-panel"
                    // `hudShown` 必须一起判：HUD 在 2.5 秒无指针活动后整体淡出，
                    // 而浮层自己的 `.open` 会把 `pointer-events` 恢复成 auto ——
                    // 只看 showEnhanceMenu 的话，用户读文案时不动鼠标，浮层淡出到
                    // 看不见，却仍有一块 292×~220px 在吃点击，误触直接切 VSR 并
                    // 重载本集。视频画面上的透明可点区域是这里最不能接受的东西。
                    className={`crystal-flyout crystal-surface ttv-enhance-flyout${showEnhanceMenu && hudShown ? ' open' : ''}`}
                    role="dialog"
                    aria-label="视频增强"
                    // 收起时整块 `inert`：既不可交互也不可聚焦。只靠 opacity:0 +
                    // pointer-events:none 的话，键盘 Tab 会落进一个看不见的对话框
                    // （清晰度菜单是既有实现，这里不复制那个缺口）。
                    inert={!showEnhanceMenu || !hudShown}
                  >
                    <div className="ttv-enhance-head">
                      <span className="ttv-enhance-head-title">视频增强</span>
                      <span className="ttv-enhance-head-hint">
                        {vsrAppliesToSource ? '切换后立即重载本集' : '只作用于短剧 / 漫剧'}
                      </span>
                    </div>

                    <button
                      type="button"
                      role="switch"
                      aria-checked={vsrEnabled}
                      aria-label="VSR 视频增强"
                      aria-describedby="ttv-enhance-vsr-desc"
                      // 浮层收起时内部控件不可聚焦：隐藏但可 Tab 到等于让键盘用户
                      // 掉进一个看不见的对话框（清晰度菜单是既有实现，这里不复制它）。
                      tabIndex={showEnhanceMenu ? 0 : -1}
                      onClick={() => onToggleVsr(!vsrEnabled)}
                      className="ttv-enhance-row"
                    >
                      <span className="ttv-enhance-label">
                        <span className="ttv-enhance-title">VSR 视频增强</span>
                        <span className="ttv-enhance-desc" id="ttv-enhance-vsr-desc">
                          {vsrAppliesToSource
                            ? '转成 H.264 分片交给 NVIDIA 驱动超分；关闭后回退到未增强的旧链路（起播更快）。驱动侧是否超分仍由 NVIDIA App 决定。'
                            : '动漫源不经转码链路，此开关不影响当前播放。'}
                        </span>
                      </span>
                      <span className={`ttv-enhance-switch${vsrEnabled ? ' is-on' : ''}`} aria-hidden="true">
                        <span className="ttv-enhance-knob" />
                      </span>
                    </button>
                  </div>
                </div>

                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    onOpenEpisodes();
                  }}
                  className="btn-text-action"
                  title="打开选集"
                >
                  <Layers className="w-3.5 h-3.5" />
                  <span>选集</span>
                </button>

                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    onEnterPip();
                  }}
                  className="btn-fluent-action"
                  title="画中画小窗播放（可拖动、可拉伸改大小）"
                  aria-label="画中画小窗播放"
                >
                  <PictureInPicture2 className="w-4 h-4" />
                </button>

                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    onToggleFullscreen();
                  }}
                  className="btn-fluent-action"
                  title={isFullscreen ? '退出全屏 (F / Esc)' : '进入全屏 (F)'}
                  aria-label={isFullscreen ? '退出全屏' : '进入全屏'}
                >
                  {isFullscreen ? (
                    <Minimize className="w-4 h-4" />
                  ) : (
                    <Maximize className="w-4 h-4" />
                  )}
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

/* ==========================================================================
   垂直音量柱（独立成件：拖拽逻辑自带 pointer capture，避免污染主控件的渲染）
   ========================================================================== */

interface VolumeControlProps {
  isMuted: boolean;
  volume: number;
  open: boolean;
  onToggle: () => void;
  onToggleMute: () => void;
  onVolumeChange: (value: number) => void;
}

export const VolumeControl: React.FC<VolumeControlProps> = ({
  isMuted,
  volume,
  open,
  onToggle,
  onToggleMute,
  onVolumeChange,
}) => {
  const trackRef = useRef<HTMLDivElement | null>(null);
  // 拖拽中的即时读数。父级 volume 要等 store 回写，直接读它会让滚轮数字慢半拍。
  const [dragValue, setDragValue] = useState<number | null>(null);

  const effective = isMuted ? 0 : (dragValue ?? volume);
  const percent = Math.max(0, Math.min(100, Math.round(effective * 100)));

  const applyFromClientY = useCallback((clientY: number) => {
    const el = trackRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const ratio = 1 - Math.max(0, Math.min(1, (clientY - rect.top) / rect.height));
    setDragValue(ratio);
    onVolumeChange(ratio);
  }, [onVolumeChange]);

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.stopPropagation();
    // 用 pointer capture 而不是往 window 上挂监听：
    // 指针一旦滑出这个 24px 宽的小条，仍能继续拖动，且松手时不残留监听器。
    e.currentTarget.setPointerCapture(e.pointerId);
    applyFromClientY(e.clientY);
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!e.currentTarget.hasPointerCapture(e.pointerId)) return;
    applyFromClientY(e.clientY);
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      // 指针已释放时忽略
    }
    setDragValue(null);
  };

  return (
    <div className="relative">
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onToggle();
        }}
        className="btn-fluent-action"
        title={isMuted || volume === 0 ? '点击调节音量（当前静音）' : '音量调节'}
        aria-label="音量调节"
        aria-expanded={open}
      >
        {isMuted || volume === 0 ? (
          <VolumeX className="w-4 h-4" />
        ) : (
          <Volume2 className="w-4 h-4" />
        )}
      </button>

      <div
        className={`crystal-volume-bubble crystal-surface${open ? ' open' : ''}`}
        onClick={(e) => e.stopPropagation()}
      >
        <RollingPercent value={percent} instant={dragValue !== null} />

        {/* 垂直音量轨道：下方蓝色填充，上方灰色未激活 */}
        <div
          ref={trackRef}
          className="vol-track-vertical"
          role="slider"
          tabIndex={0}
          aria-label="音量"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerUp}
          onKeyDown={(e) => {
            if (e.key === 'ArrowUp') {
              e.preventDefault();
              onVolumeChange(Math.min(1, volume + 0.05));
            } else if (e.key === 'ArrowDown') {
              e.preventDefault();
              onVolumeChange(Math.max(0, volume - 0.05));
            }
          }}
        >
          <div className="vol-track-bg" />
          {/* 填充条固定满高，用 scaleY 表达比例：逐帧改 height 会触发重排 */}
          <div className="vol-track-fill" style={{ transform: `scaleY(${percent / 100})` }} />
          <div className="vol-track-thumb" style={{ bottom: `${percent}%` }} />
        </div>

        {/* 底部喇叭：静音 / 恢复 */}
        <button
          type="button"
          className="vol-mute-btn"
          onClick={(e) => {
            e.stopPropagation();
            // 静音不是"音量置 0"的等价物：store 里另有 muted 标志，
            // 拖动音量条会解除静音，而点这里只切换标志。所以复用它自己的开关。
            onToggleMute();
          }}
          title={isMuted || volume === 0 ? '恢复音量' : '静音'}
          aria-label={isMuted || volume === 0 ? '恢复音量' : '静音'}
        >
          {isMuted || volume === 0 ? (
            <VolumeX className="w-3.5 h-3.5" />
          ) : (
            <Volume2 className="w-3.5 h-3.5" />
          )}
        </button>
      </div>
    </div>
  );
};

/* ==========================================================================
   收起态的贴边迷你进度条
   ========================================================================== */

interface MiniProgressProps {
  position: number;
  duration: number;
  buffered: number;
  /**
   * 是否露面（控制条收起 / 锁定时为 true）。
   *
   * 由组件自己内联控制，不再只依赖祖先的 `.is-locked` / `.is-auto-hidden`
   * 类（2026-10-19 修「收起后进度条有几率消失」）：那两条类由 PlayerHud 挂在外
   * 层容器上，任何一次类名抖动或判定分支漏挂，细条就会永久停在 `opacity: 0`
   * —— 而它恰恰是收起态唯一的位置反馈，消失了用户就没有任何进度可看。
   * 内联样式优先级高于类，判定与渲染在同一个表达式里，不可能对不上。
   */
  visible: boolean;
}

/**
 * 控制器收起后贴着窗口最底部的一条 3.5px 进度条。
 *
 * **只作进度显示，不接受任何操作**——锁定态的语义是"除解锁外一切输入失效"
 * （单击/双击画面、快捷键、长按倍速都已屏蔽，这里若还能拖动跳转就成了漏网
 * 的操作入口）。历史版本曾支持收起态拖动找位置，与锁定语义冲突，已收回。
 *
 * 进度改用 scaleX 而非宽度：播放中它每 250ms 更新一次，改 width 会带动
 * 重排，而 transform 只在合成层。
 *
 * 时长尚未就绪（duration ≤ 0）时**不能把已播段也画成 0**：源刚起播的那几秒、
 * 或后端返回的容器还没解析出时长时，整条会只剩底轨 —— 用户看到的是"进度条
 * 不见了"。这种情况按"已加载但未知进度"处理，铺一段低饱和度填充，
 * 至少让人看得出这里有一条进度条。
 */
export const MiniProgress: React.FC<MiniProgressProps> = ({
  position,
  duration,
  buffered,
  visible,
}) => {
  /**
   * 挂载与关键状态各留一条痕。
   *
   * 「进度条消失了」这个症状在代码层反复查不出来，是因为**渲染与否**和
   * **看得见与否**是两件事：元素可能在，只是被父层透明度 / 裁剪 / 层叠吃掉。
   * 有了这两行，下一次现场就能直接分辨：
   *   - 完全没有这行 → 组件根本没挂载（上层条件渲染问题）；
   *   - 有挂载行但看不见 → 纯视觉层问题（截图时对照 opacity/尺寸）。
   */
  useEffect(() => {
    tracePlayback(
      `贴边进度条挂载 visible=${visible} 位置=${Number.isFinite(position) ? position.toFixed(2) : 'NaN'} 时长=${Number.isFinite(duration) ? duration.toFixed(1) : 'NaN'}`,
    );
  }, []);
  // duration 未就绪时不算百分比（除零会得到 NaN，scaleX(NaN) 会让整条消失）。
  const hasDuration = Number.isFinite(duration) && duration > 0;
  /**
   * 比例必须**有限**：`video.currentTime` 在 MSE 重新 attach 的那一瞬间会短暂读成
   * `NaN`，一路传下来就是 `Math.min(1, NaN) = NaN` → `scaleX(NaN)` 让已播段
   * 整个不渲染（不是变 0，是"这条线没了"）。所有比例统一在这里收口。
   */
  const safeRatio = (value: number): number => {
    if (!hasDuration || !Number.isFinite(value)) return 0;
    return Math.max(0, Math.min(100, (value / duration) * 100));
  };
  const percent = safeRatio(position);
  const bufferPercent = safeRatio(buffered);

  return (
    <div
      aria-hidden
      className="ttv-mini-progress"
      style={{
        opacity: visible ? 1 : 0,
        transform: visible ? 'translateY(0)' : 'translateY(100%)',
      }}
    >
      <div className="ttv-mini-buffer" style={{ width: `${bufferPercent}%` }} />
      {hasDuration ? (
        <div className="ttv-mini-played" style={{ transform: `scaleX(${percent / 100})` }} />
      ) : (
        // 时长未知：铺一段固定宽度的弱化填充，明确"在加载"而不是"什么都没有"。
        <div className="ttv-mini-played is-unknown" />
      )}
    </div>
  );
};
