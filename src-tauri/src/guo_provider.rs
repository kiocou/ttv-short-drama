use crate::models::{
    CatalogFilter, CatalogPage, EpisodeItem, PlaybackSession, SeriesDetail, SeriesItem,
    VideoQualityOption,
};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

pub const GUO_ID_PREFIX: &str = "guo:";

/// 一次 `resolve` 换来的 guo 播放会话（键是前端 `session_id`）。
///
/// 表里只留 `session` 一个字段：它唯一的读点是 [`GuoProvider::release`] 转发
/// guo-core 的 `release` action，那是**资源释放**语义（让上游把解密/连接还回去），
/// 与表里存不存别的东西无关。
///
/// **曾经还存过 `episode_id`，因为要接弹幕——已删。记在这里是防止下一个人再接一遍**：
/// guo-core 的 `danmaku` action 压根没有 drama/chapter 入参，弹幕身份（红果的剧 id
/// 与视频 id）只挂在**播放会话**上（`nativeDanmaku` 第一件事就是查
/// `engine.playbacks[session]`，会话 12h 过期）；而能产出会话的前提是剧集 id 形如
/// `guo:hongguo:<数字>`。可红果被 `main.rs` **显式排除在 guo 链路之外**
/// （`catalog_list` / `catalog_fast_search` / `catalog_categories` 里都是
/// `if source != "hongguo"`，红果走原生 `DramaProvider`，剧集 id 是裸
/// `series_id`）——`guo:hongguo:` 这个前缀**永远产生不出来**，整条弹幕链路不可达。
/// 真要接，前置条件是让红果重新进 guo 链路，那是另一件事。
struct GuoPlayback {
    session: String,
}

/// guo 播放序号的基数。
///
/// 必须**远大于前端任何 session_id**：前端会话号从 100 起（见不变量 13，两个
/// 窗口各自持有一份、都从 100 起），整部剧几百集、连切源换清晰度也就几千，
/// 留三个数量级的余量够用到这个应用被判死为止。
const SEQUENCE_BASE: u64 = 1_000_000;

/// 下一发 resolve 的全局单调序号。
///
/// guo-core 的 `nativeBeginPlayback` 把 sequence 当**全局高水位**用：
/// `sequence <= engine.playbackSequence` 直接回 `context.Canceled`，并且每发新的
/// 都会先 `playbackCancel()` 掐掉上一次 resolve
/// （`guo-core/core/app_playback.go:5-26`）。所以这个号既不能重复、也不能倒退。
///
/// **不能直接拿前端的 `session_id` 当 sequence**（`open_episode` 原来就是这么
/// 传的）：它从 100 起，第一次起播就把水位抬到 100，此后任何 `sequence=1` 的
/// 画质探测必被 Cancel——这正是"guo 画质从第二集起恒为空"的根因。而且两个窗口
/// 各自持有一份从 100 起的计数，裸作 key 还会互相撞车。
///
/// `open_episode` 与 `qualities` 共用这一个计数器：fetch_add 严格单调，所以后发
/// 的画质探测拿到的号必然大于此前任何一次起播的号。抽成自由函数是为了不加载
/// DLL 也能测（`GuoProvider::new` 要 LoadLibrary）。
fn next_sequence(counter: &AtomicU64) -> u64 {
    SEQUENCE_BASE + counter.fetch_add(1, Ordering::Relaxed)
}

/// 播放会话表保留的条数上界。
///
/// 16 条足够覆盖主窗口当前集 + 画中画小窗 + 连播/切源时刚解析过的前几集。之所以
/// 需要上界：这张表原来只增不减——清理走 `playback_command` 的 `stop` 分支，而前端
/// `ipcService.playback.command` 在 `src/` 里零调用点（`stopPlayback` 是纯前端收口），
/// 那条分支永不执行，表就随播放时长一路涨。
const SESSION_HISTORY_LIMIT: usize = 16;

/// 裁剪会话表：只留 `session_id` 最大的 `keep` 条。
fn retain_recent_sessions(sessions: &mut HashMap<u64, GuoPlayback>, keep: usize) {
    if sessions.len() <= keep {
        return;
    }
    let mut recent: Vec<u64> = sessions.keys().copied().collect();
    recent.sort_unstable_by(|left, right| right.cmp(left));
    recent.truncate(keep);
    sessions.retain(|id, _| recent.contains(id));
}

/// 一个 guo 站源的**结构性**属性。
///
/// 这里刻意只有 `id` / `name` / `adult`：可用性（`available` / `partial` /
/// `blocked`）原来还有第三个字段，但它是一份手填快照，填完就不再变——芽果当时
/// 记着"未返回有效的访问令牌"却仍被标成 `available`。真实健康度改由 guo-core 的
/// `sourceStatus` / `sourceJob` 现测（[`GuoProvider::source_status_all`]），
/// 同名的 `guo_sources` 命令已随之删除：它在 `src/` 里零调用点，输出的
/// `available` 只会与真实健康度漂移。
///
/// [`GuoSource::adult`] 与前端 `src/services/guoSources.ts` 的 `adult` 字段
/// **必须保持一致——这两份 18+ 源名单是各存一份的，迟早会漂**。它们服务的是
/// 两端各自的一部分职责：前端那份决定源选择器里勾不勾得到、聚合时收不收，后端
/// 这份是**门闩的唯一权威**（前端过滤可以被绕过，`invoke('catalog_list', …)`
/// 直接打到后端）。合并不了的地方在前端：它是 TS 常量，这边是 Rust 静态表，
/// 中间隔着 FFI 契约，加一层代码生成不换一分漂移风险，只多一个构建期依赖。
/// 所以**改任一份都要同步改另一份**，并留一条测试钉住六个 18+ 源的名字
/// （`source_is_adult_matches_the_frontend_list`）。
#[derive(Debug, Clone, Copy)]
pub struct GuoSource {
    pub id: &'static str,
    pub name: &'static str,
    /// 18+ 成人内容源，受设置页"显示 18+ 内容源"总开关控制。
    ///
    /// 分类依据是各源**实际目录内容**，不是站名——下面每条的 `实测` 注释
    /// 照抄前端 `guoSources.ts` 的同源结论（2026-09-29 逐源抽查），别自己重编。
    pub adult: bool,
}

pub const GUO_SOURCES: &[GuoSource] = &[
    // 实测：2044 条全为真人短剧（都市/逆袭/爱情/年代，有剧情简介、几十至上百集）。
    GuoSource {
        id: "hongguo",
        name: "红果短剧 / 漫剧",
        adult: false,
    },
    // 实测 30 条：多数"黄豆原创"（真人成人），但含"国漫"分类的少量动漫条目。
    GuoSource {
        id: "huangdou",
        name: "黄豆",
        adult: true,
    },
    // 实测 20 条：分类恒为"短剧"，标题为成人真人条目。
    GuoSource {
        id: "huangju",
        name: "剧果",
        adult: true,
    },
    // 实测 20 条：分类恒为"短剧"，标签为成人题材；集数全部为 0。
    GuoSource {
        id: "yeguo",
        name: "野果",
        adult: true,
    },
    // 实测 72 条：真人成人向内容（无码中字 / 无码破解）。
    GuoSource {
        id: "dsd",
        name: "帝果",
        adult: true,
    },
    // 实测 96 条：分类恒为 "AI 短剧"（AI 生成、真人外形），有集数。
    GuoSource {
        id: "huangguoai",
        name: "黄果 AI",
        adult: true,
    },
    // 实测 40 条：分类为 series/video 的混合条目，真人。
    GuoSource {
        id: "huangguo-video",
        name: "黄果视频",
        adult: true,
    },
    // 实测失败："芽果未返回有效的访问令牌"，内容未验证，暂按真人登记。
    GuoSource {
        id: "yaguo",
        name: "芽果",
        adult: false,
    },
    // 实测 66 条：都市情感真人短剧，33~70 集。
    GuoSource {
        id: "maoguo",
        name: "猫果",
        adult: false,
    },
    // 实测 10 条：分类恒为"都市"，真人，30~90 集。
    GuoSource {
        id: "fanguo",
        name: "饭果",
        adult: false,
    },
    // 实测 30 条：玄幻仙侠/都市爱情/逆袭/甜宠，真人。
    GuoSource {
        id: "guanguo",
        name: "观果",
        adult: false,
    },
    // 实测 63 条：都市/古风/复仇真人短剧，部分条目集数为 0。
    GuoSource {
        id: "heguo",
        name: "河果",
        adult: false,
    },
    // 实测 10 条：真人短剧，20~91 集。
    GuoSource {
        id: "xingguo",
        name: "星果",
        adult: false,
    },
    // 实测 36 条：标题带题材后缀的真人短剧，但含《工资真相-动漫合集》这一漫剧条目。
    GuoSource {
        id: "huaguo",
        name: "花果",
        adult: false,
    },
    // 实测 12 条：穿越/修仙/剑仙，集数全为 0；无简介，按真人登记。
    GuoSource {
        id: "niuguo",
        name: "牛果",
        adult: false,
    },
    // 实测 403（站点要求浏览器验证），内容未验证。
    GuoSource {
        id: "wangguo",
        name: "网果",
        adult: false,
    },
    // 实测 444。
    GuoSource {
        id: "faguo",
        name: "发果",
        adult: false,
    },
    // 实测 492，且两次探测结果不一致（一次 10 条、一次报错），链路不稳。
    GuoSource {
        id: "piguo",
        name: "皮果",
        adult: false,
    },
    // 实测 30 条：古代宅斗/宫斗真人短剧，集数恒为 1。
    GuoSource {
        id: "wuguo",
        name: "伍果",
        adult: false,
    },
];

/// 该站源是否属于 18+ 受控清单。
///
/// 认不出的 id 一律**不当成 18+**：门闩的方向是"挡住"，认错了方向是
/// 把未登记的新源当普通源放行——那等于门闩对新源失效。反过来说，把一个
/// 已经被前端登记为 18+ 的源漏标成普通源，同样是放行；这正是上面那段
/// "两份名单必须同步"的注释要防的事。
pub fn source_is_adult(source: &str) -> bool {
    GUO_SOURCES
        .iter()
        .find(|item| item.id == source)
        .map(|item| item.adult)
        .unwrap_or(false)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct GuoIds<'a> {
    pub source: &'a str,
    pub raw_series_id: &'a str,
}

pub fn is_guo_id(series_id: &str) -> bool {
    parse_guo_series_id(series_id).is_some()
}

pub fn parse_guo_series_id(series_id: &str) -> Option<GuoIds<'_>> {
    let rest = series_id.strip_prefix(GUO_ID_PREFIX)?;
    let (source, raw_series_id) = rest.split_once(':')?;
    if source.is_empty() || raw_series_id.is_empty() {
        return None;
    }
    Some(GuoIds {
        source,
        raw_series_id,
    })
}

/// 从剧集 id 里取出它所属的 guo 站源 id；不是 guo id 则返回空串。
///
/// 与 [`is_guo_id`] 的分工：那个只回答"走不走 guo 链路"，而 18+ 门闩要回答的
/// 是"是**哪个**源"。`guo:dsd:123` 两条都为真但只有本函数能给出门闩要的答案，
/// 所以命令侧的守卫统一走它，别再自己拆前缀（拆法一旦和这里漂移，守卫会静默
/// 失效在"拼错前缀"上，而门闩失效是不报错的）。
pub fn guo_source_of(series_id: &str) -> &str {
    parse_guo_series_id(series_id)
        .map(|ids| ids.source)
        .unwrap_or_default()
}

fn guo_id(source: &str, raw: &str) -> String {
    format!("{GUO_ID_PREFIX}{source}:{raw}")
}

fn guo_episode_raw<'a>(series_id: &str, episode_id: &'a str) -> Option<&'a str> {
    let ids = parse_guo_series_id(series_id)?;
    episode_id.strip_prefix(format!("{GUO_ID_PREFIX}{}:", ids.source).as_str())
}

fn text(value: &Value, keys: &[&str]) -> String {
    keys.iter()
        .find_map(|key| match value.get(*key) {
            Some(Value::String(value)) => Some(value.trim().to_owned()),
            Some(Value::Number(value)) => Some(value.to_string()),
            Some(Value::Bool(value)) => Some(value.to_string()),
            _ => None,
        })
        .unwrap_or_default()
}

/// guo-core 错误的公开化清洗（不变量 12）。
///
/// guo-core 的错误主文案是面向用户的中文（"野果线路暂不可用，请稍后重试"），
/// 但网络层的细节会拼在后面：死链时是
/// "获取花果播放列表失败：cdn.yddsha2.com HTTP 404"，超时时是
/// `Get "https://analyze.buxefaex.cc/": context deadline exceeded`——内部域名、
/// URL、IP 直接见了用户。清洗原则：**剥技术 token（URL/域名/IP），保留并翻译
/// 语义**（"HTTP 404" → "播放文件不存在或已下线"），guo-core 自己的人话文案
/// 原样保留。原始错误在 `GuoBridge::request` 里已进 stderr 留诊断。
fn sanitize_guo_error(raw: &str) -> String {
    use std::sync::OnceLock;
    static PATTERNS: OnceLock<(regex::Regex, regex::Regex, regex::Regex, regex::Regex)> =
        OnceLock::new();
    let (go_wrap, url, host, ip) = PATTERNS.get_or_init(|| {
        (
            // Go http client 的双层包装：`Get "URL": Get "URL": dial tcp: ...`
            regex::Regex::new(r#"Get\s*"[^"]*"\s*:\s*"#).unwrap(),
            regex::Regex::new(r"https?://\S+").unwrap(),
            // 域名 token（Go 侧错误里常跟在中文冒号后）。
            regex::Regex::new(
                r"(?i)(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+(?:com|net|org|cc|vip|top|red|se|xyz|io|me|tv|app|site|online|club|shop|link|icu|buzz|cyou|info|cn|live|fun|pro)\b",
            )
            .unwrap(),
            regex::Regex::new(r"\b\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?\b").unwrap(),
        )
    });
    let cleaned = go_wrap.replace_all(raw, "");
    let cleaned = url.replace_all(&cleaned, "");
    let cleaned = host.replace_all(&cleaned, "");
    let cleaned = ip.replace_all(&cleaned, "");
    let cleaned = cleaned
        .replace("context deadline exceeded", "响应超时")
        .replace("Client.Timeout", "响应超时")
        .replace("context canceled", "已取消")
        .replace("no such host", "站点域名无法解析，站点可能已关闭")
        .replace("dial tcp: lookup ", "")
        .replace("dial tcp", "站点连接失败")
        .replace("connection refused", "站点拒绝连接")
        .replace("connection reset", "站点中断了连接")
        .replace("HTTP 404", "播放文件不存在或已下线")
        .replace("HTTP 403", "站点拒绝了本次访问")
        .replace("HTTP 429", "请求过于频繁");
    // 剥完 token 后残留的孤立分隔符与连续空白收尾，别把 "失败： " 这样的
    // 空尾巴或 "：：" 挤在句中。
    let mut result = cleaned
        .split('\n')
        .map(|line| {
            let mut trimmed = line
                .replace("：：", "：")
                .replace("::", ":")
                .replace("，，", "，")
                .replace(", ,", ",")
                .trim()
                .to_owned();
            // 剥 token 后残留在行首的孤立分隔符（皮果的 Go 双层包装剥完就剩
            // 一个 ": "）。按字符剥，全角冒号是三字节，字节切片会截断 UTF-8。
            while let Some(first) = trimmed.chars().next() {
                if matches!(first, ':' | '：' | ',' | '，') {
                    trimmed = trimmed[first.len_utf8()..].trim_start().to_owned();
                } else {
                    break;
                }
            }
            trimmed
        })
        .collect::<Vec<_>>()
        .join("\n");
    while result.contains("  ") {
        result = result.replace("  ", " ");
    }
    let result = result.trim().to_owned();
    if result.is_empty() {
        "该站源暂时不可用，请稍后重试。".to_owned()
    } else {
        result
    }
}

fn number(value: &Value, keys: &[&str]) -> u32 {
    keys.iter()
        .find_map(|key| {
            value.get(key).and_then(|raw| {
                // guo-core 的输出把集数、章节号这类数字字段序列化成字符串
                // （实测目录 item 是 `episodes: "33"`），只认 as_u64 会把它们
                // 全读成 0——卡片集数徽标随之全灭、章节号全部退回 index 兜底。
                // 字符串先按数字解析，空串/非数字算没有这个值。
                raw.as_u64()
                    .or_else(|| raw.as_str()?.trim().parse::<u64>().ok())
            })
        })
        .unwrap_or(0) as u32
}

fn string_list(value: &Value, key: &str) -> Vec<String> {
    value
        .get(key)
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.as_str())
                .map(str::trim)
                .filter(|item| !item.is_empty())
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default()
}

fn quality_int(value: &str) -> i32 {
    value
        .chars()
        .filter(char::is_ascii_digit)
        .collect::<String>()
        .parse()
        .unwrap_or(0)
}

fn stream_kind(url: &str) -> &'static str {
    if url
        .split('?')
        .next()
        .unwrap_or(url)
        .to_ascii_lowercase()
        .ends_with(".m3u8")
    {
        "hls"
    } else {
        "file"
    }
}

#[cfg(windows)]
mod ffi {
    use super::Path;
    use serde_json::Value;
    use std::collections::HashMap;
    use std::ffi::{c_char, CStr, CString};
    use std::sync::{Arc, Mutex};
    use windows_sys::Win32::System::LibraryLoader::{GetProcAddress, LoadLibraryA};

    type RequestFn = unsafe extern "C" fn(*const c_char) -> *mut c_char;
    type FreeFn = unsafe extern "C" fn(*mut c_char);

    pub struct GuoBridge {
        request: RequestFn,
        free: FreeFn,
        /// 按站源分片的调用锁（键 = 站源 id；空串 = 全局片，给带不出站源的
        /// action 用）。**只护 FFI 入口，不护任何 Rust 侧数据**。
        ///
        /// 原来是一把全局锁：任何一个源的调用没回来，其余 18 个源的目录、封面、
        /// 起播全部排队。实测（2026-10-06，直连）神秘小窝 6 个 18+ 源里 3 个已死
        /// （野果 25s、帝果 16s、黄果 AI 6 镜像跑满 60s 才认输），打开该专区 =
        /// 6 个目录请求在全局锁里串行 ≈ 104s 才出首屏；期间连其它 tab 的封面与
        /// 播放 resolve 都被一起冻住。分片后互不拖拽：一个源死，只有它自己的
        /// 后续调用在它自己的片里等 Go 侧 60s 超时。
        ///
        /// 分片对 guo-core 是安全的：c-shared 每次调用本来就跑在独立 goroutine
        /// 上，共享状态（catalogs / categories / covers / sessions）在 Go 侧全部
        /// 有 `engine.mu` 或每源锁；上游 LAN 模式的 HTTPS 服务也是多 goroutine
        /// 并发进同一批 handler。带不出站源的 action（initialize /
        /// resourceSettings / saveResourceSettings / release / cancelRead 这类
        /// 全局语义）仍共享同一把全局片，保持互相独占。
        locks: Mutex<HashMap<String, Arc<Mutex<()>>>>,
    }

    unsafe impl Send for GuoBridge {}
    unsafe impl Sync for GuoBridge {}

    impl GuoBridge {
        pub fn load(path: &Path) -> Result<Self, String> {
            let raw_path = CString::new(path.to_string_lossy().as_bytes())
                .map_err(|_| "guo-core DLL 路径无效。".to_string())?;
            let module = unsafe { LoadLibraryA(raw_path.as_ptr() as *const u8) };
            if module.is_null() {
                return Err("加载 guo-core 失败，缺少 duanju_core.dll。".to_string());
            }
            let request = unsafe {
                GetProcAddress(module, c"DuanjuRequest".as_ptr().cast::<u8>())
                    .ok_or_else(|| "guo-core 缺少 DuanjuRequest 导出。".to_string())
            }?;
            let free = unsafe {
                GetProcAddress(module, c"DuanjuFree".as_ptr().cast::<u8>())
                    .ok_or_else(|| "guo-core 缺少 DuanjuFree 导出。".to_string())
            }?;
            Ok(Self {
                request: unsafe {
                    std::mem::transmute::<unsafe extern "system" fn() -> isize, RequestFn>(request)
                },
                free: unsafe {
                    std::mem::transmute::<unsafe extern "system" fn() -> isize, FreeFn>(free)
                },
                locks: Mutex::new(HashMap::new()),
            })
        }

        /// 拿到这次调用该排在哪把片锁上。**外层表锁只护 HashMap 几微秒，绝不
        /// 跨 FFI**（不变量 15 的锁内不 await 在这里同样成立）。
        fn shard_for(&self, input: &Value) -> Result<Arc<Mutex<()>>, String> {
            let key = bridge_lock_key(input);
            let mut locks = self
                .locks
                .lock()
                .map_err(|_| "guo-core 调用锁不可用。".to_string())?;
            Ok(locks
                .entry(key)
                .or_insert_with(|| Arc::new(Mutex::new(())))
                .clone())
        }

        pub fn request(&self, input: &Value) -> Result<Value, String> {
            let body = serde_json::to_string(input).map_err(|error| error.to_string())?;
            let raw = CString::new(body).map_err(|_| "guo-core 请求包含无效字符。".to_string())?;
            let shard = self.shard_for(input)?;
            let _guard = shard
                .lock()
                .map_err(|_| "guo-core 调用锁不可用。".to_string())?;
            let output = unsafe { (self.request)(raw.as_ptr()) };
            if output.is_null() {
                return Err("guo-core 没有返回结果。".to_string());
            }
            let result = unsafe { CStr::from_ptr(output) }
                .to_string_lossy()
                .into_owned();
            unsafe { (self.free)(output) };
            let envelope: Value = serde_json::from_str(&result)
                .map_err(|_| "guo-core 返回了无效 JSON。".to_string())?;
            if envelope.get("ok").and_then(Value::as_bool) != Some(true) {
                let raw = text(&envelope, &["error"]);
                // 原始错误进 stderr 留诊断；给上层的必须脱敏——guo-core 的
                // 错误会拼进内部域名/URL/IP（如死链时的
                // "获取花果播放列表失败:cdn.yddsha2.com HTTP 404"），直接透传
                // 到 UI 违反不变量 12。
                eprintln!("[ttv] guo-core 错误: {raw}");
                return Err(super::sanitize_guo_error(&raw));
            }
            Ok(envelope.get("data").cloned().unwrap_or(Value::Null))
        }
    }

    /// 这次桥接调用落在哪个分片上。
    ///
    /// 取站源的三条路（与 guo-core 各 action 的入参习惯一一对应）：
    /// `catalog` / `cached` / `categories` / `sourceJob` 顶层带 `source`；
    /// `detail` / `resolve` / `cover` 带 `drama.source`；兜底从 `drama.id`
    /// （`"源:裸id"`，见 `cover()` / `detail_raw()` 的拼法）剥前缀。三条都带
    /// 不出来（initialize / resourceSettings / saveResourceSettings / release /
    /// cancelRead 这类全局语义）回空串 = 全局片。
    ///
    /// 键只要求**一致**不要求规范：同一源两种写法顶多少并行一点，不会错。
    pub(super) fn bridge_lock_key(input: &Value) -> String {
        let non_empty = |value: Option<&str>| -> Option<String> {
            let trimmed = value?.trim();
            (!trimmed.is_empty()).then(|| trimmed.to_owned())
        };
        if let Some(source) = non_empty(input.get("source").and_then(Value::as_str)) {
            return source;
        }
        let Some(drama) = input.get("drama") else {
            return String::new();
        };
        if let Some(source) = non_empty(drama.get("source").and_then(Value::as_str)) {
            return source;
        }
        non_empty(
            drama
                .get("id")
                .and_then(Value::as_str)
                .and_then(|id| id.split(':').next()),
        )
        .unwrap_or_default()
    }

    fn text(value: &Value, keys: &[&str]) -> String {
        keys.iter()
            .find_map(|key| value.get(*key).and_then(Value::as_str).map(str::to_owned))
            .unwrap_or_else(|| "guo-core 调用失败。".to_string())
    }
}

/// 死源冷却时长。
///
/// 2026-09-29 逐源体检：19 个源里 yeguo 目录 25s、huangguoai 60s（6 个镜像逐个
/// 试）、niuguo resolve 57s 才吐超时——站方死了，guo-core 每次都要把内部重试跑满
/// 才认输。而 guo 源的失败**不写目录缓存**，意味着死源永远走全量网络：发现页
/// `Promise.allSettled` 等所有源，每次首屏都被拖 25-60s。这里给失败源记一个冷却
/// 期，期内再请求直接快速失败（0ms），到期自动放行再探一次——站方恢复无需重启。
const CATALOG_COOLDOWN: std::time::Duration = std::time::Duration::from_secs(10 * 60);

/// 该源是否还在冷却期内。抽成自由函数是为了单测：判定只依赖表与当前时刻，
/// 不需要真 DLL。
fn catalog_cooldown_active(cooldowns: &HashMap<String, std::time::Instant>, source: &str) -> bool {
    cooldowns
        .get(source)
        .is_some_and(|failed_at| failed_at.elapsed() < CATALOG_COOLDOWN)
}

pub struct GuoProvider {
    bridge: ffi::GuoBridge,
    sessions: Mutex<HashMap<u64, GuoPlayback>>,
    /// 下一个 resolve 的全局单调序号，见 [`next_sequence`]。
    playback_sequence: AtomicU64,
    /// 每个站源的分类表（`(id, name)`，用于把前端题材栏的显示名映射回源侧 ID。
    ///
    /// 各 guo 源的分类 ID 体系互不相同：黄果视频是数字、黄果 AI 是 slug、duanju
    /// 系是英文键；而题材栏展示并回传的是中文 name。不映射就直接把"全部/爱情"
    /// 当 category 发过去，会被 guo-core 的分类校验整体拒绝（表现为"目录加载失败"）。
    category_index: Mutex<HashMap<String, Vec<(String, String)>>>,
    /// 处于冷却期的站源（id → 失败时刻），见 [`CATALOG_COOLDOWN`]。
    catalog_cooldowns: Mutex<HashMap<String, std::time::Instant>>,
    /// 正在后台刷新的 `"源|分类"` 集合（SWR 去重），见 [`GuoProvider::catalog`]。
    revalidating: Mutex<HashSet<String>>,
}

impl GuoProvider {
    pub fn new(resource_dir: &Path, data_dir: &Path) -> Result<Self, String> {
        let bridge = ffi::GuoBridge::load(&find_dll(resource_dir)?)?;
        let core_data = data_dir.join("guo-core");
        std::fs::create_dir_all(&core_data).map_err(|error| error.to_string())?;
        let provider = Self {
            bridge,
            sessions: Mutex::new(HashMap::new()),
            playback_sequence: AtomicU64::new(0),
            category_index: Mutex::new(HashMap::new()),
            catalog_cooldowns: Mutex::new(HashMap::new()),
            revalidating: Mutex::new(HashSet::new()),
        };
        provider.bridge.request(&json!({
            "action": "initialize",
            "directory": core_data.to_string_lossy(),
        }))?;
        provider.apply_first_run_proxy_default(&core_data);
        Ok(provider)
    }

    /// 首次运行把 guo 源网络默认成**直连**。
    ///
    /// guo-core 的默认代理模式是 `auto`（跟随系统代理），而 guo 的 19 个站全是
    /// 境内 CDN 站点：实测（2026-09-29）挂系统代理（机场出口）访问花果站
    /// `www.zywest263.com` 恒为 HTTP 403，同一请求直连 200、详情能拿到完整分集。
    /// 本应用的目标用户在国内、开着系统代理（Clash/V2Ray 类）是常态，auto 出厂
    /// 即坏；直连对境外用户只是慢，不至于 403。只在**没有** resource-settings.json
    /// 时写一次——文件一旦存在（含用户在设置页改回“跟随系统代理”），一切交给
    /// guo-core 自己的持久化，这里不再覆盖。
    fn apply_first_run_proxy_default(&self, core_data: &Path) {
        if core_data.join("resource-settings.json").exists() {
            return;
        }
        let _ = self.set_proxy_mode("direct");
    }

    /// 当前 guo 源网络模式（`auto` 跟随系统代理 / `direct` 直连）。
    pub fn proxy_mode(&self) -> Result<String, String> {
        let data = self
            .bridge
            .request(&json!({ "action": "resourceSettings" }))?;
        let mode = text(&data, &["proxyMode"]);
        if mode.is_empty() {
            return Err("guo-core 未返回网络模式。".to_string());
        }
        Ok(mode)
    }

    /// 切换 guo 源网络模式。读一份当前完整设置、只改 proxyMode 再存回——
    /// guo-core 校验要求并发等字段同时在合法区间，缺了整体拒绝。
    /// `saveResourceSettings` 是热应用：代理路由立即切换，无需重启。
    ///
    /// 回写必须带上读到的**全部**可写字段：guo-core 侧按 JSON unmarshal 进
    /// struct，缺字段即零值——`proxyUrl` / `downloadBySource` 漏传会被静默
    /// 清空，而那个文件是这套设置的唯一持久化，丢了就真丢了。
    pub fn set_proxy_mode(&self, mode: &str) -> Result<(), String> {
        if mode != "auto" && mode != "direct" {
            return Err("网络模式无效。".to_string());
        }
        let current = self
            .bridge
            .request(&json!({ "action": "resourceSettings" }))?;
        let number_or = |key: &str, fallback: i64| -> i64 {
            current.get(key).and_then(Value::as_i64).unwrap_or(fallback)
        };
        self.bridge.request(&json!({
            "action": "saveResourceSettings",
            "settings": {
                "proxyMode": mode,
                "proxyUrl": current.get("proxyUrl").and_then(Value::as_str).unwrap_or_default(),
                "catalogConcurrency": number_or("catalogConcurrency", 3),
                "catalogIntervalMs": number_or("catalogIntervalMs", 250),
                "downloadConcurrency": number_or("downloadConcurrency", 2),
                "downloadBySource": current.get("downloadBySource").and_then(Value::as_bool).unwrap_or(false),
            },
        }))?;
        Ok(())
    }

    /// 目录：缓存优先，未命中才走网络。
    ///
    /// 这里原来一直写死 `force: true`，而 guo-core 自己在
    /// `<data_dir>/guo-core/catalogs.json` 里维护着一整份剧库缓存（实测已
    /// 527KB、17 个源）——于是每次切源/刷新都重新拉一遍网络（实测 599ms），
    /// 缓存只写不读。现在先问一次 `cached`（纯读盘，实测 1ms），命中就直接
    /// 用，连 `catalog` action 都不发。
    ///
    /// 取舍：首次访问某个源必然未命中 → 走网络并顺手写盘，第二次起才是 1ms；
    /// 超过 guo-core 自己的 15min TTL（`nativeCatalogTTL`）后同样回落一次网
    /// 络——新鲜度交给 guo-core 的 TTL，这里不再叠一层过期逻辑。想无视 TTL
    /// 强制刷新，走 [`GuoProvider::catalog_refresh`]。
    ///
    /// 关键词搜索与第 2 页以后**不查缓存**，直接走网络：`cached` 的 `items`
    /// 是逐页 merge 出来的**整份累计剧库**（`saveCatalogCache`），既不是搜
    /// 索结果也不是某一页，当结果返回会整库重复或把整库当成搜索命中。
    /// 目录：缓存优先；**过期但有货的缓存立即返回，后台再刷新（SWR）**。
    ///
    /// `self: Arc<Self>` 是为了把 `Arc` 递进后台刷新任务（`catalog_refresh`
    /// 需要 `&self` 活过本次调用）；调用方手里本来就是 `Arc<GuoProvider>`，
    /// `clone()` 一次即可。
    ///
    /// 这里原来一直写死 `force: true`（后来改成"15min TTL 内读缓存、过期即
    /// 全量网络"），但实测（2026-10-06）还不够：神秘小窝 6 个 18+ 源里 3 个
    /// 已死（野果 25s / 帝果 16s / 黄果 AI 60s 才吐超时），TTL 一过（15 分钟），
    /// 每次打开都要陪死源把重试跑满；失败又不写缓存，10 分钟冷却一过再陪一遍
    /// ——用户看到的"栏目加载非常久"就是这条链。
    ///
    /// 现在的三级：
    /// 1. 缓存新鲜（guo-core 自己的 `fresh`，15min TTL）→ 直接返回；
    /// 2. 缓存过期但**有 items** → 立即返回旧数据（0ms），同时后台起一次
    ///    `force` 刷新为下次预热。死源若已进冷却则连后台刷新都不起（起也是
    ///    0ms 快速失败，白占一个线程）；刷新失败自然落入既有冷却记录；
    /// 3. 完全没缓存 → 才在前台走 [`GuoProvider::catalog_refresh`]（首次
    ///    访问该源的代价，躲不掉，但有分片锁与冷却兜着）。
    ///
    /// 第 2 级刻意**不置 `degraded`**：这个字段在搜索链路里的语义是"来源真的
    /// 挂了"，而"缓存过期"不代表源死了（可能只是 15min TTL 自然过期，后台
    /// 正在刷新）。旧的可见、详情点进去该报错就报错，这是当下最诚实的表达。
    ///
    /// 关键词搜索与第 2 页以后**不查缓存**，直接走网络：`cached` 的 `items`
    /// 是逐页 merge 出来的**整份累计剧库**（`saveCatalogCache`），既不是搜
    /// 索结果也不是某一页，当结果返回会整库重复或把整库当成搜索命中。
    pub fn catalog(self: Arc<Self>, filter: &CatalogFilter) -> Result<CatalogPage, String> {
        let source = filter.source.as_deref().unwrap_or_default();
        if source.is_empty() {
            return Err("缺少站源。".to_string());
        }
        let keyword = filter.keyword.as_deref().unwrap_or_default();
        if filter.page <= 1 && keyword.trim().is_empty() {
            // `cached` 只吃 source + category（go 侧 cached 分支压根不读
            // page/query），所以先按"只列目录"这条路探一次。
            let probe = self.bridge.request(&json!({
                "action": "cached", "source": source,
                "category": self.category_id(source, &filter.category),
            }));
            if let Ok(data) = probe {
                if cached_is_usable(&data) {
                    return Ok(self.map_page(source, &data, filter.page));
                }
                if cached_has_items(&data) {
                    Self::spawn_revalidate(&self, filter.clone());
                    return Ok(self.map_page(source, &data, filter.page));
                }
            }
        }
        self.catalog_refresh(filter)
    }

    /// 后台刷新一份过期缓存（SWR 的 R），给 [`GuoProvider::catalog`] 用。
    ///
    /// 同一 `"源|分类"` 同时只排一个刷新（`revalidating` 去重）——用户在题材
    /// 栏来回点十次不该排十个后台任务。冷却中的源直接跳过：`catalog_refresh`
    /// 会 0ms 快速失败，起了也是白占线程；冷却到期后的下一次 SWR 读自然再排。
    /// 刷新成败都不向前台反馈——前台拿的已经是旧数据，刷新只是为下一次预热；
    /// 失败会由 `catalog_refresh` 自己记进冷却表。
    ///
    /// 写成关联函数而不是方法：`&Arc<Self>` 不是合法的 receiver 形态，而
    /// `catalog` 手里正好是 `Arc`，传引用即可。
    fn spawn_revalidate(me: &Arc<Self>, filter: CatalogFilter) {
        let source = filter.source.clone().unwrap_or_default();
        let key = format!("{source}|{}", filter.category);
        let cooling = me
            .catalog_cooldowns
            .lock()
            .map(|cooldowns| catalog_cooldown_active(&cooldowns, &source))
            .unwrap_or(false);
        if cooling {
            return;
        }
        let claimed = me
            .revalidating
            .lock()
            .map(|mut pending| pending.insert(key.clone()))
            .unwrap_or(false);
        if !claimed {
            return;
        }
        let provider = Arc::clone(me);
        tauri::async_runtime::spawn_blocking(move || {
            let _ = provider.catalog_refresh(&filter);
            // 无论成败都撤在途标记：失败已进冷却，成功则缓存已新鲜，
            // 两条路都允许下一次过期读再排新任务。
            if let Ok(mut pending) = provider.revalidating.lock() {
                pending.remove(&key);
            }
        });
    }

    /// 无视磁盘缓存直接拉一次目录（`force: true`），并让 guo-core 顺手把结果
    /// 写进 `catalogs.json`。`catalog` 的未命中分支与"显式刷新"都走这里。
    ///
    /// 冷却的检查与记录都在这一层（调用方是 [`GuoProvider::catalog`] 的未命中
    /// 分支与 [`GuoProvider::spawn_revalidate`]，main.rs 未单独暴露）：首页、
    /// 翻页、搜索任何一条浏览路径撞上冷却中的死源都 0ms 快速失败，而不是每次
    /// 都陪 guo-core 把 25-60s 的内部重试跑满。
    pub fn catalog_refresh(&self, filter: &CatalogFilter) -> Result<CatalogPage, String> {
        let source = filter.source.as_deref().unwrap_or_default();
        if source.is_empty() {
            return Err("缺少站源。".to_string());
        }
        // 锁毒化只可能发生在持锁 panic 时，此时放行走网络比拒绝服务好。
        if self
            .catalog_cooldowns
            .lock()
            .ok()
            .map(|cooldowns| catalog_cooldown_active(&cooldowns, source))
            .unwrap_or(false)
        {
            return Err("该站源近期不可用，已临时跳过，稍后自动恢复。".to_string());
        }
        let outcome = self.bridge.request(&json!({
            "action": "catalog", "source": source, "category": self.category_id(source, &filter.category),
            "query": filter.keyword, "page": filter.page, "force": true,
        }));
        match outcome {
            Ok(data) => {
                // 站点复活：立刻撤冷却，不等期满。
                self.catalog_cooldowns
                    .lock()
                    .map(|mut cooldowns| {
                        cooldowns.remove(source);
                    })
                    .ok();
                Ok(self.map_page(source, &data, filter.page))
            }
            Err(error) => {
                self.catalog_cooldowns
                    .lock()
                    .map(|mut cooldowns| {
                        cooldowns.insert(source.to_owned(), std::time::Instant::now());
                    })
                    .ok();
                Err(error)
            }
        }
    }

    /// `catalog` 与 `cached` 两条链路的响应归一成同一个 `CatalogPage`。
    /// `total` 一律按本页 `items` 算——guo-core 侧压根没有 total 字段。
    fn map_page(&self, source: &str, data: &Value, requested_page: u32) -> CatalogPage {
        let items: Vec<SeriesItem> = data
            .get("items")
            .and_then(Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .map(|item| self.map_item(source, item))
                    .collect()
            })
            .unwrap_or_default();
        CatalogPage {
            total: items.len(),
            has_more: data
                .get("hasMore")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            page: data
                .get("page")
                .and_then(Value::as_u64)
                .unwrap_or(requested_page as u64) as u32,
            categories: string_list(data, "categories"),
            next_cursor: None,
            source: source.to_owned(),
            items,
            // guo 是单源链路：要么整体 Err，要么这一页就是该源的真实结果，
            // 没有"部分来源失败"可言，degraded 恒为 false。
            degraded: false,
        }
    }

    pub fn categories(&self, source: &str) -> Result<Vec<String>, String> {
        let entries = self.fetch_categories(source)?;
        let mut result = vec!["全部".to_owned()];
        for (_, name) in &entries {
            if !name.is_empty() && !result.contains(name) {
                result.push(name.clone());
            }
        }
        Ok(result)
    }

    /// 把题材栏传回的显示名解析成 guo-core 认的 category。
    ///
    /// - 空 / "全部" → 空串（guo-core 语义上的"不筛选"）；
    /// - 纯数字 → 原样（黄果视频等数字 ID 类源，允许前端将来直接传 ID）；
    /// - 其它 → 查该源分类表的 name 映射；查不到回退空串而不是报错——词表在
    ///   切源瞬间可能残留上一个源的题材，此时"显示全部"比"目录加载失败"好得多。
    fn category_id(&self, source: &str, category: &str) -> String {
        let category = category.trim();
        if category.is_empty() || category == "全部" {
            return String::new();
        }
        if category.chars().all(|character| character.is_ascii_digit()) {
            return category.to_owned();
        }
        self.fetch_categories(source)
            .unwrap_or_default()
            .iter()
            .find(|(_, name)| name == category)
            .map(|(id, _)| id.clone())
            .unwrap_or_default()
    }

    /// 拉取（并缓存）某站源的分类表，三级：内存 `category_index` → guo-core
    /// 磁盘缓存 → 网络。
    ///
    /// 磁盘这一级是实测加的：guo-core 把分类词表和剧库写在同一个
    /// `catalogs.json` 的 `categories[source]` 段里，`force: false` 命中它实测
    /// 0ms、`force: true` 实测 1954ms——分类是静态词表，没有任何理由每次重抓。
    ///
    /// 注意不要在持有 `category_index` 锁时调用 bridge——跨 FFI 的请求可能
    /// 耗时数百毫秒，持锁会卡住所有其它 guo 调用。
    fn fetch_categories(&self, source: &str) -> Result<Vec<(String, String)>, String> {
        if let Ok(cache) = self.category_index.lock() {
            if let Some(entries) = cache.get(source) {
                return Ok(entries.clone());
            }
        }
        // go 侧 `nativeCategories` 在冷缓存时会自己回落网络并把词表写回
        // `catalogs.json`，所以这一发就已经覆盖了首次访问；`force: true` 那层
        // 只在磁盘词表读回来却不可用时兜底。
        let from_disk = self
            .bridge
            .request(&json!({ "action": "categories", "source": source, "force": false }))
            .ok()
            .map(|data| category_entries(&data))
            .filter(|entries| !entries.is_empty());
        let entries = match from_disk {
            Some(entries) => entries,
            None => {
                let data = self
                    .bridge
                    .request(&json!({ "action": "categories", "source": source, "force": true }))?;
                let entries = category_entries(&data);
                if entries.is_empty() {
                    // 不给空结果建缓存：站源抖动一次不该让题材栏永久失效。
                    return Err("站源暂未返回内容分类。".to_string());
                }
                entries
            }
        };
        if let Ok(mut cache) = self.category_index.lock() {
            cache.insert(source.to_owned(), entries.clone());
        }
        Ok(entries)
    }

    /// 取回封面并转成本地缓存文件路径（由 guo-core 带源侧 Referer 下载、解密、
    /// 校验后落盘）。
    ///
    /// 各 guo 源封面的直连在 WebView 里都不可靠：黄果视频有 Cloudflare 防护
    /// （裸 `<img>` 实测 403），部分源封面还是加过密的（AES/XOR，前端拿到密文
    /// 解不出来）。guo-core 的 cover 通道自带源侧 Referer 与浏览器传输层，是
    /// 唯一能稳定拿到图的路。HEIC 封面（WebView2 显示不了）按"无封面"处理。
    pub fn cover(&self, series_id: &str) -> Result<Option<String>, String> {
        let ids = parse_guo_series_id(series_id).ok_or_else(|| "剧集 ID 无效。".to_string())?;
        let data = self.bridge.request(&json!({
            "action": "cover",
            "drama": { "id": format!("{}:{}", ids.source, ids.raw_series_id), "source": ids.source },
            "force": false,
        }))?;
        if data.get("heic").and_then(Value::as_bool) == Some(true) {
            return Ok(None);
        }
        let path = text(&data, &["path"]);
        if path.is_empty() {
            return Ok(None);
        }
        Ok(Some(path))
    }

    pub fn detail(&self, series_id: &str) -> Result<SeriesDetail, String> {
        let ids = parse_guo_series_id(series_id).ok_or_else(|| "剧集 ID 无效。".to_string())?;
        let (drama, chapters) = self.detail_raw(ids.source, ids.raw_series_id)?;
        let episodes = chapters
            .iter()
            .enumerate()
            .map(|(index, chapter)| EpisodeItem {
                id: guo_id(ids.source, &text(chapter, &["id"])),
                series_id: series_id.to_owned(),
                episode_number: number(chapter, &["episodeNumber", "index"]).max(index as u32 + 1),
                title: text(chapter, &["title"]),
                duration_seconds: 0.0,
                preview_url: None,
            })
            .collect::<Vec<_>>();
        Ok(SeriesDetail {
            id: series_id.to_owned(),
            title: text(&drama, &["title", "name"]),
            cover: text(&drama, &["cover", "coverUrl"]),
            item_type: "drama".into(),
            tags: string_list(&drama, "tags"),
            origin: source_name(ids.source).to_owned(),
            episodes_count: number(&drama, &["episodes", "episodeCount", "totalEpisode"])
                .max(episodes.len() as u32),
            description: text(&drama, &["description", "desc", "intro"]),
            episodes,
            available_qualities: data_qualities(&drama),
            sources: vec![crate::models::PlaybackSource {
                id: ids.source.to_owned(),
                name: source_name(ids.source).to_owned(),
                is_primary: true,
                health: "healthy".into(),
                ping_ms: 0,
            }],
        })
    }

    pub fn open_episode(
        &self,
        session_id: u64,
        series_id: &str,
        episode_id: &str,
        quality: &str,
        position: f64,
    ) -> Result<PlaybackSession, String> {
        let ids = parse_guo_series_id(series_id).ok_or_else(|| "剧集 ID 无效。".to_string())?;
        let episode_raw =
            guo_episode_raw(series_id, episode_id).ok_or_else(|| "分集 ID 无效。".to_string())?;
        let (drama, chapters) = self.detail_raw(ids.source, ids.raw_series_id)?;
        let chapter_index = chapters
            .iter()
            .position(|chapter| text(chapter, &["id"]) == episode_raw)
            .ok_or_else(|| "分集不存在或已失效。".to_string())?;
        let chapter = chapters[chapter_index].clone();
        // resolve 的 index 是"第几集"：黄豆等源在章节自身没带集数时靠它推导播放
        // 序号，硬编码 1 会让这些源的所有分集都去请求第 1 集。
        let data = self.resolve(
            drama,
            chapter,
            next_sequence(&self.playback_sequence),
            quality_int(quality),
            chapter_index + 1,
        )?;
        let url = text(&data, &["url"]);
        if url.is_empty() {
            return Err("站源未返回播放地址。".to_string());
        }
        self.sessions
            .lock()
            .map_err(|_| "播放会话锁不可用。".to_string())
            .map(|mut sessions| {
                retain_recent_sessions(&mut sessions, SESSION_HISTORY_LIMIT);
                sessions.insert(
                    session_id,
                    GuoPlayback {
                        session: text(&data, &["session"]),
                    },
                );
            })?;
        Ok(PlaybackSession {
            session_id,
            series_id: series_id.to_owned(),
            episode_id: episode_id.to_owned(),
            position,
            quality: quality.to_owned(),
            stream_kind: Some(stream_kind(&url).to_owned()),
            url,
            backup_url: None,
        })
    }

    pub fn qualities(
        &self,
        series_id: &str,
        episode_id: &str,
    ) -> Result<Vec<VideoQualityOption>, String> {
        let ids = parse_guo_series_id(series_id).ok_or_else(|| "剧集 ID 无效。".to_string())?;
        let episode_raw =
            guo_episode_raw(series_id, episode_id).ok_or_else(|| "分集 ID 无效。".to_string())?;
        let (drama, chapters) = self.detail_raw(ids.source, ids.raw_series_id)?;
        let chapter_index = chapters
            .iter()
            .position(|chapter| text(chapter, &["id"]) == episode_raw)
            .ok_or_else(|| "分集不存在或已失效。".to_string())?;
        let chapter = chapters[chapter_index].clone();
        // 画质探测和起播共用同一个全局序号：写死 1（原来的写法）会被 guo-core
        // 当成"比高水位旧"直接 Cancel——第一次起播就把水位抬到了 ≥100，于是
        // 任意 guo 源从第 2 集起探测恒失败，画质轴整条是死的。
        let data = self.resolve(
            drama,
            chapter,
            next_sequence(&self.playback_sequence),
            0,
            chapter_index + 1,
        )?;
        if let Some(session) = data.get("session").and_then(Value::as_str) {
            let _ = self
                .bridge
                .request(&json!({ "action": "release", "session": session }));
        }
        Ok(data_qualities(&data))
    }

    pub fn release(&self, session_id: u64) {
        if let Ok(mut sessions) = self.sessions.lock() {
            if let Some(playback) = sessions.remove(&session_id) {
                let _ = self
                    .bridge
                    .request(&json!({ "action": "release", "session": playback.session }));
            }
        }
    }

    /// 站源任务/健康度状态（`sourceStatus` → go 侧 `nativeSourceStatus`）。
    ///
    /// 纯内存读（`engine.sourceRecords` / `catalogStates`），不联网也不碰磁盘，
    /// 所以 19 个源逐个查只是 19 次微秒级 FFI。
    pub fn source_status(&self, source: &str) -> Result<Value, String> {
        self.bridge
            .request(&json!({ "action": "sourceStatus", "source": source }))
    }

    /// 19 个源各查一次，顺序与 `GUO_SOURCES` 一致；某个源查不到就带 `error`
    /// 占位，不让整份状态因为一个源缺字段而少一项。
    pub fn source_status_all(&self) -> Vec<Value> {
        GUO_SOURCES
            .iter()
            .map(|source| {
                self.source_status(source.id)
                    .unwrap_or_else(|error| json!({ "source": source.id, "error": error }))
            })
            .collect()
    }

    /// 起一次源健康检查（`sourceJob` + `command: "check"`）。
    ///
    /// **这个 action 是异步起任务、立即返回**：go 侧 `startSourceTask` 登记完
    /// `sourceTasks[source]` 就 `go engine.runSourceTask(...)`，回给调用方的只是
    /// `running: true` / `stage: "准备中"` 的初始状态。结果只能靠再调
    /// [`GuoProvider::source_status`] 取——`checkSource` 每跑完一步就
    /// `publish()` 一次，`health.steps` 是**增量长出来**的，`running` 转 false
    /// 才算终态（判据见 [`source_settled`]）。
    ///
    /// `check` 是五步链路（入口与目录 / 分集目录 / 播放地址与播放列表 / 播放密钥 /
    /// 媒体连接，`playback=true`，`record.Total = 5`）；只探目录的轻量版是
    /// `checkCatalog`（一步）。任务的 ctx 超时 3 分钟。
    pub fn source_check(&self, source: &str) -> Result<Value, String> {
        if !GUO_SOURCES.iter().any(|item| item.id == source) {
            return Err("未知的站源。".to_string());
        }
        self.bridge.request(&json!({
            "action": "sourceJob", "source": source, "command": "check",
        }))
    }

    fn resolve(
        &self,
        drama: Value,
        chapter: Value,
        sequence: u64,
        quality: i32,
        episode_number: usize,
    ) -> Result<Value, String> {
        self.bridge.request(&json!({
            "action": "resolve", "drama": drama, "chapter": chapter, "index": episode_number,
            "quality": quality, "sequence": sequence as i64, "force": true,
        }))
    }

    fn detail_raw(&self, source: &str, raw_series_id: &str) -> Result<(Value, Vec<Value>), String> {
        let data = self.bridge.request(&json!({
            "action": "detail",
            "drama": { "id": format!("{source}:{raw_series_id}"), "source": source },
        }))?;
        let drama = data.get("drama").cloned().unwrap_or(Value::Null);
        let chapters = data
            .get("chapters")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        if drama.is_null() || chapters.is_empty() {
            return Err("该剧暂时没有可播放的分集。".to_string());
        }
        Ok((drama, chapters))
    }

    fn map_item(&self, source: &str, item: &Value) -> SeriesItem {
        let raw = text(item, &["id", "sourceId"]);
        let raw = raw
            .strip_prefix(&format!("{source}:"))
            .unwrap_or(&raw)
            .to_owned();
        SeriesItem {
            id: guo_id(source, &raw),
            title: text(item, &["title", "name"]),
            cover: text(item, &["cover", "coverUrl"]),
            item_type: "drama".into(),
            episodes_count: number(item, &["episodes", "episodeCount", "totalEpisode"]),
            latest_episode_title: None,
            tags: string_list(item, "tags"),
            origin: source_name(source).to_owned(),
            brief: Some(text(item, &["description", "desc", "intro"]))
                .filter(|value| !value.is_empty()),
            // 评分走 `score` / `rating`，量纲 0-10（见 `parse_rating` 的依据）。
            //
            // 实测提醒：`guo-core/core/app_runtime.go` 的 `nativeNormalize` 目前
            // **没有把 `Drama.Score` 复制进 `nativeDrama`**（`nativeDrama` 根本没有
            // Score 字段，只有 `heat`/`views`），所以随包的 0.2.17 DLL 走目录这条路
            // 拿不到任何评分，这里实际恒为 None。留这段解析是为了 guo-core 哪天把
            // Score 透出来时不必再改一遍 TTV 这侧——它已经按 0-10 量纲校准过了。
            rating: parse_rating(item),
        }
    }
}

/// `cached` 的响应能不能当目录结果用。
///
/// 依据是 guo-core 侧的 `nativeCatalogResult`（`guo-core/core/app_runtime.go`，
/// `cached` 分支直接返回它，形状是 `{items, hasMore, page, warning?, localSearch,
/// fresh}`）——**没有 `total` 字段**，`total` 是本文件 `map_page` 按
/// `items.len()` 自己算的，别再去找它。
///
/// 判据只看 `fresh`，因为它是 guo-core 自己给出的"这份缓存可信"结论：
/// `items` 非空 && 无 `warning` && `updatedAt` 非零 && 距上次落盘 < 15min
/// （`nativeCatalogTTL`）。`items` 为空时它必然是 `false`，所以这里不会把
/// "这个源还没缓存过"误判成"这个源没有内容"——那会让每个源的首次访问永久
/// 空白：返回空结果 → 缓存永远不被写 → 下次还是这条空结果。
fn cached_is_usable(data: &Value) -> bool {
    matches!(data.get("items"), Some(Value::Array(_)))
        && data.get("fresh").and_then(Value::as_bool) == Some(true)
}

/// 缓存过期但手里有货——SWR 第 2 级的判据（见 [`GuoProvider::catalog`]）。
///
/// 只要求 `items` 是非空数组：空数组走前台 `catalog_refresh`（`fresh` 为 false
/// 时 `items` 为空必然是"这个源还没缓存过"，不能当"没有内容"返回——那会让
/// 首次访问永久空白，理由见 [`cached_is_usable`] 的注释）。
fn cached_has_items(data: &Value) -> bool {
    data.get("items")
        .and_then(Value::as_array)
        .is_some_and(|items| !items.is_empty())
}

/// guo-core 的 `categories` action 返回 `{"items": [{id, name}, ...]}`。
/// 首项恒为 `{name: "全部"}`（`nativeCategories` 塞的，id 为空）：`categories()`
/// 会去重掉它，`category_id` 也提前拦掉了"全部"，原样带出来即可。
fn category_entries(data: &Value) -> Vec<(String, String)> {
    data.get("items")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .map(|item| (text(item, &["id"]), text(item, &["name"])))
                .filter(|(_, name)| !name.is_empty())
                .collect()
        })
        .unwrap_or_default()
}

/// `sourceStatus` 里的站源任务是否已经落到终态。
///
/// 判据只看 `running` 这一个字段：`startSourceTask` 一登记就是 `true`，
/// `runSourceTask` 的 defer 里无条件写 `Running = false`（成功、失败、取消、
/// 超时都算），所以 `false` 即终态。字段缺失按"已结束"处理——那说明这条记录
/// 压根没在跑（`checkSource` 之外的操作也写这张表）。
pub fn source_settled(status: &Value) -> bool {
    status.get("running").and_then(Value::as_bool) != Some(true)
}

/// 站源评分串 → 0-10 量纲的分。
///
/// 依据全在 guo-core 侧：`provider_huangguo.go` 读
/// `firstNonEmpty(mapString(m,"score"), mapString(m,"rating"))` 之后会补一个
/// "分"后缀（`"9.0"` → `"9.0分"`），`provider_rankings_hongguo.go` 则把
/// `"评分8.5"` 的前缀剥掉；`provider_huangju.go` 明确按 `0 < v <= 10` 过滤，
/// 两边都是 **0-10 量纲**。
///
/// **只认 `score` / `rating`**：`hot_score`、`hot_score_data.score` 是**热度**
/// （`provider_sort_metadata.go` 的 `hongguoHeat`），键名撞车但量纲完全不同，
/// 实测红果热度是 `44456111` 这种整数——认了就会在卡片上渲染成「44456111.0 分」。
/// 量纲对不上（> 10 / 0 / 非数字）一律 None：宁可没有，也不要造分，更不要填 0。
fn parse_rating(item: &Value) -> Option<f64> {
    let cleaned = text(item, &["score", "rating"])
        .trim()
        .trim_start_matches("评分")
        .trim_end_matches('分')
        .trim()
        .to_owned();
    if cleaned.is_empty() {
        return None;
    }
    let value: f64 = cleaned.parse().ok()?;
    (value.is_finite() && value > 0.0 && value <= 10.0).then_some(value)
}

fn data_qualities(value: &Value) -> Vec<VideoQualityOption> {
    value
        .get("qualities")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_i64)
                .filter(|quality| *quality > 0)
                .map(|quality| VideoQualityOption {
                    // label 用大写 P 与红果/动漫链路的档位文案统一（UI 直接展示）；
                    // value 必须是小写 `{digits}p` 字面量，与前端 setQuality 的
                    // 判定及后端解析保持同一种编码。
                    label: format!("{quality}P"),
                    value: format!("{quality}p"),
                    resolution: format!("{quality}P"),
                })
                .collect()
        })
        .unwrap_or_default()
}

fn source_name(source: &str) -> &'static str {
    GUO_SOURCES
        .iter()
        .find(|item| item.id == source)
        .map(|item| item.name)
        .unwrap_or("外部站源")
}

fn find_dll(resource_dir: &Path) -> Result<PathBuf, String> {
    [
        std::env::var_os("TTV_GUO_CORE_DLL").map(PathBuf::from),
        Some(resource_dir.join("guo-core").join("duanju_core.dll")),
        Some(
            resource_dir
                .join("resources")
                .join("guo-core")
                .join("duanju_core.dll"),
        ),
        Some(
            Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("resources")
                .join("guo-core")
                .join("duanju_core.dll"),
        ),
        std::env::current_exe().ok().and_then(|path| {
            path.parent().map(|dir| {
                dir.join("resources")
                    .join("guo-core")
                    .join("duanju_core.dll")
            })
        }),
        std::env::current_exe().ok().and_then(|path| {
            path.parent()
                .map(|dir| dir.join("guo-core").join("duanju_core.dll"))
        }),
    ]
    .into_iter()
    .flatten()
    .find(|path| path.is_file())
    .ok_or_else(|| "没有找到 guo-core 的 duanju_core.dll。".to_string())
}

#[cfg(test)]
mod tests {
    use super::{
        cached_is_usable, category_entries, guo_episode_raw, guo_source_of, next_sequence,
        parse_guo_series_id, parse_rating, retain_recent_sessions, source_is_adult, source_settled,
        stream_kind, GuoPlayback, SEQUENCE_BASE, SESSION_HISTORY_LIMIT,
    };
    use serde_json::{json, Value};
    use std::collections::HashMap;
    use std::sync::atomic::AtomicU64;

    fn playback(session: &str) -> GuoPlayback {
        GuoPlayback {
            session: session.to_owned(),
        }
    }

    /// 18+ 名单与前端 `guoSources.ts` 的 `adult` 字段必须一致。
    ///
    /// 这份名单是**各存一份**的（见 `GuoSource::adult` 的文档注释），所以这条
    /// 测试就是那个"迟早会漂"的护栏：任何一边新增/改动 18+ 源而忘了另一边，
    /// 这里立刻红。六个 18+ 源与十三个常规源是全量断言，不是抽样——加源要同时
    /// 改两处，忘了改这里等于把护栏自己删了。
    #[test]
    fn source_is_adult_matches_the_frontend_list() {
        for source in [
            "huangdou",
            "huangju",
            "yeguo",
            "dsd",
            "huangguoai",
            "huangguo-video",
        ] {
            assert!(
                source_is_adult(source),
                "{source} 在前端 guoSources.ts 里是 adult: true，后端必须同步"
            );
        }
        for source in [
            "hongguo", "yaguo", "maoguo", "fanguo", "guanguo", "heguo", "xingguo", "huaguo",
            "niuguo", "wangguo", "faguo", "piguo", "wuguo",
        ] {
            assert!(
                !source_is_adult(source),
                "{source} 不是 18+ 源，标错会让普通源被门闩误伤"
            );
        }
        // 两条必须同时成立：既没有漏标 18+ 源，也没有把常规源标进去。
        assert_eq!(super::GUO_SOURCES.len(), 19);
    }

    /// 未知 id 与空串都不是 18+ 源（见 `source_is_adult` 的方向性注释）。
    ///
    /// 反向要防的漏法是"认不出就当 18+"：那等于把后端还没登记的新源一律挡住，
    /// 表现为某个新源在上架当天就静默消失，且没有任何日志。
    #[test]
    fn source_is_adult_rejects_unknown_and_empty_ids() {
        for source in [
            "",
            " ",
            "hongguo ",
            "HONGGUO",
            "dsdx",
            "guo:dsd:1",
            "不存在的源",
        ] {
            assert!(
                !source_is_adult(source),
                "未登记的 id {source:?} 不能被当成 18+ 源（会让新源静默消失）"
            );
        }
    }

    /// 从剧集 id 取站源：只有 `guo:<source>:<id>` 才取得到，其余给空串。
    ///
    /// 门闩的判定全靠它——取错了前缀解析，守卫会**静默**放行（`source_is_adult("")`
    /// 恒为 false），所以这几条必须钉死。
    #[test]
    fn guo_source_of_extracts_the_source_or_gives_empty() {
        assert_eq!(guo_source_of("guo:dsd:12345"), "dsd");
        assert_eq!(guo_source_of("guo:huangguo-video:abc"), "huangguo-video");
        // 非 guo id / 结构不全的 guo id 一律空串。
        for series_id in ["", "12345", "dmghg:9999", "guo:", "guo:dsd", "guo::1"] {
            assert_eq!(guo_source_of(series_id), "", "{series_id:?} 不该解析出站源");
        }
    }

    /// guo 的 sequence 是**全局高水位**：≤ 水位即 Cancel，且每发新的都会掐掉上一次
    /// resolve。所以必须严格递增，且永远压过任何前端 session_id。
    ///
    /// 前端会话号从 100 起（不变量 13：主窗口与画中画小窗各持一份、都从 100 起），
    /// 原来的写法正是把它直接当 sequence 传，于是第一次起播就把水位抬到 100，
    /// 画质探测那个写死的 `sequence=1` 从此恒被 Cancel。
    #[test]
    fn playback_sequence_is_monotonic_and_above_every_session_id() {
        let counter = AtomicU64::new(0);
        let first = next_sequence(&counter);
        let second = next_sequence(&counter);
        assert!(
            first < second,
            "sequence 必须严格递增，否则 guo-core 直接 Cancel"
        );
        // 前端 session_id 的量级（100 起，几千）必须永远落在 guo 自己的号之下。
        assert!(first >= SEQUENCE_BASE, "基数要压过任何前端会话号");
        // 画质探测拿到的号（第三次）必须大于此前任何一次起播的号。
        let probe = next_sequence(&counter);
        assert!(probe > first && probe > second);
        // 多取几次也不能倒退，偏移量始终等于已发出的发数。
        let more = next_sequence(&counter);
        assert_eq!(more - probe, 1);
    }

    /// 会话表必须有上界：它原来只增不减（清理走 `playback_command` 的 `stop` 分支，
    /// 而前端零调用点 → 永不执行），会随播放时长一路涨。
    #[test]
    fn retain_recent_sessions_keeps_the_newest_window() {
        let mut sessions = HashMap::new();
        for id in 0..40u64 {
            sessions.insert(id, playback(&format!("s-{id}")));
        }
        retain_recent_sessions(&mut sessions, SESSION_HISTORY_LIMIT);
        assert_eq!(sessions.len(), SESSION_HISTORY_LIMIT);
        assert_eq!(sessions.keys().min().copied(), Some(24));
        assert_eq!(sessions.keys().max().copied(), Some(39));

        // 未超上界时原样不动（不能因为刚起播就把上一集踢掉）。
        let mut small = HashMap::new();
        small.insert(1u64, playback("a"));
        small.insert(2u64, playback("b"));
        retain_recent_sessions(&mut small, SESSION_HISTORY_LIMIT);
        assert_eq!(small.len(), 2);
        // keep = 0 收敛成空表，不能 panic（别用 recent[keep - 1] 那种写法）。
        retain_recent_sessions(&mut small, 0);
        assert!(small.is_empty());
    }

    #[test]
    fn parses_guo_ids_without_losing_raw_episode_key() {
        let ids = parse_guo_series_id("guo:yaguo:51").expect("series id");
        assert_eq!(ids.source, "yaguo");
        assert_eq!(ids.raw_series_id, "51");
        assert_eq!(
            guo_episode_raw("guo:yaguo:51", "guo:yaguo:yaguo:51:1"),
            Some("yaguo:51:1")
        );
    }

    /// `number` 必须兼容 guo-core 的字符串化数字：`episodes: "33"` 是实测目录
    /// 输出的真实形状，读成 0 会灭掉所有 guo 卡片的集数徽标。
    #[test]
    fn number_parses_stringified_digits() {
        let item = json!({ "episodes": "33", "index": " 7 " });
        assert_eq!(super::number(&item, &["episodes", "episodeCount"]), 33);
        // 空串/非数字/缺失都归 0，并继续尝试下一个键。
        let broken = json!({ "episodes": "", "episodeCount": "abc", "totalEpisode": 12 });
        assert_eq!(
            super::number(&broken, &["episodes", "episodeCount", "totalEpisode"]),
            12
        );
        // 原生数字字段照旧直读。
        assert_eq!(super::number(&json!({ "n": 5u64 }), &["n"]), 5);
        assert_eq!(super::number(&json!({}), &["n"]), 0);
    }

    /// 桥接调用锁的分片键：三类入参各取一条路，带不出站源的落全局片（空串）。
    ///
    /// 分片错了不会崩溃但会退化：本该同片互斥的两个 action（如同源的 catalog
    /// 与 cover）落进不同片，就失去了"同源串行"的保守保障。所以三类入参、
    /// 两种 drama id 拼法、空白串全都要钉住。
    #[test]
    fn bridge_lock_key_follows_source_shape() {
        use super::ffi::bridge_lock_key;
        // 顶层 source：catalog / cached / categories / sourceJob。
        assert_eq!(
            bridge_lock_key(&json!({ "action": "catalog", "source": "yeguo" })),
            "yeguo"
        );
        // drama.source：detail / resolve / cover。
        assert_eq!(
            bridge_lock_key(
                &json!({ "action": "detail", "drama": { "id": "dsd:42", "source": "dsd" } })
            ),
            "dsd"
        );
        // 兜底：drama.id 剥前缀（cover 的拼法没有单独的 source 字段时）。
        assert_eq!(
            bridge_lock_key(&json!({ "action": "cover", "drama": { "id": "huangdou:9" } })),
            "huangdou"
        );
        // guo: 前缀的双冒号 id 剥出的键粗一点（"guo"），但**一致**——不会错，只会少并行。
        assert_eq!(
            bridge_lock_key(&json!({ "action": "cover", "drama": { "id": "guo:dsd:42" } })),
            "guo"
        );
        // 空串 / 空白串 / 缺失一律全局片。
        assert_eq!(bridge_lock_key(&json!({ "action": "initialize" })), "");
        assert_eq!(
            bridge_lock_key(&json!({ "action": "catalog", "source": "  " })),
            ""
        );
        assert_eq!(
            bridge_lock_key(&json!({ "action": "release", "session": "s1" })),
            ""
        );
    }

    /// 错误脱敏（不变量 12）：样例全部来自 2026-09-30 真机实测——花果死链把
    /// 内部 CDN 域名拼进错误、野果超时带完整 URL、牛果超时带 IP + 内部路径、
    /// 皮果域名死亡是 Go 双层包装。脱敏后不得出现任何域名/URL/IP/内部路径，
    /// 但 guo-core 自己的人话文案（站名、建议）必须原样保留。
    #[test]
    fn sanitize_guo_error_strips_internal_tokens() {
        let cases = [
            (
                "获取花果播放列表失败：cdn.yddsha2.com HTTP 404",
                "获取花果播放列表失败： 播放文件不存在或已下线",
            ),
            (
                "野果线路暂不可用，请稍后重试\nGet \"https://analyze.buxefaex.cc/\": context deadline exceeded",
                "野果线路暂不可用，请稍后重试\n响应超时",
            ),
            (
                "Get \"http://203.0.113.10:5560/jx/dj.php?[redacted]\": context deadline exceeded",
                "响应超时",
            ),
            (
                "Get \"https://ptt.red/p/66/c/67\": Get \"https://ptt.red/p/66/c/67\": dial tcp: lookup ptt.red: no such host",
                "站点域名无法解析，站点可能已关闭",
            ),
            ("皮果线路已切换，请稍后重试", "皮果线路已切换，请稍后重试"),
        ];
        let token_re = regex::Regex::new(
            r#"(https?://|\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}|[a-z0-9-]+\.(?:com|cc|vip|red|net)\b)"#,
        )
        .unwrap();
        for (raw, expected) in cases {
            let cleaned = super::sanitize_guo_error(raw);
            assert!(
                !token_re.is_match(&cleaned),
                "仍含内部 token: {raw} -> {cleaned}"
            );
            assert_eq!(cleaned, expected, "输入: {raw}");
        }
        // 全部内容都被剥光时退化为通用文案，不返回空串。
        assert!(!super::sanitize_guo_error("https://only.a.url/here").is_empty());
    }

    #[test]
    fn bridge_loads_and_initializes() {
        let resource = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("resources");
        let data = std::env::temp_dir().join("ttv-guo-provider-smoke");
        // 开头先清场：本测试断言的是"首次运行"语义（目录里没有
        // resource-settings.json），上次运行残留会把 first-run 默认值掩盖掉。
        let _ = std::fs::remove_dir_all(&data);
        let provider =
            super::GuoProvider::new(&resource, &data).expect("guo-core DLL should initialize");
        // 全新数据目录（没有 resource-settings.json）必须把 guo 源网络默认成
        // **直连**：guo-core 出厂默认 auto 会读系统代理，而 guo 的 19 个境内
        // CDN 站实测（2026-09-29）对代理出口恒 403——这是"guo 源视频打不开"
        // 的根治点。这条断言同时验证了 first-run 写盘与 settings 回读两条链路。
        assert_eq!(
            provider
                .proxy_mode()
                .expect("proxy mode should be readable"),
            "direct"
        );
        // 设置页开关的往返：direct → auto → direct，读回都要一致；非法档位必须
        // 被拒（这层校验挡住 IPC 上的任意字符串，不让 guo-core 的 validate 兜底）。
        provider.set_proxy_mode("auto").expect("switch to auto");
        assert_eq!(provider.proxy_mode().expect("read back auto"), "auto");
        provider.set_proxy_mode("direct").expect("switch back");
        assert_eq!(provider.proxy_mode().expect("read back direct"), "direct");
        assert!(provider.set_proxy_mode("manual").is_err());
        let _ = std::fs::remove_dir_all(data);
    }

    /// 冷却判定：刚失败 → 拦；过期（约 10min 前失败）→ 放行；没失败的源不受
    /// 别人牵连。过期时刻用 `Instant - 冷却时长` 构造，不需要等待。
    #[test]
    fn catalog_cooldown_blocks_only_recent_failures() {
        use std::time::Instant;
        let mut cooldowns = HashMap::new();
        assert!(!super::catalog_cooldown_active(&cooldowns, "yeguo"));

        cooldowns.insert("yeguo".to_owned(), Instant::now());
        assert!(super::catalog_cooldown_active(&cooldowns, "yeguo"));
        assert!(!super::catalog_cooldown_active(&cooldowns, "maoguo"));

        cooldowns.insert(
            "huangguoai".to_owned(),
            Instant::now() - super::CATALOG_COOLDOWN - std::time::Duration::from_secs(1),
        );
        assert!(!super::catalog_cooldown_active(&cooldowns, "huangguoai"));
    }

    /// 判据只认 guo-core 自己标出来的 `fresh`：`items` 为空（这个源还没缓存过）
    /// 与 items 非空但过了 15min TTL / 带 warning，都必须判为不可用——否则首次
    /// 访问空白、过期缓存永远打不刷新。
    #[test]
    fn cached_is_usable_only_accepts_fresh_disk_pages() {
        assert!(cached_is_usable(&json!({
            "items": [{ "id": "dsd:1", "title": "剧" }],
            "hasMore": true, "page": 1, "localSearch": false, "fresh": true,
        })));
        // 结构完整但 items 为空：guo-core 必然给 fresh=false，不能当结果。
        assert!(!cached_is_usable(&json!({
            "items": [], "hasMore": true, "page": 1, "localSearch": false, "fresh": false,
        })));
        // items 非空但已过 TTL / 带 warning：同样不算数，该回落到网络。
        assert!(!cached_is_usable(&json!({
            "items": [{ "id": "dsd:1", "title": "剧" }],
            "hasMore": true, "page": 1, "warning": "写盘失败", "fresh": false,
        })));
        // cached 自己报错时 data 可能是 null；缺 items / 缺 fresh 都要判为不可用。
        assert!(!cached_is_usable(&Value::Null));
        assert!(!cached_is_usable(&json!({ "error": "内容分类无效" })));
        assert!(!cached_is_usable(
            &json!({ "items": [{ "id": "dsd:1" }], "hasMore": true, "page": 1 })
        ));
    }

    /// `categories` 的 `{"items":[{id,name}]}` 映射：空 name 丢掉；"全部"照常带
    /// 出来，交给 `categories()` 自己（它会先塞一个"全部"再按 name 去重）。
    #[test]
    fn category_entries_drops_nameless_items() {
        let entries = category_entries(&json!({
            "items": [
                { "id": "", "name": "全部" },
                { "id": "ai-duanju", "name": "AI 短剧" },
                { "id": "x", "name": "" },
            ]
        }));
        assert_eq!(
            entries,
            vec![
                (String::new(), "全部".to_owned()),
                ("ai-duanju".to_owned(), "AI 短剧".to_owned()),
            ]
        );
        // 完全没有 items 段时给空表，交给上层走"不给空结果建缓存"那条老路。
        assert!(category_entries(&Value::Null).is_empty());
    }

    #[test]
    fn detects_hls_from_local_asset_path() {
        assert_eq!(stream_kind("http://127.0.0.1:1/token/asset.m3u8"), "hls");
        assert_eq!(stream_kind("http://127.0.0.1:1/token/asset.mp4"), "file");
    }

    /// 评分解析：只认 `score` / `rating`，0-10 量纲。热度（`44456111`，键名来自
    /// `provider_sort_metadata.go` 的 `hongguoHeat`）和越界值一律 None，绝不填 0。
    #[test]
    fn parse_rating_only_accepts_zero_to_ten_scale() {
        assert_eq!(parse_rating(&json!({ "score": "9.0分" })), Some(9.0));
        assert_eq!(parse_rating(&json!({ "rating": "9分" })), Some(9.0));
        assert_eq!(parse_rating(&json!({ "score": "9" })), Some(9.0));
        assert_eq!(parse_rating(&json!({ "score": "评分8.5" })), Some(8.5));
        assert_eq!(parse_rating(&json!({ "score": 8.5 })), Some(8.5));
        assert_eq!(parse_rating(&json!({ "score": "44456111" })), None);
        assert_eq!(parse_rating(&json!({ "score": "87.3" })), None);
        assert_eq!(parse_rating(&json!({ "score": "0" })), None);
        // 热度键即使出现也绝不认。
        assert_eq!(parse_rating(&json!({ "hot_score": "44456111" })), None);
        assert_eq!(parse_rating(&json!({ "title": "剧" })), None);
        assert_eq!(parse_rating(&Value::Null), None);
    }

    /// 站源健康检查是**异步任务**：`sourceJob` 立刻回 `running: true`，结果只能
    /// 靠再查 `sourceStatus` 拿。判据只看这一个字段，别去猜 stage 文案。
    #[test]
    fn source_settled_waits_for_the_task_to_finish() {
        assert!(!source_settled(
            &json!({ "source": "hongguo", "running": true, "stage": "准备中" })
        ));
        assert!(source_settled(
            &json!({ "source": "hongguo", "running": false, "stage": "未完成" })
        ));
        assert!(source_settled(
            &json!({ "source": "hongguo", "stage": "已完成" })
        ));
        assert!(source_settled(&Value::Null));
    }
}
