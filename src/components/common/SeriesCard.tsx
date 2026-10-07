import React from 'react';
import { Bookmark, Play, Star } from 'lucide-react';
import { coverResolver } from '../../services/ipc';
import { SeriesItem } from '../../types/catalog';
import { FAVORITE_MARK_LABEL, type FavoriteMark } from '../../types/favorite';
import { useFavoriteMark } from '../../stores/useFavoritesStore';
import { CoverImage } from './CoverImage';
import { MicaCard } from './MicaCard';

/**
 * 海报网格卡片：发现 / 动漫 / 搜索三处共用同一份实现。
 *
 * 这三处此前各抄了一份，而且长得并不一样——搜索页那版没有 MicaCard 的玻璃底，
 * 信息区是 `px-1 pt-2.5 pb-3 bg-transparent`（标题不随断点放大、悬停不变色），
 * 悬停播放盘是白底蓝图标而不是 `fluent-convex-disc`，2xl 少一列，还漏了 guo
 * 封面的异步解析（搜到的 guo 剧封面永远只能显示首字占位）。逐页对齐样式不如
 * 只留这一份。
 *
 * 频道差异全部由 `series.type` 推出，不加变体 props——数据本身已经带了频道。
 *
 * 追剧角标同理：三页共用一份实现，所以角标也三页同时生效。收藏是跨页状态
 * （`useFavoritesStore.markBySeriesId`），发现页看到的"在看"和收藏页看到的是
 * 同一条记录，不会出现两处打架。
 */

/** 追剧角标配色：与右上角评分角标同一族（黑底 + 彩色文字），避免和左上角的源标签撞色。 */
const MARK_CHIP_CLASS: Record<FavoriteMark, string> = {
  want: 'bg-black/65 text-sky-300',
  watching: 'bg-black/65 text-emerald-300',
  done: 'bg-black/65 text-slate-300',
};

/** 网格列宽。2xl 六列是三处一致后的结果，搜索页曾少一列。 */
export const SERIES_GRID_CLASS =
  'grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6 gap-4 sm:gap-4.5';

/**
 * 榜单序号（金/银/铜三档 + 中性黑）在 2026-10 被整体移除。
 *
 * 移除理由：用户要求去掉卡片上的「1、2、3」序号，把两栏的入口统一改成「更多」。
 * 序号原本只服务"这一栏是榜单"的叙事，而两栏的数据其实是同一份目录的相邻切片
 * （真正的分区数据源见 `红果短剧客户端逆向分析报告.md` §七），序号反而在暗示
 * 一个并不存在的排名。留着金/银/铜只会让"新剧"那一栏看起来像热度榜。
 */

interface SeriesCardProps {
  series: SeriesItem;
  index: number;
  /**
   * 货架栏目的强调色，与栏目标题左侧那道色条同色。只有首页两颗货架会传，
   * 用于在卡片顶部压一条 3px 色条，把"编辑精选"和下面的完整目录区分开
   * （用户报告："和目录卡没区别，缺精选感"）。不传则完全不渲染。
   */
  accent?: 'rose' | 'blue';

  /**
   * 点击回调。**签名收 seriesId 而不是无参**：卡片自己知道自己的 id，这样宿主只需传
   * **一个** `useCallback` 给全部卡片，而不是每张卡新建一个闭包。
   *
   * 这是 `React.memo` 能否生效的前提：内联箭头函数每次渲染都是新引用，props 永远
   * 不相等，memo 等于没写。首页上百张卡时这个差别就是"滑动掉帧"与"顺滑"的差别。
   */
  onClick: (seriesId: string) => void;
  /** 鼠标悬停时预取详情，不预取媒体，避免影响滚动和带宽。 */
  onPrefetch?: (seriesId: string) => void;
/**
   * 封面确定不可得时把整张卡移出列表。发现页要，搜索/动漫保留首字占位。
   * 同样收 seriesId，理由同 `onClick`。
   */
  onUnavailable?: (seriesId: string) => void;
}

export const SeriesCard: React.FC<SeriesCardProps> = React.memo(({ series, index, accent, onClick, onUnavailable, onPrefetch }) => {
  const isAnime = series.type === 'anime';
  /** 徽章占了 tags[0]，副标题只展示剩下的标签；没有就干脆空着。 */
  const tagLine = series.tags.slice(1, 3).join(' · ');
  /**
   * 追剧状态。**没有收藏记录就完全不渲染角标**——显示"未收藏"是纯噪音，
   * 而且大多数卡片本来就是未收藏状态。
   *
   * 用 `useFavoriteMark` 逐条订阅而不是 `useFavorites().markBySeriesId`：后者订阅
   * 整张表，改任意一部剧的收藏都会重渲染这一张卡；首页上百张卡时这是纯粹的浪费。
   */
  const mark = useFavoriteMark(series.id);

  return (
    <MicaCard
      hoverable
      onClick={() => onClick(series.id)}
      onMouseEnter={() => onPrefetch?.(series.id)}
      onFocus={() => onPrefetch?.(series.id)}
      tabIndex={0}
      className="group flex flex-col cursor-pointer animate-fluent-card-in active:scale-95 transition-transform rounded-2xl"
    >
      {/* 海报封面 (3:4 黄金竖屏比例) */}
      <div className="relative w-full aspect-[3/4] overflow-hidden bg-slate-100 rounded-t-2xl">
        {/* 封面缺失时露出剧名首字，而不是留一个空框。guo 源的封面直连不可用
            （Cloudflare/加密），交给 resolveSrc 从 guo-core 换本地缓存；两种
            封面都确定拿不到时，onUnavailable 让宿主把卡片从列表移除。 */}
        {/* 悬停放大用 `scale-[1.08]` 而不是 `scale-108`：后者不在 Tailwind 的
            scale 刻度里（0/50/75/90/95/100/105/110/125/150），**这个类根本没被
            生成过** —— 拿 dev server 的编译产物核对过，`.group-hover\:scale-108`
            零命中，也就是说封面悬停其实一直不放大。只有任意值写法才会真的生成。 */}
        <CoverImage
          src={series.cover}
          title={series.title}
          fallbackChar={isAnime ? '漫' : '剧'}
          placeholderClassName={isAnime ? 'bg-gradient-to-br from-violet-50 to-slate-200' : undefined}
          className="transition-transform duration-500 ease-[cubic-bezier(0.16,1,0.3,1)] group-hover:scale-[1.08]"
          loading={index < 8 ? 'eager' : 'lazy'}
          fetchPriority={index < 4 ? 'high' : 'auto'}
          // guo 封面走 guo-core、红果的 HEIC 走后端转码 —— 见 `coverResolver`。
          // 少了这一条，首页货架（红果榜单/最新上架）的封面会全是空白：
          // 那些地址是 `image/heic`，WebView2 解不了。
          resolveSrc={coverResolver(series.id, series.cover)}
          onUnavailable={onUnavailable ? () => onUnavailable(series.id) : undefined}
        />
        <div className="absolute inset-0 bg-gradient-to-t from-black/65 via-transparent to-transparent opacity-80 group-hover:opacity-95 transition-opacity duration-300" />

        {/* 货架精选标识：3px 顶部色条，与栏目标题左侧那道色条同色。只在货架卡
            上渲染（传了 accent）——目录网格/搜索/动漫不传，那些位置不需要跟
            栏目呼应，多压一条线只是噪音。 */}
        {accent && (
          <span
            aria-hidden="true"
            className={`absolute inset-x-0 top-0 z-10 h-[3px] ${
              accent === 'rose' ? 'bg-rose-500/90' : 'bg-blue-500/90'
            }`}
          />
        )}

        {/* 顶部左侧：题材 chip。
            取不到标签就整块不渲染。这里此前兜底成「动漫」或「热门」，是在替源
            数据编造源没说过的断言（"热门"更是在伪造热度），与不变量 8 同一类；
            频道类型已由徽章配色、封面占位字、标题悬停色三处传达。

            `max-w-[7.5rem]` + `truncate`：窄卡（货架在 xl 是 6 列）上长题材名
            会一直顶到右上角的评分/追剧竖列上去。写死上限比让它自然换行 / 溢出
            更可控。 */}
        {series.tags[0] && (
          <div className="absolute inset-x-2 top-2 z-10 flex items-center gap-1.5">
            <span
              className={`truncate rounded-md px-2 py-0.5 text-[10px] font-bold text-white shadow-xs max-w-[7.5rem] ${
                isAnime ? 'bg-violet-600/95' : 'bg-blue-600/95'
              }`}
            >
              {series.tags[0]}
            </span>
          </div>
        )}

        {/* 右上角徽章列：评分在上、追剧角标在下。
            评分原本独占 `top-2 right-2`，追剧角标接在它下面而不是塞进左上角
            那组 `flex gap-1`——那样会把 tags[0] 往右挤，两张标签并排时在
            2xl 窄卡上会互相压边。竖排则两条边各自互不干扰。 */}
        {(series.rating || mark) && (
          <div className="absolute top-2 right-2 flex flex-col items-end gap-1">
            {series.rating && (
              <span className="flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[10px] font-bold bg-black/65 text-amber-300">
                <Star className="w-2.5 h-2.5 fill-current" />
                <span>{series.rating.toFixed(1)}</span>
              </span>
            )}
            {mark && (
              <span
                className={`flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[10px] font-bold ${MARK_CHIP_CLASS[mark]}`}
              >
                <Bookmark className="w-2.5 h-2.5 fill-current" />
                {FAVORITE_MARK_LABEL[mark]}
              </span>
            )}
          </div>
        )}

        {/* 悬停快捷播放图标 (实体凸出的立体浮雕圆盘) */}
        <div className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-all duration-200 bg-black/20">
          <div className="w-11 h-11 rounded-full fluent-convex-disc text-white flex items-center justify-center shadow-lg transform scale-75 group-hover:scale-100 transition-all duration-200 ease-[cubic-bezier(0.34,1.56,0.64,1)]">
            <Play className="w-5 h-5 fill-current ml-0.5" />
          </div>
        </div>

        {/* 底部集数与来源：动漫的集数备注多是「已完结」这类无数字文本，所以优先
            集名、其次原文；短剧/漫剧只有集数。 */}
        <div className="absolute bottom-2 inset-x-2 flex items-center justify-between text-[11px] text-white/95">
          {isAnime ? (
            series.episodesCount > 0 ? (
              <span className="font-semibold">{series.latestEpisodeTitle || `${series.episodesCount} 集`}</span>
            ) : series.brief ? (
              <span className="font-semibold text-white/80">{series.brief}</span>
            ) : (
              <span className="font-semibold text-white/60">集数未知</span>
            )
          ) : series.episodesCount > 1 ? (
            // 阈值 >1 而非 >0：花果/无果的目录模板把未填集数的剧填成 1（2026-09-30
            // 实测：花果 36 部里 19 部 episodes="1"、无果 30 部里 29 部，而《暗潮涌动》
            // 目录写 1、详情实测 60 章）——"1 集全"十有八九是假的，显示出来就是误导。
            // 真只有 1 集的短剧几乎不存在，且此时"集数未知"也是实话；其余源
            // （毛果/盒果/饭果/芽果）的目录集数实测可信，>=2 照常显示。
            <span className="font-semibold">{series.episodesCount} 集全</span>
          ) : (
            <span className="font-semibold text-white/60">集数未知</span>
          )}
          <span className="text-[10px] text-white/75 truncate max-w-[80px]">{series.origin}</span>
        </div>
      </div>

      {/* 卡片下半部元信息。标签行取不到就不渲染：此前兜底成「动漫」「精品短剧」
          「精选漫剧」，同样是替源数据编造断言（「精品」是在断言入选与质量状态），
          而且只有一个标签的卡片（很常见）会整片显示这行假货。 */}
      <div className="p-3 flex flex-col gap-1">
        <h3
          className={`text-xs sm:text-sm font-bold text-slate-800 truncate transition-colors duration-150 ${
            isAnime ? 'group-hover:text-violet-600' : 'group-hover:text-blue-600'
          }`}
        >
          {series.title}
        </h3>
        {tagLine && (
          <div className="flex items-center gap-1.5 text-[11px] text-slate-400 truncate">
            <span>{tagLine}</span>
          </div>
        )}
        {series.heat && series.heat > 0 && (
          <div className="text-[10px] font-medium text-slate-400">
            {series.heat >= 10_000 ? `${Math.round(series.heat / 10_000)}万热度` : `${series.heat.toLocaleString()} 热度`}
          </div>
        )}
      </div>
    </MicaCard>
  );
});

/**
 * `React.memo` 只挡**父组件**引发的重渲染，而这正是我们要的效果：
 *
 * - 父组件（列表视图）因无关状态变化而重渲染时，props 逐个相同 → 整张卡片跳过；
 * - 收藏状态变化走 `useFavoriteMark` 的内部订阅，属于该组件**自身**的状态更新，本来
 *   就会绕过 memo 精确重渲染这一张卡 —— 不需要（也不能）在比较函数里管它。
 *
 * 所以默认浅比较即可。前提是宿主传**稳定**的 `onClick` / `onUnavailable`：每次渲染都
 * 新建的箭头函数会让 props 永远不相等，memo 形同虚设。宿主侧要用 `useCallback` +
 * ref 的写法，见 ExploreView / SearchView / AnimeView。
 *
 * `index` 参与比较是有意的：它决定封面是 eager 还是 lazy、`fetchPriority` 是 high 还是
 * auto，翻页导致位置变化时必须重渲染（否则新追加的卡片会沿用错误的加载策略）。
 */
