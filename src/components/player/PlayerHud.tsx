import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ProgressBar } from './ProgressBar';
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
} from 'lucide-react';

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

const SPEED_OPTIONS = [0.75, 1.0, 1.25, 1.5, 2.0];

export interface PlayerHudProps {
  /** 顶部标题岛：剧名。 */
  title: string;
  /** 集数徽章文案（已格式化，例如"第 3 集 · 真相"）。 */
  episodeLabel: string;
  /** 返回按钮的 tooltip（短剧是"返回剧集列表"，动漫是"返回详情"）。 */
  backTitle?: string;

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
  currentQuality: string;
  qualityOptions: PlayerQualityOption[];

  onToggleLock: () => void;
  /** 交给画中画小窗播放（独立置顶窗口，可拖动、可拉伸改大小）。 */
  onEnterPip: () => void;
  onToggleFullscreen: () => void;
  onUserActivity: () => void;
  /** 指针移动统一入口（带合成事件过滤），容器层已过滤后传入。 */
  onPointerMove?: (e: React.MouseEvent) => void;

  onTogglePlay: () => void;
  onSeek: (seconds: number) => void;
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
  currentQuality,
  qualityOptions,
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

  const controlsRef = useRef<HTMLDivElement | null>(null);

  // 点击外部自动关闭下拉菜单与音量条
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (controlsRef.current && !controlsRef.current.contains(e.target as Node)) {
        setShowQualityMenu(false);
        setShowSpeedMenu(false);
        setShowVolumeSlider(false);
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
    }
  }, [isLocked]);

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
        收起态的贴边迷你进度条。
        放在 HUD 之外：HUD 整体淡出时它才刚登场，必须独立于那层透明度。
      */}
      <MiniProgress
        isLocked={isLocked}
        position={position}
        duration={duration}
        buffered={buffered}
        onSeek={onSeek}
      />

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
            {/* 进度槽内嵌于卡片顶部 */}
            <ProgressBar position={position} duration={duration} buffered={buffered} onSeek={onSeek} />

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

                {/* 机械滚轮时间读数 */}
                <div className="ttv-time" aria-label={`已播放 ${Math.floor(position)} 秒，共 ${Math.floor(duration)} 秒`}>
                  <RollingTime value={position} />
                  <span className="time-sep">/</span>
                  <RollingTime value={duration} variant="duration" />
                </div>
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
                    }}
                    className="btn-text-action"
                    title="切换播放倍速"
                  >
                    {playbackRate === 1 ? '倍速' : `${playbackRate}x`}
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
  isLocked: boolean;
  position: number;
  duration: number;
  buffered: number;
  onSeek: (seconds: number) => void;
}

/**
 * 控制器收起后贴着窗口最底部的一条 3.5px 进度条。
 *
 * 比设计稿多做了两件事：
 *   1. 支持按住拖动（稿子里只能点击）——收起态的意图就是"少遮挡、但要能找位置"，
 *      只能点击等于逼用户一遍遍点。
 *   2. 进度改用 scaleX 而非宽度：播放中它每 250ms 更新一次，改 width 会带动
 *      重排，而 transform 只在合成层。
 */
export const MiniProgress: React.FC<MiniProgressProps> = ({
  isLocked,
  position,
  duration,
  buffered,
  onSeek,
}) => {
  const barRef = useRef<HTMLDivElement | null>(null);
  const [dragging, setDragging] = useState(false);

  const percent = duration > 0 ? Math.max(0, Math.min(100, (position / duration) * 100)) : 0;
  const bufferPercent = duration > 0 ? Math.max(0, Math.min(100, (buffered / duration) * 100)) : 0;

  const applyFromClientX = useCallback((clientX: number) => {
    const el = barRef.current;
    if (!el || duration <= 0) return;
    const rect = el.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    onSeek(ratio * duration);
  }, [duration, onSeek]);

  return (
    <div
      ref={barRef}
      role="slider"
      tabIndex={isLocked ? 0 : -1}
      aria-label="播放进度"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(percent)}
      aria-hidden={!isLocked}
      onClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => {
        if (!isLocked) return;
        e.stopPropagation();
        e.currentTarget.setPointerCapture(e.pointerId);
        setDragging(true);
        applyFromClientX(e.clientX);
      }}
      onPointerMove={(e) => {
        if (!dragging) return;
        applyFromClientX(e.clientX);
      }}
      onPointerUp={(e) => {
        if (!dragging) return;
        try {
          e.currentTarget.releasePointerCapture(e.pointerId);
        } catch {
          // 已释放则忽略
        }
        setDragging(false);
      }}
      onKeyDown={(e) => {
        if (!isLocked) return;
        if (e.key === 'ArrowLeft') {
          e.preventDefault();
          onSeek(Math.max(0, position - 5));
        } else if (e.key === 'ArrowRight') {
          e.preventDefault();
          onSeek(Math.min(duration, position + 5));
        }
      }}
      className="ttv-mini-progress"
    >
      <div className="ttv-mini-buffer" style={{ width: `${bufferPercent}%` }} />
      <div className="ttv-mini-played" style={{ transform: `scaleX(${percent / 100})` }} />
    </div>
  );
};
