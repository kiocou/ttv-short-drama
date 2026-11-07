//! 动漫专区数据源。两条后端：
//!
//! 1. **正式源：动漫共和国（dmghg）** —— 见 `crate::dmghg_bridge`。
//!    直接驱动厂商的 `electron_bridge` DLL，列表/搜索/详情/播放地址全部现成，
//!    免登录、免 VIP。播放地址是 MP4 直链（实测 `ftypisom`，支持 Range）。
//!    剧集 id 带 `dmghg:` 前缀，与下面的暴风源区分开。
//!
//! 2. **兜底源：暴风资源（苹果CMS V10 协议，bfzyapi.com）** ——
//!    列表/搜索/详情/播放直链全部可直连，无需登录（实测 2026-09）。
//!    播放地址是 m3u8（vod_play_from=bfzym3u8），经 hls_proxy 转成本地流播放。
//!
//! 走哪条由 `use_dmghg()` 决定：默认优先正式源，DLL 不可用时自动回退暴风。
//! 环境变量 `TTV_ANIME_SOURCE=bfzy` 可强制走兜底源。

use crate::models::{
    CatalogFilter, CatalogPage, EpisodeItem, PlaybackSession, SeriesDetail, SeriesItem,
    VideoQualityOption,
};
use serde_json::Value;
use std::time::Duration;

const BFZY_API: &str = "https://bfzyapi.com/api.php/provide/vod/";

/// 暴风兜底源的剧集 id 前缀。
///
/// **必须加前缀**：暴风的 `vod_id` 与红果短剧的 `series_id` 都是纯数字，格式完全
/// 相同（`provider.rs` 的 `validate_numeric_id` 也只校验数字），光看 id 分不出来源。
/// 历史上暴风 id 裸奔时，来源判定押在前端 `channelBySeriesId` 这个内存 Map 上，
/// 而它在**应用重载后、以及从收藏/历史进入时**必然为空（那些入口只传 id、不回填
/// Map），于是暴风动漫的详情被送进红果链路去查：运气好报「详情页未找到剧集信息」，
/// 运气不好撞上红果同 id 的剧，实测表现为「标题是别人的、共 0 集全、选集全空」。
/// id 自带来源后，路由判定不再依赖任何易失状态。
pub const BFZY_ID_PREFIX: &str = "bfzy:";

/// 是否是动漫剧集 id（不分具体源）。给 `main.rs` 的命令路由用——
/// 动漫与短剧的数字 id 会撞号，只有前缀是可信的来源标记。
pub fn is_anime_id(series_id: &str) -> bool {
    series_id.starts_with(crate::dmghg_bridge::ID_PREFIX) || series_id.starts_with(BFZY_ID_PREFIX)
}

/// 剥掉暴风前缀，得到可直接请求 API 的裸数字 id。
///
/// 裸数字**原样返回**：历史/收藏里存着加前缀之前生成的旧 id，它们只可能来自暴风
/// （dmghg 的 id 一直有前缀），按暴风查是唯一正确的兼容行为。
fn strip_bfzy_prefix(series_id: &str) -> &str {
    series_id.strip_prefix(BFZY_ID_PREFIX).unwrap_or(series_id)
}

pub struct AnimeProvider {
    client: reqwest::Client,
    /// 「系统代理 / 直连」那条路失败后，用自动探测到的本地代理再走一次的客户端。
    ///
    /// 惰性构建、进程内只建一次：健康网络（系统代理开着或直连够快）上一辈子不会
    /// 初始化，只有真失败过才会去探测端口——探测要挨个连一串本地端口，不该出现在
    /// 启动路径上。
    local_proxy: tokio::sync::OnceCell<Option<reqwest::Client>>,
}

impl AnimeProvider {
    pub fn new() -> Result<Self, String> {
        // 必须挂系统代理：暴风的封面/播放域名解析到境外 IP（实测 `img.bfzypic.com`、
        // `p.bvvvvvvvvv1f.com` 都是 `193.148.95.x`），直连在部分网络下直接超时，而同一台
        // 机器上浏览器却能打开——差异只在走没走系统代理（详见 update::system_proxy）。
        let client = crate::update::with_system_proxy(reqwest::Client::builder())
            .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36")
            .connect_timeout(Duration::from_secs(8))
            // 15 秒而不是 20 秒：这条链路失败后要留出「探测本地代理 + 重试」的预算，
            // 而直连被限速时（实测约 690 B/s，64 KB 的目录页要 94 秒）等再久也是白等。
            // 系统代理正常时实测 1.4 秒就够，15 秒的余量对慢速但可用的线路同样够。
            .timeout(Duration::from_secs(15))
            .pool_idle_timeout(Duration::from_secs(600))
            .pool_max_idle_per_host(4)
            .tcp_nodelay(true)
            .build()
            .map_err(|error| error.to_string())?;
        // 数据源探测**不能在这里同步做**。
        //
        // `use_dmghg()` 会触发 `dmghg_bridge` 的 `OnceLock` 初始化，也就是
        // **同步加载外部 DLL**（实测 274–364ms，是 setup 里最重的一项）。
        // 而它的唯一作用是写一行日志告诉排查者"现在用的是哪个源"——
        // 让这件事挡住窗口创建、挡住第一帧，代价和收益完全不成比例。
        //
        // 现在改成后台线程异步探一次：窗口照常出现，日志在几百毫秒后补齐。
        // 真正需要 dmghg 的地方（`catalog` / `detail`）会自己触发初始化，
        // 那时用户已经在等动漫列表了，这笔开销本来就是必须付的。
        //
        // ⚠️ 不要改回同步：日志的时间戳会变，但"启动快 360ms"是用户能感觉到的。
        std::thread::spawn(|| {
            // 启动时探一次数据源并写进日志：否则"卡片怎么还是暴风的"没法查。
            //
            // 三行原先是 `println!`：本进程是 windows 子系统、没有控制台，等于没写。
            // 用户反馈"动漫区怎么老是暴风源"时，日志里一行证据都没有。改走 trace。
            if use_dmghg() {
                crate::trace::log("[anime] 数据源: 动漫共和国（正式源）");
            } else {
                crate::trace::log("[anime] 数据源: 暴风资源（兜底源）");
                if let Some(error) = crate::dmghg_bridge::init_error() {
                    crate::trace::log(format!("[anime] dmghg 不可用原因: {error}"));
                }
            }
        });
        Ok(Self {
            client,
            local_proxy: tokio::sync::OnceCell::new(),
        })
    }

    async fn get_json(&self, query: &str) -> Result<Value, String> {
        // ⚠️ **必须补 `?`**（2026-10-22 修「动漫专区封面全空」）。
        //
        // `BFZY_API` 末尾已经是 `/`（`…/provide/vod/`），而各个调用方传进来的
        // `query` 形如 `ac=detail&t=39&pg=1`，**不带前导 `?`**。原实现直接
        // `format!("{BFZY_API}{query}")`，拼出来是：
        //
        //     https://bfzyapi.com/api.php/provide/vod/ac=detail&t=39&pg=1
        //                                              ^ 少了 `?`
        //
        // 于是 `ac=detail` 被当成**路径的一部分**，服务端认不出这条请求，回落到
        // 默认的 `ac=list` 口径 —— 只返回 8 个字段
        // （`vod_id/vod_name/type_id/type_name/vod_en/vod_time/vod_remarks/vod_play_from`），
        // **恰好不含 `vod_pic`**，也不含 `vod_play_url`（分集）。
        //
        // 表现极具迷惑性：列表能出、标题能出、集数备注能出，只有封面全空，
        // 而且 `parse_series_item` 里根本找不到 `vod_pic` 这个键 —— 排查时
        // 极易误判成"源站没给封面"。实测同一台机器：
        //   带 `?`  → 60530 字节 / 83 字段 / 有 vod_pic
        //   缺 `?`  → 1482 字节  /  8 字段 / 无 vod_pic
        //
        // `trim_start_matches('?')` 只是防御：万一将来有人把 `?` 写进了 query，
        // 也不会拼出 `??`。
        let url = format!("{BFZY_API}?{}", query.trim_start_matches('?'));
        // 诊断：把**实际请求的 URL** 打进内存缓冲。动漫封面为空的排查里，
        // 「请求到底带了 ac=detail 还是 ac=list」是第一个必须钉死的事实 ——
        // 两者返回的字段数差一个数量级（8 vs 83），而 `ac=list` 恰好不含
        // `vod_pic`，表现与"源站没给封面"完全一样。只打一次，避免刷屏。
        static LOGGED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
        if !LOGGED.swap(true, std::sync::atomic::Ordering::Relaxed) {
            crate::trace::log(format!("[anime-url] {url}"));
        }
        // 两条链路按「哪条更可能快」排顺序，而不是一味先默认客户端：
        //
        //   - 系统代理没开时，本机在跑的代理端口（如果有）排第一。直连这条路对本源
        //     实测只有约 690 B/s，等它超时要 15 秒；探测 + 走代理是 2 秒级。
        //   - 系统代理开着时反过来：默认客户端只可能被「代理软件已退出、注册表还留着」
        //     这种状态坑到，而那种失败是**立刻**返回的（os error 10061），再退到本地端口。
        let system_proxy_configured = crate::update::system_proxy_address().is_some();
        if !system_proxy_configured {
            if let Some(local) = self.local_proxy_client().await {
                match self.fetch_json_once(local, &url).await {
                    Ok(json) => return Ok(json),
                    // 本地代理这一跳失败不覆盖主错误：用户更关心「直连为什么不行」，
                    // 探到的端口只是旁路尝试。失败原因写进日志备查。
                    Err(error) => {
                        crate::trace::log(format!("[anime] 本地代理请求失败: {error}"));
                    }
                }
            }
        }
        let primary_error = match self.fetch_json_once(&self.client, &url).await {
            Ok(json) => return Ok(json),
            Err(error) => error,
        };
        if system_proxy_configured {
            if let Some(local) = self.local_proxy_client().await {
                if let Ok(json) = self.fetch_json_once(local, &url).await {
                    crate::trace::log("[anime] 系统代理不可用，已切换到自动探测的本地代理");
                    return Ok(json);
                }
            }
        }
        Err(primary_error)
    }

    /// 自动探测到的本地代理客户端（惰性、进程内只建一次）。
    ///
    /// ## 为什么需要它（2026-11-02 现场）
    ///
    /// `new()` 挂代理的唯一依据是注册表 `ProxyEnable`，而用户机器上：
    ///   - `ProxyEnable = 0`（Clash Verge 的「系统代理」开关是关的）；
    ///   - 但 `127.0.0.1:7897` 正在监听，走它请求同一个接口 **1.36 秒**完成；
    ///   - 直连同一个接口：`64700` 字节用了 **94 秒**（约 690 B/s，被限速）。
    ///
    /// 于是任何正常超时都先到，界面报 `error sending request for url (...)`。
    ///
    /// 探测放在**失败之后**而不是启动时：健康网络永远走不到这里，也就不为一台
    /// 不需要代理的机器多付一次端口探测的时间。
    async fn local_proxy_client(&self) -> Option<&reqwest::Client> {
        self.local_proxy
            .get_or_init(|| async {
                let address = tokio::task::spawn_blocking(crate::update::detect_local_http_proxy)
                    .await
                    .ok()
                    .flatten()?;
                let proxy = reqwest::Proxy::all(format!("http://{address}")).ok()?;
                let client = reqwest::Client::builder()
                    .proxy(proxy)
                    .user_agent(
                        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36",
                    )
                    .connect_timeout(Duration::from_secs(8))
                    // 比主客户端宽松：代理可能绕远路，但只要通就比被限速的直连快。
                    .timeout(Duration::from_secs(30))
                    .pool_idle_timeout(Duration::from_secs(600))
                    .pool_max_idle_per_host(4)
                    .tcp_nodelay(true)
                    .build()
                    .map_err(|error| {
                        crate::trace::log(format!("[anime] 本地代理客户端创建失败: {error}"));
                    })
                    .ok()?;
                Some(client)
            })
            .await
            .as_ref()
    }

    /// 一次「请求 + 解压 + 解析」。`client` 由调用方给：同一条 URL 要能先后试两条链路。
    async fn fetch_json_once(&self, client: &reqwest::Client, url: &str) -> Result<Value, String> {
        let response = client
            .get(url)
            .header("Referer", "https://bfzyapi.com/")
            .send()
            .await
            .map_err(|error| {
                // reqwest 原文是 `error sending request for url (...)`：既没说是超时还是
                // 连不上，也没说是哪条链路。分三档写清楚，用户截图就能定位。
                if error.is_timeout() {
                    format!("动漫源请求超时（{url}）")
                } else if error.is_connect() {
                    format!("动漫源连接失败（{url}）: {error}")
                } else {
                    format!("动漫源请求失败（{url}）: {error}")
                }
            })?;
        if !response.status().is_success() {
            return Err(format!("动漫源响应异常: HTTP {}", response.status()));
        }
        let content_encoding = response
            .headers()
            .get("content-encoding")
            .and_then(|value| value.to_str().ok())
            .unwrap_or("-")
            .to_owned();
        let bytes = response
            .bytes()
            .await
            .map_err(|error| format!("动漫源读取失败: {error}"))?;
        // 诊断：确认响应是否被压缩、解压后是否仍是 gzip 头（`1f8b`）。
        // 若 body 以 `1f8b` 开头而 content-encoding 显示 gzip，说明 reqwest 没解压
        // —— 那会让 serde 只解析出少数顶层字段，封面随之消失。
        static LOGGED_BODY: std::sync::atomic::AtomicBool =
            std::sync::atomic::AtomicBool::new(false);
        if !LOGGED_BODY.swap(true, std::sync::atomic::Ordering::Relaxed) {
            let magic = bytes
                .iter()
                .take(2)
                .map(|byte| format!("{byte:02x}"))
                .collect::<String>();
            crate::trace::log(format!(
                "[anime-body] 编码={content_encoding} 字节={} 头={magic}",
                bytes.len()
            ));
        }
        serde_json::from_slice(&bytes).map_err(|error| format!("动漫源数据解析失败: {error}"))
    }

    pub async fn catalog(&self, filter: &CatalogFilter) -> Result<CatalogPage, String> {
        // 正式源优先：由 dmghg 桥接直接取数据（含真实分类表）。
        if use_dmghg() {
            return crate::dmghg_bridge::catalog_async(filter.clone()).await;
        }
        let page = filter.page.max(1);
        // 苹果CMS 分类 id：39 动漫片 / 40 国产动漫 / 41 日韩动漫 / 42 欧美动漫 /
        // 43 港台动漫 / 44 海外动漫 / 50 动画片
        let type_id = match filter.category.as_str() {
            "国产动漫" => 40,
            "日韩动漫" => 41,
            "欧美动漫" => 42,
            "港台动漫" => 43,
            "海外动漫" => 44,
            "动画片" => 50,
            _ => 39,
        };
        let json = if let Some(keyword) = filter
            .keyword
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            // 搜索走 wd 参数（ac=detail 返回封面与播放地址元数据）。
            self.get_json(&format!("ac=detail&wd={}&pg={page}", urlencode(keyword)))
                .await?
        } else {
            // 列表必须走 ac=detail 模式：ac=list 不返回 vod_pic（封面全空）
            // 与 vod_play_url，实测 2026-09。ac=detail 支持同样的 t/pg 筛选。
            self.get_json(&format!("ac=detail&t={type_id}&pg={page}"))
                .await?
        };

        let list = json
            .get("list")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let has_more = {
            let pagecount = json
                .get("pagecount")
                .and_then(Value::as_i64)
                .unwrap_or(page as i64) as u32;
            page < pagecount
        };
        let total = json
            .get("total")
            .and_then(Value::as_i64)
            .unwrap_or(list.len() as i64) as usize;

        let mut items = Vec::new();
        for vod in &list {
            if let Some(item) = parse_series_item(vod) {
                items.push(item);
            }
        }

        // 分类标签固定为动漫分类集合（搜索时只回"全部"）。
        let categories = if filter.keyword.is_some() {
            vec!["全部".to_string()]
        } else {
            vec![
                "全部".to_string(),
                "国产动漫".to_string(),
                "日韩动漫".to_string(),
                "欧美动漫".to_string(),
                "港台动漫".to_string(),
                "海外动漫".to_string(),
                "动画片".to_string(),
            ]
        };

        Ok(CatalogPage {
            total,
            items,
            has_more,
            page,
            categories,
            next_cursor: has_more.then(|| (page + 1).to_string()),
            source: "暴风动漫源".into(),
            // 恒为 false：这条链路只有一个来源、一次请求，`get_json` 用 `?`
            // 直接冒泡，没有"一部分拿到了、另一部分失败"的分支。`list` 缺失
            // 会被 `unwrap_or_default` 兜成空数组，但那属于"这一页就是空的"
            // （末页/无匹配），不是来源失败。多来源合并的降级由
            // `main.rs::merge_search_sources` 汇总。
            degraded: false,
        })
    }

    pub async fn detail(&self, series_id: &str) -> Result<SeriesDetail, String> {
        // 按 **id 前缀**决定数据源，不能看 `use_dmghg()`：id 是持久的来源标记，跨会话
        // 有效，而源可用性只在进程内算一次。历史/收藏里的 id 可能生成于上一次会话
        // （那时 dmghg DLL 还可用），本次 DLL 不可用时若按 use_dmghg() 改走暴风，
        // `dmghg:181655` 会被当暴风 id 去查——两套数字 id 互不相通，表现为
        // 「详情为空/张冠李戴」。前缀指向的源不可用就如实报错，比静默串源好排查。
        if series_id.starts_with(crate::dmghg_bridge::ID_PREFIX) {
            return crate::dmghg_bridge::detail_async(series_id.to_string()).await;
        }
        let id: i64 = strip_bfzy_prefix(series_id)
            .parse()
            .map_err(|_| "动漫剧集 id 非法。".to_string())?;
        let json = self.get_json(&format!("ac=detail&ids={id}")).await?;
        let vod = json
            .get("list")
            .and_then(Value::as_array)
            .and_then(|list| list.first())
            .cloned()
            .ok_or_else(|| "动漫详情未找到该剧集。".to_string())?;

        let title = str_field(&vod, &["vod_name"]).unwrap_or_else(|| "未命名动漫".into());
        // 封面过本地代理：暴风封面域名是境外 IP，直连在部分网络下超时，详见
        // `hls_proxy::proxied_image_url`。代理未启动时原样返回，行为不变。
        // 字段回退与列表一致（`vod_pic` → `vod_pic_thumb` → `vod_pic_slide`）：
        // 详情页若只认 `vod_pic`，会出现「列表有封面、点进去却空白」的来源不一致。
        // 封面保留**源站原始地址**，不在这里改写成 `127.0.0.1` 代理地址。
        //
        // 代理端口与令牌每次进程启动都会变，而目录结果会被前端缓存、也可能在
        // 代理尚未就绪时生成。把这种易失地址交给 `<img>`，重启或缓存命中后就是
        // 一条死链，表现正是动漫页整片只剩剧名首字。暴风图床实测 HTTP/HTTPS
        // 都可直连（200 image/jpeg），让 WebView 直接加载更稳。
        let cover =
            str_field(&vod, &["vod_pic", "vod_pic_thumb", "vod_pic_slide"]).unwrap_or_default();
        let tags = class_tags(&vod);
        let (episodes, episodes_count) = parse_episodes(&vod, series_id);

        Ok(SeriesDetail {
            id: series_id.to_string(),
            title,
            cover,
            item_type: "anime".into(),
            tags,
            origin: "暴风动漫源".into(),
            episodes_count,
            description: strip_html(&str_field(&vod, &["vod_content"]).unwrap_or_default()),
            episodes,
            available_qualities: vec![VideoQualityOption {
                label: "自动".into(),
                value: "auto".into(),
                resolution: "由播放源自动选择".into(),
            }],
            sources: Vec::new(),
        })
    }

    /// 探测某集的清晰度档位。
    ///
    /// 详情接口不返回档位（dmghg 的档位藏在播放解析里），所以只能在真正要播
    /// 这一集时探一次。档位数随作品/线路而变，实测 1~2 档。
    pub async fn qualities(
        &self,
        series_id: &str,
        episode_id: &str,
    ) -> Result<Vec<VideoQualityOption>, String> {
        // 与 detail 同理，按 id 前缀分流，不看 use_dmghg()。
        if series_id.starts_with(crate::dmghg_bridge::ID_PREFIX) {
            return crate::dmghg_bridge::qualities_async(
                series_id.to_string(),
                episode_id.to_string(),
            )
            .await;
        }
        // 暴风源只有一路，没有档位可选。
        Ok(Vec::new())
    }

    pub async fn open_episode(
        &self,
        session_id: u64,
        series_id: &str,
        episode_id: &str,
        position: f64,
        quality: &str,
    ) -> Result<PlaybackSession, String> {
        // 与 detail 同理，按 id 前缀分流，不看 use_dmghg()。dmghg 解析出真实地址后，
        // 按需过本地代理。
        if series_id.starts_with(crate::dmghg_bridge::ID_PREFIX) {
            let url = crate::dmghg_bridge::resolve_play_url_async(
                series_id.to_string(),
                episode_id.to_string(),
                quality.to_string(),
            )
            .await?;
            // 不同选集线路回来的格式不一样（实测 2026-09-18）：
            //   凡人修仙传/炼气十万年 cn 线 -> **部分集是 https MP4 直链
            //   （preview.ndcsk.com 等），部分集是 http m3u8**
            //   恋爱与选举 newup-jp -> http 明文 m3u8
            // http 明文会被 CSP 的 media-src/connect-src 拦掉（只放行 https 与
            // 127.0.0.1），而且这些 CDN 不给 CORS 头，hls.js 直拉同样过不了。
            // 另实测：preview.ndcsk.com/ndcyx.com 的 https MP4 直链**连接不稳定**
            // （Range 探测间歇性 SSL EOF / ERR_CONNECTION_CLOSED，WebView2 播放
            // 时直接失败）。所以**一律走本地代理**：解决 CSP、CORS、TLS 抖动与
            // 分片重写（代理对 Range 的透传已在 hls_proxy 中实现）。
            let stream_kind = classify_stream(&url);
            let url = crate::hls_proxy::proxied_url(&url).unwrap_or(url);
            return Ok(PlaybackSession {
                session_id,
                series_id: series_id.to_string(),
                episode_id: episode_id.to_string(),
                position,
                quality: "auto".into(),
                url,
                backup_url: None,
                stream_kind: Some(stream_kind.to_string()),
            });
        }
        // 播放地址在详情接口的 vod_play_url 里：`第1集$https://...m3u8#第2集$https://...`
        let id: i64 = strip_bfzy_prefix(series_id)
            .parse()
            .map_err(|_| "动漫剧集 id 非法。".to_string())?;
        let json = self.get_json(&format!("ac=detail&ids={id}")).await?;
        let vod = json
            .get("list")
            .and_then(Value::as_array)
            .and_then(|list| list.first())
            .cloned()
            .ok_or_else(|| "动漫详情未找到该剧集。".to_string())?;
        let urls = str_field(&vod, &["vod_play_url"]).unwrap_or_default();
        let mut direct = None;
        let mut backup = None;
        for part in urls.split('#') {
            let mut segs = part.splitn(2, '$');
            let ep_title = segs.next().unwrap_or("").trim();
            let url = segs.next().unwrap_or("").trim();
            if url.is_empty() || !url.starts_with("http") {
                continue;
            }
            if ep_title == episode_id
                || normalize_ep_title(ep_title) == normalize_ep_title(episode_id)
            {
                direct = Some(url.to_string());
                break;
            }
            if backup.is_none() {
                backup = Some(url.to_string());
            }
        }
        let url = direct
            .or(backup)
            .ok_or_else(|| "该集没有可用的播放地址。".to_string())?;
        let stream_kind = classify_stream(&url);
        // m3u8 由本地 HLS 代理转发，绕过 WebView2 原生不支持 m3u8 的限制。
        let proxied = crate::hls_proxy::proxied_url(&url).unwrap_or(url);
        Ok(PlaybackSession {
            session_id,
            series_id: series_id.to_string(),
            episode_id: episode_id.to_string(),
            position,
            quality: "auto".into(),
            url: proxied,
            backup_url: None,
            stream_kind: Some(stream_kind.to_string()),
        })
    }
}

/// 判定一条动漫源地址的形态：返回 `"hls"`（m3u8 播放列表）或 `"file"`（整段媒体文件）。
///
/// 必须在 `hls_proxy::proxied_url` **之前**调用——代理会把任何地址都改写为
/// `/stream?u=…`，之后从外观上再也分不出它是播放列表还是 MP4。前端据此决定
/// 用 hls.js 挂 MSE 还是直接把地址交给 `<video>`，两者错配就是"黑屏有声"或
/// "解析失败"。（实测这批源里两种都存在：preview.ndcsk.com 的整集 MP4 与
/// img.nxjunyu.asia 的 m3u8 会在同一部剧的不同集之间来回切。）
fn classify_stream(url: &str) -> &'static str {
    let lower = url.split('?').next().unwrap_or(url).to_ascii_lowercase();
    if lower.ends_with(".m3u8") || lower.ends_with(".m3u") {
        "hls"
    } else {
        "file"
    }
}

fn urlencode(text: &str) -> String {
    let mut out = String::new();
    for byte in text.as_bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(*byte as char)
            }
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

fn str_field(value: &Value, keys: &[&str]) -> Option<String> {
    keys.iter().find_map(|key| {
        value
            .get(*key)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|text| !text.is_empty())
            .map(str::to_string)
    })
}

fn parse_series_item(vod: &Value) -> Option<SeriesItem> {
    // id 一律带 `bfzy:` 前缀：裸数字与红果短剧撞号，见 BFZY_ID_PREFIX 的说明。
    let id = format!(
        "{BFZY_ID_PREFIX}{}",
        vod.get("vod_id").and_then(Value::as_i64)?
    );
    let title = str_field(vod, &["vod_name"])?;
    // 同 detail：封面走本地代理，境外图床直连会超时。
    //
    // ⚠️ **必须按顺序回退多个字段**（2026-10-21 修「动漫专区封面全丢」）。
    // 苹果CMS 系接口（`ac=detail`）的三个封面字段各有分工，不是每个源都填满：
    //   * `vod_pic`        竖版主图，多数条目有，但**部分源整页留空**；
    //   * `vod_pic_thumb`  横版缩略图，`vod_pic` 空时往往有值；
    //   * `vod_pic_slide`  轮播图，前两者都空时的最后兜底。
    // 原实现只看 `vod_pic`，一旦该页它为空，整页卡片就只剩剧名首字——而同一批
    // 数据里明明存在可用的其它封面字段。
    let cover = str_field(vod, &["vod_pic", "vod_pic_thumb", "vod_pic_slide"]).unwrap_or_default();
    // 诊断：封面为空时把**原始字段**打进内存环形缓冲（`trace_tail` 可读回）。
    //
    // 不写文件：本机上文件写入被拒（os error 5），日志落不了盘；而 `trace::log`
    // 的内存缓冲走 IPC 就能取出来，是这类"只能看到空值"的问题唯一可靠的证据来源。
    if cover.is_empty() {
        static ONCE: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
        if !ONCE.swap(true, std::sync::atomic::Ordering::Relaxed) {
            let (key_count, all_keys) = vod
                .as_object()
                .map(|object| {
                    (
                        object.len(),
                        object.keys().cloned().collect::<Vec<_>>().join(","),
                    )
                })
                .unwrap_or((0, String::new()));
            let pic_like = vod
                .as_object()
                .map(|object| {
                    object
                        .iter()
                        .filter(|(key, _)| {
                            let lower = key.to_ascii_lowercase();
                            lower.contains("pic")
                                || lower.contains("img")
                                || lower.contains("cover")
                        })
                        .map(|(key, value)| {
                            format!(
                                "{key}={}",
                                value.to_string().chars().take(70).collect::<String>()
                            )
                        })
                        .collect::<Vec<_>>()
                        .join(" | ")
                })
                .unwrap_or_default();
            crate::trace::log(format!(
                "[anime-cover] 空封面 标题={title} 字段数={key_count} 全部字段=[{all_keys}] 图片类=[{pic_like}]"
            ));
        }
    }
    // 同上：封面存原始地址。只有**播放列表/分片**才需要本地代理。
    let type_name = str_field(vod, &["type_name"]).unwrap_or_else(|| "动漫".into());
    let remarks = str_field(vod, &["vod_remarks"]).unwrap_or_default();
    // 集数从 remarks（"更新至第6集"/"第10集"）提取；"已完结"等无数字 remarks
    // 保留原文（前端显示完结状态，不显示"集数未知"）。
    let episodes_count = extract_episode_count(&remarks);
    Some(SeriesItem {
        id,
        title,
        cover,
        item_type: "anime".into(),
        episodes_count,
        latest_episode_title: (!remarks.is_empty()).then_some(remarks.clone()),
        tags: vec![type_name],
        origin: "暴风动漫源".into(),
        brief: Some(remarks),
        // 恒为 None：苹果CMS 的 vod_* 字段里没有任何评分位（实测字段集为
        // vod_id / vod_name / vod_pic / type_name / vod_remarks / vod_class /
        // vod_content / vod_play_url）。评分角标是红果那条链路的事，动漫源
        // 本来就没有——不造分，不显示 0.0 分。
        rating: None,
    })
}

fn extract_episode_count(remarks: &str) -> u32 {
    // "更新至第287集" → 287；"已完结"/"HD" 等无数字返回 0（前端显示 remarks 原文）。
    let digits: String = remarks
        .chars()
        .skip_while(|c| !c.is_ascii_digit())
        .take_while(|c| c.is_ascii_digit())
        .collect();
    digits.parse().unwrap_or(0)
}

fn class_tags(vod: &Value) -> Vec<String> {
    let mut tags = Vec::new();
    if let Some(name) = str_field(vod, &["type_name"]) {
        tags.push(name);
    }
    if let Some(class) = str_field(vod, &["vod_class"]) {
        for tag in class.split(',').map(str::trim).filter(|t| !t.is_empty()) {
            if !tags.iter().any(|existing| existing == tag) {
                tags.push(tag.to_string());
            }
        }
    }
    tags
}

fn parse_episodes(vod: &Value, series_id: &str) -> (Vec<EpisodeItem>, u32) {
    // vod_play_url 形如 `第1集$https://...m3u8#第2集$https://...m3u8`。
    // 优先取 m3u8 源（bfzym3u8）。
    let urls = str_field(vod, &["vod_play_url"]).unwrap_or_default();
    let mut episodes = Vec::new();
    for (index, part) in urls.split('#').enumerate() {
        let mut segs = part.splitn(2, '$');
        let ep_title = segs.next().unwrap_or("").trim();
        let url = segs.next().unwrap_or("").trim();
        if url.is_empty() || !url.starts_with("http") {
            continue;
        }
        episodes.push(EpisodeItem {
            id: ep_title.to_string(),
            series_id: series_id.to_string(),
            episode_number: (index + 1) as u32,
            title: ep_title.to_string(),
            duration_seconds: 0.0,
            preview_url: None,
        });
    }
    let count = episodes.len() as u32;
    (episodes, count)
}

fn normalize_ep_title(title: &str) -> String {
    // clippy::collapsible_str_replace：一次 replace 传字符数组即可，语义与两次链式相同。
    title.replace([' ', '\u{3000}'], "")
}

fn strip_html(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut in_tag = false;
    for ch in text.chars() {
        match ch {
            '<' => in_tag = true,
            '>' => in_tag = false,
            c if !in_tag => out.push(c),
            _ => {}
        }
    }
    out.trim().to_string()
}

/// 是否走 dmghg 正式源。
///
/// 可用性只在进程内判一次（DLL 加载失败会永久回退到暴风），避免出现
/// "列表来自 dmghg、详情却落到暴风" 这种 id 串源的情况。
fn use_dmghg() -> bool {
    crate::dmghg_bridge::preferred() && crate::dmghg_bridge::available()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 来源判定必须认全两种前缀，且**不能**认裸数字：裸数字与红果短剧撞号，一旦
    /// `is_anime_id` 对裸数字返回 true，红果的短剧就会被反向送进动漫链路。
    #[test]
    fn anime_id_requires_source_prefix() {
        assert!(is_anime_id("dmghg:181655"));
        assert!(is_anime_id("bfzy:44871"));
        assert!(!is_anime_id("44871"));
        assert!(!is_anime_id(""));
    }

    /// 旧数据兼容：加前缀之前生成的裸数字 id 只可能来自暴风（dmghg 的 id 一直有前缀），
    /// 剥前缀必须原样放行，否则历史 / 收藏里的旧条目会全部失效。
    #[test]
    fn strip_prefix_tolerates_bare_ids() {
        assert_eq!(strip_bfzy_prefix("bfzy:44871"), "44871");
        assert_eq!(strip_bfzy_prefix("44871"), "44871");
        assert_eq!(strip_bfzy_prefix(""), "");
    }

    /// 列表项 id 必须自带来源前缀：这是整个路由修复的根。退回裸数字就等于退回
    /// 「撞号查到红果同 id 的剧、只剩标题没有集数」那个 bug。
    #[test]
    fn series_item_id_carries_source_prefix() {
        let item = parse_series_item(&serde_json::json!({
            "vod_id": 44871,
            "vod_name": "章鱼哥",
            "vod_pic": "https://img.bfzypic.com/a.jpg",
            "type_name": "动漫",
            "vod_remarks": "更新至第6集",
        }))
        .expect("应解析出列表项");
        assert_eq!(item.id, "bfzy:44871");
        assert_eq!(item.episodes_count, 6);
    }

    /// 联调：真实请求一次暴风目录，验证「系统代理没开时会自动走本机代理」这条链路。
    ///
    /// 默认 `#[ignore]`：它要联网、还要本机真有一个能用的代理端口，放进常规测试集会红。
    /// 排障时手动跑：
    ///   cargo test --bin ttv-short-drama anime_catalog_reaches_source -- --ignored --nocapture
    ///
    /// 2026-11-02 用它钉死过现场：`ProxyEnable=0` 时直连该接口 64 KB 要 94 秒，
    /// 走自动探测到的 `127.0.0.1:7897` 只要 1.36 秒。
    #[tokio::test]
    #[ignore = "需要联网 + 本机可用的代理端口，只在排障时手动跑"]
    async fn anime_catalog_reaches_source() {
        // 强制走兜底源：dmghg DLL 可用时 `catalog` 会走正式源，就测不到这条链路了。
        std::env::set_var("TTV_ANIME_SOURCE", "bfzy");
        let provider = AnimeProvider::new().expect("客户端创建失败");
        let page = provider
            .catalog(&CatalogFilter {
                channel: "anime".into(),
                source: None,
                category: "全部".into(),
                audience: "全部".into(),
                sort: "recommend".into(),
                keyword: None,
                page: 1,
                page_size: 30,
                cursor: None,
            })
            .await
            .expect("目录请求失败");
        assert!(page.total > 0, "目录总数应为正数");
        assert!(!page.items.is_empty(), "第一页不应为空");
    }

    /// 暴风源没有评分位，卡片必须给 `None` 而不是 0。
    ///
    /// 苹果CMS 的 vod_* 字段集里根本没有评分（实测见 parse_series_item 的注释），
    /// 而前端 `SeriesCard` 是 `{series.rating && …}` —— 填 0 会渲染成"0.0 分"的
    /// 琥珀角标，是凭空造分（不变量 8：不要把不存在的东西显示成可用）。
    #[test]
    fn anime_items_never_carry_a_fabricated_rating() {
        let item = parse_series_item(&serde_json::json!({
            "vod_id": 44871,
            "vod_name": "章鱼哥",
            "vod_remarks": "已完结",
        }))
        .expect("应解析出列表项");
        assert!(
            item.rating.is_none(),
            "暴风源没有评分数据，rating 必须是 None 而不是 0"
        );
        let json = serde_json::to_value(&item).expect("序列化");
        assert!(
            !json
                .get("rating")
                .is_some_and(|value| value.as_f64() == Some(0.0)),
            "载荷里不得出现 0 分占位"
        );
    }
}
