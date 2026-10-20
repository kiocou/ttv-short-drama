#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""guo 源站「真实播放」测速探针 —— 可重复运行，只读，不改应用源码。

设计：用 ctypes 直接驱动 duanju_core.dll，完全复刻 app 的调用顺序
    initialize(directory) → saveResourceSettings(proxyMode) →
    catalog(force=True) → detail → resolve(quality=0, force=True) → release

再对 resolve 得到的本机媒体地址（http://127.0.0.1:<port>/<token>/<hash>）
用 requests 做一次只读 GET，量出 playlist / 首片 / 连续分片的真实耗时与吞吐。
注意：本机地址必须绕过系统代理（trust_env=False），否则 127.0.0.1 也会被代理。

用法：
    python probe_playback.py --rounds 1 --sources huangdou,maoguo,fanguo
    python probe_playback.py --rounds 3 --proxy direct
    python probe_playback.py --rounds 2 --proxy system --out .tmp/probe-system.json

输出：
    * stdout 每源每轮一行 JSON（PLAYBACK 前缀 + 单行 JSON）
    * stderr 进度
    * --out 聚合 + raw 结果 JSON
"""

import argparse
import ctypes
import json
import math
import os
import re
import shutil
import statistics
import sys
import tempfile
import time
from datetime import datetime
from urllib.parse import urljoin

import requests

# ---------------------------------------------------------------- 常量配置

ALL_SOURCES = [
    "hongguo", "huangdou", "huangju", "yeguo", "dsd", "huangguoai", "huangguo-video",
    "yaguo", "maoguo", "fanguo", "guanguo", "heguo", "xingguo", "huaguo",
    "niuguo", "wangguo", "faguo", "piguo", "wuguo",
]

# 单源每轮的整体预算（秒）：超出后不再发起新步骤，避免整轮卡死
SOURCE_BUDGET_SECONDS = 30.0

CONNECT_TIMEOUT = 8.0
READ_TIMEOUT = 15.0
MEDIA_TIMEOUT = (CONNECT_TIMEOUT, READ_TIMEOUT)

PLAYLIST_CAP_BYTES = 4 << 20        # 播放列表读取上限
PLAYLIST_CAP_SECONDS = 12.0
SEGMENT_CAP_BYTES = 8 << 20         # 单个分片上限 8MB
SEGMENT_CAP_SECONDS = 8.0           # 或 8s

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36")

# 播放链路关键步骤（评分与连续性判定共用）
STEP_KEYS = ("catalog", "detail", "resolve", "playlist", "first_seg")

# 序列号与 Rust 侧 next_sequence 同构：全局严格递增
SEQUENCE_START = 1_000_000


def resolve_dll_path():
    default = os.path.normpath(os.path.join(
        os.path.dirname(os.path.abspath(__file__)), "..", "..", "resources", "guo-core", "duanju_core.dll"
    ))
    return os.environ.get("TTV_GUO_CORE_DLL") or default


def r1(value):
    """毫秒/数值保留 1 位小数。"""
    return None if value is None else round(float(value), 1)


# ---------------------------------------------------------------- DLL 驱动


class Guocore:
    """duanju_core.dll 的极薄包装，只用 diag 需要的 action。"""

    def __init__(self, dll_path, directory, proxy_mode):
        if not os.path.exists(dll_path):
            raise SystemExit(f"找不到 duanju_core.dll: {dll_path}\n可设环境变量 TTV_GUO_CORE_DLL 指定路径。")
        self.lib = ctypes.CDLL(dll_path)
        self.lib.DuanjuRequest.restype = ctypes.c_char_p
        self.lib.DuanjuRequest.argtypes = [ctypes.c_char_p]
        self.sequence = SEQUENCE_START
        self.directory = directory
        self.proxy_mode = proxy_mode

        result = self.req({"action": "initialize", "directory": directory})
        if not result.get("ok"):
            raise SystemExit(f"initialize 失败: {result}")
        result = self.req({"action": "saveResourceSettings", "settings": {
            "proxyMode": proxy_mode,
            "catalogConcurrency": 3,
            "catalogIntervalMs": 250,
            "downloadConcurrency": 2,
        }})
        if not result.get("ok"):
            raise SystemExit(f"saveResourceSettings 失败: {result}")

    def req(self, payload):
        raw = self.lib.DuanjuRequest(json.dumps(payload).encode("utf-8"))
        if raw is None:
            raise RuntimeError("DuanjuRequest 返回空指针")
        return json.loads(raw.decode("utf-8"))

    def next_sequence(self):
        self.sequence += 1
        return self.sequence


# ---------------------------------------------------------------- HTTP 工具


def new_http():
    """本地地址必须绕过系统代理：trust_env=False 同时忽略环境变量与 .netrc。"""
    http = requests.Session()
    http.trust_env = False
    http.proxies = {}
    return http


def consume(resp, cap_bytes, cap_seconds, first_ms=None, start=None, keep=False):
    """读完（或读到上限）一个流式响应，返回 {bytes, ms, first_byte_ms, truncated, body}。"""
    if start is None:
        start = time.perf_counter()
    total = 0
    body = bytearray()
    truncated = False
    try:
        for chunk in resp.iter_content(65536):
            if not chunk:
                continue
            if first_ms is None:
                first_ms = (time.perf_counter() - start) * 1000.0
            total += len(chunk)
            if keep:
                body += chunk
            if total >= cap_bytes:
                truncated = True
                break
            if (time.perf_counter() - start) >= cap_seconds:
                truncated = True
                break
    finally:
        resp.close()
    elapsed_ms = (time.perf_counter() - start) * 1000.0
    return {
        "bytes": total,
        "ms": elapsed_ms,
        "first_byte_ms": first_ms,
        "truncated": truncated,
        "body": bytes(body),
    }


def throughput_kbps(size_bytes, elapsed_ms):
    if not size_bytes or not elapsed_ms or elapsed_ms <= 0:
        return None
    return round(size_bytes * 8.0 / elapsed_ms, 1)   # bytes*8/ms == kbit/s


ATTR_RE = re.compile(r'([A-Za-z0-9-]+)=("[^"]*"|[^,]*)')


def parse_attrs(text):
    attrs = {}
    for match in ATTR_RE.finditer(text):
        key = match.group(1).upper()
        value = match.group(2).strip().strip('"')
        attrs[key] = value
    return attrs


def parse_playlist(text):
    """返回 (variants, segments)。

    variants: [{"bandwidth": int|None, "resolution": str|None, "uri": str|None}]
    segments: [str]  媒体分片/子清单相对地址，按出现顺序
    """
    variants = []
    segments = []
    expect_variant_uri = False
    for raw in text.replace("\r\n", "\n").replace("\r", "\n").split("\n"):
        line = raw.strip()
        if not line:
            continue
        if line.startswith("#EXT-X-STREAM-INF:"):
            attrs = parse_attrs(line.split(":", 1)[1])
            bandwidth = None
            try:
                bandwidth = int(attrs.get("BANDWIDTH", ""))
            except ValueError:
                bandwidth = None
            variants.append({
                "bandwidth": bandwidth,
                "resolution": attrs.get("RESOLUTION"),
                "uri": None,
            })
            expect_variant_uri = True
            continue
        if line.startswith("#"):
            continue
        if expect_variant_uri:
            if variants and variants[-1]["uri"] is None:
                variants[-1]["uri"] = line
            expect_variant_uri = False
        else:
            segments.append(line)
    return variants, segments


def safe_text(data, limit=240):
    return data[:limit].decode("utf-8", "replace").replace("\n", " ")[:limit]


# ---------------------------------------------------------------- 播放测速


def probe_hls(http, playlist_url, text, out):
    """解析播放列表：master 取最高码率子清单，再下第 1/2/3 个媒体分片。"""
    variants, segments = parse_playlist(text)
    out["playlist_kind"] = "master" if variants else "media"
    if variants:
        out["variants"] = len(variants)
        bandwidths = [v["bandwidth"] for v in variants if v["bandwidth"]]
        out["top_bandwidth"] = max(bandwidths) if bandwidths else None
        resolutions = [v["resolution"] for v in variants if v["resolution"]]
        out["top_resolution"] = max(resolutions, key=lambda r: _pixels(r)) if resolutions else None
        # 取最高码率子清单（app 的 nativePlaybackChoice 也是按 Quality 降序首选项）
        ranked = sorted([v for v in variants if v.get("uri")],
                        key=lambda v: (v["bandwidth"] or 0, _pixels(v["resolution"])), reverse=True)
        if not ranked:
            raise RuntimeError("master 播放列表里没有可用的子清单地址")
        child_url = urljoin(playlist_url, ranked[0]["uri"])
        start = time.perf_counter()
        resp = http.get(child_url, stream=True, timeout=MEDIA_TIMEOUT,
                        headers={"User-Agent": UA, "Accept": "*/*", "Accept-Encoding": "identity"})
        child = consume(resp, PLAYLIST_CAP_BYTES, PLAYLIST_CAP_SECONDS, keep=True, start=start)
        out["child_playlist_status"] = resp.status_code
        out["child_playlist_ms"] = r1(child["ms"])
        out["child_playlist_bytes"] = child["bytes"]
        # playlist_ms 计为「整个播放列表阶段」（master + 子清单），便于 total_open 直接相加
        out["playlist_ms"] = r1((out.get("playlist_ms") or 0.0) + child["ms"])
        if resp.status_code >= 400:
            raise RuntimeError(f"子清单 HTTP {resp.status_code}: {safe_text(child['body'])}")
        child_text = child["body"].lstrip(b"\xef\xbb\xbf").decode("utf-8", "replace")
        if not child_text.strip().startswith("#EXTM3U"):
            raise RuntimeError(f"子清单不是 m3u8: {child_text[:80]!r}")
        base_url = child_url
        _, segments = parse_playlist(child_text)
    else:
        out["variants"] = 0
        base_url = playlist_url

    if not segments:
        raise RuntimeError("媒体播放列表里没有分片")

    rows = []
    for index, reference in enumerate(segments[:3], start=1):
        segment_url = urljoin(base_url, reference)
        try:
            start = time.perf_counter()
            resp = http.get(segment_url, stream=True, timeout=MEDIA_TIMEOUT,
                            headers={"User-Agent": UA, "Accept": "*/*", "Accept-Encoding": "identity"})
            stat = consume(resp, SEGMENT_CAP_BYTES, SEGMENT_CAP_SECONDS, start=start)
            status = resp.status_code
            if status >= 400 or stat["bytes"] <= 0:
                rows.append({"index": index, "ok": False, "status": status,
                             "error": f"HTTP {status} / {stat['bytes']}B"})
                continue
            rows.append({
                "index": index, "ok": True, "status": status,
                "ms": r1(stat["ms"]), "first_byte_ms": r1(stat["first_byte_ms"]),
                "bytes": stat["bytes"], "truncated": stat["truncated"],
                "kbps": throughput_kbps(stat["bytes"], stat["ms"]),
            })
        except Exception as error:                       # 分片级失败不打断整源
            rows.append({"index": index, "ok": False, "error": repr(error)[:160]})

    out["segments"] = rows
    first = rows[0]
    out["first_seg_ok"] = bool(first.get("ok"))
    if first.get("ok"):
        out["first_seg_ms"] = first["ms"]
        out["first_seg_bytes"] = first["bytes"]
        out["first_seg_ttfb_ms"] = first.get("first_byte_ms")
        out["throughput_kbps"] = first.get("kbps")
    else:
        out["first_seg_error"] = first.get("error") or "首片下载失败"
    for row in rows[1:3]:
        slot = "seg2" if row["index"] == 2 else "seg3"
        out[f"{slot}_ok"] = bool(row.get("ok"))
        if row.get("ok"):
            out[f"{slot}_ms"] = row["ms"]
            out[f"{slot}_kbps"] = row.get("kbps")
        else:
            out[f"{slot}_error"] = row.get("error") or "分片下载失败"
    ok_count = sum(1 for row in rows if row.get("ok"))
    out["seg_ok"] = ok_count
    out["seg_attempt"] = len(rows)


def _pixels(resolution):
    if not resolution:
        return 0
    match = re.match(r"(\d+)\s*[xX*]\s*(\d+)", str(resolution))
    if not match:
        return 0
    return int(match.group(1)) * int(match.group(2))


def probe_media(http, url):
    """对 resolve 得到的本机媒体地址做一次真实播放测速。"""
    out = {
        "resolve_url_host": url.split("/")[2] if "//" in url else "",
        "playlist_status": None,
        "playlist_kind": None,
        "playlist_ttfb_ms": None,
        "playlist_ms": None,
        "playlist_bytes": 0,
        "first_seg_ok": False,
    }
    start = time.perf_counter()
    resp = http.get(url, stream=True, timeout=MEDIA_TIMEOUT,
                    headers={"User-Agent": UA, "Accept": "*/*", "Accept-Encoding": "identity"},
                    allow_redirects=True)
    first_ms = None
    total = 0
    head = b""
    body = bytearray()
    try:
        out["playlist_status"] = resp.status_code
        content_type = (resp.headers.get("Content-Type") or "").lower()
        iterator = resp.iter_content(16384)
        for chunk in iterator:
            if not chunk:
                continue
            first_ms = (time.perf_counter() - start) * 1000.0
            head = chunk
            total = len(chunk)
            break
        if resp.status_code >= 400:
            raise RuntimeError(f"播放地址 HTTP {resp.status_code}: {safe_text(head)}")
        sniff = head.lstrip(b"\xef\xbb\xbf").lstrip()
        is_hls = ("mpegurl" in content_type) or sniff.startswith(b"#EXTM3U")
        if is_hls:
            body += head
            for chunk in iterator:
                if not chunk:
                    continue
                body += chunk
                total += len(chunk)
                if total >= PLAYLIST_CAP_BYTES or (time.perf_counter() - start) >= PLAYLIST_CAP_SECONDS:
                    break
            out["playlist_ttfb_ms"] = r1(first_ms)
            out["playlist_ms"] = r1((time.perf_counter() - start) * 1000.0)
            out["playlist_bytes"] = total
            out["playlist_ok"] = True
        else:
            # file 源：首个响应就是二进制流，只取首块用于确认可用，随后单独发 Range 请求
            out["playlist_kind"] = "file"
            out["playlist_ttfb_ms"] = r1(first_ms)
            out["playlist_ms"] = r1((time.perf_counter() - start) * 1000.0)
            out["playlist_bytes"] = total
            out["playlist_ok"] = total > 0
            out["file_content_type"] = content_type or None
            out["file_content_length"] = resp.headers.get("Content-Length")
            out["file_accept_ranges"] = resp.headers.get("Accept-Ranges")
    finally:
        resp.close()

    if out["playlist_kind"] == "file":
        probe_file(http, url, out)
        return out

    text = body.lstrip(b"\xef\xbb\xbf").decode("utf-8", "replace")
    if not text.strip().startswith("#EXTM3U"):
        raise RuntimeError(f"播放列表无效（前 80 字节: {text[:80]!r}）")
    probe_hls(http, url, text, out)
    return out


def probe_file(http, url, out):
    """file（mp4）源：Range 拉 4MB 或 8s，量首片时间与吞吐。"""
    headers = {"User-Agent": UA, "Accept": "*/*", "Accept-Encoding": "identity",
               "Range": "bytes=0-4194303"}
    start = time.perf_counter()
    resp = http.get(url, stream=True, timeout=MEDIA_TIMEOUT, headers=headers, allow_redirects=True)
    try:
        out["range_status"] = resp.status_code
        stat = consume(resp, SEGMENT_CAP_BYTES, SEGMENT_CAP_SECONDS, start=start)
    finally:
        resp.close()
    if resp.status_code >= 400 or stat["bytes"] <= 0:
        out["first_seg_ok"] = False
        out["first_seg_error"] = f"Range HTTP {resp.status_code} / {stat['bytes']}B"
        return
    out["first_seg_ok"] = True
    out["first_seg_ms"] = r1(stat["ms"])
    out["first_seg_ttfb_ms"] = r1(stat["first_byte_ms"])
    out["first_seg_bytes"] = stat["bytes"]
    out["first_seg_truncated"] = stat["truncated"]
    out["throughput_kbps"] = throughput_kbps(stat["bytes"], stat["ms"])
    out["seg_ok"] = 1
    out["seg_attempt"] = 1


# ---------------------------------------------------------------- 单源单轮


def pick_index(round_index, item_count):
    """按轮次轮换目录里的前 3 条，避免每轮都测同一部剧。"""
    span = min(3, item_count)
    return (round_index - 1) % span if span else 0


def probe_once(core, http, source, round_index):
    row = {
        "round": round_index,
        "source": source,
        "ts": datetime.now().isoformat(timespec="seconds"),
    }
    deadline = time.monotonic() + SOURCE_BUDGET_SECONDS

    def remaining():
        return deadline - time.monotonic()

    def budget_exhausted(step):
        if remaining() <= 0:
            row[f"{step}_ok"] = False
            row[f"{step}_error"] = f"单源超时({SOURCE_BUDGET_SECONDS:.0f}s)预算耗尽"
            return True
        return False

    session_token = None
    try:
        # 1) 目录：force 走网络（等价 app 的 catalog_refresh）
        if budget_exhausted("catalog"):
            return row
        start = time.perf_counter()
        result = core.req({"action": "catalog", "source": source, "category": "",
                           "query": "", "page": 1, "force": True})
        row["catalog_ms"] = r1((time.perf_counter() - start) * 1000.0)
        if not result.get("ok"):
            row["catalog_ok"] = False
            row["catalog_error"] = str(result.get("error"))[:200]
            return row
        items = (result.get("data") or {}).get("items") or []
        row["catalog_ok"] = True
        row["catalog_items"] = len(items)
        if not items:
            row["detail_ok"] = False
            row["detail_error"] = "目录为空"
            return row

        # 2) 详情：按轮次取第 (round-1)%min(3,items) 条
        index = pick_index(round_index, len(items))
        drama = items[index]
        raw_id = str(drama.get("sourceId") or drama.get("id") or "").split(":")[-1]
        row["detail_pick"] = index
        row["detail_item"] = {"id": raw_id, "title": drama.get("title")}
        if budget_exhausted("detail"):
            return row
        start = time.perf_counter()
        result = core.req({"action": "detail", "drama": {"id": f"{source}:{raw_id}", "source": source}})
        row["detail_ms"] = r1((time.perf_counter() - start) * 1000.0)
        if not result.get("ok"):
            row["detail_ok"] = False
            row["detail_error"] = str(result.get("error"))[:200]
            return row
        data = result.get("data") or {}
        chapters = data.get("chapters") or []
        row["detail_ok"] = True
        row["detail_chapters"] = len(chapters)
        if not chapters:
            row["resolve_ok"] = False
            row["resolve_error"] = "详情没有剧集"
            return row

        # 3) 解析播放：与 app 的 open_episode 同参（index=1、quality=0、force=True）
        if budget_exhausted("resolve"):
            return row
        start = time.perf_counter()
        result = core.req({"action": "resolve", "drama": data.get("drama"),
                           "chapter": chapters[0], "index": 1,
                           "quality": 0, "sequence": core.next_sequence(), "force": True})
        row["resolve_ms"] = r1((time.perf_counter() - start) * 1000.0)
        if not result.get("ok"):
            row["resolve_ok"] = False
            row["resolve_error"] = str(result.get("error"))[:200]
            return row
        plan = result.get("data") or {}
        url = plan.get("url") or ""
        session_token = plan.get("session")
        row["resolve_quality"] = plan.get("quality")
        row["resolve_route"] = f"{(plan.get('routeIndex') or 0) + 1}/{plan.get('routeCount') or 1}"
        if not url:
            row["resolve_ok"] = False
            row["resolve_error"] = "resolve 返回空播放地址"
            return row
        row["resolve_ok"] = True
        row["resolve_url"] = url
        row["resolve_kind"] = "hls" if url.split("?")[0].lower().endswith(".m3u8") else "file"

        # 4) 播放测速
        if budget_exhausted("playlist"):
            return row
        try:
            row.update(probe_media(http, url))
        except Exception as error:
            row["playlist_ok"] = False
            row["playlist_error"] = repr(error)[:200]
            row["first_seg_ok"] = False
            row["first_seg_error"] = row["playlist_error"]
            return row

        # 5) 起播体验（不含 catalog）：detail + resolve + playlist + first_seg
        parts = [row.get("detail_ms"), row.get("resolve_ms"),
                 row.get("playlist_ms"), row.get("first_seg_ms")]
        if all(part is not None for part in parts):
            row["total_open_ms"] = r1(sum(parts))
        return row
    except Exception as error:                            # 任何异常都不能中断整轮
        row["error"] = repr(error)[:200]
        return row
    finally:
        if session_token:
            try:
                released = core.req({"action": "release", "session": session_token})
                row["release_ok"] = bool(released.get("ok"))
            except Exception as error:
                row["release_ok"] = False
                row["release_error"] = repr(error)[:120]


# ---------------------------------------------------------------- 聚合与评分


def median(values):
    clean = [float(value) for value in values if value is not None]
    return round(statistics.median(clean), 1) if clean else None


def max_consecutive_failure(rows, key):
    longest = current = 0
    for row in sorted(rows, key=lambda item: item.get("round") or 0):
        if key == "playlist":
            ok = row.get("playlist_ok")
        elif key == "first_seg":
            ok = row.get("first_seg_ok")
        else:
            ok = row.get(f"{key}_ok")
        if ok is False:
            current += 1
            longest = max(longest, current)
        elif ok is True:
            current = 0
    return longest


def score_of(steps_rate, total_open_ms, kbps):
    """可播放性 50 + 起播速度 30 + 吞吐 20 = 100。"""
    playability = sum(10.0 * steps_rate[key] for key in STEP_KEYS)

    if total_open_ms is None:
        speed = 0.0
    elif total_open_ms <= 2000:
        speed = 30.0
    else:
        # 每慢 1000ms（不足 1000ms 的按一段计）扣 5 分，最低 0
        speed = max(0.0, 30.0 - 5.0 * math.ceil((total_open_ms - 2000.0) / 1000.0))

    if not kbps:
        bandwidth = 0.0
    else:
        bandwidth = max(0.0, min(20.0, 20.0 * kbps / 2500.0))

    return round(playability + speed + bandwidth, 1), {
        "playability": round(playability, 1),
        "startup": round(speed, 1),
        "bandwidth": round(bandwidth, 1),
    }


def aggregate(raw, sources):
    summary = {}
    for source in sources:
        rows = [row for row in raw if row["source"] == source]
        rounds = len(rows)
        steps = {}
        steps_rate = {}
        for key in STEP_KEYS:
            if key == "playlist":
                oks = [row.get("playlist_ok") for row in rows]
            elif key == "first_seg":
                oks = [row.get("first_seg_ok") for row in rows]
            else:
                oks = [row.get(f"{key}_ok") for row in rows]
            ok_count = sum(1 for ok in oks if ok)
            rate = (ok_count / rounds) if rounds else 0.0
            steps_rate[key] = rate
            steps[key] = {
                "ok": ok_count,
                "rounds": rounds,
                "rate": round(rate, 3),
                "median_ms": median([row.get(f"{key}_ms") for row, ok in zip(rows, oks) if ok]),
            }

        medians = {
            "catalog_ms": median([row.get("catalog_ms") for row in rows if row.get("catalog_ok")]),
            "detail_ms": median([row.get("detail_ms") for row in rows if row.get("detail_ok")]),
            "resolve_ms": median([row.get("resolve_ms") for row in rows if row.get("resolve_ok")]),
            "playlist_ms": median([row.get("playlist_ms") for row in rows if row.get("playlist_ok")]),
            "playlist_ttfb_ms": median([row.get("playlist_ttfb_ms") for row in rows if row.get("playlist_ok")]),
            "first_seg_ms": median([row.get("first_seg_ms") for row in rows if row.get("first_seg_ok")]),
            "throughput_kbps": median([row.get("throughput_kbps") for row in rows if row.get("first_seg_ok")]),
            "total_open_ms": median([row.get("total_open_ms") for row in rows if row.get("total_open_ms")]),
            "seg_stability": median([(row.get("seg_ok") or 0) / row["seg_attempt"]
                                     for row in rows if row.get("seg_attempt")]),
        }

        consecutive = {key: max_consecutive_failure(rows, key) for key in STEP_KEYS}
        critical_fail = any(value >= 2 for value in consecutive.values())

        score, breakdown = score_of(steps_rate, medians["total_open_ms"], medians["throughput_kbps"])
        if critical_fail:
            verdict = "drop"
        elif score >= 70:
            verdict = "keep"
        elif score >= 45:
            verdict = "watch"
        else:
            verdict = "drop"

        summary[source] = {
            "rounds": rounds,
            "rounds_fully_ok": sum(1 for row in rows if row.get("first_seg_ok")),
            "success_rate": round(sum(1 for row in rows if row.get("first_seg_ok")) / rounds, 3) if rounds else 0.0,
            "steps": steps,
            "medians": medians,
            "consecutive_failures": consecutive,
            "score": score,
            "score_breakdown": breakdown,
            "verdict": verdict,
            "errors": [f"r{row['round']}: {row.get('catalog_error') or row.get('detail_error') or row.get('resolve_error') or row.get('playlist_error') or row.get('first_seg_error')}"
                       for row in rows
                       if (row.get("catalog_error") or row.get("detail_error") or row.get("resolve_error")
                           or row.get("playlist_error") or row.get("first_seg_error"))],
        }
    return summary


def fmt(value, spec=".0f", dash="-"): 
    return dash if value is None else format(value, spec)


def print_tables(summary):
    header = ["source", "open", "cat", "det", "res", "play", "seg1", "kbps", "ok", "stab", "score", "verdict"]
    rows = []
    for source, info in summary.items():
        med = info["medians"]
        rows.append([
            source,
            fmt(med["total_open_ms"]),
            fmt(med["catalog_ms"]),
            fmt(med["detail_ms"]),
            fmt(med["resolve_ms"]),
            fmt(med["playlist_ms"]),
            fmt(med["first_seg_ms"]),
            fmt(med["throughput_kbps"]),
            f"{info['steps']['first_seg']['ok']}/{info['rounds']}",
            f"{(med['seg_stability'] or 0) * 100:.0f}%",
            f"{info['score']:.0f}",
            info["verdict"],
        ])
    rows.sort(key=lambda item: (item[1] == "-", float(item[1]) if item[1] != "-" else 0))

    widths = [max(len(header[i]), *(len(row[i]) for row in rows)) if rows else len(header[i])
              for i in range(len(header))]
    line = "  ".join(text.ljust(widths[i]) for i, text in enumerate(header))
    print("\n=== 按 total_open_ms 升序（单位 ms / kbps）===", file=sys.stderr)
    print(line, file=sys.stderr)
    print("  ".join("-" * width for width in widths), file=sys.stderr)
    for row in rows:
        print("  ".join(text.ljust(widths[i]) for i, text in enumerate(row)), file=sys.stderr)
    print(line)
    for row in rows:
        print("  ".join(text.ljust(widths[i]) for i, text in enumerate(row)))


# ---------------------------------------------------------------- 主流程


def main(argv=None):
    parser = argparse.ArgumentParser(description="guo 源站播放测速探针（只读）")
    parser.add_argument("--rounds", type=int, default=3, help="轮数，默认 3")
    parser.add_argument("--proxy", choices=["direct", "system"], default="direct",
                        help="direct→proxyMode=direct；system→proxyMode=auto（跟随系统代理 127.0.0.1:10808）")
    parser.add_argument("--sources", default="", help="逗号分隔的源 id，默认全部 19 个")
    parser.add_argument("--out", default="", help="结果 JSON 路径，默认 .tmp/probe-playback-<时间戳>.json")
    args = parser.parse_args(argv)

    rounds = max(1, args.rounds)
    if args.sources.strip():
        sources = [item.strip() for item in args.sources.split(",") if item.strip()]
        unknown = [item for item in sources if item not in ALL_SOURCES]
        if unknown:
            print(f"未知源 id 已忽略: {','.join(unknown)}", file=sys.stderr)
        sources = [item for item in sources if item in ALL_SOURCES]
    else:
        sources = list(ALL_SOURCES)
    if not sources:
        raise SystemExit("没有可测的源")

    proxy_mode = "direct" if args.proxy == "direct" else "auto"
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    out_path = args.out or os.path.join(".tmp", f"probe-playback-{stamp}.json")
    out_dir = os.path.dirname(os.path.abspath(out_path))
    os.makedirs(out_dir, exist_ok=True)

    data_dir = os.path.join(tempfile.gettempdir(), "ttv-guo-playback-probe")
    shutil.rmtree(data_dir, ignore_errors=True)
    os.makedirs(data_dir, exist_ok=True)

    dll = resolve_dll_path()
    core = Guocore(dll, data_dir, proxy_mode)
    proxy_note = "直连" if proxy_mode == "direct" else "跟随系统代理(127.0.0.1:10808)"
    print(f"[init] dll={dll}", file=sys.stderr)
    print(f"[init] proxyMode={proxy_mode} ({proxy_note}) rounds={rounds} sources={len(sources)}", file=sys.stderr)

    http = new_http()
    started = time.time()
    raw = []
    try:
        for round_index in range(1, rounds + 1):
            for order, source in enumerate(sources, start=1):
                begin = time.perf_counter()
                row = probe_once(core, http, source, round_index)
                row["wall_s"] = r1(time.perf_counter() - begin)
                raw.append(row)
                print("PLAYBACK " + json.dumps(row, ensure_ascii=False), flush=True)
                flag = "OK " if row.get("first_seg_ok") else "ERR"
                print(f"[r{round_index} {order}/{len(sources)}] {source:16s} {flag} "
                      f"open={fmt(row.get('total_open_ms'))}ms seg1={fmt(row.get('first_seg_ms'))}ms "
                      f"kbps={fmt(row.get('throughput_kbps'))} ({row['wall_s']:.1f}s)",
                      file=sys.stderr, flush=True)
    finally:
        http.close()

    summary = aggregate(raw, sources)
    elapsed = time.time() - started
    print(f"\n[总耗时] {elapsed:.1f}s", file=sys.stderr)
    print_tables(summary)

    payload = {
        "rounds": rounds,
        "proxy": args.proxy,
        "proxy_mode": proxy_mode,
        "sources_requested": sources,
        "generated_at": datetime.now().isoformat(timespec="seconds"),
        "elapsed_s": round(elapsed, 1),
        "timeouts": {"source_budget_s": SOURCE_BUDGET_SECONDS,
                     "connect_s": CONNECT_TIMEOUT, "read_s": READ_TIMEOUT,
                     "segment_cap_bytes": SEGMENT_CAP_BYTES,
                     "segment_cap_s": SEGMENT_CAP_SECONDS},
        "sources": summary,
        "raw": raw,
    }
    with open(out_path, "w", encoding="utf-8") as handle:
        json.dump(payload, handle, ensure_ascii=False, indent=1)
    print(f"\n[写出] {out_path}", file=sys.stderr)

    shutil.rmtree(data_dir, ignore_errors=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
