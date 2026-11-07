import React from 'react';
import { usePlaybackStore } from '../../stores/usePlaybackStore';
import { useSettingsStore } from '../../stores/useSettingsStore';
import { ipcService } from '../../services/ipc';
import { useAppStore } from '../../stores/useAppStore';
import { PlayerHud } from './PlayerHud';
import type { DanmakuSettings } from './PlayerHud';
import { Sparkles, Zap } from 'lucide-react';

/**
 * 短剧 / 漫剧播放器的控制层适配器。
 *
 * 外观已经全部搬到 `PlayerHud`（与动漫专区共用同一套晶体材质），这里只剩两件事：
 * 从 `usePlaybackStore` 取状态、把用户操作映射回 store 的方法。加新样式请改
 * PlayerHud——两个播放器的观感从此只有一处来源。
 */

/**
 * 「原生播放」入口开关（mpv + LSFG 补帧那套独立播放器）。
 *
 * 2026-11-01 按需求**暂时搁置**：新的原生播放器先不开发，播放页右上角那个
 * 入口不再显示。代码整体保留在这里 —— 它不是死代码，`handleOpenNative` 的
 * 链路（`ipcService.playback.nativeOpen` / 后端 `native_open`）都还是通的，
 * 将来要继续做只需要把这个常量改回 `true`。
 *
 * 顺带记一个当时的观感问题：按钮用的是 `ttv-lock crystal-surface` 那套晶体
 * 样式，而 `ttv-lock` 原本是给**正方形图标按钮**（锁）写的，宽度被压到只能
 * 放一个图标。塞进「原生播放」四个字之后文字被迫竖排折行，又贴着窗口右上角，
 * 看上去就是一块被裁掉的白方块 —— 这也是它显得难看的直接原因。恢复时请给它
 * 单独的类名，不要复用 `ttv-lock`。
 */
const NATIVE_PLAYER_ENTRY_ENABLED = false;

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
  /** 长按方向键加速时实际生效的速率（未加速为 null），仅用于展示。 */
  effectivePlaybackRate?: number | null;
}

export const PlayerControls: React.FC<PlayerControlsProps> = ({
  isVisible,
  isFullscreen,
  isLocked,
  onToggleLock,
  onToggleFullscreen,
  onUserActivity,
  onPointerMove,
  effectivePlaybackRate = null,
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
    vsrEnabled,
    setVsrEnabled,
    danmakuEnabled,
    setDanmakuEnabled,
    playNextEpisode,
    playPrevEpisode,
    toggleSideDrawer,
    availableQualities,
    enterPip,
  } = usePlaybackStore();

  // 补帧入口已在发布前移除（独立窗口方案不成熟：需要另起 D3D11 窗口、
  // 与主窗口两套音频/进度，且调试徽标漏在界面上）。后端 `frame_interp_set`
  // 命令保留但不再被前端调用。
  const { goBack } = useAppStore();

  /**
   * 弹幕观感设置（显示区域/不透明度/字号/速度/字体/粗体/描边）。
   *
   * 设置真相在 `useSettingsStore`，「弹幕设置」面板写它；`PlayerHud` 是纯呈现层
   * （文件头写明的边界：不读任何 store），所以在这里读好、以 props 喂下去。
   * 改动即时生效：滑条每动一格都走 `updateSettings`（面板当下重渲染 +
   * 异步落库），不需要"确认"按钮。
   */
  const { settings, updateSettings } = useSettingsStore();
  const danmakuAppearance: DanmakuSettings = {
    danmakuArea: settings.danmakuArea,
    danmakuOpacity: settings.danmakuOpacity,
    danmakuFontScale: settings.danmakuFontScale,
    danmakuSpeed: settings.danmakuSpeed,
    danmakuFont: settings.danmakuFont,
    danmakuColor: settings.danmakuColor,
    danmakuBold: settings.danmakuBold,
    danmakuStroke: settings.danmakuStroke,
  };

  /**
   * 进入画中画。
   *
   * 交接成功后**主窗口不离开播放器视图**，而是整窗隐藏（由 `PipReturnBridge`
   * 在收到 `pip://shown` 时执行）。这样"同一时刻只有一个窗口"：小窗先出画，
   * 主窗口再退场。
   *
   * 旧实现交接成功后立刻 `goBack()` 回主界面 —— 那正是空档的来源：播放界面
   * 先消失、主界面露出来，小窗还在加载，过一会儿才出现。
   *
   * 交接失败（后端拒绝、非桌面环境）则原地不动：把用户扔到一个空页面上更糟。
   */
  const handleEnterPip = async () => {
    await enterPip();
  };

  /**
   * 用原生播放器（mpv + LSFG 补帧）打开当前这一集。
   *
   * 为什么需要这条入口：WebView2 里的 `<video>` 只能播 H.264，红果 HEVC+CENC 源
   * 必须先整集转码（首帧 3~6 秒），而且补帧引擎根本捕获不到 WebView2。
   * 原生播放器直吃直链、自带补帧，首帧能进 1 秒内。
   *
   * 打开后**暂停本窗口的播放**：否则两套音频会同时出声。
   */
  const handleOpenNative = async () => {
    const ep = currentEpisode;
    if (!ep) return;
    try {
      await ipcService.playback.nativeOpen({
        vid: ep.id,
        seriesId: currentSeries?.id,
        episodeId: ep.id,
        title: currentSeries?.title ?? '',
        episode: ep.episodeNumber,
        startSeconds: position,
        volume: Math.round(volume * 100),
        fg: true,
        fgMult: 2,
      });
      if (isPlaying) togglePlay();
    } catch (error) {
      void ipcService.diagnostics.uiLog(
        `原生播放器打开失败 ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };

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
    <>
      {/*
        VSR 状态徽章（2026-11-02 新增）。

        ## 为什么需要它
        增强开关此前只有两个反馈：底部「增强」按钮的 `is-on` 高亮，以及点开浮层
        才能看到的开关状态。**画面本身看不出区别** —— 驱动侧是否真的在做超分
        要看 NVIDIA App，应用这边只能保证"链路已经切到 H.264 分片"。于是用户
        拨了开关之后没有任何确定性反馈，只能凭感觉猜"到底生效没有"。

        这里给出一个明确、不需要点开任何浮层的常驻标识：开启即出现，关闭即消失。

        ## 为什么跟着 HUD 一起淡出
        它是状态指示而不是控件，但**常显会永久遮挡画面右上角**。跟着 HUD 显隐
        与其它控件一致：鼠标一动就看得见，看剧时自动让位。

        ## 为什么不用 ttv-lock 那套类
        那套样式是给正方形图标按钮（锁）写的，宽度被压死 —— 昨天「原生播放」
        按钮就是被它挤成竖排折行的一块白方块。这里用独立的内联样式，宽度自适应
        文字，不再复用。
      */}
      {vsrEnabled && (
        <div
          className={`absolute top-3 right-3 z-40 pointer-events-none flex items-center gap-1.5 rounded-full transition-opacity duration-200 ${
            isVisible ? 'opacity-100' : 'opacity-0'
          }`}
          style={{
            padding: '4px 9px 4px 7px',
            background: 'linear-gradient(180deg, rgba(16,26,38,0.72), rgba(8,14,22,0.72))',
            border: '1px solid rgba(116,214,255,0.42)',
            boxShadow: '0 2px 12px rgba(0,0,0,0.35), inset 0 1px 0 rgba(255,255,255,0.10)',
            backdropFilter: 'blur(12px)',
            WebkitBackdropFilter: 'blur(12px)',
            color: 'rgba(186,238,255,0.96)',
            fontSize: 11,
            fontWeight: 600,
            letterSpacing: '0.02em',
            whiteSpace: 'nowrap',
          }}
          title="视频增强已开启：正在播放 RTX VSR 超分链路（H.264 分片）"
          aria-label="视频增强已开启"
        >
          <Sparkles className="w-3 h-3" />
          <span>RTX VSR</span>
        </div>
      )}

      {/* 原生播放器入口：已按需求搁置（见文件顶部 NATIVE_PLAYER_ENTRY_ENABLED）。
          保留 JSX 而不是删掉，是为了让 `handleOpenNative` / `Zap` 仍被引用，
          同时将来恢复只是改一个布尔值。 */}
      {NATIVE_PLAYER_ENTRY_ENABLED && (
        <button
          type="button"
          onClick={handleOpenNative}
          title="用原生播放器播放（mpv 硬解 + 补帧，首帧更快）"
          className={`absolute top-3 right-3 z-40 pointer-events-auto transition-opacity duration-200 ${
            isVisible ? 'opacity-100' : 'opacity-0 pointer-events-none'
          }`}
          style={{ padding: '6px 10px', display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}
        >
          <Zap className="w-[14px] h-[14px]" />
          原生播放
        </button>
      )}
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
      effectivePlaybackRate={effectivePlaybackRate}
      currentQuality={currentQuality}
      qualityOptions={availableQualities}
      vsrEnabled={vsrEnabled}
      onToggleVsr={setVsrEnabled}
      danmakuEnabled={danmakuEnabled}
      onToggleDanmaku={setDanmakuEnabled}
      danmakuAppearance={danmakuAppearance}
      onDanmakuAppearanceChange={updateSettings}
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
        onEnterPip={handleEnterPip}
      />
    </>
  );
};
