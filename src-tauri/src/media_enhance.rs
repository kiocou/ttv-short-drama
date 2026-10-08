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

/// 启动一条 H.264 HLS 增强流。源流失败时返回 Err，调用方继续用原 URL。
pub async fn start(session_id: u64, source_url: &str) -> Result<String, String> {
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
        let oldest = jobs()
            .lock()
            .ok()
            .and_then(|guard| guard.keys().copied().min());
        match oldest {
            Some(id) => stop(id),
            None => break,
        }
    }

    let directory = media_root().join(format!("{session_id}-{}", uuid::Uuid::new_v4().simple()));
    std::fs::create_dir_all(&directory)
        .map_err(|error| format!("创建增强缓存目录失败：{error}"))?;

    let ffmpeg = crate::short_drama_app::ffmpeg_path()?;
    let playlist = directory.join("index.m3u8");
    // 记下"转码这一段"的起点。整条首开时间线 = 解析(worker) + 等待就绪(这里)
    // + 播放器拉清单/首片，三者混在一个"很慢"里没法优化，所以每段各自落一行。
    crate::trace::log(format!(
        "[vsr] start 会话={session_id} 源={} ffmpeg={}",
        crate::trace::redact_url(source_url),
        ffmpeg.display()
    ));
    let mut command = Command::new(ffmpeg);
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
        .arg("-c:v")
        .arg("libx264")
        .arg("-preset")
        .arg("ultrafast")
        .arg("-crf")
        .arg("20")
        .arg("-tune")
        .arg("zerolatency")
        .arg("-pix_fmt")
        .arg("yuv420p")
        .arg("-c:a")
        .arg("aac")
        .arg("-b:a")
        .arg("128k")
        .arg("-force_key_frames")
        .arg("expr:gte(t,n_forced*2)")
        .arg("-f")
        .arg("hls")
        .arg("-hls_time")
        .arg("2")
        .arg("-hls_list_size")
        .arg("0")
        .arg("-hls_flags")
        .arg("independent_segments")
        .arg("-hls_segment_type")
        .arg("fmp4")
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
            },
        );
    if let Some(previous) = replaced {
        if let Some(task) = previous.task {
            task.abort();
        }
        let _ = std::fs::remove_dir_all(previous.directory);
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
        // 这一行是判断"到底谁在拖"的关键：ready=true 说明 ffmpeg 已经在 1.5 秒内
        // 吐出首片，后面的等待全在播放器侧；ready=false 说明后端压根没跟上。
        crate::trace::log(format!(
            "[vsr] 就绪判定 会话={session_id} ready={} 进程存活={} 等待={}ms 地址={}",
            ready(),
            job_alive(session_id),
            wait_start.elapsed().as_millis(),
            url
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

/// 停止并清理一条会话的增强流。重复调用是安全的。
pub fn stop(session_id: u64) {
    let job = jobs()
        .lock()
        .ok()
        .and_then(|mut guard| guard.remove(&session_id));
    if let Some(job) = job {
        if let Some(task) = job.task {
            task.abort();
        }
        let _ = std::fs::remove_dir_all(job.directory);
    }
}

/// 启动时/清缓存时清掉所有残留；此时没有正在使用的增强任务。
pub fn cleanup_all() {
    if let Ok(mut guard) = jobs().lock() {
        for (_, job) in guard.drain() {
            if let Some(task) = job.task {
                task.abort();
            }
            let _ = std::fs::remove_dir_all(job.directory);
        }
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

#[cfg(test)]
mod tests {
    use super::*;

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
