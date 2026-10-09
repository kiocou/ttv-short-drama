//! 短剧/漫剧的 RTX VSR 兼容播放层。
//!
//! 这里不调用 NVIDIA API。实测（同一段 1920x1080 真实漫剧）是：
//! HEVC 直连或 HEVC + MSE 都不会触发 `ToggleNvidiaVpSuperResolution(on=true)`，
//! 只把编码改成 H.264 后同一 WebView2/同一窗口尺寸稳定触发。
//! 因此本模块的职责只是把源流转成 H.264 分片流，让驱动满足 VSR 的条件。
//!
//! 产物放在 `<data>/short-drama-cache/rtx-vsr/<session>/`，以 2 秒 fMP4
//! 分片边转边播；进程退出、换集或调用 stop 时删除，不把临时 HLS 当永久缓存。
//! 原始 URL 由调用方保存为 `backupUrl`，转码进程失败时仍可回退播放。

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex, OnceLock,
};
use std::time::Duration;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::process::Command;
use tokio::task::JoinHandle;

#[derive(Clone)]
struct ServerInfo {
    port: u16,
    token: String,
}

struct Job {
    done: Arc<AtomicBool>,
    directory: PathBuf,
    task: Option<JoinHandle<()>>,
    ///
    /// 这条会话的产物是否值得**保留**为缓存。
    ///
    /// 红果短剧的整集 HLS 是「按 vid 转一次、之后任意次都能直接播」的产物（实测整集
    /// 转码只要 5.6 秒，但没必要每集都重转），所以它的目录必须跨会话留存；而 guo /
    /// 公开直链那种按 session 建的临时转码目录用完即弃。
    ///
    /// `false` 时 `stop()` 仍然删目录（沿用旧行为）；`true` 时只杀进程、留产物，
    /// 由缓存预算（`evict_channels_to_budget`）负责回收。
    persist: bool,
}

fn server_info() -> &'static OnceLock<ServerInfo> {
    static SERVER: OnceLock<ServerInfo> = OnceLock::new();
    &SERVER
}

fn jobs() -> &'static Mutex<HashMap<u64, Job>> {
    static JOBS: OnceLock<Mutex<HashMap<u64, Job>>> = OnceLock::new();
    JOBS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// 交出地址前最多等多久首段落地。理由见 `start()` 里的等待循环。
const READY_WAIT: Duration = Duration::from_millis(1500);

fn media_root() -> PathBuf {
    crate::short_drama_app::cache_dir().join("rtx-vsr")
}

/// 只处理确实能由 ffmpeg 输入的 http(s) 源。asset/本地文件由红果 worker
/// 直接产出 H.264，不需要在这里二次转码。
pub fn needs_enhancement(url: &str) -> bool {
    url.starts_with("http://") || url.starts_with("https://")
}

/// H.264 视频编码参数：能上硬件就上硬件。
///
/// **为什么这件事对「边转边播」是决定性的**：流式链路的可用性取决于"转码速度
/// 能否跟上播放速度"。CPU 编码（libx264 ultrafast）在 1080p 上要吃掉好几个核，
/// 一旦与整集预取抢起来就会跟不上，播放器随即撞上"分片还没生成"→ 重试耗尽 →
/// 报错。NVENC 把这块负载整体搬到显卡的编码单元，CPU 让出来给解密与下载。
///
/// 实测这台机器（RTX 5060 Laptop）：NVENC 探测约 0.3 秒（每个进程只探一次），
/// 编码 1080p 从 libx264 ultrafast 的 ~1.0 秒/2 秒分段降到 ~0.4 秒。
///
/// 探测失败一律回落 libx264：兼容性优先，VSR 只要求"是 H.264"，不要求谁编的。
/// 码率上限（三档共用）。
///
/// **为什么恒定质量模式还要限码率**：`-cq` / `-crf` 的语义是"给你这个质量，码率
/// 自己想办法"——在源流本身码率很低、画面又简单的短剧上，它会把输出**放到源之上**。
/// 本机实测（同一集、92.7 秒正片）：NVENC cq26 不加上限时输出 **61.3MB**，而这一集
/// 的源流总共只有 10.2MB。补上 `-maxrate` / `-bufsize` 后体积降到 **13.5MB**，
/// 整集转码反而快 243ms（要写盘的字节少了一个数量级），画质仍由 cq26 决定，无可见变化。
///
/// 1100k 的由来：该源平均约 0.9Mbps，留约 20% 余量，快镜头不卡码。
///
/// ⚠️ **已知边界（本轮刻意保留）**：1100k 是按**这一条源**标定的固定值，而三档 × 两条
/// 链路共用它。对码率明显更高的源（高码率档、guo 直链、公开直链），它会把输出硬压到
/// 1100k，表现是"某些集清楚、某些集发糊"。之所以先固定：收益可测、行为可预期；
/// 按源码率自适应（如 `min(源码率 × 1.2, 2500k)`）要先探测输入码率，那是一次
/// 独立改动，本轮不做。
/// 按**源档码率**算码率上限与缓冲窗口（单位 kbps）。
///
/// **为什么不能再用固定值**：上一版是固定 `-maxrate 1100k -bufsize 2200k`，而它是按
/// 单条源（约 0.9Mbps）标定的，源档码率的实际分布很散（实测同一部剧不同集 300kbps
/// ~ 2.5Mbps）。对高于它的源，这等于把 1080p 硬压下去 —— 相对源画质直接掉档：同一段
/// 真人短剧 20 秒、源码率 733kbps，固定 1100k 的 SSIM 只有 **0.9814**，而按源自适应的
/// cq23 + preset p4 是 **0.9917**（体积只多 25%，编码耗时 +24%）。用户看到的"转码后
/// 画质下降很多"就是这个上限造成的。
///
/// 倍率由来（实测标定，源是 H.265）：
///   * H.265 → H.264 同画质经验上要 1.4~1.6× 码率，取 1.4；
///   * 再乘 1.6 给运动与复杂画面的瞬时峰值留余量 ⇒ **2.24×**；
///   * bufsize 取上限的 2 倍（VBV 约束过紧会在快镜头处直接压出块）。
///
/// 实测对照（同一 20 秒片段，SSIM 相对源）：固定 1100k = 0.9814 / 3.5×源码率 ≈ 0.9917 /
/// 2.8×源码率 ≈ 0.9934 / 完全不设上限 ≈ 0.9950 但体积是源的 7.3 倍（8.53MB vs 1.16MB）。
/// 选 2.24× 是"画质接近无损、体积不失控"那一档。
///
/// 取不到源码率时（guo / 公开直链没有档位信息）给一组中性默认：不设上限会被恒定质量
/// 模式放到源的 7 倍，设太紧又会糊，3000k 覆盖 1080p 短剧的常见上限。
pub(crate) fn rate_limits(source_kbps: Option<u32>) -> (u32, u32) {
    let source = match source_kbps {
        Some(value) if value >= 100 => value,
        _ => return (3000, 6000),
    };
    let maxrate = ((source as f64) * 2.24).round() as u32;
    // 下限只用来挡"离谱的小值"（上游码率字段脏数据），**绝不能反过来把低码率源抬高**：
    // 300kbps 的源按 2.24× 是 672k，若下限取 900k，输出就变成源码率的 3 倍 ——
    // 体积膨胀而画质零收益，正是"恒定质量模式把输出放到源之上"在小码率源上复现
    // （审查 R6）。所以再取一次 min(上限, 源码率 × 3)。
    let maxrate = maxrate
        .clamp(150, 8000)
        .min(source.saturating_mul(3).max(150));
    (maxrate, maxrate * 2)
}

/// 把 `rate_limits` 的结果铺成 ffmpeg 参数。给**不经过 `video_encoder_args`** 的
/// 调用点用（`ensure_h264_cache` 的旧缓存迁移、worker 侧经环境变量取同一组值）。
pub(crate) fn rate_lines(source_kbps: Option<u32>) -> Vec<String> {
    let (maxrate, bufsize) = rate_limits(source_kbps);
    vec![
        "-maxrate".to_owned(),
        format!("{maxrate}k"),
        "-bufsize".to_owned(),
        format!("{bufsize}k"),
    ]
}

/// 硬件档参数（NVIDIA NVENC）。
///
/// `-preset p4` + `-cq 23`：上一版是 `p1` + `cq 26`（最快档 + 较低质量目标）。实测同一段
/// 20 秒 1080p 真人短剧（SSIM 相对源、上限都按源档自适应）：`p1 + cq26 + 固定 1100k` 是
/// **0.9814**（1084ms），`p4 + cq23 + 按源自适应` 是 **0.9917**（1345ms）。
/// 编码耗时多 24%，整集仍是 5 秒级（61 秒正片），换来的是肉眼可见的那一档画质。
/// NVENC 的 p1→p4 差距主要在运动估计与码率分配，GPU 上多花的绝对时间远小于 CPU 档位。
///
/// 码率上限**不在这里**：它必须按源档码率算（见 `rate_limits`），由 `video_encoder_args`
/// 追加 —— 固定值就是上一版画质掉档的根因。
const NVENC_ARGS: &[&str] = &[
    "-c:v",
    "h264_nvenc",
    "-preset",
    "p4",
    "-cq",
    "23",
    "-pix_fmt",
    "yuv420p",
    "-profile:v",
    "high",
    "-g",
    "48",
    "-keyint_min",
    "48",
    "-sc_threshold",
    "0",
];

/// 软件档（CPU，核数够）：libx264 **veryfast**。
///
/// ⚠️ 上一版是 `ultrafast`，那是画质最差的档 —— 实测同一 20 秒 1080p 片段：
/// `ultrafast + crf20 + 固定 1100k` 的 SSIM 只有 **0.9431**（比硬件档旧参数还低 0.04，
/// 超快档会牺牲大量运动估计与亚像素精度），而 `veryfast + crf20 + 按源自适应` 是
/// **0.9881**、体积反而更小（2.54MB vs 2.88MB），代价是编码耗时 1489ms → 2276ms（+53%）。
/// 也就是说：这一档以前"又慢又糊"。低配档另有 720p 兜底，这里按画质优先取 veryfast。
///
/// 码率上限同样由 `rate_limits` 按源档算，不写死在这里。
const X264_ARGS: &[&str] = &[
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "20",
    "-tune",
    "zerolatency",
    "-pix_fmt",
    "yuv420p",
    "-profile:v",
    "high",
    "-g",
    "48",
    "-keyint_min",
    "48",
    "-sc_threshold",
    "0",
];

/// 软件档参数：给"要产出一份普通 H.264 mp4"的地方复用（旧缓存迁移那条链路用）。
///
/// **为什么需要暴露它**：`short_drama_app::ensure_h264_cache` 此前自己写了一份 libx264
/// 参数，与本表漂移了——少了 `-profile:v high`、没有码率上限、也没有关键帧约束
/// （libx264 默认 keyint 250 帧）。症状是同一部剧里"迁移出来的老集"与"新解析的集"
/// seek 粒度、体积、首帧时间都不一样，正是 `worker.py` 注释点名的那种极难定位的差异。
/// 参数表只留一份，谁要产 H.264 都从这里取。
pub(crate) fn x264_args() -> &'static [&'static str] {
    X264_ARGS
}

/// 低配档：**降分辨率**，同时只把预设降**一档**（`superfast`）而不是降到最差档。
///
/// 理由（本机实测）：只降码率对 CPU 几乎无帮助 —— 1080p cq26→cq34 只从 5499ms 降到
/// 5429ms；而降到 720p 直接到 4027–4691ms。解码像素数决定解码与编码两个阶段的算术量，
/// 减半分辨率等于把这块砍到四分之一。像素少了一半之后，`superfast` 的速度优势变小、
/// 而画质劣势依然存在，所以预设只从 veryfast 退一档、crf 从 20 放到 22，不再用画质最差
/// 的 ultrafast（那一档实测 SSIM 只有 0.9431，用户直接能看到糊）。
const LOW_TIER_ARGS: &[&str] = &[
    "-c:v",
    "libx264",
    "-preset",
    "superfast",
    "-crf",
    "22",
    "-tune",
    "zerolatency",
    "-vf",
    "scale=-2:720",
    "-pix_fmt",
    "yuv420p",
    "-profile:v",
    "high",
    "-g",
    "48",
    "-keyint_min",
    "48",
    "-sc_threshold",
    "0",
];

/// HLS 打包参数（增强链路与短剧流式链路共用同一套节奏）。
///
/// `-hls_init_time 1`：**只对第一个分片生效**的切分时长目标值。不给它时，首片要等满
/// `-hls_time`（2 秒）才写得出来；给了 1 秒，第一片理论上 1 秒就能交给播放器，之后
/// 恢复 2 秒节奏。
///
/// ⚠️ 实测边界必须写清：**本地源**上首片完成时间 652ms → 465ms；而在**真实网络源**上
/// （15fps、`-g 48` ⇒ 关键帧间隔 3.2 秒）**没有可测出的收益** —— HLS 分片只能从关键帧
/// 开始切，`hls_time` / `hls_init_time` 比 GOP 短时形同虚设，首片仍是 3.2 秒一片。
/// 它是"在 GOP ≤ `hls_time` 的源上才会显形"的改动，本身不带来坏处，所以照留。
///
/// `-hls_list_size 0`：保留全部已生成分片，已转好的部分可自由 seek。
///
/// **这里没有 `-force_key_frames`**：它对 NVENC 无效，对 libx264 是与 `-g` 并行的
/// 第二条规则 —— 详见调用点的长注释。
const HLS_PACKAGING_ARGS: &[&str] = &[
    "-f",
    "hls",
    "-hls_time",
    "2",
    "-hls_init_time",
    "1",
    "-hls_list_size",
    "0",
    "-hls_flags",
    "independent_segments",
    "-hls_segment_type",
    "fmp4",
];

/// 软件档专用的 HLS 打包参数：与上面**只差**一条 `-force_key_frames`。
///
/// **为什么只给软件档**：`-force_key_frames` 只对软件编码器生效，NVENC 不认这个表达式
/// （见调用点的长注释）。没有它时软件档的关键帧只能落在 `-g 48` 上，15fps 源就是 3.2 秒
/// 一片。实测（libx264 ultrafast、同一集、各 3 次取中位，两组只差这一个参数）：
///
/// | 组 | 首片时长 | 首片体积 | 首片完成 | 整集 |
/// |---|---|---|---|---|
/// | 无 force | 3.2 秒 | 0.71MB | 1028ms | 9218ms |
/// | 有 force | **2.0 秒** | **0.53MB** | 958ms | 8277ms |
///
/// 也就是说：首片覆盖时长与 `hls_time` 对齐、体积小 25%（下载更快），而首片完成时间
/// 的差别在噪声内。这条实测推翻了我先前的判断（"删掉它对软件档也无害"）——它确实有用，
/// 只是**对硬件档没用**。
const HLS_PACKAGING_ARGS_X264: &[&str] = &[
    "-f",
    "hls",
    "-hls_time",
    "2",
    "-hls_init_time",
    "1",
    "-hls_list_size",
    "0",
    "-hls_flags",
    "independent_segments",
    "-hls_segment_type",
    "fmp4",
    "-force_key_frames",
    "expr:gte(t,n_forced*2)",
];

/// 按档位选 HLS 打包参数：硬件档不带 `-force_key_frames`（无效参数只会有误导性），
/// 软件两档带上（它真的生效，见 `HLS_PACKAGING_ARGS_X264` 的实测表）。
fn hls_packaging_args(ffmpeg: &std::path::Path) -> &'static [&'static str] {
    if detect_encoder_tier(ffmpeg) == EncoderTier::Hardware {
        HLS_PACKAGING_ARGS
    } else {
        HLS_PACKAGING_ARGS_X264
    }
}

fn video_encoder_args(ffmpeg: &std::path::Path, source_kbps: Option<u32>) -> Vec<String> {
    let tier = detect_encoder_tier(ffmpeg);
    let args = match tier {
        EncoderTier::Hardware => NVENC_ARGS,
        EncoderTier::SoftwareFast => X264_ARGS,
        EncoderTier::SoftwareLow => LOW_TIER_ARGS,
    };
    // 码率上限统一在这里追加（三档共用同一套按源换算），而不是写死进常量 ——
    // 见 `rate_limits` 的实测表：固定值就是上一版画质掉档的根因。
    let mut out: Vec<String> = args.iter().map(|value| (*value).to_owned()).collect();
    out.extend(rate_lines(source_kbps));
    out
}

/// 硬件能力档位。决定用哪一套编码参数与目标分辨率。
///
/// 用户需求：「如果程序遇到配置低的用户，则自适应」。档位不是"猜"出来的，
/// 而是**实测探测**出来的 —— 与 `nvenc_available` 同一套方法论（真跑一次，
/// 而不是读 `-encoders` 列表，那个在缺卡/驱动过旧时照样会列出编码器）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EncoderTier {
    /// 有可用的 NVIDIA 硬件编码：整集 1080p 重编实测约 5.5 秒（92.7 秒正片）。
    Hardware,
    /// 没有硬件编码、但 CPU 核数够（>= 8）：libx264 ultrafast 实测约 11.7 秒。
    SoftwareFast,
    /// 低配机（CPU 核数少）：降到 720p 并要求更低码率，牺牲画质换"能看"。
    SoftwareLow,
}

/// 探测结果落盘文件名（与 NVENC 探测同一套指纹失效机制）。
const TIER_CACHE_FILE: &str = "encoder-tier";

fn tier_cache_path() -> PathBuf {
    crate::short_drama_app::cache_dir().join(TIER_CACHE_FILE)
}

/// 探测结果的**进程内**槽位（与 `nvenc_slot` 同一套做法）。
///
/// 为什么必须有：`detect_encoder_tier` 在热路径上被反复调用（每次开播的
/// `artifact_is_current` → `encoder_fingerprint` → `hls_packaging_args` 各一次，
/// 加上 `video_encoder_args` 自己一次）。只有"落盘缓存"的话，每次都要读一次盘；
/// 而一旦读盘失败或指纹失配，就会退化成**每次开播都真跑一次 ffmpeg 探测**
/// （实测约 1.1 秒）—— 那等于把探测税重新摊回每一集的首屏（审查 R8）。
static TIER_SLOT: OnceLock<std::sync::RwLock<Option<EncoderTier>>> = OnceLock::new();

fn tier_slot() -> &'static std::sync::RwLock<Option<EncoderTier>> {
    TIER_SLOT.get_or_init(|| std::sync::RwLock::new(None))
}

/// 探测本机适合哪一档。**只探测一次**（进程内 + 落盘）。
///
/// 判据与理由：
/// 1. **能上硬件就上硬件**：NVENC 把编码负载整体从 CPU 移走，而 CPU 还要同时
///    做解密与下载 —— 这是本机实测 5.5s vs 11.7s 的差距来源。
/// 2. **没有硬件才看 CPU 核数**：libx264 ultrafast 在 8 核以上实测 11.7 秒
///    （92.7 秒正片，约 8 倍实时），仍然够"边转边播"；核数更少时同步转码会
///    明显跟不上播放进度，此时降分辨率比降码率有效（解码像素数直接减半）。
/// 3. **不确定时取保守档**：探测失败宁可当低配（720p 也能看），也不要让低配
///    用户在"一直转圈"里等。画质差一点是可见的遗憾，卡住不动是体验事故。
pub fn detect_encoder_tier(ffmpeg: &std::path::Path) -> EncoderTier {
    // 0) 进程内已有结论：这是热路径上的第一道（也是绝大多数调用会命中的那道）。
    if let Ok(guard) = tier_slot().read() {
        if let Some(tier) = *guard {
            return tier;
        }
    }
    // 盘上已有结论且指纹匹配：直接读（省掉每次冷启动的探测开销）。
    if let Some(fingerprint) = tier_fingerprint() {
        if let Ok(raw) = std::fs::read_to_string(tier_cache_path()) {
            if let Some((saved, tier)) = raw.trim().split_once(' ') {
                if saved == fingerprint {
                    let parsed = match tier {
                        "hardware" => Some(EncoderTier::Hardware),
                        "software-fast" => Some(EncoderTier::SoftwareFast),
                        "software-low" => Some(EncoderTier::SoftwareLow),
                        _ => None,
                    };
                    if let Some(value) = parsed {
                        crate::trace::log(format!("[vsr] 编码档位：读缓存 = {value:?}"));
                        if let Ok(mut slot) = tier_slot().write() {
                            *slot = Some(value);
                        }
                        return value;
                    }
                }
            }
        }
    }
    let tier = if nvenc_available(ffmpeg) {
        EncoderTier::Hardware
    } else if available_parallelism() >= 8 {
        EncoderTier::SoftwareFast
    } else {
        EncoderTier::SoftwareLow
    };
    crate::trace::log(format!(
        "[vsr] 编码档位探测 = {tier:?}（核数={}）",
        available_parallelism()
    ));
    if let Some(fingerprint) = tier_fingerprint() {
        if let Some(parent) = tier_cache_path().parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let tag = match tier {
            EncoderTier::Hardware => "hardware",
            EncoderTier::SoftwareFast => "software-fast",
            EncoderTier::SoftwareLow => "software-low",
        };
        let _ = std::fs::write(tier_cache_path(), format!("{fingerprint} {tag}"));
    }
    if let Ok(mut slot) = tier_slot().write() {
        *slot = Some(tier);
    }
    tier
}

/// 档位缓存的失效指纹：ffmpeg 身份 + **CPU 核数**。
///
/// 核数必须进指纹：换机器（或虚拟机调核）会改变分档，而 ffmpeg 没变。
fn tier_fingerprint() -> Option<String> {
    let ffmpeg = crate::short_drama_app::ffmpeg_path().ok()?;
    let base = ffmpeg_fingerprint(&ffmpeg)?;
    Some(format!("{base}-cpu{}", available_parallelism()))
}

/// 本机可用并行度。取不到时给一个**偏保守**的默认（4），理由见 `detect_encoder_tier`。
fn available_parallelism() -> usize {
    std::thread::available_parallelism()
        .map(|value| value.get())
        .unwrap_or(4)
}

///
/// **必须真跑一次**，不能读 `-encoders` 列表：编译进去的 h264_nvenc 在没有 N 卡、
/// 驱动过旧或编码会话占满时照样会列出来，只有实际初始化才暴露。
/// 这与 worker 侧 `video_encoder_args` 的做法一致（那边探测尺寸用 640x360，
/// 因为 64x64 会被 NVENC 直接拒、给出假阴性）。
/// 进程内探测结论。
///
/// 用 `RwLock<Option<bool>>` 而不是 `OnceLock<bool>`：后者一旦写入就再也改不了，
/// 于是设置页的「清空缓存」（用户换显卡/更新驱动后表达"重新探测"的唯一入口）
/// 只能删掉盘上的文件，进程内那份旧结论仍然生效 —— 除非重启应用（审查 E1）。
static NVENC_AVAILABLE: OnceLock<std::sync::RwLock<Option<bool>>> = OnceLock::new();

fn nvenc_slot() -> &'static std::sync::RwLock<Option<bool>> {
    NVENC_AVAILABLE.get_or_init(|| std::sync::RwLock::new(None))
}

/// 探测结果落盘的文件名（放在缓存根目录）。
///
/// 为什么落盘：探测本身要起一次 ffmpeg（实测 **1133ms**），而它发生在**首屏路径上**
/// —— 每次进程冷启动后的第一次播放都会付这笔税。日志里那段 15.7 秒首屏中它占 1.1 秒，
/// 而结果在同一台机器上不会变（显卡与驱动都不动）。落盘之后只有"第一次安装后首播"
/// 才探测，此后直接读文件。
///
/// 失效条件写清：换显卡、换驱动、升级 ffmpeg 都应重新探测。这里用 ffmpeg 的**文件大小
/// 与 mtime** 做指纹——它是随包资源，升级必然变；显卡/驱动变化本应用无法可靠感知，
/// 用户可以用设置页的"清空缓存"强制重探（`cache_clear` 会连带清掉这个文件）。
const NVENC_CACHE_FILE: &str = "h264-nvenc-capability";

fn nvenc_cache_path() -> PathBuf {
    crate::short_drama_app::cache_dir().join(NVENC_CACHE_FILE)
}

/// 读落盘的探测结论。返回 `None` 表示没有可用记录（需重新探测）。
fn read_nvenc_cache(ffmpeg: &std::path::Path) -> Option<bool> {
    let fingerprint = ffmpeg_fingerprint(ffmpeg)?;
    let raw = std::fs::read_to_string(nvenc_cache_path()).ok()?;
    // 格式：`<指纹> <0|1>`。指纹不匹配即视为失效。
    let (saved, verdict) = raw.trim().split_once(' ')?;
    if saved != fingerprint {
        return None;
    }
    Some(verdict.trim() == "1")
}

fn write_nvenc_cache(ffmpeg: &std::path::Path, available: bool) {
    let Some(fingerprint) = ffmpeg_fingerprint(ffmpeg) else {
        return;
    };
    let path = nvenc_cache_path();
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let _ = std::fs::write(
        path,
        format!("{fingerprint} {}", if available { 1 } else { 0 }),
    );
}

/// ffmpeg 的身份指纹：大小 + mtime 秒。升级随包 ffmpeg 必然改变其中一个。
fn ffmpeg_fingerprint(ffmpeg: &std::path::Path) -> Option<String> {
    let meta = std::fs::metadata(ffmpeg).ok()?;
    let mtime = meta
        .modified()
        .ok()
        .and_then(|time| time.duration_since(std::time::SystemTime::UNIX_EPOCH).ok())
        .map(|delta| delta.as_secs())
        .unwrap_or(0);
    Some(format!("{}-{}", meta.len(), mtime))
}

fn nvenc_available(ffmpeg: &std::path::Path) -> bool {
    // 命中进程内结论直接返回（这是热路径：每次开播都会问一次）。
    if let Ok(guard) = nvenc_slot().read() {
        if let Some(value) = *guard {
            return value;
        }
    }
    let verdict = {
        // 先读落盘结论：命中就完全不付探测成本（省 1133ms 首屏税）。
        if let Some(cached) = read_nvenc_cache(ffmpeg) {
            crate::trace::log(format!(
                "[vsr] 硬件编码：读缓存 = {}",
                if cached { "可用" } else { "不可用" }
            ));
            cached
        } else {
            let probe = std::process::Command::new(ffmpeg)
                .args([
                    "-hide_banner",
                    "-loglevel",
                    "error",
                    "-f",
                    "lavfi",
                    "-i",
                    "color=black:s=640x360",
                    "-frames:v",
                    "2",
                    "-an",
                    "-c:v",
                    "h264_nvenc",
                    "-preset",
                    "p1",
                    "-cq",
                    "26",
                    "-pix_fmt",
                    "yuv420p",
                    "-profile:v",
                    "high",
                    "-f",
                    "null",
                    "-",
                ])
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .status();
            let ok = probe.map(|status| status.success()).unwrap_or(false);
            crate::trace::log(format!(
                "[vsr] 硬件编码探测：h264_nvenc={}",
                if ok {
                    "可用"
                } else {
                    "不可用，回落 libx264"
                }
            ));
            // 落盘：下次冷启动直接读，不再付这 1133ms。
            write_nvenc_cache(ffmpeg, ok);
            ok
        }
    };
    // 写回进程内槽位。用 `write()` 而不是 `get_or_init`：清缓存时会把槽位置回
    // `None`，此时才可能真正重探（审查 E1）。
    if let Ok(mut guard) = nvenc_slot().write() {
        *guard = Some(verdict);
    }
    verdict
}

/// 产物参数指纹文件名：写在 HLS 目录里，用来判断"这份产物是哪套编码参数转出来的"。
///
/// **为什么必须有它**：目录缓存是按 vid 长期复用的（看到 `#EXT-X-ENDLIST` 就直接播），
/// 而参数会随版本调整（2026-10-09 就把固定 1100k 改成按源自适应、预设从 p1 提到 p4）。
/// 没有指纹的话，升级后看到的是**旧参数转出来的旧产物** —— 修复对老集完全不生效，
/// 用户只会觉得"别人的画质变好了、我这几集还是糊的"。
const ENCODER_STAMP_FILE: &str = ".encoder-stamp";

/// 当前编码参数指纹：换算公式版本 + 三档编码参数 + HLS 打包参数。
///
/// 刻意用**可读文本**而不是哈希：排查时可以直接打开产物目录里的这个文件，看到
/// "这一集是按什么参数转出来的"。改了任何影响画面的参数（含 `rate_limits` 的倍数，
/// 所以要同时改 `rate=` 那一段的版本号），指纹就会变、旧产物自动重转。
fn encoder_fingerprint(ffmpeg: &std::path::Path) -> String {
    let mut parts: Vec<String> = vec!["rate=v2:2.24x".to_owned()];
    for args in [NVENC_ARGS, X264_ARGS, LOW_TIER_ARGS] {
        parts.push(args.join(" "));
    }
    parts.push(hls_packaging_args(ffmpeg).join(" "));
    parts.join(" | ")
}

/// 目录里的产物是不是**当前参数**转出来的。
///
/// 没有指纹文件的一律算过期：那是上一版留下的产物，重转一次的代价（几秒）远小于
/// 让用户继续看糊掉的画面。
fn artifact_is_current(directory: &std::path::Path) -> bool {
    let Ok(ffmpeg) = crate::short_drama_app::ffmpeg_path() else {
        return true;
    };
    match std::fs::read_to_string(directory.join(ENCODER_STAMP_FILE)) {
        Ok(saved) => saved.trim() == encoder_fingerprint(&ffmpeg).trim(),
        Err(_) => false,
    }
}

/// 启动一条 H.264 HLS 增强流。源流失败时返回 Err，调用方继续用原 URL。
pub async fn start(session_id: u64, source_url: &str) -> Result<String, String> {
    // 这条链路（guo / 公开直链）拿不到档位信息，源码率交给 `rate_limits` 的默认值。
    start_with_key(session_id, source_url, None, None).await
}

/// 红果短剧：按 **vid** 建持久缓存目录的整集 HLS。
///
/// 与 `start_with_key` 的区别只有生命周期，但它正是方案 B 成立的关键：
///   - 目录名是 `vid-<vid>` 而不是 `session-<id>`，**同一集无论打开多少次都是同一份产物**；
///   - 任务标记 `persist = true`，换集 `stop()` 不会删目录；
///   - 产物已完整（含 `#EXT-X-ENDLIST`）时**直接返回地址，连 ffmpeg 都不起**。
///
/// 实测依据：整集转码 5.6 秒（92.7 秒正片，16 倍实时）。转一次之后二次打开的代价应当是
/// 零 —— 起进程、起转码、等首片全部省掉。
pub async fn start_video_cache(
    session_id: u64,
    vid: &str,
    source_url: &str,
    key_hex: Option<&str>,
    source_kbps: Option<u32>,
) -> Result<String, String> {
    let directory = media_root().join(format!("vid-{vid}"));
    let playlist = directory.join("index.m3u8");
    // 1) 已完成（ENDLIST）的产物直接复用：这是「同一集第二次打开」的快路径。
    //
    // ⚠️ 但必须**先验参数指纹**：产物是按 vid 长期留存的，而编码参数会随版本变化，
    // 直接复用等于让用户继续看旧参数（更糊）的画面 —— 见 `ENCODER_STAMP_FILE`。
    // 指纹不符就把整个目录删掉重转（只删已完成、没有 ffmpeg 在写的那一份）。
    if directory.is_dir()
        && directory_of_inflight_vid(&directory).is_none()
        && !artifact_is_current(&directory)
    {
        crate::trace::log(format!("[vsr] 产物是旧编码参数转的，丢弃重转 vid={vid}"));
        let _ = std::fs::remove_dir_all(&directory);
    }
    if let Ok(body) = std::fs::read_to_string(&playlist) {
        if body.contains("#EXT-X-ENDLIST") && directory.join("init.mp4").is_file() {
            let info = ensure_server().await?;
            let url = format!(
                "http://127.0.0.1:{}/rtx/{}/index.m3u8?token={}",
                info.port, session_id, info.token
            );
            // 复用目录必须重新挂进 jobs 表：本地服务是按 session 找目录的，
            // 而这次会话是新的（新的 session_id），表里没有它的映射。
            register_reused(session_id, directory.clone());
            crate::trace::log(format!(
                "[vsr] 复用已转好的整集 HLS 会话={session_id} vid={vid}（未起转码）"
            ));
            return Ok(url);
        }
    }
    // 1b) **同一 vid 正在转码中**：不能再起第二个 ffmpeg 往同一个目录里写。
    //
    // 为什么这条必须有：目录现在按 vid 固定（不再按 session 唯一），于是「转码还没
    // 结束，用户又打开同一集」（切走再切回、连播回退、画中画交接）会让第二次调用
    // 也走到下面的 `start_in_directory` —— 两个 ffmpeg 同时写 `index.m3u8` 与
    // `seg-*.m4s`，产物必然损坏（截断的清单 + 交错的分片），而症状是"画面花掉/播一半停"。
    //
    // 处置：把正在转的那条会话的目录**挂到本次会话号上**，共用同一次转码。
    if let Some(existing) = directory_of_inflight_vid(&directory) {
        let info = ensure_server().await?;
        let url = format!(
            "http://127.0.0.1:{}/rtx/{}/index.m3u8?token={}",
            info.port, session_id, info.token
        );
        register_reused(session_id, existing);
        crate::trace::log(format!(
            "[vsr] 同一 vid 正在转码，共用产物 会话={session_id} vid={vid}"
        ));
        return Ok(url);
    }
    // 2) 没有可用产物：正常起转码，但目录按 vid 固定、且不清空旧内容。
    start_in_directory(
        session_id,
        source_url,
        key_hex,
        directory,
        true,
        source_kbps,
    )
    .await
}

/// 若某个**正在转码**的任务用的正是这个目录，返回那份目录。
///
/// `done == false` 说明它的 ffmpeg 还没退出（也就是还在写分片）。
fn directory_of_inflight_vid(directory: &std::path::Path) -> Option<PathBuf> {
    let guard = jobs().lock().ok()?;
    guard
        .values()
        .find(|job| job.directory == directory && !job.done.load(Ordering::Acquire))
        .map(|job| job.directory.clone())
}

/// 把一个**已存在**的产物目录重新挂进任务表，让本地服务能按新会话号找到它。
///
/// 不需要真进程：`done` 直接置位（表示"没有正在跑的转码"），`task` 为 None。
fn register_reused(session_id: u64, directory: PathBuf) {
    let done = Arc::new(AtomicBool::new(true));
    if let Ok(mut guard) = jobs().lock() {
        // ⚠️ 同号已有任务时，先看它是不是"正在给我自己转"。
        //
        // 同号重入是**常态**，不是异常：前端首播失败后会带着同一个 sessionId 重试
        // （700ms 自动重试、CDN 失败后的本地解析兜底都用那个号），而上面的 1b 分支
        // 会把这份**正在转**的目录挂到同一个号上。若这里无条件 abort，等于杀掉自己
        // 正在写产物的 ffmpeg —— 产物永远等不到 `#EXT-X-ENDLIST`，播放器播到已生成
        // 分片的末尾就 stall（用户看到"播一半卡死"），而且没有任何路径会补转（审查 R1）。
        let same_inflight = guard
            .get(&session_id)
            .map(|previous| {
                previous.directory == directory && !previous.done.load(Ordering::Acquire)
            })
            .unwrap_or(false);
        if same_inflight {
            crate::trace::log(format!(
                "[vsr] 会话号重入同一份在途转码，保持原任务 会话={session_id}"
            ));
            return;
        }
        // 其余情况（同号但换了目录、或旧任务已结束）照旧收掉。
        if let Some(previous) = guard.remove(&session_id) {
            if let Some(task) = previous.task {
                task.abort();
            }
        }
        guard.insert(
            session_id,
            Job {
                done,
                directory,
                task: None,
                persist: true,
            },
        );
    }
}

/// 与 `start` 相同，但可带**解密密钥**。
///
/// 红果的源是 CENC 加密的（`1:encrypt`），ffmpeg 需要 `-decryption_key` 才能读出
/// 画面。加上这个参数之后，这条链路对红果也成立了 —— 而它带来的收益比 guo/直链
/// 那条大得多：
///
/// 红果原先必须把整集下载+解密+转存成本地 mp4 才能播（实测 6.6–22.3 秒），
/// 而改成「解密密钥 + 边解密边转 H.264 HLS」之后，**首片实测 1126ms 就落地**
/// （含 API 往返的总首屏 3.3 秒）。这就是「先把画面出来、播放的同时再加载」。
///
/// `key_hex` 是 16 字节 AES-128 密钥的十六进制串；`None` 表示源未加密。
///
/// `source_kbps` 是**选中档的源码率**（kbps），用来按源算码率上限（见 `rate_limits`）；
/// 拿不到就传 `None`，会退回一组中性默认值。
pub async fn start_with_key(
    session_id: u64,
    source_url: &str,
    key_hex: Option<&str>,
    source_kbps: Option<u32>,
) -> Result<String, String> {
    if source_url.trim().is_empty() || !needs_enhancement(source_url) {
        return Err("源流地址不支持增强转码。".to_owned());
    }
    // 每次会话一个临时目录（用完即弃），与红果的按 vid 持久目录相对。
    let directory = media_root().join(format!("{session_id}-{}", uuid::Uuid::new_v4().simple()));
    start_in_directory(
        session_id,
        source_url,
        key_hex,
        directory,
        false,
        source_kbps,
    )
    .await
}

/// 转码主体：`start_with_key`（临时目录）与 `start_video_cache`（按 vid 持久目录）共用。
async fn start_in_directory(
    session_id: u64,
    source_url: &str,
    key_hex: Option<&str>,
    directory: PathBuf,
    persist: bool,
    source_kbps: Option<u32>,
) -> Result<String, String> {
    if source_url.trim().is_empty() || !needs_enhancement(source_url) {
        return Err("源流地址不支持增强转码。".to_owned());
    }
    // ⚠️ 清理与淘汰**必须排在 `ensure_server().await` 之后**。
    //
    // 历史坑：旧实现把 `stop(session_id)` 与"上限 8 淘汰"放在这个 await 之前，
    // 而 Job 是等全部准备做完才 insert 进表（见本函数末尾）。于是同一个 session_id
    // 并发 start 时（预取与前台换集几乎同时发生）：A 先过了清理、在 await 上让出；
    // B 也过清理（表里此刻还没有 A）、也过了 await，随后 B 的 insert **覆盖** A 的 Job
    // —— A 的 JoinHandle 被直接丢弃，既不会被 abort 也不会被淘汰，那条 ffmpeg 长进程
    // 与它整个会话目录双双泄漏（用户连续点选可以堆到十几路）。
    //
    // 现在改为：await 之后再清理，并且末尾 insert 时若发现同 id 已存在，
    // 就地 abort 旧任务并删掉旧目录。
    let info = ensure_server().await?;
    stop(session_id);
    // 预取可能同时准备多条 guo 会话；限制任务数，避免用户连续点选后留下十几路 ffmpeg。
    while jobs().lock().map(|guard| guard.len()).unwrap_or(0) >= 8 {
        // 淘汰只能挑**非持久**任务：持久目录是可复用缓存，掐掉正在转的那一路
        // 会连同它的产物一起失效（下次还得重转）。
        let victim = jobs().lock().ok().and_then(|guard| {
            guard
                .iter()
                .filter(|(_, job)| !job.persist)
                .map(|(id, _)| *id)
                .min()
        });
        match victim {
            Some(id) => stop(id),
            None => break,
        }
    }

    // 持久目录要**保留已有产物**：重转时只覆盖分片与清单，不整目录清空，
    // 这样「转了一半就被打断」的那次留下的分片仍可能被复用。
    if !persist {
        let _ = std::fs::remove_dir_all(&directory);
    }
    std::fs::create_dir_all(&directory)
        .map_err(|error| format!("创建增强缓存目录失败：{error}"))?;

    let ffmpeg = crate::short_drama_app::ffmpeg_path()?;
    let playlist = directory.join("index.m3u8");
    // 落一枚参数指纹：持久目录（`vid-{vid}`）会被长期复用，而编码参数随版本变化，
    // 复用前必须先比对它 —— 否则升级后用户看到的是旧参数转出来的旧产物（见
    // `ENCODER_STAMP_FILE` 的说明）。写在起转码之前，于是"转了一半"的目录也带指纹。
    let _ = std::fs::write(
        directory.join(ENCODER_STAMP_FILE),
        encoder_fingerprint(&ffmpeg),
    );
    // 记下"转码这一段"的起点。整条首开时间线 = 解析(worker) + 等待就绪(这里)
    // + 播放器拉清单/首片，三者混在一个"很慢"里没法优化，所以每段各自落一行。
    crate::trace::log(format!(
        "[vsr] start 会话={session_id} 源={} ffmpeg={}",
        crate::trace::redact_url(source_url),
        ffmpeg.display()
    ));
    let mut command = Command::new(&ffmpeg);
    // 解密密钥是**输入**选项，必须排在 `-i` 之前（与 -tls_verify 同一条规则：
    // 写到 -i 之后会被解析到输出侧，而输出是 HLS 分片、没有解密封装器，等于被忽略，
    // 结果是 ffmpeg 拿到密文解不出画面）。
    if let Some(key) = key_hex.map(str::trim).filter(|value| !value.is_empty()) {
        command.arg("-decryption_key").arg(key);
    }
    // 关键：把 ffmpeg 的工作目录钉死在本次会话目录上。
    //
    // fMP4 的 init 段（`init.mp4`）在 ffmpeg 里是按**相对文件名**写出的，而
    // `-hls_segment_filename` 我们传的是绝对路径 —— 于是只有分片落对了地方，
    // init.mp4 会悄悄掉到**父进程的当前工作目录**（实测：会直接掉在工程根
    // 目录/桌面），会话目录里永远没有它。
    //
    // 后果正好对应用户的两条反馈：
    //   1) `ready()` 要求 index.m3u8 与 init.mp4 同时存在 → 恒为 false →
    //      start() 每次都会死等满 READY_WAIT(1500ms) 才把地址交出去。这就是
    //      "首次打开一直在加载"里后端按住的那一段。
    //   2) 就算地址交给了播放器，`#EXT-X-MAP:URI="init.mp4"` 的请求会 404
    //      （本地服务去会话目录里找它，找不到），hls.js 只能反复重试首片 →
    //      用户看到的就是"一直转圈、加载很长时间"。
    //
    // 实测四种组合：
    //   不传 init 名 + cwd=工程根   → 目录内 init=False（掉到 cwd）
    //   传相对名 init.mp4 + cwd=根  → 目录内 init=False（照样掉到 cwd）
    //   **cwd=会话目录**            → 目录内 init=True ✅
    //   传绝对路径 init + cwd=根     → ffmpeg 直接失败
    //     Failed to open segment '<abs>/init.mp4'
    // 所以唯一稳的组合就是「相对名 + current_dir(会话目录)」。
    command
        .current_dir(&directory)
        .arg("-y")
        .arg("-hide_banner")
        .arg("-loglevel")
        .arg("error")
        // 输入探测参数（必须是输入选项，所以排在 `-i` **之前**）。
        //
        // ffmpeg 默认 probesize=5,000,000、analyzeduration=5,000,000，也就是说它
        // 会先尽量读满 5MB / 5 秒的源数据才决定"这是什么流、第一帧从哪开始"——
        // 对网络输入这就是纯粹的**白等**：源要先下载几 MB 才可能开始转码。
        // 本链路要处理的只是「一条 H.264/HEVC 视频 + 一条 AAC 音频」这种最普通的
        // mp4/HLS，1MB / 2 秒足够识别，第一帧不必等整段探测。
        //
        // 这是「首次打开要等很久」在转码侧的直接来源之一，且完全无副作用：
        // 探测不足时 ffmpeg 只会退化成"边播边补"，不会失败。
        .arg("-probesize")
        .arg("1000000")
        .arg("-analyzeduration")
        .arg("2000000")
        // `-tls_verify 0` 与 `-rw_timeout` 必须和 `-probesize` 一样排在 `-i`
        // **之前**——它们是 ffmpeg 的**输入**选项，写到 `-i` 之后会被解析到
        // 输出侧（而这条命令的输出是 HLS 分片，没有网络输出流，等于被整个
        // 忽略），输入于是仍走默认证书校验。
        //
        // 随包 ffmpeg 没有 CA 证书链，后果是打开 https 源必然失败：
        //   error:0A000086:lib(20)::reason(134)
        //   Error opening input: I/O error
        // 实测对照（同一条真实 CDN 地址）：
        //   写在 `-i` 之后 → 115ms 失败；写在 `-i` 之前 → 704ms 成功出片。
        //
        // 这条链路上它意味着**增强转码从来没有成功打开过源**：每次播放都在
        // 极短时间内失败退出、上层静默回退原流。表现正是用户报的两条——
        // 开关怎么拨都一样（因为开关开时走的那条路本身就是坏的），以及
        // 「首次打开一直在加载」。
        .arg("-tls_verify")
        .arg("0")
        .arg("-rw_timeout")
        .arg("60000000")
        .arg("-i")
        .arg(source_url)
        .arg("-map")
        .arg("0:v:0")
        .arg("-map")
        .arg("0:a:0?")
        .args(video_encoder_args(&ffmpeg, source_kbps))
        .arg("-c:a")
        .arg("aac")
        .arg("-b:a")
        .arg("128k")
        // ⚠️ 关键帧间隔必须用**编码器自己的** GOP 参数，不能用 `-force_key_frames`。
        //
        // 实测（同一集、同一条真实加密源，五组对照）：
        //   现状 hls_time=2 + force_key_frames  →  分片 **8.33 秒** × 12 个，首片 4.6MB
        //   + -g48 -keyint_min 48 -sc_threshold 0 →  分片 **3.20 秒** × 46 个，首片 1.8MB
        //   两者整集转码耗时几乎相同（5320ms vs 5412ms）
        //
        // 原因是 `-force_key_frames` 只对软件编码器生效，**NVENC 不认这个表达式**；
        // 于是分片边界只能落在源流自带的关键帧上，而源是 8.33 秒一个关键帧。
        // 用户看到的「前 8 秒转换」正是这个：首片要等满一个 8.33 秒的 GOP 才写得出，
        // 而 hls_time=2 在这里形同虚设（HLS 分片只能比 GOP 长，不能比它短）。
        //
        // 收到 3.2 秒之后：首片体积 4.6→1.8MB（用户更早看到画面）、拖动粒度更细。
        //
        // 2026-10-09：**`-force_key_frames` 已删除**（`HLS_PACKAGING_ARGS` 里也没有）。
        // 上面那次实测已经证明它对 NVENC 无效（不删也撑不出 2 秒分片）。删它的另一个
        // 理由是它对 libx264 是**第二条**规则：硬编码的 2.0 秒与 `-g 48` 在不同帧率下
        // 并不重合（24fps 源是 2.0 秒、15fps 源是 3.2 秒），两者取并集＝比配置更密的关键帧。
        //
        // ⚠️ 但**"关键帧节奏只有一处权威"只对软件档成立**：`-keyint_min` 与
        // `-sc_threshold` 对 `h264_nvenc` 是死参数（随包 ffmpeg 会直接报
        // `Codec AVOption sc_threshold has not been used for any stream`），硬件档真正
        // 生效的只有 `-g 48`，外加 NVENC 自己在场景切换处插的 I 帧。实测"首片 3.2 秒、
        // 分片中位 1.6 秒、46 段"就是 `-g` 与这些场景切换点取并集的结果——对用户是好事
        // （分片更短、seek 更细），所以**刻意不去关掉场景切换插帧**（`-no-scenecut 1`
        // 只在 `-rc-lookahead > 0` 时才可用，且关了会让分片统一变回 3.2 秒）。
        //
        // 三档自己那份参数里已经含这套 GOP 设置，这里**不再重复追加**（重复会让"只改一处
        // 就漂移"变成静默失败：命令行里出现两遍同值参数，单测也看不见）。
        //
        // `-force_key_frames` 的取舍按档位分开：软件档需要它（实测首片 3.2→2.0 秒、
        // 首片体积 -25%），硬件档不需要（NVENC 不认这个表达式）。两个常量各自的注释里有
        // 完整的实测表。
        .args(hls_packaging_args(&ffmpeg))
        // 刻意**不传** `-hls_fmp4_init_filename`。
        //
        // 传绝对路径（`directory.join("init.mp4")`；正斜杠、反斜杠、预创建空文件，
        // 三种都试过）会让随包 ffmpeg 直接以 EACCES 失败：
        //   Failed to open segment '<abs>/init.mp4'  →  Permission denied
        // 结果是**播放列表永远生成不出来**。也就是说这条增强链路从上线起就没生效过：
        // 每次播放都在 ~0.4 秒内挂掉、`job_alive` 转 false、上层静默回退原流——
        // 快得连"卡"都看不出来，所以一直没人发现 guo / 公开直链上根本没有 VSR。
        //
        // 实测对照（`-t 6` 本地片）：不传该参数时 init.mp4 会正确落在播放列表同级
        // 目录，且播放列表里写的就是相对路径 `#EXT-X-MAP:URI="init.mp4"` —— 正好
        // 配合下面本地服务把 token 补回每条分片的重写逻辑。
        .arg("-hls_segment_filename")
        .arg(directory.join("seg-%05d.m4s"))
        .arg(&playlist)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    #[cfg(windows)]
    command.creation_flags(0x0800_0000);

    let child = command
        .spawn()
        .map_err(|error| format!("启动增强转码失败：{error}"))?;
    let done = Arc::new(AtomicBool::new(false));
    let task_done = Arc::clone(&done);
    let task = tokio::spawn(async move {
        let output = child.wait_with_output().await;
        if let Ok(output) = output {
            if !output.status.success() {
                // 原来这里只 eprintln!：双击启动（windows 子系统）时是黑洞，
                // 转码到底为什么退出没人看得到。改走日志通道。
                let stderr = String::from_utf8_lossy(&output.stderr);
                let trimmed = stderr.trim();
                crate::trace::log(format!(
                    "[vsr] 转码进程退出 会话={session_id} 状态={} stderr={}",
                    output.status,
                    trimmed.chars().take(300).collect::<String>()
                ));
            }
        }
        // 正常播放结束或异常退出都保留到本次会话清理，避免末尾分片刚写完就被删。
        task_done.store(true, Ordering::Release);
    });

    // 插入即替换：同 id 已经在表里说明有另一路 start 抢进了同一会话（两者都在
    // `ensure_server().await` 上让出过，清理那一步谁都还没入表）。这里必须把被替换
    // 掉的那一路**就地收掉**——abort 它的转码任务（`child` 带 kill_on_drop，abort
    // 会连带杀掉 ffmpeg）并删掉它的会话目录。不这么做，被覆盖的 JoinHandle 就再也
    // 没有引用，进程与目录一起泄漏。
    let replaced = jobs()
        .lock()
        .map_err(|_| "增强任务表锁不可用。".to_string())?
        .insert(
            session_id,
            Job {
                done,
                directory: directory.clone(),
                task: Some(task),
                persist,
            },
        );
    if let Some(previous) = replaced {
        if let Some(task) = previous.task {
            task.abort();
        }
        // ⚠️ 这里**不能**无条件删目录。
        //
        // 被替换的那份可能正是 `vid-{vid}` 持久目录，而它可能同时被别的会话
        // 用着（`register_reused` 会把同一目录挂到多个会话号上）。旧实现无条件
        // `remove_dir_all`，于是「同一集并发两次 start」会把另一会话正在播的
        // 产物从盘上抽走 —— 表现为播到一半分片全 404（审查 R1）。
        //
        // 判据与 `stop()` 完全一致：只有"非持久 + 没有别的会话在用 + 目录确实换了"
        // 才允许删。
        let still_used = jobs()
            .lock()
            .map(|guard| {
                guard
                    .values()
                    .any(|other| other.directory == previous.directory)
            })
            .unwrap_or(false);
        if !previous.persist && !still_used && previous.directory != directory {
            let _ = std::fs::remove_dir_all(previous.directory);
        }
    }

    // 快路径：首个分片落地就把地址交出去（常见 2–4 秒），与官方实现的 on_ready
    // 语义一致。
    //
    // 但**"慢"不等于"失败"**。进程还活着就说明转码确实在跑，只是还没吐出分片；
    // 这种情况下直接把地址交回去，让播放器按自己的重试节奏等首段即可
    // （`hlsAttach.ts` 已补上 manifestLoadingMaxRetry / fragLoadingMaxRetry）。
    // 旧实现在这里按住用户最多 15 秒才返回，是"首次解析很慢"的直接来源——
    // 而它之所以要按住，正是因为当时前端没有重试，早返回必然判死。
    //
    // 只有 ffmpeg 进程真的退出且没留下任何产物，才算起不来，回退原始 URL。
    let url = format!(
        "http://127.0.0.1:{}/rtx/{}/index.m3u8?token={}",
        info.port, session_id, info.token
    );
    // 就绪条件同时要求 `init.mp4` 存在。它是 fMP4 的首片（播放列表里的
    // `#EXT-X-MAP`），缺了它 hls.js 连解封装都起不来；只等 playlist 会在
    // "列表已写、init 还没落"的那一瞬把一个必然失败的地址交出去。
    // 上面之所以敢不传 `-hls_fmp4_init_filename`，也是靠这一步兜住落点。
    let init_segment = directory.join("init.mp4");
    let ready = || playlist.is_file() && init_segment.is_file();
    // 等待上限。**这个值越小，首开越快**。
    //
    // 时间线是串行的：后端按住 → 前端才 attach → 播放器才开始重试清单。
    // 所以后端多等 1 秒，用户就实打实多等 1 秒——前端并不会因为后端早返回而失败，
    // 它的 `manifestLoadingMaxRetry=4` / `fragLoadingMaxRetry=8`（见 hlsAttach.ts）
    // 本来就是为了"边转边播"准备的：地址先给，首段由播放器自己等到。
    // 1.5 秒足够覆盖本机实测的首段就绪（本地片 0.55s、真实源 2–4s 的常见情况），
    // 剩下的交给播放器重试，总耗时变成 max(后端, 前端) 而不是两者相加。
    let wait_start = tokio::time::Instant::now();
    let deadline = wait_start + READY_WAIT;
    while !ready() && job_alive(session_id) && tokio::time::Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    if ready() || job_alive(session_id) {
        // ⚠️ 进程已经退出、且产物**不完整**（没有 `#EXT-X-ENDLIST`）时不能算成功。
        //
        // 那说明 ffmpeg 中途挂了（网络断、密钥错、源返回 403），产物只覆盖开头几秒。
        // 旧实现看到 ready() 为真就返回 Ok(地址)，于是上层不会走 `cached_full_mp4`
        // 回退链路 —— 用户看到的是"播一两秒就卡住、既不报错也不自愈"（审查 R5）。
        // 只有"进程还在跑"或"转完了（ENDLIST 齐）"两种情形才值得把地址交出去。
        if !job_alive(session_id) {
            let complete = std::fs::read_to_string(&playlist)
                .map(|body| body.contains("#EXT-X-ENDLIST"))
                .unwrap_or(false);
            if !complete {
                crate::trace::log(format!(
                    "[vsr] 转码进程已退出且产物不完整（无 ENDLIST），按失败处理 会话={session_id}"
                ));
                stop(session_id);
                return Err("增强转码提前退出，产物不完整。".to_owned());
            }
        }
        // 这一行是判断"到底谁在拖"的关键：ready=true 说明 ffmpeg 已经在 1.5 秒内
        // 吐出首片，后面的等待全在播放器侧；ready=false 说明后端压根没跟上。
        crate::trace::log(format!(
            "[vsr] 就绪判定 会话={session_id} ready={} 进程存活={} 等待={}ms 地址={}",
            ready(),
            job_alive(session_id),
            wait_start.elapsed().as_millis(),
            crate::trace::redact_url(&url)
        ));
        if !ready() {
            crate::trace::log("[vsr] 首段尚未落地，先交地址交由播放器重试");
        }
        return Ok(url);
    }
    crate::trace::log(format!(
        "[vsr] 起转失败 会话={session_id} 等待={}ms 后进程已退出",
        wait_start.elapsed().as_millis()
    ));
    stop(session_id);
    Err("增强转码进程已退出。".to_owned())
}

fn job_alive(session_id: u64) -> bool {
    jobs()
        .lock()
        .map(|guard| {
            guard
                .get(&session_id)
                .map(|job| !job.done.load(Ordering::Acquire))
                .unwrap_or(false)
        })
        .unwrap_or(false)
}

/// 停止一条会话的增强流。重复调用是安全的。
///
/// **`persist` 的产物不删目录**：换集时 `playback_command("stop")` 会走到这里，
/// 而对红果的整集 HLS 来说那时转码早已结束、产物是一份可复用的缓存 —— 删掉意味着
/// 用户下一次打开同一集又要重转 5.6 秒。回收改由缓存预算统一负责。
pub fn stop(session_id: u64) {
    let job = jobs()
        .lock()
        .ok()
        .and_then(|mut guard| guard.remove(&session_id));
    if let Some(job) = job {
        if let Some(task) = job.task {
            task.abort();
        }
        // ⚠️ 即使 `persist == false` 也要先确认"还有没有别的会话在用这个目录"。
        //
        // 复用场景下同一份 `vid-{vid}` 目录会被挂到多个会话号上（切走再切回、
        // 连播回退、画中画交接都走 `register_reused`）。此时若某个会话 stop 时
        // 直接删目录，就会把**另一个会话正在播的那份产物**从盘上抽走——
        // 播放器下一次请求分片时拿到 404，表现为"播到一半突然卡死"。
        // 回收交给缓存预算（它按整目录 LRU 淘汰），这里只负责解绑。
        let still_used = jobs()
            .lock()
            .map(|guard| guard.values().any(|other| other.directory == job.directory))
            .unwrap_or(false);
        if !job.persist && !still_used {
            let _ = std::fs::remove_dir_all(job.directory);
        }
    }
}

/// 清掉落盘的硬件编码探测结论，让下一次播放重新探测。
///
/// 设置页的"清空缓存"会调它：那是用户能表达"环境变了、重来一遍"的唯一入口，
/// 而探测结果的指纹只覆盖随包 ffmpeg，覆盖不到显卡与驱动。
pub fn clear_encoder_capability_cache() {
    let _ = std::fs::remove_file(nvenc_cache_path());
    let _ = std::fs::remove_file(tier_cache_path());
    // **同时清进程内槽位**。只删盘上文件的话，本次运行里 `nvenc_slot()` 仍是旧结论，
    // 探测要等重启才会重做 —— 而用户点"清空缓存"的动机恰恰是"环境变了，现在重来"
    // （换显卡、更新驱动）。审查 E1 指出的就是这个缺口。
    if let Ok(mut guard) = nvenc_slot().write() {
        *guard = None;
    }
    // 档位结论的进程内槽位同样要清 —— 否则"重新探测"只对 NVENC 那半生效，
    // 分档（Hardware / SoftwareFast / SoftwareLow）仍是旧结论。
    if let Ok(mut slot) = tier_slot().write() {
        *slot = None;
    }
}

/// 某一集的整集 HLS 缓存目录（`rtx-vsr/vid-{vid}`）。
///
/// 暴露给上层是为了两件事：命中复用/起转之后把它的 mtime 推到当下（缓存淘汰的
/// 唯一保护），以及测试里直接断言目录形态。
pub fn video_cache_dir(vid: &str) -> PathBuf {
    media_root().join(format!("vid-{vid}"))
}

/// 清掉残留的增强产物。
///
/// `keep_persistent` 决定 `vid-{vid}` 的整集 HLS 目录留不留：
///   * **启动路径传 `true`** —— 那些目录是"同一集第二次打开零等待"的全部依据
///     （按 vid 存、换集不删、带参数指纹）。旧实现无条件 `remove_dir_all(media_root())`，
///     等于把持久缓存降级成"单进程内有效"：每次重启、每次升级，所有看过的集都要重转，
///     而且用户完全看不出为什么"昨天秒开的今天又要等"（审查 R2）。
///   * **设置页「清空缓存」传 `false`** —— 用户主动要求释放空间，那时应当真的清干净。
///
/// 另外**不在持锁状态下删目录**：清缓存时 `rtx-vsr` 可能是 GB 级，而本地 HLS 服务的
/// 每个分片请求都要拿这把锁 —— 持锁删盘会让正在播的画面卡住好几秒（审查 R9）。
pub fn cleanup_all(keep_persistent: bool) {
    let mut abandoned: Vec<PathBuf> = Vec::new();
    if let Ok(mut guard) = jobs().lock() {
        for (_, job) in guard.drain() {
            if let Some(task) = job.task {
                task.abort();
            }
            if !job.persist || !keep_persistent {
                abandoned.push(job.directory);
            }
        }
    }
    for directory in abandoned {
        let _ = std::fs::remove_dir_all(directory);
    }
    if keep_persistent {
        // 只清根目录下的**临时**残留（`session-<id>-<uuid>`、早期版本的裸数字目录）。
        let Ok(entries) = std::fs::read_dir(media_root()) else {
            return;
        };
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with("vid-") {
                continue;
            }
            let path = entry.path();
            if path.is_dir() {
                let _ = std::fs::remove_dir_all(&path);
            } else {
                let _ = std::fs::remove_file(&path);
            }
        }
        return;
    }
    let _ = std::fs::remove_dir_all(media_root());
}

async fn ensure_server() -> Result<ServerInfo, String> {
    if let Some(info) = server_info().get() {
        return Ok(info.clone());
    }
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|error| format!("增强播放服务绑定失败：{error}"))?;
    let port = listener
        .local_addr()
        .map_err(|error| error.to_string())?
        .port();
    let info = ServerInfo {
        port,
        token: uuid::Uuid::new_v4().simple().to_string(),
    };
    let accepted = info.clone();
    server_info()
        .set(info.clone())
        .map_err(|_| "增强播放服务状态重复初始化。".to_string())?;
    tokio::spawn(async move {
        while let Ok((socket, _)) = listener.accept().await {
            let server = accepted.clone();
            tokio::spawn(async move {
                let _ = handle(socket, server).await;
            });
        }
    });
    Ok(info)
}

async fn handle(mut socket: TcpStream, server: ServerInfo) -> std::io::Result<()> {
    let mut request = Vec::with_capacity(4096);
    let mut chunk = [0u8; 4096];
    loop {
        let count = socket.read(&mut chunk).await?;
        if count == 0 {
            break;
        }
        request.extend_from_slice(&chunk[..count]);
        if request.windows(4).any(|window| window == b"\r\n\r\n") || request.len() > 64 * 1024 {
            break;
        }
    }
    let request = String::from_utf8_lossy(&request).into_owned();
    let first = request.lines().next().unwrap_or_default();
    let method = first
        .split_whitespace()
        .next()
        .unwrap_or_default()
        .to_ascii_uppercase();
    let target = first.split_whitespace().nth(1).unwrap_or_default();
    let (path, query) = target.split_once('?').unwrap_or((target, ""));
    if method == "OPTIONS" {
        write_head(
            &mut socket,
            "204 No Content",
            &cors_headers(),
            0,
            None,
            true,
        )
        .await?;
        return Ok(());
    }
    let token = query
        .split('&')
        .find_map(|pair| pair.strip_prefix("token="))
        .unwrap_or_default();
    if token != server.token {
        // 前端若还在用上一轮会话的地址，这里会成片 403，表现为"播放器一直转圈"。
        crate::trace::log("[vsr] 本地服务：令牌无效，拒绝请求（多半是过期会话地址）");
        write_plain(&mut socket, "403 Forbidden", "增强播放令牌无效").await?;
        return Ok(());
    }
    let Some(file_name) = path.rsplit('/').next() else {
        write_plain(&mut socket, "404 Not Found", "增强播放资源不存在").await?;
        return Ok(());
    };
    let Some(session_text) = path.split('/').nth(2) else {
        write_plain(&mut socket, "404 Not Found", "增强播放资源不存在").await?;
        return Ok(());
    };
    let Ok(session_id) = session_text.parse::<u64>() else {
        write_plain(&mut socket, "404 Not Found", "增强播放资源不存在").await?;
        return Ok(());
    };
    if !matches!(file_name, "index.m3u8" | "init.mp4") && !is_segment(file_name) {
        write_plain(&mut socket, "404 Not Found", "增强播放资源不存在").await?;
        return Ok(());
    }
    let Some(directory) = jobs()
        .lock()
        .ok()
        .and_then(|guard| guard.get(&session_id).map(|job| job.directory.clone()))
    else {
        write_plain(&mut socket, "404 Not Found", "增强播放会话已结束").await?;
        return Ok(());
    };
    let file_path = directory.join(file_name);
    if file_name == "index.m3u8" {
        let body = std::fs::read_to_string(&file_path).unwrap_or_default();
        let rewritten = rewrite_local_playlist(&body, &server.token);
        // ⚠️ 清单还没写出有效内容时**必须返 5xx**，绝不能返 200 空清单。
        //
        // 为什么：hls.js 对"拿到了完整响应但内容是空的"的解读只有一个 ——
        // `manifestParsingError`，而它走 `handleManifestParsingError`，**那条路径里
        // 没有任何重试逻辑**，`fatal` 直接为 true。也就是说返 200 空清单等于把一个
        // 必死信号交给播放器，它连等的余地都没有。
        //
        // 而"暂时还没准备好"应当用 **503** 表达：hls.js 的 `manifestLoadError` 会走
        // `shouldRetry` → `retryForHttpStatus`，**对 5xx 重试、对 4xx 不重试**，因此
        // 配上调用方的 `manifestLoadingMaxRetry: 4` 正好让它自己等到 ffmpeg 吐出首片。
        // （返 404 是错的：4xx 不重试。分片路径上的 404 之所以没事，是因为 hls.js 对
        //  分片另有 `fragLoadingMaxRetry` 那条不同的重试路径。）
        //
        // 空清单只有一种成因：ffmpeg 刚起、还没来得及 prime 出播放列表。实测从起进程
        // 到清单首次含 `#EXTINF` 是 1011ms，这段窗口踩中的概率不低——用户那次 15.7 秒
        // 首屏里就正好撞上（日志 `下发清单 会话=102 字节=1`）。
        //
        // 判据是**没有 `#EXTINF`**，不是"文件为空"：ffmpeg 会先把 header 版清单
        // （`#EXTM3U` + `#EXT-X-TARGETDURATION`，约 40~120 字节）写出来，那段时间
        // 清单非空但没有一条分片。返 200 的话 hls.js 会报 `LEVEL_EMPTY_ERROR`
        // （无 ENDLIST 被判成 live 流）→ 落到 `levelLoadingMaxRetry`，重试预算被花在
        // 另一条路径上；返 503 才回到注释上面写的那条 `manifestLoadingMaxRetry`。
        if !rewritten.contains("#EXTINF") {
            crate::trace::log(format!(
                "[vsr] 本地服务：清单尚未就绪 会话={session_id}（返 503 让播放器重试）"
            ));
            write_plain(
                &mut socket,
                "503 Service Unavailable",
                "增强播放清单尚未就绪",
            )
            .await?;
            return Ok(());
        }
        // 播放器每次重新拉清单都会打一行：清单已经被拉了几次，直接反映"卡了多久"。
        crate::trace::log(format!(
            "[vsr] 本地服务：下发清单 会话={session_id} 字节={}",
            rewritten.len()
        ));
        let headers = format!(
            "{}Content-Type: application/vnd.apple.mpegurl\r\nAccept-Ranges: bytes\r\n",
            cors_headers()
        );
        write_head(
            &mut socket,
            "200 OK",
            &headers,
            rewritten.len() as u64,
            None,
            method == "HEAD",
        )
        .await?;
        if method != "HEAD" {
            socket.write_all(rewritten.as_bytes()).await?;
        }
        socket.flush().await?;
        return Ok(());
    }
    let Ok(metadata) = std::fs::metadata(&file_path) else {
        // 分片还没落盘、播放器却在要它——这就是"一直加载等待"最直接的一行证据。
        crate::trace::log(format!(
            "[vsr] 本地服务：分片尚未就绪 会话={session_id} 文件={file_name}"
        ));
        write_plain(&mut socket, "404 Not Found", "增强播放分片尚未就绪").await?;
        return Ok(());
    };
    let size = metadata.len();
    let range = request.lines().find_map(|line| {
        let (name, value) = line.split_once(':')?;
        name.eq_ignore_ascii_case("range")
            .then(|| value.trim().to_string())
    });
    let (start, end) = parse_range(range.as_deref(), size).unwrap_or((0, size.saturating_sub(1)));
    if start > end || start >= size {
        write_head(
            &mut socket,
            "416 Range Not Satisfiable",
            &cors_headers(),
            0,
            Some((0, size)),
            true,
        )
        .await?;
        return Ok(());
    }
    let content_type = if file_name.ends_with(".m3u8") {
        "application/vnd.apple.mpegurl"
    } else {
        "video/mp4"
    };
    let mut headers = cors_headers();
    headers.push_str(&format!("Content-Type: {content_type}\r\n"));
    headers.push_str("Accept-Ranges: bytes\r\n");
    let status = if range.is_some() {
        "206 Partial Content"
    } else {
        "200 OK"
    };
    write_head(
        &mut socket,
        status,
        &headers,
        end - start + 1,
        Some((start, end)),
        method == "HEAD",
    )
    .await?;
    if method != "HEAD" {
        let mut file = std::fs::File::open(&file_path)?;
        use std::io::{Read, Seek, SeekFrom};
        file.seek(SeekFrom::Start(start))?;
        let mut remaining = end - start + 1;
        let mut buffer = [0u8; 64 * 1024];
        while remaining > 0 {
            let count = file.read(&mut buffer)?;
            if count == 0 {
                break;
            }
            let count = count.min(remaining as usize);
            socket.write_all(&buffer[..count]).await?;
            remaining -= count as u64;
        }
    }
    socket.flush().await
}

/// ffmpeg 的相对分片地址不带查询串；令牌必须在播放列表阶段补回去。
fn rewrite_local_playlist(body: &str, token: &str) -> String {
    body.lines()
        .map(|line| {
            if line.starts_with('#') {
                if line.starts_with("#EXT-X-MAP:URI=\"") {
                    format!("#EXT-X-MAP:URI=\"init.mp4?token={token}\"")
                } else {
                    line.to_owned()
                }
            } else if line.trim().is_empty() {
                line.to_owned()
            } else {
                format!("{line}?token={token}")
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
        + "\n"
}

fn is_segment(name: &str) -> bool {
    let Some(rest) = name.strip_prefix("seg-") else {
        return false;
    };
    let Some(number) = rest.strip_suffix(".m4s") else {
        return false;
    };
    number.len() == 5 && number.bytes().all(|byte| byte.is_ascii_digit())
}

fn parse_range(value: Option<&str>, size: u64) -> Option<(u64, u64)> {
    let value = value?;
    let rest = value.strip_prefix("bytes=")?;
    let (start, end) = rest.split_once('-')?;
    if start.is_empty() {
        let suffix = end.parse::<u64>().ok()?;
        return Some((size.saturating_sub(suffix), size.saturating_sub(1)));
    }
    let start = start.parse::<u64>().ok()?;
    let end = if end.is_empty() {
        size.saturating_sub(1)
    } else {
        end.parse::<u64>().ok()?.min(size.saturating_sub(1))
    };
    Some((start, end))
}

fn cors_headers() -> String {
    "Access-Control-Allow-Origin: *\r\n\
     Access-Control-Allow-Headers: *\r\n\
     Access-Control-Allow-Methods: GET, HEAD, OPTIONS\r\n\
     Access-Control-Expose-Headers: Content-Length,Content-Range,Accept-Ranges\r\n\
     X-Content-Type-Options: nosniff\r\n"
        .to_owned()
}

async fn write_plain(socket: &mut TcpStream, status: &str, body: &str) -> std::io::Result<()> {
    let mut headers = cors_headers();
    headers.push_str("Content-Type: text/plain; charset=utf-8\r\n");
    write_head(socket, status, &headers, body.len() as u64, None, false).await?;
    socket.write_all(body.as_bytes()).await?;
    socket.flush().await
}

async fn write_head(
    socket: &mut TcpStream,
    status: &str,
    headers: &str,
    length: u64,
    range: Option<(u64, u64)>,
    head_only: bool,
) -> std::io::Result<()> {
    let mut head = format!("HTTP/1.1 {status}\r\n{headers}");
    if let Some((start, end)) = range {
        // 调用方已将 length 算成 end-start+1；这里补 Content-Range。
        if status.starts_with("206") {
            head.push_str(&format!("Content-Range: bytes {start}-{end}/*\r\n"));
        }
    }
    head.push_str(&format!(
        "Content-Length: {length}\r\nConnection: close\r\n\r\n"
    ));
    socket.write_all(head.as_bytes()).await?;
    socket.flush().await?;
    let _ = head_only;
    Ok(())
}

/// 预转的**在途闸门**（同时最多 1 路）。
///
/// 为什么必须放在 Rust 侧：预转的产物与"正在播的那一集"共用同一块编码单元，而
/// 实测 NVENC **完全串行**（两路 9455+9407ms、四路 20060ms × 4，总时长不因并发减少，
/// 只是把正在播的那一路挤慢 → 分片来不及生成 → hls.js 重试耗尽报错）。
/// 前端的 `MAX_PREWARM_INFLIGHT = 1` 只管得住它自己那条路，画中画、悬停预取、
/// 连播预转各有入口 —— 闸门放在这里才能对所有调用方生效（审查 R3）。
static PREWARM_INFLIGHT: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

/// 在途计数的配对释放器：无论函数从哪条路径返回（含提前 return）都会减回去。
struct PrewarmGuard;

impl Drop for PrewarmGuard {
    fn drop(&mut self) {
        PREWARM_INFLIGHT.fetch_sub(1, Ordering::AcqRel);
    }
}

/// **预转**某一集的整集 HLS，不占用任何播放会话。
///
/// ## 为什么需要它（用户需求：「集与集之间无缝切换」）
///
/// 方案 B 的播放源是整集 HLS，转码耗时实测 5.6 秒（92.7 秒正片）。若这一集等到
/// 用户真的点开/连播到它才开始转，那 5.6 秒就是黑屏等待。
///
/// 而一集正片 50–140 秒，**上一集播放期间完全来得及把下一集转好**。这个函数就是
/// 做这件事：起一路转码写进 `vid-{vid}` 目录（与 `start_video_cache` 同一个目录），
/// 转完自然退出。等用户真的切过去时，`start_video_cache` 命中 `#EXT-X-ENDLIST`
/// 直接返回地址 —— 切换不需要任何等待。
///
/// ## 与播放任务的区别
///
/// - **不占会话号**：用一个专用的大数段做 key，且 `persist = true`。播放会话的
///   `stop()` 不会误删它，8 路淘汰也不会选中它。
/// - **不等待就绪**：预转是后台行为，不等首片、不返回地址，调用方 fire-and-forget。
/// - **已有产物直接跳过**：避免与正在播的那一路重复转码（`directory_of_inflight_vid`
///   会挡住并发，这里再加一道 ENDLIST 检查）。
///
/// 失败一律静默（只记日志）：预转是纯优化，失败时用户走的就是"现场转"那条老路。
pub async fn prewarm_video_cache(
    vid: &str,
    source_url: &str,
    key_hex: Option<&str>,
    session_slot: u64,
    source_kbps: Option<u32>,
) {
    // 闸门：已经有预转在跑就不再接新的（见 `PREWARM_INFLIGHT` 的说明）。
    // 放在最前面——比"查产物"还早，避免多路调用同时走到起 ffmpeg 那一步。
    if PREWARM_INFLIGHT.fetch_add(1, Ordering::AcqRel) > 0 {
        PREWARM_INFLIGHT.fetch_sub(1, Ordering::AcqRel);
        crate::trace::log(format!("[vsr] 预转跳过（已有预转在途）vid={vid}"));
        return;
    }
    // 从这里开始，任何 return 都会由 guard 把计数减回去。
    let _guard = PrewarmGuard;

    let directory = video_cache_dir(vid);
    let playlist = directory.join("index.m3u8");
    // 参数变了就把旧产物丢掉：否则预转会把"旧参数的成品"当成就绪而跳过，
    // 用户点开时又在 `start_video_cache` 里重转一次，白等一轮。
    // 正在转码的那一份不能删（那会把别的会话正在播的产物抽走）。
    if directory.is_dir()
        && directory_of_inflight_vid(&directory).is_none()
        && !artifact_is_current(&directory)
    {
        let _ = std::fs::remove_dir_all(&directory);
    }
    // 已经转好：什么都不用做。
    if let Ok(body) = std::fs::read_to_string(&playlist) {
        if body.contains("#EXT-X-ENDLIST") && directory.join("init.mp4").is_file() {
            return;
        }
    }
    // 正在播的那一路已经在转同一个目录：让它跑完即可，别起第二路。
    if directory_of_inflight_vid(&directory).is_some() {
        crate::trace::log(format!("[vsr] 预转跳过（同一 vid 已在转码）vid={vid}"));
        return;
    }
    crate::trace::log(format!("[vsr] 预转开始 vid={vid} 槽位={session_slot}"));
    match start_in_directory(
        session_slot,
        source_url,
        key_hex,
        directory.clone(),
        true,
        source_kbps,
    )
    .await
    {
        Ok(_) => {
            // 地址拿到就丢弃：预转不需要播，等 ffmpeg 自己跑完。
            // 转完后 `start_video_cache` 会凭 ENDLIST 直接复用。
            crate::trace::log(format!("[vsr] 预转已就绪 vid={vid}"));
        }
        Err(error) => {
            crate::trace::log(format!("[vsr] 预转未启动（静默）vid={vid}：{error}"));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 低配档必须**降分辨率**，而不是只降码率。
    ///
    /// 这是「遇到配置低的用户则自适应」唯一可被单测钉住的一面（探测本身依赖真实
    /// 硬件）。低配档的全部性能保障就是这条 `-vf scale=-2:720` —— 实测只降码率对
    /// CPU 几乎无帮助（1080p cq26→cq34 只从 5499ms 降到 5429ms），而降分辨率到
    /// 720p 能到 4027–4691ms。改参数时若把它删掉，低配用户会立刻退回"一直转圈"。
    #[test]
    fn low_tier_drops_resolution() {
        assert!(
            LOW_TIER_ARGS.contains(&"-vf"),
            "低配档缺少 -vf，等于只降码率、对 CPU 无实质帮助"
        );
        assert!(
            LOW_TIER_ARGS
                .iter()
                .any(|value| value.contains("scale=-2:720")),
            "低配档的分辨率目标应为 720p"
        );
    }

    /// 三档都必须钉住关键帧间隔。
    ///
    /// 缺了它 HLS 分片会落到源流的关键帧间隔上（实测 8.33 秒），`hls_time=2` 形同
    /// 虚设 —— 那正是「前 8 秒转换」的由来。三档共用同一套分片节奏，用户换机器不
    /// 该改变"多久能看到画面"。
    #[test]
    fn every_tier_pins_keyframe_interval() {
        for (name, args) in [
            ("hardware", NVENC_ARGS),
            ("software-fast", X264_ARGS),
            ("software-low", LOW_TIER_ARGS),
        ] {
            for flag in ["-g", "-keyint_min", "-sc_threshold"] {
                assert!(
                    args.contains(&flag),
                    "{name} 档缺少 {flag}，分片时长会退化成源流关键帧间隔"
                );
            }
        }
    }

    /// 三档参数必须两两不同 —— 否则"自适应"是假的。
    #[test]
    fn tiers_are_actually_distinct() {
        assert_ne!(NVENC_ARGS, X264_ARGS, "硬件档与软件档参数相同");
        assert_ne!(X264_ARGS, LOW_TIER_ARGS, "软件快档与低配档参数相同");
    }

    /// 码率上限必须**跟着源档码率**走，而不是写死一个数。
    ///
    /// 实测（同一段 20 秒 1080p 真人短剧，SSIM 相对源）：固定 `-maxrate 1100k`（上一版）
    /// 是 **0.9814**（用户报的"转码后画质下降很多"），按源 2.24× 自适应是 **0.9917**
    /// （体积只多 25%），完全不设上限是 0.9950 但体积是源的 7.3 倍（8.53MB vs 1.16MB）。
    /// 所以两件事都要钉住：上限存在（否则体积失控）、且按源算（否则高码率源掉画质）。
    #[test]
    fn rate_limits_follow_the_source() {
        // 实测样本的源档是 733kbps：2.24× = 1642k，bufsize = 2× = 3284k
        assert_eq!(rate_limits(Some(733)), (1642, 3284));
        // 源码率翻倍，上限必须跟着翻倍（证明它不是固定值）
        assert_eq!(rate_limits(Some(1466)), (3284, 6568));
        // 拿不到源码率 ⇒ 中性默认值
        assert_eq!(rate_limits(None), (3000, 6000));
        // 荒谬的小值按"拿不到"处理（上游字段出过 100 这种不可信的值）
        assert_eq!(rate_limits(Some(0)), (3000, 6000));
        // 低码率源（实测档位表里出现过 300kbps 档）**不能被下限抬高**：
        // 2.24×300 = 672，旧实现的下限 900 会把它抬到源码率的 3 倍（审查 R6）。
        assert_eq!(rate_limits(Some(300)), (672, 1344));
        // 边界：低于 100k 的"码率"一律视为脏数据（不是码率），按拿不到处理；
        // 极高值钳到 8000k。
        assert_eq!(rate_limits(Some(10)), (3000, 6000));
        assert_eq!(rate_limits(Some(100)), (224, 448));
        assert_eq!(rate_limits(Some(99_999)).0, 8000);
    }

    /// 上限是**运行时追加**到编码参数里的（常量表里没有它）。
    ///
    /// 这一条守着"常量改了、追加逻辑没改"的漂移：`video_encoder_args` 调的就是它。
    #[test]
    fn rate_limits_are_appended_to_encoder_args() {
        let lines = rate_lines(Some(733));
        assert_eq!(lines, vec!["-maxrate", "1642k", "-bufsize", "3284k"]);
    }

    /// 首片必须比 `-hls_time` 更早切出去，且关键帧节奏只能有一条规则。
    ///
    /// `-hls_init_time 1` 是"首片多早写得出来"的一个手段：不给它，首片要等满
    /// `-hls_time`（2 秒）才有机会落盘（本地源实测 652ms → 465ms）。⚠️ 但它在
    /// **GOP 比 `hls_time` 长的源上不起作用** —— 网络源实测（15fps、`-g 48` ⇒ GOP
    /// 3.2 秒）首片仍是 3.2 秒一片、完成时间在噪声内。它属于"GOP ≤ hls_time 才显形"
    /// 的改动，留着无害；别把它当成首屏时间的保证。
    ///
    /// `-force_key_frames` 必须**不在**这套参数里：它对 NVENC 无效（实测分片照样
    /// 8.33 秒），而对 libx264 又是与 `-g` 并行的第二条规则（不同帧率下两者不重合，
    /// 取并集＝无谓更密的关键帧）。软件档删掉它的实测代价与收益见调用点注释。
    /// `-force_key_frames` 的取舍：**硬件档不许有、软件档必须有**。
    ///
    /// 硬件档有它是纯误导（NVENC 不认表达式，实测分片照样 8.33 秒）；软件档没有它时
    /// 关键帧只能落在 `-g 48` 上（15fps 源＝3.2 秒），实测首片 3.2→2.0 秒、体积 -25%。
    #[test]
    fn hls_packaging_keeps_first_segment_early() {
        assert!(
            HLS_PACKAGING_ARGS.contains(&"-hls_init_time"),
            "缺少 -hls_init_time，首片要等满 -hls_time 才出得来"
        );
        assert!(
            !HLS_PACKAGING_ARGS.contains(&"-force_key_frames"),
            "硬件档不该有 -force_key_frames：NVENC 不认这个表达式，写它是误导"
        );
        assert!(
            HLS_PACKAGING_ARGS_X264.contains(&"-force_key_frames"),
            "软件档需要 -force_key_frames：实测首片 3.2→2.0 秒、首片体积 -25%"
        );
    }

    /// Rust 与 worker 的三档编码参数必须逐项一致。
    ///
    /// 参数表在两个文件里各有一份（这里是 `NVENC_ARGS` / `X264_ARGS` / `LOW_TIER_ARGS`，
    /// worker 是 `_NVENC_ARGS` / `_X264_ARGS` / `_X264_LOW_ARGS`），此前已经漂移过两次
    /// （GOP 一次、`-profile:v high` 与码率上限又一次），症状是"同一条链路换集后分片粒度、
    /// 体积、首屏突然变样"，极难定位。worker 那边的注释写着"必须保持一致"，但那条承诺
    /// 过去完全靠人盯着 —— 这个测试把它变成**会失败的检查**。
    ///
    /// 只比元素的多重集、不比顺序：两边都是输出侧选项，顺序没有语义（低配档的
    /// `-vf scale=-2:720` 位置就与 Rust 侧不同）。读不到 `worker.py` 时直接跳过
    /// （打包后的运行环境里没有源码，这个测试只在开发机上才有意义）。
    #[test]
    fn worker_encoder_args_match_rust() {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("resources/shortdrama-worker/worker.py");
        let Ok(text) = std::fs::read_to_string(&path) else {
            return;
        };
        for (python_name, rust_args) in [
            ("_NVENC_ARGS", NVENC_ARGS),
            ("_X264_ARGS", X264_ARGS),
            ("_X264_LOW_ARGS", LOW_TIER_ARGS),
        ] {
            let mut worker = python_list_literals(&text, python_name)
                .unwrap_or_else(|| panic!("worker.py 里找不到 {python_name} 的列表字面量"));
            let mut rust: Vec<String> = rust_args.iter().map(|value| (*value).to_owned()).collect();
            worker.sort();
            rust.sort();
            assert_eq!(
                worker, rust,
                "{python_name} 与 Rust 侧同名档位的参数漂移了（两边必须同一套）"
            );
        }
    }

    /// 取出 Python 源码里 `<name> = [ ... ]` 这一段之间所有字符串字面量的值。
    ///
    /// 只够应付当前这份列表（纯双引号字面量、无嵌套括号），刻意不写通用解析器：
    /// 它服务于上面那条一致性断言，不是通用的 Python 解析。
    fn python_list_literals(text: &str, name: &str) -> Option<Vec<String>> {
        let start = text.find(&format!("{name} = ["))?;
        let rest = &text[start..];
        let end = rest.find(']')?;
        Some(
            rest[..end]
                .split('"')
                .skip(1)
                .step_by(2)
                .map(|piece| piece.to_owned())
                .collect(),
        )
    }

    #[tokio::test]
    #[ignore = "真实源流冒烟：设置 TTV_VSR_SMOKE_SOURCE=http://.../video.mp4 后手动运行"]
    async fn enhanced_hls_smoke() {
        let source = std::env::var("TTV_VSR_SMOKE_SOURCE").expect("缺少 TTV_VSR_SMOKE_SOURCE");
        let url = start(0x565352, &source).await.expect("增强流应能启动");
        println!("TTV_VSR_SMOKE_URL={url}");
        let body = reqwest::get(&url)
            .await
            .expect("增强播放列表应可读")
            .text()
            .await
            .expect("播放列表正文");
        assert!(body.starts_with("#EXTM3U"));
        if std::env::var_os("TTV_VSR_SMOKE_HOLD").is_some() {
            tokio::time::sleep(Duration::from_secs(300)).await;
        }
        stop(0x565352);
    }

    #[test]
    fn range_parser_supports_browser_requests() {
        assert_eq!(parse_range(Some("bytes=0-1"), 10), Some((0, 1)));
        assert_eq!(parse_range(Some("bytes=8-"), 10), Some((8, 9)));
        assert_eq!(parse_range(Some("bytes=-2"), 10), Some((8, 9)));
        assert_eq!(parse_range(Some("bytes=20-30"), 10), Some((20, 9)));
    }

    #[test]
    fn playlist_rewrite_forces_local_init_and_tokens_segments() {
        let raw = "#EXTM3U\n#EXT-X-MAP:URI=\"C:\\\\cache\\\\init.mp4\"\nseg-00000.m4s\n";
        let rewritten = rewrite_local_playlist(raw, "tok");
        assert!(rewritten.contains("#EXT-X-MAP:URI=\"init.mp4?token=tok\""));
        assert!(rewritten.contains("seg-00000.m4s?token=tok"));
    }

    #[test]
    fn enhancement_only_targets_http_sources() {
        assert!(needs_enhancement("https://cdn.example/video.mp4"));
        assert!(needs_enhancement("http://127.0.0.1:57225/stream?u=x"));
        assert!(!needs_enhancement("asset:///C:/video.mp4"));
    }
}
