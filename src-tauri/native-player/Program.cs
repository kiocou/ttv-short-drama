// Program.cs —— TTV 原生播放器主体（mpv 内核 + LSFG 补帧 + WebView2 控制条）。
//
// 窗口结构（用户要求"只保留一个窗口"）：
//   ┌──────────────────────┐
//   │  D3D11 swapchain      │ ← mpv render → LsfgChain 补帧 → Present（视频区）
//   ├──────────────────────┤
//   │  WebView2 控制条      │ ← 加载 TTV 前端的控制条路由，样式与原播放页一模一样
//   └──────────────────────┘
//   全部在同一顶层窗口内；补帧在 swapchain 管线里完成，不叠加第二个 HWND。
//
// 时间轴（补帧核心）：
//   * 源帧率 fps 从 mpv 属性拿（container-fps 实测短剧 15/24/30 都有，不能写死）；
//   * mpv 的 time-pos 是音频时钟驱动的连续位置（暂停冻结、倍速加速）；
//   * t = frac(time-pos × fps) 正是"当前两源帧之间的插值位置"——
//     暂停/倍速/seek 全部自动正确，不需要自己维护视频时钟。
//   * 源帧滚动：mpv wakeup → RenderUpdate() 报新帧 → Render 到 FBO →
//     CopyResource 滚动 frameA/frameB（GPU 零拷贝；Dynamic 纹理不支持 CopyResource，
//     所以自建 DEFAULT 用法的 Img，绕开 LsfgChain.CreateDynamic）。
using System.Diagnostics;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Text.Json;
using LsfgPipeline;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;
using Vortice.Direct3D;
using Vortice.Direct3D11;
using Vortice.DXGI;
using static Vortice.Direct3D11.D3D11;

namespace NativePlayer;

internal static class Program
{
    [STAThread]
    static void Main(string[] args)
    {
        ApplicationConfiguration.Initialize();
        // 全局兜底：任何未捕获异常都落日志。之前 seat 会话里出现过"静默退出"——
        // 没有这层就只能靠猜（进程消失、日志停在最后一帧）。
        AppDomain.CurrentDomain.UnhandledException += (_, e) =>
            Log("FATAL unhandled: " + (e.ExceptionObject as Exception)?.ToString());
        Application.ThreadException += (_, e) => Log("FATAL thread: " + e.Exception);
        Application.SetUnhandledExceptionMode(UnhandledExceptionMode.CatchException);

        string? pipe = null, mpvPath = null, shaders = null, hlsl = null, loadJson = null;
        int fg = 1, fgMult = 2;
        for (int i = 0; i < args.Length; i++)
        {
            switch (args[i])
            {
                case "--pipe": pipe = args[++i]; break;
                case "--mpv": mpvPath = args[++i]; break;
                case "--shaders": shaders = args[++i]; break;
                case "--hlsl": hlsl = args[++i]; break;
                case "--load": loadJson = args[++i]; break;
                case "--load-file":
                    // 从文件读 JSON：命令行传 JSON 会被外壳（PowerShell/批处理）
                    // 吞掉双引号，且 URL 带签名后很容易超长 —— 文件是唯一稳的通道。
                    try { loadJson = File.ReadAllText(args[++i]); }
                    catch (Exception ex) { Log("read --load-file: " + ex.Message); }
                    break;
                case "--fg": int.TryParse(args[++i], out fg); break;
                case "--fgmult": int.TryParse(args[++i], out fgMult); break;
            }
        }
        if (pipe == null)
        {
            MessageBox.Show("缺少 --pipe 参数（本播放器由 TTV 主程序启动）。", "TTV NativePlayer");
            return;
        }
        // libmpv 必须是 DLL 构建（mpv.exe 的导出是 EXE 副产物，调用即崩）。
        // 默认取 exe 同目录的 libmpv-2.dll。
        mpvPath ??= Path.Combine(AppContext.BaseDirectory, "libmpv-2.dll");
        string exeDir = AppContext.BaseDirectory;
        shaders ??= Path.Combine(exeDir, "shaders");
        hlsl ??= Path.Combine(exeDir, "LsfgPipeline");
        LoadRequest? initial = null;
        if (loadJson != null)
        {
            try { initial = JsonSerializer.Deserialize<LoadRequest>(loadJson); }
            catch (Exception ex) { Log("bad --load: " + ex.Message); }
        }
        Application.Run(new PlayerForm(pipe, Path.GetFullPath(mpvPath), shaders, hlsl,
            initial, fg > 0, Math.Clamp(fgMult, 2, 5)));
    }

    public static void Log(string s)
    {
        try
        {
            File.AppendAllText(Path.Combine(AppContext.BaseDirectory, "nativeplayer.log"),
                DateTime.Now.ToString("HH:mm:ss.fff") + " " + s + Environment.NewLine);
        }
        catch { }
    }
}

public sealed class LoadRequest
{
    public string url { get; set; } = "";
    public string? key { get; set; }
    public double start { get; set; }
    public string title { get; set; } = "";
    public int ep { get; set; }
    public double total { get; set; }
    public int vw { get; set; } = 540;
    public int vh { get; set; } = 960;
    public double volume { get; set; } = 100;
}

internal sealed class PlayerForm : Form
{
    const int BarH = 64;                 // 控制条高度（与前端 HUD 贴底一致）
    const int DefaultVW = 540, DefaultVH = 960;

    readonly IpcPipe ipc;
    readonly string mpvExe, shaderDir, hlslDir;
    Mpv mpv = null!;
    ControlsServer http = null!;
    WebView2? webView;

    ID3D11Device device = null!;
    ID3D11DeviceContext ctx = null!;
    IDXGISwapChain1 swap = null!;
    ID3D11RenderTargetView backRtv = null!;
    ID3D11Texture2D backBuffer = null!;
    ID3D11Texture2D fboA = null!;
    ID3D11Texture2D fboB = null!;
    bool fboPing = true;

    LsfgChain chain = null!;
    Img frameA = null!, frameB = null!;
    int vw = DefaultVW, vh = DefaultVH;
    Rectangle windowedBounds;

    volatile bool running = true;
    volatile bool fgEnabled;
    volatile int fgMult = 2;
    double totalSeconds = 1;
    double srcFps = 15;
    bool hasFramePair;
    readonly ManualResetEventSlim wake = new(false);
    Thread? renderThread;
    readonly Stopwatch swStat = Stopwatch.StartNew();
    long statFrames, statSrc;
    long nextPresentationTick;
    readonly object resizeGate = new();
    Size pendingSwapchainSize;
    bool swapchainResizePending;
    bool fullscreen;
    volatile bool sizeSynced;
    volatile bool ended;
    double lastPos = 0;
    readonly System.Windows.Forms.Timer uiTimer = new() { Interval = 200 };

    Panel viewport = null!;
    Panel barHost = null!;
    PlayerBar playerBar = null!;

    public PlayerForm(string pipeName, string mpvExePath, string shaders, string hlsl,
        LoadRequest? initial, bool startFg, int startMult)
    {
        ipc = new IpcPipe(pipeName);
        mpvExe = mpvExePath; shaderDir = shaders; hlslDir = hlsl;
        fgEnabled = startFg; fgMult = startMult;

        Text = "TTV 播放器";
        StartPosition = FormStartPosition.CenterScreen;
        BackColor = Color.FromArgb(12, 12, 16);
        KeyPreview = true;
        MinimumSize = new Size(360, 260);

        barHost = new Panel { Dock = DockStyle.Bottom, Height = BarH, BackColor = Color.FromArgb(22, 22, 28) };
        playerBar = new PlayerBar { Dock = DockStyle.Fill };
        barHost.Controls.Add(playerBar);
        playerBar.OnTogglePlay += CmdPause;
        playerBar.OnSeek += (sec) => { CmdSeek(sec); if (mpv != null && mpv.GetPropertyFlag("pause")) CmdPause(); };
        playerBar.OnVolume += (v) => CmdVolume((int)Math.Round(v * 100));
        playerBar.OnSpeed += (r) => CmdSpeed(r);
        playerBar.OnFg += (on, mult) => SetFg(on, mult);
        playerBar.OnPrev += () => ipc.SendEvent(new { @event = "prev", pos = Math.Round(lastPos, 2) });
        playerBar.OnNext += () => ipc.SendEvent(new { @event = "next", pos = Math.Round(lastPos, 2) });
        playerBar.OnClose += Close;
        playerBar.OnFullscreen += ToggleFullscreen;
        viewport = new Panel { Dock = DockStyle.Fill, BackColor = Color.Black };
        // Dock 布局按 z-order 逆序处理：先加 Fill 的 viewport，再加 Bottom 的 barHost，
        // 这样 viewport 只占「客户区 - 控制条」，视频不会被控制条压住最后 64px。
        Controls.Add(viewport);
        Controls.Add(barHost);
        ClientSize = new Size(DefaultVW, DefaultVH + BarH);

        KeyDown += OnKey;
        viewport.DoubleClick += (_, _) => ToggleFullscreen();
        FormClosing += (_, _) => Shutdown();
        uiTimer.Tick += (_, _) =>
        {
            http.Poll();
            if (mpv == null || playerBar == null) return;
            playerBar.SetPosition(lastPos, Math.Max(totalSeconds, GetDuration()));
            playerBar.SetPlaying(!GetPaused());
        };

        ipc.OnCommand += OnIpcCommand;
        ipc.StartListen();

        Load += async (_, _) =>
        {
            try
            {
                InitD3D();
                InitMpv();
                InitChain();
                http = new ControlsServer(this, Path.Combine(AppContext.BaseDirectory, "controls"));
                http.Start();
                await InitWebView();
                uiTimer.Start();
                renderThread = new Thread(RenderLoop) { IsBackground = true, Name = "render", Priority = ThreadPriority.Highest };
                renderThread.Start();
                if (initial != null) ApplyLoad(initial);
            }
            catch (Exception ex)
            {
                Program.Log("INIT FAIL: " + ex);
                ipc.SendEvent(new { @event = "error", msg = ex.Message });
                // 无人值守场景：MessageBox 会永远挂住进程，锁死输出 DLL，
                // 后续构建全部静默失败（实测踩过整晚）。失败只写日志 + 退出。
                running = false;
                Close();
            }
        };
    }

    // ───────────────────────── 初始化 ─────────────────────────

    void InitD3D()
    {
        var levels = new[] { FeatureLevel.Level_11_1, FeatureLevel.Level_11_0 };
        D3D11CreateDevice(null, DriverType.Hardware, DeviceCreationFlags.BgraSupport, levels,
            out device, out ctx).CheckError();
        using (var dxgiDevice = device.QueryInterface<IDXGIDevice>())
        using (var adapter = dxgiDevice.GetAdapter())
        {
            var desc = adapter.Description;
            Program.Log($"D3D adapter={desc.Description.Trim()} vendor=0x{desc.VendorId:X4} device=0x{desc.DeviceId:X4}");
        }
        using var fac = DXGI.CreateDXGIFactory1<IDXGIFactory2>();
        swap = fac.CreateSwapChainForHwnd(device, viewport.Handle, new SwapChainDescription1
        {
            Width = (uint)viewport.ClientSize.Width, Height = (uint)viewport.ClientSize.Height,
            Format = Format.B8G8R8A8_UNorm, SampleDescription = new SampleDescription(1, 0),
            BufferUsage = Usage.RenderTargetOutput, BufferCount = 2,
            Scaling = Scaling.Stretch, SwapEffect = SwapEffect.FlipDiscard,
            AlphaMode = Vortice.DXGI.AlphaMode.Unspecified, Flags = SwapChainFlags.None,
        });
        BindBackBuffer();
        viewport.SizeChanged += (_, _) => QueueSwapchainResize();
    }

    void BindBackBuffer()
    {
        backRtv?.Dispose(); backBuffer?.Dispose();
        backBuffer = swap.GetBuffer<ID3D11Texture2D>(0);
        backRtv = device.CreateRenderTargetView(backBuffer);
    }

    void QueueSwapchainResize()
    {
        if (IsDisposed) return;
        var size = viewport.ClientSize;
        if (size.Width < 8 || size.Height < 8) return;
        lock (resizeGate)
        {
            pendingSwapchainSize = size;
            swapchainResizePending = true;
        }
        wake.Set();
    }

    void ApplyPendingSwapchainResize()
    {
        Size size;
        lock (resizeGate)
        {
            if (!swapchainResizePending) return;
            size = pendingSwapchainSize;
            swapchainResizePending = false;
        }
        if (backBuffer != null && backBuffer.Description.Width == size.Width
            && backBuffer.Description.Height == size.Height) return;
        try
        {
            // ⚠️ ResizeBuffers 之前**必须释放所有 buffer 引用**（RTV + Texture），
            // 且必须与画面自检串行：staging texture 尺寸不跟随会导致 Map 指针失效。
            ctx.UnsetRenderTargets();
            selfCheckTex?.Dispose(); selfCheckTex = null;
            backRtv?.Dispose(); backRtv = null!;
            backBuffer?.Dispose(); backBuffer = null!;
            swap.ResizeBuffers(0, (uint)size.Width, (uint)size.Height, Format.B8G8R8A8_UNorm, SwapChainFlags.None);
            BindBackBuffer();
            Program.Log($"swapchain 重建 viewport={size.Width}x{size.Height} backBuffer={backBuffer.Description.Width}x{backBuffer.Description.Height} 视频={vw}x{vh} dpi={DeviceDpi}");
        }
        catch (Exception ex) { Program.Log("resize: " + ex.GetType().Name + " " + ex.Message); }
    }

    void InitMpv()
    {
        mpv = new Mpv(mpvExe);
        mpv.OnWakeup += () => wake.Set();
        mpv.SetOption("vo", "libmpv");
        mpv.SetOption("hwdec", "auto-safe");            // d3d11va 硬解
        mpv.SetOption("keep-open", "always");           // 播完停住（由我们上报 ended）
        mpv.SetOption("idle", "yes");
        mpv.SetOption("force-window", "no");
        mpv.SetOption("audio-display", "no");
        mpv.SetOption("osc", "no");                     // mpv 屏上控件关掉（控制条是 WebView2）
        // 红果 CDN 的 TLS 在部分网络路径下证书验证失败（mpv 走 curl 后端，
        // 实测 --tls-verify=no 后恢复正常）。视频内容本身有 CENC 加密，传输层
        // 不校验证书的风险可接受。
        mpv.SetOption("tls-verify", "no");
        mpv.Init();
        mpv.CreateRenderContext(device.NativePointer);
    }

    void InitChain()
    {
        AppDomain.CurrentDomain.SetData("LSFG_HLSL_DIR", hlslDir);
        chain = NewChain();
        AllocateFbo();
    }

    LsfgChain NewChain()
    {
        var c = new LsfgChain(device, ctx, vw, vh, shaderDir, Format.B8G8R8A8_UNorm);
        c.UseCustomFlow = true;
        frameA = MakeFrameImg("frameA");
        frameB = MakeFrameImg("frameB");
        return c;
    }

    Img MakeFrameImg(string name)
    {
        // CopyResource 目标必须 DEFAULT 用法（Dynamic 不行），绕开 CreateDynamic。
        var img = new Img { Name = name, W = vw, H = vh, Fmt = Format.B8G8R8A8_UNorm };
        img.Tex = device.CreateTexture2D(new Texture2DDescription
        {
            Width = (uint)vw, Height = (uint)vh, MipLevels = 1, ArraySize = 1,
            Format = Format.B8G8R8A8_UNorm, SampleDescription = new SampleDescription(1, 0),
            Usage = ResourceUsage.Default, BindFlags = BindFlags.ShaderResource,
            CPUAccessFlags = CpuAccessFlags.None, MiscFlags = ResourceOptionFlags.None,
        });
        img.Srv = device.CreateShaderResourceView(img.Tex);
        return img;
    }

    void AllocateFbo()
    {
        fboA?.Dispose(); fboB?.Dispose();
        var desc = new Texture2DDescription
        {
            Width = (uint)vw, Height = (uint)vh, MipLevels = 1, ArraySize = 1,
            Format = Format.B8G8R8A8_UNorm, SampleDescription = new SampleDescription(1, 0),
            Usage = ResourceUsage.Default, BindFlags = BindFlags.RenderTarget,
            CPUAccessFlags = CpuAccessFlags.None, MiscFlags = ResourceOptionFlags.None,
        };
        fboA = device.CreateTexture2D(desc);
        fboB = device.CreateTexture2D(desc);
        fboPing = true;
        hasFramePair = false;
    }

    async Task InitWebView()
    {
        if (http == null) return;
        try
        {
            webView = new WebView2
            {
                Dock = DockStyle.Fill,
                DefaultBackgroundColor = Color.Transparent,
            };
            Controls.Add(webView);
            webView.BringToFront();
            // WinForms 控件没有 WebView2Environment 静态类（那是 WPF 的）；
            // 用户数据目录通过 CreationProperties 指定，然后无参 Ensure 即可。
            webView.CreationProperties = new CoreWebView2CreationProperties
            {
                UserDataFolder = Path.Combine(Path.GetTempPath(), "ttv-player-webview"),
            };
            await webView.EnsureCoreWebView2Async();
            webView.CoreWebView2.Settings.AreDefaultContextMenusEnabled = false;
            webView.CoreWebView2.Settings.IsStatusBarEnabled = false;
            webView.CoreWebView2.Settings.IsZoomControlEnabled = false;
            webView.CoreWebView2.Settings.AreDevToolsEnabled = Debugger.IsAttached;
            var pageUrl = http.NativePageUrl;
            webView.CoreWebView2.NavigationCompleted += (_, args) =>
            {
                if (args.IsSuccess)
                {
                    BeginInvoke(() =>
                    {
                        if (IsDisposed || webView == null) return;
                        barHost.Visible = false;
                        webView.BringToFront();
                    });
                }
                else
                {
                    Program.Log($"webview controls navigation failed: {args.WebErrorStatus}");
                    BeginInvoke(() =>
                    {
                        if (IsDisposed || webView == null) return;
                        Controls.Remove(webView);
                        webView.Dispose();
                        webView = null;
                        barHost.Visible = true;
                        playerBar.Visible = true;
                    });
                }
            };
            webView.CoreWebView2.Navigate(pageUrl);
            Program.Log("webview controls -> " + pageUrl);
        }
        catch (Exception ex)
        {
            Program.Log("webview init failed（回退原生控制条）: " + ex.Message);
            if (webView != null)
            {
                Controls.Remove(webView);
                webView.Dispose();
                webView = null;
            }
            barHost.Visible = true;
            playerBar.Visible = true;
        }
    }

    // ───────────────────────── 装载 ─────────────────────────

    void ApplyLoad(LoadRequest req)
    {
        Program.Log($"load ep={req.ep} vw={req.vw}x{req.vh} start={req.start:0.###} total={req.total:0.#}");
        int newVw = Math.Clamp(req.vw, 160, 2160);
        int newVh = Math.Clamp(req.vh, 160, 3840);

        if (newVw != vw || newVh != vh)
        {
            vw = newVw; vh = newVh;
            chain.Dispose();
            frameA.Dispose(); frameB.Dispose();
            AppDomain.CurrentDomain.SetData("LSFG_HLSL_DIR", hlslDir);
            chain = NewChain();
            AllocateFbo();
        }
        hasFramePair = false;
        sizeSynced = false;      // 新的一集：等 mpv 解密后重新确认真实尺寸
        ended = false;
        Interlocked.Exchange(ref nextPresentationTick, 0);
        totalSeconds = Math.Max(0.1, req.total);

        mpv.SetPropertyDouble("volume", Math.Clamp(req.volume, 0, 100));
        mpv.LoadFile(req.url, req.key, Math.Max(0, req.start));
        Text = "TTV 播放器 — " + req.title;

        if (!fullscreen)
        {
            // ⚠️ WorkingArea 是**物理像素**，ClientSize 是**逻辑像素**：
            // 150% 缩放时 960 逻辑 = 1440 物理，直接取 area.Width 会让窗口
            // 右边超出屏幕（实测被裁掉半个控制条）。按 DeviceDpi 折算。
            var area = Screen.FromControl(this).WorkingArea;
            float scale = DeviceDpi / 96f;
            int maxW = (int)(area.Width / scale) - 20;
            int maxH = (int)(area.Height / scale) - 20;
            // 先按视频比例定宽，再按同一比例反推高 —— 否则被屏幕宽度限制后
            // 比例失衡，画面上下会多出黑边（实测 960x540 被压到 833 宽就出现了）。
            // 窗口客户区**精确等于**视频尺寸 + 控制条：swapchain 与解码帧同尺寸，
            // BlitToBack 走 CopyResource 整幅拷贝，没有任何黑边。
            // （曾经按屏幕工作区 clamp 宽度，结果 backBuffer 比例与视频不一致，
            //   letterbox 又因为 CopySubresourceRegion 不缩放而偏移，画面上方多出黑边。）
            int winW = Math.Clamp(vw, 320, Math.Max(320, maxW));
            int winH = Math.Clamp(vh + BarH, 200, Math.Max(200, maxH));
            if (winW != vw || winH != vh + BarH)
                Program.Log($"窗口受屏幕限制 {vw}x{vh + BarH} -> {winW}x{winH}（画面会 letterbox 居中）");
            ClientSize = new Size(winW, winH);
            // 改过尺寸必须重新居中：StartPosition=CenterScreen 只在构造时生效一次，
            // 之后 ApplyLoad 调整 ClientSize 会让窗口向右下越界（实测右侧被裁）。
            CenterToScreen();
        }
        // 控制条状态与播放器实际状态对齐（构造时补帧是关的，这里按参数开起来）
        playerBar?.SetFg(fgEnabled, fgMult);
        playerBar?.SetTitle(req.title ?? "");
        playerBar?.SetPosition(0, totalSeconds);
        http.PushTitle(req.title, req.ep);
        ipc.SendEvent(new { @event = "loaded", ep = req.ep });

        // 置顶并抢焦点：播放器是独立进程，主程序窗口（TTV）通常占满屏幕，
        // 不置顶的话用户只会听到声音、看不到画面（实测画面在渲染但被主窗口盖住）。
        // 全屏模式下由 ToggleFullscreen 自己处理，这里只管窗口态。
        if (!fullscreen)
        {
            TopMost = true;
            Activate();
            BringToFront();
            // 一秒后取消置顶：给用户一次"看到窗口弹出来"的确认，之后回到普通层级，
            // 免得播放器永远压住主程序的对话框。
            var t = new System.Windows.Forms.Timer { Interval = 1200 };
            t.Tick += (_, _) => { t.Stop(); t.Dispose(); if (!fullscreen) TopMost = false; };
            t.Start();
        }
        wake.Set();
    }

    // ───────────────────────── 渲染循环 ─────────────────────────

    void RenderLoop()
    {
        while (running)
        {
            wake.Reset();
            try
            {
                ApplyPendingSwapchainResize();
                uint flags = mpv.RenderUpdate();
                if ((flags & Mpv.MPV_RENDER_UPDATE_FRAME) != 0)
                {
                    var fbo = fboPing ? fboA : fboB;
                    fboPing = !fboPing;
                    mpv.Render(fbo.NativePointer);
                    ctx.CopyResource(frameA.Tex, frameB.Tex);   // A ← 上一帧 B
                    ctx.CopyResource(frameB.Tex, fbo);          // B ← 新帧
                    hasFramePair = true;
                    statSrc++;
                }

                // 视频真实尺寸自适应：Rust 侧只有"源尺寸"（可能来自旧缓存或猜错），
                // mpv 解密后才知道真实宽高（横屏剧 1920x1080 / 竖屏短剧 1080x1920 都有）。
                // 比例不符就按真实比例重建补帧链 + 调整窗口，免得大片黑边。
                if (!sizeSynced)
                {
                    // dwidth/dheight = 显示尺寸（含像素比修正）；width/height 在
                    // render 模式下常常读不到，video-params/* 是解码尺寸，三级兜底。
                    long mw = mpv.GetPropertyInt64("dwidth");
                    long mh = mpv.GetPropertyInt64("dheight");
                    if (mw < 100 || mh < 100)
                    {
                        mw = mpv.GetPropertyInt64("video-params/w");
                        mh = mpv.GetPropertyInt64("video-params/h");
                    }
                    if (mw < 100 || mh < 100)
                    {
                        mw = mpv.GetPropertyInt64("width");
                        mh = mpv.GetPropertyInt64("height");
                    }
                    if (mw > 100 && mh > 100)
                    {
                        sizeSynced = true;
                        Program.Log($"探测源尺寸 {mw}x{mh}");
                        int targetVw, targetVh;
                        // 补帧管线长边固定 960（540p~720p 档，GPU 预算可控）
                        if (mw >= mh) { targetVw = 960; targetVh = (int)Math.Round(960.0 * mh / mw / 2) * 2; }
                        else { targetVh = 960; targetVw = (int)Math.Round(960.0 * mw / mh / 2) * 2; }
                        if (Math.Abs(targetVw - vw) > 8 || Math.Abs(targetVh - vh) > 8)
                        {
                            Program.Log($"尺寸自适应 {vw}x{vh} -> {targetVw}x{targetVh}（源 {mw}x{mh}）");
                            BeginInvoke(() =>
                            {
                                try
                                {
                                    vw = targetVw; vh = targetVh;
                                    chain.Dispose();
                                    frameA.Dispose(); frameB.Dispose();
                                    chain = NewChain();
                                    AllocateFbo();
                                    if (!fullscreen)
                                    {
                                        var area = Screen.FromControl(this).WorkingArea;
                                        int winH = Math.Min(vh + BarH, area.Height - 20);
                                        int scale = Math.Max(1, vw / area.Width + 1);
                                        int winW = Math.Min(vw / Math.Max(1, vw / 900), area.Width - 20);
                                        ClientSize = new Size(Math.Max(360, winW), Math.Max(240, winH));
                                    }
                                }
                                catch (Exception ex) { Program.Log("resize video: " + ex.Message); }
                            });
                        }
                    }
                }

                double fpsNow = mpv.GetPropertyDouble("container-fps");
                if (fpsNow > 5 && fpsNow < 240 && Math.Abs(fpsNow - srcFps) > 0.5)
                {
                    srcFps = fpsNow;
                    Program.Log($"fps -> {srcFps}");
                }

                double pos = mpv.GetPropertyDouble("time-pos");
                if (pos >= 0) lastPos = pos;

                // 播到末尾 / 无更多帧 → ended。收到新 load 或 seek 后清除。
                if (mpv.GetPropertyFlag("eof-reached"))
                {
                    if (!ended)
                    {
                        ended = true;
                        Program.Log($"ended at {lastPos:F1}s");
                        ipc.SendEvent(new { @event = "ended", pos = Math.Round(lastPos, 2), dur = totalSeconds });
                    }
                }
                else if (ended && pos > 0 && pos < totalSeconds - 0.5) ended = false;

                // 画面自检：每 3 秒回读一次像素均值
                framesSinceCheck++;
                if (framesSinceCheck >= 180)
                {
                    framesSinceCheck = 0;
                    double mean = SelfCheckMean();
                    if (Math.Abs(mean - lastMean) > 0.5 || mean < 5)
                        Program.Log($"画面自检 mean={mean:F1}{(mean < 5 ? "  ⚠ 接近全黑" : "")} pos={lastPos:F1}s");
                    lastMean = mean;
                }

                // 播完（keep-open 停在末尾）：不再跑补帧链，否则整条 162-dispatch
                // 管线会在静止画面上空转烧 GPU（实测停住后仍 97fps）。
                if (ended)
                {
                    if (framesSinceCheck == 0)
                    {
                        BlitToBack(fboPing ? fboB : fboA);
                        Present();
                    }
                    wake.Wait(80);
                    continue;
                }
                int targetFps = fgEnabled && srcFps > 5
                    ? FrameCadence.TargetFps(srcFps, fgMult)
                    : 0;
                if (fgEnabled && hasFramePair && targetFps > 0)
                {
                    long interval = FrameCadence.IntervalTicks(targetFps, Stopwatch.Frequency);
                    var schedule = FrameCadence.Evaluate(
                        Stopwatch.GetTimestamp(),
                        Interlocked.Read(ref nextPresentationTick),
                        interval,
                        Stopwatch.Frequency);
                    if (!schedule.Due)
                    {
                        wake.Wait(schedule.WaitMilliseconds);
                        continue;
                    }
                    Interlocked.Exchange(ref nextPresentationTick, schedule.NextTick);
                    double t = (pos * srcFps) % 1.0;
                    if (t < 0) t += 1.0;
                    chain.RunFrame(frameA, frameB, (float)t);
                    BlitToBack(chain.Output.Tex);
                    Present();
                }
                else if (hasFramePair)
                {
                    BlitToBack(fboPing ? fboB : fboA);
                    Present();
                }
                else
                {
                    ctx.ClearRenderTargetView(backRtv, new Vortice.Mathematics.Color4(0, 0, 0, 1));
                    Present();
                    wake.Wait(30);
                    continue;
                }

                statFrames++;
                if (swStat.ElapsedMilliseconds >= 2000)
                {
                    double outFps = statFrames * 1000.0 / swStat.ElapsedMilliseconds;
                    Program.Log($"out={outFps:F1}fps src={statSrc} fg={(targetFps > 0 ? $"{fgMult}X target={targetFps}fps" : "off")} pos={lastPos:F1}s");
                    statFrames = 0; statSrc = 0;
                    swStat.Restart();
                    ipc.SendEvent(new { @event = "progress", pos = Math.Round(lastPos, 2), dur = totalSeconds });
                }

                wake.Wait(10);
            }
            catch (Exception ex)
            {
                Program.Log("RENDER: " + ex.GetType().Name + " " + ex.Message);
                wake.Wait(50);
            }
        }
    }

    // ── 画面自检（无人值守验证"真的有画面"，比截图可靠）──
    // 每 3 秒回读一次 backBuffer 采样均值：全黑=0；有内容一般 > 20。
    // 窗口被遮挡、无桌面会话时截图完全不可靠，这个才是可信证据。
    ID3D11Texture2D? selfCheckTex;
    long framesSinceCheck;
    double lastMean = -1;

    double SelfCheckMean()
    {
        try
        {
            var d = backBuffer.Description;
            if (selfCheckTex == null || !ReadbackTexture.Matches(
                selfCheckTex.Description.Width, selfCheckTex.Description.Height, d.Width, d.Height))
            {
                selfCheckTex?.Dispose();
                selfCheckTex = device.CreateTexture2D(new Texture2DDescription
                {
                    Width = d.Width, Height = d.Height, MipLevels = 1, ArraySize = 1,
                    Format = Format.B8G8R8A8_UNorm, SampleDescription = new SampleDescription(1, 0),
                    Usage = ResourceUsage.Staging, BindFlags = BindFlags.None,
                    CPUAccessFlags = CpuAccessFlags.Read, MiscFlags = ResourceOptionFlags.None,
                });
            }
            ctx.CopyResource(selfCheckTex, backBuffer);
            var map = ctx.Map(selfCheckTex, 0, MapMode.Read, Vortice.Direct3D11.MapFlags.None);
            try
            {
                long sum = 0; int n = 0;
                for (int y = 0; y < (int)d.Height; y += 24)
                {
                    long row = (long)map.DataPointer + (long)y * map.RowPitch;
                    for (int x = 0; x < (int)d.Width; x += 24)
                    {
                        int b = Marshal.ReadByte((nint)row, x * 4);
                        int g = Marshal.ReadByte((nint)row, x * 4 + 1);
                        int r = Marshal.ReadByte((nint)row, x * 4 + 2);
                        sum += (b + g + r) / 3; n++;
                    }
                }
                return n == 0 ? 0 : (double)sum / n;
            }
            finally { ctx.Unmap(selfCheckTex, 0); }
        }
        catch (Exception ex) { Program.Log("selfcheck: " + ex.GetType().Name); return -1; }
    }

    void BlitToBack(ID3D11Texture2D src)
    {
        var bbDesc = backBuffer.Description;
        if (bbDesc.Width == (uint)vw && bbDesc.Height == (uint)vh)
        {
            ctx.CopyResource(backBuffer, src);
        }
        else
        {
            // 尺寸不一致时只能整幅拷贝（CopySubresourceRegion 不做缩放），
            // 居中放置后清黑边。窗口比例正常情况下不会走到这里。
            ctx.ClearRenderTargetView(backRtv, new Vortice.Mathematics.Color4(0, 0, 0, 1));
            int dw = (int)bbDesc.Width, dh = (int)bbDesc.Height;
            int x = Math.Max(0, (dw - vw) / 2);
            int y = Math.Max(0, (dh - vh) / 2);
            ctx.CopySubresourceRegion(backBuffer, 0, (uint)x, (uint)y, 0, src, 0);
        }
    }

    void Present()
    {
        ctx.UnsetRenderTargets();
        swap.Present(1, PresentFlags.None);   // vsync
        mpv.ReportSwap();
    }

    // ───────────────────────── 控制命令（IPC 管道 + HTTP 共用） ─────────────────────────

    public void CmdPause()
    {
        bool cur = mpv.GetPropertyFlag("pause");
        mpv.SetPropertyFlag("pause", !cur);
    }

    // 数组形式：mpv_command_string 对 "seek 60 absolute exact" 这类带多个
    // 位置参数的字符串解析不可靠（实测完全不生效，且不报错）。数组形式零歧义。
    public void CmdSeek(double pos) =>
        mpv.CommandArgs("seek",
            Math.Max(0, pos).ToString("0.###", CultureInfo.InvariantCulture),
            "absolute", "exact");

    public void CmdVolume(int v) => mpv.SetPropertyDouble("volume", Math.Clamp(v, 0, 100));

    public void CmdSpeed(double rate) => mpv.SetPropertyDouble("speed", Math.Clamp(rate, 0.25, 4.0));

    public void SetFg(bool on, int mult)
    {
        fgEnabled = on;
        fgMult = Math.Clamp(mult, 2, 5);
        Interlocked.Exchange(ref nextPresentationTick, 0);
        ipc.SendEvent(new { @event = "frame-interpolation", enabled = fgEnabled, mult = fgMult });
        Program.Log($"fg -> {on} {fgMult}X");
    }

    void OnIpcCommand(JsonElement cmd)
    {
        try
        {
            switch (cmd.GetProperty("cmd").GetString())
            {
                case "load":
                    var req = JsonSerializer.Deserialize<LoadRequest>(cmd.GetRawText());
                    if (req != null) BeginInvoke(() => ApplyLoad(req));
                    break;
                // ⚠️ 参数必须**在这里就读出来**：`cmd` 是 JsonElement，IpcPipe 里的
                // JsonDocument 是 `using` 的，HandleLine 返回即释放；BeginInvoke 的
                // lambda 是排队执行的，那时再访问 cmd 会抛 ObjectDisposedException，
                // 而异常发生在消息泵里 —— 表现为"命令静默不生效"。
                // 实测：pause（无参数）正常，seek/volume/speed/fg（带参数）全部失效。
                case "pause": BeginInvoke(CmdPause); break;
                case "play":
                    BeginInvoke(() => { if (mpv.GetPropertyFlag("pause")) CmdPause(); });
                    break;
                case "seek":
                {
                    double pos = cmd.GetProperty("pos").GetDouble();
                    BeginInvoke(() => CmdSeek(pos));
                    break;
                }
                case "volume":
                {
                    int v = cmd.GetProperty("v").GetInt32();
                    BeginInvoke(() => CmdVolume(v));
                    break;
                }
                case "speed":
                {
                    double rate = cmd.GetProperty("rate").GetDouble();
                    BeginInvoke(() => CmdSpeed(rate));
                    break;
                }
                case "fg":
                {
                    bool on = cmd.GetProperty("on").GetBoolean();
                    int mult = cmd.TryGetProperty("mult", out var m) ? m.GetInt32() : fgMult;
                    BeginInvoke(() => SetFg(on, mult));
                    break;
                }
                case "quit": BeginInvoke(Close); break;
            }
        }
        catch (Exception ex) { Program.Log("ipc: " + ex.Message); }
    }

    void OnKey(object? s, KeyEventArgs e)
    {
        switch (e.KeyCode)
        {
            case Keys.Space: CmdPause(); e.Handled = true; break;
            case Keys.Left: CmdSeek(lastPos - 10); e.Handled = true; break;
            case Keys.Right: CmdSeek(lastPos + 10); e.Handled = true; break;
            case Keys.F: case Keys.F11: ToggleFullscreen(); e.Handled = true; break;
            case Keys.B: playerBar?.SetFg(!fgEnabled, fgMult); e.Handled = true; break;
            case Keys.D2: playerBar?.SetFg(true, 2); e.Handled = true; break;
            case Keys.D3: playerBar?.SetFg(true, 3); e.Handled = true; break;
            case Keys.D4: playerBar?.SetFg(true, 4); e.Handled = true; break;
            case Keys.D5: playerBar?.SetFg(true, 5); e.Handled = true; break;
            case Keys.Escape: if (fullscreen) ToggleFullscreen(); else Close(); e.Handled = true; break;
        }
    }

    void ToggleFullscreen()
    {
        if (!fullscreen)
        {
            windowedBounds = Bounds;
            fullscreen = true;
            FormBorderStyle = FormBorderStyle.None;
            WindowState = FormWindowState.Maximized;
        }
        else
        {
            fullscreen = false;
            FormBorderStyle = FormBorderStyle.Sizable;
            WindowState = FormWindowState.Normal;
            if (windowedBounds.Width > 0 && windowedBounds.Height > 0)
                Bounds = windowedBounds;
        }
    }

    // ───────────────────────── 控制条（HTTP）读取面 ─────────────────────────

    public bool GetPaused() => mpv?.GetPropertyFlag("pause") ?? true;
    public double GetPosition() => lastPos;
    public double GetDuration() => Math.Max(mpv?.GetPropertyDouble("duration") ?? 0, totalSeconds);
    public double GetVolume() => mpv?.GetPropertyDouble("volume") ?? 100;
    public double GetSpeed() => mpv?.GetPropertyDouble("speed") ?? 1.0;
    public bool IsFullscreen() => fullscreen;
    public bool IsFgOn() => fgEnabled;
    public int GetFgMult() => fgMult;
    public void PrevEpisode() => ipc.SendEvent(new { @event = "prev", pos = Math.Round(lastPos, 2) });
    public void NextEpisode() => ipc.SendEvent(new { @event = "next", pos = Math.Round(lastPos, 2) });
    public void ToggleFullscreenPublic() => ToggleFullscreen();

    void Shutdown()
    {
        running = false;
        wake.Set();
        try { renderThread?.Join(1200); } catch { }
        double pos = lastPos;
        ipc.SendEvent(new { @event = "closed", pos = Math.Round(pos, 2), dur = totalSeconds });
        try { mpv.Dispose(); } catch { }
        try { selfCheckTex?.Dispose(); } catch { }
        try { chain.Dispose(); } catch { }
        try { http?.Stop(); } catch { }
        try { ipc.Dispose(); } catch { }
        try { swap.Dispose(); } catch { }
        try { device.Dispose(); } catch { }
    }
}
