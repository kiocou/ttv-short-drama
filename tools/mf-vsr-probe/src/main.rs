//! 最小验证内核：Media Foundation 解码 → D3D11 纹理 → **VideoProcessorBlt** → SwapChain 呈现。
//!
//! 存在的唯一理由：判定「原生 MF + D3D11 视频处理器」这条呈现链能否触发 RTX VSR。
//! 已实测的对照：Chromium `<video>`（H.264）会触发；mpv 的 `gpu-next` shader 上屏不会。
//! 所以本程序把帧**真的送进 D3D11 Video Processor**（`VideoProcessorBlt`）——
//! 这是唯一还没被否掉的路径。
//!
//! 用法：
//! ```text
//! mf-vsr-probe <file.mp4> [--pix bgra|nv12] [--size 1280x720]
//! ```
//! 判定：播放时看右上角是否出现 NVIDIA 的 "RTX VSR" 角标（同一台机器、同一片段、
//! 同一窗口尺寸，与 Edge 对照）。
//!
//! 刻意不做的（与验证目标无关，会把最小内核撑成播放器）：
//! 音频、seek、倍速、字幕、音画同步、PTS 精确调度。

use std::ffi::c_void;
use std::time::{Duration, Instant};

use windows::core::{Interface, PCWSTR, Result};
use windows::Win32::Foundation::{BOOL, HMODULE, HWND, LPARAM, LRESULT, WPARAM};
use windows::Win32::Graphics::Direct3D::D3D_DRIVER_TYPE_HARDWARE;
use windows::Win32::Graphics::Direct3D11::*;
use windows::Win32::Graphics::Dxgi::Common::{
    DXGI_ALPHA_MODE_IGNORE, DXGI_FORMAT_B8G8R8A8_UNORM, DXGI_FORMAT_NV12, DXGI_RATIONAL,
    DXGI_SAMPLE_DESC,
};
use windows::Win32::Graphics::Dxgi::*;
use windows::Win32::Media::MediaFoundation::*;
use windows::Win32::System::Com::{CoInitializeEx, COINIT_APARTMENTTHREADED};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::UI::WindowsAndMessaging::*;

#[derive(Clone, Copy, PartialEq, Debug)]
enum PixFmt {
    /// BGRA：上传最简单，但驱动看到的可能只是"普通纹理"，VSR 未必介入。
    Bgra,
    /// NV12：视频处理器原生输入格式，最接近真实播放器的呈现链。
    Nv12,
}

fn main() -> Result<()> {
    let mut args = std::env::args().skip(1);
    let path = match args.next() {
        Some(p) => p,
        None => {
            eprintln!("用法: mf-vsr-probe <file.mp4> [--pix bgra|nv12] [--size 1280x720]");
            std::process::exit(2);
        }
    };
    let mut pix = PixFmt::Nv12;
    let mut win_w = 1280u32;
    let mut win_h = 720u32;
    let rest: Vec<String> = args.collect();
    let mut i = 0;
    while i < rest.len() {
        match rest[i].as_str() {
            "--pix" => {
                if let Some(v) = rest.get(i + 1) {
                    pix = if v.eq_ignore_ascii_case("bgra") { PixFmt::Bgra } else { PixFmt::Nv12 };
                }
                i += 2;
            }
            "--size" => {
                if let Some(v) = rest.get(i + 1) {
                    if let Some((w, h)) = v.split_once('x') {
                        win_w = w.parse().unwrap_or(win_w);
                        win_h = h.parse().unwrap_or(win_h);
                    }
                }
                i += 2;
            }
            _ => i += 1,
        }
    }

    unsafe {
        CoInitializeEx(None, COINIT_APARTMENTTHREADED).ok()?;
        MFStartup(MF_VERSION, MFSTARTUP_FULL)?;

        let reader = open_reader(&path, pix)?;
        // 拿到了 reader 之后，真正的像素格式可能被内部回退过，这里以实际类型为准。
        let actual_pix = {
            let mt = reader.GetCurrentMediaType(MF_SOURCE_READER_FIRST_VIDEO_STREAM.0 as u32)?;
            let sub = mt.GetGUID(&MF_MT_SUBTYPE)?;
            if sub == MFVideoFormat_NV12 { PixFmt::Nv12 } else { PixFmt::Bgra }
        };
        let pix = actual_pix;
        let (video_w, video_h, fps) = video_geometry(&reader)?;
        eprintln!(
            "[probe] 源 {}x{} @ {:.2}fps，像素格式 = {:?}，窗口 {}x{}",
            video_w, video_h, fps, pix, win_w, win_h
        );

        let (device, context) = create_device()?;
        eprintln!("[probe] step: d3d11 device ok");
        let hwnd = create_window(win_w, win_h)?;
        eprintln!("[probe] step: window ok");
        let swap = create_swapchain(&device, hwnd, win_w, win_h)?;
        eprintln!("[probe] step: swapchain ok");

        let video_device: ID3D11VideoDevice = device.cast()?;
        let video_context: ID3D11VideoContext = context.cast()?;
        eprintln!("[probe] step: video device ok");

        let content_desc = D3D11_VIDEO_PROCESSOR_CONTENT_DESC {
            InputFrameFormat: D3D11_VIDEO_FRAME_FORMAT_PROGRESSIVE,
            InputFrameRate: DXGI_RATIONAL { Numerator: 60, Denominator: 1 },
            InputWidth: video_w,
            InputHeight: video_h,
            OutputFrameRate: DXGI_RATIONAL { Numerator: 60, Denominator: 1 },
            OutputWidth: win_w,
            OutputHeight: win_h,
            Usage: D3D11_VIDEO_USAGE_PLAYBACK_NORMAL,
        };
        let enumerator: ID3D11VideoProcessorEnumerator =
            video_device.CreateVideoProcessorEnumerator(&content_desc)?;
        eprintln!("[probe] step: vp enumerator ok");
        let processor: ID3D11VideoProcessor = video_device.CreateVideoProcessor(&enumerator, 0)?;
        eprintln!("[probe] step: vp ok");

        // 诊断：这台机器的视频处理器到底认哪些输入格式（决定 NV12 路线是否可行）。
        for (name, fmt) in [
            ("NV12", DXGI_FORMAT_NV12),
            ("BGRA", DXGI_FORMAT_B8G8R8A8_UNORM),
            ("YUY2", windows::Win32::Graphics::Dxgi::Common::DXGI_FORMAT_YUY2),
            ("P010", windows::Win32::Graphics::Dxgi::Common::DXGI_FORMAT_P010),
        ] {
            match enumerator.CheckVideoProcessorFormat(fmt) {
                Ok(support) => eprintln!("[probe] vp 输入格式 {name}: flags=0x{support:x}"),
                Err(e) => eprintln!("[probe] vp 输入格式 {name}: 不可用 ({e:?})"),
            }
        }

        let in_tex = create_input_texture(&device, pix, video_w, video_h)?;
        eprintln!("[probe] step: input texture ok");
        // 视频处理器的输入是 **InputView**（不是纹理）：纹理不变，view 建一次就够。
        let input_view: ID3D11VideoProcessorInputView = get_checked(|p| {
            video_device.CreateVideoProcessorInputView(
                &in_tex,
                &enumerator,
                &D3D11_VIDEO_PROCESSOR_INPUT_VIEW_DESC {
                    FourCC: 0,
                    ViewDimension: D3D11_VPIV_DIMENSION_TEXTURE2D,
                    Anonymous: D3D11_VIDEO_PROCESSOR_INPUT_VIEW_DESC_0 {
                        Texture2D: D3D11_TEX2D_VPIV { MipSlice: 0, ArraySlice: 0 },
                    },
                },
                Some(p),
            )
        })?;
        eprintln!("[probe] step: input view ok");

        video_context.VideoProcessorSetStreamFrameFormat(
            &processor,
            0,
            D3D11_VIDEO_FRAME_FORMAT_PROGRESSIVE,
        );
        eprintln!("[probe] step: frame format ok");
        let black = D3D11_VIDEO_COLOR {
            Anonymous: D3D11_VIDEO_COLOR_0 {
                RGBA: D3D11_VIDEO_COLOR_RGBA { R: 0.0, G: 0.0, B: 0.0, A: 1.0 },
            },
        };
        video_context.VideoProcessorSetOutputBackgroundColor(&processor, BOOL(0), &black);
        eprintln!("[probe] step: bg color ok");

        let mut last = Instant::now();
        let frame_interval = if fps > 1.0 {
            Duration::from_secs_f64(1.0 / fps)
        } else {
            Duration::from_millis(33)
        };
        let mut frames: u64 = 0;

        loop {
            let mut msg = MSG::default();
            while PeekMessageW(&mut msg, None, 0, 0, PM_REMOVE).as_bool() {
                if msg.message == WM_QUIT {
                    let _ = MFShutdown();
                    return Ok(());
                }
                let _ = TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }

            let Some(sample) = read_sample(&reader)? else {
                // 播完：本内核不做 seek，直接退出（观察角标够用）。
                eprintln!("[probe] 播放结束，共呈现 {frames} 帧");
                let _ = DestroyWindow(hwnd);
                let _ = MFShutdown();
                return Ok(());
            };

            upload_sample(&sample, &context, &in_tex, pix, video_w, video_h)?;

            let backbuffer: ID3D11Texture2D = swap.GetBuffer::<ID3D11Texture2D>(0)?;
            let output_view: ID3D11VideoProcessorOutputView = get_checked(|p| {
                video_device.CreateVideoProcessorOutputView(
                    &backbuffer,
                    &enumerator,
                    &D3D11_VIDEO_PROCESSOR_OUTPUT_VIEW_DESC {
                        ViewDimension: D3D11_VPOV_DIMENSION_TEXTURE2D,
                        Anonymous: D3D11_VIDEO_PROCESSOR_OUTPUT_VIEW_DESC_0 {
                            Texture2D: D3D11_TEX2D_VPOV { MipSlice: 0 },
                        },
                    },
                    Some(p),
                )
            })?;

            let stream = D3D11_VIDEO_PROCESSOR_STREAM {
                Enable: BOOL(1),
                OutputIndex: 0,
                InputFrameOrField: 0,
                PastFrames: 0,
                FutureFrames: 0,
                ppPastSurfaces: std::ptr::null_mut(),
                pInputSurface: std::mem::ManuallyDrop::new(Some(input_view.clone())),
                ppFutureSurfaces: std::ptr::null_mut(),
                ppPastSurfacesRight: std::ptr::null_mut(),
                pInputSurfaceRight: std::mem::ManuallyDrop::new(None),
                ppFutureSurfacesRight: std::ptr::null_mut(),
            };

            video_context.VideoProcessorBlt(&processor, &output_view, 0, &[stream])?;
            swap.Present(1, DXGI_PRESENT(0)).ok()?;
            frames += 1;
            if frames % 120 == 0 {
                eprintln!("[probe] 已呈现 {frames} 帧");
            }

            let elapsed = last.elapsed();
            if elapsed < frame_interval {
                std::thread::sleep(frame_interval - elapsed);
            }
            last = Instant::now();
        }
    }
}

unsafe fn open_reader(path: &str, pix: PixFmt) -> Result<IMFSourceReader> {
    let mut attrs: Option<IMFAttributes> = None;
    MFCreateAttributes(&mut attrs, 1)?;
    let attrs = attrs.unwrap();
    // 只开基础 VIDEO_PROCESSING：它让 SourceReader 在本进程内做色彩转换。
    // `ENABLE_ADVANCED_VIDEO_PROCESSING` 与它互斥（同时设会 E_INVALIDARG），
    // 而且 advanced 需要自己挂 DXVA 管理器，超出最小验证的范围。
    attrs.SetUINT32(&MF_SOURCE_READER_ENABLE_VIDEO_PROCESSING, 1)?;

    let wide: Vec<u16> = path.encode_utf16().chain(std::iter::once(0)).collect();
    let reader = MFCreateSourceReaderFromURL(PCWSTR(wide.as_ptr()), &attrs)?;
    match set_output_type(&reader, pix) {
        Ok(()) => Ok(reader),
        Err(err) => {
            // 源/解码器不接受请求的像素格式时，退到 BGRA 至少能验证「能不能出画面」；
            // 但 NV12 才是这条链路的关键，失败必须显式说出来。
            eprintln!("[probe] 设定输出格式 {pix:?} 失败：{err:?}，回退 BGRA");
            set_output_type(&reader, PixFmt::Bgra)?;
            Ok(reader)
        }
    }
}

unsafe fn set_output_type(reader: &IMFSourceReader, pix: PixFmt) -> Result<()> {
    let media_type: IMFMediaType = MFCreateMediaType()?;
    media_type.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Video)?;
    let sub = match pix {
        PixFmt::Nv12 => MFVideoFormat_NV12,
        PixFmt::Bgra => MFVideoFormat_RGB32,
    };
    media_type.SetGUID(&MF_MT_SUBTYPE, &sub)?;
    reader.SetCurrentMediaType(MF_SOURCE_READER_FIRST_VIDEO_STREAM.0 as u32, None, &media_type)
}

unsafe fn video_geometry(reader: &IMFSourceReader) -> Result<(u32, u32, f64)> {
    let mt = reader.GetCurrentMediaType(MF_SOURCE_READER_FIRST_VIDEO_STREAM.0 as u32)?;
    let size = mt.GetUINT64(&MF_MT_FRAME_SIZE)?;
    let w = (size >> 32) as u32;
    let h = (size & 0xffff_ffff) as u32;
    let fps = match mt.GetUINT64(&MF_MT_FRAME_RATE) {
        Ok(v) => {
            let num = (v >> 32) as f64;
            let den = (v & 0xffff_ffff) as f64;
            if den > 0.0 { num / den } else { 30.0 }
        }
        Err(_) => 30.0,
    };
    Ok((w.max(2), h.max(2), fps))
}

unsafe fn create_device() -> Result<(ID3D11Device, ID3D11DeviceContext)> {
    let flags = D3D11_CREATE_DEVICE_BGRA_SUPPORT | D3D11_CREATE_DEVICE_VIDEO_SUPPORT;
    let mut device: Option<ID3D11Device> = None;
    let mut context: Option<ID3D11DeviceContext> = None;
    D3D11CreateDevice(
        None::<&IDXGIAdapter>,
        D3D_DRIVER_TYPE_HARDWARE,
        HMODULE::default(),
        flags,
        None,
        D3D11_SDK_VERSION,
        Some(&mut device),
        None,
        Some(&mut context),
    )?;
    Ok((device.unwrap(), context.unwrap()))
}

unsafe fn create_window(w: u32, h: u32) -> Result<HWND> {
    let class_name: Vec<u16> = "MFVSRPROBE\0".encode_utf16().collect();
    let title: Vec<u16> = "MF + D3D11 VideoProcessor probe\0".encode_utf16().collect();
    let hinstance = GetModuleHandleW(None)?;
    let wc = WNDCLASSW {
        lpfnWndProc: Some(wndproc),
        hInstance: hinstance.into(),
        lpszClassName: PCWSTR(class_name.as_ptr()),
        ..Default::default()
    };
    if RegisterClassW(&wc) == 0 {
        eprintln!("[probe] RegisterClassW 返回 0（可能已注册过）");
    }
    let hwnd = CreateWindowExW(
        WINDOW_EX_STYLE(0),
        PCWSTR(class_name.as_ptr()),
        PCWSTR(title.as_ptr()),
        WS_OVERLAPPEDWINDOW | WS_VISIBLE,
        80,
        80,
        w as i32,
        h as i32,
        None,
        None,
        hinstance,
        None,
    )?;
    let _ = ShowWindow(hwnd, SW_SHOW);
    // 置顶：验证期间必须让它盖在任何其它窗口之上（否则角标会被别的窗口挡住，
    // 判定就没法做了）。外部脚本设 TOPMOST 有竞态，索性在创建时就定死。
    let _ = SetWindowPos(
        hwnd,
        HWND_TOPMOST,
        120,
        80,
        w as i32 + 16,
        h as i32 + 39,
        SWP_SHOWWINDOW,
    );
    let _ = SetForegroundWindow(hwnd);
    Ok(hwnd)
}

unsafe extern "system" fn wndproc(hwnd: HWND, msg: u32, w: WPARAM, l: LPARAM) -> LRESULT {
    match msg {
        WM_DESTROY => {
            PostQuitMessage(0);
            LRESULT(0)
        }
        _ => DefWindowProcW(hwnd, msg, w, l),
    }
}

unsafe fn create_swapchain(
    device: &ID3D11Device,
    hwnd: HWND,
    w: u32,
    h: u32,
) -> Result<IDXGISwapChain1> {
    let dxgi_device: IDXGIDevice = device.cast()?;
    let adapter = dxgi_device.GetAdapter()?;
    let factory: IDXGIFactory2 = adapter.GetParent()?;
    let desc = DXGI_SWAP_CHAIN_DESC1 {
        Width: w,
        Height: h,
        Format: DXGI_FORMAT_B8G8R8A8_UNORM,
        Stereo: BOOL(0),
        SampleDesc: DXGI_SAMPLE_DESC { Count: 1, Quality: 0 },
        BufferUsage: DXGI_USAGE_RENDER_TARGET_OUTPUT,
        BufferCount: 2,
        Scaling: DXGI_SCALING_STRETCH,
        SwapEffect: DXGI_SWAP_EFFECT_FLIP_DISCARD,
        AlphaMode: DXGI_ALPHA_MODE_IGNORE,
        Flags: 0,
    };
    factory.CreateSwapChainForHwnd(device, hwnd, &desc, None, None)
}

unsafe fn create_input_texture(
    device: &ID3D11Device,
    pix: PixFmt,
    w: u32,
    h: u32,
) -> Result<ID3D11Texture2D> {
    let desc = D3D11_TEXTURE2D_DESC {
        Width: w,
        Height: h,
        MipLevels: 1,
        ArraySize: 1,
        Format: match pix {
            PixFmt::Nv12 => DXGI_FORMAT_NV12,
            PixFmt::Bgra => DXGI_FORMAT_B8G8R8A8_UNORM,
        },
        SampleDesc: DXGI_SAMPLE_DESC { Count: 1, Quality: 0 },
        Usage: D3D11_USAGE_DEFAULT,
        // 视频处理器的输入纹理必须带 SHADER_RESOURCE；NV12 还是解码器的原生输出格式，
        // 一并带上 DECODER（实测某些驱动只认这一种组合）。
        BindFlags: match pix {
            PixFmt::Nv12 => (D3D11_BIND_DECODER.0 | D3D11_BIND_SHADER_RESOURCE.0) as u32,
            PixFmt::Bgra => D3D11_BIND_SHADER_RESOURCE.0 as u32,
        },
        CPUAccessFlags: 0,
        MiscFlags: 0,
    };
    let mut tex: Option<ID3D11Texture2D> = None;
    device.CreateTexture2D(&desc, None, Some(&mut tex))?;
    Ok(tex.unwrap())
}

/// 把 SourceReader 给出的帧拷进 D3D11 纹理。
unsafe fn upload_sample(
    sample: &IMFSample,
    context: &ID3D11DeviceContext,
    texture: &ID3D11Texture2D,
    pix: PixFmt,
    w: u32,
    h: u32,
) -> Result<()> {
    let buffer: IMFMediaBuffer = sample.ConvertToContiguousBuffer()?;
    let mut ptr: *mut u8 = std::ptr::null_mut();
    let mut max_len: u32 = 0;
    let mut cur_len: u32 = 0;
    buffer.Lock(&mut ptr, Some(&mut max_len), Some(&mut cur_len))?;
    let result = (|| -> Result<()> {
        match pix {
            PixFmt::Bgra => {
                context.UpdateSubresource(texture, 0, None, ptr as *const c_void, w * 4, 0);
            }
            PixFmt::Nv12 => {
                // NV12：Y 平面（w*h）+ UV 平面（w*h/2）。D3D11 的 NV12 只有一个
                // subresource，`SrcDepthPitch` 就是 Y 平面大小 —— 用它把两段一次拷进去。
                context.UpdateSubresource(texture, 0, None, ptr as *const c_void, w, w * h);
            }
        }
        Ok(())
    })();
    let _ = buffer.Unlock();
    result
}

unsafe fn read_sample(reader: &IMFSourceReader) -> Result<Option<IMFSample>> {
    let mut actual_stream: u32 = 0;
    let mut flags: u32 = 0;
    let mut ts: i64 = 0;
    let mut sample: Option<IMFSample> = None;
    reader.ReadSample(
        MF_SOURCE_READER_FIRST_VIDEO_STREAM.0 as u32,
        0,
        Some(&mut actual_stream),
        Some(&mut flags),
        Some(&mut ts),
        Some(&mut sample),
    )?;
    if flags & (MF_SOURCE_READERF_ENDOFSTREAM.0 as u32) != 0 {
        return Ok(None);
    }
    Ok(sample)
}

/// 把 `windows` 的 "Option 出参" 风格收敛成一个辅助函数。
unsafe fn get_checked<T, F>(f: F) -> Result<T>
where
    F: FnOnce(*mut Option<T>) -> Result<()>,
{
    let mut out: Option<T> = None;
    f(&mut out)?;
    out.ok_or_else(|| windows::core::Error::from(windows::Win32::Foundation::E_FAIL))
}
