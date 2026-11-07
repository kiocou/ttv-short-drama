import React, { useCallback, useEffect, useState } from 'react';
import { Loader2, SlidersHorizontal, X } from 'lucide-react';
import {
  ipcService,
  type HongguoFilterPage,
  type HongguoFilterRow,
} from '../../services/ipc';
import { SeriesCard } from './SeriesCard';

const RESULT_GRID_CLASS =
  'grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3 sm:gap-4';

interface ShortFilterDialogProps {
  /** 'drama' 时用真人剧档（short_play），'comic' 用漫剧档。 */
  channel: 'drama' | 'comic';
  onOpenSeries: (seriesId: string) => void;
  onClose: () => void;
}

/**
 * 短剧筛选（App 原生 `short_filter_panel` + `short_filter`）。
 *
 * ## 为什么做成弹窗而不是塞进发现页的题材栏
 *
 * 题材栏（`CategoryBar`）走的是网页源的题材路由，选中就整页换目录、还要参与
 * 发现页的缓存与分页。筛选面板是**独立的 App 接口**：它自己带一套行与选项
 * （题材 / 角色 / 年代 / 性别 / 完结状态 / 排序），提交后由服务端按游标翻页。
 * 硬并进题材栏会让两套分页状态互相污染。
 *
 * 所以：题材栏保持原样，筛选单独一个入口。用户点「筛选」，挑条件，看结果，
 * 点卡片直接进详情——不必离开当前页面，也没有改动发现页的任何既有行为。
 *
 * ## 游标与筛选必须成套
 *
 * 续页时把上一页返回的 `selections` 原样带回：游标里记着它是哪一组查询，
 * 换了条件就得从头开始（这里在条件变化时主动清游标）。
 */
export const ShortFilterDialog: React.FC<ShortFilterDialogProps> = ({
  channel,
  onOpenSeries,
  onClose,
}) => {
  /** 面板行。空数组 = 还没加载 / 该档位没有面板。 */
  const [rows, setRows] = useState<HongguoFilterRow[]>([]);
  const [isLoadingRows, setIsLoadingRows] = useState(true);
  const [rowsError, setRowsError] = useState<string | null>(null);

  /** 已选条件：行 key → 选中的值。 */
  const [selections, setSelections] = useState<Record<string, string[]>>({});

  const [result, setResult] = useState<HongguoFilterPage | null>(null);
  const [isSearching, setIsSearching] = useState(false);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [resultError, setResultError] = useState<string | null>(null);

  const genre = channel === 'comic' ? 'comic_series' : 'short_play';

  useEffect(() => {
    let alive = true;
    setIsLoadingRows(true);
    setRowsError(null);
    void ipcService.hongguo
      .shortFilterPanel(genre)
      .then(data => {
        if (alive) setRows(data);
      })
      .catch((err: unknown) => {
        if (alive) setRowsError((err as Error).message || '筛选条件加载失败');
      })
      .finally(() => {
        if (alive) setIsLoadingRows(false);
      });
    return () => {
      alive = false;
    };
  }, [genre]);

  const toggle = (rowKey: string, value: string) => {
    setSelections(prev => {
      const current = prev[rowKey] ?? [];
      const next = current.includes(value)
        ? current.filter(v => v !== value)
        : [...current, value];
      const copy = { ...prev };
      if (next.length === 0) delete copy[rowKey];
      else copy[rowKey] = next;
      return copy;
    });
    // 条件变了，旧结果与游标都作废——不然续页会接着上一组查询翻。
    setResult(null);
    setResultError(null);
  };

  const runSearch = useCallback(async () => {
    setIsSearching(true);
    setResultError(null);
    try {
      const page = await ipcService.hongguo.shortFilter({
        selections,
        channel,
      });
      setResult(page);
    } catch (err) {
      setResultError((err as Error).message || '筛选失败，请重试');
      setResult(null);
    } finally {
      setIsSearching(false);
    }
  }, [channel, selections]);

  const loadMore = useCallback(async () => {
    if (!result?.cursor || isLoadingMore) return;
    setIsLoadingMore(true);
    try {
      const page = await ipcService.hongguo.shortFilter({
        // 续页必须用上一页**实际生效**的筛选，而不是当前界面上的（用户可能又点了两下）。
        selections: result.selections,
        cursor: result.cursor,
        channel,
      });
      setResult(prev =>
        prev
          ? {
              ...page,
              items: [
                ...prev.items,
                ...page.items.filter(item => !prev.items.some(p => p.id === item.id)),
              ],
            }
          : page,
      );
    } catch (err) {
      setResultError((err as Error).message || '加载更多失败');
    } finally {
      setIsLoadingMore(false);
    }
  }, [channel, isLoadingMore, result]);

  const activeCount = Object.values(selections).reduce((sum, v) => sum + v.length, 0);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-6 bg-black/40 backdrop-blur-sm animate-fade-in select-none"
      onClick={onClose}
    >
      <div
        className="w-full max-w-4xl max-h-[82vh] rounded-3xl bg-white/95 backdrop-blur-2xl border border-white shadow-fluent-hud flex flex-col overflow-hidden animate-fluent-scale-in"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-start gap-3 border-b border-slate-100 px-6 py-4">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-sky-200/60 bg-sky-50 text-sky-600">
            <SlidersHorizontal className="h-4 w-4" />
          </div>
          <div className="min-w-0 flex-1">
            <h3 className="text-sm font-bold text-slate-900">
              筛选{channel === 'comic' ? '漫剧' : '短剧'}
            </h3>
            <p className="mt-0.5 text-[11px] text-slate-400">
              红果 App 筛选面板
              {activeCount > 0 ? ` · 已选 ${activeCount} 项` : ''}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="shrink-0 cursor-pointer rounded-lg p-1.5 text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-700"
            aria-label="关闭"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-5">
          {isLoadingRows && (
            <div className="flex items-center justify-center py-10 text-slate-400">
              <Loader2 className="h-5 w-5 animate-spin" />
            </div>
          )}

          {rowsError && (
            <div className="rounded-2xl border border-rose-200/70 bg-rose-50/80 p-4 text-xs text-rose-700">
              {rowsError}
            </div>
          )}

          {rows.map(row => (
            <div key={row.key} className="mb-4">
              <p className="mb-2 text-[11px] font-bold text-slate-500">{row.name}</p>
              <div className="flex flex-wrap gap-2">
                {row.options.map(option => {
                  const active = (selections[row.key] ?? []).includes(option.value);
                  return (
                    <button
                      key={`${row.key}-${option.value}`}
                      type="button"
                      onClick={() => toggle(row.key, option.value)}
                      className={`px-3 py-1.5 rounded-full text-[11px] border transition-colors cursor-pointer ${
                        active
                          ? 'bg-sky-50 text-sky-700 border-sky-200'
                          : 'bg-white text-slate-500 border-slate-200/80 hover:bg-slate-50'
                      }`}
                    >
                      {option.name}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}

          {resultError && (
            <p className="mt-3 rounded-xl border border-rose-200/70 bg-rose-50/70 p-3 text-[11px] text-rose-700">
              {resultError}
            </p>
          )}

          {result && result.items.length === 0 && (
            <p className="py-8 text-center text-xs text-slate-400">
              这组条件没有匹配的短剧，去掉一两项再试试
            </p>
          )}

          {result && result.items.length > 0 && (
            <>
              <div className="mb-3 mt-2 flex items-center justify-between">
                <h4 className="text-xs font-bold text-slate-700">筛选结果</h4>
                <span className="text-[11px] text-slate-400">{result.items.length} 部</span>
              </div>
              <div className={RESULT_GRID_CLASS}>
                {result.items.map((series, index) => (
                  <SeriesCard
                    key={`${series.id}-${index}`}
                    series={series}
                    index={index}
                    onClick={onOpenSeries}
                  />
                ))}
              </div>
              {result.hasMore && (
                <div className="mt-4 flex justify-center">
                  <button
                    type="button"
                    disabled={isLoadingMore}
                    onClick={() => void loadMore()}
                    className="inline-flex cursor-pointer items-center gap-1.5 rounded-xl border border-slate-200/80 bg-white px-4 py-2 text-xs font-semibold text-slate-600 transition-colors hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {isLoadingMore && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                    {isLoadingMore ? '加载中…' : '加载更多'}
                  </button>
                </div>
              )}
            </>
          )}
        </div>

        {/* 底部动作条：常驻，结果滚动不影响「查看结果」的可达性。 */}
        <div className="flex items-center justify-between gap-3 border-t border-slate-100 px-6 py-3">
          <button
            type="button"
            onClick={() => {
              setSelections({});
              setResult(null);
              setResultError(null);
            }}
            className="cursor-pointer rounded-lg px-2 py-1.5 text-[11px] text-slate-400 transition-colors hover:text-slate-600"
          >
            清空条件
          </button>
          <button
            type="button"
            disabled={isSearching}
            onClick={() => void runSearch()}
            className="inline-flex cursor-pointer items-center gap-1.5 rounded-xl bg-slate-900 px-4 py-2 text-xs font-bold text-white transition-colors hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {isSearching && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            {isSearching ? '筛选中…' : '查看结果'}
          </button>
        </div>
      </div>
    </div>
  );
};
