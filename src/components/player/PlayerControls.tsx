import React from 'react';
import { usePlaybackStore } from '../../stores/usePlaybackStore';
import { useAppStore } from '../../stores/useAppStore';
import { PlayerHud } from './PlayerHud';

/**
 * 短剧 / 漫剧播放器的控制层适配器。
 *
 * 外观已经全部搬到 `PlayerHud`（与动漫专区共用同一套晶体材质），这里只剩两件事：
 * 从 `usePlaybackStore` 取状态、把用户操作映射回 store 的方法。加新样式请改
 * PlayerHud——两个播放器的观感从此只有一处来源。
 */

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

  const { goBack } = useAppStore();

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

  return (
    <PlayerHud
      title={currentSeries?.title || '精彩短剧'}
      episodeLabel={episodeBadge}
      position={position}
      duration={duration}
      buffered={buffered}
      isPlaying={isPlaying}
      isFullscreen={isFullscreen}
      isVisible={isVisible}
      isLocked={isLocked}
      volume={volume}
      isMuted={isMuted}
      playbackRate={playbackRate}
      currentQuality={currentQuality}
      qualityOptions={availableQualities}
      onToggleLock={onToggleLock}
      onToggleFullscreen={onToggleFullscreen}
      onUserActivity={onUserActivity}
      onPointerMove={onPointerMove}
      onTogglePlay={togglePlay}
      onSeek={seek}
      onSeekRelative={seekRelative}
      onVolumeChange={setVolume}
      onToggleMute={toggleMute}
      onPlaybackRate={setPlaybackRate}
      onQualityChange={setQuality}
      onPlayPrev={playPrevEpisode}
      onPlayNext={playNextEpisode}
      onOpenEpisodes={() => toggleSideDrawer()}
      onBack={goBack}
    />
  );
};
