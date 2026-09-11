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
import subprocess
import sys
import time
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
CONTENT_PROFILES = {
    1: {"aid": 8662, "name": "short-series"},
    1004: {"aid": 8704, "name": "motion-comic"},
    1007: {"aid": 8704, "name": "unreal-motion-comic"},
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


def select_best_quality(video_list: dict) -> tuple[str, dict]:
    best_key, best_item, best_height = "", {}, 0
    for key, item in video_list.items():
        if not isinstance(item, dict):
            continue
        height = int(item.get("vheight", 0) or 0)
        if height > best_height:
            best_key, best_item, best_height = key, item, height
        elif height == best_height and best_item:
            if int(item.get("bitrate", 0) or 0) > int(best_item.get("bitrate", 0) or 0):
                best_key, best_item = key, item
    return best_key, best_item


def quality_label(key: str, item: dict) -> str:
    """统一档位展示；优先使用真实像素高度，避免显示成笼统的“高清”。"""
    width = int(item.get("vwidth", 0) or 0)
    height = int(item.get("vheight", 0) or 0)
    if height > 0:
        return f"{height}P"
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
    spade_a = str(item.get("spade_a") or "").strip()
    if spade_a:
        try:
            content_key = derive_content_key(spade_a).hex()
        except Exception:
            content_key = ""
    return {
        "id": str(key),
        "label": quality_label(str(key), item),
        "url": real_url,
        "content_key": content_key,
        "width": int(item.get("vwidth", 0) or 0),
        "height": int(item.get("vheight", 0) or 0),
        "bitrate": int(item.get("bitrate", 0) or 0),
    }


def collect_quality_variants(video_list: dict, key_seed: bytes) -> list[dict]:
    """返回所有不同源流，最高像素/码率排在首位，便于默认顶档播放。"""
    variants = []
    seen_urls = set()
    for key, item in video_list.items():
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
                    "message": f"线路失败，切换备用域名（{urlsplit(candidate).netloc}）",
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
                    "message": f"线路失败，切换备用域名（{urlsplit(candidate).netloc}）",
                })
                continue
            raise
    raise last_error or RuntimeError("红果 fallback 接口无可用线路")


def hongguo_business_error(payload: dict) -> str | None:
    if not isinstance(payload, dict):
        return None
    raw = payload.get("code")
    if raw in (None, 0, "0", ""):
        return None
    try:
        code = int(raw)
    except (TypeError, ValueError):
        code = None
    message = str(payload.get("message") or payload.get("msg") or raw).strip()
    if code == 111104:
        return (
            "设备身份无效（111104）。请用真机抓包更新 deviceId / installId，"
            "并写入服务端下发的 deviceToken（x-tt-dt），不要本地编造。"
        )
    if code == 110001:
        return "播放模型未知异常（110001）。漫剧请走 V2 端点，或更换设备凭据后重试。"
    if payload.get("data") is None and code not in (None, 0):
        return f"红果接口错误 {code}：{message or 'SERVICE_ERROR'}"
    return None


def signed_post(session: requests.Session, url: str, payload: dict,
                device_id: str, install_id: str) -> dict:
    """liushen 六代签名 + POST，返回响应 JSON。"""
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
    signed_headers, signed_url = core_sixgod(
        surl=f"{parts.scheme}://{parts.netloc}{parts.path}",
        params=dict(parse_qsl(parts.query, keep_blank_values=True)),
        data=json.loads(body_text),
        devices=device_keys(device_id, install_id),
        header=base_headers,
        log=False,
    )
    response = session.post(signed_url, headers=signed_headers, data=body_bytes, timeout=10)
    response.raise_for_status()
    data = response.json()
    error = hongguo_business_error(data)
    if error:
        raise PermissionError(error)
    return data


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
                    "message": f"线路失败，切换备用域名（{urlsplit(url).netloc}）",
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

    return {
        "url": best["url"],
        "content_key": best["content_key"] or None,
        "width": best["width"],
        "height": best["height"],
        "variants": variants,
    }


def resolve(vid: str, out_path: Path, device_id: str, install_id: str, ffmpeg: str,
            content_type: int, aid: int) -> dict:
    session = http_session()
    stream_info = fetch_stream(session, vid, device_id, install_id, content_type, aid)
    # Honor the requested quality when the App API returns multiple variants.
    # Keep auto/unknown on the highest quality selected by fetch_stream.
    requested_quality = os.getenv("TTV_SD_QUALITY", "auto").strip().lower()
    selected = None
    if requested_quality != "auto":
        target_height = {"4k": 2160, "1080p": 1080, "720p": 720}.get(requested_quality)
        variants = stream_info.get("variants") or []
        if target_height:
            selected = min(
                (item for item in variants if int(item.get("height", 0) or 0) > 0),
                key=lambda item: abs(int(item.get("height", 0) or 0) - target_height),
                default=None,
            )
    if selected:
        real_url = selected["url"]
        stream_info = {**stream_info, "url": real_url,
                       "content_key": selected.get("content_key") or stream_info.get("content_key"),
                       "width": int(selected.get("width", 0) or 0),
                       "height": int(selected.get("height", 0) or 0)}
    else:
        real_url = stream_info["url"]
    content_key = None
    if stream_info["content_key"]:
        try:
            content_key = binascii.unhexlify(stream_info["content_key"])
        except (binascii.Error, ValueError):
            content_key = None
    width = stream_info["width"]
    height = stream_info["height"]
    emit({"event": "progress", "stage": "download", "message": f"正在下载源流（{height}p）"})

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
        command += ["-i", str(source), "-map", "0:v:0", "-map", "0:a:0?", "-c", "copy",
                    "-movflags", "+faststart", str(partial)]
        proc = subprocess.run(command, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True)
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


def main() -> int:
    argv = sys.argv[1:]
    if not argv:
        emit({"ok": False, "error": "用法: worker.py resolve|stream <vid> / album <series_id>"})
        return 2
    subcommand = argv[0]
    if subcommand == "selftest":
        urls = player_urls(VIDEO_MODEL_PATH, "1", "2", 8662)
        assert len(urls) == 3
        assert "sinfonlineb" in urls[0] and "sinfonlinea" in urls[1] and "api5-normal-lf" in urls[2]
        assert "aid=8662" in urls[0] and "app_name=novelread" in urls[0]
        assert "111104" in (hongguo_business_error({"code": 111104, "data": None}) or "")
        assert hongguo_business_error({"code": 0, "data": {}}) is None
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
        emit({"ok": True, "event": "done", "hosts": [urlsplit(item).netloc for item in urls]})
        return 0
    if subcommand not in ("resolve", "stream", "album") or len(argv) < 2:
        emit({"ok": False, "error": f"未知子命令: {subcommand or '(空)'}"})
        return 2
    target = argv[1].strip()
    if not target or not target.isdigit():
        emit({"ok": False, "error": f"缺少有效的 {subcommand} 目标 ID。"})
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
        if subcommand == "resolve":
            if not ffmpeg or not out:
                emit({"ok": False, "error": "缺少环境变量: TTV_SD_FFMPEG, TTV_SD_OUT"})
                return 2
            if not Path(ffmpeg).is_file():
                emit({"ok": False, "error": f"ffmpeg 不存在: {ffmpeg}"})
                return 2
            resolve(target, Path(out), device_id, install_id, ffmpeg, content_type, aid)
        elif subcommand == "stream":
            stream_cmd(target, device_id, install_id, content_type, aid)
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
