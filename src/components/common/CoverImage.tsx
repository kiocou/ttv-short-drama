import React, { useEffect, useRef, useState } from 'react';
import { tracePlayback } from '../../services/playbackTrace';

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
 * - 封面没到（等视口 / 解析中 / 下载中 / 重试中）铺的是**扫光骨架块**，与列表骨架
 *   `.shimmer-loading` 同一材质 —— 卡片因此从上到下都是"骨架形状"，不会出现封面那块
 *   是灰底首字、周围网格骨架是扫光片的割裂；
 * - 只有**确定拿不到封面**（地址为空、重试耗尽、guo 解析失败、20s 挂起兜底）才退回
 *   剧名首字占位 —— 那时还挂扫光就是在撒谎"还在加载"；
 * - 图片在 `onLoad` 之前是透明的，**加载完成才淡入**——所以中途看到的是占位而不是半截空白；
 * - 加载慢/挂起时占位一直顶着，图片元素留在原地继续尝试，**一旦成功会自动浮现**，
 *   不会出现"等太久被前端判死、其实后来又加载好了"的浪费。
 *
 * ## guo 外部源的封面（`resolveSrc`）
 *
 * guo 源的封面地址不能直接喂给 `<img>`（黄果视频有 Cloudflare 防护、部分源封面
 * 是加过密的），必须经 guo-core 带源侧 Referer 下载后取本地缓存文件。提供
 * `resolveSrc` 时：视口到达 → 调它拿本地路径 → `convertFileSrc` 后加载；
 * 拿不到（含明确的"该剧没有封面"）直接判不可得。失败/耗尽重试的卡片由宿主
 * 通过 `onUnavailable` 感知并决定是否移除。
 */
export interface CoverImageProps {
  /** 封面地址；空/纯空白时直接显示占位，不发任何请求。提供 `resolveSrc` 时忽略。 */
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
  /**
   * 异步解析真实封面地址。提供后忽略 `src`。
   *
   * 返回值有两种形态，两种都要支持：
   * - **本地文件路径**（guo 封面：guo-core 带源侧 Referer 下载后落盘的文件），
   *   由这里经 `convertFileSrc` 转成 `asset:` 地址；
   * - **已经可直接使用的地址**（`data:` / `blob:` / `http(s):`）—— 红果封面走
   *   这条（后端把 HEIC 转成 JPEG 后以 data URL 返回，见
   *   `short_drama_app_cover_proxy`）。识别靠 `RESOLVED_URL_PATTERN`，否则会把
   *   data URL 当成路径拼出垃圾地址。
   */
  resolveSrc?: () => Promise<string | null>;
  /** 封面确定不可得（解析失败 / 重试耗尽）时回调一次，宿主可据此移除卡片。 */
  onUnavailable?: () => void;
}

/** 重试上限（含首次）：CDN 抖动两次还不行，就没必要继续折腾用户。 */
const MAX_ATTEMPTS = 3;

/**
 * `resolveSrc` 失败后的重试退避（毫秒）。
 *
 * 数组长度 = 总尝试次数。首项是**第一次失败后**等多久再试，所以 3 项 = 最多 3 次。
 *
 * 为什么需要它（而不是像 `MAX_ATTEMPTS` 那样靠 `img.onError`）：`resolveSrc` 这一路
 * 的失败发生在**拿到地址之前**（后端还没就绪 / worker 冷启动 / IPC 抖动），此时
 * 连 `<img>` 都还没渲染，`onError` 根本没有机会触发。旧实现把这一类一次性判死，
 * 首屏十几张卡于是一起停在剧名首字上、永不恢复（用户报告「封面全丢」）。
 *
 * 退避取 800ms / 2.4s：worker 冷启动实测 0.6–1.9s，第一档覆盖不了还有第二档；
 * 再长就没有意义了（用户已经在往下滚，卡也不再视口内）。
 */
const RESOLVE_RETRY_DELAYS_MS = [800, 2400, 4000];

/**
 * `resolveSrc` 返回值已经是**可直接使用的地址**的判定。
 *
 * 只有落在这里面之外的才当作本地文件路径去走 `convertFileSrc`。
 */
const RESOLVED_URL_PATTERN = /^(data|blob|https?|asset|ipc):/i;

/**
 * **全局共享**一个 IntersectionObserver，而不是每张封面各建一个。
 *
 * 一页 30 张卡、无限流之后上百张 —— 每张卡各建一个观察器意味着上百个 IO 实例、上百次
 * 独立的 root/阈值协商与回调分发，而它们要的判定完全一样（"进入视口前 800px 了吗"）。
 * 观察器持有元素引用，元素卸载时还要逐个 disconnect，全是浪费。
 *
 * 这里用一个模块级单例 + 回调表：观察器只创建一次（且是惰性的——没人用封面就不创建），
 * 每个元素注册自己的回调，进入视口后立刻自 deregister。
 *
 * 注意 `root` 用 `null`（视口）而不是滚动容器：封面分布在发现/动漫/搜索/历史/收藏多个
 * 各自滚动的容器里，而它们的 `rootMargin` 一致，用视口做根对这些容器是等价的（容器占满
 * 内容区），且这样才能真正只建一个。`document` 根下卡片在隐藏视图里时不会相交，
 * 切回来时再触发——正是想要的懒加载语义。
 */
const COVER_ROOT_MARGIN = '800px 0px';

/**
 * 封面诊断的去重集合（仅排查期使用）。
 *
 * 一屏几十张卡、每次渲染都会重跑组件体，不加去重会把日志刷满。用
 * 「标题 + 地址前缀」做键：同一张卡的重复渲染被压掉，不同卡各自留一条。
 */
const coverDiagLogged = new Set<string>();

let coverObserver: IntersectionObserver | null = null;
const coverCallbacks = new WeakMap<Element, () => void>();

function observeCover(element: Element, onEnter: () => void): () => void {
  if (typeof IntersectionObserver === 'undefined') {
    onEnter();
    return () => {};
  }
  if (!coverObserver) {
    coverObserver = new IntersectionObserver(
      entries => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const callback = coverCallbacks.get(entry.target);
          if (!callback) continue;
          // 先摘掉再回调：命中即完成，这个元素不该再看第二次。
          coverObserver?.unobserve(entry.target);
          coverCallbacks.delete(entry.target);
          callback();
        }
      },
      { rootMargin: COVER_ROOT_MARGIN },
    );
  }
  coverCallbacks.set(element, onEnter);
  coverObserver.observe(element);
  return () => {
    coverCallbacks.delete(element);
    coverObserver?.unobserve(element);
  };
}

/**
 * `convertFileSrc` 的模块级缓存。
 *
 * 每张 guo 卡都会走到这里。动态 import 虽然被 Vite 缓存了模块，但每次调用仍是一次
 * Promise 调度 + 一次模块查找；一页几十张卡就是几十次。把 Promise 本身缓存下来，
 * 全应用只解析一次。
 *
 * 刻意保持动态引入：Web/演示模式没有 Tauri 运行时，静态 import 会直接炸构建产物。
 */
let convertFileSrcPromise: Promise<(path: string) => string> | null = null;

function loadConvertFileSrc(): Promise<(path: string) => string> {
  if (!convertFileSrcPromise) {
    convertFileSrcPromise = import('@tauri-apps/api/core')
      .then(module => module.convertFileSrc)
      .catch(() => {
        // 失败不该被永久缓存，否则后续所有卡片都拿不到。
        convertFileSrcPromise = null;
        throw new Error('convertFileSrc 不可用');
      });
  }
  return convertFileSrcPromise;
}

/**
 * 重试地址。
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
  resolveSrc,
  onUnavailable,
}) => {
  const directUrl = (src || '').trim();
  const char = (title || '').trim().slice(0, 1) || fallbackChar;

  const [started, setStarted] = useState(loading === 'eager');
  const [loaded, setLoaded] = useState(false);
  const [attempt, setAttempt] = useState(0);
  /** 重试次数用尽（或 guo 封面解析失败）：不再渲染 `img`，只留占位。 */
  const [givenUp, setGivenUp] = useState(false);
  /**
   * `resolveSrc` 这条通道已经放弃（重试用尽 / 宿主说没有）。
   *
   * 与 `givenUp` 分开是必须的：`resolveSrc` 失败**不等于**这张卡没有封面 ——
   * 原地址可能本身就是可直连的 jpg（首页货架就是这种情况：同一个地址在详情页
   * 直连能出图）。只有"解析失败 **且** 直连也失败"才该落到 `givenUp`。
   */
  const [resolveFailed, setResolveFailed] = useState(false);
  /** guo 封面解析结果：null = 尚未解析，其余 = 可用地址（失败走 givenUp）。 */
  const [resolvedUrl, setResolvedUrl] = useState<string | null>(null);
  /** 已用掉几次 `resolveSrc` 尝试（见 `RESOLVE_RETRY_DELAYS_MS`）。 */
  const resolveAttemptRef = useRef(0);
  /** 解析请求在途：防止同一张卡并发打两次 IPC。 */
  const resolveInFlightRef = useRef(false);
  /** 退避计时器的触发信号：ref 不能做 effect 依赖，用一个计数器把它带进去。 */
  const [resolveTick, setResolveTick] = useState(0);
  /**
   * 解析函数的最新引用。
   *
   * **不能让它出现在 effect 依赖里**（2026-10-21 修「三处封面全丢」）：
   * `SeriesCard` 传的是 `coverResolver(series.id, series.cover)` —— 一个**内联箭头
   * 函数**，父组件每次重渲染都是全新 identity。而 effect 的 cleanup 会把
   * `cancelled` 置 true，于是每一轮重渲染都发生这件事：
   *
   *   1. effect 发车，`resolveInFlightRef = true`；
   *   2. 父组件因任意原因重渲染（滚动、收藏态、时间戳）→ 新箭头函数 identity；
   *   3. cleanup 跑：`cancelled = true`、`resolveInFlightRef = false`；
   *   4. 新 effect 跑：`resolveInFlightRef` 已是 false，重新发车；
   *   5. 上一轮的 IPC 此时返回，撞上 `if (cancelled) return` → **结果被丢弃**。
   *
   * 也就是"每次都发车、每次都丢掉结果"，`setResolvedUrl` 永远执行不到。表现正是
   * 用户看到的那三处（动漫 / 新剧 / 正在热播）全部只剩剧名首字。
   *
   * 讽刺的是原注释早就写明"请求在尝试时捕获 `resolveSrc` 引用而不是跟着它的
   * identity 重启"，只是依赖数组里仍然写着 `resolveSrc`，代码没照注释做。
   */
  const resolveSrcRef = useRef<typeof resolveSrc>(resolveSrc);
  resolveSrcRef.current = resolveSrc;
  const holderRef = useRef<HTMLDivElement | null>(null);
  /** 上一个地址：用来区分“首次挂载”与“地址真的变了”。 */
  const prevUrlRef = useRef('');
  const imgRef = useRef<HTMLImageElement | null>(null);
  // 用 ref 存回调：宿主传入的箭头函数每次渲染都是新 identity，作为 effect deps
  // 会反复触发；值本身只在"要通知"时用一次。
  const onUnavailableRef = useRef(onUnavailable);
  onUnavailableRef.current = onUnavailable;
  const reportedUnavailableRef = useRef(false);

  /**
   * 实际喂给 `<img>` 的地址。
   *
   * ## 为什么 `resolveSrc` 解析不出结果时要**回退到原地址**（2026-10-21 修「首页封面全丢」）
   *
   * 旧写法是 `resolveSrc ? (resolvedUrl ?? '') : directUrl` —— 只要宿主给了解析器，
   * 原地址就被**彻底丢弃**。这个取舍原本成立（当时解析器只服务两类"直连必然失败"
   * 的封面：guo 源的加密封面、红果的 HEIC），但它把"解析失败"与"没有封面"画上了
   * 等号：
   *
   *   - 详情页 Hero 没传 `resolveSrc`，走 `directUrl` 直连，封面正常；
   *   - 首页货架传了 `resolveSrc`（红果 HEIC），一旦代理这一路拿不到（后端未就绪、
   *     worker 冷启动、域名不在白名单），`url` 就是空串 —— `<img>` 根本不渲染，
   *     卡片永远停在剧名首字上，**而那个原地址其实是能用的**（同一个地址在详情页
   *     直连就有图）。
   *
   * 现在改成三段式：解析成功用解析结果 → 解析彻底失败则回退原地址直连 → 两者都
   * 没有才认输。heic 原地址在 WebView2 里确实解不出来，但那时 `<img>` 会 `onError`
   * 走既有的重试与 `givenUp` 流程，结论与现在一致；而**非 heic 的原地址（官网抓来
   * 的 jpg/webp）因此重新变得可用**——这正是详情页一直能显示、首页显示不出来的差别。
   */
  const url = resolveSrc
    ? (resolvedUrl ?? (resolveFailed ? directUrl : ''))
    : directUrl;
  const hasSource = Boolean(directUrl || resolveSrc);

  /**
   * 诊断打点：封面全丢时，需要区分四种完全不同的原因 ——
   * ① 宿主没给解析器（`resolveSrc` 为 undefined，地址不像 heic）；
   * ② 给了但没触发（`started` 卡在 false，视口观察器没命中）；
   * ③ 触发了但拿不到（代理失败，`shelf.cover` 会另打一条）；
   * ④ 拿到了但 `<img>` 解不出像素（heic 直连的典型表现）。
   *
   * 四者在 UI 上都是"首字占位"，光看界面永远分不出来。
   *
   * ⚠️ 走 `tracePlayback`（落进 ttv-playback.log）而不是 `console`：开发版窗口的
   * DevTools 焦点在自动化环境里拿不稳，而"前端到底收到了什么封面地址"这个证据
   * 不能靠猜。日志是唯一稳定的落点。
   *
   * 用 `挂载计数` 限流：一屏几十张卡，每张只打首次，靠模块级 Set 去重。
   */
  useEffect(() => {
    if (givenUp || loaded) return;
    const key = `${title}|${directUrl.slice(0, 40)}`;
    if (coverDiagLogged.has(key)) return;
    coverDiagLogged.add(key);
    tracePlayback(
      `封面挂载 标题=${(title || '').slice(0, 12)} 有解析器=${resolveSrc ? 1 : 0}` +
      ` 有直连=${directUrl ? 1 : 0} 地址长=${directUrl.length}` +
      ` 像heic=${/\.heic(\?|$)/i.test(directUrl) ? 1 : 0} started=${started ? 1 : 0}`,
    );
  });

  /**
   * **只在源地址真的变了**时整体重来（换剧 / 节点被复用）。
   *
   * ⚠️ 锚定的是 `directUrl` 而不是 `url`：`url` 在「解析成功 / 回退直连」之间会变
   * （空串 ↔ 真实地址），拿它当判据会让"解析失败后回退"这一步被当成"换了新图"，
   * 于是解析重试预算被清零 → 又发起一轮解析 → 再次失败 → 再回退……无限循环。
   * 真正标识"这张卡要显示哪张图"的是源地址本身。
   *
   * 不能在挂载时无条件重置：图片命中缓存时 `load` 事件会赶在 passive effect 之前触发
   * （React 的顺序是 提交 DOM → layout effect → passive effect），于是 `onLoad` 刚把
   * `loaded` 置为 true，紧接着这次重置又把它改回 false —— 结果是**图片明明已经加载成功、
   * 却永久保持透明**，用户看到的还是占位。
   * 实测证据：滚动过去之后仍有 8 张卡停留在 `opacity: 0`，而它们的 `img.complete` 已是 `true`。
   */
  useEffect(() => {
    const sourceKey = directUrl || title;
    if (prevUrlRef.current === sourceKey) return;
    prevUrlRef.current = sourceKey;
    setLoaded(false);
    setAttempt(0);
    setGivenUp(false);
    setResolveFailed(false);
    /**
     * **换剧必须清掉上一张的解析结果**（2026-10-21）。
     *
     * 列表用的是复用式渲染：格子被复用成另一部剧时，本组件实例不销毁，只是换
     * props。`resolvedUrl` 属于**上一张图的产物**，留着就等于把 A 的海报画在 B 的
     * 卡上——比没有封面更糟，因为它看起来是"对的"。
     *
     * 解析 effect 的第一句是 `resolvedUrl !== null` 就 return，所以不清它的话，
     * 新剧连一次解析都不会发车，永远显示上一部剧的封面。
     */
    setResolvedUrl(null);
    // 换地址（换剧 / 格子被复用）要把**解析重试预算**一起重置：那份额度属于
    // 上一张图，带过来会让新封面少试几次，甚至一次都不试。
    resolveAttemptRef.current = 0;
  }, [directUrl, title]);

  /** 进入视口（提前一屏）才开始加载；guo 源的解析也等这个信号，避免整页一起打 IPC。 */
  useEffect(() => {
    if (!hasSource || started) return;
    const holder = holderRef.current;
    if (!holder) return;
    // 走共享观察器（见 `observeCover` 的注释）：一页上百张卡时这是数量级差别。
    // 提前一屏预载：滚动时不会先看到一片占位再"跳"出图。
    return observeCover(holder, () => setStarted(true));
  }, [hasSource, started]);

  /**
   * 异步封面解析：视口到达后向宿主换真实地址。
   *
   * ## 为什么允许重试（2026-10-21 修「封面全丢且永不恢复」）
   *
   * 旧实现是「本次挂载内只尝试一次」（`resolveAttemptedRef` 一发判死）。对 guo 源
   * 那是对的（guo-core 已带源侧 Referer 试过一轮，失败就是真没有封面）；但对红果
   * HEIC 那一路是**错的**：`shelf.cover` 在三种完全可自愈的情形下都会返回 null ——
   * 应用刚启动后端还没就绪、随包 worker 冷启动中、单次网络抖动。旧实现把这些
   * 一次性抖动记成了"这张卡没有封面"，而且**整个挂载周期内不再重试**：首屏 12 张
   * 卡片于是一起停在剧名首字上，无论等多久都不会自己恢复（用户报告「封面全丢」）。
   *
   * 现在改成**有限次退避重试**：失败后按 `RESOLVE_RETRY_DELAYS_MS` 等一会儿再来，
   * 用尽预算才判死。判死的语义没变——真的没有封面时仍然是首字占位，只是不再是
   * "一次抖动判无期"。
   *
   * 请求在尝试时捕获 `resolveSrc` 引用而不是跟着它的 identity 重启——宿主每次
   * 渲染都会传新箭头函数，跟着重启会把在途结果当"过期"丢掉。
   */
  useEffect(() => {
    if (!resolveSrcRef.current || !started || resolvedUrl !== null) return;
    // 解析通道已放弃（重试用尽）：交给 `directUrl` 直连，这里不再发车。
    if (resolveFailed || givenUp) return;
    if (resolveAttemptRef.current >= RESOLVE_RETRY_DELAYS_MS.length) return;
    if (resolveInFlightRef.current) return;

    const attemptIndex = resolveAttemptRef.current;
    // 取 ref 里的最新实现，但**不把它写进依赖**（理由见 `resolveSrcRef` 的注释）。
    const request = resolveSrcRef.current;
    resolveInFlightRef.current = true;
    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;

    void (async () => {
      try {
        const resolved = await request();
        if (cancelled) return;
        if (!resolved) {
          // 宿主明确说"这次拿不到"：排一次退避重试，用尽预算才判死。
          if (attemptIndex + 1 < RESOLVE_RETRY_DELAYS_MS.length) {
            resolveAttemptRef.current = attemptIndex + 1;
            resolveInFlightRef.current = false;
            retryTimer = setTimeout(() => {
              // 用一次 state 抖动把 effect 重新跑起来（依赖里没有可变 ref）。
              setResolveTick(tick => tick + 1);
            }, RESOLVE_RETRY_DELAYS_MS[attemptIndex]);
            return;
          }
          resolveInFlightRef.current = false;
          setResolveFailed(true);
          return;
        }
        resolveInFlightRef.current = false;
        if (RESOLVED_URL_PATTERN.test(resolved)) {
          setResolvedUrl(resolved);
          return;
        }
        const convertFileSrc = await loadConvertFileSrc();
        if (!cancelled) setResolvedUrl(convertFileSrc(resolved));
      } catch {
        if (cancelled) return;
        resolveInFlightRef.current = false;
        if (attemptIndex + 1 < RESOLVE_RETRY_DELAYS_MS.length) {
          resolveAttemptRef.current = attemptIndex + 1;
          retryTimer = setTimeout(() => setResolveTick(tick => tick + 1), RESOLVE_RETRY_DELAYS_MS[attemptIndex]);
          return;
        }
        setGivenUp(true);
      }
    })();

    return () => {
      cancelled = true;
      resolveInFlightRef.current = false;
      if (retryTimer) clearTimeout(retryTimer);
    };
    // `resolveTick` 只用于把"该重试了"这个信号带进 effect；它本身不参与任何计算。
    // ⚠️ **不要**把 `resolveSrc` 加回依赖：它是内联箭头函数，每次父组件重渲染都会
    // 换 identity，cleanup 会因此把在途请求的结果丢掉（详见 `resolveSrcRef`）。
  }, [started, resolvedUrl, givenUp, resolveFailed, resolveTick]);

  /** 封面确定不可得时通知宿主一次（宿主据此移除卡片）。 */
  useEffect(() => {
    if (!givenUp || reportedUnavailableRef.current) return;
    reportedUnavailableRef.current = true;
    onUnavailableRef.current?.();
  }, [givenUp]);

  /**
   * 挂起兜底：CDN 连接一直 pending 时 `onError` 永远不会触发（见文件头注释），
   * 没有终点的话卡片就是永久字占位——在"首页卡片必须都有封面"的约束下，
   * 挂起与失败等价。20 秒是保守值：正常封面（含冷门小站 CDN）都在数秒内出图，
   * 撑到 20 秒还没像素的，放进后续列表也比留着秃卡好。
   */
  useEffect(() => {
    if (!started || loaded || givenUp || !url) return;
    const timer = setTimeout(() => setGivenUp(true), 20_000);
    return () => clearTimeout(timer);
  }, [started, loaded, givenUp, url]);

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

  /**
   * 还没像素、也没有认输 —— 此刻占位层该铺骨架。
   * 空地址（`hasSource` 为假）不算：没有请求在跑，铺扫光就是撒谎。
   */
  const pending = hasSource && !loaded && !givenUp;

  return (
    <>
      {/* 占位层：始终渲染在最底层，图片没成它就是最终画面。
          两种材质二选一 —— 还在等/还在下：扫光骨架块；确定拿不到：剧名首字。 */}
      <div
        ref={holderRef}
        className={`absolute inset-0 flex items-center justify-center ${placeholderClassName}`}
      >
        {pending ? (
          <span aria-hidden="true" className="block h-full w-full shimmer-loading" />
        ) : (
          <span className={`${placeholderTextClassName} font-bold text-slate-300 select-none`}>{char}</span>
        )}
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
          // 不带 Referer：图床普遍按 Referer 做防盗链，而 WebView2 里 `<img>` 的 Referer
          // 是应用自身地址（`http://127.0.0.1:5175` / `tauri://localhost`），最容易被判定
          // 为盗链而 403。实测暴风图床三种 Referer 都放行，但 dmghg 那批脏图床（百度图片
          // 代理、第三方 bcebos）不一定；不发 Referer 一律按直接访问处理，判定最宽松。
          referrerPolicy="no-referrer"
          fetchPriority={fetchPriority}
          onLoad={() => setLoaded(true)}
          onError={handleError}
        />
      ) : null}
    </>
  );
};

export default CoverImage;
