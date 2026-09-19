import React, { useEffect, useRef, useState } from 'react';

/**
 * 封面图的统一渲染入口（全应用唯一）。
 *
 * ## 为什么必须收口到一处
 *
 * 封面来自外部源站，**脏数据与坏网络都是常态**：实测 dmghg 的部分条目 `pic` 指向的是
 * 百度图片代理，甚至 `spore-mall.cdn.bcebos.com`（实测 404）这类与源站无关的地址；
 * 而正常封面走的是 `pN-ad.adukwai.com` 小站 CDN（**明文 http**）。之前每个视图各写一份
 * `<img src={cover}>`，兜底只在三个列表里各写了一遍，详情页 Hero、卡片展开动画、
 * 收藏与历史的小图都是裸 `img`，失败就留一个白框。
 *
 * ## 为什么不用原生 `loading="lazy"`
 *
 * 两处实测结论把原生懒加载否掉了：
 *   1. **卡片宿主视图是常驻 DOM + hidden**（App.tsx 切视图只改 display）。元素在
 *      `display: none` 的祖先里创建时，原生懒加载**不会加载**，而切到可见之后它对
 *      "这张图该不该加载"的重新评估并不可靠——这正是"卡片空白、鼠标扫过才出来"的同源问题；
 *   2. **CDN 连接挂起时图片会永远停在 pending**（`img.complete === false`），
 *      **`onError` 根本不会触发**，所有基于 error 的兜底全部失效，界面上就是那块封面
 *      无限期不出现。原生懒加载把"何时开始"交给浏览器之后，我们连它有没有开始都无从判断。
 *
 * 所以这里**自己管**：用 IntersectionObserver 决定何时开始（提前一屏预载），
 * 状态只认自己的 `onLoad` / `onError`，并对失败做有限次重试。
 *
 * ## 呈现规则（用户看到的）
 *
 * - 剧名首字占位**始终铺在最底层**：地址为空、还在加载、重试中、彻底失败，都不会留白框；
 * - 图片在 `onLoad` 之前是透明的，**加载完成才淡入**——所以中途看到的是占位而不是半截空白；
 * - 加载慢/挂起时占位一直顶着，图片元素留在原地继续尝试，**一旦成功会自动浮现**，
 *   不会出现"等太久被前端判死、其实后来又加载好了"的浪费。
 */
export interface CoverImageProps {
  /** 封面地址；空/纯空白时直接显示占位，不发任何请求。 */
  src?: string | null;
  /** 标题，取首字作为占位。 */
  title: string;
  /** 标题为空时的兜底字（短剧"剧"、动漫"漫"）。 */
  fallbackChar?: string;
  /** 给 `<img>` 的类：动效（`group-hover:scale-*` 等）由调用方决定。 */
  className?: string;
  /** 占位层配色。 */
  placeholderClassName?: string;
  /** 占位首字字号：大卡片 `text-3xl`，列表小图 `text-sm`。 */
  placeholderTextClassName?: string;
  /** 语义仍是"要不要立即加载"：`eager` 跳过视口判断直接开始。 */
  loading?: 'eager' | 'lazy';
  fetchPriority?: 'high' | 'auto' | 'low';
}

/** 重试上限（含首次）：CDN 抖动两次还不行，就没必要继续折腾用户。 */
const MAX_ATTEMPTS = 3;

/**
 * 重试地址。
 *
 * **不能无条件拼 `?r=N` 做 cache-bust**：百度图床那类地址把参数写成路径的一部分
 * （`/gimg/app=2001&n=0&fmt=webp&src=xxx.jpg`，整个 URL 里没有 `?`），盲加会把
 * `src` 参数污染成 `xxx.jpg?r=1`，图必然取不到——本来只是想绕过失败缓存，结果把
 * 一次抖动变成了永久失败。只有 URL 确实带 `?` 时才追加。
 */
function attemptUrl(raw: string, attempt: number): string {
  if (attempt === 0) return raw;
  return raw.includes('?') ? `${raw}&ttv_r=${attempt}` : raw;
}

export const CoverImage: React.FC<CoverImageProps> = ({
  src,
  title,
  fallbackChar = '影',
  className = '',
  placeholderClassName = 'bg-gradient-to-br from-slate-100 to-slate-200',
  placeholderTextClassName = 'text-3xl',
  loading = 'lazy',
  fetchPriority = 'auto',
}) => {
  const url = (src || '').trim();
  const char = (title || '').trim().slice(0, 1) || fallbackChar;

  const [started, setStarted] = useState(loading === 'eager');
  const [loaded, setLoaded] = useState(false);
  const [attempt, setAttempt] = useState(0);
  /** 重试次数用尽：不再渲染 `img`，只留占位。 */
  const [givenUp, setGivenUp] = useState(false);
  const holderRef = useRef<HTMLDivElement | null>(null);
  /** 上一个地址：用来区分“首次挂载”与“地址真的变了”。 */
  const prevUrlRef = useRef(url);
  const imgRef = useRef<HTMLImageElement | null>(null);

  /**
   * **只在地址真的变了**时整体重来（换剧 / 节点被复用）。
   *
   * 不能在挂载时无条件重置：图片命中缓存时 `load` 事件会赶在 passive effect 之前触发
   * （React 的顺序是 提交 DOM → layout effect → passive effect），于是 `onLoad` 刚把
   * `loaded` 置为 true，紧接着这次重置又把它改回 false —— 结果是**图片明明已经加载成功、
   * 却永久保持透明**，用户看到的还是占位。
   * 实测证据：滚动过去之后仍有 8 张卡停留在 `opacity: 0`，而它们的 `img.complete` 已是 `true`。
   */
  useEffect(() => {
    if (prevUrlRef.current === url) return;
    prevUrlRef.current = url;
    setLoaded(false);
    setAttempt(0);
    setGivenUp(false);
  }, [url]);

  /** 进入视口（提前一屏）才开始加载。 */
  useEffect(() => {
    if (!url || started || typeof IntersectionObserver === 'undefined') {
      if (url && !started && typeof IntersectionObserver === 'undefined') setStarted(true);
      return;
    }
    const holder = holderRef.current;
    if (!holder) return;
    const observer = new IntersectionObserver(
      entries => {
        if (entries.some(entry => entry.isIntersecting)) {
          setStarted(true);
          observer.disconnect();
        }
      },
      // 提前一屏预载：滚动时不会先看到一片占位再"跳"出图。
      { rootMargin: '800px 0px' },
    );
    observer.observe(holder);
    return () => observer.disconnect();
  }, [url, started]);

  // `loading` 由 lazy 变为 eager（列表重排等）时补上开始信号，避免还傻等视口。
  useEffect(() => {
    if (loading === 'eager' && !started) setStarted(true);
  }, [loading, started]);

  /**
   * 兜底核对：`onLoad` / `onError` **都可能收不到**。
   *
   * 图片命中缓存（同一张图在前面已加载过）时，`load` 事件可能在 React 挂上监听之前
   * 就已经发生过了——事件不会重放，`onLoad` 于是永远不触发，图片明明已经 `complete`、
   * `naturalWidth > 0`，界面上却一直是占位。实测就是这个：滚过去之后仍有 8 张卡停在
   * `opacity: 0`，而它们的 `img.complete` 早已是 `true` 且能正常解码。
   * 这里在每次渲染提交后主动核对一次元素状态，把漏掉的事件补回来。
   */
  useEffect(() => {
    const img = imgRef.current;
    if (!img || loaded || givenUp || !img.complete) return;
    if (img.naturalWidth > 0) setLoaded(true);
    // 已完成但没解出像素 = 这次尝试失败了（同样可能漏事件）；重试交给 handleError 的同一套逻辑。
    else if (attempt + 1 < MAX_ATTEMPTS) setAttempt(prev => prev + 1);
    else setGivenUp(true);
  }, [attempt, started, url, loaded, givenUp]);

  const handleError = () => {
    if (attempt + 1 < MAX_ATTEMPTS) setAttempt(prev => prev + 1);
    else setGivenUp(true);
  };

  return (
    <>
      {/* 占位层：始终渲染在最底层，图片没成它就是最终画面 */}
      <div
        ref={holderRef}
        className={`absolute inset-0 flex items-center justify-center ${placeholderClassName}`}
      >
        <span className={`${placeholderTextClassName} font-bold text-slate-300 select-none`}>{char}</span>
      </div>
      {/* 加载完成前保持透明：中途看到的是占位，而不是一块半截空白。
          `key={attempt}` 让每次重试都用新元素，避免复用上一次的失败状态。 */}
      {url && started && !givenUp ? (
        <img
          ref={imgRef}
          key={attempt}
          src={attemptUrl(url, attempt)}
          alt={title}
          className={`relative w-full h-full object-cover transition-opacity duration-300 ${
            loaded ? 'opacity-100' : 'opacity-0'
          } ${className}`}
          // 时机由上面的 IntersectionObserver 决定，这里显式声明避免浏览器再插一手。
          loading="eager"
          decoding="async"
          fetchPriority={fetchPriority}
          onLoad={() => setLoaded(true)}
          onError={handleError}
        />
      ) : null}
    </>
  );
};

export default CoverImage;
