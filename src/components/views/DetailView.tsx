import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useAppStore } from '../../stores/useAppStore';
import { usePlaybackActions } from '../../stores/usePlaybackStore';
import { useAnimePlayer } from '../../stores/useAnimePlayerStore';
import { useFavorites } from '../../stores/useFavoritesStore';
import { ipcService, coverResolver } from '../../services/ipc';
import { SeriesDetail, EpisodeItem } from '../../types/series';
import type { WatchHistoryItem } from '../../types/history';
import { MicaCard } from '../common/MicaCard';
import { FluentButton } from '../common/FluentButton';
import { CoverImage } from '../common/CoverImage';
import { StatusBadge } from '../common/StatusBadge';
import { RelatedSeriesSection } from '../common/RelatedSeriesSection';
import { SeriesSeasonsDialog } from '../common/SeriesSeasonsDialog';
import { canLookupSeasons } from '../../services/relatedSeries';
import { 
  Play, 
  ArrowLeft, 
  ChevronDown, 
  ChevronUp,
  Tv,
  MoreHorizontal,
  X,
  Search,
  Layers,
  Layers3,
  Check,
  Heart
} from 'lucide-react';

/** 秒 → `mm:ss`（超出一小时才会出现 `h:mm:ss`，短剧几乎用不到）。 */
function formatClock(totalSeconds: number): string {
  const total = Math.max(0, Math.round(totalSeconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const mm = String(minutes).padStart(hours > 0 ? 2 : 1, '0');
  const ss = String(seconds).padStart(2, '0');
  return hours > 0 ? `${hours}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** 「还剩 8 分 20 秒」——续播时比"已看 62%"更有用的那个数字。 */
function formatRemaining(totalSeconds: number): string {
  const total = Math.max(0, Math.round(totalSeconds));
  if (total < 60) return `还剩 ${total} 秒`;
  const minutes = Math.floor(total / 60);
  const rest = total % 60;
  if (minutes < 60) return rest > 0 ? `还剩 ${minutes} 分 ${rest} 秒` : `还剩 ${minutes} 分钟`;
  return `还剩 ${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分`;
}

/**
 * 选集面板每页的集数。
 *
 * 与规范一致的三档策略，全部落在这一条常量上：
 *   - 1–30 集：一页装完，不分页；
 *   - 31–100 集：默认第一页 50 集，其余靠翻页；
 *   - 100 集以上：翻页 + 集数跳转。
 *
 * **不要**改成"一次渲染全部"：一部 300 集的短剧会同时挂 300 个按钮，
 * 每个按钮还各带 hover 预签名回调，滚动帧耗时直接翻倍。
 */
const EPISODE_PAGE_SIZE = 50;

/**
 * 单颗集数按钮。
 *
 * 抽出来之前，"选集播放"网格与「全部选集」弹窗各抄了一份一模一样的 JSX（含三档
 * 状态色、勾选图标、进度小条、预签名回调）。两份一旦有一处改了配色，另一处就
 * 静默留在旧样式上 —— 详情页与弹窗里的同一集会长得不一样，而它们本来就该是
 * 同一个东西。
 *
 * ## 状态层级（规范里的六态，这里一一对应）
 *
 * | 状态 | 视觉 |
 * | --- | --- |
 * | 当前播放 | 蓝底白字 + 播放图标 + 外圈 ring |
 * | 已观看 | 淡蓝底 + 右上勾 |
 * | 看到一半 | 白底 + 底部蓝色进度条 |
 * | 未观看 | 白底 + 灰边 |
 * | 悬停 | 浅蓝底 + 蓝边 |
 * | 键盘焦点 | `focus-visible` 蓝色外描边 |
 *
 * 前三种状态**互斥不叠加**：当前播放不画勾、也不画进度条 —— 一整格蓝底已经是最强
 * 的那一档，再往上叠细节只会让它看起来像"又脏又重要"。
 */
interface EpisodeButtonProps {
  ep: EpisodeItem;
  /** 这一集是不是"上次看到的那一集"（详情页的锚点集）。 */
  isCurrent: boolean;
  onPlay: (ep: EpisodeItem) => void;
  onPrewarm: (episodeId: string) => void;
}

const EpisodeButton: React.FC<EpisodeButtonProps> = ({ ep, isCurrent, onPlay, onPrewarm }) => {
  const hasProgress = (ep.watchedSeconds || 0) > 0;
  const isWatched = ep.isFinished || hasProgress;
  const title = isCurrent
    ? `当前播放：第 ${ep.episodeNumber} 集 · ${ep.title}`
    : `第 ${ep.episodeNumber} 集 · ${ep.title}${ep.isFinished ? ' (已看完)' : hasProgress ? ' (看到一半)' : ''}`;

  return (
    <button
      key={ep.id}
      type="button"
      onMouseEnter={() => onPrewarm(ep.id)}
      onFocus={() => onPrewarm(ep.id)}
      onClick={() => onPlay(ep)}
      title={title}
      aria-current={isCurrent ? 'true' : undefined}
      className={`group relative h-10 rounded-xl flex items-center justify-center font-bold text-xs shadow-xs active:scale-95 transition-all duration-150 cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-blue-500/60 focus-visible:ring-offset-1 ${
        isCurrent
          ? 'bg-blue-600 text-white border border-blue-600 shadow-md shadow-blue-500/25 ring-2 ring-blue-400/40'
          : isWatched
          ? 'bg-blue-50/70 hover:bg-blue-50 border border-blue-200/70 hover:border-blue-400 text-blue-700 hover:text-blue-700'
          : 'bg-white hover:bg-blue-50/80 border border-slate-200/80 hover:border-blue-400 text-slate-700 hover:text-blue-600'
      }`}
    >
      {isCurrent ? (
        <span className="flex items-center gap-1">
          <Play className="w-2.5 h-2.5 fill-current shrink-0" />
          <span>{ep.episodeNumber}</span>
        </span>
      ) : (
        <span>{ep.episodeNumber}</span>
      )}

      {/* 已看完：右上角勾。看到一半则不画勾 —— 它还没看完，勾会骗人。 */}
      {ep.isFinished && !isCurrent && (
        <span className="absolute top-1 right-1 text-blue-500/70" title="已看完">
          <Check className="w-2.5 h-2.5 stroke-[2.5]" />
        </span>
      )}

      {/* 看到一半：底部进度小条，与上面的筛选项共用同一判定（hasProgress） */}
      {hasProgress && !ep.isFinished && !isCurrent && (
        <span className="absolute bottom-1 inset-x-2 h-0.5 bg-blue-500 rounded-full" />
      )}
    </button>
  );
};

export const DetailView: React.FC = () => {
  const { selectedSeriesId, navigateTo, goBack, showToast, currentView } = useAppStore();
  // 详情页挂在常驻 DOM 上：走低频动作专线，整表订阅会让选集网格跟着播放进度重渲染。
  // `currentEpisode` 只用于「别预转用户正在看的那一集」，它是低频字段（换集才变），
  // 走动作专线不会引入高频重渲染。
  const { openEpisode, prewarmEpisode, currentEpisode } = usePlaybackActions();
  const { open: openAnimeEpisode } = useAnimePlayer();
  const { markBySeriesId, setMark } = useFavorites();
  const detailCacheRef = useRef<Record<string, SeriesDetail>>({});
  // 供 effect 读取最新实现，避免把 prewarmEpisode 放进依赖数组导致每次渲染重跑。
  const prewarmEpisodeRef = useRef(prewarmEpisode);
  prewarmEpisodeRef.current = prewarmEpisode;
  const hoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [rawDetail, setRawDetail] = useState<SeriesDetail | null>(null);

  /**
   * 把观看历史回填到集数里。
   *
   * 后端 `series_detail` 返回的 `EpisodeItem` 只有 id / 集号 / 时长，从来不带
   * `watchedSeconds`（Rust 侧 `models.rs::EpisodeItem` 根本没有这个字段）——
   * 也就是说详情页的「继续播放第 N 集」「已观看 N 集」「上次观看进度条」在真实
   * 链路里永远拿不到数据，只有浏览器 mock 才有。观看进度实际落在
   * `ipcService.history.list()` 的 `WatchHistoryItem` 上（首页「继续观看」用的就是它）。
   *
   * 这里在进入详情页时拉一次历史，把当前这一部剧的记录合并进 episodes：优先按
   * episodeId 匹配、其次按集号；只克隆匹配到的那一集，其余保持原引用，不污染
   * `ipcService` 的详情缓存对象。`currentView` 进依赖是为了从播放器返回时刷新。
   */
  const [historyRecord, setHistoryRecord] = useState<WatchHistoryItem | null>(null);
  useEffect(() => {
    if (!rawDetail?.id) {
      setHistoryRecord(null);
      return;
    }
    let alive = true;
    void ipcService.history
      .list()
      .then(list => {
        if (alive) setHistoryRecord(list.find(item => item.seriesId === rawDetail.id) || null);
      })
      .catch(() => {
        if (alive) setHistoryRecord(null);
      });
    return () => {
      alive = false;
    };
  }, [rawDetail?.id, currentView]);

  const detail = useMemo<SeriesDetail | null>(() => {
    if (!rawDetail) return null;
    if (!historyRecord) return rawDetail;
    let matched = false;
    const episodes = rawDetail.episodes.map(ep => {
      const hit =
        ep.id === historyRecord.episodeId || ep.episodeNumber === historyRecord.episodeNumber;
      if (!hit) return ep;
      matched = true;
      return {
        ...ep,
        watchedSeconds: Math.max(0, historyRecord.positionSeconds || 0),
        durationSeconds:
          historyRecord.durationSeconds > 0 ? historyRecord.durationSeconds : ep.durationSeconds,
        isFinished: historyRecord.isFinished,
      };
    });
    return matched ? { ...rawDetail, episodes } : rawDetail;
  }, [rawDetail, historyRecord]);


  /**
   * 红果 App 的详情扩展字段（`hongguo_series_detail`）。
   *
   * 详情页本身的数据来自 provider 链路（网页/App 混源），它只有集数与简介；
   * 「更新至N集 / 全N集」这种角标、发布状态、总播放/关注数只有 App 的
   * `video_detail` 才有。这里作为**增量**补充：拿不到就整块不显示，
   * 已有的集数徽标与来源文案照旧。
   *
   * 只对红果的数字 id 取（`guo:`/`dmghg:` 前缀与动漫 id 在那边不存在）。
   */
  const [hongguoMeta, setHongguoMeta] = useState<{
    rightText: string;
    status: number;
    playCount: number;
    followCount: number;
  } | null>(null);
  const [isDescExpanded, setIsDescExpanded] = useState(false);
  const [showAllEpisodesModal, setShowAllEpisodesModal] = useState(false);
  /**
   * 选集筛选与翻页。
   *
   * 状态放在这里而不是 `EpisodeSelector` 子组件里：详情页是常驻 DOM 的，用户在
   * 选集里翻到第 3 页、切到播放器、再返回——筛选与页码必须还在原处，否则"我刚
   * 才翻到的那一页"每次回来都要重翻。子组件内的 state 在视图切换时不会丢，
   * 但换一部剧时必须重置，所以重置逻辑跟着 `selectedSeriesId` 走（见下面的 effect）。
   */
  const [episodeFilter, setEpisodeFilter] = useState<'all' | 'unwatched' | 'watched'>('all');
  const [episodePage, setEpisodePage] = useState(0);
  /** 集数跳转输入框。 */
  const [episodeJump, setEpisodeJump] = useState('');
  /**
   * 「系列剧」弹窗。
   *
   * 与「全部选集」弹窗并列放在这一层（而不是塞进 `RelatedSeriesSection`）：它属于
   * **这部剧本身**的操作入口，和"猜你喜欢"推荐的其它剧是两个语义；放在详情页也
   * 让它和选集面板共用同一套弹窗外壳与 Esc/遮罩关闭行为。
   */
  const [showSeasonsDialog, setShowSeasonsDialog] = useState(false);

  /**
   * 拉取 App 详情扩展字段。失败静默——它只是把「共 N 集全」升级成
   * 「更新至 N 集」，拿不到时页面照旧可用。
   */
  useEffect(() => {
    if (!detail) {
      setHongguoMeta(null);
      return;
    }
    const numeric = /^\d{4,25}$/.test(detail.id);
    if (!numeric || detail.type === 'anime' || detail.type === 'adult') {
      setHongguoMeta(null);
      return;
    }
    let alive = true;
    void ipcService.hongguo
      .seriesDetail(detail.id, detail.type)
      .then(data => {
        if (!alive) return;
        setHongguoMeta({
          rightText: data.rightText ?? '',
          status: data.status ?? 0,
          playCount: data.playCount ?? 0,
          followCount: data.followCount ?? 0,
        });
      })
      .catch(() => {
        if (alive) setHongguoMeta(null);
      });
    return () => {
      alive = false;
    };
  }, [detail]);

  // 打开详情页只预热**最可能被点开的那一集**。
  //
  // 旧实现一次预签名 6 集（后端 3 路并发），会在用户点“立即播放”时同时占着
  // 多路 worker 与 App API 往返；而首播真正需要的只有一集。点得越快，越容易
  // 撞上这轮并发，表现为“立即播放后一直缓冲”。收敛到一集之后，签名与预转
  // 都只服务当前入口，首播等待最短。
  useEffect(() => {
    if (!detail || detail.episodes.length === 0) return;
    const anchor = detail.episodes.findIndex(ep => (ep.watchedSeconds || 0) > 0 && !ep.isFinished);
    const target = detail.episodes[anchor >= 0 ? anchor : 0];
    if (!target) return;
    void ipcService.playback.prefetchStream(
      [target.id],
      detail.type === 'comic' ? 1004 : 1,
    );
  }, [detail]);

  /**
   * 详情页为「最可能被点开的那一集」**预转整集 HLS**。
   *
   * ## 为什么这条是首开提速的最大一块
   *
   * 实测（ttv-playback.log，同一份日志里两种情形并存）：
   *   - 冷集首开：`整集 HLS 出画 耗时=9056ms`
   *   - 命中预转：`流式开播 返回 耗时=132ms` → `出画 耗时=368ms`
   * 差 25 倍。而在此之前，`prewarmStreamNative` 在整个前端**只有一处调用点**
   * （`usePlaybackStore` 的 `warmAdjacentEpisodes`，且是"本集出画后延后 7 秒
   * 转下一集"），也就是说**任何一集被首次打开时，它的转码一定是冷的**。
   *
   * 而转码本身只要 1.5~5.6 秒（实测首片中位 761ms、整集 5.6 秒），用户从
   * 首页点卡片进详情、看简介、翻选集，停留时间通常远超这个数——这段窗口此前
   * 完全没被利用。
   *
   * ## 三条硬约束
   *
   * 1. **只预转一集**。编码单元是串行的（见 `MAX_PREWARM_INFLIGHT` 的实测），
   *    多转一集就是把正在播的那一路挤慢，收益为零、代价是卡顿。
   * 2. **不预转"当前正在播的那一集"**。它已经在转（或已转好），重复发车只会
   *    命中后端去重空跑一趟；更糟的是用户可能正看着它，抢资源就是直接卡顿。
   * 3. **详情页常驻 DOM**（`display:none` 隐藏），所以这个 effect 在用户已经
   *    在播放器里时同样可能因 `detail` 变化而触发 —— 必须用 `currentView` 挡掉，
   *    否则会在播放期间凭空起一路转码。
   */
  const prewarmedStreamRef = useRef<Set<string>>(new Set());
  // 供 effect 读取最新值而不进依赖数组：`currentEpisode` 每次换集都变，放进依赖
  // 会让预转在换集时重跑一遍——那恰恰是约束 2 要禁止的事。
  const playingEpisodeIdRef = useRef<string | null>(null);
  playingEpisodeIdRef.current = currentEpisode?.id ?? null;
  const currentViewRef = useRef(currentView);
  currentViewRef.current = currentView;

  useEffect(() => {
    if (!detail || detail.episodes.length === 0) return;
    // 动漫与 guo 源不走整集 HLS 预转：动漫是流式 m3u8（无产物可转），
    // guo 走的是 guo-core 本地媒体服务，两者的预取在各自链路里另有安排。
    if (detail.type === 'anime' || detail.id.startsWith('guo:')) return;
    // 只在详情页可见时预热：播放器里不该有第二路转码。
    if (currentViewRef.current !== 'detail') return;
    const target =
      detail.episodes.find(ep => (ep.watchedSeconds || 0) > 0 && !ep.isFinished) || detail.episodes[0];
    if (!target) return;
    if (playingEpisodeIdRef.current === target.id) return;
    const key = `${detail.id}::${target.id}`;
    if (prewarmedStreamRef.current.has(key)) return;
    prewarmedStreamRef.current.add(key);
    // 延后 1.2 秒：让上面那条 `prefetchStream` 先把签名跑完。预转内部会调
    // `ensure_stream_cached`，与预签名命中同一条缓存，串行发起等于白等一轮
    // 2.2 秒的 API 往返（后端有 leader/follower 去重，但前端没必要制造这次排队）。
    const timer = setTimeout(() => {
      // 定时器到点时用户可能已经离开详情页进了播放器：再复查一次。
      if (currentViewRef.current !== 'detail') return;
      void ipcService.playback.prewarmStreamNative(
        detail.id,
        target.id,
        detail.type === 'comic' ? 1004 : 1,
      );
    }, 1200);
    return () => clearTimeout(timer);
  }, [detail]);
  const [modalSearch, setModalSearch] = useState('');

  // 详情和可播放集数始终以当前项目后端返回的数据为准。
  useEffect(() => {
    if (!selectedSeriesId) {
      setRawDetail(null);
      return;
    }

    const cached = detailCacheRef.current[selectedSeriesId];
    if (cached) {
      setRawDetail(cached);
      return;
    }

    let active = true;
    setRawDetail(null);

    // 失败自动重试一次：详情页是单次网络往返，抖动一次就白屏一整页。
    // 重试仍失败才提示，且保留"重试"入口（点刷新重新拉）。
    const loadDetail = (attempt: number) => {
      ipcService.series.getDetail(selectedSeriesId)
        .then((res) => {
          if (!active) return;
          detailCacheRef.current[selectedSeriesId] = res;
          setRawDetail(res);
        })
        .catch(() => {
          if (!active) return;
          if (attempt < 2) {
            setTimeout(() => { if (active) loadDetail(attempt + 1); }, 600);
            return;
          }
          showToast('获取剧集详情失败', 'error');
        });
    };
    loadDetail(1);

    return () => {
      active = false;
    };
  }, [selectedSeriesId, showToast]);

  /**
   * 换一部剧就把选集筛选与页码归零。
   *
   * 不重置的话：上一部剧筛成"已观看"、翻到第 4 页，新剧进来继承这两个值，
   * 用户看到的是"选集面板空了"或"只有最后几集"——像是数据没取到。
   */
  useEffect(() => {
    setEpisodeFilter('all');
    setEpisodePage(0);
    setEpisodeJump('');
  }, [selectedSeriesId]);

  // 详情到手就预热"最可能被点开"的那一集（断点续播集，没有则第一集）。
  //
  // ⚠️ 这里**曾经**调 `prewarmEpisode`（整集 mp4 的 worker 下载 + 解密 + 转存），
  // 现已改为由下面的「整集 HLS 预转」承担。原因是实机日志证明两者会互相打架：
  //
  //   18.574s  resolve 请求开始        ← 本条 effect 抢跑，worker 开始下整集 mp4
  //   19.912s  流式开播 请求开始        ← 用户点播放
  //   24.189s  预转跳过（同一 vid 已在转码） ← HLS 预转被这条占位顶掉
  //   39.912s  resolve 完成 耗时=21279ms 字节=35.7MB
  //
  // 整集 mp4 在方案 B 之后**已经不是播放源**（整集 HLS 才是），它只是「HLS 起不来」
  // 时的退路；而它却要跑 21 秒、下 35MB，且占着「同一 vid 已在转码」的坑，把真正
  // 有用的 HLS 预转挡在门外。用 21 秒的下载去抢 1.5 秒的转码，纯属倒挂。
  //
  // 现在这里只保留**预签名**（下面那条 effect 已负责），整集产物的预热交给
  // HLS 预转 —— 它产出的正是播放要用的东西。
  //
  // 保留 `prewarmedSeriesRef` 与 `prewarmEpisode` 的引用：悬停预热（`schedulePrewarm`）
  // 仍然在用它，那条路径有 420ms 防抖且是用户主动瞄准某集，语义不同。

  // 悬停预热必须防抖：鼠标扫过选集网格会在几百毫秒内触发几十次 hover，
  // 每次都起 worker 会把带宽抢空（store 侧另有并发上限兜底）。
  const schedulePrewarm = (episodeId: string) => {
    if (!detail) return;
    // 悬停先只做"预签名"：签名是点播链路里最贵的一段固定开销（两次 App API
    // 往返，实测约 2.4s），但它比整集下载快得多，几十毫秒的悬停就够发起。
    // 命中之后用户点下去只剩解密那一步，等待时间直接少一半。
    void ipcService.playback.prefetchStream([episodeId], detail.type === 'comic' ? 1004 : 1);
    if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
    hoverTimerRef.current = setTimeout(() => {
      if (!detail) return;
      prewarmEpisodeRef.current(detail.id, episodeId, detail.type === 'comic' ? 1004 : 1);
    }, 420);
  };

  useEffect(() => () => {
    if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
  }, []);

  /**
   * 「猜你喜欢」里点一张卡：就地换成那一部的详情。
   *
   * 走 `navigateTo('detail', id)` 而不是别的入口：`navigateTo` 只在**视图真的变化**
   * 时才写 `previousView`，所以从详情页进另一部详情不会污染返回栈——返回仍然是
   * 用户最初进来的那个页面，而不是"上一部剧的详情"（那会让返回键看起来像失效）。
   *
   * 稳定引用（`useCallback` + 稳定依赖）：`SeriesCard` 是 `React.memo` 的，每次渲染
   * 新建的箭头函数会让整栏卡片全部重渲染。
   *
   * ⚠️ **必须定义在下面那个 `if (!detail) return` 之前**。详情还没到手时组件走的是
   * 骨架屏那条早退分支，钩子却已经在这里执行过一次；把 `useCallback` 放在早退之后，
   * 详情到达的那一帧钩子数量会从 N 跳到 N+1，React 直接抛
   * "Rendered more hooks than during the previous render" —— 整页白屏（实测踩过）。
   */
  const handleOpenRelated = useCallback((seriesId: string) => {
    navigateTo('detail', seriesId);
  }, [navigateTo]);

  /*
    详情还没到手时的占位。

    历史：这里原本是一个居中的转圈。它是「点进详情页卡一下」的直接来源 ——
    详情是单次网络往返（实测 0.3–1.2 秒，慢源更久），而整屏只有一个 spinner，
    用户既看不到剧名、也点不了返回，主观上就是"页面卡住了"。

    改成**骨架屏**：版面结构与真实内容一致，用户立刻知道"要看到什么了"，
    而且这是一次布局、不是一次跳变（真内容进来时位置对得上）。
    返回按钮刻意做成可点 —— 转圈最气人的一点是"连退都退不出去"。
  */
  if (!detail) {
    return (
      <div className="flex-1 h-full overflow-hidden select-none pb-12" aria-busy="true">
        {/* 占位块统一用 .shimmer-loading（扫光 + 凹槽），与列表骨架同一套材质；
            原先的 animate-pulse 是整体呼吸，和别的页面对不上。 */}
        <div className="max-w-7xl mx-auto px-6 sm:px-8 pt-5 flex flex-col gap-6">
          <div className="flex items-center justify-between">
            <button
              onClick={goBack}
              className="inline-flex items-center gap-2 px-3.5 py-1.5 rounded-xl bg-white/85 hover:bg-white text-slate-700 hover:text-blue-600 shadow-xs border border-slate-200/70 text-xs font-semibold cursor-pointer active:scale-95 transition-all"
              title="返回短剧精选"
            >
              <ArrowLeft className="w-4 h-4" />
              <span>返回发现</span>
            </button>
            <div className="h-3 w-40 rounded-full shimmer-loading" />
          </div>
          <div className="flex flex-col md:flex-row gap-7 items-start">
            <div className="w-52 sm:w-60 aspect-[3/4] rounded-2xl shimmer-loading flex-shrink-0" />
            <div className="flex-1 flex flex-col gap-3 pt-0.5">
              <div className="h-3 w-24 rounded-full shimmer-loading" />
              <div className="h-7 w-64 rounded-xl shimmer-loading" />
              <div className="h-3 w-full max-w-lg rounded-full shimmer-loading" />
              <div className="h-3 w-4/5 max-w-md rounded-full shimmer-loading" />
              <div className="h-11 w-40 rounded-xl shimmer-loading mt-2" />
            </div>
          </div>
          <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-6 gap-2.5">
            {Array.from({ length: 12 }).map((_, index) => (
              <div key={index} className="h-9 rounded-lg shimmer-loading" />
            ))}
          </div>
        </div>
      </div>
    );
  }

  const episodes = detail.episodes;
  const totalEpisodes = detail.episodesCount || episodes.length;

  /** 已看（看完，或有一段进度）的集数。选集头部那句「已观看 N 集」用它。 */
  const watchedCount = episodes.filter(
    ep => ep.isFinished || (ep.watchedSeconds || 0) > 0,
  ).length;

  /**
   * 筛选后的集数。
   *
   * 三个档位与规范里的"全部 / 未观看 / 已观看"一致。判定门槛**与集数按钮的
   * 状态色共用同一个表达式**（`isFinished || watchedSeconds > 0`）：两处各写
   * 一份，必然漂移成"筛进来说已观看、显示却是未观看"的白底按钮。
   */
  const filteredEpisodes = episodes.filter(ep => {
    const watched = ep.isFinished || (ep.watchedSeconds || 0) > 0;
    if (episodeFilter === 'watched') return watched;
    if (episodeFilter === 'unwatched') return !watched;
    return true;
  });

  const episodePageCount = Math.max(1, Math.ceil(filteredEpisodes.length / EPISODE_PAGE_SIZE));
  /**
   * 页码夹紧。换筛选 / 数据刷新后总页数会变小，`episodePage` 可能已经越界；
   * 直接切片会得到空数组，用户看到的是"选集空了"。夹到最后一页即可。
   */
  const safeEpisodePage = Math.min(episodePage, episodePageCount - 1);
  const pageStart = safeEpisodePage * EPISODE_PAGE_SIZE;
  const upfrontEpisodes = filteredEpisodes.slice(pageStart, pageStart + EPISODE_PAGE_SIZE);
  /** 一页装不下才需要翻页控件（1–30 集、31–50 集这类直接全展示）。 */
  const hasEpisodePager = filteredEpisodes.length > EPISODE_PAGE_SIZE;

  // 弹窗快速过滤
  const filteredModalEpisodes = modalSearch.trim()
    ? episodes.filter(
        ep => ep.title.toLowerCase().includes(modalSearch.toLowerCase()) || 
              ep.episodeNumber.toString() === modalSearch.trim()
      )
    : episodes;

  /**
   * 「继续观看」锚点：**只要有进度就认，不再排除 `isFinished`**。
   *
   * ## 为什么去掉 `!e.isFinished`（2026-10-19 修「断点续播时有时无」）
   *
   * 旧写法是 `watchedSeconds > 0 && !isFinished`。而 `isFinished` 由前端
   * `percent >= 95` 算出——短剧一集只有 33–68 秒，看到 95% 就置位，
   * 于是这一集被**从续播候选中剔除**，用户重进播放器被带去看别的集。
   *
   * 现在 `isFinished` 的判定已收紧（98% 且剩余 ≤3 秒），但这里再兜一层：
   * 就算某一集真的被标成看完，只要它有进度，仍然应该作为锚点——
   * 用户点「继续观看」时的预期是"回到我上次看到的地方"，
   * 而不是"因为我看完了，所以给你从第一集重来"。
   *
   * 排序按**集号最大**取（`EpisodeItem` 没有时间戳字段）：短剧是顺看，
   * 看得最远的那一集就是最近看的那一集，这与"最近观看优先"等价。
   */
  const lastWatchedEp =
    [...episodes]
      .filter(e => (e.watchedSeconds || 0) > 0)
      .sort((left, right) => right.episodeNumber - left.episodeNumber)[0] ||
    episodes[0] ||
    null;

  /**
   * 「上次看到哪儿」的全部数字。
   *
   * 只有**真的有进度**才返回；`watchedSeconds` 为 0（或没有历史）时返回 null，
   * Hero 里那条进度条整块不渲染 —— 不显示"已看 0%"这种占位。
   */
  const watchProgress = (() => {
    const ep = lastWatchedEp;
    const watched = Math.max(0, Math.round(ep?.watchedSeconds || 0));
    if (!ep || watched <= 0) return null;
    const duration = Math.max(0, Math.round(ep.durationSeconds || 0));
    const percent = duration > 0 ? Math.min(100, (watched / duration) * 100) : 0;
    const remaining = duration > 0 ? Math.max(0, duration - watched) : 0;
    return {
      episode: ep,
      watched,
      duration,
      percent,
      remaining,
      /** 进播放器要用的起点；`isFinished` 时归零（重新播放不该停在那 3 秒上）。 */
      startAt: ep.isFinished ? 0 : watched,
    };
  })();

  /**
   * 集数跳转：输入框里是**集号**（`episodeNumber`），不是数组下标。
   *
   * 服务端的集号不保证与下标相等（预告集、下架集都会让两者错开），所以按集号
   * 找对应条目，找不到就什么都不做 —— 而不是 `episodes[n]` 那样悄悄播错一集。
   */
  const handleJumpToEpisode = () => {
    const target = Number.parseInt(episodeJump.trim(), 10);
    if (!Number.isFinite(target)) return;
    const ep = episodes.find(item => item.episodeNumber === target);
    if (!ep) {
      showToast(`没有第 ${target} 集`, 'error');
      return;
    }
    setEpisodeJump('');
    handleStartPlay(ep);
  };

  /**
   * 播放某一集。`startAt` 不给时用这一集自己的进度。
   *
   * 单独一个入参是为了「已看完」的那种情况：此时用户的意图是"重看"，而不是
   * "从片尾 3 秒处接着播"。判定在调用方（Hero 的 `watchProgress.startAt`），
   * 这里只负责把数字交给播放链路。
   */
  const handleStartPlay = (ep: EpisodeItem, startAt?: number) => {
    setShowAllEpisodesModal(false);
    // 动漫专区走**独立播放器**（AnimeVideoSurface + useAnimePlayerStore）。
    //
    // 为什么必须分流：动漫源与短剧源在三个维度上不同——① 同一部剧的不同集回来
    // 的是 m3u8 或整段 MP4；② WebView2 的 canPlayType 对 HLS 谎报 "maybe"，
    // 照它判就会把 m3u8 交给原生 <video>（15 秒后仍无画面，只有声音）；
    // ③ dmghg 的档位里混着 HEVC。这套判定与看门狗只对动漫有意义，短剧/漫剧
    // 继续走原来的链路，互不影响。
    const resumeAt = startAt ?? (ep.watchedSeconds || 0);
    if (detail.type === 'anime') {
      void openAnimeEpisode(detail.id, ep.id, resumeAt);
      return;
    }
    navigateTo('player', detail.id);
    openEpisode(detail.id, ep.id, resumeAt);
  };

  return (
    <div className="flex-1 h-full overflow-y-auto select-none pb-12">
      <div className="max-w-7xl mx-auto px-6 sm:px-8 pt-5 flex flex-col gap-6">
        {/* 顶部导航行：返回按钮与面包屑路径 */}
        <div className="flex items-center justify-between">
          <button
            onClick={goBack}
            className="inline-flex items-center gap-2 px-3.5 py-1.5 rounded-xl bg-white/85 hover:bg-white text-slate-700 hover:text-blue-600 shadow-xs border border-slate-200/70 backdrop-blur-md transition-all text-xs font-semibold cursor-pointer active:scale-95"
              title="返回短剧精选"
          >
            <ArrowLeft className="w-4 h-4" />
            <span>返回发现</span>
          </button>

          <div className="flex items-center gap-2 text-xs text-slate-400">
            <span>短剧精选</span>
            <span>/</span>
            <span className="text-slate-700 font-semibold truncate max-w-xs sm:max-w-md">{detail.title}</span>
          </div>
        </div>

        {/*
          Hero 主展示区。

          ## 光源氛围为什么这样做

          规范里建议"从海报提取主色生成低透明度渐变光晕"。取主色需要把封面画进
          canvas 再读像素，而封面来源有三种（红果 HEIC 转码后的本地缓存、guo-core
          下载的本地文件、直连 CDN），`asset:` / `http:` 混在一起，跨域策略随时可能
          让 `getImageData` 抛 SecurityError —— 那会让整个 Hero 白屏。

          这里改用**同一张封面的模糊副本**叠在 Hero 背后：`blur-3xl` + 缩放 +
          极低不透明度，取色问题自然消失（模糊后的像素就是这张海报的平均色）。
          关键是**不铺满整页**：它被限制在 Hero 这一块 320px 高的区域内，正文
          始终落在白底上，所以不会出现"模糊海报铺满背景导致文字读不清"。
        */}
        <div className="relative">
          <div
            aria-hidden="true"
            className="pointer-events-none absolute -top-8 left-0 h-[280px] w-[min(100%,640px)] overflow-hidden opacity-[0.16] blur-3xl"
            style={{
              backgroundImage: detail.cover ? `url("${detail.cover}")` : undefined,
              backgroundSize: 'cover',
              backgroundPosition: 'center',
              // 取色失败（HEIC / 跨域 / 404）时这层就是空的 —— 兜底一层同色系
              // 的冷光，保证 Hero 在任何封面条件下都有层次，而不是纯白。
              backgroundColor: 'rgba(59, 130, 246, 0.10)',
              maskImage: 'radial-gradient(ellipse at 20% 40%, black 0%, transparent 72%)',
              WebkitMaskImage: 'radial-gradient(ellipse at 20% 40%, black 0%, transparent 72%)',
            }}
          />
        <div className="relative flex flex-col md:flex-row gap-7 items-start">
          {/* 核心海报：3:4 比例，带 animate-fluent-hero-poster 硬件加速平滑入场 */}
          <div className="relative w-52 sm:w-60 aspect-[3/4] rounded-2xl overflow-hidden shadow-fluent-hud border-2 border-white flex-shrink-0 bg-white animate-fluent-hero-poster transition-transform duration-300 hover:scale-[1.02]">
            {/* 这里是封面缺失最刺眼的位置：源站脏数据（实测有指向已 404 的第三方
                图床）会让整块海报变成白框，而列表卡片当时已经有首字兜底。

                `resolveSrc` 必须传（2026-10-24）：guo 源的封面直连在 WebView 里
                不可靠（黄果视频有 Cloudflare 防护实测 403，部分源还是加密码），
                唯一稳的路是 guo-core 带源侧 Referer 下载后给本地文件路径。列表
                卡片一直有这一条、详情页 Hero 却漏了 —— 表现是"卡片上有图，点进
                详情反而只剩首字"，而且每次进详情都要重新直连失败一轮。 */}
            <CoverImage
              src={detail.cover}
              title={detail.title}
              fallbackChar="影"
              placeholderTextClassName="text-5xl"
              loading="eager"
              fetchPriority="high"
              resolveSrc={coverResolver(detail.id, detail.cover)}
            />
          </div>

          {/* 右侧详细资料与操作区 */}
          <div className="flex-1 flex flex-col gap-3 pt-0.5">
            {/* 顶部分类与来源元数据徽章 */}
            <div className="flex items-center gap-2 flex-wrap">
              <StatusBadge
                label={detail.type === 'drama' ? '短剧爆款' : detail.type === 'anime' ? '动漫专区' : '漫剧专享'}
                variant="blue"
                dot
              />
              <span className="text-xs text-slate-600 font-semibold bg-white/85 px-2.5 py-0.5 rounded-lg border border-slate-200/60 shadow-xs">
                {detail.type === 'anime' && detail.episodesCount === 0
                  ? '单集/已完结'
                  : // App 给了集数角标就用它：「更新至 12 集」比「共 12 集全」准确得多，
                    // 后者会把连载中的剧说成已完结。拿不到才退回集数。
                    hongguoMeta?.rightText
                    ? hongguoMeta.rightText
                    : `共 ${detail.episodesCount} 集全`}
              </span>
              {/* 连载状态：只有 App 详情明确给了状态才显示（0 更新中 / 1 已完结）。
                  与上面的集数角标是两条信息，不合并——「更新至12集」+「连载中」才完整。 */}
              {hongguoMeta && hongguoMeta.status === 1 && (
                <span className="text-xs font-semibold bg-emerald-50 text-emerald-700 px-2.5 py-0.5 rounded-lg border border-emerald-200/70 shadow-xs">
                  已完结
                </span>
              )}
              {hongguoMeta && hongguoMeta.status === 0 && (
                <span className="text-xs font-semibold bg-sky-50 text-sky-700 px-2.5 py-0.5 rounded-lg border border-sky-200/70 shadow-xs">
                  连载中
                </span>
              )}
              {/* 热度：原文案（"4102万热度"）由服务端给，不在这里换算。 */}
              {hongguoMeta && hongguoMeta.playCount > 0 && (
                <span className="text-xs font-medium text-slate-500 bg-white/85 px-2.5 py-0.5 rounded-lg border border-slate-200/60 shadow-xs">
                  {hongguoMeta.playCount >= 10000
                    ? `${Math.round(hongguoMeta.playCount / 10000)} 万播放`
                    : `${hongguoMeta.playCount} 播放`}
                </span>
              )}
              <span className="text-xs text-slate-300">|</span>
              <span className="text-xs text-slate-500 font-medium">{detail.origin}</span>
            </div>

            {/* 剧集主标题 */}
            <h1 className="text-[26px] sm:text-[30px] font-black text-slate-900 tracking-tight leading-[1.28]">
              {detail.title}
            </h1>

            {/* 题材标签列表 */}
            <div className="flex items-center gap-1.5 flex-wrap">
              {detail.tags.map((tag) => (
                <span
                  key={tag}
                  className="px-2.5 py-0.5 rounded-lg text-xs font-medium bg-white/80 text-slate-700 border border-slate-200/70 shadow-xs"
                >
                  {tag}
                </span>
              ))}
            </div>

            {/* 剧情简介 */}
            <div className="text-xs text-slate-600 leading-relaxed max-w-2xl bg-white/60 backdrop-blur-md p-3.5 rounded-2xl border border-white/80 shadow-xs">
              {/* `text-pretty` 交给浏览器做孤字规避（`text-wrap: pretty`）。
                  这里是最值得加的一处：简介是自由长度的中文正文，末行只剩一两个
                  字时（"…被逐出家门。"）读起来像排版事故，而这一行又正好紧贴着
                  「展开完整简介」按钮，孤字会与按钮挤在一起。 */}
              <p className={`text-pretty ${isDescExpanded ? '' : 'line-clamp-3'}`}>
                {detail.description}
              </p>
              <button
                onClick={() => setIsDescExpanded(!isDescExpanded)}
                className="mt-1.5 text-blue-600 hover:text-blue-700 font-semibold inline-flex items-center gap-0.5 cursor-pointer text-[11px]"
              >
                <span>{isDescExpanded ? '收起简介' : '展开完整简介'}</span>
                {isDescExpanded ? (
                  <ChevronUp className="w-3 h-3" />
                ) : (
                  <ChevronDown className="w-3 h-3" />
                )}
              </button>
            </div>

            {/* 上次观看：把「看到哪一集 / 看到哪一秒 / 还剩多久」串成一条可点的进度线。
                只有真的有进度才渲染，没有历史时整块不出现（不显示「已看 0%」这种占位）。 */}
            {watchProgress && (
              <button
                type="button"
                onClick={() => handleStartPlay(watchProgress.episode, watchProgress.startAt)}
                className="group mt-1 flex w-full max-w-2xl items-center gap-3 rounded-2xl border border-blue-100/80 bg-gradient-to-r from-blue-50/90 to-white/70 px-3.5 py-2.5 text-left shadow-xs transition-all hover:border-blue-300 hover:shadow-sm active:scale-[0.995] cursor-pointer"
              >
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-blue-600 text-white shadow-sm shadow-blue-500/25">
                  <Play className="h-3.5 w-3.5 fill-current" />
                </span>
                <span className="flex min-w-0 flex-1 flex-col gap-1.5">
                  <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] font-semibold text-slate-600">
                    <span className="truncate">上次观看 · 第 {watchProgress.episode.episodeNumber} 集</span>
                    <span className="shrink-0 tabular-nums text-slate-400">
                      {formatClock(watchProgress.watched)} / {formatClock(watchProgress.duration)}
                    </span>
                    {watchProgress.remaining > 0 && (
                      <span className="shrink-0 text-blue-500">{formatRemaining(watchProgress.remaining)}</span>
                    )}
                  </span>
                  <span className="h-1.5 w-full overflow-hidden rounded-full bg-blue-100/80">
                    <span
                      className="block h-full rounded-full bg-blue-600 transition-[width] duration-500"
                      style={{ width: `${Math.max(2, watchProgress.percent)}%` }}
                    />
                  </span>
                </span>
                <span className="shrink-0 text-[11px] font-bold text-blue-600 opacity-0 transition-opacity group-hover:opacity-100">
                  继续观看 →
                </span>
              </button>
            )}

            {/* 主操作按键行 */}
            <div className="flex items-center gap-3 mt-1">
              <button
                  onClick={() =>
                    lastWatchedEp &&
                    handleStartPlay(
                      lastWatchedEp,
                      watchProgress?.episode.id === lastWatchedEp.id ? watchProgress.startAt : undefined,
                    )
                  }
                  disabled={!lastWatchedEp}
                className="flex items-center gap-2 px-6 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-700 text-white text-xs font-bold shadow-md shadow-blue-500/25 active:scale-95 transition-all cursor-pointer"
              >
                <Play className="w-4 h-4 fill-current" />
                <span>
                  {watchProgress
                    ? `继续播放 第 ${watchProgress.episode.episodeNumber} 集`
                    : '播放第 1 集'}
                </span>
              </button>

              <button
                onClick={() => {
                  // 收藏三态轮转：未收藏 → 想看 → 在看 → 已看 → 取消。
                  // 与观看历史相互独立：取消收藏不删历史。
                  const current = detail ? markBySeriesId.get(detail.id) : undefined;
                  const next = current === 'want' ? 'watching' : current === 'watching' ? 'done' : current === 'done' ? null : 'want';
                  if (detail) {
                    void setMark(detail.id, detail.title, detail.cover, next, detail.type);
                  }
                }}
                className={`flex items-center gap-2 px-5 py-2.5 rounded-xl text-xs font-semibold shadow-xs active:scale-95 transition-all cursor-pointer border ${
                  detail && markBySeriesId.get(detail.id)
                    ? 'bg-rose-50 hover:bg-rose-100 text-rose-600 border-rose-200/80'
                    : 'bg-white hover:bg-slate-50 text-slate-700 border-slate-200/80'
                }`}
                title="点击切换追剧状态：想看 → 在看 → 已看"
              >
                <Heart
                  className={`w-4 h-4 transition-transform ttv-spring-pop ${
                    detail && markBySeriesId.get(detail.id)
                      ? 'fill-current text-rose-500 scale-110'
                      : 'text-slate-500 scale-100'
                  }`}
                />
                <span>
                  {(() => {
                    const current = detail ? markBySeriesId.get(detail.id) : undefined;
                    return current ? `已标「${current === 'want' ? '想看' : current === 'watching' ? '在看' : '已看'}」` : '加入追剧';
                  })()}
                </span>
              </button>

              <button
                onClick={() => {
                  // 旧实现只弹了个"已复制"的提示，从未真正写入剪贴板——
                  // 用户粘贴时拿到的是空的。这里改为真的复制，并在失败时
                  // 如实告知，而不是继续假装成功。
                  const link = `https://hongguoduanju.com/detail?series_id=${detail?.id ?? ''}`;
                  void navigator.clipboard
                    ?.writeText(link)
                    .then(
                      () => showToast('已复制剧集链接到剪贴板', 'success'),
                      () => showToast('复制失败，请手动复制剧集 ID', 'error'),
                    );
                }}
                className="flex items-center gap-2 px-5 py-2.5 rounded-xl bg-white hover:bg-slate-50 text-slate-700 border border-slate-200/80 text-xs font-semibold shadow-xs active:scale-95 transition-all cursor-pointer"
              >
                <Tv className="w-4 h-4 text-slate-500" />
                <span>分享此剧</span>
              </button>

              {/*
                「系列剧」入口：把这部剧**其它所有季**铺成一个弹窗。

                ## 为什么在这一行、为什么带条件

                位置：主操作行是详情页唯一"这部剧能做什么"的集中入口，用户扫一眼
                就知道有这一项；而它紧挨在「分享此剧」之后，不打断"播放 → 追剧 →
                分享"这条主链路。

                条件：`canLookupSeasons` 与数据层用的是**同一份**判定（不分季的剧、
                guo 源、18+ 频道都返回 false）。不共用的话必然漂移成"按钮点得开、
                窗口永远是空的"——那比没有按钮更糟。判不出来就整颗按钮不渲染，
                而不是渲染一颗点了没反应的按钮。

                配色：沿用选集面板头部 `Layers` 图标的蓝族，与「系列」这件事在
                全站的一致性对齐（violet 是"猜你喜欢/推荐"的语义色，这里不是推荐）。
              */}
              {detail && canLookupSeasons(detail) && (
                <button
                  onClick={() => setShowSeasonsDialog(true)}
                  title="查看这个系列的其它季"
                  className="flex items-center gap-2 px-5 py-2.5 rounded-xl bg-blue-50/90 hover:bg-blue-100 text-blue-700 border border-blue-200/70 text-xs font-semibold shadow-xs active:scale-95 transition-all cursor-pointer"
                >
                  <Layers3 className="w-4 h-4 text-blue-600" />
                  <span>系列剧</span>
                </button>
              )}
            </div>
          </div>
        </div>
        </div>

        {/* 选集播放：保留原来的网格，把「状态 / 筛选 / 跳转 / 分页」补齐。
            面板与「全部选集」弹窗共用同一颗 EpisodeButton，配色与状态判定不会漂移。 */}
        <MicaCard className="p-5 flex flex-col gap-4">
          <div className="flex flex-wrap items-center justify-between gap-3 pb-3 border-b border-black/[0.04]">
            <div className="flex items-center gap-2.5">
              <h2 className="text-sm font-bold text-slate-800">选集播放</h2>
              <span className="text-xs text-slate-400">
                共 {totalEpisodes} 集 · 已观看 {watchedCount} 集
              </span>
            </div>

            {/* 状态图例 */}
            <div className="flex items-center gap-3 text-[11px] text-slate-400">
              <span className="inline-flex items-center gap-1">
                <span className="w-3.5 h-3.5 rounded bg-blue-600 flex items-center justify-center text-white shadow-xs">
                  <Play className="w-2 h-2 fill-current" />
                </span>
                <span className="text-slate-600 font-medium">当前播放</span>
              </span>
              <span className="inline-flex items-center gap-1">
                <span className="w-3.5 h-3.5 rounded bg-blue-50 border border-blue-200 flex items-center justify-center text-blue-500">
                  <Check className="w-2.5 h-2.5 stroke-[2.5]" />
                </span>
                <span>已看完</span>
              </span>
            </div>
          </div>

          {/* 筛选 / 集号跳转 / 全部选集入口，合成一条控制条 */}
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex items-center gap-1 rounded-xl border border-slate-200/70 bg-slate-100/90 p-1">
              {([['all', '全部'], ['unwatched', '未观看'], ['watched', '已观看']] as const).map(([key, label]) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => { setEpisodeFilter(key); setEpisodePage(0); }}
                  className={`rounded-lg px-2.5 py-1 text-[11px] font-semibold transition-all cursor-pointer ${
                    episodeFilter === key
                      ? 'bg-white text-blue-600 shadow-xs'
                      : 'text-slate-500 hover:bg-white/60 hover:text-slate-800'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>

            <div className="relative w-32">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-400 pointer-events-none" />
              <input
                type="text"
                inputMode="numeric"
                value={episodeJump}
                onChange={(e) => setEpisodeJump(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') handleJumpToEpisode(); }}
                placeholder="跳到第 N 集"
                className="ttv-input w-full h-8 pl-8 pr-2 text-xs bg-white rounded-lg border border-slate-200/80 shadow-xs"
              />
            </div>
            <button
              type="button"
              onClick={handleJumpToEpisode}
              className="h-8 px-2.5 rounded-lg bg-white hover:bg-blue-50 text-slate-600 hover:text-blue-600 border border-slate-200/80 text-[11px] font-semibold shadow-xs active:scale-95 transition-all cursor-pointer"
            >
              跳转
            </button>

            <span className="flex-1" />

            <button
              type="button"
              onClick={() => setShowAllEpisodesModal(true)}
              title="在弹窗里搜索全部集数"
              className="inline-flex h-8 items-center gap-1 rounded-lg border border-slate-200/80 bg-white px-2.5 text-[11px] font-semibold text-slate-500 shadow-xs transition-colors hover:text-blue-600 active:scale-95 cursor-pointer"
            >
              <MoreHorizontal className="w-3.5 h-3.5" />
              全部选集
            </button>
          </div>

          {episodes.length === 0 ? (
            <div className="py-8 text-center text-xs text-slate-500">
              当前剧集暂未返回可播放集数，后端可能仅开放红果 App 播放。
            </div>
          ) : filteredEpisodes.length === 0 ? (
            <div className="py-8 text-center text-xs text-slate-500">
              这个筛选下没有集数。
              <button
                type="button"
                onClick={() => { setEpisodeFilter('all'); setEpisodePage(0); }}
                className="ml-1 font-semibold text-blue-600 hover:text-blue-700 cursor-pointer"
              >
                看全部
              </button>
            </div>
          ) : (
            <>
              <div className="grid grid-cols-5 sm:grid-cols-8 md:grid-cols-10 gap-2">
                {upfrontEpisodes.map((ep) => (
                  <EpisodeButton
                    key={ep.id}
                    ep={ep}
                    isCurrent={lastWatchedEp?.id === ep.id}
                    onPlay={handleStartPlay}
                    onPrewarm={schedulePrewarm}
                  />
                ))}
              </div>

              <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-slate-400">
                <span>
                  显示 {pageStart + 1}–{pageStart + upfrontEpisodes.length} 集 · 本筛选共 {filteredEpisodes.length} 集
                </span>
                {hasEpisodePager && (
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      disabled={safeEpisodePage === 0}
                      onClick={() => setEpisodePage((page) => Math.max(0, page - 1))}
                      className="rounded-lg border border-slate-200/80 bg-white px-2 py-1 font-semibold text-slate-500 shadow-xs transition-colors hover:text-blue-600 disabled:cursor-not-allowed disabled:opacity-40 cursor-pointer"
                    >
                      ← 上一页
                    </button>
                    <span className="tabular-nums">{safeEpisodePage + 1} / {episodePageCount} 页</span>
                    <button
                      type="button"
                      disabled={safeEpisodePage >= episodePageCount - 1}
                      onClick={() => setEpisodePage((page) => Math.min(episodePageCount - 1, page + 1))}
                      className="rounded-lg border border-slate-200/80 bg-white px-2 py-1 font-semibold text-slate-500 shadow-xs transition-colors hover:text-blue-600 disabled:cursor-not-allowed disabled:opacity-40 cursor-pointer"
                    >
                      下一页 →
                    </button>
                  </div>
                )}
              </div>
            </>
          )}
        </MicaCard>

        {/* 猜你喜欢：只出同频道其它剧，**同系列已在数据层剔除**（用户要求把系列
            短剧移出这一栏，改由上面的「系列剧」按钮弹窗完整展示）。
            替换掉原来的「可用播放解析通道与健康度」面板——那一块的数据源
            （`detail.sources`）在真实链路里恒为空，永远只显示一句占位文案。 */}
        <RelatedSeriesSection detail={detail} onOpen={handleOpenRelated} />
      </div>

      {/* 系列剧弹窗：铺开这部剧**其它所有季**，当前季不在其中（数据层已排除）。 */}
      {showSeasonsDialog && (
        <SeriesSeasonsDialog
          detail={detail}
          onOpen={handleOpenRelated}
          onClose={() => setShowSeasonsDialog(false)}
        />
      )}

      {/* 选集弹窗 (Modal) */}
      {showAllEpisodesModal && (
        <div 
          onClick={() => setShowAllEpisodesModal(false)}
          className="fixed inset-0 z-50 flex items-center justify-center p-6 bg-black/40 backdrop-blur-sm animate-fade-in select-none"
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-4xl max-h-[80vh] rounded-3xl bg-white/95 backdrop-blur-2xl border border-white shadow-fluent-hud flex flex-col overflow-hidden animate-fluent-scale-in"
          >
            {/* 弹窗顶部栏 */}
            <div className="h-14 px-6 flex items-center justify-between border-b border-black/[0.05] bg-slate-50/70 flex-shrink-0">
              <div className="flex items-center gap-2.5">
                <div className="w-8 h-8 rounded-lg bg-blue-50 text-blue-600 flex items-center justify-center border border-blue-200/60">
                  <Layers className="w-4 h-4" />
                </div>
                <div>
                  <h3 className="text-sm font-bold text-slate-800">
                    全部选集 ({totalEpisodes} 集全)
                  </h3>
                  <p className="text-[11px] text-slate-400">
                    {detail.title}
                  </p>
                </div>
              </div>

              {/* 快速数字搜索框与关闭按钮 */}
              <div className="flex items-center gap-3">
                <div className="relative w-48">
                  <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-400 pointer-events-none" />
                  <input
                    type="text"
                    value={modalSearch}
                    onChange={(e) => setModalSearch(e.target.value)}
                    placeholder="输入集数直接定位..."
                    className="ttv-input w-full h-8 pl-8 pr-7 text-xs bg-white rounded-lg border border-slate-200/80 shadow-xs"
                  />
                  {modalSearch && (
                    <button
                      type="button"
                      onClick={() => setModalSearch('')}
                      className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 p-0.5 cursor-pointer"
                    >
                      <X className="w-3 h-3" />
                    </button>
                  )}
                </div>

                <button
                  type="button"
                  onClick={() => setShowAllEpisodesModal(false)}
                  className="p-1.5 rounded-lg text-slate-400 hover:text-slate-700 hover:bg-slate-100 transition-colors cursor-pointer"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            </div>

            {/* 弹窗内容：所有集数的数字方块网格 (平整、纯净) */}
            <div className="flex-1 overflow-y-auto p-6">
              <div className="grid grid-cols-5 sm:grid-cols-8 md:grid-cols-10 gap-2 content-start">
                {filteredModalEpisodes.map((ep) => (
                  <EpisodeButton
                    key={ep.id}
                    ep={ep}
                    isCurrent={lastWatchedEp?.id === ep.id}
                    onPlay={handleStartPlay}
                    onPrewarm={schedulePrewarm}
                  />
                ))}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
