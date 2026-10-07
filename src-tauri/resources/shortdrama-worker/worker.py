# -*- coding: utf-8 -*-
"""TTV Box 短剧 App-API 解析 worker（单次进程，无状态）。

用法:
    python worker.py resolve <vid>     下载+CENC 解密为本地 mp4（锁定集兜底管线）
    python worker.py stream <vid>      只解出直链+CENC 密钥，不下载（锁定集秒开）
    python worker.py album <series_id> 专辑详情（全集 vid 顺序 + 每集锁定态）

环境变量（由 Rust 侧注入）:
    TTV_SD_DEVICE_ID / TTV_SD_INSTALL_ID  番茄小说设备凭据（必填）
    TTV_SD_DEVICE_TOKEN                   服务端下发的 device_token（x-tt-dt 头，选填）
    TTV_SD_CDID / TTV_SD_OPENUDID         设备指纹（选填，写入 g99 query）
    TTV_SD_CONTENT_TYPE / TTV_SD_AID      短剧 1/8662，漫剧 1004|1007/8704
    TTV_SD_FFMPEG                          ffmpeg 可执行文件路径（resolve 必填）
    TTV_SD_OUT                             输出 mp4 路径（resolve 必填）

协议: stdout 逐行输出 JSON。过程行为 {"event":"progress", ...}，
最终行为 {"ok":true,...}（各子命令字段不同），
失败时 {"ok":false,"error":"..."} 并以非零码退出。

接口形态与 2026-09 红果/番茄 APK 逆向结论一致（PlayerApiService 全部
`$POST /novel/player/*/v1/`、JSON 序列化）:
  - multi_video_model: 取 video_model.fallback_api → GET 解析 video_info.data
  - album_detail: album_data + video_detail_data，EpisodeInfo{vid,vid_index,
    need_unlock} 给出全集顺序与锁定态
  - key_seed AES 解密出真实 main_url；spade_a 派生 CENC 内容密钥
"""
from __future__ import annotations

import base64
import binascii
import hashlib
import json
import os
import re
import subprocess
import sys
import time
import uuid
from pathlib import Path
from urllib.parse import parse_qsl, quote, urlsplit, urlunsplit

# 让嵌入式 Python 能找到随包依赖（requests/Crypto/betterproto）与 liushen
# （flurl 以顶层包导入）。必须在 import requests 之前注入，避免误用用户
# site-packages 里版本不匹配的 requests。
_WORKER_DIR = Path(__file__).resolve().parent
os.environ.setdefault("PYTHONNOUSERSITE", "1")
for _candidate in (_WORKER_DIR / "site-packages", _WORKER_DIR / "liushen", _WORKER_DIR):
    if _candidate.is_dir() and str(_candidate) not in sys.path:
        sys.path.insert(0, str(_candidate))

import requests  # noqa: E402


def _no_window() -> dict:
    """子进程创建标志：Windows 下不要弹出控制台窗口。

    Rust 侧启 worker 时已经用了 CREATE_NO_WINDOW，所以 worker 自己没有控制台；
    而随包的 ffmpeg.exe 是 console 子系统程序，它**不继承**父进程的这个标志——
    父进程无控制台时，Windows 会给子进程新分配一个，于是用户在前台界面播放剧集时
    会被闪出一个黑色终端窗口（只在全链路 ffmpeg 路径出现，所以很容易被漏测）。

    CREATE_NO_WINDOW 在这里可靠：它作用在 CreateProcess 上，而 STARTF_USESHOWWINDOW
    + SW_HIDE 偶尔仍会闪。Windows 之外没有这个概念，返回空 dict。
    """
    if os.name != "nt":
        return {}
    return {"creationflags": subprocess.CREATE_NO_WINDOW}

from flurl.core import core_sixgod  # noqa: E402

USER_AGENT = (
    "com.phoenix.read/71332 (Linux; U; Android 16; zh_CN; 25053RT47C; "
    "Build/BP2A.250605.031.A3; Cronet/TTNetVersion:04657795 2026-01-23 "
    "QuicVersion:c67e9834 2025-09-08)"
)
DOWNLOAD_UA = "com.phoenix.read/71332"
DOWNLOAD_REFERER = "https://novel.snssdk.com/"


def download_headers() -> dict[str, str]:
    """官方播放器下载所需的基础媒体请求头。"""
    return {
        "User-Agent": USER_AGENT,
        "Referer": DOWNLOAD_REFERER,
        "Accept": "*/*",
        "Accept-Encoding": "identity",
        "Connection": "keep-alive",
    }


def download_source(session: requests.Session, real_url: str, source: Path) -> None:
    """下载当前授权会话允许的媒体源。"""
    response = session.get(real_url, headers=download_headers(), timeout=120, stream=True)
    if response.status_code == 403:
        response.close()
        raise PermissionError("CDN 拒绝当前播放会话（403）：此集需要在官方已授权会话中播放")
    response.raise_for_status()
    total = int(response.headers.get("content-length") or 0)
    downloaded = 0
    last_pct = -10
    with response:
        with source.open("wb") as output:
            for chunk in response.iter_content(chunk_size=1024 * 1024):
                if not chunk:
                    continue
                output.write(chunk)
                downloaded += len(chunk)
                if total > 0:
                    pct = int(downloaded * 100 / total)
                    if pct >= last_pct + 10:
                        last_pct = pct
                        emit({"event": "progress", "stage": "download", "percent": pct})

# 红果短剧和红果漫剧共用 seriessdk 播放端点，但在 APK 中注册为不同模型/aids。
# 只保留逆向报告确认的值，避免让 UI 传入任意请求模型。
#
# 2026-09-18 实测：服务端策略已变——漫剧 vid 用 aid=8662（短剧 aid）在
# v1/v2 端点都能取到播放模型；旧的 1004/1007 → aid=8704 现在被网关
# 静默拒绝（HTTP 200 空 body，无错误码），表现为"网络失败"重试耗尽。
CONTENT_PROFILES = {
    1: {"aid": 8662, "name": "short-series"},
    1004: {"aid": 8662, "name": "motion-comic"},
    1007: {"aid": 8662, "name": "unreal-motion-comic"},
}

# 放映厅/播放域名：sinfonlineb 为现网主路径，sinfonlinea 与 lf 为实测对照备线。
PLAYER_HOSTS = (
    "api5-normal-sinfonlineb.fqnovel.com",
    "api5-normal-sinfonlinea.fqnovel.com",
    "api5-normal-lf.fqnovel.com",
)

G99_QUERY = (
    "&ac=wifi&channel=update_64"
    "&app_name=novelread&version_code=71332&version_name=7.1.3.32"
    "&device_platform=android&os=android&ssmix=a&device_type=25053RT47C"
    "&device_brand=Redmi&language=zh&os_api=36&os_version=16"
    "&manifest_version_code=71332&resolution=1280*2772&dpi=520"
    "&update_version_code=71332&host_abi=arm64-v8a&dragon_device_type=phone"
    "&pv_player=71332&compliance_status=0&need_personal_recommend=1"
    "&player_so_load=1&is_android_pad_screen=0"
)

VIDEO_MODEL_PATH = "/novel/player/multi_video_model/v1/"
VIDEO_MODEL_V2_PATH = "/novel/player/multi_video_model/default/v1/"
ALBUM_PATH = "/novel/player/album_detail/v1/"

# 与 APK 逆向出的 GetVideoBizParam 对齐的字段子集（worker 实证可用）。
BIZ_PARAM = {
    "detail_page_version": 0,
    "device_level": 3,
    "disable_digg_stat": False,
    "need_all_video_definition": True,
    "need_mp4_align": False,
    "use_os_player": False,
    "use_server_dns": False,
    "video_platform": 1024,
}


def request_profile() -> tuple[int, int]:
    raw_content_type = os.getenv("TTV_SD_CONTENT_TYPE", "1").strip()
    raw_aid = os.getenv("TTV_SD_AID", "").strip()
    try:
        content_type = int(raw_content_type)
    except ValueError as exc:
        raise ValueError(f"content_type 无效: {raw_content_type}") from exc
    profile = CONTENT_PROFILES.get(content_type)
    if profile is None:
        raise ValueError(f"不支持的 content_type: {content_type}")
    expected_aid = int(profile["aid"])
    if raw_aid:
        try:
            supplied_aid = int(raw_aid)
        except ValueError as exc:
            raise ValueError(f"aid 无效: {raw_aid}") from exc
        if supplied_aid != expected_aid:
            raise ValueError(
                f"content_type={content_type} 必须使用 aid={expected_aid}，收到 aid={supplied_aid}"
            )
    return content_type, expected_aid


def emit(payload: dict) -> None:
    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def b64_decode_padded(value: str) -> bytes:
    text = value.strip()
    pad = len(text) % 4
    if pad:
        text += "=" * (4 - pad)
    try:
        return base64.b64decode(text)
    except Exception:
        return base64.urlsafe_b64decode(text)


def derive_content_key(spade_b64: str) -> bytes:
    """spade_a → 16 字节 CENC 内容密钥（与 FRAME 1.py / Go deriveContentKey 一致）。"""
    text = spade_b64.strip()
    pad = 4 - len(text) % 4
    if pad != 4:
        text += "=" * pad
    raw = base64.b64decode(text)
    if len(raw) < 3:
        raise ValueError(f"spade_a too short: {len(raw)} bytes")
    v6 = raw[0] ^ raw[1] ^ raw[2]
    v8 = len(raw) - v6 + 47
    if v8 <= 0 or v8 > len(raw) * 2:
        raise ValueError(f"spade_a: computed v8={v8} out of range")
    if 1 + v8 > len(raw):
        v8 = len(raw) - 1
    if v8 < 33:
        raise ValueError(f"spade_a: v8={v8} too small (need >=33)")
    body = bytearray(raw[1:1 + v8])
    v_a, v_b = 85, 246
    for i in range(v8):
        popcnt = bin(i).count("1")
        if i & 1:
            v24, v_a = v_a, body[i]
        else:
            v24, v_b = v_b, body[i]
        body[i] = (-21 - popcnt + (v24 ^ body[i])) & 0xFF
    return binascii.unhexlify(bytes(body[1:33]).decode("ascii"))


SPADE_CONSTANTS = bytes([
    0x4D, 0xD4, 0xC2, 0xE6, 0xB8, 0x31, 0x62, 0x09, 0x0E, 0x52, 0xB3, 0xC7, 0xA6, 0x73, 0x3B, 0xA4,
    0x1C, 0xB2, 0x46, 0x2B, 0x82, 0x9A, 0xB5, 0x8A, 0x19, 0x6B, 0x39, 0xDB, 0x57, 0x17, 0x75, 0x24,
    0xF4, 0x9B, 0xAF, 0x7F, 0x08, 0xE8, 0xD6, 0x8D, 0x26, 0xA7, 0x2E, 0x37, 0xC1, 0xA9, 0x5A, 0x2F,
    0x1F, 0x05, 0xA5, 0x18, 0x92, 0xAE, 0xF2, 0x94, 0x97, 0x32, 0xB6, 0x2A, 0x38, 0xAA, 0xDD, 0x58,
])


def decrypt_spade_url(b64_str: str, key_seed: bytes) -> str:
    """spade 编码的播放地址 AES-128-CBC 解密（与 FRAME 1.py 一致）。"""
    if not b64_str:
        return ""
    raw = b64_decode_padded(b64_str)
    if len(raw) < 5:
        raise ValueError("spade 密文过短")
    if raw[0] != 0xA8 or raw[2] != 0x01 or raw[3] != 0x00:
        raise ValueError("spade 密文头格式异常")
    cipher_data = raw[4:]
    cipher_data = cipher_data[:(len(cipher_data) // 16) * 16]
    h1 = hashlib.sha512(key_seed).digest()
    h2 = hashlib.sha512(h1 + SPADE_CONSTANTS).digest()
    from Crypto.Cipher import AES
    cipher = AES.new(h2[:16], AES.MODE_CBC, iv=h2[16:32])
    plaintext = cipher.decrypt(cipher_data)
    if plaintext:
        pad = plaintext[-1]
        if 1 <= pad <= 16 and pad <= len(plaintext):
            plaintext = plaintext[:-pad]
    return plaintext.rstrip(b"\x00").decode("utf-8", errors="replace")


def variant_height(item: dict) -> int:
    """该档的真实像素高度。

    优先级与参考实现（provider_hongguo_native_media.go）一致：
    definition 里的数字 → vheight → vwidth（竖屏源会把宽度当高度用）。
    只读 vheight 会让不带该字段的档位高度恒为 0，进而被选流与画质菜单整体剔除
    （Rust 侧也会丢弃高度 0 的档），表现成"画质菜单为空"。
    """
    if not isinstance(item, dict):
        return 0
    digits = "".join(ch for ch in str(item.get("definition") or "") if ch.isdigit())
    if digits:
        value = int(digits)
        if value > 0:
            return value
    height = int(item.get("vheight", 0) or 0)
    if height > 0:
        return height
    width = int(item.get("vwidth", 0) or 0)
    if width > 0:
        return width
    return 0


def variant_codec(item: dict) -> str:
    """取该档源流的编码标识（video_meta.codec_type 或 gear_des_key）。"""
    meta = item.get("video_meta") if isinstance(item.get("video_meta"), dict) else {}
    codec = str(meta.get("codec_type") or "").lower()
    if codec:
        return codec
    gear = str(item.get("gear_des_key") or item.get("gear_name") or "").lower()
    if "bytevc2" in gear:
        return "bytevc2"
    return codec or gear


def is_compatible_codec(item: dict) -> bool:
    """该档能否被 WebView2 / ffmpeg 解码。

    参考果果剧库的做法：bytevc2（H.266）源流本机解码链路不支持，选中它
    会出现"下载成功但解不出画面"。这些档直接跳过，只留 H.264/HEVC 兼容档。
    """
    codec = variant_codec(item)
    if not codec:
        return True
    return "bytevc2" not in codec


def is_h264_codec(codec: str) -> bool:
    """源档是否已是 H.264（可直接 -c:v copy 重封装，不必整集重编码）。

    判定用「先排除、再包含」，而不是全等匹配——真实数据里 codec 常常不是
    干净的 h264 三个字母：video_meta.codec_type 缺失时 variant_codec 会把
    整串 gear_des_key 交上来，实测形如

        0:mp4|1:encrypt|2:h265_hvc1|4:1080p|5:normal|6:only_roi_vcube_improve_1

    全等匹配对这类串一律判 False：源明明是 H.264 也要白花一次整集重编码
    （本机实测多花约 4 秒、文件膨胀十几倍）。反过来，先排掉 h265/hevc/
    bytevc2 这些明确的非 H.264 标识，再找 h264/avc，既不会漏判，也不会把
    HEVC 误判成 H.264——后者是功能故障：输出 HEVC 则 RTX VSR 不触发
    （AGENTS.md 不变量 25）。
    """
    value = (codec or "").strip().lower()
    if not value:
        return False
    for marker in ("h265", "hvc1", "hevc", "h266", "bytevc2"):
        if marker in value:
            return False
    return ("h264" in value) or ("avc" in value)


def vsr_enabled() -> bool:
    """设置页「RTX VSR 视频增强」开关的当前值（由 Rust 侧注入 TTV_SD_VSR）。

    缺省按**开**处理：这条链路在开关落地之前的行为就是"一律转 H.264"，
    不注入时保持原行为才不会让老路径悄悄降级（与 Rust 侧 AtomicBool 初值
    为 true 一致）。
    """
    return os.getenv("TTV_SD_VSR", "1").strip() != "0"


def should_copy_video(codec: str) -> bool:
    """这一次是否只重封装（-c:v copy）、不重编码。

    这就是设置页「RTX VSR 视频增强」开关在红果链路里的落地语义：

      * 开关**关** → 完全回到引入 RTX VSR 之前的播放链路。那条链路对红果
        整集用的就是 `-c copy` 重封装（见 .workbuddy/memory/2026-10-07.md
        的实测：同一条链路 copy 是 0.87s / 10.8MB）。播放器只要求"WebView2
        能解出画面"，本机已开 PlatformHEVCDecoderSupport，H.265 源也照播，
        因此这里不再为了一样用不上的 VSR 去做整集重编码。
      * 开关**开** → 这条链路必须产出 H.264（RTX VSR 的硬条件，AGENTS.md
        不变量 25）。源本来就是 H.264 时 copy 出来的仍然是 H.264，直接
        copy 即可，省掉整集重编码；源不是 H.264 才真的重编码。

    也就是说两档共用同一条判定：**输出必须是 H.264，且能 copy 就 copy**；
    区别只在"源不是 H.264 时"——开关开时重编成 H.264（否则 VSR 不触发），
    开关关时保持源编码原样（否则就该叫增强转码而不是回旧链路了）。

    源档是 bytevc2 时永远重编码：它在 select_best_quality 里已被排除，走到
    这里说明是缺失 codec_type 的兜底路径，宁可慢也不能产出解不出的文件。
    """
    if is_h264_codec(codec):
        return True
    if vsr_enabled():
        return False
    # 开关关：回到旧链路，源是什么编码就存什么编码（bytevc2 除外）。
    return "bytevc2" not in (codec or "").strip().lower()


def select_best_quality(video_list: dict) -> tuple[str, dict]:
    """挑最高可用档。

    评分与果果 selectHongguoAppMedia 一致：先跳过 bytevc2 等不兼容编码，
    再按像素高度取最高；同高度比码率；同分时 H.264(avc1) 优先——它比
    HEVC 兼容面更广，WebView2 直解成功率更高。
    """
    best_key, best_item, best_score = "", {}, -1
    for key, item in video_list.items():
        if not isinstance(item, dict):
            continue
        if not is_compatible_codec(item):
            continue
        height = variant_height(item)
        score = height * 10
        if int(item.get("bitrate", 0) or 0) > 0:
            score += 1
        meta = item.get("video_meta") if isinstance(item.get("video_meta"), dict) else {}
        codec = str(meta.get("codec_type") or "").lower()
        if codec in ("h264", "avc1"):
            score += 1
        if score > best_score:
            best_key, best_item, best_score = key, item, score
    if not best_item:
        # 兼容档全空时才回退到不检查编码的旧逻辑——宁可给一条可能播不了的，
        # 也不能直接报"没有清晰度"，那样整个错误提示会误导排查方向。
        for key, item in video_list.items():
            if isinstance(item, dict):
                height = variant_height(item)
                if height > 0 and not best_item:
                    best_key, best_item = key, item
    return best_key, best_item


def quality_label(key: str, item: dict) -> str:
    """统一档位展示；优先使用真实像素高度，避免显示成笼统的“高清”。"""
    height = variant_height(item)
    if height > 0:
        return f"{height}P"
    width = int(item.get("vwidth", 0) or 0)
    if width > 0:
        return f"{width}P"
    for field in ("definition", "resolution", "quality", "quality_name"):
        value = str(item.get(field) or "").strip()
        if value:
            return value.upper()
    return str(key or "原始画质").upper()


def quality_source_urls(item: dict) -> list[str]:
    """主链优先，主链为空或解密失败时用 backup_url（播放模型 VideoModelData）。"""
    urls: list[str] = []
    for field in ("main_url", "backup_url", "mainUrl", "backupUrl"):
        value = str(item.get(field) or "").strip()
        if value and value not in urls:
            urls.append(value)
    return urls


def decrypt_play_url(raw_url: str, key_seed: bytes, key: str) -> str:
    if not raw_url:
        return ""
    if key_seed and len(raw_url) > 10:
        try:
            decrypted = decrypt_spade_url(raw_url, key_seed)
            if decrypted:
                return decrypted
        except Exception as exc:
            emit({"event": "progress", "stage": "fallback", "message": f"{key} URL 解密失败，使用原始地址: {exc}"})
    return raw_url


def decode_quality_variant(key: str, item: dict, key_seed: bytes) -> dict | None:
    """解出 video_list 中单个清晰度的直链与 CENC 密钥。"""
    if not isinstance(item, dict):
        return None
    raw_urls = quality_source_urls(item)
    if not raw_urls:
        return None
    real_url = ""
    for raw_url in raw_urls:
        real_url = decrypt_play_url(raw_url, key_seed, key)
        if real_url:
            break
    if not real_url:
        return None
    content_key = ""
    content_key = ""
    # 密钥优先取 encrypt_info.spade_a：把加密信息放在这一层是参考实现
    # （provider_hongguo_native_media.go）读到的形状，顶层 spade_a 作兼容兜底。
    encryption = item.get("encrypt_info") if isinstance(item.get("encrypt_info"), dict) else {}
    spade_a = str(encryption.get("spade_a") or item.get("spade_a") or "").strip()
    if spade_a:
        try:
            content_key = derive_content_key(spade_a).hex()
        except Exception:
            content_key = ""
    elif bool(encryption.get("encrypt")) or str(
        encryption.get("encryption_method") or ""
    ).strip().lower() == "cenc-aes-ctr":
        # 声明加密却拿不到密钥：不静默降级，否则症状会表现成
        # "起播成功但解不出画面"，极难定位到密钥这一层。
        emit({
            "event": "progress",
            "stage": "fallback",
            "message": f"{key} 声明为加密流但未取到 spade_a 密钥",
        })
    return {
        "id": str(key),
        "label": quality_label(str(key), item),
        "url": real_url,
        "content_key": content_key,
        "width": int(item.get("vwidth", 0) or 0),
        "height": variant_height(item),
        "bitrate": int(item.get("bitrate", 0) or 0),
        # codec 一路带到 resolve：直连那一步要按它决定"重封装还是重编码"
        # （见 _ffmpeg_direct_decrypt 的 copy_video 参数）。写进日志也是必要的
        # ——"首开为什么慢"完全取决于选中档是 H.264（可 copy，几秒）还是
        # HEVC/bytevc2（必须整集重编），不把这一项记下来就只能猜。
        "codec": variant_codec(item),
    }


def collect_quality_variants(video_list: dict, key_seed: bytes) -> list[dict]:
    """返回所有不同源流，最高像素/码率排在首位，便于默认顶档播放。

    不兼容编码（bytevc2 等）的档位不进列表：放进画质菜单只会让用户切到
    一个解不出画面的档位。
    """
    variants = []
    seen_urls = set()
    for key, item in video_list.items():
        if not is_compatible_codec(item):
            continue
        variant = decode_quality_variant(str(key), item, key_seed)
        if not variant or not variant["url"] or variant["url"] in seen_urls:
            continue
        seen_urls.add(variant["url"])
        variants.append(variant)
    variants.sort(key=lambda value: (int(value["height"]), int(value["width"]), int(value["bitrate"])), reverse=True)
    # 同一分辨率可能因 CDN 或编码不同被重复返回。播放器只保留码率最高的一条，
    # 避免一个“极速/高清”在画质菜单里膨胀成一排重复按钮。
    unique: list[dict] = []
    seen_labels: set[str] = set()
    for variant in variants:
        label = str(variant["label"]).strip().upper()
        if not label or label in seen_labels:
            continue
        seen_labels.add(label)
        unique.append(variant)
    return unique


def http_session() -> requests.Session:
    session = requests.Session()
    adapter = requests.adapters.HTTPAdapter(pool_connections=8, pool_maxsize=8, max_retries=1)
    session.mount("https://", adapter)
    session.mount("http://", adapter)
    return session


def device_keys(device_id: str, install_id: str) -> dict:
    keys = {
        "device_id": device_id,
        "iid": install_id,
        "install_id": install_id,
        "device_brand": "Redmi",
        "device_model": "25053RT47C",
        "device_type": "25053RT47C",
        "device_manufacturer": "Xiaomi",
        "os_version": "16",
        "version_name": "7.1.3.32",
        "ua": USER_AGENT,
    }
    token = os.getenv("TTV_SD_DEVICE_TOKEN", "").strip()
    if token:
        keys["x_tt_dt"] = token
    cdid = os.getenv("TTV_SD_CDID", "").strip()
    if cdid:
        keys["cdid"] = cdid
    openudid = os.getenv("TTV_SD_OPENUDID", "").strip()
    if openudid:
        keys["openudid"] = openudid
    return keys


def player_query(install_id: str, device_id: str, aid: int) -> str:
    query = (
        f"?iid={quote(install_id, safe='')}&device_id={quote(device_id, safe='')}"
        f"&aid={aid}{G99_QUERY}"
    )
    extra = []
    cdid = os.getenv("TTV_SD_CDID", "").strip()
    if cdid:
        extra.append(f"cdid={quote(cdid, safe='')}")
    openudid = os.getenv("TTV_SD_OPENUDID", "").strip()
    if openudid:
        extra.append(f"openudid={quote(openudid, safe='')}")
    if extra:
        query += "&" + "&".join(extra)
    return query


def player_urls(path: str, install_id: str, device_id: str, aid: int) -> list[str]:
    query = player_query(install_id, device_id, aid)
    return [f"https://{host}{path}{query}" for host in PLAYER_HOSTS]


def is_player_api_host(host: str) -> bool:
    host = (host or "").lower()
    return host in PLAYER_HOSTS or host.endswith(".fqnovel.com") or "sinfonline" in host


def player_failover_urls(url: str) -> list[str]:
    """播放/fallback 域名故障转移：只改 fqnovel 业务域，不动 CDN。"""
    parts = urlsplit(url)
    host = parts.netloc
    if not is_player_api_host(host):
        return [url]
    ordered: list[str] = []
    seen: set[str] = set()
    for candidate in (host, *PLAYER_HOSTS):
        if not candidate or candidate in seen:
            continue
        seen.add(candidate)
        ordered.append(urlunsplit((parts.scheme or "https", candidate, parts.path, parts.query, parts.fragment)))
    return ordered


def get_with_host_failover(session: requests.Session, url: str, headers: dict[str, str],
                           timeout: int = 10) -> requests.Response:
    urls = player_failover_urls(url)
    last_error: Exception | None = None
    for index, candidate in enumerate(urls):
        try:
            response = session.get(candidate, headers=headers, timeout=timeout)
            if response.status_code >= 500 and index + 1 < len(urls):
                last_error = RuntimeError(f"HTTP {response.status_code}")
                emit({
                    "event": "progress",
                    "stage": "fallback",
                    "message": f"主线路波动，已自动切换备用线路（{urlsplit(candidate).netloc}）",
                })
                continue
            response.raise_for_status()
            return response
        except requests.RequestException as error:
            last_error = error
            if index + 1 < len(urls):
                emit({
                    "event": "progress",
                    "stage": "fallback",
                    "message": f"主线路波动，已自动切换备用线路（{urlsplit(candidate).netloc}）",
                })
                continue
            raise
    raise last_error or RuntimeError("红果 fallback 接口无可用线路")


def hongguo_business_error(payload: dict) -> str | None:
    """业务错误判定：**任何**非 0 业务码都算失败（参考果果 provider_hongguo_app.go）。

    旧判据是"code 非 0 **且** data 为空"才算错，于是两类失败会被放行成成功：
    一是"非 0 但响应里夹带了 data"，二是"code 是字符串型错误码（如 E1001，
    int() 抛异常后被吞成 None）"。放行的后果是调用方随后只会在"找不到 vid"
    之类的地方抛出与真实原因无关的错误，真实错误码当场丢失。

    "成功但 data 为空"不在这里放行——那属于调用方的结构校验职责。
    """
    if not isinstance(payload, dict):
        return None
    raw = payload.get("code")
    base_resp = payload.get("BaseResp")
    if not isinstance(base_resp, dict):
        base_resp = {}
    status = base_resp.get("StatusCode")
    message = str(
        payload.get("message")
        or payload.get("msg")
        or base_resp.get("StatusMessage")
        or raw
        or ""
    ).strip()
    try:
        numeric: int | None = int(raw)
    except (TypeError, ValueError):
        numeric = None
    if numeric == 111104:
        return (
            "设备身份无效（111104）。请用真机抓包更新 deviceId / installId，"
            "并写入服务端下发的 deviceToken（x-tt-dt），不要本地编造。"
        )
    if numeric == 110001:
        return "播放模型未知异常（110001）。漫剧请走 V2 端点，或更换设备凭据后重试。"
    if raw not in (None, 0, "0", ""):
        label = numeric if numeric is not None else raw
        return f"红果接口错误 {label}：{message or 'SERVICE_ERROR'}"
    # code 为 0 时仍要看 BaseResp.StatusCode（部分接口把错误只写在这里）。
    if status not in (None, 0, "0", ""):
        return f"红果接口错误 {status}：{message or 'SERVICE_ERROR'}"
    return None


def signed_post(session: requests.Session, url: str, payload: dict,
                device_id: str, install_id: str) -> dict:
    """liushen 六代签名 + POST，返回响应 JSON。

    网络失败带退避重试（参考果果 hongguoAppRequest：1s/2s 递增，最多 3 次）。
    与果果一致，4xx 业务性失败不重试——重跑同样的请求只会得到同样的拒绝，
    白白拖慢失败结论。
    """
    body_text = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
    body_bytes = body_text.encode("utf-8")
    parts = urlsplit(url)
    base_headers = {
        "User-Agent": USER_AGENT,
        "Accept": "application/json; charset=utf-8,application/x-protobuf",
        "Content-Type": "application/json; charset=UTF-8",
        "x-xs-from-web": "0",
        "x-ss-req-ticket": str(int(time.time() * 1000)),
        "x-tt-request-tag": "t=0;n=0",
        "sdk-version": "2",
        "passport-sdk-version": "50561",
        "x-vc-bdturing-sdk-version": "3.7.2.cn",
    }
    last_error: Exception | None = None
    for attempt in range(3):
        if attempt > 0:
            time.sleep(attempt)  # 1s / 2s 递增退避
        try:
            signed_headers, signed_url = core_sixgod(
                surl=f"{parts.scheme}://{parts.netloc}{parts.path}",
                params=dict(parse_qsl(parts.query, keep_blank_values=True)),
                data=json.loads(body_text),
                devices=device_keys(device_id, install_id),
                header=base_headers,
                log=False,
            )
            # x-ss-req-ticket 每次重试都要重新生成：过期的 ticket 会被网关直接拒绝。
            signed_headers["x-ss-req-ticket"] = str(int(time.time() * 1000))
            response = session.post(signed_url, headers=signed_headers, data=body_bytes, timeout=10)
            if 400 <= response.status_code < 500:
                # 4xx 是请求本身被拒（签名/参数/权限），重试无意义——直接转成
                # PermissionError 结束整个重试循环。旧写法在这里 raise_for_status 后
                # 落进了下面的通用重试分支，等于把同一个被拒的请求又打了两遍
                # （与参考实现 provider_hongguo_app.go 的"4xx 直接返回"相反）。
                raise PermissionError(
                    f"红果接口拒绝请求（HTTP {response.status_code}）：{response.text[:200]}"
                )
            response.raise_for_status()
            data = response.json()
            error = hongguo_business_error(data)
            if error:
                raise PermissionError(error)
            return data
        except PermissionError:
            raise
        except (requests.RequestException, ValueError, json.JSONDecodeError) as error:
            last_error = error
            continue
    raise last_error or RuntimeError("红果播放接口重试耗尽")


def signed_post_failover(session: requests.Session, urls: list[str], payload: dict,
                         device_id: str, install_id: str) -> dict:
    """主备域名：网络/5xx 换线；111104 等业务错误不换线。"""
    last_error: Exception | None = None
    for index, url in enumerate(urls):
        try:
            return signed_post(session, url, payload, device_id, install_id)
        except PermissionError:
            raise
        except (requests.RequestException, ValueError, json.JSONDecodeError) as error:
            last_error = error
            if index + 1 < len(urls):
                emit({
                    "event": "progress",
                    "stage": "sign",
                    "message": f"主线路波动，已自动切换备用线路（{urlsplit(url).netloc}）",
                })
            continue
    raise last_error or RuntimeError("红果播放接口无可用线路")


def fetch_stream(session: requests.Session, vid: str, device_id: str,
                 install_id: str, content_type: int, aid: int) -> dict:
    """multi_video_model → fallback_api → 解密出直链与 CENC 内容密钥（不下载）。

    返回 {url, content_key, width, height}。content_key 为 hex 字符串或 None
    （部分源流不加密）。
    """
    payload = {
        "biz_param": dict(BIZ_PARAM),
        "mixed_video_id_map": {str(content_type): [vid]},
    }
    path = VIDEO_MODEL_PATH
    if content_type != 1:
        # 漫剧(1004/1007)的 APK 只注册了 V2 端点(/multi_video_model/:dr_scene/v1/,
        # body 带 dr_scene);老端点对漫剧 vid 一律回 Code 110001"未知异常"。
        path = VIDEO_MODEL_V2_PATH
        payload["dr_scene"] = "default"
        payload["biz_param"]["caller_scene"] = "download"
    emit({"event": "progress", "stage": "sign", "message": "正在签名播放请求"})
    model = signed_post_failover(
        session,
        player_urls(path, install_id, device_id, aid),
        payload,
        device_id,
        install_id,
    )
    emit({"event": "progress", "stage": "model", "message": "正在请求播放模型"})

    data_map = model.get("data")
    if not isinstance(data_map, dict):
        raise ValueError("multi_video_model 响应缺少 data 字段")
    entry = data_map.get(vid) if isinstance(data_map.get(vid), dict) else None
    if entry is None:
        for value in data_map.values():
            if isinstance(value, dict):
                entry = value
                break
            if isinstance(value, list) and value and isinstance(value[0], dict):
                entry = value[0]
                break
    if entry is None:
        raise ValueError(f"播放模型中找不到 {vid}")
    video_model = entry.get("video_model")
    if isinstance(video_model, str):
        video_model = json.loads(video_model)
    if not isinstance(video_model, dict):
        raise ValueError("video_model 为空")
    fallback_raw = video_model.get("fallback_api")
    fallback = ""
    if isinstance(fallback_raw, str) and len(fallback_raw) > 10:
        fallback = fallback_raw
    elif isinstance(fallback_raw, list) and fallback_raw and isinstance(fallback_raw[0], str):
        fallback = fallback_raw[0]
    elif isinstance(fallback_raw, dict) and "fallback_api" in fallback_raw:
        fallback = str(fallback_raw["fallback_api"])
    if isinstance(fallback, str) and fallback.startswith("{"):
        try:
            decoded = json.loads(fallback)
            if isinstance(decoded, dict) and "fallback_api" in decoded:
                fallback = str(decoded["fallback_api"])
        except json.JSONDecodeError:
            pass
    if not fallback:
        raise ValueError(f"fallback_api 解析失败: {type(fallback_raw).__name__}")

    emit({"event": "progress", "stage": "fallback", "message": "正在获取分集直链"})
    fallback_response = get_with_host_failover(
        session, fallback, {"User-Agent": DOWNLOAD_UA}, timeout=10
    )
    video_data = (fallback_response.json().get("video_info") or {}).get("data") or {}
    if not isinstance(video_data, dict) or not video_data:
        raise ValueError("fallback_api 响应结构异常")

    key_seed = b64_decode_padded(video_data.get("key_seed") or "")
    variants = collect_quality_variants(video_data.get("video_list") or {}, key_seed)
    if not variants:
        raise ValueError("没有可用的清晰度")
    best = variants[0]

    # duration 用于直连解密的进度换算（out_time_us / 总时长）。字段名按形状
    # 防御性取，取不到就退回"只有阶段提示"的进度，不影响任何功能。
    duration_ms = 0
    for probe in (video_data.get("duration"), video_data.get("video_duration"),
                  video_data.get("video_time"), best.get("duration")):
        try:
            candidate = int(probe or 0)
        except (TypeError, ValueError):
            candidate = 0
        if candidate > 0:
            duration_ms = candidate
            break
    return {
        "url": best["url"],
        "content_key": best["content_key"] or None,
        "width": best["width"],
        "height": best["height"],
        "duration_ms": duration_ms,
        # 选中档（默认最高档）的编码，随 stream 结果一起进 Rust 的预签名缓存，
        # 再由 TTV_SD_DIRECT_CODEC 交回 resolve。
        "codec": str(best.get("codec") or ""),
        "variants": variants,
    }


# 两条编码路径的唯一区别就在这几项上；其余参数（音轨、faststart）两条共用。
#
# libx264/ultrafast/CRF20/zerolatency 是官方客户端同款参数，兼容性最好但纯
# CPU——本机实测整集重编要 3.7~4.0 秒，是与下载并列的第二大块首开开销。
# h264_nvenc 走 NVIDIA 专用编码硬件：输出同样是 H.264（VSR 只认编码格式，
# 不认谁编的），但几乎不占 CPU。
_X264_ARGS = ["-c:v", "libx264", "-preset", "ultrafast", "-crf", "20",
              "-tune", "zerolatency", "-pix_fmt", "yuv420p"]
_NVENC_ARGS = ["-c:v", "h264_nvenc", "-preset", "p1", "-cq", "26",
               "-pix_fmt", "yuv420p", "-profile:v", "high"]

# 单个 worker 进程内只探测一次（每次播放都会起新进程，跨进程缓存没意义）。
_ENCODER_CHOICE: list[list[str]] = []


def video_encoder_args(ffmpeg: str) -> list[str]:
    """挑一组可用的 H.264 视频编码参数：优先 NVIDIA 硬件编码，回落 libx264。

    为什么需要它：源档是 H.265/bytevc2 时**必须**重编码成 H.264（RTX VSR
    的硬条件，AGENTS.md 不变量 25）。这段成本在首开时间里占比很高，而显卡
    上的编码器是白躺着的。

    判定必须"真跑一次"，不能读 `-encoders` 列表：编译进去的 h264_nvenc 在
    没有 N 卡、驱动过旧或编码会话占满时照样会列出来，只有实际初始化才会
    暴露。探测只编码 2 帧到 null muxer，不写盘。

    失效一律回落 libx264：兼容性优先，VSR 只要求"H.264"，不要求谁编的。
    可用 TTV_SD_ENCODER=nvenc|x264 强制指定，用于对照实测。
    """
    if _ENCODER_CHOICE:
        return _ENCODER_CHOICE[0]
    forced = os.getenv("TTV_SD_ENCODER", "").strip().lower()
    if forced == "x264":
        _ENCODER_CHOICE.append(_X264_ARGS)
        return _ENCODER_CHOICE[0]
    probe_ok = False
    if forced != "x264":
        # 尺寸不能太小：实测 64x64 会被 NVENC 直接拒（"Frame Dimension less
        # than the minimum supported value"，返回码 -22），于是探针给出假阴性、
        # 永远回落 CPU 编码。640x360 已实测可用（本机 311ms 完成 2 帧）。
        command = [ffmpeg, "-hide_banner", "-loglevel", "error",
                   "-f", "lavfi", "-i", "color=black:s=640x360",
                   "-frames:v", "2", "-an"] + _NVENC_ARGS + ["-f", "null", "-"]
        try:
            probe = subprocess.run(command, stdout=subprocess.DEVNULL,
                                   stderr=subprocess.PIPE, text=True,
                                   timeout=25, **_no_window())
            probe_ok = probe.returncode == 0
            if not probe_ok:
                emit({"event": "progress", "stage": "encoder",
                      "message": "硬件编码不可用，改用 CPU 编码"})
        except (OSError, subprocess.SubprocessError):
            probe_ok = False
    _ENCODER_CHOICE.append(_NVENC_ARGS if probe_ok else _X264_ARGS)
    return _ENCODER_CHOICE[0]


def _h264_output_args(ffmpeg: str) -> list[str]:
    """固定输出 WebView2/RTX VSR 可用的 H.264，分辨率保持不变。"""
    # 实测同一段 1920x1080 漫剧：HEVC 直连/MSE 都不触发 VSR，H.264 稳定触发。
    # 音轨统一转 AAC（源音频编码不确定，转 AAC 才不会有画面没声音）。
    return video_encoder_args(ffmpeg) + [
        "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart",
    ]

def _ffmpeg_direct_decrypt(ffmpeg: str, url: str, key_hex: str | None,
                           out_path: Path, duration_ms: int,
                           with_app_headers: bool,
                           copy_video: bool = False) -> bool:
    """让 ffmpeg 直连 CDN 完成"拉流 + CENC 解密 + 转存"，一步到位。

    旧路径是"python 下载到 .source.tmp（8.8MB 写盘）→ ffmpeg 读 tmp 解密转存
    （再写 8.8MB）"，实测 3.4s。直连把两步合一，实测 1.2s，且不再产生临时
    整集文件（省一次写 + 一次读 + 一次删除）。

    -tls_verify 0 不可省略，且必须写在 -i 之前：随包 ffmpeg 没有 CA 证书链，
    直连 https 必然以 "certificate verify failed / Error opening input: I/O error"
    失败；而写在 -i 之后时该选项会被解析到输出侧，对输入完全不生效，
    这个快速路径就永远退化成慢路径（详见下方命令拼接处的实测记录）。

    进度用 ffmpeg 的 -progress 输出换算：out_time_us 对已知总时长。这样
    百分比与真实拉取进度同源，不会退化成假的"匀速进度条"。
    """
    partial = out_path.with_name(out_path.name + ".part.mp4")
    partial.unlink(missing_ok=True)
    command = [ffmpeg, "-y", "-hide_banner", "-loglevel", "error",
               "-progress", "pipe:1", "-nostats"]
    if with_app_headers:
        command += ["-user_agent", DOWNLOAD_UA,
                    "-headers", f"Referer: {DOWNLOAD_REFERER}\r\n"]
    if key_hex:
        command += ["-decryption_key", key_hex]
    # H.264 重编码会重写整个容器，因此这里保留 faststart：WebView2 从 asset
    # 协议起播与拖动时直接读到 moov，不依赖文件尾寻址。
    #
    # copy_video：源档本身就是 H.264 时**不重编码**，只把解密后的裸流重新封装。
    # 这一条只改 CPU 占用，不改下载时间——但正是它把"整集重编"这笔成本变成零：
    # 历史实测同一条链路 -c copy 是 0.87s / 10.8MB，而 libx264/ultrafast 整集
    # 重编是 9.99s / 157.5MB（膨胀 15 倍，见 .workbuddy/memory/2026-10-07.md）。
    # 输出仍是 H.264，RTX VSR 的硬条件（AGENTS.md 不变量 25）不受影响。
    #
    # 音轨仍然转 AAC：音频重编的代价可以忽略，而源音频是什么编码我们并不
    # 每次都清楚，统一成 AAC 才不会出现"画面有了、声音没有"。
    out_args = (
        ["-c:v", "copy", "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart"]
        if copy_video
        else _h264_output_args(ffmpeg)
    )
    # `-tls_verify 0` 与 `-rw_timeout` 必须写在 **`-i` 之前**。
    #
    # 这是整条链路最隐蔽的一处坑，实测（.workbuddy/probe-tls.ps1）：
    #   * 写成 `-i <url> -tls_verify 0 ...` → ffmpeg 在**打开输入**时用的是
    #     默认的证书校验，直接 `error:0A000086:lib(20)::reason(134)` +
    #     `Error opening input: I/O error`，115ms 就失败。它被解析成了输出侧
    #     选项，而这次没有任何输出网络流，于是这个选项对输入毫无作用。
    #   * 写成 `-tls_verify 0 ... -i <url>` → 704ms 成功产出 5.9MB。
    #
    # 后果正好对应用户的实机日志：6 集**无一例外**都出现
    # 「带应用请求头直连失败，改用裸直连重试」→「改用本地下载模式」，
    # 也就是这条"拉流+解密+转存一步到位"的快速路径从未真正生效过，
    # 每一集都退回到 python 完整下载整集写盘、再由 ffmpeg 读盘解密转存
    # 的慢路径（多一次整集写盘 + 一次整集读盘）。
    command += ["-tls_verify", "0", "-rw_timeout", "60000000",
                "-i", url, "-map", "0:v:0", "-map", "0:a:0?"] + out_args + [str(partial)]

    proc = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                            text=True, encoding="utf-8", errors="replace", **_no_window())
    last_pct = -10
    try:
        if proc.stdout is not None:
            for line in proc.stdout:
                line = line.strip()
                if line.startswith("out_time_us=") and duration_ms > 0:
                    try:
                        micros = int(line.split("=", 1)[1])
                    except ValueError:
                        continue
                    if micros <= 0:
                        continue
                    pct = min(99, int(micros / 1000.0 / duration_ms * 100))
                    if pct >= last_pct + 10:
                        last_pct = pct
                        emit({"event": "progress", "stage": "download", "percent": pct})
        try:
            proc.wait(timeout=60)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait()
    finally:
        stderr_text = ""
        if proc.stderr is not None:
            stderr_text = proc.stderr.read() or ""
        for handle in (proc.stdout, proc.stderr):
            try:
                if handle is not None:
                    handle.close()
            except Exception:
                pass
    if proc.returncode != 0 or not partial.is_file() or partial.stat().st_size == 0:
        partial.unlink(missing_ok=True)
        raise RuntimeError(
            "ffmpeg 直连失败: " + (stderr_text or "").strip().replace("\n", " ")[:200]
        )
    partial.replace(out_path)
    return True


SEARCH_SUGGEST_PATH = "/reading/bookapi/search/suggest/v1/"


def signed_get(session: requests.Session, url: str, extra_params: dict,
               device_id: str, install_id: str) -> dict:
    """GET 签名请求。

    worker 原有链路只有 signed_post（播放模型/专辑都是 POST）。搜索联想这类
    只读接口走 GET，需要在这里单独做一次六代签名。
    关键点：业务参数必须连同 iid/device_id 一起进 query——缺这两个会被服务端
    判成 PARAM_INVALID(100103)，而不是签名错误，很容易误判成"接口不可用"。
    """
    parts = urlsplit(url)
    params = dict(parse_qsl(parts.query, keep_blank_values=True))
    params.update(extra_params)
    base_headers = {
        "User-Agent": USER_AGENT,
        "Accept": "application/json; charset=utf-8",
        # 与 signed_post 保持一致：网关对这些头敏感，少一个就可能被判成非法客户端
        # （参考实现 provider_hongguo_app.go 对每个请求都设这两项）。
        "x-xs-from-web": "0",
        "sdk-version": "2",
    }
    signed_headers, signed_url = core_sixgod(
        surl=f"{parts.scheme}://{parts.netloc}{parts.path}",
        params=params,
        data={},
        devices=device_keys(device_id, install_id),
        header=base_headers,
        log=False,
    )
    response = session.get(signed_url, headers=signed_headers, timeout=10)
    response.raise_for_status()
    text = response.text.strip()
    if not text:
        # 部分档位（实测 aid=8704）会回 HTTP 200 + **空 body** 而不是错误码。
        # 直接 response.json() 会抛 JSONDecodeError，被上层误当成网络故障重试。
        raise ValueError("红果接口返回空响应（该 aid 可能不服务此接口）")
    return json.loads(text)


def search_cmd(keyword: str, device_id: str, install_id: str, aid: int) -> dict:
    """搜索联想：拿到该关键词对应的剧集（含 series_id 与封面）。

    为什么需要它：网页搜索每次只返回前 10 条，且分季剧集（"…第 N 季"）在结果里
    是跳着出现的，用户搜某一季经常看不到它。App 联想接口按名称前缀返回整组季，
    把两者合并后覆盖度明显更好。
    """
    session = http_session()
    emit({"event": "progress", "stage": "search", "message": "正在检索剧集"})
    last_error: Exception | None = None
    for url in player_urls(SEARCH_SUGGEST_PATH, install_id, device_id, aid):
        try:
            payload = signed_get(session, url, {"q": keyword, "count": "20"},
                                 device_id, install_id)
        except (requests.RequestException, ValueError) as error:
            last_error = error
            continue
        if not isinstance(payload, dict) or payload.get("code") != 0:
            last_error = RuntimeError(str(payload.get("message") or "搜索接口返回异常"))
            continue
        data = payload.get("data") or {}
        items = []
        seen = set()
        for entry in (data.get("query_result_v2") or []):
            if not isinstance(entry, dict):
                continue
            # 真实数据在 video_data 里：外层 pic_url 是所有条目共用的类型通用图，
            # 拿它当封面会得到一排名为"加载失败"的占位方块。
            video = entry.get("video_data") if isinstance(entry.get("video_data"), dict) else {}
            series_id = str(video.get("series_id") or entry.get("keyword") or "").strip()
            title = str(entry.get("name") or video.get("title") or "").strip()
            if not series_id.isdigit() or not title or series_id in seen:
                continue
            seen.add(series_id)
            # sub_title_list 形如 [{"第11季"}, {"传统玄幻"}, {"391万热度"}]：
            # 只取题材，季数与热度不是标签。
            tags = []
            episode_count = int(video.get("episode_cnt") or 0)
            for sub in (entry.get("sub_title_list") or []):
                if not isinstance(sub, dict):
                    continue
                name = str(sub.get("content") or "").strip()
                # 剧名本身也会出现在 sub_title_list 里。把它当题材收下，卡片
                # 角标就会拿剧名当分类显示（"分类里出现了视频标题名称"）。
                # 标题不是题材，按与 title 相等直接剔除。
                if (name and name != title
                        and not name.startswith("第") and "热度" not in name):
                    tags.append(name)
            # 实测大多数联想条目的 video_data.cover 直接为空——只有"首位主条目"
            # 带签名封面。空封面又没有集数的条目是纯联想（用户点进去什么都没有，
            # 历史上正是"下载了错误的卡片"的来源），直接丢弃。
            cover = str(video.get("cover") or "").strip()
            if not cover and episode_count <= 0:
                continue
            items.append({
                "id": series_id,
                "title": title,
                "cover": cover,
                "episodeCount": episode_count,
                "tags": tags[:3],
            })
        if items:
            result = {"ok": True, "keyword": keyword, "items": items}
            emit({"event": "done", **result})
            return result
    raise RuntimeError(f"搜索联想失败：{last_error or '无可用线路'}")


def search_cmd_placeholder() -> None:
    """占位：保持函数定义顺序稳定（实际逻辑见 search_cmd）。"""
    return None


def download_prefix(session: requests.Session, real_url: str, out_path: Path,
                    limit_bytes: int) -> int:
    """只取源流的前若干字节（HTTP Range）。

    为什么这样可行：这条 CDN 是 faststart 布局，moov 在文件头部（实测 offset 28、
    约 250KB），所以截断的前缀解密出来是一个**自洽可播的小片段**，不是残片。
    """
    headers = download_headers()
    headers["Range"] = f"bytes=0-{limit_bytes - 1}"
    response = session.get(real_url, headers=headers, timeout=60, stream=True)
    if response.status_code not in (200, 206):
        response.close()
        raise RuntimeError(f"前缀下载失败：HTTP {response.status_code}")
    written = 0
    with response:
        with out_path.open("wb") as output:
            for chunk in response.iter_content(chunk_size=256 * 1024):
                if not chunk:
                    continue
                output.write(chunk)
                written += len(chunk)
                if written >= limit_bytes:
                    break
    return written


def resolve_prefix(vid: str, out_path: Path, device_id: str, install_id: str,
                   ffmpeg: str, content_type: int, aid: int) -> dict:
    """「立刻起播」通道：只取开头一小段并解密成可播片段。

    旧链路必须先下完整集（8.8MB）再解密才能播，首播就得等一次完整下载。这里
    只取前 2MB（实测约 300ms）解出开头约 40 秒交给播放器立刻出画，完整版由
    调用方在后台继续解析，就绪后无缝切换。
    """
    session = http_session()
    stream_info = load_stream_info(session, vid, device_id, install_id, content_type, aid)
    real_url, key_hex, width, height, codec = pick_stream_variant(stream_info)
    content_key = None
    if key_hex:
        try:
            content_key = binascii.unhexlify(key_hex)
        except (binascii.Error, ValueError):
            content_key = None
    copy_video = should_copy_video(codec)

    limit_bytes = max(512 * 1024, int(os.getenv("TTV_SD_PREFIX_BYTES", str(2 * 1024 * 1024))))
    emit({"event": "progress", "stage": "prefix", "message": "正在预取开头片段"})
    source = out_path.with_name(out_path.name + ".prefix.tmp")
    source.unlink(missing_ok=True)
    try:
        written = download_prefix(session, real_url, source, limit_bytes)
        if written == 0:
            raise RuntimeError("前缀下载为空")
        partial = out_path.with_name(out_path.name + ".part.mp4")
        partial.unlink(missing_ok=True)
        command = [ffmpeg, "-y", "-hide_banner", "-loglevel", "error"]
        if content_key:
            command += ["-decryption_key", content_key.hex()]
        # 截断的输入会让 ffmpeg 在末尾报 packet corrupt，但那几帧之后的完整部分
        # 全部可用——产物是正常可播的（实测 1.5MB 前缀解出 28.16 秒）。
        prefix_args = (
            ["-c:v", "copy", "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart"]
            if copy_video
            else _h264_output_args(ffmpeg)
        )
        command += ["-i", str(source), "-map", "0:v:0", "-map", "0:a:0?"] + prefix_args + [str(partial)]
        proc = subprocess.run(command, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True,
                              **_no_window())
        if proc.returncode != 0 or not partial.is_file() or partial.stat().st_size == 0:
            raise RuntimeError("前缀解密失败: " + (proc.stderr or "").strip()[:200])
        partial.replace(out_path)
        size = out_path.stat().st_size
        payload = {"ok": True, "file": str(out_path), "width": width,
                   "height": height, "size": size, "prefix": True}
        emit({"event": "done", **payload})
        return payload
    finally:
        source.unlink(missing_ok=True)


def load_stream_info(session: requests.Session, vid: str, device_id: str, install_id: str,
                     content_type: int, aid: int) -> dict:
    """取播放直链与解密密钥（优先复用 Rust 侧预签名的结果）。

    预签名直链：Rust 已提前调用 stream 并把 (url, key) 缓存下来。命中时直接
    跳过签名链路——实测那两次 App API 往返是固定 2.16s，占未命中总耗时的
    一半以上，而用户从打开详情页到点集通常有足够空档提前做完。
    """
    cached_url = os.getenv("TTV_SD_DIRECT_URL", "").strip()
    if cached_url:
        emit({"event": "progress", "stage": "cache", "message": "复用已预取的播放直链"})
        return {
            "url": cached_url,
            "content_key": os.getenv("TTV_SD_DIRECT_KEY", "").strip() or None,
            "width": int(os.getenv("TTV_SD_DIRECT_WIDTH", "0") or 0),
            "height": int(os.getenv("TTV_SD_DIRECT_HEIGHT", "0") or 0),
            "duration_ms": int(os.getenv("TTV_SD_DIRECT_DURATION", "0") or 0),
            # 预签名缓存里也存了选中档的编码：命中这条路是详情页预热铺出来的
            # 最常见路径，缺了这一项它会永远走整集重编码。
            "codec": os.getenv("TTV_SD_DIRECT_CODEC", "").strip(),
            "variants": [],
        }
    return fetch_stream(session, vid, device_id, install_id, content_type, aid)


def preferred_quality_height(requested: str, variants: list) -> int | None:
    """目标清晰度 → 实际选中高度（缺档回退，与果果 preferredDownloadQuality 一致）。

    回退规则：优先不高于目标的最接近档；全部比目标高时保留其中最低档。
    0/auto 表示跟随默认最高档。高度夹在 1-4320（果果 parsePlaybackQuality 的范围）。
    """
    raw = (requested or "auto").strip().lower()
    target = {"4k": 2160, "1080p": 1080, "720p": 720, "480p": 480}.get(raw)
    if not target:
        # 前端画质菜单报的是源流真实高度，实测会出现 540、360 这类固定档位之外的
        # 值。只认 4 个字面量会把它们静默降级成"跟随默认最高档"，用户切了等于没切。
        digits = "".join(ch for ch in raw if ch.isdigit())
        target = int(digits) if digits else 0
    if not target:
        return None
    heights = sorted({int(item.get("height", 0) or 0) for item in variants
                      if int(item.get("height", 0) or 0) > 0 and int(item.get("height", 0) or 0) <= 4320})
    if not heights:
        return None
    below = [h for h in heights if h <= target]
    if below:
        return below[-1]
    return heights[0]


def pick_stream_variant(stream_info: dict) -> tuple:
    """按请求的清晰度挑一路流，返回 (url, content_key_hex, width, height, codec)。

    第 5 项 codec 只用于决定直连那一步能否 -c:v copy（见
    _ffmpeg_direct_decrypt）。取不到时给空串，语义是「未知」——未知一律按
    需要重编码处理，宁可多花 CPU 也不能产出 WebView2 解不出的文件。

    指定档位优先该档；缺档时选择不高于目标的最高档（若全部更高则保留其中
    最低档）——与果果 preferredDownloadQuality 的回退规则一致，而不是旧版
    的"取绝对值最近的档"（那会选到比目标更高的档，下载体积凭空变大）。
    """
    requested_quality = os.getenv("TTV_SD_QUALITY", "auto").strip().lower()
    selected = None
    if requested_quality != "auto":
        variants = stream_info.get("variants") or []
        target_height = preferred_quality_height(requested_quality, variants)
        if target_height:
            selected = next(
                (item for item in variants
                 if int(item.get("height", 0) or 0) == target_height),
                None,
            )
    if selected:
        return (selected["url"],
                selected.get("content_key") or stream_info.get("content_key"),
                int(selected.get("width", 0) or 0),
                int(selected.get("height", 0) or 0),
                str(selected.get("codec") or ""))
    return (stream_info["url"], stream_info["content_key"],
            stream_info["width"], stream_info["height"],
            str(stream_info.get("codec") or ""))


def resolve(vid: str, out_path: Path, device_id: str, install_id: str, ffmpeg: str,
            content_type: int, aid: int) -> dict:
    session = http_session()
    stream_info = load_stream_info(session, vid, device_id, install_id, content_type, aid)
    real_url, key_hex, width, height, codec = pick_stream_variant(stream_info)
    content_key = None
    if key_hex:
        try:
            content_key = binascii.unhexlify(key_hex)
        except (binascii.Error, ValueError):
            content_key = None
    # 输出格式由 **RTX VSR 开关**（TTV_SD_VSR）与源档编码共同决定——见
    # should_copy_video 的说明。红果这条链路完全不经过 media_enhance，
    # 所以这里是开关唯一的落点。
    copy_video = should_copy_video(codec)
    # ===== 主路径：ffmpeg 直连，拉流 + 解密 + 转存一步完成 =====
    # 把编码与"重封装/重编码"直接写进 message：Rust 侧的阶段日志只转发
    # message，附加字段会被吞掉，而"这集为什么十几秒"恰恰就是这一项决定的。
    if copy_video:
        _mode = "重封装（保留源编码）"
    elif vsr_enabled():
        _mode = "整集重编码为 H.264（VSR 需要）"
    else:
        _mode = "整集重编码为 H.264（源不可直接播放）"
    emit({"event": "progress", "stage": "download",
          "message": f"正在下载并解密源流（{height}p，编码={codec or '未知'}，{_mode}）",
          "codec": codec, "copy": copy_video})
    key_hex = content_key.hex() if content_key else None
    direct_error = ""
    # 顺序：**先带红果 App 的 UA/Referer，再退回裸直连**。
    #
    # 旧写法是反的，注释里写「第一轮不带请求头（实测最快）」——那条实测在
    # 2026-10-07 的实机日志（ttv-playback.log）里已经不成立：6 集无一例外
    # 都走了 fallback，每一集都要先白等一次注定失败的拉流。实测这次白等的
    # 代价是 0.23–0.30s（vid=7691682052302703640：14.270s 开始下载，14.499s
    # 报「直连失败」），量不大但纯浪费，而且每集都会在界面上闪一次
    # 「直连失败」的进度文案，看起来像网络出了问题。CDN 现在要求 UA/Referer，
    # 第一轮带头上才是"最快那一轮"。
    #
    # 保留第二轮而不是直接删掉：将来若某种源流反过来拒绝带头请求，这条链路
    # 仍能退到裸直连，最坏情况与旧版持平，不会更糟。
    for with_app_headers in (True, False):
        try:
            if _ffmpeg_direct_decrypt(ffmpeg, real_url, key_hex, out_path,
                                      int(stream_info.get("duration_ms") or 0),
                                      with_app_headers, copy_video):
                size = out_path.stat().st_size
                emit({"event": "done", "ok": True, "file": str(out_path), "width": width,
                      "height": height, "size": size})
                return {"ok": True, "file": str(out_path), "width": width,
                        "height": height, "size": size}
        except Exception as exc:  # noqa: BLE001 - 任何失败都要能回退
            direct_error = str(exc)
        if with_app_headers:
            emit({"event": "progress", "stage": "fallback",
                  "message": "带应用请求头直连失败，改用裸直连重试"})

    # ===== 回退路径：下载到本地再解密（直连被 CDN 拒绝时使用）=====
    emit({"event": "progress", "stage": "fallback", "message": "改用本地下载模式"})
    source = out_path.with_name(out_path.name + ".source.tmp")
    source.unlink(missing_ok=True)
    try:
        download_source(session, real_url, source)
        if not source.is_file() or source.stat().st_size == 0:
            raise RuntimeError("源流下载为空")
        emit({"event": "progress", "stage": "transcode", "message": "正在解密转存为本地 mp4"})
        partial = out_path.with_name(out_path.name + ".part.mp4")
        partial.unlink(missing_ok=True)
        command = [ffmpeg, "-y", "-hide_banner", "-loglevel", "error"]
        if content_key:
            command += ["-decryption_key", content_key.hex()]
        fallback_args = (
            ["-c:v", "copy", "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart"]
            if copy_video
            else _h264_output_args(ffmpeg)
        )
        command += ["-i", str(source), "-map", "0:v:0", "-map", "0:a:0?"] + fallback_args + [str(partial)]
        proc = subprocess.run(command, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True,
                              **_no_window())
        if proc.returncode != 0 or not partial.is_file() or partial.stat().st_size == 0:
            raise RuntimeError("ffmpeg 处理失败: " + (proc.stderr or "").strip()[:300])
        partial.replace(out_path)
        size = out_path.stat().st_size
        emit({"event": "done", "ok": True, "file": str(out_path), "width": width,
              "height": height, "size": size})
        return {"ok": True, "file": str(out_path), "width": width, "height": height, "size": size}
    finally:
        source.unlink(missing_ok=True)


def stream_cmd(vid: str, device_id: str, install_id: str, content_type: int, aid: int) -> dict:
    """锁定集秒开：只解出直链+CENC 密钥交给 libmpv 流播，不落盘。"""
    session = http_session()
    stream_info = fetch_stream(session, vid, device_id, install_id, content_type, aid)
    payload = {
        "ok": True,
        "url": stream_info["url"],
        "content_key": stream_info["content_key"] or "",
        "width": stream_info["width"],
        "height": stream_info["height"],
        "variants": stream_info.get("variants") or [],
        # duration_ms 一并透出：Rust 的 store_stream 会读它塞进 CachedStream，
        # 再经 TTV_SD_DIRECT_DURATION 交给 resolve。缺了它，直连解密那条链路
        # 换算不出下载百分比（out_time_us / 总时长），界面上只能退化成
        # "只有阶段提示、没有百分比"，看起来就像卡住不动。
        "duration_ms": int(stream_info.get("duration_ms") or 0),
        # codec 同理：它决定 resolve 是重封装还是整集重编码。
        "codec": str(stream_info.get("codec") or ""),
        "download_ua": DOWNLOAD_UA,
        "download_referer": DOWNLOAD_REFERER,
    }
    emit({"event": "done", **payload})
    return payload


def collect_episode_infos(value) -> list:
    """从专辑响应里收集全部 EpisodeInfo（vid/vid_index/need_unlock/...）。

    响应可能把分集列表放在 album_data.video_detail_list[*].video_list 或
    video_detail_data[*].video_data.video_list，两处都扫，按 vid 去重。
    """
    collected: dict[str, dict] = {}

    def walk(node):
        if isinstance(node, dict):
            if "vid" in node and "vid_index" in node and isinstance(node.get("vid"), str):
                vid = node["vid"]
                if vid and vid not in collected:
                    collected[vid] = node
                elif vid in collected:
                    old = collected[vid]
                    if int(node.get("vid_index", 0) or 0) > int(old.get("vid_index", 0) or 0):
                        collected[vid] = node
            for child in node.values():
                walk(child)
        elif isinstance(node, list):
            for child in node:
                walk(child)

    walk(value)
    return list(collected.values())


def album_cmd(series_id: str, device_id: str, install_id: str, aid: int) -> dict:
    """album_detail/v1：全集顺序 + 每集锁定态（官网 H5 只有前 N 集直链信息）。"""
    session = http_session()
    numeric = int(series_id) if series_id.isdigit() else 0
    payload = {
        "album_id": series_id,
        "series_ids": [numeric] if numeric else [],
        "need_video_detail_info": True,
        "biz_param": dict(BIZ_PARAM),
    }
    emit({"event": "progress", "stage": "sign", "message": "正在签名专辑请求"})
    response = signed_post_failover(
        session,
        player_urls(ALBUM_PATH, install_id, device_id, aid),
        payload,
        device_id,
        install_id,
    )
    data = response.get("data") if isinstance(response, dict) else None
    if not isinstance(data, dict):
        raise ValueError("album_detail 响应缺少 data 字段")
    album_data = data.get("album_data") if isinstance(data.get("album_data"), dict) else {}
    episodes_raw = collect_episode_infos(data)
    if not episodes_raw:
        raise ValueError("album_detail 响应中没有分集信息")
    episodes = []
    for item in episodes_raw:
        vid = str(item.get("vid") or "").strip()
        if not vid:
            continue
        episodes.append({
            "vid": vid,
            "index": int(item.get("vid_index", 0) or 0),
            "title": str(item.get("title") or item.get("video_title") or item.get("episode_title") or "").strip(),
            "locked": bool(item.get("need_unlock")),
            "disabled": bool(item.get("disable_play")),
            "duration_seconds": int(item.get("duration", 0) or 0) / 1000.0,
            "cover": str(item.get("episode_cover") or item.get("cover") or ""),
        })
    episodes.sort(key=lambda entry: (entry["index"] if entry["index"] > 0 else len(episodes) + 1))
    for position, entry in enumerate(episodes, start=1):
        if entry["index"] <= 0:
            entry["index"] = position
    payload = {
        "ok": True,
        "series_id": series_id,
        "title": str(album_data.get("title") or album_data.get("series_name") or "").strip(),
        "cover": str(album_data.get("cover") or album_data.get("small_cover") or album_data.get("series_cover") or "").strip(),
        "intro": str(album_data.get("intro") or album_data.get("series_intro") or album_data.get("description") or "").strip(),
        "total": int(album_data.get("episode_total_cnt") or album_data.get("episode_cnt") or len(episodes)),
        "episodes": episodes,
    }
    emit({"event": "done", **payload})
    return payload


def extract_episode_counts(data) -> dict:
    """从 album_detail 的 data 里取出 {series_id: 集数}。

    实测结构为 `data.video_detail_data.<series_id>.video_data.episode_cnt`；
    少数条目会把 video_data 摊平在上一层，两种形状都认。
    """
    details = data.get("video_detail_data") if isinstance(data, dict) else None
    if not isinstance(details, dict):
        return {}
    counts: dict[str, int] = {}
    for key, entry in details.items():
        if not isinstance(entry, dict):
            continue
        video = entry.get("video_data")
        if not isinstance(video, dict):
            video = entry
        series_id = str(video.get("series_id") or video.get("series_id_str") or key).strip()
        raw_total = video.get("episode_total_cnt") or video.get("episode_cnt")
        try:
            total = int(raw_total or 0)
        except (TypeError, ValueError):
            total = 0
        if series_id.isdigit() and total > 0:
            counts[series_id] = total
    return counts


def counts_cmd(series_ids: list[str], device_id: str, install_id: str, aid: int) -> dict:
    """批量取真实集数（漫剧列表卡片"集数未知"的修复）。

    为什么必须走 App：漫剧列表来自公开榜单页 HTML，而整页（含内嵌 router data）
    都不含任何集数文案——实测 `episode_cnt` 在榜单页出现 0 次，所以卡片只能显示
    "集数未知"。真实集数在 App 侧，且 album_detail 支持一次传多个 series_ids：
    实测整页 20 部一次命中 20/20，冷启 337ms / 热 117ms；逐部详情页则要 N 次往返
    （N × 0.6s，且会和播放解析抢同一个单实例 worker）。
    """
    unique: list[str] = []
    seen: set[str] = set()
    for raw in series_ids:
        value = str(raw).strip()
        if value.isdigit() and value not in seen:
            seen.add(value)
            unique.append(value)
    if not unique:
        raise ValueError("counts 需要至少一个有效的 series_id")
    session = http_session()
    emit({"event": "progress", "stage": "counts", "message": "正在获取真实集数"})
    payload = {
        "album_id": unique[0],
        "series_ids": [int(value) for value in unique],
        # 必须为 True：实测 False 时响应只剩单个 album_data，没有逐剧的 video_data，
        # 一个集数都拿不到。
        "need_video_detail_info": True,
        "biz_param": dict(BIZ_PARAM),
    }
    response = signed_post_failover(
        session,
        player_urls(ALBUM_PATH, install_id, device_id, aid),
        payload,
        device_id,
        install_id,
    )
    counts = extract_episode_counts(response.get("data") if isinstance(response, dict) else None)
    result = {"ok": True, "counts": counts}
    emit({"event": "done", **result})
    return result
# ---------------------------------------------------------------------------
# 「更多」页的分区数据源：红果榜单 / 最新上架
# ---------------------------------------------------------------------------
# 逆向自官方 PC 客户端 `backend/hongguo.py`（见仓库根目录
# 「红果短剧客户端逆向分析报告.md」§四）：
#   榜单  GET  /reading/bookapi/bookmall/cell/change/v   → sub_selected_items 换榜
#   上架  POST /reading/distribution/category/landpage/v → select_items.sort 换排序
#
# 官方自己对这两条接口默认**不发签名**（注释称实测红果不校验 X-Argus）。TTV 这里
# 仍然走既有的六代签名 —— 签名是更严的一侧，不会因此被拒，也就不必为「免签」
# 再分一条代码路径出来。
#
# 分页模型两边不同，统一收敛成「不透明游标」（opaque cursor）交给调用方原样回传：
#   榜单  游标要同时带 session_uuid（同一会话贯穿整个榜单）与 next_offset
#   上架  游标只是 offset（offset += 本页条数）
# 编码成 `{"o":<offset>,"s":"<uuid>"}`；调用方不解析它，只负责带回来。
CELL_CHANGE_PATH = "/reading/bookapi/bookmall/cell/change/v"
LANDPAGE_PATH = "/reading/distribution/category/landpage/v"

# 漫剧榜单（cell + tab_type 固定，三个子榜靠 sub_selected_items 区分）。
FEED_RANK_CELL = "7470092475068071998"
FEED_RANK_BOARDS = {
    "recommend": "comic_series_hot_rank",
    "hot": "comic_series_hot_play",
    "new": "comic_series_new_rank",
}
# 体裁 → landpage 的 req_scene / genre，与官方 GENRES 同值。
FEED_GENRES = {
    "short_play": "default",
    "comic_series": "comic_series",
    "ai_series": "ai_series",
}
FEED_SORTS = ("online_time", "hot_score", "hot_collect")
FEED_PAGE_SIZE = 18

# sub_title_list 里这些文案不是题材：热度/播放量/集数/季数，以及"今日上新"标记。
_FEED_SUB_NOISE = re.compile(r"^\d+集$|^第.+季$")


def _feed_int(value, fallback: int) -> int:
    """宽松取非负整数：拿不到或为负一律回落。"""
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return fallback
    return parsed if parsed >= 0 else fallback


def _feed_item(entry) -> dict | None:
    """榜单/上架条目 → `SeriesItem` 的原料。

    刻意在 worker 侧就把脏数据处理掉（HTML 标签、题材噪声、"今日上新"标记），
    Rust 侧只做类型与字段名的搬运 —— 与 `search_cmd` 的分工一致。
    """
    if not isinstance(entry, dict):
        return None
    sid = str(entry.get("series_id") or entry.get("book_id") or "").strip()
    if not sid.isdigit():
        return None
    title = re.sub(r"<[^>]+>", "", str(entry.get("title") or "")).strip()
    if not title:
        return None

    subs = [
        str(sub.get("content") or "").strip()
        for sub in (entry.get("sub_title_list") or [])
        if isinstance(sub, dict)
    ]
    # 分类优先取 category_schema（源数据里可能同时有"玄幻/逆袭/异界"多个），
    # sub_title_list 只有一个，只作兜底。
    tags: list[str] = []
    for name in re.findall(r'"name":"([^"]+)"', str(entry.get("category_schema") or "")):
        if name and name not in tags:
            tags.append(name)
    if not tags:
        for name in subs:
            if (not name or name == "今日上新" or name == title
                    or "热度" in name or "播放" in name
                    or _FEED_SUB_NOISE.match(name)):
                continue
            if name not in tags:
                tags.append(name)

    return {
        "id": sid,
        "title": title,
        "cover": str(entry.get("cover") or "").strip(),
        "episodeCount": _feed_int(entry.get("episode_cnt"), 0),
        "score": str(entry.get("score") or "").strip(),
        "copyright": str(entry.get("copyright") or "").strip(),
        "brief": str(entry.get("video_desc") or "").strip()[:120],
        "tags": tags[:3],
        # 短剧的 landpage 有真"今日上新"标记，漫剧/AI 没有（官方也没有更细粒度）。
        "today": "今日上新" in subs,
    }


def _feed_request(session, path, device_id, install_id, aid, *, query=None, body=None):
    """主备域名轮询一次请求。业务性拒绝（PermissionError）不换线，直接抛。"""
    last_error: Exception | None = None
    for url in player_urls(path, install_id, device_id, aid):
        try:
            if body is None:
                return signed_get(session, url, query or {}, device_id, install_id)
            return signed_post(session, url, body, device_id, install_id)
        except PermissionError:
            raise
        except (requests.RequestException, ValueError, json.JSONDecodeError) as error:
            last_error = error
            continue
    raise last_error or RuntimeError("红果接口不可用")


def _feed_rank(session, board, offset, session_uuid, device_id, install_id, aid):
    """漫剧榜单一页。返回 (items, hasMore, nextOffset)。"""
    query = {
        "cell_id": FEED_RANK_CELL,
        "tab_type": "26",
        "client_req_type": "2",
        "client_template": "2",
        "screen_width_px": "1350",
        "selected_items": "comic_series_rank",
        "sub_selected_items": FEED_RANK_BOARDS[board],
        "session_uuid": session_uuid,
    }
    if offset:
        query["offset"] = str(offset)
    payload = _feed_request(session, CELL_CHANGE_PATH, device_id, install_id, aid, query=query)
    view = (payload.get("data") or {}).get("cell_view") or {}
    raw = view.get("cell_data") or []
    items = []
    for entry in raw:
        value = entry.get("video_data") if isinstance(entry, dict) else None
        # video_data 既可能是对象也可能是数组（官方客户端同样两种都兜）。
        if isinstance(value, list):
            value = value[0] if value else None
        mapped = _feed_item(value)
        if mapped:
            items.append(mapped)
    has_more = bool(view.get("has_more"))
    next_offset = _feed_int(view.get("next_offset"), offset + len(raw))
    return items, has_more, next_offset


def _feed_list(session, genre, sort, offset, device_id, install_id, aid):
    """landpage 一页（最新上架 / 按热度）。返回 (items, hasMore, nextOffset)。"""
    body = {
        "filter_ids": "",
        "req_scene": FEED_GENRES[genre],
        "offset": offset,
        "need_selector_panel": False,
        "limit": FEED_PAGE_SIZE,
        "select_items": {
            "category_dim_epoch": [],
            "online_time": [],
            "gender": [],
            "category_dim_role": [],
            "genre": [genre],
            "sort": [sort],
            "category_dim_theme": [],
        },
        "session_id": "",
        "req_type": "only_content",
        "client_req_type": 3,
    }
    payload = _feed_request(session, LANDPAGE_PATH, device_id, install_id, aid, body=body)
    data = payload.get("data") or {}
    raw = data.get("video_data") or []
    items = [mapped for mapped in (_feed_item(entry) for entry in raw) if mapped]
    has_more = bool(data.get("has_more"))
    # offset 用**原始条数**推进（不是过滤后的条数）：服务端的分页按它的返回条数算，
    # 用过滤后的数量会让下一次请求重复拉回同一段。
    return items, has_more, offset + len(raw)


def feed_cmd(spec: dict, device_id: str, install_id: str, aid: int) -> dict:
    """「更多」页的分区列表。

    spec:
      {"mode":"rank","board":"hot",     "cursor":"{\\"o\\":0,\\"s\\":\\"<uuid>\\"}"}
      {"mode":"list","genre":"short_play","sort":"online_time","cursor":"{\\"o\\":0}"}

    cursor 由本函数产出、调用方原样回传；首次不带 cursor 即从第一页开始。
    """
    mode = str(spec.get("mode") or "").strip()
    state: dict = {}
    cursor = spec.get("cursor")
    if isinstance(cursor, str) and cursor.strip():
        try:
            parsed = json.loads(cursor)
        except ValueError:
            parsed = None
        if isinstance(parsed, dict):
            state = parsed
    offset = _feed_int(state.get("o"), 0)

    session = http_session()
    emit({"event": "progress", "stage": "shelf", "message": "正在获取列表"})

    if mode == "rank":
        board = str(spec.get("board") or "hot").strip()
        if board not in FEED_RANK_BOARDS:
            raise ValueError(f"榜单无效：{board}")
        # session_uuid 必须贯穿整个榜单会话（服务端靠它串起分页），所以它进游标。
        session_uuid = str(state.get("s") or "").strip() or str(uuid.uuid4())
        items, has_more, next_offset = _feed_rank(
            session, board, offset, session_uuid, device_id, install_id, aid)
        next_state = {"o": next_offset, "s": session_uuid}
    elif mode == "list":
        genre = str(spec.get("genre") or "short_play").strip()
        if genre not in FEED_GENRES:
            raise ValueError(f"体裁无效：{genre}")
        sort = str(spec.get("sort") or "online_time").strip()
        if sort not in FEED_SORTS:
            sort = "online_time"
        items, has_more, next_offset = _feed_list(
            session, genre, sort, offset, device_id, install_id, aid)
        next_state = {"o": next_offset}
    else:
        raise ValueError(f"模式无效：{mode}")

    result = {
        "ok": True,
        "items": items,
        # 一页都过滤空了就不该继续翻：空页即到底。
        "hasMore": has_more and len(items) > 0,
        "nextCursor": json.dumps(next_state, separators=(",", ":")),
    }
    emit({"event": "done", **result})
    return result


def main() -> int:
    argv = sys.argv[1:]
    if not argv:
        emit({"ok": False, "error": "用法: worker.py resolve|stream <vid> / album <series_id> / counts <id,id,...> / feed <json>"})
        return 2
    subcommand = argv[0]
    if subcommand == "selftest":
        urls = player_urls(VIDEO_MODEL_PATH, "1", "2", 8662)
        assert len(urls) == 3
        assert "sinfonlineb" in urls[0] and "sinfonlinea" in urls[1] and "api5-normal-lf" in urls[2]
        assert "aid=8662" in urls[0] and "app_name=novelread" in urls[0]
        assert "111104" in (hongguo_business_error({"code": 111104, "data": None}) or "")
        assert hongguo_business_error({"code": 0, "data": {}}) is None
        # 业务错误判定：任何非 0 码都算失败。"非 0 但夹带 data"与字符串型错误码
        # 都不能被放行——旧判据把这两种情况判成了成功，真实错误码当场丢失。
        assert hongguo_business_error({"code": "0", "data": {}}) is None
        assert hongguo_business_error({"code": None, "data": {}}) is None
        assert hongguo_business_error({"code": 100001, "data": {"series": 1}}) is not None
        assert hongguo_business_error({"code": "E1001", "data": None}) is not None
        assert hongguo_business_error({"code": 0, "BaseResp": {"StatusCode": 7}}) is not None
        assert hongguo_business_error({"code": 0, "BaseResp": {"StatusCode": 0}}) is None
        assert hongguo_business_error(None) is None
        # 画质高度回退顺序（参考实现）：definition → vheight → vwidth。
        assert variant_height({"vheight": 720}) == 720
        assert variant_height({"definition": "1080P"}) == 1080
        assert variant_height({"vwidth": 480}) == 480
        # definition 覆盖 vheight（与参考实现一致，不是取较大值）
        assert variant_height({"definition": "720P", "vheight": 1080}) == 720
        assert variant_height({}) == 0
        assert quality_label("low", {"definition": "540P"}) == "540P"
        failover = player_failover_urls(
            "https://api5-normal-sinfonlineb.fqnovel.com/video/play?x=1"
        )
        assert len(failover) == 3 and "sinfonlinea" in failover[1]
        assert player_failover_urls("https://qznovelvod.com/a.mp4") == [
            "https://qznovelvod.com/a.mp4"
        ]
        os.environ.pop("TTV_SD_DEVICE_TOKEN", None)
        assert "x_tt_dt" not in device_keys("1", "2")
        os.environ["TTV_SD_DEVICE_TOKEN"] = "tok-from-server"
        assert device_keys("1", "2")["x_tt_dt"] == "tok-from-server"
        os.environ.pop("TTV_SD_DEVICE_TOKEN", None)
        assert quality_source_urls({"backup_url": "https://b.example/a.mp4"}) == [
            "https://b.example/a.mp4"
        ]
        assert quality_source_urls({
            "main_url": "https://a.example/a.mp4",
            "backup_url": "https://b.example/a.mp4",
        }) == ["https://a.example/a.mp4", "https://b.example/a.mp4"]
        # 编码感知画质挑选：bytevc2 跳过，H.264 同分优先（参考果果）。
        video_list = {
            "origin": {"vheight": 1080, "bitrate": 2000,
                       "video_meta": {"codec_type": "bytevc2"}},
            "main": {"vheight": 1080, "bitrate": 2000,
                     "video_meta": {"codec_type": "h264"}},
            "low": {"vheight": 540, "bitrate": 800,
                    "video_meta": {"codec_type": "h264"}},
        }
        key, item = select_best_quality(video_list)
        assert key == "main", f"bytevc2 必须被跳过，选中 {key}"
        assert is_compatible_codec(video_list["origin"]) is False
        assert is_compatible_codec(video_list["main"]) is True
        filtered = [k for k, v in video_list.items()
                    if is_compatible_codec(v)]
        assert filtered == ["main", "low"], f"bytevc2 档不进画质列表: {filtered}"
        # 缺档回退（果果 preferredDownloadQuality）：请求 720p、只有 1080p/540p
        # 时选 540p（不高于目标的最高档），而不是旧版的"绝对值最近"（会选 1080p）。
        variants = [{"height": 1080}, {"height": 540}]
        assert preferred_quality_height("720p", variants) == 540
        assert preferred_quality_height("1080p", variants) == 1080
        # 全部比目标高：保留最低档。
        assert preferred_quality_height("480p", [{"height": 1080}, {"height": 720}]) == 720
        # auto / 无有效高度：返回 None，跟随默认最高档。
        assert preferred_quality_height("auto", variants) is None
        assert preferred_quality_height("720p", [{"height": 0}]) is None
        # 超范围高度（>4320）被夹掉。
        assert preferred_quality_height("720p", [{"height": 8640}, {"height": 540}]) == 540
        # counts 解析：只认 video_detail_data 下的真实集数，缺集数的条目丢弃。
        assert extract_episode_counts({
            "video_detail_data": {
                "111": {"video_data": {"series_id": "111", "episode_cnt": 153}},
                "222": {"video_data": {"series_id": "222", "episode_total_cnt": 528}},
                "333": {"video_data": {"series_id": "333", "episode_cnt": 0}},
                "444": {"series_id": "444", "episode_cnt": 12},
            }
        }) == {"111": 153, "222": 528, "444": 12}
        assert extract_episode_counts(None) == {}
        assert extract_episode_counts({"video_detail_data": []}) == {}
        emit({"ok": True, "event": "done", "hosts": [urlsplit(item2).netloc for item2 in urls]})
        return 0
    if subcommand not in ("resolve", "resolve-prefix", "stream", "album", "search", "counts", "feed") or len(argv) < 2:
        emit({"ok": False, "error": f"未知子命令: {subcommand or '(空)'}"})
        return 2
    target = argv[1].strip()
    # 各子命令的 target 形态不同：search 是关键词（可含中文）、feed 是一段 JSON、
    # counts 是逗号列表，其余都要求是纯数字 ID。
    if not target or (subcommand not in ("search", "counts", "feed") and not target.isdigit()):
        emit({"ok": False, "error": f"缺少有效的 {subcommand} 目标。"})
        return 2
    device_id = os.getenv("TTV_SD_DEVICE_ID", "").strip()
    install_id = os.getenv("TTV_SD_INSTALL_ID", "").strip()
    ffmpeg = os.getenv("TTV_SD_FFMPEG", "").strip()
    out = os.getenv("TTV_SD_OUT", "").strip()
    if not device_id or not install_id:
        emit({"ok": False, "error": "缺少环境变量: TTV_SD_DEVICE_ID, TTV_SD_INSTALL_ID"})
        return 2
    try:
        content_type, aid = request_profile()
        if subcommand in ("resolve", "resolve-prefix"):
            if not ffmpeg or not out:
                emit({"ok": False, "error": "缺少环境变量: TTV_SD_FFMPEG, TTV_SD_OUT"})
                return 2
            if not Path(ffmpeg).is_file():
                emit({"ok": False, "error": f"ffmpeg 不存在: {ffmpeg}"})
                return 2
            if subcommand == "resolve":
                resolve(target, Path(out), device_id, install_id, ffmpeg, content_type, aid)
            else:
                resolve_prefix(target, Path(out), device_id, install_id, ffmpeg, content_type, aid)
        elif subcommand == "stream":
            stream_cmd(target, device_id, install_id, content_type, aid)
        elif subcommand == "search":
            search_cmd(target, device_id, install_id, aid)
        elif subcommand == "counts":
            counts_cmd(target.split(","), device_id, install_id, aid)
        elif subcommand == "feed":
            feed_cmd(json.loads(target), device_id, install_id, aid)
        else:
            album_cmd(target, device_id, install_id, aid)
        return 0
    except PermissionError as exc:
        emit({"ok": False, "error": str(exc)})
        return 1
    except requests.RequestException as exc:
        emit({"ok": False, "error": f"红果接口网络失败：{exc}"})
        return 1
    except Exception as exc:
        emit({"ok": False, "error": str(exc)})
        return 1


if __name__ == "__main__":
    sys.exit(main())
