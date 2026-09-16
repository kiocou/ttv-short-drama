import React, { useState, useRef, useEffect, useCallback } from 'react';
import { usePlaybackStore } from '../../stores/usePlaybackStore';
import { useAppStore } from '../../stores/useAppStore';
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
  Minimize,
  ArrowLeft,
  Layers,
  Lock,
  LockOpen,
} from 'lucide-react';

interface PlayerControlsProps {
  isVisible: boolean;
  isFullscreen: boolean;
  /** 控制器是否被用户主动收起（锁定）。 */
  isLocked: boolean;
  onToggleLock: () => void;
  onToggleFullscreen: () => void;
  onUserActivity: () => void;
  /** 指针移动统一入口（带合成事件过滤），容器层已按真实位移过滤后传入。 */
  onPointerMove?: (e: React.MouseEvent) => void;
}

export const PlayerControls: React.FC<PlayerControlsProps> = ({
  isVisible,
  isFullscreen,
  isLocked,
  onToggleLock,
  onToggleFullscreen,
  onUserActivity,
  onPointerMove,
}) => {
  const {
    currentSeries,
    currentEpisode,
    isPlaying,
    position,
    duration,
    buffered,
    volume,
    isMuted,
    playbackRate,
    currentQuality,
    togglePlay,
    seek,
    seekRelative,
    setVolume,
    toggleMute,
    setPlaybackRate,
    setQuality,
    playNextEpisode,
    playPrevEpisode,
    toggleSideDrawer,
    availableQualities,
  } = usePlaybackStore();

  const { goBack, showToast } = useAppStore();

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

  const speedOptions = [0.75, 1.0, 1.25, 1.5, 2.0];
  // 清晰度档位以「源流真实提供」为准：优先用后端探测到的 variants，
  // 探测未完成或源只有一路时只显示"自动"。绝不虚构 4K/1080P 这类
  // 源里不存在的档位——那只会触发无意义的重复下载。
  const qualityOptions = availableQualities.length > 0
    ? availableQualities
    : [{ label: '自动', value: 'auto', resolution: '由播放源自动选择' }];
  // 单档位时禁用切换（点了也没得选，徒增困惑）。
  const qualitySelectable = qualityOptions.length > 1;
  // 集数徽章文案。
  //
  // 后端在缺少真实分集标题时会把 title 填成"第 N 集"（见 provider.rs 的
  // 详情解析），直接拼接就会显示成"第 1 集 · 第 1 集"。标题与集数基名
  // 等价时不再重复；将来接入真实分集标题时会自动显示成"第 3 集 · 真相"。
  const episodeBadge = (() => {
    if (!currentEpisode) return '第 1 集';
    const base = `第 ${currentEpisode.episodeNumber} 集`;
    const title = (currentEpisode.title || '').trim();
    return title && title !== base ? `${base} · ${title}` : base;
  })();

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
        onSeek={seek}
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
                goBack();
              }}
              className="btn-fluent-action"
              title="返回剧集列表"
              aria-label="返回剧集列表"
            >
              <ArrowLeft className="w-4 h-4" />
            </button>

            <div className="crystal-divider" />

            <div className="flex items-center gap-2 pr-1.5 min-w-0">
              <span className="drama-title">{currentSeries?.title || '精彩短剧'}</span>
              <span className="episode-badge">{episodeBadge}</span>
            </div>
          </div>

        </div>

        {/* 底部操控坞：进度槽与控件同处一张晶体大卡片 */}
        <div className="ttv-dock" onClick={(e) => e.stopPropagation()}>
          <div ref={controlsRef} className="mica-crystal-card crystal-surface">
            {/* 进度槽内嵌于卡片顶部 */}
            <ProgressBar position={position} duration={duration} buffered={buffered} onSeek={seek} />

            <div className="controls-deck-row">
              {/* 左侧：集数切换、快进快退、播放主键、滚轮时间读数 */}
              <div className="flex items-center gap-3 min-w-0">
                <div className="flex items-center gap-0.5">
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      playPrevEpisode();
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
                      seekRelative(-5);
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
                      togglePlay();
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
                      seekRelative(5);
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
                      playNextEpisode();
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

              {/* 右侧：音量、清晰度、倍速、超分、选集、全屏 */}
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
                  onToggleMute={toggleMute}
                  onVolumeChange={(v) => setVolume(v)}
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
                    {qualityOptions.find(q => q.value === currentQuality)?.label.split(' ')[0]
                      || qualityOptions[0]?.label.split(' ')[0]
                      || '自动'}
                  </button>

                  {qualitySelectable && (
                    <div className={`crystal-flyout crystal-surface${showQualityMenu ? ' open' : ''}`}>
                      {qualityOptions.map((opt, index) => (
                        <button
                          key={`${opt.value}-${index}`}
                          type="button"
                          onClick={() => {
                            setQuality(opt.value);
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
                    {speedOptions.map((rate) => (
                      <button
                        key={rate}
                        type="button"
                        onClick={() => {
                          setPlaybackRate(rate);
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
                    toggleSideDrawer();
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

const VolumeControl: React.FC<VolumeControlProps> = ({
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
const MiniProgress: React.FC<MiniProgressProps> = ({
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