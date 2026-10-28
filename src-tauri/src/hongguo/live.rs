//! 真实网络集成验证。
//!
//! 默认不跑（`#[ignore]`），因为它们会真的连红果接口。需要时显式执行：
//!
//! ```sh
//! cargo test --bin ttv-short-drama live_ -- --ignored --nocapture
//! ```
//!
//! 这些用例存在的意义：签名算法错了不会编译失败，只会被服务端用
//! 「HTTP 200 + 空 body」静默拒绝。只有真打一次请求才能证明整条链路是对的。

use crate::hongguo::client::HongguoClient;

/// 全球死考第一季第 1 集（openhongguo 文档里的示例剧集）。
const SAMPLE_EPISODE: &str = "7675424396831378456";

#[tokio::test]
#[ignore = "需要真实网络"]
async fn live_register_and_resolve_playback() {
    let client = HongguoClient::new(None).await.expect("创建客户端失败");

    // 1) 匿名注册
    let profile = client.ensure_guest().await.expect("匿名注册失败");
    assert!(profile.is_ready(), "注册后 device_id/install_id 必须有效");
    eprintln!(
        "[live] 注册成功 device_id={} install_id={}",
        profile.device_id_str, profile.install_id_str
    );

    // 2) 播放解析
    let started = std::time::Instant::now();
    let resolved = client
        .resolve_playback(SAMPLE_EPISODE)
        .await
        .expect("播放解析失败");
    let elapsed = started.elapsed();

    eprintln!(
        "[live] 播放解析耗时 {}ms，码流 {} 路，加密={}",
        elapsed.as_millis(),
        resolved.playback.streams.len(),
        resolved.playback.protected
    );
    for s in &resolved.playback.streams {
        eprintln!(
            "  - {} / {} / {}x{} / {}kbps / protected={}",
            s.definition,
            s.codec,
            s.width,
            s.height,
            s.bitrate / 1000,
            s.protected
        );
    }

    assert!(!resolved.playback.streams.is_empty(), "必须至少有一路码流");
    assert!(
        resolved.playback.streams.iter().all(|s| !s.url.is_empty()),
        "所有码流都要有地址"
    );
    if resolved.playback.protected {
        let key = resolved
            .content_key
            .as_ref()
            .expect("加密流必须能解出内容密钥");
        assert_eq!(key.hex.len(), 32, "内容密钥应为 32 位 hex");
        eprintln!("[live] 内容密钥 {}... 版本 {}", &key.hex[..8], key.version);
    }
}

#[tokio::test]
#[ignore = "需要真实网络"]
async fn live_signature_is_accepted() {
    // 只验证「签名被服务端接受」这一件事：能拿到非空 body 且无业务错误码。
    // 用一个确定存在的分集，请求播放模型。
    let client = HongguoClient::new(None).await.expect("创建客户端失败");
    let result = client.resolve_playback(SAMPLE_EPISODE).await;
    match result {
        Ok(_) => {}
        Err(e) => panic!("签名未被接受：{e}（若是 AnonymousLimited 说明签名算法有偏差）"),
    }
}

#[tokio::test]
#[ignore = "需要真实网络"]
async fn live_search_and_series() {
    let client = HongguoClient::new(None).await.expect("创建客户端失败");

    let started = std::time::Instant::now();
    let hits = client.search("末世", 10, 0).await.expect("搜索失败");
    eprintln!(
        "[live] 搜索 {}ms，命中 {} 部",
        started.elapsed().as_millis(),
        hits.len()
    );
    assert!(
        !hits.is_empty(),
        "搜索必须返回结果（空结果说明签名或参数不对）"
    );
    for h in hits.iter().take(3) {
        eprintln!("  - {} / {} / {}集", h.id, h.title, h.episode_count);
    }

    // 取第一部拿详情
    let sid = &hits[0].id;
    let started = std::time::Instant::now();
    let (series, episodes) = client.get_series(sid).await.expect("详情失败");
    eprintln!(
        "[live] 详情 {}ms：{} / {} 集",
        started.elapsed().as_millis(),
        series.title,
        episodes.len()
    );
    assert!(!eps_is_empty(&episodes), "详情必须带分集列表");
    eprintln!("  第 1 集: {} 第{}集", episodes[0].id, episodes[0].number);

    // 用详情拿到的一集去解析播放
    let started = std::time::Instant::now();
    let resolved = client
        .resolve_playback(&episodes[0].id)
        .await
        .expect("播放解析失败");
    eprintln!(
        "[live] 播放解析 {}ms，{} 路码流",
        started.elapsed().as_millis(),
        resolved.playback.streams.len()
    );
    assert!(resolved.playback.protected);
    assert!(resolved.content_key.is_some());
}

fn eps_is_empty(v: &[crate::hongguo::catalog::EpisodeHit]) -> bool {
    v.is_empty()
}
#[tokio::test]
#[ignore = "需要真实网络"]
async fn live_duration_check() {
    let client = HongguoClient::new(None).await.expect("client");
    let resolved = client
        .resolve_playback(SAMPLE_EPISODE)
        .await
        .expect("resolve");
    eprintln!(
        "[live] duration_seconds = {}",
        resolved.playback.duration_seconds
    );
    eprintln!("[live] expires_at = {}", resolved.playback.expires_at);
    eprintln!("[live] media_type = {}", resolved.playback.media_type);
    for s in &resolved.playback.streams {
        eprintln!(
            "  {} / {}x{} / {}bps / hls={} dash={}",
            s.definition, s.width, s.height, s.bitrate, s.hls, s.dash
        );
    }
}

#[tokio::test]
#[ignore = "需要真实网络"]
async fn live_user_episode_duration() {
    let client = HongguoClient::new(None).await.expect("client");
    for vid in ["7690936226991311897", "7690936062583000089"] {
        match client.resolve_playback(vid).await {
            Ok(r) => eprintln!(
                "[live] {} duration={}s streams={}",
                vid,
                r.playback.duration_seconds,
                r.playback.streams.len()
            ),
            Err(e) => eprintln!("[live] {} 失败: {}", vid, e),
        }
    }
}

#[tokio::test]
#[ignore = "需要真实网络"]
async fn live_dump_stream_url() {
    let client = HongguoClient::new(None).await.expect("client");
    let r = client
        .resolve_playback("7690936226991311897")
        .await
        .expect("resolve");
    let best = r.playback.best_stream().expect("best");
    let key = r
        .content_key
        .as_ref()
        .map(|k| k.hex.clone())
        .unwrap_or_default();
    std::fs::write(
        "D:/Users/kioco/Desktop/TTV Short Drama/.tmp/url.txt",
        &best.url,
    )
    .unwrap();
    std::fs::write("D:/Users/kioco/Desktop/TTV Short Drama/.tmp/key.txt", &key).unwrap();
    eprintln!(
        "[live] 已导出 url/key, duration={}s",
        r.playback.duration_seconds
    );
}

#[tokio::test]
#[ignore = "需要真实网络"]
async fn live_diagnose_vid() {
    // 新设备（内存档案）测应用里失败的那个 vid
    let fresh = HongguoClient::new(None).await.expect("client");
    let target = "7690208595719244825";
    match fresh.resolve_playback(target).await {
        Ok(r) => eprintln!(
            "[diag] 新设备 OK: streams={} duration={}s",
            r.playback.streams.len(),
            r.playback.duration_seconds
        ),
        Err(e) => eprintln!("[diag] 新设备 失败: {e}"),
    }
    // 用应用里那份落盘档案再测一次
    let path = std::path::PathBuf::from(
        "D:/Users/kioco/Desktop/TTV Short Drama/src-tauri/.app-data/hongguo-device.json",
    );
    match HongguoClient::new(Some(path)).await {
        Ok(persisted) => match persisted.resolve_playback(target).await {
            Ok(r) => eprintln!("[diag] 落盘设备 OK: streams={}", r.playback.streams.len()),
            Err(e) => eprintln!("[diag] 落盘设备 失败: {e}"),
        },
        Err(e) => eprintln!("[diag] 载入落盘档案失败: {e}"),
    }
}

#[tokio::test]
#[ignore = "需要真实网络"]
async fn live_dump_cover_url() {
    let client = HongguoClient::new(None).await.expect("client");
    let hits = client.search("末世", 5, 0).await.expect("search");
    let mut out = String::new();
    for h in &hits {
        out.push_str(&h.cover);
        out.push('\n');
    }
    std::fs::write(
        "D:/Users/kioco/Desktop/TTV Short Drama/.tmp/covers.txt",
        &out,
    )
    .unwrap();
    eprintln!("[live] 导出 {} 条封面 URL", hits.len());
    if let Some(first) = hits.first() {
        eprintln!(
            "[live] 首条: {}",
            &first.cover.chars().take(160).collect::<String>()
        );
    }
}
