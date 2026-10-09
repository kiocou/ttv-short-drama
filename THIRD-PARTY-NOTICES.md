# 第三方组件与许可证清单（THIRD-PARTY NOTICES）

本应用随包分发以下第三方组件。它们**不在**仓库根目录 `LICENSE`（MIT）的覆盖范围内，
各自遵循其原始许可证。本清单的目的是让再分发者一眼看清"要移除什么、要保留什么声明"。

> ⚠️ 本项目本身只做客户端整合：不托管任何内容，所有剧集数据与视频流均来自第三方
> 站点 / 接口，版权归各自权利人所有。仅供个人学习与技术研究，请勿用于商业用途。

## 一、随包可执行与运行时

| 组件 | 位置 | 版本 / 形态 | 许可证 |
| --- | --- | --- | --- |
| **ffmpeg** | `src-tauri/resources/mpv/ffmpeg.exe` | Windows x64 静态构建，配置含 `--enable-gpl --enable-version3` | **GPLv3**（因启用 GPL 组件，整体按 GPLv3 分发） |
| **嵌入式 CPython** | `src-tauri/resources/python/`（含 `python312.dll`、`python312.zip`、`libcrypto-3.dll` 等） | Python 3.12 embeddable | PSF License；随附 `resources/python/LICENSE.txt` |
| **guo-core（站源适配内核）** | `src-tauri/guo-core/`（Go 源码）与 `src-tauri/resources/guo-core/duanju_core.dll`（预编译二进制） | 本项目自带，源码整棵入库 | 不在 MIT 范围内（见 `LICENSE` 的范围说明） |
| **第三方站源对接实现** | `src-tauri/resources/shortdrama-worker/worker.py`、`.../liushen/` | 本项目自带（含第三方签名算法实现） | 不在 MIT 范围内（见 `LICENSE` 的范围说明） |

### ffmpeg 的 GPLv3 义务

- 分发的是**未修改的官方构建**，无本地补丁。
- 源码获取：<https://ffmpeg.org/download.html>（对应版本号见应用内「设置 → 关于」或
  构建脚本；如需精确对应，可对 `ffmpeg.exe` 执行 `ffmpeg -version` 查看构建配置行）。
- 重新分发本应用（含 `ffmpeg.exe`）时，必须同时满足 GPLv3 的声明与源码提供义务；
  若你不打算承担该义务，请在打包前移除 `src-tauri/resources/mpv/`。

## 二、Python 依赖（`resources/shortdrama-worker/site-packages/`）

| 包 | 版本（实测） | 许可证 |
| --- | --- | --- |
| requests | 2.34.2 | Apache-2.0 |
| urllib3 | 2.7.0 | MIT |
| certifi | — | MPL-2.0 |
| charset_normalizer | — | MIT |
| idna | — | BSD-3-Clause |
| multidict | — | Apache-2.0 |
| h2 / hpack / hyperframe | — | MIT |
| grpclib | — | BSD-3-Clause |
| stringcase | 1.2.0 | MIT |
| pycryptodome / pycryptodomex | 3.23.0 | Public Domain / BSD-2-Clause（见包内 `LICENSE.rst`） |
| gmssl | 3.2.2 | MIT |

各包的完整许可证文本随包分发在 `site-packages/<包名>*.dist-info/licenses/` 或包根目录；
本清单只做索引，不替代原始文本。

## 三、前端与后端依赖

- **前端**（`package.json`，构建时打包进 `dist/`）：React 19（MIT）、React DOM（MIT）、
  hls.js（Apache-2.0）、lucide-react（ISC）、clsx（MIT）；构建工具链 Vite / TypeScript /
  Tailwind CSS / PostCSS（各自 MIT）。
- **Rust**（`src-tauri/Cargo.toml`，静态链接进可执行文件）：Tauri 2（MIT / Apache-2.0）、
  tokio（MIT）、serde（MIT / Apache-2.0）、reqwest（MIT / Apache-2.0）、
  windows-sys（MIT / Apache-2.0）等。完整清单与版本见 `src-tauri/Cargo.lock`；
  许可证以各 crate 的 `license` 字段为准。

## 四、再分发前的检查清单

1. 移除或替换 `src-tauri/resources/mpv/`（GPLv3 义务）——除非你愿意一并履行。
2. 移除 `src-tauri/resources/shortdrama-worker/liushen/`、`worker.py` 内的第三方接口
   对接实现，以及 `src-tauri/guo-core/` 与其编译产物 `duanju_core.dll`。
3. 保留本文件与 `LICENSE`，并保留 CPython 与各 Python 包的原始许可证文本。
4. 不要移除应用内的免责声明与「仅供个人学习」提示。
