//! dmghg（动漫共和国概念版）源桥接。
//!
//! 直接加载厂商的 `electron_bridge` DLL 并调用它的 JSON RPC：鉴权、DoH 网关发现、
//! 播放地址解析全部在 DLL 内部完成，返回的已经是解密后的 JSON。
//!
//! **为什么不自己实现请求头**：`authentication` 头的密钥是运行时与服务端 RSA
//! 协商出来的，不在客户端二进制里（4 个二进制全部 16/32 字节窗口 × AES-128/256
//! 穷尽无命中），且服务端有防重放（重放旧头会回 `403502`）。详见
//! `docs/dmghg-reverse/REVERSE-NOTES.md`。
//!
//! **两个必须记住的坑**：
//! 1. `DMGHG_LEGACY_DIRECT_HOST` 必须在 `dmghg_service_new` **之前**设成
//!    `http://bkbfdm.hzhcbkj.cn`。不设的话 legacy 家族会走网关发现池
//!    `175.178.11.16:7862`，对 `pc/*` 一律返回 HTTP 418。
//! 2. 取播放地址时 `part` 是**集名字符串**（`"第01集"`）、`play` 是**线路代码**
//!    （`"cn"`）。传数字一律 `400404 查询无果`。

use std::ffi::CString;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, MutexGuard, OnceLock};

use serde_json::{json, Value};

use crate::models::{
    CatalogFilter, CatalogPage, EpisodeItem, SeriesDetail, SeriesItem, VideoQualityOption,
};

/// dmghg 剧集 id 前缀。
///
/// 两个源的 id 都是纯数字（dmghg `181655` / 暴风 `158973`）且可能撞号，
/// 而历史与收藏按 id 存库，所以必须加前缀区分来源。
pub const ID_PREFIX: &str = "dmghg:";

/// 一档清晰度：来源只给中文名（`4K 超清` / `1080P 高清`），且 `width`/`height`
/// 字段恒为 0，所以高度只能从名字里解析。
#[derive(Debug, Clone)]
pub struct PlayVariant {
    pub name: String,
    pub url: String,
    pub height: u32,
}

/// 集 id 用 `线路|集名` 编码（取播放地址时两个值都要用）。
const EPISODE_SEP: char = '|';

const DEFAULT_LEGACY_HOST: &str = "http://bkbfdm.hzhcbkj.cn";
const PROTOCOL_VERSION: u32 = 1;
/// 解析脚本会校验版本白名单（1.3.8~1.4.4），不在名单内会返回"引导视频"。
const SPOOF_APP_VERSION: &str = "1.4.4";

static REQUEST_SEQ: AtomicU64 = AtomicU64::new(0);

// ---------------------------------------------------------------------------
// Kernel32 FFI
//
// 自己声明而不走 windows-sys：只需要 3 个函数，省得受 feature 组合牵制。
// ---------------------------------------------------------------------------

#[link(name = "kernel32")]
extern "system" {
    fn LoadLibraryExW(
        file_name: *const u16,
        file: *mut std::ffi::c_void,
        flags: u32,
    ) -> *mut std::ffi::c_void;
    fn GetProcAddress(module: *mut std::ffi::c_void, name: *const u8) -> *mut std::ffi::c_void;
    fn AddDllDirectory(path: *const u16) -> *mut std::ffi::c_void;
}

const LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR: u32 = 0x0000_0100;
const LOAD_LIBRARY_SEARCH_USER_DIRS: u32 = 0x0000_0400;
const LOAD_LIBRARY_SEARCH_DEFAULT_DIRS: u32 = 0x0000_1000;

fn wide(path: &Path) -> Vec<u16> {
    use std::os::windows::ffi::OsStrExt;
    path.as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect()
}

/// 加载 DLL：先试"用户目录 + 默认目录"（配合 `AddDllDirectory`），失败再试
/// "DLL 自身目录 + 默认目录"。两次都不动进程级搜索路径。
fn load_library(dll: &Path, search_dir: &Path) -> Result<*mut std::ffi::c_void, String> {
    let dll_wide = wide(dll);
    let dir_wide = wide(search_dir);

    unsafe {
        AddDllDirectory(dir_wide.as_ptr());

        let module = LoadLibraryExW(
            dll_wide.as_ptr(),
            std::ptr::null_mut(),
            LOAD_LIBRARY_SEARCH_USER_DIRS | LOAD_LIBRARY_SEARCH_DEFAULT_DIRS,
        );
        if !module.is_null() {
            return Ok(module);
        }
        let module = LoadLibraryExW(
            dll_wide.as_ptr(),
            std::ptr::null_mut(),
            LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR | LOAD_LIBRARY_SEARCH_DEFAULT_DIRS,
        );
        if !module.is_null() {
            return Ok(module);
        }
    }
    Err(format!("加载失败: {}", dll.display()))
}

fn symbol(module: *mut std::ffi::c_void, name: &str) -> Result<*mut std::ffi::c_void, String> {
    let cname = CString::new(name).map_err(|_| "符号名含 NUL".to_string())?;
    let address = unsafe { GetProcAddress(module, cname.as_ptr() as *const u8) };
    if address.is_null() {
        return Err(format!("导出不存在: {name}"));
    }
    Ok(address)
}

// ---------------------------------------------------------------------------
// 导出函数的签名
//
// 安装目录那份 DLL 的导出是"转发 thunk"：内部 loader 跑完后 jmp 到真身，
// rcx/rdx 原样透传，所以直接按真身签名调用即可。
// ---------------------------------------------------------------------------

type ServiceNewFn =
    unsafe extern "system" fn(*const u8, *mut std::ffi::c_void) -> *mut std::ffi::c_void;
type HandleCommandFn = unsafe extern "system" fn(*mut std::ffi::c_void, *const u8) -> *mut u8;
type StringFreeFn = unsafe extern "system" fn(*mut u8);
type ServiceFreeFn = unsafe extern "system" fn(*mut std::ffi::c_void);

// ---------------------------------------------------------------------------
// 桥接本体
// ---------------------------------------------------------------------------

pub struct DmghgBridge {
    service: *mut std::ffi::c_void,
    handle_command: HandleCommandFn,
    string_free: StringFreeFn,
    service_free: ServiceFreeFn,
    _module: *mut std::ffi::c_void,
    install_dir: PathBuf,
}

// service 句柄是裸指针。DLL 内部状态未知，这里假定它不可并发调用，
// 由外层的 Mutex 串行化（见 `shared()`）。模块与 service 都是进程级常驻，
// 不随线程迁移，所以这里声明 Send 是安全的。
unsafe impl Send for DmghgBridge {}

impl DmghgBridge {
    /// 加载并初始化。`legacy_host` 为空时用默认主机。
    pub fn open(install_dir: &Path, legacy_host: &str) -> Result<Self, String> {
        let legacy_host = if legacy_host.trim().is_empty() {
            DEFAULT_LEGACY_HOST
        } else {
            legacy_host.trim()
        };

        // 必须在 service_new 之前：决定 legacy 家族打哪台主机。
        std::env::set_var("DMGHG_LEGACY_DIRECT_HOST", legacy_host);

        // 优先用安装目录那份（与客户端版本同步）；它内部会转发到真身。
        // 真身单独放了一份，作为兜底。
        let installed = install_dir.join("electron_bridge.dll");
        let dll = if installed.is_file() {
            installed
        } else {
            let real = real_dll_path().ok_or_else(|| "找不到 electron_bridge DLL".to_string())?;
            if !real.is_file() {
                return Err(format!("找不到 electron_bridge DLL: {}", real.display()));
            }
            real
        };

        let module = load_library(&dll, install_dir)?;

        let service_new: ServiceNewFn =
            unsafe { std::mem::transmute(symbol(module, "dmghg_service_new")?) };
        let handle_command: HandleCommandFn =
            unsafe { std::mem::transmute(symbol(module, "dmghg_service_handle_command_json")?) };
        let string_free: StringFreeFn =
            unsafe { std::mem::transmute(symbol(module, "dmghg_string_free")?) };
        let service_free: ServiceFreeFn =
            unsafe { std::mem::transmute(symbol(module, "dmghg_service_free")?) };

        // 第二个参数是真身的 rdx（NULL）。config 留空表示用默认配置。
        let config = CString::new("{}").map_err(|_| "config 含 NUL".to_string())?;
        let service = unsafe { service_new(config.as_ptr() as *const u8, std::ptr::null_mut()) };
        if service.is_null() {
            return Err("dmghg_service_new 返回空指针".into());
        }

        Ok(Self {
            service,
            handle_command,
            string_free,
            service_free,
            _module: module,
            install_dir: install_dir.to_path_buf(),
        })
    }

    /// 发一条命令，返回完整响应（含 `ok`）。
    pub fn call_raw(&self, command: &str, payload: Value) -> Result<Value, String> {
        let request = json!({
            "request_id": format!("ttv-{}", REQUEST_SEQ.fetch_add(1, Ordering::Relaxed)),
            "command": command,
            "payload": payload,
            "protocol_version": PROTOCOL_VERSION,
        });
        let text =
            CString::new(request.to_string()).map_err(|_| "dmghg 请求含 NUL 字符".to_string())?;

        let ptr = unsafe { (self.handle_command)(self.service, text.as_ptr() as *const u8) };
        if ptr.is_null() {
            return Err(format!("dmghg `{command}` 返回空指针"));
        }
        let response = unsafe { std::ffi::CStr::from_ptr(ptr as *const std::os::raw::c_char) }
            .to_string_lossy()
            .into_owned();
        unsafe { (self.string_free)(ptr) };

        serde_json::from_str(&response)
            .map_err(|error| format!("dmghg `{command}` 响应不是合法 JSON: {error}"))
    }

    /// 发一条命令，只取 `data`；`ok=false` 时把 error 摊平报错。
    pub fn call(&self, command: &str, payload: Value) -> Result<Value, String> {
        let response = self.call_raw(command, payload)?;
        if response.get("ok").and_then(Value::as_bool) == Some(true) {
            return Ok(response.get("data").cloned().unwrap_or(Value::Null));
        }
        let error = response.get("error").cloned().unwrap_or(Value::Null);
        let code = error
            .get("code")
            .and_then(Value::as_str)
            .unwrap_or("unknown");
        let message = error.get("message").and_then(Value::as_str).unwrap_or("");
        let detail = error
            .get("detail")
            .map(|d| d.to_string())
            .unwrap_or_default();
        Err(format!(
            "dmghg `{command}` 失败: {code} {message} {}",
            truncate(&detail, 200)
        ))
    }

    // -- 目录 -------------------------------------------------------------

    /// 分类列表。返回 `(channel_id, 名称)`。
    fn channels(&self) -> Result<Vec<(i64, String)>, String> {
        let data = self.call("catalog.get_channels", json!({}))?;
        Ok(data
            .as_array()
            .map(|array| {
                array
                    .iter()
                    .filter_map(|channel| {
                        Some((
                            channel.get("id")?.as_i64()?,
                            channel.get("name")?.as_str()?.to_string(),
                        ))
                    })
                    .collect()
            })
            .unwrap_or_default())
    }

    pub fn catalog(&self, filter: &CatalogFilter) -> Result<CatalogPage, String> {
        let page = filter.page.max(1);
        let page_size = filter.page_size.clamp(1, 60);
        let keyword = filter
            .keyword
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty());

        if let Some(keyword) = keyword {
            let data = self.call("catalog.search_video", json!({ "key": keyword }))?;
            let items = collect_items(&data)
                .iter()
                .filter_map(parse_series_item)
                .collect::<Vec<_>>();
            return Ok(CatalogPage {
                total: items.len(),
                has_more: false,
                items,
                page,
                categories: vec!["全部".to_string()],
                next_cursor: None,
                source: "动漫共和国".into(),
            });
        }

        // 分类用真实频道表，名称直接来自 dmghg（日漫/国漫/剧场/美漫/特摄/少儿…）
        let mut table: Vec<(i64, String)> = vec![(0, "全部".to_string())];
        match self.channels() {
            Ok(list) => table.extend(list),
            Err(error) => {
                // 频道表拿不到不该让整个列表挂掉：退回"全部"
                log_line(&format!("dmghg 分类表获取失败，退回全部: {error}"));
            }
        }
        let channel_id = table
            .iter()
            .find(|(_, name)| name == &filter.category)
            .map(|(id, _)| *id)
            .unwrap_or(0);

        let sort = if filter.sort.trim().is_empty() {
            "hits"
        } else {
            filter.sort.trim()
        };
        let data = self.call(
            "catalog.get_video_list",
            json!({
                "channel": channel_id,
                "page": page,
                "limit": page_size,
                "sort": sort,
            }),
        )?;

        let total = data.get("total").and_then(Value::as_u64).unwrap_or(0) as usize;
        let items = collect_items(&data)
            .iter()
            .filter_map(parse_series_item)
            .collect::<Vec<_>>();
        let has_more = total > 0 && (page as usize) * (page_size as usize) < total;

        Ok(CatalogPage {
            total,
            has_more,
            items,
            page,
            categories: table.into_iter().map(|(_, name)| name).collect(),
            next_cursor: has_more.then(|| (page + 1).to_string()),
            source: "动漫共和国".into(),
        })
    }

    // -- 详情 -------------------------------------------------------------

    pub fn detail(&self, series_id: &str) -> Result<SeriesDetail, String> {
        let raw_id = strip_prefix(series_id);
        let data = self.call("catalog.get_video_detail", json!({ "id": raw_id }))?;

        let title = data
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or("未命名动漫")
            .to_string();
        let cover = data
            .get("pic")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        let description = data
            .get("content")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();

        let mut tags = Vec::new();
        if let Some(class) = data.get("type").and_then(Value::as_str) {
            tags.extend(
                class
                    .split(',')
                    .map(str::trim)
                    .filter(|tag| !tag.is_empty())
                    .map(str::to_string),
            );
        }
        if let Some(area) = data.get("area").and_then(Value::as_str) {
            if !area.is_empty() {
                tags.push(area.to_string());
            }
        }

        let (episodes, count) = parse_episodes(&data, series_id)?;

        Ok(SeriesDetail {
            id: series_id.to_string(),
            title,
            cover,
            item_type: "anime".into(),
            tags,
            origin: "动漫共和国".into(),
            episodes_count: count,
            description,
            episodes,
            available_qualities: vec![VideoQualityOption {
                label: "自动".into(),
                value: "auto".into(),
                resolution: "由播放源自动选择".into(),
            }],
            sources: Vec::new(),
        })
    }

    // -- 播放 -------------------------------------------------------------

    /// 解析出该集的全部清晰度档位。
    ///
    /// `episode_id` 形如 `cn|第01集`。返回按分辨率从高到低排序；
    /// 档位数取决于源的线路（实测有的作品只有 1 档，有的给 2 档）。
    pub fn play_variants(
        &self,
        series_id: &str,
        episode_id: &str,
    ) -> Result<Vec<PlayVariant>, String> {
        let raw_id = strip_prefix(series_id);
        let (line, part) = episode_id
            .split_once(EPISODE_SEP)
            .ok_or_else(|| format!("动漫集标识非法: {episode_id}"))?;

        let data = self.call(
            "legacy.rpc",
            json!({
                "module": "video",
                "type": "videoPlay",
                "data": { "id": raw_id, "part": part, "play": line },
            }),
        )?;
        let item = data
            .as_array()
            .and_then(|array| array.first())
            .or(Some(&data))
            .ok_or_else(|| "dmghg 未返回播放信息".to_string())?;

        let parse_lua = item.get("parse").and_then(Value::as_str).unwrap_or("");
        if parse_lua.trim().is_empty() {
            return Err("dmghg 响应里没有解析脚本".into());
        }
        let token = item
            .get("extension")
            .and_then(|extension| extension.get("url"))
            .and_then(Value::as_str)
            .or_else(|| item.get("url").and_then(Value::as_str))
            .ok_or_else(|| "dmghg 响应里没有播放令牌".to_string())?;

        let script = self.build_parser_script(parse_lua)?;
        let result = self.call(
            "rule.execute_script_text",
            json!({ "script": script, "args": [token] }),
        )?;

        let json_value = result
            .get("result")
            .and_then(|result| result.get("json_value"))
            .cloned()
            .unwrap_or(Value::Null);
        let state = json_value
            .get("state")
            .and_then(Value::as_str)
            .unwrap_or("");
        if state != "OK" {
            return Err(format!("dmghg 解析未成功: state={state}"));
        }
        let payload = json_value.get("data").and_then(Value::as_str).unwrap_or("");
        let parsed: Value = serde_json::from_str(payload)
            .map_err(|error| format!("dmghg 解析结果不是合法 JSON: {error}"))?;

        let mut variants: Vec<PlayVariant> = parsed
            .as_array()
            .map(|array| {
                array
                    .iter()
                    .filter_map(|entry| {
                        let url = entry.get("url").and_then(Value::as_str)?;
                        if url.trim().is_empty() {
                            return None;
                        }
                        let name = entry
                            .get("name")
                            .and_then(Value::as_str)
                            .unwrap_or("")
                            .trim()
                            .to_string();
                        Some(PlayVariant {
                            height: parse_variant_height(&name),
                            name,
                            url: url.to_string(),
                        })
                    })
                    .collect()
            })
            .unwrap_or_default();

        if variants.is_empty() {
            return Err("dmghg 解析结果里没有播放地址".into());
        }
        // 源按"高→低"给，但不依赖它的顺序；同高度保持原有先后。
        variants.sort_by_key(|variant| std::cmp::Reverse(variant.height));
        Ok(variants)
    }

    /// 按选定清晰度取播放地址。
    ///
    /// `quality` 是前端传的档位字面量（形如 `1080p`）；`auto` / 空 / 认不出的值
    /// 优先回落到 **2160p 以外的最高档**（见函数体里的 HEVC 兼容说明）。
    pub fn resolve_play_url(
        &self,
        series_id: &str,
        episode_id: &str,
        quality: &str,
    ) -> Result<String, String> {
        let variants = self.play_variants(series_id, episode_id)?;
        let wanted = parse_quality_value(quality);
        if wanted > 0 {
            if let Some(hit) = variants.iter().find(|variant| variant.height == wanted) {
                return Ok(hit.url.clone());
            }
        }
        // WebView2 的 HEVC 支持不可靠（PlatformHEVCDecoderSupport + 零售扩展都
        // 就位时 153 版仍经常解不出视频轨，表现为黑屏但有声音）。实测这批源里
        // "4K" 档是 HEVC、1080P 及以下是 H.264。所以 auto 优先选 **2160p 以外的
        // 最高档**；4K 仅当用户显式要求时才给。
        let best = variants
            .iter()
            .find(|variant| variant.height < 2160)
            .unwrap_or(&variants[0]);
        Ok(best.url.clone())
    }

    /// 拼出可在规则引擎里跑的脚本。
    ///
    /// 三处必须的前置（缺一个都拿不到真地址）：
    /// 1. 执行沙箱里没有 `json` 全局 —— 内联 `dkjson.lua`；
    /// 2. 脚本开头有版本白名单 —— 覆盖 `device_info`，否则返回"引导视频"；
    /// 3. 脚本会调 UI 的 `toast` —— 给个空桩。
    fn build_parser_script(&self, parse_lua: &str) -> Result<String, String> {
        let dkjson_path = self
            .install_dir
            .join("resources")
            .join("lua")
            .join("dkjson.lua");
        let dkjson = std::fs::read_to_string(&dkjson_path)
            .map_err(|error| format!("读取 dkjson 失败 ({}): {error}", dkjson_path.display()))?;

        let prelude = format!(
            "json = (function()\n{dkjson}\nend)()\n\
             device_info = {{ platform = \"Windows\", app_version = \"{SPOOF_APP_VERSION}\" }}\n\
             toast = function(...) end\n"
        );
        Ok(format!("{prelude}{parse_lua}"))
    }
}

impl Drop for DmghgBridge {
    fn drop(&mut self) {
        // 进程退出前 Tauri 会走到这里。DLL 若已被卸载则不能调，故用 catch 语义保守处理：
        // service 与 module 都是常驻的，这里仅尽力回收。
        if !self.service.is_null() {
            unsafe { (self.service_free)(self.service) };
            self.service = std::ptr::null_mut();
        }
    }
}

// ---------------------------------------------------------------------------
// 进程级单例
// ---------------------------------------------------------------------------

static BRIDGE: OnceLock<Option<Mutex<DmghgBridge>>> = OnceLock::new();
static INIT_ERROR: OnceLock<String> = OnceLock::new();

/// 安装目录：优先 `TTV_DMGHG_DIR`，否则 `%LOCALAPPDATA%\Programs\动漫共和国概念版`。
pub fn install_dir() -> Option<PathBuf> {
    if let Ok(explicit) = std::env::var("TTV_DMGHG_DIR") {
        let path = PathBuf::from(explicit.trim());
        if path.is_dir() {
            return Some(path);
        }
    }
    let base = dirs::data_local_dir()?;
    let candidate = base.join("Programs").join("动漫共和国概念版");
    candidate.is_dir().then_some(candidate)
}

/// 真身 DLL（安装目录那份的内部转发目标，作为兜底）。
fn real_dll_path() -> Option<PathBuf> {
    Some(
        dirs::data_local_dir()?
            .join("dmghg-electron-bridge-vipfix")
            .join("electron_bridge.real.dll"),
    )
}

fn legacy_host() -> String {
    std::env::var("TTV_DMGHG_HOST").unwrap_or_else(|_| DEFAULT_LEGACY_HOST.to_string())
}

/// 源开关：`auto`（默认，桥接可用就用 dmghg）/ `dmghg`（强制）/ `bfzy`（关掉）。
fn source_mode() -> String {
    std::env::var("TTV_ANIME_SOURCE")
        .unwrap_or_else(|_| "auto".to_string())
        .trim()
        .to_ascii_lowercase()
}

/// dmghg 是否应当作为动漫源。
pub fn preferred() -> bool {
    !matches!(source_mode().as_str(), "bfzy" | "fallback" | "off")
}

/// 懒加载单例。首次调用时尝试加载 DLL，失败返回 None 并记下原因。
pub fn shared() -> Option<&'static Mutex<DmghgBridge>> {
    BRIDGE
        .get_or_init(|| {
            let Some(dir) = install_dir() else {
                let _ = INIT_ERROR.set("未找到动漫共和国安装目录".into());
                return None;
            };
            match DmghgBridge::open(&dir, &legacy_host()) {
                Ok(bridge) => {
                    log_line(&format!("dmghg 桥接就绪: {}", dir.display()));
                    Some(Mutex::new(bridge))
                }
                Err(error) => {
                    log_line(&format!("dmghg 桥接不可用: {error}"));
                    let _ = INIT_ERROR.set(error);
                    None
                }
            }
        })
        .as_ref()
}

/// 桥接是否可用（会触发一次加载尝试）。
pub fn available() -> bool {
    shared().is_some()
}

/// 初始化失败原因（诊断用）。
pub fn init_error() -> Option<&'static str> {
    shared();
    INIT_ERROR.get().map(String::as_str)
}

fn lock(bridge: &'static Mutex<DmghgBridge>) -> MutexGuard<'static, DmghgBridge> {
    // 调用方 panic 会污染锁，但 DLL 句柄本身仍然有效，直接取回内部值继续用。
    bridge
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn log_line(message: &str) {
    println!("[anime] {message}");
}

// ---------------------------------------------------------------------------
// 供 anime_provider 调用的 async 门面
//
// DLL 调用是阻塞的，全部丢到 spawn_blocking，别占着 async 执行器。
// ---------------------------------------------------------------------------

async fn run_blocking<T, F>(job: F) -> Result<T, String>
where
    F: FnOnce() -> Result<T, String> + Send + 'static,
    T: Send + 'static,
{
    tokio::task::spawn_blocking(job)
        .await
        .map_err(|error| format!("dmghg 任务执行失败: {error}"))?
}

pub async fn catalog_async(filter: CatalogFilter) -> Result<CatalogPage, String> {
    run_blocking(move || {
        let bridge = shared().ok_or_else(|| "dmghg 桥接未就绪".to_string())?;
        lock(bridge).catalog(&filter)
    })
    .await
}

pub async fn detail_async(series_id: String) -> Result<SeriesDetail, String> {
    run_blocking(move || {
        let bridge = shared().ok_or_else(|| "dmghg 桥接未就绪".to_string())?;
        lock(bridge).detail(&series_id)
    })
    .await
}

pub async fn resolve_play_url_async(
    series_id: String,
    episode_id: String,
    quality: String,
) -> Result<String, String> {
    run_blocking(move || {
        let bridge = shared().ok_or_else(|| "dmghg 桥接未就绪".to_string())?;
        lock(bridge).resolve_play_url(&series_id, &episode_id, &quality)
    })
    .await
}

/// 探测某集的全部清晰度档位（供播放页的画质菜单用）。
pub async fn qualities_async(
    series_id: String,
    episode_id: String,
) -> Result<Vec<VideoQualityOption>, String> {
    run_blocking(move || {
        let bridge = shared().ok_or_else(|| "dmghg 桥接未就绪".to_string())?;
        let variants = lock(bridge).play_variants(&series_id, &episode_id)?;
        Ok(variants_to_options(&variants))
    })
    .await
}

/// 把源给的档位映射成前端认的选项。
///
/// `value` 必须是 `{digits}p` 形式（与既有短剧链路一致，见 usePlaybackStore 的
/// setQuality 守卫：value 不匹配就等于点不动）。
pub fn variants_to_options(variants: &[PlayVariant]) -> Vec<VideoQualityOption> {
    variants
        .iter()
        .map(|variant| {
            let label = if variant.name.is_empty() {
                if variant.height > 0 {
                    format!("{}P", variant.height)
                } else {
                    "自动".to_string()
                }
            } else {
                variant.name.clone()
            };
            let value = if variant.height > 0 {
                format!("{}p", variant.height)
            } else {
                "auto".to_string()
            };
            VideoQualityOption {
                label,
                value,
                resolution: variant.name.clone(),
            }
        })
        .collect()
}

// ---------------------------------------------------------------------------
// 解析辅助
// ---------------------------------------------------------------------------

fn strip_prefix(series_id: &str) -> &str {
    series_id.strip_prefix(ID_PREFIX).unwrap_or(series_id)
}

/// 从源给的档位名解析高度。
///
/// 实测源只给中文名，且 `width`/`height` 字段恒为 0：
/// `"4K 超清"` / `"1080P 高清"` / `"720P"` / `"480P 流畅"`。
/// 认不出时返回 0（调用方回落成 `auto`，不会伪造档位）。
fn parse_variant_height(name: &str) -> u32 {
    let lower = name.to_ascii_lowercase();
    // K 档：4k / 2k / 8k
    for (token, height) in [("8k", 4320u32), ("4k", 2160), ("2k", 1440)] {
        if lower.contains(token) {
            return height;
        }
    }
    // P 档：取紧邻 p 的数字（"1080p 高清" -> 1080）
    let bytes = lower.as_bytes();
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'p' {
            let mut start = index;
            while start > 0 && bytes[start - 1].is_ascii_digit() {
                start -= 1;
            }
            if start < index {
                if let Ok(value) = lower[start..index].parse::<u32>() {
                    if value >= 144 {
                        return value;
                    }
                }
            }
        }
        index += 1;
    }
    0
}

/// 解析前端传的档位字面量（`1080p` / `1080P` / `720`）为高度。
/// `auto` / 空 / 认不出返回 0，表示"由源决定"。
fn parse_quality_value(quality: &str) -> u32 {
    let trimmed = quality.trim().trim_end_matches(['p', 'P']);
    if trimmed.is_empty() || !trimmed.chars().all(|c| c.is_ascii_digit()) {
        return 0;
    }
    trimmed.parse::<u32>().unwrap_or(0)
}

fn truncate(text: &str, limit: usize) -> String {
    if text.chars().count() <= limit {
        return text.to_string();
    }
    text.chars().take(limit).collect::<String>() + "…"
}

/// 列表类响应既可能是 `{items:[...]}`，也可能是裸数组。
fn collect_items(data: &Value) -> Vec<Value> {
    if let Some(array) = data.as_array() {
        return array.clone();
    }
    data.get("items")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
}

fn parse_series_item(item: &Value) -> Option<SeriesItem> {
    let id = item.get("id").and_then(Value::as_i64)?;
    let title = item.get("name").and_then(Value::as_str)?.to_string();
    let cover = item
        .get("pic")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    // continu 形如 "158|周日18:40更"：竖线前是已更新集数。
    let continu = item.get("continu").and_then(Value::as_str).unwrap_or("");
    let episodes_count = continu
        .split('|')
        .next()
        .and_then(|head| head.trim().parse::<u32>().ok())
        .unwrap_or(0);

    let mut tags: Vec<String> = Vec::new();
    if let Some(class) = item.get("type").and_then(Value::as_str) {
        tags.extend(
            class
                .split(',')
                .map(str::trim)
                .filter(|tag| !tag.is_empty())
                .map(str::to_string),
        );
    }
    if let Some(area) = item.get("area").and_then(Value::as_str) {
        if !area.is_empty() {
            tags.push(area.to_string());
        }
    }

    Some(SeriesItem {
        id: format!("{ID_PREFIX}{id}"),
        title,
        cover,
        item_type: "anime".into(),
        episodes_count,
        latest_episode_title: (!continu.is_empty()).then(|| continu.to_string()),
        tags,
        origin: "动漫共和国".into(),
        brief: (!continu.is_empty()).then(|| continu.to_string()),
    })
}

/// parts 结构：`[{oid, part: ["第01集", ...], play: "cn", play_zh: "国语"}]`。
///
/// 集 id 用 `线路|集名` 编码，因为取播放地址时 `play` 和 `part` 都要传。
fn parse_episodes(data: &Value, series_id: &str) -> Result<(Vec<EpisodeItem>, u32), String> {
    let groups = data
        .get("parts")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let multi_line = groups.len() > 1;

    let mut episodes = Vec::new();
    for group in &groups {
        let line = group.get("play").and_then(Value::as_str).unwrap_or("cn");
        let line_label = group.get("play_zh").and_then(Value::as_str).unwrap_or("");
        let names = group
            .get("part")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();

        for (index, name) in names.iter().enumerate() {
            let Some(name) = name.as_str() else { continue };
            let title = if multi_line && !line_label.is_empty() {
                format!("{name}·{line_label}")
            } else {
                name.to_string()
            };
            episodes.push(EpisodeItem {
                id: format!("{line}{EPISODE_SEP}{name}"),
                series_id: series_id.to_string(),
                episode_number: (index + 1) as u32,
                title,
                duration_seconds: 0.0,
                preview_url: None,
            });
        }
    }

    if episodes.is_empty() {
        return Err("dmghg 详情没有可播放的选集。".into());
    }
    let count = episodes.len() as u32;
    Ok((episodes, count))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn episode_id_encodes_line_and_part() {
        let detail = json!({
            "name": "仙逆",
            "pic": "http://example/x.png",
            "content": "简介",
            "type": "玄幻,战斗",
            "area": "大陆",
            "parts": [{ "oid": 2, "part": ["第01集", "第02集"], "play": "cn", "play_zh": "国语" }],
        });
        let (episodes, count) = parse_episodes(&detail, "dmghg:181655").expect("应解析出选集");
        assert_eq!(count, 2);
        assert_eq!(episodes[0].id, "cn|第01集");
        assert_eq!(episodes[0].episode_number, 1);
        // 单线路时不加线路后缀
        assert_eq!(episodes[0].title, "第01集");
    }

    #[test]
    fn multi_line_episodes_get_line_suffix() {
        let detail = json!({
            "parts": [
                { "part": ["第01集"], "play": "cn", "play_zh": "国语" },
                { "part": ["第01集"], "play": "jp", "play_zh": "日语" },
            ],
        });
        let (episodes, _) = parse_episodes(&detail, "dmghg:1").expect("应解析出选集");
        assert_eq!(episodes.len(), 2);
        assert_eq!(episodes[0].title, "第01集·国语");
        assert_eq!(episodes[1].title, "第01集·日语");
        assert_eq!(episodes[1].id, "jp|第01集");
    }

    #[test]
    fn empty_parts_is_an_error() {
        assert!(parse_episodes(&json!({ "parts": [] }), "dmghg:1").is_err());
    }

    #[test]
    fn series_item_uses_continu_head_for_episode_count() {
        let item = json!({
            "id": 181655, "name": "仙逆", "pic": "http://x/y.png",
            "continu": "158|周日18:40更", "type": "玄幻,战斗", "area": "大陆",
        });
        let series = parse_series_item(&item).expect("应解析出剧集");
        assert_eq!(series.id, "dmghg:181655");
        assert_eq!(series.episodes_count, 158);
        assert_eq!(series.tags, vec!["玄幻", "战斗", "大陆"]);
        assert_eq!(
            series.latest_episode_title.as_deref(),
            Some("158|周日18:40更")
        );
    }

    #[test]
    fn series_item_without_continu_reports_zero() {
        let item = json!({ "id": 1, "name": "x" });
        let series = parse_series_item(&item).expect("应解析出剧集");
        assert_eq!(series.episodes_count, 0);
        assert!(series.latest_episode_title.is_none());
    }

    #[test]
    fn collect_items_accepts_both_shapes() {
        assert_eq!(collect_items(&json!([{"id": 1}])).len(), 1);
        assert_eq!(collect_items(&json!({"items": [{"id": 1}]})).len(), 1);
        assert!(collect_items(&json!({"total": 0})).is_empty());
    }

    #[test]
    fn strip_prefix_tolerates_bare_ids() {
        assert_eq!(strip_prefix("dmghg:181655"), "181655");
        assert_eq!(strip_prefix("158973"), "158973");
    }

    /// 真机冒烟测试：完整链路（加载 DLL → 列表 → 详情 → 解析播放地址）。
    ///
    /// 需要本机装有动漫共和国客户端，所以默认跳过。
    /// 跑法：`cargo test -- --ignored --nocapture dmghg_smoke`
    #[test]
    #[ignore = "需要本机安装动漫共和国客户端"]
    fn dmghg_smoke_end_to_end() {
        let bridge = shared().expect("dmghg 桥接应可用（需要本机安装客户端）");
        let guard = lock(bridge);

        let filter = CatalogFilter {
            channel: "anime".into(),
            category: "全部".into(),
            audience: String::new(),
            sort: "hits".into(),
            keyword: None,
            page: 1,
            page_size: 5,
            cursor: None,
        };
        let page = guard.catalog(&filter).expect("列表应成功");
        println!(
            "[冒烟] 列表 total={} items={}",
            page.total,
            page.items.len()
        );
        assert!(!page.items.is_empty(), "列表不应为空");

        let first = &page.items[0];
        assert!(first.id.starts_with(ID_PREFIX), "id 应带 dmghg 前缀");
        println!("[冒烟] 首条 {} ({})", first.title, first.id);

        let detail = guard.detail(&first.id).expect("详情应成功");
        println!(
            "[冒烟] 详情 {} 共 {} 集",
            detail.title, detail.episodes_count
        );
        assert!(!detail.episodes.is_empty(), "选集不应为空");

        let episode = &detail.episodes[0];

        // 档位探测：有的作品 1 档，有的 2 档（实测凡人修仙传给 4K + 1080P）。
        let variants = guard
            .play_variants(&first.id, &episode.id)
            .expect("档位解析应成功");
        println!("[冒烟] 档位 {} 个:", variants.len());
        for variant in &variants {
            println!(
                "[冒烟]   {} (height={}) -> {}",
                variant.name, variant.height, variant.url
            );
        }
        assert!(!variants.is_empty(), "至少应有一档");
        // 高度按降序（最高档在前）
        for pair in variants.windows(2) {
            assert!(pair[0].height >= pair[1].height, "档位应按高度降序");
        }

        // 指定档位能取到对应地址；认不出的档位回落最高档。
        let top = &variants[0];
        let by_quality = guard
            .resolve_play_url(&first.id, &episode.id, &format!("{}p", top.height))
            .expect("按档位取地址应成功");
        assert_eq!(by_quality, top.url, "指定档位应命中同一档");
        let auto = guard
            .resolve_play_url(&first.id, &episode.id, "auto")
            .expect("auto 应成功");
        assert_eq!(auto, top.url, "auto 应回落最高档");
        println!("[冒烟] {} => {auto}", episode.title);
        assert!(auto.starts_with("http"), "播放地址应是 http(s)");

        // 选项映射：value 必须是前端守卫认的 `{digits}p` 形式。
        let options = variants_to_options(&variants);
        for option in &options {
            if option.value != "auto" {
                let digits = option.value.trim_end_matches('p');
                assert!(
                    !digits.is_empty() && digits.chars().all(|c| c.is_ascii_digit()),
                    "档位 value 必须形如 `1080p`，实际 {}",
                    option.value
                );
            }
        }
        println!(
            "[冒烟] 选项: {:?}",
            options.iter().map(|o| &o.value).collect::<Vec<_>>()
        );
    }

    /// 诊断用：打印 dmghg 详情里的**全部图片类字段**，确认封面是不是只有 `pic` 一个来源。
    ///
    /// 起因：个别条目的 `pic` 指向与源站无关的第三方图床（实测
    /// `spore-mall.cdn.bcebos.com/...` 返回 404、`p3-aio.ecombdimg.com/...` 是电商 CDN），
    /// 需要在“源站脏数据”这个前提下确认还有没有别的字段可以兑封面。
    /// 默认忽略（需要本机客户端 + 联网）。
    /// 跑法：`cargo test --bins -- --ignored --nocapture dmghg_dump_raw_detail`
    #[test]
    #[ignore = "诊断用：需要本机安装动漫共和国客户端"]
    fn dmghg_dump_raw_detail() {
        let bridge = shared().expect("dmghg 桥接应可用（需要本机安装客户端）");
        let guard = lock(bridge);
        // 184574 / 194837 是实测封面为第三方脏图床的两条，181412 作为正常样本对照。
        for id in [184574_i64, 194837, 181412] {
            // 源要求 id 是**字符串**：传整数会报 `invalid type: integer ... expected a string`。
            match guard.call("catalog.get_video_detail", json!({ "id": id.to_string() })) {
                Ok(data) => {
                    println!("=== id={id} ===");
                    let Some(object) = data.as_object() else {
                        println!("  非对象响应");
                        continue;
                    };
                    println!("  字段名: {:?}", object.keys().collect::<Vec<_>>());
                    for (key, value) in object {
                        let lower = key.to_ascii_lowercase();
                        if lower.contains("pic")
                            || lower.contains("img")
                            || lower.contains("cover")
                            || lower.contains("image")
                        {
                            println!("  {key} = {value}");
                        }
                    }
                }
                Err(error) => println!("=== id={id} === 失败: {error}"),
            }
        }
    }
    #[test]
    fn variant_height_parses_chinese_labels() {
        // 源实际给的就是这些
        assert_eq!(parse_variant_height("4K 超清"), 2160);
        assert_eq!(parse_variant_height("1080P 高清"), 1080);
        assert_eq!(parse_variant_height("720P"), 720);
        assert_eq!(parse_variant_height("480P 流畅"), 480);
        assert_eq!(parse_variant_height("1080p"), 1080);
        assert_eq!(parse_variant_height("2K"), 1440);
        assert_eq!(parse_variant_height("8K 极清"), 4320);
        // 认不出就是 0，绝不猜
        assert_eq!(parse_variant_height("默认"), 0);
        assert_eq!(parse_variant_height(""), 0);
        assert_eq!(parse_variant_height("高清"), 0);
    }

    #[test]
    fn quality_value_matches_frontend_literal() {
        assert_eq!(parse_quality_value("1080p"), 1080);
        assert_eq!(parse_quality_value("1080P"), 1080);
        assert_eq!(parse_quality_value("720"), 720);
        // auto / 空 / 垃圾值 -> 0（表示由源决定）
        assert_eq!(parse_quality_value("auto"), 0);
        assert_eq!(parse_quality_value(""), 0);
        assert_eq!(parse_quality_value("   "), 0);
        assert_eq!(parse_quality_value("高清"), 0);
    }

    #[test]
    fn variant_options_use_digits_p_values() {
        let variants = vec![
            PlayVariant {
                name: "4K 超清".into(),
                url: "http://a/1".into(),
                height: 2160,
            },
            PlayVariant {
                name: "1080P 高清".into(),
                url: "http://a/2".into(),
                height: 1080,
            },
        ];
        let options = variants_to_options(&variants);
        assert_eq!(options[0].value, "2160p");
        assert_eq!(options[1].value, "1080p");
        // label 保留源的中文名，前端会 split(' ')[0] 取首段
        assert_eq!(options[0].label, "4K 超清");
    }

    #[test]
    fn unparsable_variant_falls_back_to_auto() {
        let variants = vec![PlayVariant {
            name: "默认".into(),
            url: "http://a/1".into(),
            height: 0,
        }];
        let options = variants_to_options(&variants);
        assert_eq!(options[0].value, "auto");
        assert_eq!(options[0].label, "默认");
    }
}
