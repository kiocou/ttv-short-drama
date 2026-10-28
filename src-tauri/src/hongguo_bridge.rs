//! 红果原生客户端与既有命令层的桥接。
//!
//! 这个模块把 `hongguo::client` 的能力接到原来的 worker 调用点上：播放直链、
//! 预签名、目录读取都优先走 Rust 原生实现，worker 只作为失败回退保留。
//!
//! ## 为什么从这里切
//!
//! `ensure_stream_cached` 是「取播放直链」的**唯一入口**（`open_stream` 与
//! `resolve` 都经过它）。在这一处换成原生实现，两条播放链路同时受益，
//! 而且上层命令、前端、缓存结构全都不用改。

use std::path::PathBuf;
use std::sync::OnceLock;

use crate::hongguo::client::HongguoClient;
use serde_json::json;

/// 进程内单例。匿名设备档案要跨请求复用，不能每次新建客户端。
static CLIENT: OnceLock<tokio::sync::Mutex<Option<std::sync::Arc<HongguoClient>>>> =
    OnceLock::new();

fn slot() -> &'static tokio::sync::Mutex<Option<std::sync::Arc<HongguoClient>>> {
    CLIENT.get_or_init(|| tokio::sync::Mutex::new(None))
}

fn profile_path() -> PathBuf {
    crate::app_storage_root()
        .unwrap_or_else(std::env::temp_dir)
        .join("hongguo-device.json")
}

/// 取（必要时创建）原生客户端。
pub async fn client() -> Result<std::sync::Arc<HongguoClient>, String> {
    let mut guard = slot().lock().await;
    if let Some(existing) = guard.as_ref() {
        return Ok(existing.clone());
    }
    let client = HongguoClient::new(Some(profile_path()))
        .await
        .map_err(|e| e.to_string())?;
    let arc = std::sync::Arc::new(client);
    *guard = Some(arc.clone());
    Ok(arc)
}

/// 原生取「播放直链 + 内容密钥」，产出与 worker `stream` 子命令**完全相同**的
/// payload 形状，因此 `store_stream` 与下游全部不用改。
pub async fn fetch_stream_payload(vid: &str) -> Result<serde_json::Value, String> {
    let client = client().await?;
    let resolved = client
        .resolve_playback(vid)
        .await
        .map_err(|e| e.to_string())?;

    let best = resolved
        .playback
        .best_stream()
        .ok_or_else(|| "原生解析没有可用码流".to_string())?;

    // worker 侧 duration_ms 是毫秒，原生模型给的是秒
    let duration_ms = (resolved.playback.duration_seconds.max(0) as i64) * 1000;

    let variants: Vec<serde_json::Value> = resolved
        .playback
        .streams
        .iter()
        .map(|s| {
            json!({
                // `short_drama_app_qualities` 读的是 id/label 这两个键，
                // 缺了它们菜单会全是「原始画质」且无法区分档位。
                "id": s.definition,
                "label": if s.quality.is_empty() { s.definition.clone() } else { s.quality.clone() },
                "definition": s.definition,
                "quality": s.quality,
                "codec": s.codec,
                "width": s.width,
                "height": s.height,
                "bitrate": s.bitrate,
                "size": s.size,
                "url": s.url,
                "backup_url": s.backup_url,
            })
        })
        .collect();

    Ok(json!({
        "ok": true,
        "url": best.url,
        "content_key": resolved
            .content_key
            .as_ref()
            .map(|k| k.hex.clone())
            .unwrap_or_default(),
        "width": best.width,
        "height": best.height,
        "duration_ms": duration_ms,
        "codec": best.codec,
        "bitrate_kbps": best.bitrate / 1000,
        "variants": variants,
        // worker 里这两个是链路常量；原生链路同样按 App 的 UA/Referer 拉流
        // 与 worker 原来的链路常量一致：CDN 认这个 UA/Referer
        "download_ua": "com.phoenix.read/71332",
        "download_referer": "https://novel.snssdk.com/",
    }))
}
