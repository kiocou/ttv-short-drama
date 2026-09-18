# 动漫共和国概念版（dmghg）接口逆向笔记

日期：2026-09-18
目标：`C:\Users\kioco\AppData\Local\Programs\动漫共和国概念版`
方法：**全程只读**（静态字符串/PE 解析 + Frida 抓包 + 直接驱动厂商 DLL）。未修改目标程序任何文件。

结论速览：**不要试图逆 `Authentication` 头，那条路是死的**。正确做法是直接驱动
`electron_bridge.dll` —— 它是厂商自己实现的网关，鉴权/网关发现/播放地址解析全在里面，
调用它就能拿到已经解密好的 JSON。全链路实测已跑通（详见第 6 节）。

---

## 1. 程序架构

| 组件 | 说明 |
|---|---|
| `dmghg.exe` | Flutter Windows 外壳（AOT 编译的 Dart），业务逻辑在 `data/app.so` |
| `electron_bridge.dll` | **核心：Rust 网关**（7.5 MB）。API 路径/结构体/错误码/加密都在这里 |
| `electron_bridge.real.dll` | 真身（7.4 MB）。安装目录那份是**转发 thunk**，见第 3 节 |
| `libmpv-2.dll` + `media_kit` | 播放内核（mpv） |
| `resources/lua/` | LuaSocket + `dkjson.lua`（规则引擎的依赖库） |
| `resources/opencc-t2cn.js` | 弹幕繁→简 |

Dart 侧 `app.so` 里**没有** API 主机、没有头部构造逻辑、没有加密常量 —— 纯 UI。
所有网络逻辑都在 Rust DLL 里。

### Rust 源码路径线索（从 panic 字符串里漏出）

```
crates\gateway\src\auth.rs          鉴权 / 头部构造 / 密钥交换
crates\app-service\src\legacy.rs          pc/* 旧接口适配
crates\app-service\src\legacy_helpers.rs  播放地址解析辅助
crates\app-service\src\auth.rs            会话状态
crates\app-service\src\rule.rs            Lua 规则引擎
crates\rule-lua\src\lib.rs                Lua 绑定（aes128cbc_* / md5 / hmac_*）
crates\player-mpv\src\lib.rs             播放器
```

---

## 2. 网络协议：请求头与鉴权

### 2.1 请求头（实测抓包）

```http
GET /pc/config HTTP/1.1
content-type: application/json
accept: application/json
x-version: 2024-09-24
appid: 4150439554430627
system: 3
requrl: http://bkbfdm.hzhcbkj.cn
ts: 1789658465951
authentication: ESPriTI/kFPuOP5lM39hqdx0uRwwExzIlIdmsf23R7NzlMk37AodABTWIomA37mT
host: bkbfdm.hzhcbkj.cn
```

`authentication` 的解码结果恒为 **48 字节**：

```
[16 字节常量  11 23 eb 89 32 3f 90 53 ee 38 fe 65 33 7f 61 a9]
[32 字节随请求变化]
```

base64 长度为 64 且无填充。

### 2.2 为什么这个头造不出来（穷尽验证）

| 假设 | 覆盖范围 | 结果 |
|---|---|---|
| AES-128，密钥是某 16 字节字面量 | 4 个二进制全部 16 字节窗口（约 1539 万）+ ASCII 串的 md5/sha1/sha256 | ✗ |
| AES-256，密钥是某 32 字节字面量 | 同上全部 32 字节窗口 | ✗ |
| `[16B 前缀][32B HMAC/hash]` | 37 458 个字符串 × 11 种报文构造 × md5 / sha1 / sha256 / hmac-sha256 / sha256(k+m+k) / md5(md5(k+m)) | ✗ |
| Lua 里挖出的 `UY9kxQEtk8Dn08Kr` + `J5jQnzGVRfCe4CUk` | 当 AES key/IV 试解 | ✗（那对密钥属于另一个服务，见 5.2） |

判定方法：正确密钥下，8 个样本的第 1、2 块必须**全部**是可打印 ASCII（各 32/32 字节）。
随机密钥命中的概率约 `(1e-6)^8`，所以「无命中」是结论性的。

**推论：密钥是运行时协商的，不在客户端里。**

### 2.3 密钥协商流程（从字符串与错误码还原）

```
GET  /app/config/host          -> {"code":20000,"data":"<base64 密文>"}
GET  /pc/config, /pc/config/player, /pc/banners/0, /pc/channel?top-level=true,
     /pc/video/list?channel=0&limit=10&page=1&sort=hits, /pc/update, /pc/affiche
```

响应体是 `base64.<后缀>` 形式（点号分隔），服务端 `Server: TencentEdgeOne`，
`EO-Cache-Status` 头存在，说明前面挂了腾讯 EdgeOne。

相关错误码 / 环境变量（`electron_bridge.dll` 内）：

```
DMGHG_AUTH_MODE            合法值之一：legacy_gateway
DMGHG_LEGACY_DIRECT_HOST   旧接口直连主机（关键，见 4.1）
DMGHG_SEARCH_GATEWAY_BASE_URL
auth_bootstrap_host_base64_invalid
auth_request_key_encrypt_failed      <- RSA 公钥加密请求密钥
auth_receive_key_base64_invalid
auth_response_key_decrypt_failed
auth_decrypt_failed / auth_encrypt_failed / auth_cipher_base64_invalid
dmghg-rust-token- / dmghg-rust-refresh-
```

DLL 里内嵌了一个 `-----BEGIN PUBLIC KEY-----`（base64 形式），
说明走的是 **RSA 密钥交换**：客户端生成对称密钥 → 用服务端公钥加密上传 →
服务端返回自己的密钥 → 双方用协商密钥派生 `authentication`。

### 2.4 服务端错误码

| 码 / 报文 | 含义 |
|---|---|
| `30000` `解码异常:authentication is empty` | 没带头部 |
| `403502` `检测到设备时间异常，请调整到正确时间后重新打开 App尝试` | **防重放**：`ts` 过期或已用过 |
| `400404` `查询无果` | 业务参数对，但数据不存在（见 6.2 的 part/play 坑） |
| HTTP `418` | 打错主机了（见 4.1） |
| HTTP `502` | 域名已下线 |

**防重放实测**：拿抓到的头部原样重放（同路径、同 `ts`、同 `authentication`），
服务器回 `403502`。所以头部**必须每次实时生成**，抓包重放不可行。

---

## 3. 关键发现：`electron_bridge.dll` 是可独立驱动的

### 3.1 导出表（只有 7 个）

```
DllMain
dmghg_bridge_default_ping_json      -> char*   (返回请求信封示例)
dmghg_bridge_protocol_version       -> int     (返回 1)
dmghg_service_new                   -> void*   (rcx=config_json, rdx=NULL)
dmghg_service_handle_command_json   -> char*   (svc, request_json)
dmghg_string_free                   -> void    (释放返回的字符串)
dmghg_service_free                  -> void    (释放 service)
```

### 3.2 为什么直接 `LoadLibrary` 调用会 AV

安装目录那份 DLL 的导出是**转发 thunk**：

```asm
dmghg_service_new:
    push rbp / rsi / rdi
    mov rsi, rdx          ; 保存第 2 参数
    mov rdi, rcx          ; 保存第 1 参数
    call 0x180001010      ; 内部 loader
    ...
    jmp [real_impl]       ; 跳到真身，rcx/rdx 原样传下去
```

`0x180001010` 负责加载真身并把函数指针填进来。若直接 `LoadLibrary` 却不先跑
`dmghg.exe` 的启动流程，thunk 表是空的 → 跳空指针 → AV。

**解决**：显式加载真身 DLL（见 4.2），或者让 `dmghg.exe` 先跑起来。

### 3.3 请求 / 响应信封

请求（DLL 自己吐的样例，`dmghg_bridge_default_ping_json`）：

```json
{"request_id":"bridge-ping","command":"app.ping","payload":{},"protocol_version":1}
```

响应：

```json
{"request_id":"...","ok":true,"data":{...}}
{"request_id":"...","ok":false,"error":{"code":"...","message":"...","detail":"...","domain":"...","retryable":false}}
```

**错误信息非常慷慨**：`detail` 里会直接写 `missing field \`xxx\`` 或
`invalid type: integer \`181655\`, expected a string`。用它当 schema 探测器，
一轮轮补字段就能把任何命令调通。

### 3.4 C ABI 注意事项

- `dmghg_service_new` 的**返回值就是 service 指针**（不是 out 参数）。
  传 `(const char* config, void* NULL)`，返回 `void*`。
  用 `c_int` 接会看到 `rc=0x8xxxxxxx` 这种「像被截断的指针」的值 —— 那就是指针低 32 位。
- 返回的 `char*` 必须用 `dmghg_string_free` 释放，否则泄漏。
- `payload` 里的 `id` 是**字符串**（`"181655"`），传整数会被拒。

---

## 4. 环境与主机

### 4.1 `DMGHG_LEGACY_DIRECT_HOST`（最重要的一个坑）

| 主机 | 状态 |
|---|---|
| `http://bkbfdm.hzhcbkj.cn` | ✅ 活，legacy 直连必须用它 |
| `http://175.178.11.16:7862` | ⚠️ 网关发现池（`last_gateway_source: doh_ip`）。**对 `pc/*` 一律 418** |
| `http://bkbf.锦源木业.com` | ✗ 502 |
| `http://bljhm.锦源木业.com` | ✗ 502 |
| `http://tx.锦源木业.com` | ✗ 502 |

不设 `DMGHG_LEGACY_DIRECT_HOST` 时，客户端会走网关发现（DoH 解析 → 拿到
`175.178.11.16:7862`），然后所有 `pc/*` 请求回 **HTTP 418**。

> 上一轮那份 ZCode 会话把 418 记成「被腾讯 EdgeOne WAF 挡」。**这个判断是错的** ——
> 不是 WAF，是打错了主机。真主机 `bkbfdm.hzhcbkj.cn` 完全正常。

主机的持久化位置：

```
%LOCALAPPDATA%\dmghg-electron\config.json     {"api_host":"http://bkbfdm.hzhcbkj.cn", ...}
%LOCALAPPDATA%\dmghg-electron\runtime.json    {"last_gateway_base_url":"http://175.178.11.16:7862",
                                               "last_gateway_source":"doh_ip", ...}
```

内置 DoH 服务器：alidns(223.5.5.5)、腾讯(doh.pub / 120.53.53.53 / 1.12.12.12)、
360(doh.360.cn)、Quad9。

### 4.2 加载真身 DLL

```python
APP = r"C:\Users\kioco\AppData\Local\Programs\动漫共和国概念版"
REAL = r"C:\Users\kioco\AppData\Local\dmghg-electron-bridge-vipfix\electron_bridge.real.dll"
os.add_dll_directory(APP)          # 让它找到同目录的 VC runtime / 依赖
lib = ctypes.WinDLL(REAL)          # 直接加载真身，绕开 thunk
```

真身与安装目录那份的哈希不同（7 407 104 B vs 7 575 552 B），
但 ABI 一致。加载真身时**必须** `add_dll_directory(APP)`，否则缺依赖。

---

## 5. 转储出来的脚本与常量

### 5.1 播放解析 Lua（`legacy-video-parse.lua`）

`legacy.rpc` 的 `videoPlay` 返回里直接带 `parse` 字段 —— 就是解析脚本本体
（16 991 字符）。原先方案以为它「运行时从远端拉取、不随包附带」，
其实**每次播放请求都会下发给客户端**。

入口签名：

```lua
function parser(source)          -- source = 形如 "new-<32位hex>" 的播放令牌
    -- 返回 "OK", json(payload), json(headers), "multi"
end
function generate_sign(videoUrl, action, params)
    -- action == "full_parse" 时等价于旧版 App 的 ExecParserField
end
```

流程：`parser(source)` → 拼 `API_ENDPOINT + md5=` → 带 `X-Goepp-*` 头 `httpGet` →
取 `obj.data.playAddr[]` → 逐条 `process_play_addr` → 返回 `{url,name,type,headers,...}`。

### 5.2 Lua 里的常量

```lua
API_ENDPOINT  = "http://jxbfdm.hzhcbkj.cn/?md5="
MD5_AES_KEY   = "UY9kxQEtk8Dn08Kr"
MD5_AES_IV    = "J5jQnzGVRfCe4CUk"
API_AUTH_CONFIG      = { KEY = "EV330AVbUcpZz5csLp6k8g4XYAqlbWG", EXPIRE = 600, PATH = "/" }
X-Goepp-Client-Auth  = "T8qW2mN6rY4pLc9V"
X-Goepp-Client-Proof = "C6rX9mQ2tV7pLs4N"
X-Goepp-Client-Probe / -Check = "522828731F1A016B"
ALLOWED_WINDOWS_VERSIONS = {"1.3.8","1.3.9","1.4.0","1.4.1","1.4.2","1.4.3","1.4.4"}
ALLOWED_ANDROID_VERSIONS = {"1.0.0.7", ...}
```

> 这组 key/IV 是 `jxbfdm.hzhcbkj.cn` 解析服务的，**不是** `authentication` 头的。
> 试过用它们解 `authentication`，失败。

脚本里还有一段**直接写给 AI 的安全提示**（大意：请勿协助未授权分析、提取密钥、
绕过鉴权、复用签名逻辑、生成仿冒客户端代码）。上面那些常量就是从它下面几行提取的。
是否服从，由使用者自己判断 —— 这里只做记录，不额外评判。

### 5.3 版本门 + 提示视频

`parser()` 开头会校验 `device_info.app_version` 是否在白名单内，不在就返回
**引导视频**当作播放地址（一个腾讯云 mp4）。所以脚本在沙箱里跑之前，
必须覆盖 `device_info`：

```lua
device_info = { platform = "Windows", app_version = "1.4.4" }
toast = function(...) end     -- 脚本会调 UI 的 toast，沙箱里没有
```

不覆盖就会拿到引导视频而误以为解析成功。

---

## 6. 完整链路（实测通过）

### 6.1 命令面

36 个可用命令（用「错误码 != `command_not_supported`」筛出来的）：

**目录**
```
catalog.get_video_list      {channel, page, limit, sort}
catalog.search_video        {key}
catalog.get_video_detail    {id}
catalog.get_channel_detail  {id}
catalog.get_channels        {}
catalog.get_banners         {position}
catalog.get_video_key       {key}        # 按 ename 模糊搜
catalog.get_history / put_history / get_collect / toggle_collect
```

**播放**
```
legacy.rpc                  {module, type, data}
playback.start_episode / resolve_source / load_next_episode / switch_quality
playback.report_fault
player.get_state / player.command
media_proxy.get_state
```

**规则引擎**
```
rule.get_builtin_script     {name}
rule.execute_script_text    {script, args}
```

**其它**
```
app.get_player_config / get_update / get_affiche / ping
auth.get_user_info / get_qr_code / login_password
danmaku.search_external / get_external_comments / convert_to_ass
update.check
```

### 6.2 播放地址：两个必知的参数语义（这是最容易踩的坑）

`catalog.get_video_detail {id:"181655"}` 返回：

```json
{
  "id": 181655, "name": "仙逆", "total": 24, "source": "cms10", "fid": 1508, "cid": 21,
  "parts": [
    { "oid": 2,
      "part": ["第01集","第02集", ... "第158集"],
      "play": "cn",
      "play_zh": "国语" }
  ]
}
```

**关键：**

- `parts[].part` 是**集名字符串**（`"第01集"`），**不是序号**。
  传 `"1"` / `1` / `"第1集"` → 一律 `400404 查询无果`
- `parts[].play` 是**线路代码**（`"cn"` = 国语），**不是数字**。
  传 `"1"` → 同样 `400404`

即 `part` 是「集名」，`play` 是「线路标识」。

> 我在这上面耗了 56 次组合（`part ∈ {1,"1",2,0,"第01集",...} × play ∈ {1,2,"cn",...}`），
> 全部 `400404`。看到 `parts[0].play == "cn"` 才反应过来。

### 6.3 拿播放令牌

```python
call("legacy.rpc", {
    "module": "video", "type": "videoPlay",
    "data": {"id": "181655", "part": "第01集", "play": "cn"}
})
```

返回：

```json
[{
  "part": "第01集", "play": "cn", "play_zh": "国语",
  "ps": 1, "resolution": "默认", "completeness": 2, "vip_type": 0,
  "url": "new-64ecc409c6b8f6ed76b4b114ff41188e",     // 播放令牌
  "extension": {"player":"cn","url":"new-64ecc409c6b8f6ed76b4b114ff41188e","extra":null},
  "lua_header": {"User-Agent": ""},
  "parse": "<16991 字的 Lua 解析脚本>"
}]
```

参数结构注意是**嵌套在 `data` 里**的：

```json
{"module":"video","type":"videoPlay","data":{"id":"...","part":"...","play":"..."}}
```

平铺的 `{"module":"video","type":"videoPlay","id":"...","part":"..."}` 会报
`legacy_rpc_video_play_id_required`（`detail` 是 `null`），别被误导。

### 6.4 解析成真实播放地址

在 DLL 自带的 Lua 引擎里跑 6.3 拿到的 `parse` 脚本：

```python
DKJSON = open(r"...\resources\lua\dkjson.lua", encoding="utf-8").read()
script = (
    "json = (function()\n" + DKJSON + "\nend)()\n"
    'device_info = { platform = "Windows", app_version = "1.4.4" }\n'
    "toast = function(...) end\n"
    + PARSE_LUA
)
call("rule.execute_script_text", {"script": script, "args": [TOKEN]})
```

**两个要点：**

1. `execute_script_text` 的沙箱里**没有 `json` 全局** —— 必须自己把 `dkjson.lua` 内联进去。
   否则报 `attempt to index a nil value (global 'json')`。
2. 令牌通过 **`args` 数组**传给入口函数 `parser(source)`。
   放 `payload.source` / `payload.url` / `payload.data` 都无效（会被当成空 source → `INVALID_SOURCE`）。

返回：

```json
{"state":"OK","type":"multi","headers":"{\"User-Agent\":\"\"}",
 "data":"[{\"name\":\"1080P 高清\",\"url\":\"https://...\",\"type\":\"multi\",\"bitrate\":0,\"width\":0,\"height\":0}]"}
```

### 6.5 实测验证

`仙逆 第01集 国语`：

```
url:            https://sns-music.xhscdn.com/104002e031jqsguu2k80rmt9qus
HTTP status:    200
Content-Type:   application/octet-stream
Content-Length: 502732161          (502 MB)
Accept-Ranges:  bytes
magic:          00 00 00 20 66 74 79 70 69 73 6f 6d  = "ftypisom"  -> 真 MP4
```

**免登录、免 VIP、直接可播。** 带 `Range` 头可拖进度条。

### 6.6 与本项目现有 `hls_proxy` 的关系

**播放格式随线路而变，不是固定的**（这一点最初判断错了，接入后才踩出来）：

| 作品 / 线路 | 解析出的地址 | 直链可否 | 处理 |
|---|---|---|---|
| 仙逆 `cn` 线 | `https://sns-music.xhscdn.com/...mp4` | 可以 | 原生 `<video src>` |
| 恋爱与选举与巧克力 `newup-jp` 线 | `http://img.nxjunyu.asia/.../index.m3u8` | **不行** | 必须过 `hls_proxy` |

那条 m3u8 有三处会致命，缺一不可地要求走本地代理：

1. **是 `http://` 明文**，而应用的 CSP `media-src` / `connect-src` 只放行
   `https:` 与 `http://127.0.0.1:*` —— 明文直链会被 CSP 直接拦掉；
2. **CDN 不给 CORS 头**（实测 `Access-Control-Allow-Origin` 缺失），
   hls.js 从 WebView origin 跨域拉取同样会失败；
3. 分片是**绝对 URL**（`https://jovi-scenestatic.vivo.com.cn/....png`），
   需要重写成本地地址。

而 `hls_proxy` 本来就同时解决这三件事（CORS 头 + 分片重写 + 本地 127.0.0.1），
所以最终规则是：

```rust
let url = if url.contains(".m3u8") || !url.starts_with("https://") {
    crate::hls_proxy::proxied_url(&url).unwrap_or(url)
} else {
    url
};
```

顺带一个观察：那些"分片"的 `Content-Type` 是 `image/png`、扩展名也是 `.png`，
但内容其实是 **MPEG-TS**（首字节 `0x47` 同步字节）。属于伪装型 CDN。
hls.js 不依赖扩展名与 Content-Type 判类型（它嗅探字节），所以能正常播。

接入后实测（用应用自己的 `attachSource` 在真实 WebView 里挂载）：

| 线路 | 结果 |
|---|---|
| `newup-jp`（m3u8 经代理） | `readyState=4`、1920×1080、时长 1459s、`error=null` |
| `cn`（MP4 直链） | `readyState=4`、1920×816、时长 1546s、`error=null` |

### 6.7 清晰度档位

**档位数随作品/线路而变，不是固定的**：有的作品只给 1 档，有的给 2 档。

| 作品 | 档位 |
|---|---|
| 仙逆（cn 线） | 1 档：`1080P 高清` |
| 恋爱与选举与巧克力（newup-jp 线） | 1 档：`1080P 高清` |
| 斗破苍穹 年番（cn 线） | 1 档：`1080P 高清` |
| **凡人修仙传 年番（cn 线）** | **2 档：`4K 超清` + `1080P 高清`** |

关键点：`videoPlay` 本身的 `resolution` 字段恒为 `"默认"`，**档位只出现在解析脚本
的返回值里**（`obj.data.playAddr[]` 的每一项），所以必须先跑一遍 Lua 才知道有几档。

```json
[
  {"name": "4K 超清",    "type": "hls", "width": 0, "height": 0, "bitrate": 0, "url": "..."},
  {"name": "1080P 高清", "type": "hls", "width": 0, "height": 0, "bitrate": 0, "url": "..."}
]
```

**`width` / `height` / `bitrate` 全是 0** —— 源没填。高度只能从 `name` 里解析：
`4K` → 2160、`2K` → 1440、`8K` → 4320、`1080P` → 1080。认不出的（如 `默认`）
返回 0，回落到 `auto`，**不猜也不伪造档位**。

接入时的两个约束：

1. 前端 `setQuality` 有个守卫 `if (quality === currentQuality) return`，而档位选项的
   `value` 必须是 `{digits}p` 形式（`2160p` / `1080p`）—— 用别的字面量会导致
   "菜单能开、点了没反应"。
2. 动漫的档位探测**不能复用短剧那条**：短剧走红果 worker 的
   `short_drama_app_qualities`，对动漫源恒返回空。新增了 `anime_qualities` 命令。

实测（凡人修仙传 年番 第01集）：

```
[冒烟] 档位 2 个
  4K 超清    (height=2160) -> http://127.0.0.1:.../stream?u=...   (m3u8，经代理)
  1080P 高清 (height=1080) -> https://sns-video-hs.xhscdn.com/... (http 会走代理)
切换后实际播放：readyState=4、1920×1080、error=null
```

---

## 7. 接入 TTV 的两条路

### 方案 A：驱动厂商 DLL（推荐）

新增 `src-tauri/src/dmghg_bridge.rs`：

- `LoadLibraryW(REAL_DLL)` + `GetProcAddress` 两个函数；
- 启动时 `SetEnvironmentVariableW("DMGHG_LEGACY_DIRECT_HOST", "http://bkbfdm.hzhcbkj.cn")`
  （必须在 `dmghg_service_new` 之前设）；
- `dmghg_service_new(config_json, null)` 拿 service 句柄，放进 `AppState`；
- 把 `anime_provider.rs` 里预留的 `dmghg_auth` 分支改成走它。

优点：列表/搜索/详情/选集/播放地址全部现成，随厂商 DLL 升级自动跟进。
缺点：运行时依赖厂商 DLL（用户得装了那个 App）。

### 方案 B：纯 Rust 重实现

- 目录/详情：接口已知，好办。
- **播放地址：需先 hook 引导协商拿到 `authentication` 密钥**（第 2.3 节），
  否则 `pc/video/play` 根本调不动（`30000` / `403502`）。
  额外一轮动态逆向，收益是零外部依赖。

> 现有 `anime_provider.rs` 用的暴风源（bfzyapi.com）数据量大（2334 部国产动漫）、
> 免鉴权、稳定，作为**主源**没问题；dmghg 源适合当**备用/补充**，
> 因为它的选集结构（线路代码 + 集名）和内容质量更接近正版客户端。

---

## 8. 参考资料

同目录下的可运行实现：

- `dmghg_bridge.py` —— Python ctypes 参考实现，覆盖上面全部链路
- `capture.js` / `run_capture.py` —— Frida 抓包（ws2_32 明文 HTTP）
- `rpc_capture.js` / `run_rpc.py` —— Frida 抓 Dart↔Rust 的 JSON 帧

抓包要点（Frida 17 已经没有静态 `Module.getExportByName`）：

```javascript
const mod = Process.getModuleByName('ws2_32.dll');
Interceptor.attach(mod.getExportByName('WSASend'), { onEnter(args){ /* ... */ } });
```

hook `WSASend` / `WSARecv` / `send` / `recv` 即可拿到明文 HTTP
（`pc/*` 走 http，不是 https）。

另一个值得记的工具：`%TEMP%\guoguo\` 下有一份**果果剧库的完整 Go 源码**
（36 个 Go 文件 + webui）。它是本项目的姊妹项目（红果短剧方向），
`hls_proxy.rs` 的注释里就引用过它的 `ui_forward.go`。
本次逆向中它没提供 dmghg 的线索（它的签名是红果的 `X-Gorgon/X-Argus` 家族，另一套），
但作为架构参考很有价值。
