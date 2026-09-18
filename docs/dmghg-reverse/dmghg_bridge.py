#!/usr/bin/env python3
"""dmghg_bridge —— 动漫共和国概念版（dmghg）接口的 Python ctypes 参考实现。

直接驱动厂商的 electron_bridge DLL，拿到已经解密好的 JSON。
绕开 authentication 头的逆向（那条路走不通，见 REVERSE-NOTES.md 第 2 节）。

用法：
    python dmghg_bridge.py channels
    python dmghg_bridge.py list --channel 0 --page 1 --limit 10 --sort hits
    python dmghg_bridge.py search 仙逆
    python dmghg_bridge.py detail 181655
    python dmghg_bridge.py play 181655 --part 第01集 --line cn
    python dmghg_bridge.py raw catalog.get_channels '{}'

环境变量（可选，有默认值）：
    DMGHG_INSTALL_DIR   安装目录
    DMGHG_REAL_DLL      真身 DLL 路径
    DMGHG_LEGACY_HOST   legacy 直连主机

依赖：无（仅标准库）。需要已安装动漫共和国概念版客户端。
"""
from __future__ import annotations

import argparse
import ctypes
import json
import os
import sys
from typing import Any

# ---------------------------------------------------------------------------
# 路径 / 环境
# ---------------------------------------------------------------------------

DEFAULT_INSTALL = r"C:\Users\kioco\AppData\Local\Programs\动漫共和国概念版"
DEFAULT_REAL_DLL = r"C:\Users\kioco\AppData\Local\dmghg-electron-bridge-vipfix\electron_bridge.real.dll"
DEFAULT_LEGACY_HOST = "http://bkbfdm.hzhcbkj.cn"

INSTALL_DIR = os.environ.get("DMGHG_INSTALL_DIR", DEFAULT_INSTALL)
REAL_DLL = os.environ.get("DMGHG_REAL_DLL", DEFAULT_REAL_DLL)
LEGACY_HOST = os.environ.get("DMGHG_LEGACY_HOST", DEFAULT_LEGACY_HOST)

PROTOCOL_VERSION = 1


class DmghgError(RuntimeError):
    """命令返回 ok=false。"""

    def __init__(self, command: str, error: dict[str, Any]):
        self.command = command
        self.error = error
        super().__init__(
            f"{command} 失败: {error.get('code')} {error.get('message')} "
            f"({str(error.get('detail'))[:200]})"
        )


# ---------------------------------------------------------------------------
# 核心桥接
# ---------------------------------------------------------------------------

class DmghgBridge:
    """驱动 electron_bridge DLL。

    线程安全性：DLL 内部持锁，但这里不做同步。多线程用记得自己加锁。
    """

    def __init__(
        self,
        install_dir: str = INSTALL_DIR,
        real_dll: str = REAL_DLL,
        legacy_host: str = LEGACY_HOST,
        api_host: str | None = None,
    ) -> None:
        if not os.path.isdir(install_dir):
            raise FileNotFoundError(f"安装目录不存在: {install_dir}")
        if not os.path.isfile(real_dll):
            raise FileNotFoundError(f"真身 DLL 不存在: {real_dll}")

        # 必须在 service_new 之前设：不设的话 legacy 家族会走网关发现池
        # 175.178.11.16:7862，对 pc/* 一律返回 HTTP 418。
        os.environ["DMGHG_LEGACY_DIRECT_HOST"] = legacy_host

        # 真身 DLL 需要同目录的依赖（VC runtime 等）
        os.add_dll_directory(install_dir)

        self._lib = ctypes.WinDLL(real_dll)
        self._bind()
        self._seq = 0

        cfg: dict[str, Any] = {}
        if api_host:
            cfg["api_host"] = api_host
        self._service = self._lib.dmghg_service_new(
            json.dumps(cfg).encode("utf-8"), None
        )
        if not self._service:
            raise RuntimeError("dmghg_service_new 返回空指针")

    def _bind(self) -> None:
        lib = self._lib
        lib.dmghg_bridge_protocol_version.restype = ctypes.c_int
        lib.dmghg_bridge_protocol_version.argtypes = []

        lib.dmghg_service_new.restype = ctypes.c_void_p
        lib.dmghg_service_new.argtypes = [ctypes.c_char_p, ctypes.c_void_p]

        lib.dmghg_service_handle_command_json.restype = ctypes.c_void_p
        lib.dmghg_service_handle_command_json.argtypes = [ctypes.c_void_p, ctypes.c_char_p]

        lib.dmghg_string_free.restype = None
        lib.dmghg_string_free.argtypes = [ctypes.c_void_p]

        lib.dmghg_service_free.restype = None
        lib.dmghg_service_free.argtypes = [ctypes.c_void_p]

    # -- 底层调用 ---------------------------------------------------------

    @property
    def protocol_version(self) -> int:
        return self._lib.dmghg_bridge_protocol_version()

    def call_raw(self, command: str, payload: dict[str, Any] | None = None) -> dict[str, Any]:
        """发一条命令，返回完整响应 dict（不抛异常）。"""
        self._seq += 1
        request = json.dumps(
            {
                "request_id": f"py-{self._seq}",
                "command": command,
                "payload": payload or {},
                "protocol_version": PROTOCOL_VERSION,
            },
            ensure_ascii=False,
        ).encode("utf-8")

        ptr = self._lib.dmghg_service_handle_command_json(self._service, request)
        if not ptr:
            return {"ok": False, "error": {"code": "null_response", "message": "DLL 返回空指针"}}
        try:
            text = ctypes.string_at(ptr).decode("utf-8", "replace")
        finally:
            self._lib.dmghg_string_free(ctypes.c_void_p(ptr))

        try:
            return json.loads(text)
        except json.JSONDecodeError as exc:
            return {
                "ok": False,
                "error": {"code": "invalid_json", "message": str(exc), "detail": text[:400]},
            }

    def call(self, command: str, payload: dict[str, Any] | None = None) -> Any:
        """发一条命令，返回 data；失败抛 DmghgError。"""
        resp = self.call_raw(command, payload)
        if not resp.get("ok"):
            raise DmghgError(command, resp.get("error") or {})
        return resp.get("data")

    def close(self) -> None:
        if getattr(self, "_service", None):
            self._lib.dmghg_service_free(ctypes.c_void_p(self._service))
            self._service = None

    def __enter__(self) -> "DmghgBridge":
        return self

    def __exit__(self, *exc: Any) -> None:
        self.close()

    # -- 目录 -------------------------------------------------------------

    def get_channels(self) -> list[dict[str, Any]]:
        """所有分类（含 areas / types）。"""
        return self.call("catalog.get_channels") or []

    def get_banners(self, position: int = 0) -> list[dict[str, Any]]:
        return self.call("catalog.get_banners", {"position": position}) or []

    def get_video_list(
        self,
        channel: int = 0,
        page: int = 1,
        limit: int = 20,
        sort: str = "hits",
    ) -> dict[str, Any]:
        """列表。返回 {items, total, ...}。"""
        return self.call(
            "catalog.get_video_list",
            {"channel": channel, "page": page, "limit": limit, "sort": sort},
        ) or {}

    def search(self, key: str) -> Any:
        """搜索。"""
        return self.call("catalog.search_video", {"key": key})

    def get_video_key(self, key: str) -> dict[str, Any]:
        """按 ename / 名称模糊查（返回精简单条）。"""
        return self.call("catalog.get_video_key", {"key": key}) or {}

    def get_detail(self, video_id: str | int) -> dict[str, Any]:
        """详情。含 parts（线路 + 集名列表）。"""
        return self.call("catalog.get_video_detail", {"id": str(video_id)}) or {}

    # -- 播放 -------------------------------------------------------------

    def get_play_token(
        self,
        video_id: str | int,
        part: str,
        line: str,
    ) -> dict[str, Any]:
        """取播放令牌 + 解析脚本。

        注意两个参数语义（这里是最容易踩的坑）：
          part —— **集名字符串**（如 "第01集"），不是序号 "1"
          line —— **线路代码**（如 "cn"），不是数字 "1"
        传错一律 400404 查询无果。

        line 的值来自 get_detail()["parts"][i]["play"]。
        """
        data = self.call(
            "legacy.rpc",
            {
                "module": "video",
                "type": "videoPlay",
                "data": {"id": str(video_id), "part": part, "play": line},
            },
        )
        items = data if isinstance(data, list) else [data]
        if not items:
            raise DmghgError("legacy.rpc/videoPlay", {"code": "empty", "message": "无播放信息"})
        return items[0]

    def resolve_play_url(
        self,
        video_id: str | int,
        part: str,
        line: str,
        install_dir: str = INSTALL_DIR,
    ) -> list[dict[str, Any]]:
        """一步到位：拿到真实可播放地址列表。

        返回 [{name, url, type, headers, bitrate, width, height}, ...]
        """
        token_info = self.get_play_token(video_id, part, line)
        parse_lua = token_info.get("parse") or ""
        if not parse_lua.strip():
            raise DmghgError("legacy.rpc/videoPlay", {
                "code": "no_parse_script",
                "message": "响应里没有 parse 解析脚本",
            })

        token = (token_info.get("extension") or {}).get("url") or token_info.get("url")
        if not token:
            raise DmghgError("legacy.rpc/videoPlay", {
                "code": "no_token", "message": "响应里没有播放令牌",
            })

        script = self._build_parser_script(parse_lua, install_dir)
        result = self.call("rule.execute_script_text", {"script": script, "args": [token]})

        json_value = ((result or {}).get("result") or {}).get("json_value") or {}
        state = json_value.get("state")
        if state != "OK":
            raise DmghgError("rule.execute_script_text", {
                "code": state or "unknown",
                "message": f"解析未成功: {state}",
                "detail": json_value,
            })
        try:
            return json.loads(json_value["data"])
        except (KeyError, json.JSONDecodeError) as exc:
            raise DmghgError("rule.execute_script_text", {
                "code": "bad_payload", "message": str(exc), "detail": json_value,
            }) from exc

    @staticmethod
    def _build_parser_script(parse_lua: str, install_dir: str) -> str:
        """拼出可执行脚本。

        三个必须的前置：
          1. 沙箱里没有 json 全局 —— 内联 dkjson.lua
          2. 脚本开头有版本白名单 —— 覆盖 device_info 绕过（否则拿到"引导视频"）
          3. 脚本会调 UI 的 toast —— 给个空桩
        """
        dkjson_path = os.path.join(install_dir, "resources", "lua", "dkjson.lua")
        with open(dkjson_path, encoding="utf-8") as fh:
            dkjson = fh.read()

        prelude = (
            "json = (function()\n" + dkjson + "\nend)()\n"
            'device_info = { platform = "Windows", app_version = "1.4.4" }\n'
            "toast = function(...) end\n"
        )
        return prelude + parse_lua

    # -- 历史 / 收藏 ------------------------------------------------------

    def get_history(self) -> Any:
        return self.call("catalog.get_history")

    def put_history(self, video_id: str | int, part: str, play: str, position: int = 0) -> Any:
        return self.call(
            "catalog.put_history",
            {"id": str(video_id), "part": part, "play": play, "position": position},
        )

    def get_collect(self) -> Any:
        return self.call("catalog.get_collect")

    def toggle_collect(self, video_id: str | int) -> Any:
        return self.call("catalog.toggle_collect", {"id": str(video_id)})

    # -- 弹幕 -------------------------------------------------------------

    def search_danmaku(self, keyword: str) -> Any:
        return self.call("danmaku.search_external", {"keyword": keyword})

    def get_danmaku(self, episode_id: str | int) -> Any:
        return self.call("danmaku.get_external_comments", {"episode_id": str(episode_id)})

    def convert_to_ass(self, comments: Any) -> Any:
        return self.call("danmaku.convert_to_ass", {"comments": comments})


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def _print(obj: Any) -> None:
    if isinstance(obj, (dict, list)):
        print(json.dumps(obj, ensure_ascii=False, indent=2))
    else:
        print(obj)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="dmghg 接口参考实现")
    parser.add_argument("--legacy-host", default=LEGACY_HOST)
    sub = parser.add_subparsers(dest="cmd", required=True)

    sub.add_parser("channels", help="列出所有分类")
    sub.add_parser("banners", help="首页 banner")

    p = sub.add_parser("list", help="视频列表")
    p.add_argument("--channel", type=int, default=0)
    p.add_argument("--page", type=int, default=1)
    p.add_argument("--limit", type=int, default=20)
    p.add_argument("--sort", default="hits")

    p = sub.add_parser("search", help="搜索")
    p.add_argument("key")

    p = sub.add_parser("detail", help="详情")
    p.add_argument("video_id")

    p = sub.add_parser("play", help="解析真实播放地址")
    p.add_argument("video_id")
    p.add_argument("--part", required=True, help='集名，如 "第01集"')
    p.add_argument("--line", default="cn", help='线路代码，如 "cn"（默认国语）')

    p = sub.add_parser("raw", help="原始命令")
    p.add_argument("command")
    p.add_argument("payload", nargs="?", default="{}")

    args = parser.parse_args(argv)

    with DmghgBridge(legacy_host=args.legacy_host) as bridge:
        if args.cmd == "channels":
            for ch in bridge.get_channels():
                print(f"  id={ch.get('id'):<4} {ch.get('name'):<10} "
                      f"areas={ch.get('areas')} types={len(ch.get('types') or [])}")
        elif args.cmd == "banners":
            _print(bridge.get_banners())
        elif args.cmd == "list":
            page = bridge.get_video_list(args.channel, args.page, args.limit, args.sort)
            print(f"total={page.get('total')} items={len(page.get('items') or [])}")
            for it in (page.get("items") or [])[:30]:
                print(f"  {it.get('id'):<8} {it.get('name')}")
        elif args.cmd == "search":
            _print(bridge.search(args.key))
        elif args.cmd == "detail":
            d = bridge.get_detail(args.video_id)
            print(f"{d.get('name')}  id={d.get('id')}  总集数={d.get('total')}  source={d.get('source')}")
            print(f"简介: {str(d.get('content'))[:120]}...")
            for p_ in d.get("parts") or []:
                print(f"  线路 play={p_.get('play')!r} ({p_.get('play_zh')}) "
                      f"共 {len(p_.get('part') or [])} 集")
                print(f"    前5集: {(p_.get('part') or [])[:5]}")
        elif args.cmd == "play":
            urls = bridge.resolve_play_url(args.video_id, args.part, args.line)
            print(f"解析成功，{len(urls)} 条：")
            for u in urls:
                print(f"  [{u.get('name')}] {u.get('url')}")
        elif args.cmd == "raw":
            _print(bridge.call_raw(args.command, json.loads(args.payload)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
