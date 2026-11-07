import React, { useCallback, useEffect, useState } from 'react';
import { Loader2, UserRound, X } from 'lucide-react';
import { ipcService, type HongguoPerson, type HongguoWork } from '../../services/ipc';
import { SeriesCard } from './SeriesCard';

/** 弹窗内的作品网格：与选季弹窗同一套列数与间距，观感一致。 */
const WORK_GRID_CLASS =
  'grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-3 sm:gap-4';

interface PersonDialogProps {
  userId: string;
  /** 点某部作品：进详情。 */
  onOpenSeries: (seriesId: string) => void;
  onClose: () => void;
}

/**
 * 演员 / 角色主页。
 *
 * 数据来自红果的 `person` + `person_works` 两个接口：主页给头衔、粉丝数、
 * 简介，作品列表是游标分页的一页页短剧。这两样在网页源里都没有，
 * 所以它是纯 App 侧的新入口，不复用 `SeriesDetail` 那套。
 *
 * 失败分两种：主页拉不到就整块报错（没有名字的空壳毫无意义）；
 * 作品拉不到只说一句「暂时取不到作品」，主页信息照常显示——用户来这里是看人的。
 */
export const PersonDialog: React.FC<PersonDialogProps> = ({
  userId,
  onOpenSeries,
  onClose,
}) => {
  const [person, setPerson] = useState<HongguoPerson | null>(null);
  const [works, setWorks] = useState<HongguoWork[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [worksError, setWorksError] = useState<string | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [isLoadingMore, setIsLoadingMore] = useState(false);

  useEffect(() => {
    let alive = true;
    setIsLoading(true);
    setError(null);
    setWorksError(null);
    setPerson(null);
    setWorks([]);
    setCursor(null);
    setHasMore(false);

    void ipcService.hongguo
      .person(userId)
      .then(data => {
        if (alive) setPerson(data);
      })
      .catch((err: unknown) => {
        if (alive) setError((err as Error).message || '演员信息加载失败');
      })
      .finally(() => {
        if (alive) setIsLoading(false);
      });

    void ipcService.hongguo
      .personWorks({ userId })
      .then(page => {
        if (!alive) return;
        setWorks(page.items);
        setCursor(page.cursor);
        setHasMore(page.hasMore);
      })
      .catch((err: unknown) => {
        if (alive) setWorksError((err as Error).message || '作品列表加载失败');
      });

    return () => {
      alive = false;
    };
  }, [userId]);

  const loadMore = useCallback(async () => {
    if (!cursor || isLoadingMore) return;
    setIsLoadingMore(true);
    try {
      const page = await ipcService.hongguo.personWorks({ userId, cursor });
      // 合并而不是覆盖：作品可能跨页重复（服务端按游标去重，但不保证）。
      setWorks(prev => {
        const seen = new Set(prev.map(w => w.series.id));
        return [...prev, ...page.items.filter(w => !seen.has(w.series.id))];
      });
      setCursor(page.cursor);
      setHasMore(page.hasMore);
    } catch {
      // 翻页失败不动已有作品。
    } finally {
      setIsLoadingMore(false);
    }
  }, [cursor, isLoadingMore, userId]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-6 bg-black/40 backdrop-blur-sm animate-fade-in select-none"
      onClick={onClose}
    >
      <div
        className="w-full max-w-4xl max-h-[80vh] rounded-3xl bg-white/95 backdrop-blur-2xl border border-white shadow-fluent-hud flex flex-col overflow-hidden animate-fluent-scale-in"
        onClick={e => e.stopPropagation()}
      >
        {/* 头部 */}
        <div className="flex items-start gap-3 border-b border-slate-100 px-6 py-4">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-amber-200/60 bg-amber-50 text-amber-600">
            <UserRound className="h-4 w-4" />
          </div>
          <div className="min-w-0 flex-1">
            <h3 className="truncate text-sm font-bold text-slate-900">
              {person?.name || (isLoading ? '加载中…' : '演员主页')}
            </h3>
            {person && (person.tags.length > 0 || person.labels.length > 0) && (
              <p className="mt-0.5 truncate text-[11px] text-slate-400">
                {[...person.tags, ...person.labels].join(' · ')}
              </p>
            )}
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
          {error && (
            <div className="rounded-2xl border border-rose-200/70 bg-rose-50/80 p-4 text-xs text-rose-700">
              {error}
            </div>
          )}

          {isLoading && !person && !error && (
            <div className="flex items-center justify-center py-16 text-slate-400">
              <Loader2 className="h-5 w-5 animate-spin" />
            </div>
          )}

          {person && (
            <div className="mb-5 flex items-start gap-4">
              <div className="h-20 w-20 shrink-0 overflow-hidden rounded-2xl border border-white bg-slate-100 shadow-xs">
                {person.avatarUrl ? (
                  <img
                    src={person.avatarUrl}
                    alt={person.name}
                    className="h-full w-full object-cover"
                    draggable={false}
                  />
                ) : (
                  <div className="flex h-full w-full items-center justify-center text-slate-300">
                    <UserRound className="h-7 w-7" />
                  </div>
                )}
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-3 text-[11px] text-slate-500">
                  {person.followers > 0 && <span>{person.followers} 粉丝</span>}
                  {person.likes > 0 && <span>{person.likes} 获赞</span>}
                </div>
                {person.description && (
                  <p className="mt-2 line-clamp-4 text-xs leading-relaxed text-slate-600">
                    {person.description}
                  </p>
                )}
              </div>
            </div>
          )}

          <div className="mb-3 flex items-center justify-between">
            <h4 className="text-xs font-bold text-slate-700">参演作品</h4>
            <span className="text-[11px] text-slate-400">{works.length} 部</span>
          </div>

          {worksError && (
            <p className="rounded-xl border border-amber-200/70 bg-amber-50/70 p-3 text-[11px] text-amber-700">
              暂时取不到作品：{worksError}
            </p>
          )}

          {works.length > 0 && (
            <div className={WORK_GRID_CLASS}>
              {works.map((work, index) => (
                <SeriesCard
                  key={`${work.series.id}-${index}`}
                  series={work.series}
                  index={index}
                  onClick={onOpenSeries}
                />
              ))}
            </div>
          )}

          {works.length === 0 && !worksError && !isLoading && (
            <p className="py-8 text-center text-xs text-slate-400">还没有收录这位演员的作品</p>
          )}

          {hasMore && (
            <div className="mt-4 flex justify-center">
              <button
                type="button"
                disabled={isLoadingMore}
                onClick={() => void loadMore()}
                className="inline-flex cursor-pointer items-center gap-1.5 rounded-xl border border-slate-200/80 bg-white px-4 py-2 text-xs font-semibold text-slate-600 transition-colors hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {isLoadingMore && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                {isLoadingMore ? '加载中…' : '加载更多作品'}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
