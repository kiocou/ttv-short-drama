import React, { useEffect, useRef } from 'react';
import { ipcService } from '../../services/ipc';
import {
  listenPip,
  PIP_RETURNED_EVENT,
  type PipHandoff,
  type PipProgress,
  type PipReturnedPayload,
} from '../../services/pip';
import { useAnimePlayer } from '../../stores/useAnimePlayerStore';
import { useAppStore } from '../../stores/useAppStore';
import { useHistoryStore } from '../../stores/useHistoryStore';
import { usePlaybackStore } from '../../stores/usePlaybackStore';

/**
 * 画中画小窗的"回流"处理（主窗口侧，不渲染任何界面）。
 *
 * 小窗是独立的 WebView，它播到哪儿只能经 Rust 转发的 `pip://returned` 事件回到
 * 主窗口（见 `services/pip.ts` 的交接协议）。这里负责三件事：
 *
 * 1. **`return` 模式**（用户点了小窗上的"回到播放器"）：按小窗最后在播的那一集与
 *    秒数重新起播，并把音量/静音/倍速接回来——用户可能在小窗里按过静音，只接音量
 *    不接静音，回到播放器的第一声会与预期相反；
 * 2. **任何关闭方式都落一次历史进度**：小窗可能在主窗口离开播放器之后又播了很久，
 *    甚至自动连播到了下一集，不落盘就等于这段观看被丢掉；
 * 3. 失败静默（只留 console 痕迹）：小窗已经关掉，这里再弹错误卡片没有意义。
 *
 * 起播时机是安全的：`pip_close` / `pip_dismiss` 都是"先回报、再销毁窗口"，事件到达
 * 主窗口时小窗已经让出播放权（见 `src-tauri/src/pip.rs`），不存在两路声音同响。
 */

interface PipBridgeContext {
  playback: ReturnType<typeof usePlaybackStore>;
  anime: ReturnType<typeof useAnimePlayer>;
  navigateTo: (view: 'player') => void;
  loadHistory: () => Promise<void>;
}

/** 倍速的合法性兜底：损坏/未就绪的媒体元素可能报出 0 或 NaN。 */
function safeRate(rate: number): number {
  return Number.isFinite(rate) && rate > 0 ? rate : 1;
}

/**
 * 把最终进度写进历史。
 *
 * 复刻播放器里 `saveProgressThrottled` 的算法（百分比、95% 视为看完），但数据源是
 * 小窗上报的进度，不依赖主窗口自己那份可能早就不对的 position/duration。
 */
async function saveHistory(
  handoff: PipHandoff,
  episodeId: string,
  progress: PipProgress,
): Promise<void> {
  const duration = Number.isFinite(progress.duration) && progress.duration > 0 ? progress.duration : 0;
  const rawPosition = Number.isFinite(progress.position) && progress.position > 0 ? progress.position : 0;
  const position = duration > 0 ? Math.min(rawPosition, duration) : rawPosition;
  const percent = duration > 0 ? Math.min(100, Math.max(0, Math.round((position / duration) * 100))) : 0;
  // 集号按"小窗最后在播的那一集"取：它可能已经自动连播到下一集了。
  const episodeNumber = handoff.episodes.find(item => item.id === episodeId)?.episodeNumber
    ?? handoff.episodeNumber;

  try {
    await ipcService.history.save({
      seriesId: handoff.seriesId,
      episodeId,
      title: handoff.title,
      seriesCover: handoff.cover,
      episodeNumber,
      totalEpisodes: handoff.totalEpisodes,
      positionSeconds: Math.floor(position),
      durationSeconds: Math.floor(duration),
      progressPercent: percent,
      updatedAt: Date.now(),
      isFinished: percent >= 95,
      channel: handoff.channel,
    });
  } catch (error) {
    // 落盘失败不该影响"回到播放器"这条主动作，但必须留痕——否则用户只会看到
    // "历史记录没同步"，无从排查（与播放器里的处理一致）。
    console.warn('[pip] 历史记录保存失败', error);
  }
}

async function handleReturned(ctx: PipBridgeContext, payload: PipReturnedPayload): Promise<void> {
  const handoff = payload.handoff;
  if (!handoff) return;
  const { progress } = payload;
  const episodeId = progress.episodeId || handoff.episodeId;
  const position = Number.isFinite(progress.position) && progress.position > 0
    ? progress.position
    : handoff.position;

  if (payload.mode === 'return') {
    if (handoff.kind === 'anime') {
      // 动漫链路：`open` 自己会导航到播放器，并重新解析一次直链（MSE 地址无法跨窗口）。
      ctx.anime.setVolume(progress.volume);
      ctx.anime.setMuted(progress.muted);
      ctx.anime.setPlaybackRate(safeRate(progress.rate));
      await ctx.anime.open(handoff.seriesId, episodeId, position);
    } else {
      // 短剧/漫剧链路：命中整集缓存即秒开，所以这里起播是"接着看"，不是重头再来。
      ctx.playback.setVolume(progress.volume);
      ctx.playback.setMuted(progress.muted);
      ctx.playback.setPlaybackRate(safeRate(progress.rate));
      ctx.navigateTo('player');
      await ctx.playback.openEpisode(handoff.seriesId, episodeId, position);
    }
  }

  await saveHistory(handoff, episodeId, progress);
  await ctx.loadHistory();
}

export const PipReturnBridge: React.FC = () => {
  const playback = usePlaybackStore();
  const anime = useAnimePlayer();
  const { navigateTo } = useAppStore();
  const { loadHistory } = useHistoryStore();

  /**
   * 事件只订阅一次，但回调必须拿到"最新那一份" store。
   *
   * 主窗口的 PlaybackContext 每次渲染都是新对象：闭包住首渲染那一份的话，回到
   * 播放器时用的会是挂载时的音量/静音（实测就是默认音量），用户在小窗里的设定
   * 全部丢失。这里每次渲染后把最新一份挂到 ref 上，订阅本身保持稳定。
   */
  const latestRef = useRef<PipBridgeContext>({ playback, anime, navigateTo, loadHistory });
  useEffect(() => {
    latestRef.current = { playback, anime, navigateTo, loadHistory };
  });

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | null = null;
    void listenPip<PipReturnedPayload>(PIP_RETURNED_EVENT, (payload) => {
      if (disposed) return;
      void handleReturned(latestRef.current, payload);
    }).then(off => {
      if (disposed) off();
      else unlisten = off;
    });
    return () => {
      disposed = true;
      if (unlisten) unlisten();
    };
  }, []);

  return null;
};

export default PipReturnBridge;
