# 逐源链路体检台架：直接驱动 duanju_core.dll，按 app 真实调用顺序
# （catalog force → detail 首条 → resolve 第一章 → release）测试每个 guo 源。
# 用独立临时目录 + proxyMode=direct，避免污染 app 数据目录、也复现直连修复。
import ctypes
import json
import os
import shutil
import sys
import tempfile
import time

DLL = r"D:\Users/<user>\Desktop\TTV Short Drama\src-tauri\resources\guo-core\duanju_core.dll"

SOURCES = [
    "hongguo", "huangdou", "huangju", "yeguo", "dsd", "huangguoai", "huangguo-video",
    "yaguo", "maoguo", "fanguo", "guanguo", "heguo", "xingguo", "huaguo",
    "niuguo", "wangguo", "faguo", "piguo", "wuguo",
]

# 与 Rust 侧 next_sequence 同构：远大于前端会话号，且全局严格递增
sequence = 1_000_000


def main():
    global sequence
    data_dir = os.path.join(tempfile.gettempdir(), "ttv-guo-probe")
    shutil.rmtree(data_dir, ignore_errors=True)
    os.makedirs(data_dir, exist_ok=True)

    lib = ctypes.CDLL(DLL)
    lib.DuanjuRequest.restype = ctypes.c_char_p
    lib.DuanjuRequest.argtypes = [ctypes.c_char_p]

    def req(payload):
        out = lib.DuanjuRequest(json.dumps(payload).encode("utf-8"))
        return json.loads(out.decode("utf-8"))

    r = req({"action": "initialize", "directory": data_dir})
    assert r.get("ok"), f"initialize failed: {r}"
    r = req({"action": "saveResourceSettings", "settings": {
        "proxyMode": "direct", "catalogConcurrency": 3, "catalogIntervalMs": 250,
        "downloadConcurrency": 2}})
    assert r.get("ok"), f"save settings failed: {r}"
    print("PROBE init ok (proxyMode=direct)", flush=True)

    results = {}
    for source in SOURCES:
        entry = {"source": source}
        t0 = time.time()
        try:
            # 1) 目录：force 走网络（app 的 catalog_refresh 分支）
            r = req({"action": "catalog", "source": source, "category": "",
                     "query": "", "page": 1, "force": True})
            if not r.get("ok"):
                entry["catalog"] = f"ERR: {r.get('error')}"
            else:
                items = (r.get("data") or {}).get("items") or []
                entry["catalog"] = f"OK {len(items)} items"
                if not items:
                    entry["detail"] = "SKIP (no items)"
                    entry["resolve"] = "SKIP"
                else:
                    # 2) 详情：取目录第一条（贴近用户点开第一张卡）
                    drama = items[0]
                    raw_id = str(drama.get("sourceId") or drama.get("id") or "").split(":")[-1]
                    entry["probe_item"] = {"id": raw_id, "title": drama.get("title")}
                    r = req({"action": "detail", "drama": {"id": f"{source}:{raw_id}", "source": source}})
                    if not r.get("ok"):
                        entry["detail"] = f"ERR: {r.get('error')}"
                        entry["resolve"] = "SKIP"
                    else:
                        data = r.get("data") or {}
                        chapters = data.get("chapters") or []
                        entry["detail"] = f"OK {len(chapters)} chapters"
                        if not chapters:
                            entry["resolve"] = "SKIP (no chapters)"
                        else:
                            # 3) 解析播放：与 Rust open_episode 同参（force, index=1, quality=0）
                            sequence += 1
                            r = req({"action": "resolve", "drama": data.get("drama"),
                                     "chapter": chapters[0], "index": 1,
                                     "quality": 0, "sequence": sequence, "force": True})
                            if not r.get("ok"):
                                entry["resolve"] = f"ERR: {r.get('error')}"
                            else:
                                plan = r.get("data") or {}
                                url = plan.get("url") or ""
                                if not url:
                                    entry["resolve"] = "ERR: empty url"
                                else:
                                    kind = "hls" if url.split("?")[0].lower().endswith(".m3u8") else "file"
                                    entry["resolve"] = f"OK {kind} {url[:90]}"
                                    session = plan.get("session")
                                    if session:
                                        req({"action": "release", "session": session})
        except Exception as error:  # DLL 崩溃/解码失败不能中断整轮体检
            entry["error"] = repr(error)
        entry["seconds"] = round(time.time() - t0, 1)
        results[source] = entry
        print(f"PROBE {json.dumps(entry, ensure_ascii=False)}", flush=True)

    shutil.rmtree(data_dir, ignore_errors=True)
    print("PROBE DONE", flush=True)


if __name__ == "__main__":
    sys.exit(main())
