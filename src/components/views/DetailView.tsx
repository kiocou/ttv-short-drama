import React, { useState, useEffect, useRef } from 'react';
import { useAppStore } from '../../stores/useAppStore';
import { usePlaybackStore } from '../../stores/usePlaybackStore';
import { ipcService } from '../../services/ipc';
import { SeriesDetail, EpisodeItem } from '../../types/series';
import { MicaCard } from '../common/MicaCard';
import { FluentButton } from '../common/FluentButton';
import { StatusBadge } from '../common/StatusBadge';
import { 
  Play, 
  ArrowLeft, 
  ShieldCheck, 
  ChevronDown, 
  ChevronUp,
  Tv,
  MoreHorizontal,
  X,
  Search,
  Layers,
  Check
} from 'lucide-react';

export const DetailView: React.FC = () => {
  const { selectedSeriesId, navigateTo, goBack, showToast } = useAppStore();
  const { openEpisode, prewarmEpisode } = usePlaybackStore();
  const detailCacheRef = useRef<Record<string, SeriesDetail>>({});
  // 供 effect 读取最新实现，避免把 prewarmEpisode 放进依赖数组导致每次渲染重跑。
  const prewarmEpisodeRef = useRef(prewarmEpisode);
  prewarmEpisodeRef.current = prewarmEpisode;
  const hoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const prewarmedSeriesRef = useRef<Set<string>>(new Set());

  const [detail, setDetail] = useState<SeriesDetail | null>(null);
  const [isDescExpanded, setIsDescExpanded] = useState(false);
  const [showAllEpisodesModal, setShowAllEpisodesModal] = useState(false);

  // 打开详情页就预签名接下来几集的播放直链。
  //
  // `stream` 只有两次 App API 往返、不下载任何媒体，实测固定 2.16s，是首播
  // 耗时里最大的一块固定开销。用户在详情页通常停留数秒到数十秒，正好覆盖它；
  // 点集时后端直接命中缓存，这段等待就消失了。从"继续观看"那一集开始取，
  // 因为那是最可能被点的。失败静默——预签名是纯优化。
  useEffect(() => {
    if (!detail || detail.episodes.length === 0) return;
    const anchor = detail.episodes.findIndex(ep => (ep.watchedSeconds || 0) > 0 && !ep.isFinished);
    const start = anchor >= 0 ? anchor : 0;
    const vids = detail.episodes.slice(start, start + 6).map(ep => ep.id);
    if (vids.length === 0) return;
    void ipcService.playback.prefetchStream(vids, detail.type === 'comic' ? 1004 : 1);
  }, [detail]);
  const [modalSearch, setModalSearch] = useState('');

  // 详情和可播放集数始终以当前项目后端返回的数据为准。
  useEffect(() => {
    if (!selectedSeriesId) {
      setDetail(null);
      return;
    }

    const cached = detailCacheRef.current[selectedSeriesId];
    if (cached) {
      setDetail(cached);
      return;
    }

    let active = true;
    setDetail(null);

    ipcService.series.getDetail(selectedSeriesId)
      .then((res) => {
        if (!active) return;
        detailCacheRef.current[selectedSeriesId] = res;
        setDetail(res);
      })
      .catch(() => {
        if (active) {
          showToast('获取剧集详情失败', 'error');
        }
      });

    return () => {
      active = false;
    };
  }, [selectedSeriesId, showToast]);

  // 详情到手就预热"最可能被点开"的那一集（断点续播集，没有则第一集）。
  // 用户在详情页看简介、翻选集通常要停留数秒，这段时间足够把该集所需数据拉下来；
  // 此前预热只在进入播放器之后才开始，等于白白丢掉这段可利用的窗口。
  useEffect(() => {
    if (!detail || detail.episodes.length === 0) return;
    const seriesKey = detail.id;
    if (prewarmedSeriesRef.current.has(seriesKey)) return;
    prewarmedSeriesRef.current.add(seriesKey);
    const target =
      detail.episodes.find(ep => (ep.watchedSeconds || 0) > 0 && !ep.isFinished) || detail.episodes[0];
    prewarmEpisodeRef.current(detail.id, target.id, detail.type === 'comic' ? 1004 : 1);
  }, [detail]);

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

  if (!detail) {
    return (
      <div className="flex-1 h-full flex items-center justify-center select-none">
        <div className="w-7 h-7 border-2 border-blue-600 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  const episodes = detail.episodes;
  const totalEpisodes = detail.episodesCount || episodes.length;
  // 前面直接紧凑列出前50集
  const upfrontEpisodes = episodes.slice(0, 50);
  const hasMoreThan50 = totalEpisodes > 50;

  // 弹窗快速过滤
  const filteredModalEpisodes = modalSearch.trim()
    ? episodes.filter(
        ep => ep.title.toLowerCase().includes(modalSearch.toLowerCase()) || 
              ep.episodeNumber.toString() === modalSearch.trim()
      )
    : episodes;

  // 检查是否有观看历史或从第一集开始
  const lastWatchedEp = episodes.find(e => (e.watchedSeconds || 0) > 0 && !e.isFinished) || episodes[0] || null;

  const handleStartPlay = (ep: EpisodeItem) => {
    setShowAllEpisodesModal(false);
    navigateTo('player', detail.id);
    openEpisode(detail.id, ep.id, ep.watchedSeconds || 0);
  };

  return (
    <div className="flex-1 h-full overflow-y-auto select-none pb-12">
      <div className="max-w-6xl mx-auto px-6 sm:px-8 pt-5 flex flex-col gap-6">
        {/* 顶部导航行：返回按钮与面包屑路径 */}
        <div className="flex items-center justify-between">
          <button
            onClick={goBack}
            className="inline-flex items-center gap-2 px-3.5 py-1.5 rounded-xl bg-white/85 hover:bg-white text-slate-700 hover:text-blue-600 shadow-xs border border-slate-200/70 backdrop-blur-md transition-all text-xs font-semibold cursor-pointer active:scale-95"
            title="返回发现精选"
          >
            <ArrowLeft className="w-4 h-4" />
            <span>返回发现</span>
          </button>

          <div className="flex items-center gap-2 text-xs text-slate-400">
            <span>发现精选</span>
            <span>/</span>
            <span className="text-slate-700 font-semibold truncate max-w-xs sm:max-w-md">{detail.title}</span>
          </div>
        </div>

        {/* Hero 主展示区：3:4 核心海报 (带 GPU 硬件加速缩放就位动效) + 详细资料与操作区 */}
        <div className="flex flex-col md:flex-row gap-7 items-start">
          {/* 核心海报：3:4 比例，带 animate-fluent-hero-poster 硬件加速平滑入场 */}
          <div className="w-44 sm:w-52 aspect-[3/4] rounded-2xl overflow-hidden shadow-fluent-hud border-2 border-white flex-shrink-0 bg-white animate-fluent-hero-poster transition-transform duration-300 hover:scale-[1.02]">
            <img
              src={detail.cover}
              alt={detail.title}
              className="w-full h-full object-cover"
            />
          </div>

          {/* 右侧详细资料与操作区 */}
          <div className="flex-1 flex flex-col gap-3 pt-0.5">
            {/* 顶部分类与来源元数据徽章 */}
            <div className="flex items-center gap-2 flex-wrap">
              <StatusBadge
                label={detail.type === 'drama' ? '短剧爆款' : '漫剧专享'}
                variant="blue"
                dot
              />
              <span className="text-xs text-slate-600 font-semibold bg-white/85 px-2.5 py-0.5 rounded-lg border border-slate-200/60 shadow-xs">
                共 {detail.episodesCount} 集全
              </span>
              <span className="text-xs text-slate-300">|</span>
              <span className="text-xs text-slate-500 font-medium">{detail.origin}</span>
            </div>

            {/* 剧集主标题 */}
            <h1 className="text-2xl sm:text-3xl font-black text-slate-900 tracking-tight leading-snug">
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
              <p className={isDescExpanded ? '' : 'line-clamp-2'}>
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

            {/* 主操作按键行 */}
            <div className="flex items-center gap-3 mt-1">
              <button
                  onClick={() => lastWatchedEp && handleStartPlay(lastWatchedEp)}
                  disabled={!lastWatchedEp}
                className="flex items-center gap-2 px-6 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-700 text-white text-xs font-bold shadow-md shadow-blue-500/25 active:scale-95 transition-all cursor-pointer"
              >
                <Play className="w-4 h-4 fill-current" />
                <span>
                  {lastWatchedEp?.watchedSeconds
                    ? `继续观看 (第 ${lastWatchedEp.episodeNumber} 集)`
                    : '立即播放第 1 集'}
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
            </div>
          </div>
        </div>

        {/* 选集面板：平整通透的现代化网格 (彻底告别深灰色沉重凹槽) */}
        <MicaCard className="p-5 flex flex-col gap-4">
          <div className="flex items-center justify-between pb-3 border-b border-black/[0.04]">
            <div className="flex items-center gap-2.5">
              <h2 className="text-sm font-bold text-slate-800">
                选集播放
              </h2>
              <span className="text-xs text-slate-400">
                {hasMoreThan50 ? `(展示 1-50 集 · 全剧共 ${totalEpisodes} 集)` : `(共 ${totalEpisodes} 集全)`}
              </span>
            </div>

            {/* 状态图例：清晰指示“当前播放”与“已看完” */}
            <div className="flex items-center gap-3 text-[11px] text-slate-400">
              <span className="inline-flex items-center gap-1">
                <span className="w-3.5 h-3.5 rounded bg-blue-600 flex items-center justify-center text-white shadow-xs">
                  <Play className="w-2 h-2 fill-current" />
                </span>
                <span className="text-slate-600 font-medium">当前播放</span>
              </span>
              <span className="inline-flex items-center gap-1">
                <span className="w-3.5 h-3.5 rounded bg-slate-100 border border-slate-200 flex items-center justify-center text-slate-400">
                  <Check className="w-2.5 h-2.5 stroke-[2.5]" />
                </span>
                <span>已看完</span>
              </span>
            </div>
          </div>

          {/* 平整清晰的剧集数字方块网格 (自适应 5~10 列，纯净无内陷灰槽) */}
          {episodes.length === 0 ? (
            <div className="py-8 text-center text-xs text-slate-500">
              当前剧集暂未返回可播放集数，后端可能仅开放红果 App 播放。
            </div>
          ) : (
          <div className="grid grid-cols-5 sm:grid-cols-8 md:grid-cols-10 gap-2">
            {upfrontEpisodes.map((ep) => {
              const hasProgress = (ep.watchedSeconds || 0) > 0;
              const isCurrent = lastWatchedEp.id === ep.id;

              return (
                <button
                  key={ep.id}
                  type="button"
                  onMouseEnter={() => schedulePrewarm(ep.id)}
                  onFocus={() => schedulePrewarm(ep.id)}
                  onClick={() => handleStartPlay(ep)}
                  title={isCurrent ? `当前播放：第 ${ep.episodeNumber} 集 · ${ep.title}` : `第 ${ep.episodeNumber} 集 · ${ep.title}${ep.isFinished ? ' (已看完)' : ''}`}
                  className={`group relative h-10 rounded-xl flex items-center justify-center font-bold text-xs shadow-xs active:scale-95 transition-all duration-150 cursor-pointer ${
                    isCurrent
                      ? 'bg-blue-600 text-white border border-blue-600 shadow-md shadow-blue-500/25 ring-2 ring-blue-400/40'
                      : ep.isFinished
                      ? 'bg-slate-50 hover:bg-blue-50/80 border border-slate-200/70 hover:border-blue-400 text-slate-500 hover:text-blue-600'
                      : 'bg-white hover:bg-blue-50/80 border border-slate-200/80 hover:border-blue-400 text-slate-700 hover:text-blue-600'
                  }`}
                >
                  {/* 当前播放集：明确显示播放图标与数字 */}
                  {isCurrent ? (
                    <span className="flex items-center gap-1">
                      <Play className="w-2.5 h-2.5 fill-current shrink-0" />
                      <span>{ep.episodeNumber}</span>
                    </span>
                  ) : (
                    <span>{ep.episodeNumber}</span>
                  )}

                  {/* 已看完：右上角清晰勾选小图标 (告别易混淆的绿点) */}
                  {ep.isFinished && !isCurrent && (
                    <span className="absolute top-1 right-1 text-slate-400" title="已看完">
                      <Check className="w-2.5 h-2.5 stroke-[2.5]" />
                    </span>
                  )}

                  {/* 观看中：底部蓝色小进度条 */}
                  {hasProgress && !ep.isFinished && !isCurrent && (
                    <span className="absolute bottom-1 inset-x-2 h-0.5 bg-blue-500 rounded-full" />
                  )}
                </button>
              );
            })}

            {/* 第 51 个快捷更多按钮 */}
            {hasMoreThan50 && (
              <button
                type="button"
                onClick={() => setShowAllEpisodesModal(true)}
                title={`查看剩余 ${totalEpisodes - 50} 集，共 ${totalEpisodes} 集`}
                className="group relative h-10 rounded-xl bg-blue-50/90 hover:bg-blue-100 border border-dashed border-blue-300 hover:border-blue-500 text-blue-600 flex items-center justify-center text-xs font-bold gap-1 shadow-xs active:scale-95 transition-all cursor-pointer"
              >
                <MoreHorizontal className="w-4 h-4 group-hover:scale-110 transition-transform" />
              </button>
            )}
          </div>
          )}
        </MicaCard>

        {/* 播放解析专线与健康度 */}
        <MicaCard className="p-5 flex flex-col gap-3">
          <h3 className="text-xs font-bold text-slate-700 flex items-center gap-1.5">
            <ShieldCheck className="w-4 h-4 text-emerald-600" />
            <span>可用播放解析通道与健康度</span>
          </h3>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            {detail.sources.length > 0 ? detail.sources.map((src) => (
              <div
                key={src.id}
                className="p-3 rounded-xl bg-white/70 border border-slate-200/70 shadow-xs flex items-center justify-between"
              >
                <div>
                  <div className="flex items-center gap-1.5">
                    <span className="text-xs font-semibold text-slate-800">
                      {src.name}
                    </span>
                    {src.isPrimary && (
                      <span className="text-[9px] font-bold px-1.5 py-0.5 rounded bg-blue-100 text-blue-700">
                        默认
                      </span>
                    )}
                  </div>
                  <span className="text-[10px] text-slate-400">
                    延迟 {src.pingMs}ms
                  </span>
                </div>
                <span className="w-2 h-2 rounded-full bg-emerald-500 shadow-sm" />
              </div>
            )) : (
              <div className="md:col-span-3 p-3 rounded-xl bg-white/70 border border-slate-200/70 text-xs text-slate-500">
                播放源由当前项目后端在打开集数时按需解析，页面不会暴露签名 URL。
              </div>
            )}
          </div>
        </MicaCard>
      </div>

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
                    className="w-full h-8 pl-8 pr-7 text-xs bg-white rounded-lg border border-slate-200/80 focus:outline-none focus:border-blue-500 shadow-xs"
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
                {filteredModalEpisodes.map((ep) => {
                  const hasProgress = (ep.watchedSeconds || 0) > 0;
                  const isCurrent = lastWatchedEp.id === ep.id;

                  return (
                    <button
                      key={ep.id}
                      type="button"
                      onMouseEnter={() => schedulePrewarm(ep.id)}
                  onFocus={() => schedulePrewarm(ep.id)}
                  onClick={() => handleStartPlay(ep)}
                      title={isCurrent ? `当前播放：第 ${ep.episodeNumber} 集 · ${ep.title}` : `第 ${ep.episodeNumber} 集 · ${ep.title}${ep.isFinished ? ' (已看完)' : ''}`}
                      className={`group relative h-10 rounded-xl flex items-center justify-center font-bold text-xs shadow-xs active:scale-95 transition-all duration-150 cursor-pointer ${
                        isCurrent
                          ? 'bg-blue-600 text-white border border-blue-600 shadow-md shadow-blue-500/25 ring-2 ring-blue-400/40'
                          : ep.isFinished
                          ? 'bg-slate-50 hover:bg-blue-50/80 border border-slate-200/70 hover:border-blue-400 text-slate-500 hover:text-blue-600'
                          : 'bg-white hover:bg-blue-50/80 border border-slate-200/80 hover:border-blue-400 text-slate-700 hover:text-blue-600'
                      }`}
                    >
                      {/* 当前播放集：明确显示播放图标与数字 */}
                      {isCurrent ? (
                        <span className="flex items-center gap-1">
                          <Play className="w-2.5 h-2.5 fill-current shrink-0" />
                          <span>{ep.episodeNumber}</span>
                        </span>
                      ) : (
                        <span>{ep.episodeNumber}</span>
                      )}

                      {/* 已看完：右上角清晰勾选小图标 */}
                      {ep.isFinished && !isCurrent && (
                        <span className="absolute top-1 right-1 text-slate-400" title="已看完">
                          <Check className="w-2.5 h-2.5 stroke-[2.5]" />
                        </span>
                      )}

                      {/* 观看中：底部蓝色小进度条 */}
                      {hasProgress && !ep.isFinished && !isCurrent && (
                        <span className="absolute bottom-1 inset-x-2 h-0.5 bg-blue-500 rounded-full" />
                      )}
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
