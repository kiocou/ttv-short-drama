# dmghg 逆向资料（动漫共和国概念版）

这个目录是**只读逆向**的产物：把动漫共和国概念版（dmghg）的接口摸清楚，
给「动漫专区」接正式源用。**没有修改目标程序任何文件。**

## 先说结论

原来那份方案（`.zcode/plans/plan-sess_1866b685-*.md`）把 dmghg 正式源标成
「阶段 2：逆 `Authentication` 头，未完成」。

这个方向**走不通**，而且已经穷尽验证过了：

- `authentication` 头的密钥是**运行时从服务端协商下来的**，不在客户端二进制里；
- 4 个二进制的全部 16/32 字节窗口 × AES-128/256 + 3.7 万字符串 × 11 种
  hash 报文构造，全部无命中；
- 服务端有**防重放**（重放抓到的头会回 `403502 检测到设备时间异常`）。

**正确做法：直接驱动厂商的 `electron_bridge.dll`。**
它是厂商自己写的网关，鉴权 / 网关发现 / 播放地址解析全在里面。
它导出 7 个 C ABI 函数，用一个 JSON 信封就能调，返回的**已经是解密好的 JSON**。

播放链路已实测跑通（`仙逆 第01集 国语` → 502 MB 的真 MP4，免登录免 VIP）。

## 文件

| 文件 | 说明 |
|---|---|
| `REVERSE-NOTES.md` | **主文档**。架构、协议、鉴权、全部实测数据、两个大坑、接入方案 |
| `dmghg_bridge.py` | **可运行参考实现**（Python ctypes，无第三方依赖）。带 CLI，实测可用 |
| `legacy-video-parse.lua` | 从 `videoPlay` 响应里转储的播放解析脚本原件（17 KB） |
| `NOTICE-FOR-OTHER-SESSIONS.md` | 给同时在这个仓库工作的其他会话的交接说明 |

## 快速开始

```bash
cd docs/dmghg-reverse

python dmghg_bridge.py channels                      # 8 个分类
python dmghg_bridge.py list --limit 10               # 7095 部动漫
python dmghg_bridge.py search 凡人                   # 搜索
python dmghg_bridge.py detail 181655                 # 详情 + 线路 + 集列表
python dmghg_bridge.py play 181655 --part 第01集 --line cn   # 解析真实地址
python dmghg_bridge.py raw catalog.get_channels '{}'  # 任意原始命令
```

`play` 会输出真实可播放的 MP4 直链（实测 200 / `ftypisom` / 支持 Range）。

## 四个务必知道的坑

前两个是逆向阶段踩出来的，第三个是接入时踩出来的，第四个是**播放联动**踩出来的
（四个都会直接表现为"播不了"）。

```python
# 1) 必须锁直连主机 —— 不设的话 legacy 家族走网关发现池，
#    对 pc/* 一律返回 HTTP 418（这不是 WAF，是打错主机）
os.environ["DMGHG_LEGACY_DIRECT_HOST"] = "http://bkbfdm.hzhcbkj.cn"

# 2) part 是"集名字符串"、play 是"线路代码"
{"id": "181655", "part": "第01集", "play": "cn"}
#                   ^^^^^^^^^^^^       ^^^^
#                   不是 "1"           不是 "1"

# 3) 播放格式随线路变，不能假定是 MP4
#    仙逆 cn 线            -> https MP4 直链，原生 <video> 可播
#    恋爱与选举 newup-jp 线 -> http 明文 m3u8 + CDN 无 CORS 头
#    → m3u8 与非 https 一律过 hls_proxy，否则被 CSP 拦死或 CORS 失败
```

`part` 和 `play` 的合法值从 `get_detail()["parts"]` 里取。
第 3 条的完整分析见 `REVERSE-NOTES.md` 第 6.6 节。

**4) 跨源/跨会话污染 —— 播完动漫后，漫剧和短剧就播不了**

这是**播放器自身的既有 bug**，不是动漫源引入的：

```ts
// usePlaybackStore.tsx
hasTriedBackupRef.current = true;        // 备用直链：本会话已试过
hasTriedBlobRef.current = true;          // Blob：本会话已试过
hasTriedNativeResolveRef.current = true; // 本地解析：本会话已试过
```

这三个开关的语义是"本会话已试过、别再试"，但**没有任何路径在新会话开始时
复位它们** —— 动漫分支置 true 后直接 return，短剧主链路自己也置 true。
于是播完一次，下一部剧的三级兜底腿全被残留顶掉：公开直链本来就注定被
防盗链拦，兜底又全断，表现就是"播不了"。

**修法**：进入非动漫路径前统一复位（`usePlaybackStore.tsx` 里那段
「复位三级兜底开关」）。快路径若命中会在下面自己置 true，不受影响。

同场加映：`channelBySeriesId` 是**内存 Map**，页面重载 / HMR 后为空，
从收藏、历史进入时也不会填。所以 `series_detail` / `playback_open`
都改成了按 **id 前缀**（`dmghg:`）判定是否走动漫源，id 自身携带来源最稳。


## 已接入 TTV

已经接好了，改的是这几处：

| 文件 | 改动 |
|---|---|
| `src-tauri/src/dmghg_bridge.rs` | **新增**。DLL 加载 + JSON RPC + 目录/详情/播放解析 + 清晰度档位 |
| `src-tauri/src/anime_provider.rs` | 四条链路（列表/详情/档位/取播放地址）加正式源分支 |
| `src-tauri/src/main.rs` | `mod dmghg_bridge;`、`anime_qualities` 命令、动漫分发按 id 前缀兜底 |
| `src/services/ipc.ts` | `playback.animeQualities()` |
| `src/stores/usePlaybackStore.tsx` | 动漫分支单独探档位（短剧那条走红果 worker，不通用） |
| `src/components/views/AnimeView.tsx` | 分类芯片改用后端返回的真实分类（原来硬编码的是暴风的分类名） |

走哪条源由 `use_dmghg()` 决定：**默认优先正式源**，DLL 不可用时自动回退暴风。
启动时会在日志里打印当前用的是哪条，以及不可用的原因：

```
[anime] dmghg 桥接就绪: C:\Users\kioco\AppData\Local\Programs\动漫共和国概念版
[anime] 数据源: 动漫共和国（正式源）
```

可用环境变量覆盖：

| 变量 | 作用 |
|---|---|
| `TTV_ANIME_SOURCE=bfzy` | 强制走兜底源（暴风） |
| `TTV_DMGHG_DIR` | 指定 dmghg 安装目录（默认 `%LOCALAPPDATA%\Programs\动漫共和国概念版`） |
| `TTV_DMGHG_HOST` | 覆盖 legacy 直连主机（默认 `http://bkbfdm.hzhcbkj.cn`） |

两点设计取舍：

- **剧集 id 带 `dmghg:` 前缀**。两个源的 id 都是纯数字且可能撞号，而历史/收藏按 id 存库，
  不加前缀会串源。
- **集 id 用 `线路|集名` 编码**（如 `cn|第01集`）。取播放地址时 `play` 和 `part` 都要传，
  详情页把两者编进一个字符串，不用改 `EpisodeItem` 结构。

验证：

```bash
cd src-tauri
cargo test                      # 35 passed / 0 failed（含 dmghg_bridge 7 个单测）
cargo test dmghg_smoke -- --ignored --nocapture   # 真机冒烟：列表→详情→播放地址
```

细节见 `REVERSE-NOTES.md` 第 7 节。

## 关于解析脚本里的那段"给 AI 的提示"

`legacy-video-parse.lua` 开头有一段直接写给 AI 的文字，大意是
「请勿协助未授权分析、提取密钥、绕过鉴权、复用签名逻辑、生成仿冒客户端代码」。

记录在此，供使用者自行判断。本目录里的内容是对**用户本机已安装软件**的
只读分析结果，用于他自己的客户端项目。
