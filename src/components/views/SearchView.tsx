import React, { useEffect, useRef, useState } from 'react';
import { useAppStore } from '../../stores/useAppStore';
import { ipcService } from '../../services/ipc';
import { SeriesItem } from '../../types/catalog';
import { Search, X, Trash2, Clock, Play, ArrowLeft } from 'lucide-react';

type Channel = 'drama' | 'comic';

/**
 * 独立搜索页。
 *
 * 存在的理由：搜索此前只是"在发现页就地过滤列表"——用户点搜索框后既没有
 * 页面跳转，也没有任何历史记录，看上去就像搜索没生效。这里把搜索做成一个
 * 真正的视图：空关键词时展示历史，有关键词时展示结果网格。
 */
export const SearchView: React.FC = () => {
  const {
    currentView,
    searchKeyword,
    setSearchKeyword,
    searchHistory,
    rememberSearch,
    removeSearchHistory,
    clearSearchHistory,
    navigateTo,
  } = useAppStore();

  const [channel, setChannel] = useState<Channel>('drama');
  const [items, setItems] = useState<SeriesItem[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  // 请求编号：关键词变化很快时，旧请求不允许覆盖新结果。
  const requestIdRef = useRef(0);

  // 从标题栏跳进来时把焦点交给页内输入框，用户可以直接继续打字。
  useEffect(() => {
    if (currentView !== 'search') return;
    const timer = setTimeout(() => inputRef.current?.focus(), 60);
    return () => clearTimeout(timer);
  }, [currentView]);

  useEffect(() => {
    const keyword = searchKeyword.trim();
    if (!keyword) {
      setItems([]);
      setError(null);
      setIsLoading(false);
      return;
    }
    const requestId = ++requestIdRef.current;
    setIsLoading(true);
    setError(null);
    ipcService.catalog
      .list({
        channel,
        category: '全部',
        audience: '全部',
        sort: 'recommend',
        keyword,
        page: 1,
        pageSize: 40,
      })
      .then(page => {
        if (requestId !== requestIdRef.current) return;
        setItems(page.items);
      })
      .catch((err: unknown) => {
        if (requestId !== requestIdRef.current) return;
        setError((err as Error).message || '搜索失败，请稍后重试。');
        setItems([]);
      })
      .finally(() => {
        if (requestId === requestIdRef.current) setIsLoading(false);
      });
  }, [searchKeyword, channel]);

  const runSearch = (keyword: string) => {
    const trimmed = keyword.trim();
    setSearchKeyword(trimmed);
    rememberSearch(trimmed);
    inputRef.current?.focus();
  };

  const hasKeyword = searchKeyword.trim().length > 0;

  return (
    <div className="w-full h-full overflow-y-auto select-none p-6 sm:p-8">
      <div className="max-w-5xl mx-auto flex flex-col gap-5 pb-24">
        {/* 搜索输入区 */}
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => navigateTo('explore')}
            className="w-9 h-9 rounded-xl bg-white hover:bg-slate-50 text-slate-600 border border-slate-200/80 shadow-xs flex items-center justify-center transition-all active:scale-95 cursor-pointer flex-shrink-0"
            title="返回发现"
          >
            <ArrowLeft className="w-4 h-4" />
          </button>

          <div className="relative flex-1 p-0.5 bg-slate-100/90 rounded-xl border border-slate-200/70 shadow-inner flex items-center">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400 pointer-events-none" />
            <input
              ref={inputRef}
              type="text"
              value={searchKeyword}
              onChange={event => setSearchKeyword(event.target.value)}
              onKeyDown={event => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  runSearch(searchKeyword);
                } else if (event.key === 'Escape') {
                  setSearchKeyword('');
                }
              }}
              placeholder="搜索短剧、漫剧，支持剧名关键词与分季名称"
              className="w-full h-9 pl-9 pr-8 text-sm bg-white text-slate-800 placeholder-slate-400 rounded-lg border-none focus:outline-none shadow-xs transition-all"
            />
            {hasKeyword && (
              <button
                type="button"
                onClick={() => setSearchKeyword('')}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 p-0.5 cursor-pointer"
                title="清空"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
        </div>

        {/* 空态：搜索历史 */}
        {!hasKeyword && (
          <div className="rounded-2xl bg-white/88 backdrop-blur-xl border border-white/80 shadow-fluent p-5">
            <div className="flex items-center justify-between pb-3 border-b border-black/[0.05]">
              <div className="flex items-center gap-2 text-sm font-bold text-slate-800">
                <Clock className="w-4 h-4 text-blue-600" />
                <span>搜索历史</span>
              </div>
              {searchHistory.length > 0 && (
                <button
                  type="button"
                  onClick={clearSearchHistory}
                  className="flex items-center gap-1 text-[11px] font-semibold text-slate-400 hover:text-rose-600 transition-colors cursor-pointer"
                >
                  <Trash2 className="w-3 h-3" />
                  清空历史
                </button>
              )}
            </div>

            {searchHistory.length === 0 ? (
              <p className="pt-4 text-xs text-slate-400">
                还没有搜索记录。输入剧名后回车即可搜索，历史会保存在本地。
              </p>
            ) : (
              <div className="pt-4 flex flex-wrap gap-2">
                {searchHistory.map(keyword => (
                  <span
                    key={keyword}
                    className="group inline-flex items-center gap-1.5 pl-3 pr-1.5 py-1.5 rounded-xl bg-slate-100/90 hover:bg-blue-50 border border-slate-200/70 hover:border-blue-200 text-xs font-medium text-slate-700 hover:text-blue-700 transition-all"
                  >
                    <button
                      type="button"
                      onClick={() => runSearch(keyword)}
                      className="cursor-pointer max-w-[220px] truncate"
                      title={keyword}
                    >
                      {keyword}
                    </button>
                    <button
                      type="button"
                      onClick={() => removeSearchHistory(keyword)}
                      className="w-4 h-4 rounded-md text-slate-300 hover:text-rose-600 hover:bg-white/80 flex items-center justify-center transition-colors cursor-pointer"
                      title="移除这条记录"
                    >
                      <X className="w-3 h-3" />
                    </button>
                  </span>
                ))}
              </div>
            )}
          </div>
        )}

        {/* 有关键词：结果区 */}
        {hasKeyword && (
          <>
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                {(['drama', 'comic'] as Channel[]).map(item => (
                  <button
                    key={item}
                    type="button"
                    onClick={() => setChannel(item)}
                    className={`px-3.5 py-1.5 rounded-xl text-xs font-bold border transition-all cursor-pointer ${
                      channel === item
                        ? 'bg-blue-600 text-white border-blue-600 shadow-sm'
                        : 'bg-white/90 text-slate-600 border-slate-200/80 hover:border-slate-300'
                    }`}
                  >
                    {item === 'drama' ? '短剧' : '漫剧'}
                  </button>
                ))}
              </div>
              <span className="text-xs text-slate-500">
                {isLoading ? '搜索中…' : `找到 ${items.length} 部`}
              </span>
            </div>

            {error && (
              <div className="rounded-2xl bg-rose-50/80 border border-rose-200/70 p-4 text-xs text-rose-700">
                {error}
              </div>
            )}

            {!error && !isLoading && items.length === 0 && (
              <div className="rounded-2xl bg-white/88 border border-white/80 shadow-fluent p-8 text-center">
                <p className="text-sm font-semibold text-slate-700">没有找到匹配的剧集</p>
                <p className="mt-1.5 text-xs text-slate-400">
                  试试更短的关键词，或换到另一个频道。分季剧集可以只搜主标题（如「聚宝仙盆」）。
                </p>
              </div>
            )}

            {items.length > 0 && (
              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-4">
                {items.map((series, index) => (
                  <div
                    key={`${series.id}-${index}`}
                    onClick={() => {
                      rememberSearch(searchKeyword.trim());
                      navigateTo('detail', series.id);
                    }}
                    className="group flex flex-col cursor-pointer animate-fluent-card-in active:scale-95 transition-transform rounded-2xl"
                    style={{ animationDelay: `${Math.min(index * 20, 240)}ms` }}
                  >
                    <div className="relative w-full aspect-[3/4] overflow-hidden bg-slate-100 rounded-t-2xl">
                      {/* 无封面时露出剧名首字：App 联想结果里有些条目不带封面。 */}
                      <div className="absolute inset-0 flex items-center justify-center bg-gradient-to-br from-slate-100 to-slate-200">
                        <span className="text-3xl font-bold text-slate-300 select-none">
                          {(series.title || '剧').trim().slice(0, 1)}
                        </span>
                      </div>
                      <img
                        src={series.cover}
                        alt={series.title}
                        className="relative w-full h-full object-cover group-hover:scale-105 transition-transform duration-500"
                        loading={index < 8 ? 'eager' : 'lazy'}
                        decoding="async"
                        onError={event => {
                          event.currentTarget.style.opacity = '0';
                        }}
                      />
                      <div className="absolute inset-0 bg-gradient-to-t from-black/65 via-transparent to-transparent opacity-80 group-hover:opacity-95 transition-opacity duration-300" />
                      <div className="absolute top-2 left-2 flex gap-1">
                        <span className="px-2 py-0.5 rounded-md text-[10px] font-bold bg-blue-600/95 text-white shadow-xs">
                          {series.tags[0] || '热门'}
                        </span>
                      </div>
                      <div className="absolute bottom-2 inset-x-2 flex items-center justify-between text-[11px] text-white/95">
                        {series.episodesCount > 0 ? (
                          <span className="font-semibold">{series.episodesCount} 集全</span>
                        ) : (
                          <span className="font-semibold text-white/60">集数未知</span>
                        )}
                        <span className="text-[10px] text-white/75 truncate max-w-[80px]">{series.origin}</span>
                      </div>
                      <div className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-all duration-200 bg-black/20">
                        <div className="w-11 h-11 rounded-full bg-white/95 text-blue-600 flex items-center justify-center shadow-lg transform scale-75 group-hover:scale-100 transition-all duration-200">
                          <Play className="w-5 h-5 fill-current ml-0.5" />
                        </div>
                      </div>
                    </div>
                    <div className="px-1 pt-2.5 pb-3 bg-transparent">
                      <h4 className="text-xs font-bold text-slate-800 truncate" title={series.title}>
                        {series.title}
                      </h4>
                      <p className="mt-1 text-[10px] text-slate-400 truncate">
                        {series.tags.slice(0, 2).join(' · ') || '精品短剧'}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
};
