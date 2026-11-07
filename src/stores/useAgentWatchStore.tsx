import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useAppStore } from './useAppStore';
import { usePlaybackActions } from './usePlaybackStore';
import { useAnimePlayer } from './useAnimePlayerStore';
import { useSettingsStore } from './useSettingsStore';
import {
  agentBridgePort,
  agentDisplayName,
  hideAgentDock,
  listenAgentDockAction,
  listenAgentEvent,
  showAgentDock,
  type AgentEvent,
} from '../services/agentWatch';
import { tracePlayback } from '../services/playbackTrace';

/**
 * 智能体联动的状态枢纽。
 *
 * ## 三个状态（一个时间只会有一个非空）
 *
 * - `incoming`：收到智能体事件且正在播放 → 已自动暂停，等待用户决定
 *   （呼叫卡：前往 / 继续观看 / 忽略）。
 * - `docked`：用户点了「前往」→ 播放器已收起，右下角悬浮卡待命（点击回原位续播）。
 * - `null`：空闲（没在联动，或不在播放）。
 *
 * ## 与既有 store 的关系
 *
 * 本 store 不持有任何播放状态：暂停走 `usePlaybackActions` 的 `stopPlayback` /
 * 动漫 `close`，回播走 `openEpisode` / 动漫 `open`（与 PipReturnBridge 同一条
 * 「交接-回流」路线）。这里只记录「回来时该播什么」。
 */

/** 收到事件那一刻的播放快照（回来时照此续播）。 */
export interface AgentWatchSnapshot {
  /** 短剧/漫剧走 playback store；动漫走 anime store。 */
  kind: 'drama' | 'anime';
  seriesId: string;
  episodeId: string;
  title: string;
  cover: string;
  episodeNumber: number;
  /** 暂停时的位置（秒）。 */
  position: number;
  /** 总时长（秒）；0 表示未知。悬浮卡上要显示 "3:12 / 20:05"。 */
  duration: number;
}

/** 呼叫卡（incoming）携带的完整上下文。 */
export interface AgentIncoming {
  event: AgentEvent;
  snapshot: AgentWatchSnapshot;
  /** 用户决定「继续观看」时恢复播放用的快照（同 snapshot，语义上分开存）。 */
}

/** 悬浮卡（docked）携带的上下文。 */
export interface AgentDocked {
  snapshot: AgentWatchSnapshot;
  /** 最近一条触发收起的事件（悬浮卡上显示智能体状态点）。 */
  event: AgentEvent;
}

interface AgentWatchContextType {
  incoming: AgentIncoming | null;
  docked: AgentDocked | null;
  /** 呼叫卡：用户点了「前往智能体」。 */
  goToAgent: () => void;
  /** 呼叫卡：用户选择「继续观看」（恢复播放、卡片消失、继续监测）。 */
  keepWatching: () => void;
  /** 呼叫卡：忽略本次事件（保持暂停，卡片消失，继续监测）。 */
  dismissIncoming: () => void;
  /** 悬浮卡：点击回播放器原位置续播。 */
  resumeFromDock: () => void;
  /** 悬浮卡：手动关闭（放弃本次续播，之后事件照常触发）。 */
  dismissDocked: () => void;
}

const AgentWatchContext = createContext<AgentWatchContextType | null>(null);

/**
 * 拍快照：短剧从 actions 专线取（不含 position——position 在快照场景里由
 * 调用方从 video 元素读），动漫从 anime store 取。
 */
function captureDramaSnapshot(
  playback: ReturnType<typeof usePlaybackActions>,
  position: number,
  duration: number,
): AgentWatchSnapshot | null {
  const series = playback.currentSeries;
  const episode = playback.currentEpisode;
  if (!series || !episode) return null;
  return {
    kind: 'drama',
    seriesId: series.id,
    episodeId: episode.id,
    title: series.title,
    cover: series.cover,
    episodeNumber: episode.episodeNumber,
    position,
    duration,
  };
}

export const AgentWatchProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const { settings } = useSettingsStore();
  const { navigateTo, showToast } = useAppStore();
  const playback = usePlaybackActions();
  const anime = useAnimePlayer();

  const [incoming, setIncoming] = useState<AgentIncoming | null>(null);
  const [docked, setDocked] = useState<AgentDocked | null>(null);

  const enabled = settings.agentWatchEnabled === true;

  /**
   * 启动时自动接入（开关之前是开着的用户，升级后不该还要手动点一次）。
   *
   * 只在挂载时跑一次；期间不做任何 UI，失败也只是留一条 console 痕迹——
   * 接入失败绝不能影响播放器本身。
   */
  useEffect(() => {
    if (settings.agentWatchEnabled !== true) return;
    let cancelled = false;
    void (async () => {
      const port = await agentBridgePort();
      if (cancelled || port <= 0) return;
      const { agentAttachAll } = await import('../services/agentWatch');
      const report = await agentAttachAll(port);
      if (!cancelled && report) {
        tracePlayback(`智能体联动：启动时自动接入 ${report.attached.length} 个工具（桥端口 ${port}）`);
      }
    })();
    return () => {
      cancelled = true;
    };
    // 只在开关翻转时跑：端口与工具列表都是进程级固定的。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.agentWatchEnabled]);

  // —— 事件入口：订阅一次，回调经 ref 拿最新 store（照 PipReturnBridge 的模式）——
  const latestRef = useRef({ playback, anime, navigateTo, enabled, docked, incoming });
  useEffect(() => {
    latestRef.current = { playback, anime, navigateTo, enabled, docked, incoming };
  });

  useEffect(() => {
    let disposed = false;
    let off: (() => void) | null = null;
    void listenAgentEvent(event => {
      if (disposed) return;
      const ctx = latestRef.current;
      if (!ctx.enabled) return;

      // 已经有卡片在等用户决定：后续事件只刷新"最近事件"，不叠卡片。
      if (ctx.incoming) return;

      // 已经收起到桌面时只更新现有卡片，不再创建新的呼叫卡或改变播放快照。
      if (ctx.docked) {
        const updated = { ...ctx.docked, event };
        setDocked(updated);
        const { snapshot } = updated;
        void showAgentDock({
          title: snapshot.title,
          cover: snapshot.cover,
          episodeNumber: snapshot.episodeNumber,
          position: snapshot.position,
          duration: snapshot.duration,
          agentName: agentDisplayName(event.agent),
          eventType: event.eventType,
          message: event.message,
          project: event.project ?? '',
          isAnime: snapshot.kind === 'anime',
        });
        return;
      }

      // 动漫在播：优先拍动漫快照。
      if (ctx.anime.isOpen && ctx.anime.series && ctx.anime.episode) {
        const snapshot: AgentWatchSnapshot = {
          kind: 'anime',
          seriesId: ctx.anime.series.id,
          episodeId: ctx.anime.episode.id,
          title: ctx.anime.series.title,
          cover: ctx.anime.series.cover,
          episodeNumber: ctx.anime.episode.episodeNumber,
          position: ctx.anime.position,
          duration: ctx.anime.duration,
        };
        // 自动暂停：动漫 store 没有公开 pause，用 togglePlay 仅在播放中调用。
        // 注意 anime.isPlaying 判断放在 toggle 之前，避免"已暂停还再 toggle 一次
        // 变成播放"的反向事故。
        if (ctx.anime.isPlaying) ctx.anime.togglePlay();
        setIncoming({ event, snapshot });
        tracePlayback(`智能体联动：已暂停动漫（${event.eventType}/${event.agent}）`);
        return;
      }

      // 短剧/漫剧在播：从 video 元素读精确位置（actions 专线刻意不含 position）。
      // playback.videoRef 被 Omit 出专线，这里改从 openEpisode 的会话上下文读：
      // 直接经 document.querySelector 拿常驻的播放器 video（宿主只有一块）。
      const video = document.querySelector<HTMLVideoElement>('video');
      const position = video && Number.isFinite(video.currentTime) ? video.currentTime : 0;
      // 时长优先信播放器给的值（边转边播时 `video.duration` 会一路往上跳，
      // 播放器里已有"源片权威时长"的校准），读不到才退回元素自己的。
      const duration = Number.isFinite(video?.duration) && (video?.duration ?? 0) > 0
        ? (video!.duration as number)
        : 0;
      const wasPlaying = ctx.playback.isPlaying;
      const snapshot = captureDramaSnapshot(ctx.playback, position, duration);
      if (!snapshot) return; // 没在播（也可能在详情页）：不打扰。
      if (wasPlaying) {
        // stopPlayback 的语义是"离开播放器"（暂停 + 落盘 + 收看门狗），但用户
        // 此刻还在播放页等他决定，不能走那套；这里只暂停画面（与 enterPip 里
        // `video.pause()` 同一手法），决定交给呼叫卡。
        if (video && !video.paused) video.pause();
      }
      setIncoming({ event, snapshot });
      tracePlayback(`智能体联动：已暂停短剧（${event.eventType}/${event.agent}，位置 ${position.toFixed(1)}s）`);
    }).then(fn => {
      if (disposed) fn();
      else off = fn;
    });
    return () => {
      disposed = true;
      off?.();
    };
  }, []);

  /** 恢复播放的统一路径（呼叫卡「继续观看」与悬浮卡点击共用）。 */
  const resume = useCallback(async (snapshot: AgentWatchSnapshot) => {
    const ctx = latestRef.current;
    if (snapshot.kind === 'anime') {
      await ctx.anime.open(snapshot.seriesId, snapshot.episodeId, snapshot.position);
    } else {
      ctx.navigateTo('player');
      await ctx.playback.openEpisode(snapshot.seriesId, snapshot.episodeId, snapshot.position);
    }
  }, []);

  /**
   * 呼叫卡：「前往智能体」。
   *
   * 三件事，顺序不可换：
   * 1. 交干净播放权（`stopPlayback` 会 pause + 落盘 + 收转码会话与看门狗）；
   * 2. 把播放快照交给**独立的置顶悬浮窗**（不是应用内浮层——用户接下来要切到
   *    别的程序里干活，应用内浮层跟着主窗口一起被遮住，那就失去了全部意义）；
   * 3. 关掉呼叫卡、导航回详情页。
   *
   * 悬浮窗只负责显示；用户点它时经 `agent://dock-action` 回到这里续播——
   * 它拿不到主窗口的播放器 store（独立 WebView）。
   */
  const goToAgent = useCallback(() => {
    const ctx = latestRef.current;
    const current = incoming;
    if (!current) return;
    const { snapshot } = current;
    if (snapshot.kind === 'anime') ctx.anime.close();
    else ctx.playback.stopPlayback();

    setIncoming(null);
    setDocked({ snapshot, event: current.event });
    ctx.navigateTo('detail');

    void showAgentDock({
      title: snapshot.title,
      cover: snapshot.cover,
      episodeNumber: snapshot.episodeNumber,
      position: snapshot.position,
      duration: snapshot.duration,
      agentName: agentDisplayName(current.event.agent),
      eventType: current.event.eventType,
      message: current.event.message,
      project: current.event.project ?? '',
      isAnime: snapshot.kind === 'anime',
    }).then(() => {
      tracePlayback(`智能体联动：播放器已收起为桌面悬浮卡（${snapshot.title} 第 ${snapshot.episodeNumber} 集，${snapshot.position.toFixed(1)}s）`);
    });
  }, [incoming]);

  const keepWatching = useCallback(() => {
    const current = incoming;
    if (!current) return;
    setIncoming(null);
    void resume(current.snapshot);
  }, [incoming, resume]);

  const dismissIncoming = useCallback(() => setIncoming(null), []);

  const resumeFromDock = useCallback(() => {
    const current = docked;
    if (!current) return;
    setDocked(null);
    void hideAgentDock();
    void resume(current.snapshot);
    // 回来即继续监测：不重置任何状态，下一条事件照常触发。
    tracePlayback('智能体联动：从桌面悬浮卡回到播放器，原位置续播');
  }, [docked, resume]);

  const dismissDocked = useCallback(() => {
    setDocked(null);
    void hideAgentDock();
  }, []);

  /**
   * 悬浮窗上的点击（resume / close）回到这里执行。
   *
   * 悬浮窗是独立 WebView，它只发一个动作字符串；真正的续播必须由主窗口做
   * （它才持有播放器会话、缓存与历史落盘）。
   */
  const dockActionRef = useRef({ resumeFromDock, dismissDocked });
  dockActionRef.current = { resumeFromDock, dismissDocked };
  useEffect(() => {
    let disposed = false;
    let off: (() => void) | null = null;
    void listenAgentDockAction(action => {
      if (disposed) return;
      if (action === 'resume') dockActionRef.current.resumeFromDock();
      else dockActionRef.current.dismissDocked();
    }).then(fn => {
      if (disposed) fn();
      else off = fn;
    });
    return () => {
      disposed = true;
      off?.();
    };
  }, []);

  const value = useMemo<AgentWatchContextType>(() => ({
    incoming,
    docked,
    goToAgent,
    keepWatching,
    dismissIncoming,
    resumeFromDock,
    dismissDocked,
  }), [incoming, docked, goToAgent, keepWatching, dismissIncoming, resumeFromDock, dismissDocked]);

  return <AgentWatchContext.Provider value={value}>{children}</AgentWatchContext.Provider>;
};

export function useAgentWatch(): AgentWatchContextType {
  const ctx = useContext(AgentWatchContext);
  if (!ctx) throw new Error('useAgentWatch 必须在 AgentWatchProvider 内使用');
  return ctx;
}
