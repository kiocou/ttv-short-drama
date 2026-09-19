#!/usr/bin/env python3
"""动漫源编解码采样 —— 回答"自动档选中的那一集到底是什么编码"。

为什么需要它：dmghg 只给中文档位名（`4K 超清` / `1080P 高清`），**不给编解码信息**，
`width`/`height` 字段恒为 0。而 WebView2 对 HEVC 的支持分路径（原生 `<video>` 走系统
解码器，MSE/hls.js 走 Chromium 自己的 HEVC 通路），同一批源里"MP4 直链播得动、
m3u8 播不动"完全可能。"黑屏但有声音"这个现象无法从档位名判断，只能把真实流拉下来看。

两个实测坑（脚本已绕过，手工排查时也会撞上）：
  1. **分片是伪装成 `.png` 的 MPEG-TS**（`img.nxjunyu.asia` 的播放列表里分片全是
     `v4-kling.kechuangai.com/bs2/imageGameZone/image/*.png`，`content-type: image/png`，
     字节却是标准 188 字节 TS）。ffmpeg 的 HLS 解复用器按扩展名白名单直接拒绝：
     `URL ... is not in allowed_segment_extensions`，于是"探测失败"并不代表流有问题。
     所以本脚本自己下载首段、按内容嗅探容器，再交给 ffmpeg 解析。
  2. 动漫直链里有 200MB+ 的整集 MP4，`-i <url>` 会让 ffmpeg 拉很久。这里只取首 4MB。

用法：
    # 采样观看历史里的动漫集（默认，最贴近真实故障）
    python docs/dmghg-reverse/sample_codecs.py --from-history

    # 指定某剧某集，并把该集所有档位都探一遍
    python docs/dmghg-reverse/sample_codecs.py --series 181467 --part 第01集 --line cn --probe-all

     # 优化中文以历史途径不可用时（如库被清）
    python docs/dmghg-reverse/sample_codecs.py --series dmghg:181412 --part 第17集 --line cn --probe-all

环境变量与 dmghg_bridge.py 相同（DMGHG_INSTALL_DIR / DMGHG_REAL_DLL / DMGHG_LEGACY_HOST）。
"""

from __future__ import annotations

import argparse
import json
import pathlib
import re
import sqlite3
import subprocess
import sys
import tempfile
import urllib.request
from typing import Any

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from dmghg_bridge import DmghgBridge  # noqa: E402

REPO = pathlib.Path(__file__).resolve().parents[2]
FFMPEG = REPO / "src-tauri" / "resources" / "mpv" / "ffmpeg.exe"
DEFAULT_DB = REPO / "src-tauri" / ".app-data" / "short-drama.sqlite3"

UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36"
# 只取首 4MB：够覆盖 ts 首段与 MP4 的 ftyp+moov，又不会去拉 200MB 的整集。
SAMPLE_BYTES = 4 * 1024 * 1024

# 与 Rust `parse_variant_height` 同规则：先 K 档再 P 档，认不出返回 0。
_K_HEIGHT = (("8k", 4320), ("4k", 2160), ("2k", 1440))
_P_RE = re.compile(r"(\d{3,4})p")


def variant_height(name: str) -> int:
    lower = name.lower()
    for token, height in _K_HEIGHT:
        if token in lower:
            return height
    match = _P_RE.search(lower)
    if match and int(match.group(1)) >= 144:
        return int(match.group(1))
    return 0


def pick_auto(variants: list[dict[str, Any]]) -> dict[str, Any]:
    """复刻 Rust `resolve_play_url` 的 auto 规则：2160p 以外的最高档。"""
    ordered = sorted(variants, key=lambda v: variant_height(v.get("name") or ""), reverse=True)
    for variant in ordered:
        if variant_height(variant.get("name") or "") < 2160:
            return variant
    return ordered[0]


def fetch(url: str, max_bytes: int = SAMPLE_BYTES, timeout: int = 30) -> tuple[bytes, dict[str, str]]:
    request = urllib.request.Request(
        url, headers={"User-Agent": UA, "Range": f"bytes=0-{max_bytes - 1}"}
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        headers = {k.lower(): v for k, v in response.headers.items()}
        return response.read(max_bytes), headers


def sniff(data: bytes) -> str:
    """按内容判容器。伪装扩展名的源让扩展名完全不可信。"""
    if len(data) > 376 and data[0] == 0x47 and data[188] == 0x47 and data[376] == 0x47:
        return "mpegts"
    if len(data) > 12 and data[4:8] == b"ftyp":
        return "mp4"
    if data[:4] == b"\x89PNG":
        return "png"
    if data[:2] == b"\xff\xd8":
        return "jpeg"
    # fMP4 分片（moof 开头）
    if len(data) > 8 and data[4:8] in (b"moof", b"styp", b"sidx"):
        return "fmp4"
    return "unknown"


def absolutize(base: str, url: str) -> str:
    if url.startswith("http://") or url.startswith("https://"):
        return url
    if url.startswith("//"):
        return ("https:" if base.startswith("https") else "http:") + url
    root = base.split("/", 3)[:3]
    if url.startswith("/"):
        return "/".join(root) + url
    return base.rsplit("/", 1)[0] + "/" + url


def first_segment(playlist_text: str, playlist_url: str) -> str | None:
    """取播放列表里的第一个媒体地址（master 就下钻一层）。"""
    for line in playlist_text.splitlines():
        stripped = line.strip()
        if stripped and not stripped.startswith("#"):
            return absolutize(playlist_url, stripped)
    return None


def probe_bytes(data: bytes, timeout: int) -> dict[str, Any]:
    container = sniff(data)
    forced = ["-f", "mpegts"] if container == "mpegts" else []
    with tempfile.NamedTemporaryFile(suffix=".bin", delete=False) as handle:
        handle.write(data)
        path = handle.name
    try:
        cmd = [str(FFMPEG), "-hide_banner", "-nostdin", *forced, "-i", path]
        try:
            proc = subprocess.run(
                cmd, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=timeout
            )
            text = (proc.stderr or "") + (proc.stdout or "")
        except subprocess.TimeoutExpired:
            return {"ok": False, "error": f"ffmpeg 超时（{timeout}s）", "container": container}
        except OSError as error:
            return {"ok": False, "error": f"ffmpeg 启动失败: {error}", "container": container}
    finally:
        pathlib.Path(path).unlink(missing_ok=True)

    video = re.search(r"Stream #\d+:\d+.*?: Video: ([A-Za-z0-9_]+)(.*)", text)
    audio = re.search(r"Stream #\d+:\d+.*?: Audio: ([A-Za-z0-9_]+)", text)
    if not video:
        return {
            "ok": False,
            "error": "未解析出视频轨",
            "container": container,
            "acodec": audio.group(1).lower() if audio else None,
        }
    rest = video.group(2)
    size = re.search(r"(\d{2,5})x(\d{2,5})", rest)
    return {
        "ok": True,
        "container": container,
        "vcodec": video.group(1).lower(),
        "width": int(size.group(1)) if size else 0,
        "height": int(size.group(2)) if size else 0,
        "acodec": audio.group(1).lower() if audio else None,
    }


def probe_variant(url: str, timeout: int) -> dict[str, Any]:
    """把一条档位地址探到底：播放列表形态 + 首段真实编码。"""
    info: dict[str, Any] = {"host": url.split("/")[2] if "//" in url else "?"}
    if ".m3u8" in url.lower():
        try:
            playlist, headers = fetch(url, max_bytes=256 * 1024, timeout=timeout)
            text = playlist.decode("utf-8", "replace")
        except Exception as error:  # noqa: BLE001 - 诊断脚本，失败只记录
            return {**info, "ok": False, "playlist": {"kind": "m3u8"}, "error": f"播放列表读取失败: {error}"}
        master = "#EXT-X-STREAM-INF" in text
        info["playlist"] = {
            "kind": "master" if master else "media",
            "codecs": sorted(set(re.findall(r'CODECS="([^"]+)"', text))),
            "encrypted": "#EXT-X-KEY" in text,
            "segment_count": sum(1 for l in text.splitlines() if l.strip() and not l.startswith("#")),
            "content_type": headers.get("content-type"),
        }
        if master:
            target = first_segment(text, url)
            if not target:
                return {**info, "ok": False, "error": "master 播放列表里没有子列表"}
            try:
                playlist, headers = fetch(target, max_bytes=256 * 1024, timeout=timeout)
                text = playlist.decode("utf-8", "replace")
                url = target
            except Exception as error:  # noqa: BLE001
                return {**info, "ok": False, "error": f"子播放列表读取失败: {error}"}
        segment = first_segment(text, url)
        if not segment:
            return {**info, "ok": False, "error": "播放列表里没有分片"}
        info["segment_url"] = segment
        info["segment_ext"] = pathlib.PurePosixPath(segment.split("?")[0]).suffix
        try:
            data, seg_headers = fetch(segment, timeout=timeout)
        except Exception as error:  # noqa: BLE001
            return {**info, "ok": False, "error": f"分片下载失败: {error}"}
        info["segment_content_type"] = seg_headers.get("content-type")
        info.update(probe_bytes(data, timeout))
        return info

    # 直链（多为整集 MP4）：只取首 4MB 交给 ffmpeg。
    try:
        data, headers = fetch(url, timeout=timeout)
    except Exception as error:  # noqa: BLE001
        return {**info, "ok": False, "error": f"直链读取失败: {error}"}
    info["content_type"] = headers.get("content-type")
    info["bytes_read"] = len(data)
    info.update(probe_bytes(data, timeout))
    return info


def sample(bridge: DmghgBridge, series_id: str, part: str, line: str, timeout: int, probe_all: bool) -> dict[str, Any]:
    raw_id = series_id.split(":", 1)[-1]
    result: dict[str, Any] = {"series_id": series_id, "part": part, "line": line}
    try:
        variants = bridge.resolve_play_url(raw_id, part, line)
    except Exception as error:  # noqa: BLE001
        result["error"] = f"解析播放地址失败: {error}"
        return result

    auto = pick_auto(variants)
    findings = []
    for variant in variants if probe_all else [auto]:
        url = variant.get("url") or ""
        findings.append(
            {
                "name": variant.get("name"),
                "url": url,
                "selected_by_auto": variant is auto,
                **probe_variant(url, timeout),
            }
        )
    result["variants"] = findings
    result["auto_name"] = auto.get("name")
    result["auto_codec"] = next(
        (f.get("vcodec") for f in findings if f.get("selected_by_auto")), None
    )
    return result


def history_targets(db: pathlib.Path, limit: int) -> list[tuple[str, str, str]]:
    """观看历史里的动漫集 → (series_id, part, line)。"""
    con = sqlite3.connect(f"file:{db.as_posix()}?mode=ro", uri=True)
    try:
        rows = list(
            con.execute(
                "select series_id, episode_id, title, episode_number, progress_percent from watch_history "
                "where channel = 'anime' and series_id like 'dmghg:%' "
                "order by updated_at desc limit ?",
                (limit,),
            )
        )
    finally:
        con.close()

    targets = []
    for series_id, episode_id, title, number, percent in rows:
        line, _, part = (episode_id or "").partition("|")
        if not part:
            line, part = "cn", episode_id or ""
        if part:
            targets.append((series_id, part, line))
            print(f"[历史] {title} 第{number}集 进度{percent}% -> {series_id} {line}|{part}")
    return targets


def describe(finding: dict[str, Any]) -> str:
    if finding.get("ok"):
        return (
            f"{finding['vcodec']:<6} {finding['width']}x{finding['height']} "
            f"audio={finding['acodec']} container={finding['container']}"
        )
    return f"探测失败: {finding.get('error')} (container={finding.get('container')})"


def survey(bridge: DmghgBridge, limit: int, timeout: int, probe_all: bool) -> list[dict[str, Any]]:
    """抽样：取热门前 N 部动漫的第 1 集，看自动档到底是什么编码。

    观看历史只能告诉你「哪些集被打开过」，告诉不了「哪一集黑屏」；而黑屏的
    候选原因（HEVC / 解码器不支持的编码 / 伪装容器）只取决于源返回的档位，
    与用户看了哪一集无关。所以按热门榜抽样比按历史抽样更能命中问题分布。
    """
    page = bridge.call(
        "catalog.get_video_list",
        {"channel": 0, "page": 1, "limit": limit, "sort": "hits"},
    )
    items = page.get("items") if isinstance(page, dict) else page
    items = items or []
    reports = []
    for item in items:
        series_id = f"dmghg:{item.get('id')}"
        title = item.get("name")
        try:
            detail = bridge.get_detail(item.get("id"))
            parts = (detail or {}).get("parts") or []
            names = (parts[0].get("part") if parts else None) or []
            line = (parts[0].get("play") if parts else None) or "cn"
            part = names[0]
        except Exception as error:  # noqa: BLE001
            print(f"  {title}: 详情失败 {error}")
            continue
        if not part:
            print(f"  {title}: 线路无集名")
            continue
        print(f"\n=== {title} ({series_id}) {line}|{part} ===", flush=True)
        report = sample(bridge, series_id, part, line, timeout, probe_all)
        report["title"] = title
        reports.append(report)
        if report.get("error"):
            print(f"  !! {report['error']}")
            continue
        for finding in report["variants"]:
            flag = "  <-auto" if finding["selected_by_auto"] else ""
            segment = finding.get("segment_ext") or ""
            print(
                f"  {finding['name']!r:<14} {describe(finding)}"
                f"{(' seg=' + segment) if segment else ''}{flag}",
                flush=True,
            )
    return reports


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="动漫源编解码采样")
    parser = argparse.ArgumentParser(description="动漫源编解码采样")
    parser.add_argument("--series", help="视频 id（可带 dmghg: 前缀）")
    parser.add_argument("--part", help="集名，如 第01集")
    parser.add_argument("--line", default="cn", help="线路代码，默认 cn")
    parser.add_argument("--from-history", action="store_true", help="采样观看历史里的动漫集")
    parser.add_argument("--db", type=pathlib.Path, default=DEFAULT_DB)
    parser.add_argument("--limit", type=int, default=6)
    parser.add_argument("--timeout", type=int, default=40)
    parser.add_argument("--probe-all", action="store_true", help="每个档位都探（默认只探自动档）")
    parser.add_argument("--json", type=pathlib.Path, help="把完整结果另外写成 JSON")
    parser.add_argument("--survey", type=int, help="抽样热门榜前 N 部的第 1 集")
    parser.add_argument("--url", help="直接探一条地址的真实编码（不经过 dmghg）")
    args = parser.parse_args(argv)

    if args.url:
        print("=== 直探 URL ===")
        print(json.dumps(probe_variant(args.url, args.timeout), ensure_ascii=False, indent=2))
        return 0

    if not FFMPEG.is_file():
        print(f"找不到 ffmpeg: {FFMPEG}", file=sys.stderr)
        return 2

    if args.from_history:
        if not args.db.is_file():
            print(f"找不到历史库: {args.db}", file=sys.stderr)
            return 2
        targets = history_targets(args.db, args.limit)
    elif args.series and args.part:
        targets = [(args.series, args.part, args.line)]
    elif args.survey:
        targets = []  # 抽样模式自己取目标
    else:
        parser.error("要么 --from-history / --survey，要么同时给 --series 与 --part")
        return 2

    reports = []
    with DmghgBridge() as bridge:
        if args.survey:
            reports = survey(bridge, args.survey, args.timeout, args.probe_all)
            if args.json:
                args.json.write_text(json.dumps(reports, ensure_ascii=False, indent=2), encoding="utf-8")
                print(f"\n完整结果已写入 {args.json}")
            return 0
        for series_id, part, line in targets:
            print(f"\n=== {series_id} {line}|{part} ===", flush=True)
            report = sample(bridge, series_id, part, line, args.timeout, args.probe_all)
            reports.append(report)
            if report.get("error"):
                print(f"  !! {report['error']}")
                continue
            for finding in report["variants"]:
                flag = "  <-auto" if finding["selected_by_auto"] else ""
                segment = finding.get("segment_ext") or ""
                print(f"  {finding['name']!r:<14} {describe(finding)}{(' seg=' + segment) if segment else ''}{flag}", flush=True)

    if args.json:
        args.json.write_text(json.dumps(reports, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"\n完整结果已写入 {args.json}")
    return 0


if __name__ == "__main__":
    sys.exit(main())