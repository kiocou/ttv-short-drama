import React, { useState, useRef, useEffect } from 'react';
import { usePlaybackStore } from '../../stores/usePlaybackStore';
import { useEnhancementStore } from '../../stores/useEnhancementStore';
import { useAppStore } from '../../stores/useAppStore';
import { ProgressBar } from './ProgressBar';
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
  Sparkles
} from 'lucide-react';

interface PlayerControlsProps {
  isVisible: boolean;
  isFullscreen: boolean;
  onToggleFullscreen: () => void;
  onUserActivity: () => void;
}

function formatTime(seconds: number): string {
  if (isNaN(seconds) || seconds < 0) return '00:00';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
}

export const PlayerControls: React.FC<PlayerControlsProps> = ({
  isVisible,
  isFullscreen,
  onToggleFullscreen,
  onUserActivity,
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

  const { goBack } = useAppStore();
  const { uiState: enhancementState, currentFps } = useEnhancementStore();

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

  const speedOptions = [0.75, 1.0, 1.25, 1.5, 2.0];
  // 清晰度档位以「源流真实提供」为准：优先用后端探测到的 variants，
  // 探测未完成或源只有一路时只显示"自动"。绝不虚构 4K/1080P 这类
  // 源里不存在的档位——那只会触发无意义的重复下载。
  const qualityOptions = availableQualities.length > 0
    ? availableQualities
    : [{ label: '自动', value: 'auto', resolution: '由播放源自动选择' }];
  // 单档位时禁用切换（点了也没得选，徒增困惑）。
  const qualitySelectable = qualityOptions.length > 1;
  const enhancementLabel = enhancementState.kind === 'running'
    ? `${enhancementState.engine} ${currentFps > 0 ? `${currentFps.toFixed(1)} FPS` : '运行中'}`
    : enhancementState.kind === 'warming'
      ? `${enhancementState.engine} 预热中`
      : enhancementState.kind === 'degraded'
        ? '增强已降级'
        : '原始播放';

  return (
    <div
      onMouseMove={onUserActivity}
      className={`absolute inset-0 pointer-events-none z-30 flex flex-col justify-between p-6 transition-opacity duration-300 select-none ${
        isVisible ? 'opacity-100' : 'opacity-0'
      }`}
    >
      {/* 顶部悬浮栏：纯净统一扁平化磨砂玻璃标题岛与高画质状态胶囊 */}
      <div className="flex items-center justify-between pointer-events-auto">
        <div className="inline-flex items-center gap-2.5 p-1.5 bg-white/90 backdrop-blur-2xl rounded-2xl border border-white/80 shadow-fluent-hud transition-all duration-200">
          {/* 返回按钮 */}
          <button
            onClick={(e) => {
              e.stopPropagation();
              goBack();
            }}
            className="w-8 h-8 rounded-xl bg-white hover:bg-blue-50 text-slate-700 hover:text-blue-600 flex items-center justify-center transition-all duration-150 shadow-xs active:scale-95 cursor-pointer"
            title="返回剧集列表"
          >
            <ArrowLeft className="w-4 h-4" />
          </button>

          {/* 分隔细线 */}
          <div className="w-[1px] h-5 bg-slate-300/60" />

          {/* 剧集主标题与当前集数徽章 */}
          <div className="flex items-center gap-2 pr-3">
            <span className="text-xs font-bold text-slate-900 tracking-tight max-w-[240px] sm:max-w-md truncate">
              {currentSeries?.title || '精彩短剧'}
            </span>
            <span className="text-[11px] font-semibold text-blue-600 bg-blue-50/90 px-2.5 py-0.5 rounded-lg border border-blue-200/60 shadow-xs flex-shrink-0">
              {currentEpisode ? `第 ${currentEpisode.episodeNumber} 集 · ${currentEpisode.title}` : '第 1 集'}
            </span>
          </div>
        </div>

        {/* 右上角：后端报告的增强运行状态 */}
        <div className="inline-flex items-center gap-1.5 px-3.5 py-2 bg-white/90 backdrop-blur-2xl rounded-2xl border border-white/80 shadow-fluent-hud text-[11px] font-semibold text-slate-700 shadow-xs transition-all duration-200">
          <Sparkles className="w-3.5 h-3.5 text-amber-500 animate-pulse" />
          <span>{enhancementLabel}</span>
        </div>
      </div>

      {/* 底部悬浮操控岛 (统一纯净磨砂玻璃 Acrylic HUD) */}
      <div
        ref={controlsRef}
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-4xl mx-auto flex flex-col gap-2 pointer-events-auto"
      >
        {/* 时间进度条 */}
        <div className="px-2">
          <ProgressBar
            position={position}
            duration={duration}
            buffered={buffered}
            onSeek={seek}
          />
        </div>

        {/* 核心控制栏：单一平整通透的磨砂玻璃底色，消除中间空隙凹沉色差 */}
        <div className="h-15 px-4.5 rounded-2xl bg-white/90 backdrop-blur-2xl border border-white/80 shadow-fluent-hud flex items-center justify-between gap-4">
          {/* 左侧控制区：播放、上一集、下一集、快进快退 */}
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-1">
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  playPrevEpisode();
                }}
                className="p-2 rounded-xl text-slate-700 hover:text-slate-950 hover:bg-slate-100/80 transition-colors fluent-press cursor-pointer"
                title="上一集 (快捷键 [ )"
              >
                <SkipBack className="w-4 h-4" />
              </button>

              <button
                onClick={(e) => {
                  e.stopPropagation();
                  seekRelative(-5);
                }}
                className="p-2 rounded-xl text-slate-700 hover:text-slate-950 hover:bg-slate-100/80 transition-colors fluent-press cursor-pointer"
                title="后退 5 秒 (快捷键 ←)"
              >
                <RotateCcw className="w-4 h-4" />
              </button>

              <button
                onClick={(e) => {
                  e.stopPropagation();
                  togglePlay();
                }}
                className="w-9 h-9 rounded-xl bg-blue-600 hover:bg-blue-700 text-white flex items-center justify-center shadow-md shadow-blue-500/25 transition-transform active:scale-95 mx-1 cursor-pointer"
                title={isPlaying ? '暂停 (空格)' : '播放 (空格)'}
              >
                {isPlaying ? (
                  <Pause className="w-4.5 h-4.5 fill-current" />
                ) : (
                  <Play className="w-4.5 h-4.5 fill-current ml-0.5" />
                )}
              </button>

              <button
                onClick={(e) => {
                  e.stopPropagation();
                  seekRelative(5);
                }}
                className="p-2 rounded-xl text-slate-700 hover:text-slate-950 hover:bg-slate-100/80 transition-colors fluent-press cursor-pointer"
                title="快进 5 秒 (快捷键 →)"
              >
                <RotateCw className="w-4 h-4" />
              </button>

              <button
                onClick={(e) => {
                  e.stopPropagation();
                  playNextEpisode();
                }}
                className="p-2 rounded-xl text-slate-700 hover:text-slate-950 hover:bg-slate-100/80 transition-colors fluent-press cursor-pointer"
                title="下一集 (快捷键 ] )"
              >
                <SkipForward className="w-4 h-4" />
              </button>
            </div>

            {/* 分隔细线 */}
            <div className="w-[1px] h-5 bg-slate-300/60" />

            {/* 时间显示 */}
            <div className="text-xs font-mono font-semibold text-slate-700 select-none px-1">
              <span>{formatTime(position)}</span>
              <span className="mx-1 text-slate-400 font-normal">/</span>
              <span>{formatTime(duration)}</span>
            </div>
          </div>

          {/* 右侧控制区：音量、清晰度、倍速、选集、全屏 */}
          <div className="flex items-center gap-1">
            {/* 音量控制按钮与向上弹出的垂直滑块气泡 */}
            <div className="relative">
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  setShowVolumeSlider(prev => !prev);
                  setShowQualityMenu(false);
                  setShowSpeedMenu(false);
                }}
                className="p-2 rounded-xl text-slate-700 hover:text-slate-950 hover:bg-slate-100/80 transition-colors fluent-press cursor-pointer"
                title={isMuted ? '点击取消静音' : '音量调节'}
              >
                {isMuted || volume === 0 ? (
                  <VolumeX className="w-4 h-4 text-rose-500" />
                ) : (
                  <Volume2 className="w-4 h-4" />
                )}
              </button>

              {/* 严格向上弹出的垂直音量浮层 (Upward Flyout) */}
              {showVolumeSlider && (
                <div 
                  onClick={(e) => e.stopPropagation()}
                  className="absolute bottom-full mb-3 left-1/2 -translate-x-1/2 p-3 w-12 h-44 bg-white/90 backdrop-blur-2xl border border-white/80 rounded-2xl shadow-fluent-hud flex flex-col items-center justify-between z-50 animate-slide-up"
                >
                  <button
                    onClick={toggleMute}
                    className="text-[10px] font-mono font-bold text-slate-600 hover:text-blue-600 cursor-pointer"
                    title="点击静音/恢复"
                  >
                    {isMuted ? '0%' : `${Math.round(volume * 100)}%`}
                  </button>
                  <div className="h-28 flex items-center justify-center">
                    <input
                      type="range"
                      min="0"
                      max="1"
                      step="0.05"
                      value={isMuted ? 0 : volume}
                      onChange={(e) => setVolume(parseFloat(e.target.value))}
                      className="w-24 h-1.5 -rotate-90 accent-blue-600 cursor-pointer"
                    />
                  </div>
                  <Volume2 className="w-3.5 h-3.5 text-slate-400" />
                </div>
              )}
            </div>

            {/* 清晰度：仅当源真实提供多档时才可切换 */}
            <div className="relative">
              <button
                disabled={!qualitySelectable}
                onClick={(e) => {
                  e.stopPropagation();
                  if (!qualitySelectable) return;
                  setShowQualityMenu(prev => !prev);
                  setShowSpeedMenu(false);
                  setShowVolumeSlider(false);
                }}
                title={qualitySelectable ? '切换清晰度' : '当前播放源仅提供单一画质'}
                className={`px-2.5 py-1.5 rounded-xl text-xs font-semibold transition-colors ${
                  qualitySelectable
                    ? 'text-slate-700 hover:text-blue-600 hover:bg-slate-100/80 cursor-pointer'
                    : 'text-slate-400 cursor-default'
                }`}
              >
                {qualityOptions.find(q => q.value === currentQuality)?.label.split(' ')[0]
                  || qualityOptions[0]?.label.split(' ')[0]
                  || '自动'}
              </button>

              {showQualityMenu && qualitySelectable && (
                <div 
                  onClick={(e) => e.stopPropagation()}
                  className="absolute bottom-full mb-3 left-1/2 -translate-x-1/2 p-1.5 w-28 bg-white/90 backdrop-blur-2xl border border-white/80 rounded-2xl shadow-fluent-hud flex flex-col gap-1 z-50 animate-slide-up"
                >
                  {qualityOptions.map((opt, index) => (
                    <button
                      key={`${opt.value}-${index}`}
                      onClick={() => {
                        setQuality(opt.value);
                        setShowQualityMenu(false);
                      }}
                      className={`px-3 py-1.5 rounded-xl text-xs text-left font-medium transition-colors cursor-pointer ${
                        currentQuality === opt.value
                          ? 'bg-blue-600 text-white shadow-xs font-semibold'
                          : 'text-slate-700 hover:bg-slate-100/80'
                      }`}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* 倍速切换（严格向上弹出） */}
            <div className="relative">
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  setShowSpeedMenu(prev => !prev);
                  setShowQualityMenu(false);
                  setShowVolumeSlider(false);
                }}
                className="px-2.5 py-1.5 rounded-xl text-xs font-semibold text-slate-700 hover:text-blue-600 hover:bg-slate-100/80 transition-colors cursor-pointer"
              >
                {playbackRate === 1 ? '倍速' : `${playbackRate}x`}
              </button>

              {showSpeedMenu && (
                <div 
                  onClick={(e) => e.stopPropagation()}
                  className="absolute bottom-full mb-3 left-1/2 -translate-x-1/2 p-1.5 w-24 bg-white/90 backdrop-blur-2xl border border-white/80 rounded-2xl shadow-fluent-hud flex flex-col gap-1 z-50 animate-slide-up"
                >
                  {speedOptions.map((rate) => (
                    <button
                      key={rate}
                      onClick={() => {
                        setPlaybackRate(rate);
                        setShowSpeedMenu(false);
                      }}
                      className={`px-3 py-1.5 rounded-xl text-xs text-left font-medium transition-colors cursor-pointer ${
                        playbackRate === rate
                          ? 'bg-blue-600 text-white shadow-xs font-semibold'
                          : 'text-slate-700 hover:bg-slate-100/80'
                      }`}
                    >
                      {rate === 1.0 ? '1.0x 正常' : `${rate}x`}
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* 选集弹窗按钮（点击弹出居中选集窗口） */}
            <button
              onClick={(e) => {
                e.stopPropagation();
                toggleSideDrawer();
              }}
              className="flex items-center gap-1 px-2.5 py-1.5 rounded-xl text-xs font-semibold text-slate-700 hover:text-blue-600 hover:bg-slate-100/80 transition-colors cursor-pointer"
              title="打开选集弹窗窗口"
            >
              <Layers className="w-3.5 h-3.5" />
              <span>选集</span>
            </button>

            {/* 全屏按钮 */}
            <button
              onClick={(e) => {
                e.stopPropagation();
                onToggleFullscreen();
              }}
              className="p-2 rounded-xl text-slate-700 hover:text-slate-950 hover:bg-slate-100/80 transition-colors fluent-press cursor-pointer"
              title={isFullscreen ? '退出全屏 (F / Esc)' : '进入全屏 (F)'}
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
  );
};
