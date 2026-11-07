import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ipcService, type HongguoRankBoard, type HongguoRankContent, type HongguoRankItem } from '../../services/ipc';
import type { ChannelType } from '../../types/catalog';
import { RankingRail } from './RankingRail';

/**
 * 首页「热度排行榜」的数据壳。
 *
 * 把取数、切榜、失败处理都收在这里，`RankingRail` 只负责画。这样做的直接原因
 * 与 `HomeShelfSection` 一样：**首页那块 JSX 已经 1000 行**，再往里塞三组
 * state、一个请求 effect 和一层错误分支，读的人根本分不清哪段属于哪块版面。
 *
 * ## 为什么切换必须重新发请求，而不是在前端排序
 *
 * `hongguo_short_rank` 的 `content` / `board` 是**服务端的两级选择口径**：
 * 分类（综合 / 短剧 / 漫剧 …）与子榜（日榜 / 周榜 …，由站方定义）。名次是服务端
 * 算的，前端拿到的那十条只是"当前这一组"的前十条。在前端把同一批 items 重新
 * 排一次，得到的是一份**看起来像换榜、其实一个字都没变**的列表 —— 那正是
 * `useSpotlightFeed` 注释里记过的"点了没反应"。
 *
 * ## 游标
 *
 * 首页只要第一页（游标 `null`）。**不能拿上一页的游标去请求另一个榜**：后端会
 * 直接报「游标属于另一个榜单」（`catalog.rs::short_rank`）。所以每次切榜都是
 * 一次全新的第一页请求。
 *
 * ## 挂载约定
 *
 * 调用方必须传 `key={`rank-${channel}`}` —— 换频道要整体重挂，否则会有一帧
 * 显示上一个频道的榜单（与 `HomeShelfSection` 同一条约定）。
 */
interface RankingSectionProps {
  channel: ChannelType;
  onClick: (seriesId: string) => void;
  onMore?: () => void;
}

/** 只有短剧 / 漫剧有红果榜单口径；动漫与神秘小窝没有对应接口。 */
export function rankingSupports(channel: ChannelType): boolean {
  return channel === 'drama' || channel === 'comic';
}

export const RankingSection: React.FC<RankingSectionProps> = ({ channel, onClick, onMore }) => {
  const supported = rankingSupports(channel);
  const rankChannel: 'drama' | 'comic' = channel === 'comic' ? 'comic' : 'drama';

  /** 用户点选的榜（空串 = 让服务端给默认榜）。 */
  const [query, setQuery] = useState<{ content: string; board: string }>({ content: '', board: '' });
  const [items, setItems] = useState<HongguoRankItem[]>([]);
  const [contents, setContents] = useState<HongguoRankContent[]>([]);
  const [boards, setBoards] = useState<HongguoRankBoard[]>([]);
  /** 服务端**实际**选中的那一组（不传参时就是默认榜，见 `catalog.rs`）。 */
  const [active, setActive] = useState<{ content: string; board: string }>({ content: '', board: '' });
  const [isLoading, setIsLoading] = useState(supported);
  const [error, setError] = useState<string | null>(null);
  /** 请求代次：切榜很快时，先发的旧请求可能后到，用代次把它丢掉。 */
  const seqRef = useRef(0);
  /** 服务端目录的最新快照：乐观切分类时从这取新分类的子榜表。 */
  const contentsRef = useRef<HongguoRankContent[]>([]);
  /** 手动/自动重试代次：进 effect 依赖，+1 触发整轮重新取数。 */
  const [retryTick, setRetryTick] = useState(0);
  /** 本组查询是否已自动重试过（只补一枪，再失败交给手动重试块）。 */
  const autoRetriedRef = useRef(false);

  useEffect(() => {
    if (!supported) {
      setItems([]);
      setContents([]);
      setBoards([]);
      setIsLoading(false);
      return;
    }
    const seq = ++seqRef.current;
    setIsLoading(true);
    setError(null);
    void ipcService.hongguo
      .shortRank({
        channel: rankChannel,
        content: query.content || undefined,
        board: query.board || undefined,
      })
      .then(page => {
        if (seq !== seqRef.current) return;
        autoRetriedRef.current = false;
        setItems(page.items ?? []);
        setContents(page.contents ?? []);
        contentsRef.current = page.contents ?? [];
        setActive({ content: page.content ?? '', board: page.board ?? '' });
        // 子榜跟着**服务端选中的分类**走：用户切到"漫剧"后，托盘里显示的必须是
        // 漫剧这一类的日榜/周榜，而不是上一类的残留。
        const activeContent = (page.contents ?? []).find(
          item => item.selected || item.id === page.content,
        );
        setBoards(activeContent?.boards ?? []);
        setIsLoading(false);
      })
      .catch((err: unknown) => {
        if (seq !== seqRef.current) return;
        setIsLoading(false);
        setError(err instanceof Error ? err.message : String(err ?? '未知错误'));
        // 失败**不清空**已有的榜单：整块闪成空白比留一屏略旧的榜单更糟。
        //
        // 自动补一枪（2026-11-07「排行榜有概率消失」）：榜单接口偶发空 cell /
        // 设备风控，1.5s 后重试命中率很高；失败态的整块只剩一行灰字，用户看到
        // 的就是"排行榜消失了"。同一组查询只自动补一次，再失败亮出手动重试块。
        if (!autoRetriedRef.current) {
          autoRetriedRef.current = true;
          window.setTimeout(() => {
            if (seq === seqRef.current) setRetryTick(tick => tick + 1);
          }, 1500);
        }
      });
  }, [supported, rankChannel, query.content, query.board, retryTick]);

  const handleSelectContent = useCallback((contentId: string) => {
    // 换分类必须把子榜一起清掉：新分类的子榜 id 与旧分类的完全不通用，
    // 带着旧 board 过去后端会按另一个口径解释（甚至报错）。
    autoRetriedRef.current = false;
    setQuery({ content: contentId, board: '' });
    /*
     * 乐观回显 + 即时骨架（2026-11-07「分类卡反应慢」）：
     * 旧实现点完分类什么都不变——高亮要等响应、子榜要等响应、卡片还是上一榜的，
     * 网络一来回（0.5–2s）用户就觉得"点了没反应"。现在点击瞬间：
     *   ① 高亮立即切到点中的分类（响应到达后以服务端实际选中校正）；
     *   ② 子榜托盘直接换成该分类自己的 boards（服务端目录里每类都带各自的
     *      子榜表，本地就有，不用等）；
     *   ③ 清空旧榜单亮出骨架——留着上一榜的卡片挂在新标题下才是误导。
     */
    setItems([]);
    setActive(prev => ({ ...prev, content: contentId, board: '' }));
    setBoards(contentsRef.current.find(item => item.id === contentId)?.boards ?? []);
  }, []);

  const handleSelectBoard = useCallback((boardId: string) => {
    autoRetriedRef.current = false;
    setQuery(current => ({ ...current, board: boardId }));
    setItems([]);
    setActive(prev => ({ ...prev, board: boardId }));
  }, []);

  if (!supported) return null;

  return (
    <RankingRail
      items={items}
      contents={contents}
      boards={boards}
      activeContent={active.content}
      activeBoard={active.board}
      onSelectContent={handleSelectContent}
      onSelectBoard={handleSelectBoard}
      onClick={onClick}
      loading={isLoading}
      error={error}
      onRetry={() => setRetryTick(tick => tick + 1)}
      onMore={onMore}
    />
  );
};
