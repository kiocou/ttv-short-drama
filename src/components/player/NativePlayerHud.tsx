import React, { useCallback, useEffect, useRef, useState } from 'react';
import { DANMAKU_APPEARANCE_DEFAULTS } from '../../services/ipc';
import {
  fetchNativePlayerState,
  readNativePlayerPort,
  sendNativePlayerCommand,
  type NativePlayerCommand,
  type NativePlayerState,
} from '../../services/nativePlayerBridge';
import { FALLBACK_QUALITY_OPTIONS, MiniProgress, PlayerHud } from './PlayerHud';

export const NativePlayerHud: React.FC = () => {
  const port = readNativePlayerPort(window.location.search);
  const [state, setState] = useState<NativePlayerState | null>(null);
  const [error, setError] = useState('');
  const [isVisible, setIsVisible] = useState(true);
  const focusRef = useRef<HTMLDivElement | null>(null);
  const lastAudibleVolume = useRef(80);
  const hideTimer = useRef<number | null>(null);

  const showControls = useCallback(() => {
    setIsVisible(true);
    if (hideTimer.current !== null) window.clearTimeout(hideTimer.current);
    if (state?.playing) {
      hideTimer.current = window.setTimeout(() => setIsVisible(false), 2500);
    }
  }, [state?.playing]);

  useEffect(() => {
    focusRef.current?.focus();
  }, []);

  useEffect(() => {
    if (port === null) {
      setError('播放器控制连接无效。');
      return;
    }

    let active = true;
    let timer: number | null = null;
    const poll = async () => {
      try {
        const next = await fetchNativePlayerState(port);
        if (!active) return;
        setState(next);
        setError('');
      } catch (problem) {
        if (!active) return;
        setError(problem instanceof Error ? problem.message : '无法读取播放器状态。');
      } finally {
        if (active) timer = window.setTimeout(poll, 150);
      }
    };
    void poll();
    return () => {
      active = false;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [port]);

  useEffect(() => {
    if (!state?.playing) {
      setIsVisible(true);
      if (hideTimer.current !== null) window.clearTimeout(hideTimer.current);
      hideTimer.current = null;
    }
    return () => {
      if (hideTimer.current !== null) window.clearTimeout(hideTimer.current);
    };
  }, [state?.playing]);

  const command = useCallback(async (value: NativePlayerCommand) => {
    if (port === null) return;
    showControls();
    try {
      await sendNativePlayerCommand(port, value);
      setError('');
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : '播放器控制命令失败。');
    }
  }, [port, showControls]);

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    if (target.closest('input, select, textarea, [role="slider"]')) return;
    if (event.key === ' ') { event.preventDefault(); void command({ action: 'pause' }); }
    else if (event.key === 'ArrowLeft') { event.preventDefault(); void command({ action: 'seek', pos: Math.max(0, (state?.position ?? 0) - 5) }); }
    else if (event.key === 'ArrowRight') { event.preventDefault(); void command({ action: 'seek', pos: Math.min(state?.duration ?? 0, (state?.position ?? 0) + 5) }); }
    else if (event.key === 'f' || event.key === 'F' || event.key === 'F11') { event.preventDefault(); void command({ action: 'fullscreen' }); }
    else if (event.key === 'Escape' && state?.fullscreen) { event.preventDefault(); void command({ action: 'fullscreen' }); }
    else if (event.key === 'b' || event.key === 'B') { event.preventDefault(); void command({ action: 'fg', on: !state?.frameInterpolation, mult: state?.frameMultiplier ?? 2 }); }
    else if (/^[2-5]$/.test(event.key)) { event.preventDefault(); void command({ action: 'fg', on: true, mult: Number(event.key) }); }
    else if (event.key === '[') { event.preventDefault(); void command({ action: 'prev' }); }
    else if (event.key === ']') { event.preventDefault(); void command({ action: 'next' }); }
  };

  if (!state) {
    return (
      <div className="native-player-hud-state" role={error ? 'alert' : 'status'}>
        {error || '正在连接播放器…'}
      </div>
    );
  }

  const volume = state.volume / 100;
  const muted = state.volume <= 0;

  return (
    <div ref={focusRef} tabIndex={-1} aria-label="原生视频播放控制" className="native-player-hud-root" onMouseMove={showControls} onKeyDown={handleKeyDown}>
      <PlayerHud
        title={state.title}
        hideHeader
        episodeLabel={`第 ${state.episode} 集`}
        position={state.position}
        duration={state.duration}
        buffered={state.position}
        isPlaying={state.playing}
        isFullscreen={state.fullscreen}
        isVisible={isVisible}
        isLocked={false}
        volume={volume}
        isMuted={muted}
        playbackRate={state.speed}
        currentQuality="auto"
        qualityOptions={FALLBACK_QUALITY_OPTIONS}
        vsrEnabled={false}
        hideVsr
        frameInterpolation={{
          enabled: state.frameInterpolation,
          multiplier: state.frameMultiplier,
          onEnabledChange: enabled => void command({ action: 'fg', on: enabled, mult: state.frameMultiplier }),
          onMultiplierChange: multiplier => void command({ action: 'fg', on: true, mult: multiplier }),
        }}
        danmakuEnabled={false}
        danmakuAvailable={false}
        danmakuAppearance={DANMAKU_APPEARANCE_DEFAULTS}
        onToggleDanmaku={() => undefined}
        onDanmakuAppearanceChange={() => undefined}
        vsrAppliesToSource={false}
        onToggleVsr={() => undefined}
        onToggleLock={() => undefined}
        onEnterPip={() => undefined}
        showPip={false}
        onClose={() => void command({ action: 'quit' })}
        showClose
        showEpisodes={false}
        onToggleFullscreen={() => void command({ action: 'fullscreen' })}
        onUserActivity={showControls}
        onPointerMove={showControls}
        onTogglePlay={() => void command({ action: 'pause' })}
        onSeek={(position, previewing) => {
          if (!previewing) void command({ action: 'seek', pos: position });
        }}
        onSeekRelative={delta => void command({ action: 'seek', pos: Math.max(0, Math.min(state.duration, state.position + delta)) })}
        onVolumeChange={value => {
          const next = Math.round(value * 100);
          if (next > 0) lastAudibleVolume.current = next;
          void command({ action: 'volume', v: next });
        }}
        onToggleMute={() => {
          if (muted) {
            const restore = lastAudibleVolume.current || 80;
            void command({ action: 'volume', v: restore });
          } else {
            lastAudibleVolume.current = state.volume;
            void command({ action: 'volume', v: 0 });
          }
        }}
        onPlaybackRate={rate => void command({ action: 'speed', rate })}
        onQualityChange={() => undefined}
        onPlayPrev={() => void command({ action: 'prev' })}
        onPlayNext={() => void command({ action: 'next' })}
        onOpenEpisodes={() => undefined}
        onBack={() => undefined}
      />
      {!isVisible && <MiniProgress position={state.position} duration={state.duration} buffered={state.position} visible />}
      {error && <div className="native-player-hud-error" role="status">{error}</div>}
    </div>
  );
};
