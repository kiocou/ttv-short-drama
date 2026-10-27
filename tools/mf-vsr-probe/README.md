# mf-vsr-probe —— RTX VSR 呈现链验证器

判定「原生 Media Foundation + D3D11 视频处理器」这条呈现链**能否触发 NVIDIA RTX VSR**。

## 结论（2026-10-27 实机实测）

**不能。** 三条自绘/换内核路线全部被实测否掉，只有 Chromium 的 `<video>` 能触发。

| 呈现路径 | VSR 角标 | 实测条件 |
| --- | --- | --- |
| Chromium `<video>`（Edge / WebView2） | ✅ **出现** | 同机同时、同一片段、同一窗口尺寸 |
| mpv `--vo=gpu-next --gpu-api=d3d11 --hwdec=d3d11va` | ❌ 无 | 窗口在前台、时间码在走 |
| **本探针**：MF SourceReader → NV12 纹理 → `VideoProcessorBlt` → SwapChain（720p 降采样） | ❌ 无 | 连续呈现 720 帧无错误 |
| **本探针**：同上，1440p 超分场景（输出 > 输入） | ❌ 无 | 排除"VSR 只在放大时介入"这一可能 |
| **本探针**：进程改名 `vlc.exe` | ❌ 无 | 排除"纯 exe 名白名单"这一可能 |

含义：VSR 的介入点**不是**「任何 `ID3D11VideoProcessor::VideoProcessorBlt`」。它是驱动对**特定呈现模式**（Chromium 的 video overlay / MF 的 EVR 一类）的识别，没有可复制的公开 API。所以"自研内核 + 保留 VSR"这个组合不成立。

## 这个探针仍然有用

它证明了**自研内核在工程上可行**：MF SourceReader 解码（H.264/HEVC）→ NV12 纹理 → D3D11 视频处理器（缩放/色彩转换）→ SwapChain 呈现，720 帧稳定无错。哪天要做「不依赖 WebView2 的播放内核」（例如要 10bit / HDR / 硬解控制力），这里是可用的起点。

## 用法

```bash
cargo build
./target/debug/mf-vsr-probe.exe <file.mp4> [--pix nv12|bgra] [--size 1280x720]
```

- `--pix nv12`：视频处理器原生输入格式（默认，最接近真实播放器）
- `--pix bgra`：BGRA 输入（上传简单，但不是视频原生格式）
- 窗口创建后自动置顶（验证时需要盖在其它窗口之上才能看到驱动角标）

## 踩过的坑（都写在代码注释里）

1. `MF_SOURCE_READER_ENABLE_VIDEO_PROCESSING` 与 `..._ADVANCED_VIDEO_PROCESSING` **互斥**，同时设会 `E_INVALIDARG`。
2. `CreateVideoProcessorInputView` 要求输入纹理的 `BindFlags` 包含 **`D3D11_BIND_DECODER`（NV12 必需）+ `SHADER_RESOURCE`**；只给 `SHADER_RESOURCE` 会 `E_INVALIDARG`（这个坑卡了一轮）。
3. 视频处理器的输入是 **`ID3D11VideoProcessorInputView`**，不是纹理；纹理不变时 view 建一次即可复用。
4. 背景色是 `D3D11_VIDEO_COLOR`（不是 `DXGI_RGBA`），`ycbcr` 参数是 `BOOL`。
5. 输出分辨率必须 **≥ 输入**，否则是降采样，超分逻辑根本不会介入（第一轮实验就栽在这里）。
