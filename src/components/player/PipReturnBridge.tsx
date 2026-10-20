import React, { useEffect, useRef } from 'react';
import { ipcService } from '../../services/ipc';
import {
  listenPip,
  PIP_RETURNED_EVENT,
  PIP_SHOWN_EVENT,
  type PipHandoff,
  type PipProgress,
  type PipReturnedPayload,
} from '../../services/pip';
import { useAnimePlayer } from '../../stores/useAnimePlayerStore';
import { useAppStore } from '../../stores/useAppStore';
import { useHistoryStore } from '../../stores/useHistoryStore';
import { usePlaybackActions } from '../../stores/usePlaybackStore';
import { tracePlayback } from '../../services/playbackTrace';

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
  playback: ReturnType<typeof usePlaybackActions>;
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
  // 「算看完了吗」与两个播放器同一套判定（2026-10-19）：剩余 ≤3 秒且百分比 ≥90。
  // 以秒数为主判据 —— 短集（20 秒看到 19 秒）只有 95%，用 98% 会误杀。
  const remainingSeconds = duration > 0 ? Math.max(0, duration - position) : Number.POSITIVE_INFINITY;
  const isFinished = duration > 0 && remainingSeconds <= 2 && percent >= 95;
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
      isFinished,
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
  /**
   * 起播秒数必须与集号**同源**。
   *
   * 小窗会在后台自动连播：它切到下一集之后，`progress.episodeId` 立刻就是新集，
   * 而 `progress.position` 在那次 `report(true)` 落地前仍可能是**上一集的末尾**
   * （`timeupdate` 与换源是两条时序）。旧实现无条件把 `progress.position` 配上
   * 新集号交给 `openEpisode`，于是"从小窗回到播放器"会从上一集结尾的位置开始
   * 播 —— 用户看到的就是"进度条不在 0、从一个莫名其妙的时间点继续"。
   *
   * 判据：位置与集号必须指向同一集（`progress.episodeId` 缺失时无法确认，
   * 就退回交接时记下的那一集的位置；换了集则一律从头播）。
   */
  const progressMatchesEpisode = Boolean(progress.episodeId) && progress.episodeId === episodeId;
  const handoffMatchesEpisode = !progress.episodeId && episodeId === handoff.episodeId;
  const candidate = progressMatchesEpisode || handoffMatchesEpisode
    ? (progressMatchesEpisode ? progress.position : handoff.position)
    : 0;
  const position = Number.isFinite(candidate) && candidate > 0 ? candidate : 0;

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

/**
 * 主窗口的显示 / 隐藏（本文件是这两个动作的**唯一**出口）。
 *
 * 为什么集中在这里：小窗是独立顶层窗口，而"同一时刻只该看见一个窗口"这件事
 * 需要两个方向都由同一处决定 ——
 *   1. 小窗就绪（`pip://shown`）→ 主窗口隐藏，画面交给小窗；
 *   2. 小窗结束（`pip://returned`，任何 mode）→ 主窗口必须回来。
 *
 * 第 2 条尤其不能漏：用户用 Alt+F4 关掉小窗时走的是系统路径，Rust 侧只在
 * `mode = "return"` 才抢前台。若这里不兜底，主窗口会一直隐藏着，应用看起来
 * "整个消失了"。
 */
async function setMainWindowVisible(visible: boolean): Promise<void> {
  try {
    const { getCurrentWindow } = await import('@tauri-apps/api/window');
    const window = getCurrentWindow();
    if (visible) {
      await window.show();
      await window.setFocus();
      tracePlayback('画中画结束：主窗口已恢复显示');
    } else {
      await window.hide();
      tracePlayback('画中画就绪：主窗口已隐藏（同一时刻只保留一个窗口）');
    }
  } catch (error) {
    /**
     * ⚠️ 这里**不能静默**。
     *
     * 2026-10-19 的现场：`core:window:allow-hide` 没写进 capabilities，`hide()`
     * 被运行时拒绝，而旧代码把异常吞了 —— 表现是"点画中画后主界面根本没消失、
     * 两个窗口同时在播"，日志里一条线索都没有。窗口显隐失败必须留痕。
     */
    tracePlayback(
      `主窗口${visible ? '显示' : '隐藏'}失败：${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export const PipReturnBridge: React.FC = () => {
  // 低频动作专线：本组件没有任何位置/时间读数，不该跟着播放进度重渲染。
  const playback = usePlaybackActions();
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
    const offs: Array<() => void> = [];
    // 小窗出画 → 主窗口退场。这是"任何时刻只有一个窗口"的关键一拍：
    // 反过来（主窗口先隐藏）就是用户报的"播放界面先消失、小窗过一会儿才出来"。
    void listenPip<unknown>(PIP_SHOWN_EVENT, () => {
      if (disposed) return;
      void setMainWindowVisible(false);
    }).then(off => {
      if (disposed) off();
      else offs.push(off);
    });
    // 小窗结束 → 主窗口回来（不区分模式：close / system 同样会把窗口藏丢）。
    void listenPip<PipReturnedPayload>(PIP_RETURNED_EVENT, (payload) => {
      if (disposed) return;
      tracePlayback(`小窗回流 mode=${payload.mode} 集=${payload.progress.episodeId ?? '(未知)'} 位置=${Math.round(payload.progress.position)}s`);
      void setMainWindowVisible(true);
      void handleReturned(latestRef.current, payload);
    }).then(off => {
      if (disposed) off();
      else offs.push(off);
    });
    return () => {
      disposed = true;
      offs.forEach(off => off());
    };
  }, []);

  return null;
};

export default PipReturnBridge;
