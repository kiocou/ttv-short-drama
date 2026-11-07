// LsfgChain —— 按外部 DAG 抓包实现的完整调度器（A2 主体）。
//
// 结构来源：YolkooBoost 的 lsfg-dag-capture.txt（100 dispatch/帧，500x500 输入）。
//
// 三条硬约束（都是外部抓包纠正过来的，早期版本全错）：
//   1. 金字塔第 0 级 = **原尺寸**（500,250,125,62,31,15,7），不是 w>>(i+1)
//   2. 流场工作在 **1/4 分辨率**（500→125）
//   3. 每帧 **100 个 dispatch**；frameA 的金字塔是**上一帧遗留的时间状态**
//
// 绑定约定（从 DAG 的 img id 逐条对出来的）：
//   #156 mid-flow  SRV9  = [上一帧 feature×4][当前帧 feature×4][上一级流场]
//   #157 fine-flow SRV10 = [上一帧 feature×4][当前帧 feature×4][上一级流场][全局 img4]
//   #162 refine3→4 SRV3/UAV4 = [3 工作] → [4 工作]
//   #160/#164 ping SRV4/UAV4 = 原地读写
//   #165/#161 field SRV6/UAV1 = [4 工作][全局 img4][光流金字塔对应级] → 流场
//   #176/#172/#170 blend SRV2/UAV2 = 2 → 2
//   #173 finalize SRV3/UAV1 = [2 工作][全局 img4] → blend 场
//   #155 synthesis SRV5/UAV1 = [frameA][frameB][fwd][bwd][blend]
//
// 唯一仍未定的量：每次 dispatch 的 cbuffer 数值（t / FirstIter / FirstIterS /
// InvDimension / ResolutionInvScale），全部走 CbParams，便于扫描拟合。
using System.Runtime.InteropServices;
using Vortice.Direct3D;
using Vortice.Direct3D11;
using Vortice.DXGI;

namespace LsfgPipeline;

/// <summary>#156/#157 的第 9/10 个输入（"粗级初值"）到底该喂什么 —— 静态分析定不了，靠扫描。</summary>
public enum CoarseSource { CoarserFlow, Zero, CurFeat0, PrevFeat0 }

public struct CbParams
{
    public uint InputOffsetX, InputOffsetY;
    public uint FirstIter;           // +8  链 A 首轮
    public uint FirstIterS;          // +12 链 B 首轮
    public float ResolutionInvScale; // +24
    public float Timestamp;          // +28
    public float UiThreshold;        // +32

    public static CbParams Default(float t) => new()
    {
        InputOffsetX = 0, InputOffsetY = 0,
        FirstIter = 1, FirstIterS = 1,
        ResolutionInvScale = 1f,
        Timestamp = t,
        UiThreshold = 0.5f,
    };
}

public sealed class Img : IDisposable
{
    public string Name;
    public ID3D11Texture2D Tex;
    public ID3D11ShaderResourceView Srv;
    public ID3D11UnorderedAccessView Uav;
    public int W, H;
    public Format Fmt;
    public void Dispose() { Uav?.Dispose(); Srv?.Dispose(); Tex?.Dispose(); }
}

public sealed class LsfgChain : IDisposable
{
    readonly ID3D11Device device;
    readonly ID3D11DeviceContext ctx;
    readonly ShaderBank shaders;
    readonly Dictionary<string, Img> imgs = new();
    float cachedFpyrValue = -1f;
    ID3D11Buffer cb;
    ID3D11SamplerState sampLinear, sampPoint;

    public int Width { get; }
    public int Height { get; }
    public int Levels { get; } = 7;

    /// <summary>合成输出的像素格式。播放时用 B8G8R8A8 以便直接进 swapchain。</summary>
    public Format OutputFormat { get; set; } = Format.R8G8B8A8_UNorm;
    public int DispatchCount { get; private set; }

    /// <summary>粗级初值来源（A2 扫描用）。</summary>
    public CoarseSource Coarse { get; set; } = CoarseSource.CoarserFlow;

    /// <summary>用自写块匹配光流替代官方 39 个 pass（确定性、可验证）。</summary>
    public bool UseCustomFlow { get; set; } = true;

    /// <summary>块匹配搜索半径（流场分辨率上的像素）。</summary>
    public int SearchRadius { get; set; } = 8;

    ID3D11ComputeShader blockMatchCs;
    ID3D11Buffer bmCb;

    /// <summary>强行指定 flowpyr 的常量值（null = 用 #178 的真实输出）。用于验证权重抑制。</summary>
    public float? FlowpyrOverride { get; set; }

    /// <summary>合成前把流场乘 -1（#165 的公式结构产不出负号，方向另行确认）。</summary>
    public bool NegateFlow { get; set; }

    ID3D11ComputeShader negateCs;
    ID3D11Buffer scaleCb;

    /// <summary>流场在送进 synthesis 之前乘的系数（单位=像素，官方值应为 1；实测需要放大）。</summary>
    public float FlowGain { get; set; } = 1f;

    /// <summary>#174 flow-init 的 12 个输入怎么拼（DAG 只给 img id，组合需试）。</summary>
    public int InitVariant { get; set; } = 1;   // v1 = prev4+cur4+tmp4（常量输入下偏置最小，实测 0.0004）

    /// <summary>纯色探针：把两帧的 feature 都清成同一常量（此时 #156 的正确输出必须是零）。</summary>
    public bool ConstantFeatures { get; set; }

    /// <summary>合成时交换前向/反向流场（若 #165 输出的符号与 synthesis 期望相反）。</summary>
    public bool SwapFlow { get; set; }

    /// <summary>#156/#157 的 9 个输入里，前 4 个到底放上一帧还是当前帧（DAG 只给了 img id）。</summary>
    public bool FeatCurFirst { get; set; }

    /// <summary>true = 合成时流场强制用零流（M2-a 的对照配置，应输出 (A+B)/2）。</summary>
    public bool ForceZeroFlow { get; set; }

    /// <summary>true = synthesis 的 t4 用全 1 权重（M2-a 验证过的配置）。</summary>
    public bool UseFlatWeight { get; set; } = true;

    /// <summary>合成阶段对流场的额外缩放（synthesis 把流场乘 cb0[1].z = ResolutionInvScale）。
    /// 光流链自身需要 1.0，但若实测流场量级偏大，这里可单独压回去。</summary>
    public float SynthFlowScale { get; set; } = 1f;

    /// <summary>每次 dispatch 后回调（A2 调参用）。</summary>
    public Action<string, Img> OnDispatch { get; set; }

    public LsfgChain(ID3D11Device device, ID3D11DeviceContext ctx, int width, int height, string shaderDir = null, Format outputFormat = Format.R8G8B8A8_UNorm)
    {
        OutputFormat = outputFormat;
        this.device = device; this.ctx = ctx;
        Width = width; Height = height;
        shaders = new ShaderBank(device, shaderDir);

        cb = device.CreateBuffer(new BufferDescription(48, BindFlags.ConstantBuffer,
            ResourceUsage.Default, CpuAccessFlags.None, ResourceOptionFlags.None, 0));

        sampLinear = device.CreateSamplerState(new SamplerDescription
        {
            Filter = Filter.MinMagMipLinear,
            AddressU = TextureAddressMode.Clamp, AddressV = TextureAddressMode.Clamp, AddressW = TextureAddressMode.Clamp,
            ComparisonFunc = ComparisonFunction.Never, MaxLOD = float.MaxValue,
        });
        sampPoint = device.CreateSamplerState(new SamplerDescription
        {
            Filter = Filter.MinMagMipPoint,
            AddressU = TextureAddressMode.Clamp, AddressV = TextureAddressMode.Clamp, AddressW = TextureAddressMode.Clamp,
            ComparisonFunc = ComparisonFunction.Never, MaxLOD = float.MaxValue,
        });

        Build();
    }

    // ── 尺寸阶梯（对齐 500x500 实测序列）──
    public int PyrW(int i) => Math.Max(2, Width >> i);
    public int PyrH(int i) => Math.Max(2, Height >> i);
    /// <summary>光流级 k=0..6 → 2..125（相对 Width/4）。</summary>
    public int FlowW(int k) => Math.Max(2, Math.Max(2, Width / 4) >> (Levels - 1 - k));
    public int FlowH(int k) => Math.Max(2, Math.Max(2, Height / 4) >> (Levels - 1 - k));

    Img Make(string name, int w, int h, Format fmt, bool uav = true)
    {
        var img = new Img { Name = name, W = w, H = h, Fmt = fmt };
        img.Tex = device.CreateTexture2D(new Texture2DDescription
        {
            Width = (uint)w, Height = (uint)h, MipLevels = 1, ArraySize = 1, Format = fmt,
            SampleDescription = new SampleDescription(1, 0), Usage = ResourceUsage.Default,
            BindFlags = BindFlags.ShaderResource | (uav ? BindFlags.UnorderedAccess : BindFlags.None),
            CPUAccessFlags = CpuAccessFlags.None, MiscFlags = ResourceOptionFlags.None,
        });
        img.Srv = device.CreateShaderResourceView(img.Tex);
        if (uav) img.Uav = device.CreateUnorderedAccessView(img.Tex);
        imgs[name] = img;
        return img;
    }

    void Build()
    {
        // 金字塔：mip0 = 原尺寸
        for (int i = 0; i < Levels; i++) Make($"pyr{i}", PyrW(i), PyrH(i), Format.R8_UNorm);

        // feature：**双缓冲**（上一帧 / 当前帧），四重奏每级 4 张
        // ★ feature 级别 lv 与金字塔级别**反序**：lv0 用最粗的 pyr6，lv6 用最细的 pyr0。
        //   四重奏把 pyr 逐级降到 1/4，所以 featCur 尺寸 = PyrW(pi)/4，flow 级别尺寸与之相等。
        for (int lv = 0; lv < Levels; lv++)
        {
            int pi = Levels - 1 - lv;
            int w = Math.Max(2, PyrW(pi) / 4), h = Math.Max(2, PyrH(pi) / 4);
            for (int k = 0; k < 4; k++)
            {
                Make($"featCur_l{lv}_{k}", w, h, Format.R8G8B8A8_UNorm);
                Make($"featPrev_l{lv}_{k}", w, h, Format.R8G8B8A8_UNorm);
            }
            int wh = Math.Max(2, PyrW(pi) / 2), hh = Math.Max(2, PyrH(pi) / 2);
            for (int k = 0; k < 4; k++)
            {
                Make($"featMid_l{lv}_{k}", wh, hh, Format.R8G8B8A8_UNorm);   // #166/#167 用（pyr/2）
                Make($"featTmp_l{lv}_{k}", w, h, Format.R8G8B8A8_UNorm);     // #168 用（pyr/4）
            }
        }

        // 光流：**读写严格分离**（D3D11 不允许同一资源同时绑 SRV+UAV，冲突会静默解绑，
        // 表现为输出变成常数 —— 这正是之前 std=0 的原因）。
        // 缓冲布局对齐 DAG：d3035 出 3 张 → d3036 写 A 组 4 张 → d3037 写 B 组 4 张
        // → d3038 写回 A 组 → d3039 读 A 组出流场。即 A/B 两组交替 ping-pong。
        for (int k = 0; k < Levels; k++)
        {
            int w = FlowW(k), h = FlowH(k);
            for (int j = 0; j < 3; j++) Make($"fwd3_{k}_{j}", w, h, Format.R8G8B8A8_UNorm);
            for (int j = 0; j < 4; j++)
            {
                Make($"fwdA_{k}_{j}", w, h, Format.R8G8B8A8_UNorm);
                Make($"fwdB_{k}_{j}", w, h, Format.R8G8B8A8_UNorm);
            }
            for (int j = 0; j < 2; j++) Make($"bwd2_{k}_{j}", w, h, Format.R8G8B8A8_UNorm);
            for (int j = 0; j < 4; j++)
            {
                Make($"bwdA_{k}_{j}", w, h, Format.R8G8B8A8_UNorm);
                Make($"bwdB_{k}_{j}", w, h, Format.R8G8B8A8_UNorm);
            }
            for (int j = 0; j < 2; j++)
            {
                Make($"bl2_{k}_{j}", w, h, Format.R8G8B8A8_UNorm);
                Make($"blA_{k}_{j}", w, h, Format.R8G8B8A8_UNorm);
                Make($"blB_{k}_{j}", w, h, Format.R8G8B8A8_UNorm);
            }
            // init/refine 阶段的 6 张（DAG d3030→d3033 的两组交替）
            for (int j = 0; j < 2; j++)
            {
                Make($"initOut_{k}_{j}", w, h, Format.R8G8B8A8_UNorm);
                Make($"refA_{k}_{j}", w, h, Format.R8G8B8A8_UNorm);
                Make($"refB_{k}_{j}", w, h, Format.R8G8B8A8_UNorm);
            }
            Make($"flowFwd_{k}", w, h, Format.R16G16B16A16_Float);
            Make($"flowBwd_{k}", w, h, Format.R16G16B16A16_Float);
            Make($"flowBlend_{k}", w, h, Format.R16G16B16A16_Float);
        }

        // 光流金字塔（#178 输出 6 级，最细 = 最细光流级）
        for (int i = 0; i < 6; i++)
        {
            int w = Math.Max(2, FlowW(Levels - 1) >> i), h = Math.Max(2, FlowH(Levels - 1) >> i);
            Make($"flowpyr{i}", w, h, Format.R8_UNorm);
        }

        // 全局零流初始化缓冲（DAG 里的 img4：4x4）
        {
            var zeroBytes = new byte[Width * Height * 8];
            AddExternal("zeroFlow", Width, Height, Format.R16G16B16A16_Float, zeroBytes);
            // DAG 里 #156 的第 9 个输入是 img4（4x4 rgba8），格式与流场不同
            AddExternal("initFlow8", 4, 4, Format.R8G8B8A8_UNorm, new byte[4 * 4 * 4]);
        }
        // 全 1 权重：M2-a 里已验证 synthesis 的 t4 在全 1 时输出精确 (A+B)/2
        {
            var oneBytes = new byte[Width * Height * 8];
            for (int i = 0; i < Width * Height; i++)
                for (int q = 0; q < 4; q++) { oneBytes[i * 8 + q * 2] = 0x00; oneBytes[i * 8 + q * 2 + 1] = 0x3C; }
            AddExternal("weightOne", Width, Height, Format.R16G16B16A16_Float, oneBytes);
        }

        Make("fpyrConst", Math.Max(2, FlowW(Levels - 1)), Math.Max(2, FlowH(Levels - 1)), Format.R8_UNorm);
        Make("flowFwdNeg", Math.Max(2, Width / 4), Math.Max(2, Height / 4), Format.R16G16B16A16_Float);
        Make("flowBwdNeg", Math.Max(2, Width / 4), Math.Max(2, Height / 4), Format.R16G16B16A16_Float);
        Make("synthOut", Width, Height, OutputFormat);

        // 现场编译一个 negate shader（20 行，避免为取反单独引入一个 DXBC 依赖）
        const string hlsl = @"
cbuffer K : register(b0) { float k; float3 pad; };
RWTexture2D<float4> Out_ : register(u0);
Texture2D<float4> In_ : register(t0);
[numthreads(8,8,1)]
void main(uint3 tid : SV_DispatchThreadID)
{
    uint w, h;
    Out_.GetDimensions(w, h);
    if (tid.x >= w || tid.y >= h) return;
    Out_[tid.xy] = In_[tid.xy] * k;
}";
        var blob = Vortice.D3DCompiler.Compiler.Compile(hlsl, "main", "negate.hlsl", "cs_5_0");
        negateCs = device.CreateComputeShader(blob.Span, null);
        scaleCb = device.CreateBuffer(new BufferDescription(16, BindFlags.ConstantBuffer,
            ResourceUsage.Default, CpuAccessFlags.None, ResourceOptionFlags.None, 0));

        // 块匹配光流：对每个像素在 ±R 内做 3x3 SAD 搜索，双向各一次。
        // 源码放在 blockmatch.hlsl（独立文件，便于单独用 fxc 校验语法）。
        var hlslPath = Path.Combine(AppContext.BaseDirectory, "blockmatch.hlsl");
        if (!File.Exists(hlslPath))
        {
            var probe = AppContext.BaseDirectory;
            for (int i = 0; i < 6 && probe != null; i++)
            {
                var cand = Path.Combine(probe, "LsfgPipeline", "blockmatch.hlsl");
                if (File.Exists(cand)) { hlslPath = cand; break; }
                probe = Path.GetDirectoryName(probe);
            }
        }
        var bmHlsl = File.ReadAllText(hlslPath);
        var bmBlob = Vortice.D3DCompiler.Compiler.Compile(bmHlsl, "main", "blockmatch.hlsl", "cs_5_0");
        blockMatchCs = device.CreateComputeShader(bmBlob.Span, null);
        bmCb = device.CreateBuffer(new BufferDescription(16, BindFlags.ConstantBuffer,
            ResourceUsage.Default, CpuAccessFlags.None, ResourceOptionFlags.None, 0));
    }

    Img Get(string n) => imgs[n];

    /// <summary>创建一个可反复写入的帧纹理（Dynamic + Map）。播放时每帧换内容用。</summary>
    public Img CreateDynamic(string name, int w, int h, Format fmt)
    {
        var img = new Img { Name = name, W = w, H = h, Fmt = fmt };
        img.Tex = device.CreateTexture2D(new Texture2DDescription
        {
            Width = (uint)w, Height = (uint)h, MipLevels = 1, ArraySize = 1, Format = fmt,
            SampleDescription = new SampleDescription(1, 0), Usage = ResourceUsage.Dynamic,
            BindFlags = BindFlags.ShaderResource, CPUAccessFlags = CpuAccessFlags.Write,
            MiscFlags = ResourceOptionFlags.None,
        });
        img.Srv = device.CreateShaderResourceView(img.Tex);
        imgs[name] = img;
        return img;
    }

    /// <summary>把一帧 BGRA 数据写进动态纹理（按 RowPitch 逐行拷）。</summary>
    public unsafe void UploadDynamic(Img img, byte[] data)
    {
        int rowBytes = img.W * 4;
        var map = ctx.Map(img.Tex, 0, MapMode.WriteDiscard, Vortice.Direct3D11.MapFlags.None);
        try
        {
            long dst = (long)map.DataPointer;
            fixed (byte* src = data)
            {
                for (int y = 0; y < img.H; y++)
                    Buffer.MemoryCopy(src + (long)y * rowBytes, (byte*)dst + (long)y * map.RowPitch, rowBytes, rowBytes);
            }
        }
        finally { ctx.Unmap(img.Tex, 0); }
    }

    /// <summary>把合成输出拷到一张可读的纹理（播放器取帧用）。</summary>
    public void CopyOutputTo(Img dst) => ctx.CopyResource(dst.Tex, Output.Tex);

    public Img AddExternal(string name, int w, int h, Format fmt, byte[] data = null)
    {
        if (data == null) return Make(name, w, h, fmt, uav: false);

        // ★ 必须用 CreateTexture2D + SubresourceData 一次建成带数据的纹理。
        //   UpdateSubresource 在这套 Vortice 重载下会静默失败（实测：读回平均差 17.9、最大 250），
        //   而纯色输入会把这个问题完全掩盖掉。
        int rowBytes = fmt == Format.R8G8B8A8_UNorm ? w * 4
                     : fmt == Format.R16G16B16A16_Float ? w * 8 : w;
        var img = new Img { Name = name, W = w, H = h, Fmt = fmt };
        var hnd = GCHandle.Alloc(data, GCHandleType.Pinned);
        try
        {
            var sd = new SubresourceData(hnd.AddrOfPinnedObject(), (uint)rowBytes, (uint)(rowBytes * h));
            img.Tex = device.CreateTexture2D(new Texture2DDescription
            {
                Width = (uint)w, Height = (uint)h, MipLevels = 1, ArraySize = 1, Format = fmt,
                SampleDescription = new SampleDescription(1, 0), Usage = ResourceUsage.Default,
                BindFlags = BindFlags.ShaderResource, CPUAccessFlags = CpuAccessFlags.None,
                MiscFlags = ResourceOptionFlags.None,
            }, new[] { sd });
        }
        finally { hnd.Free(); }
        img.Srv = device.CreateShaderResourceView(img.Tex);
        imgs[name] = img;
        return img;
    }

    /// <summary>
    /// 上传像素数据。**必须按"每像素字节数"选择泛型 T**：
    /// UpdateSubresource&lt;byte&gt; 会按 1 字节/像素算 rowPitch，把 BGRA 图错排成竖条纹（踩过）。
    /// </summary>
    void Upload(Img img, byte[] data)
    {
        int total = data.Length;
        int px = img.W * img.H;
        if (img.Fmt == Format.R8G8B8A8_UNorm && total == px * 4)
        {
            var u = new uint[px];
            Buffer.BlockCopy(data, 0, u, 0, total);
            ctx.UpdateSubresource<uint>(u, img.Tex);
        }
        else if (img.Fmt == Format.R16G16B16A16_Float && total == px * 8)
        {
            var u = new ulong[px];
            Buffer.BlockCopy(data, 0, u, 0, total);
            ctx.UpdateSubresource<ulong>(u, img.Tex);
        }
        else if (img.Fmt == Format.R8_UNorm && total == px)
        {
            ctx.UpdateSubresource<byte>(data, img.Tex);
        }
        else
        {
            var u = new byte[total];
            Buffer.BlockCopy(data, 0, u, 0, total);
            ctx.UpdateSubresource<byte>(u, img.Tex);
        }
    }

    void UploadCb(CbParams p)
    {
        var d = new byte[48];
        BitConverter.GetBytes(p.InputOffsetX).CopyTo(d, 0);
        BitConverter.GetBytes(p.InputOffsetY).CopyTo(d, 4);
        BitConverter.GetBytes(p.FirstIter).CopyTo(d, 8);
        BitConverter.GetBytes(p.FirstIterS).CopyTo(d, 12);
        BitConverter.GetBytes(0u).CopyTo(d, 16);       // AdvancedColorKind = SDR
        BitConverter.GetBytes(0u).CopyTo(d, 20);       // HdrSupport
        BitConverter.GetBytes(p.ResolutionInvScale).CopyTo(d, 24);
        BitConverter.GetBytes(p.Timestamp).CopyTo(d, 28);
        BitConverter.GetBytes(p.UiThreshold).CopyTo(d, 32);
        ctx.UpdateSubresource(d, cb);
    }

    static int G(int v, int local) => Math.Max(1, (v + local - 1) / local);

    void D(string tag, ID3D11ComputeShader cs, CbParams p, Img[] srvs, Img[] uavs,
           int gx, int gy, bool point = false)
    {
        UploadCb(p);
        ctx.CSSetShader(cs);
        ctx.CSSetConstantBuffer(0, cb);
        ctx.CSSetSampler(0, sampLinear);
        ctx.CSSetSampler(1, point ? sampPoint : sampLinear);

        if (srvs is { Length: > 0 })
        {
            var s = new ID3D11ShaderResourceView[srvs.Length];
            for (int i = 0; i < srvs.Length; i++) s[i] = srvs[i]?.Srv;
            ctx.CSSetShaderResources(0, s);
        }
        if (uavs is { Length: 1 })
        {
            // 单 UAV 走单数重载：验证过的 spike 就是这么绑的，复数重载在某些组合下行为不同
            ctx.CSSetUnorderedAccessView(0, uavs[0].Uav);
        }
        else if (uavs is { Length: > 1 })
        {
            var u = new ID3D11UnorderedAccessView[uavs.Length];
            var c = new uint[uavs.Length];
            for (int i = 0; i < uavs.Length; i++) { u[i] = uavs[i]?.Uav; c[i] = uint.MaxValue; }
            ctx.CSSetUnorderedAccessViews(0, (uint)u.Length, u, c);
        }

        ctx.Dispatch((uint)Math.Max(1, gx), (uint)Math.Max(1, gy), 1);

        if (srvs is { Length: > 0 }) ctx.CSSetShaderResources(0, new ID3D11ShaderResourceView[srvs.Length]);
        if (uavs is { Length: > 0 })
        {
            // Vortice 不接受 null 数组，必须给"元素为 null 的空数组"
            var n = new ID3D11UnorderedAccessView[uavs.Length];
            var c0 = new uint[uavs.Length];
            ctx.CSSetUnorderedAccessViews(0, (uint)uavs.Length, n, c0);
        }

        DispatchCount++;
        OnDispatch?.Invoke(tag, uavs is { Length: > 0 } ? uavs[0] : null);
    }

    /// <summary>
    /// 跑一帧插值。frameA = 上一帧（其金字塔是上一轮遗留的），frameB = 当前帧。
    /// 注意：本实现每帧都重建金字塔（简化），真实引擎只重建 frameB 的。
    /// </summary>
    public void RunFrame(Img frameA, Img frameB, float t, CbParams? ov = null)
    {
        var p = ov ?? CbParams.Default(t);
        p.Timestamp = t;
        DispatchCount = 0;

        // 2) feature prep 四重奏 —— **两帧各跑一遍**
        //    frameB → featCur（当前帧），frameA → featPrev（上一帧）。
        //    早先只跑一次再"轮换"是错的：第一帧的 featPrev 从未被计算过，
        //    跨帧匹配喂进去的是未初始化纹理，流场因此退化成全局均匀值。
        FeaturePrep(frameA, "featPrev", p);
        FeaturePrep(frameB, "featCur", p);

        if (ConstantFeatures)
        {
            // 两帧特征完全相同 → 任何正确的光流都必须输出 0。
            // 若仍非零，说明它读的不是这里绑的槽（或 cbuffer 里有固定偏置）。
            var grey = new Vortice.Mathematics.Color4(0.5f, 0.5f, 0.5f, 0.5f);
            foreach (var kv in imgs)
                if ((kv.Key.StartsWith("featCur_") || kv.Key.StartsWith("featPrev_")) && kv.Value.Uav != null)
                    ctx.ClearUnorderedAccessView(kv.Value.Uav, grey);
        }

        if (UseCustomFlow)
        {
            BlockMatchFlow(frameA, frameB, p);
            // 合成（复用已验证的 #155）
            int top2 = Levels - 1;
            var ps2 = p;
            ps2.ResolutionInvScale = p.ResolutionInvScale * SynthFlowScale;
            D("155.synth.custom", shaders.Synthesis, ps2,
              new[] { frameA, frameB, Get($"flowFwd_{top2}"), Get($"flowBwd_{top2}"), Get("weightOne") },
              new[] { Get("synthOut") }, G(Width, 16), G(Height, 16));
            return;
        }

        // 3) flow init（#174：12 feature → 2）
        {
            int lv = Levels - 1;
            var pv = Enumerable.Range(0, 4).Select(k => Get($"featPrev_l{lv}_{k}")).ToArray();
            var cv = Enumerable.Range(0, 4).Select(k => Get($"featCur_l{lv}_{k}")).ToArray();
            var tv = Enumerable.Range(0, 4).Select(k => Get($"featTmp_l{lv}_{k}")).ToArray();
            Img[] ins = InitVariant switch
            {
                1 => pv.Concat(cv).Concat(tv).ToArray(),            // prev4 + cur4 + tmp4
                2 => pv.Concat(pv).Concat(cv).ToArray(),            // prev8 + cur4
                3 => cv.Concat(cv).Concat(pv).ToArray(),            // cur8 + prev4
                4 => pv.Concat(tv).Concat(cv).ToArray(),            // prev4 + tmp4 + cur4
                5 => cv.Concat(tv).Concat(cv).ToArray(),            // cur4 + tmp4 + cur4
                6 => tv.Concat(cv).Concat(pv).ToArray(),            // tmp4 + cur4 + prev4
                7 => cv.Concat(pv).Concat(tv).ToArray(),            // cur4 + prev4 + tmp4
                8 => cv.Concat(cv).Concat(tv).ToArray(),            // cur8 + tmp4
                _ => pv.Concat(cv).Concat(cv).ToArray(),            // 原：prev4 + cur4 + cur4
            };
            D("174.init", shaders.FlowInit, p, ins,
              new[] { Get($"initOut_{lv}_0"), Get($"initOut_{lv}_1") }, G(FlowW(lv), 8), G(FlowH(lv), 8));
        }

        // 4) flow refine ping-pong（#177→#175→#171，原地读写）
        {
            int lv = Levels - 1;
            var i0 = Get($"initOut_{lv}_0"); var i1 = Get($"initOut_{lv}_1");
            var rA = new[] { Get($"refA_{lv}_0"), Get($"refA_{lv}_1") };
            var rB = new[] { Get($"refB_{lv}_0"), Get($"refB_{lv}_1") };
            D("177.pp", shaders.RefineA, p, new[] { i0, i1 }, rA, G(FlowW(lv), 8), G(FlowH(lv), 8));
            D("175.pp", shaders.RefineB, p, rA, rB, G(FlowW(lv), 8), G(FlowH(lv), 8));
            D("171.pp", shaders.RefineC, p, rB, rA, G(FlowW(lv), 8), G(FlowH(lv), 8));
        }

        // 5) 光流金字塔（#178：2 → 6 级）
        {
            int lv = Levels - 1;
            D("178.fpyr", shaders.FlowPyramid, p,
              new[] { Get($"refA_{lv}_0"), Get($"refA_{lv}_1") },
              Enumerable.Range(0, 6).Select(i => Get($"flowpyr{i}")).ToArray(),
              G(FlowW(lv), 32), G(FlowH(lv), 32));
        }

        // 6) 粗到细光流：7 级 × 三条链
        for (int k = 0; k < Levels; k++)
        {
            int w = FlowW(k), h = FlowH(k);
            Img fp = Get($"flowpyr{Math.Min(5, Math.Max(0, Levels - 1 - k))}");
            if (FlowpyrOverride.HasValue)
            {
                var c = Get("fpyrConst");
                if (Math.Abs(cachedFpyrValue - FlowpyrOverride.Value) > 1e-6f)
                {
                    var buf = new byte[c.W * c.H];
                    byte v = (byte)Math.Clamp((int)(FlowpyrOverride.Value * 255), 0, 255);
                    for (int i = 0; i < buf.Length; i++) buf[i] = v;
                    var h2 = GCHandle.Alloc(buf, GCHandleType.Pinned);
                    try
                    {
                        var sd = new SubresourceData(h2.AddrOfPinnedObject(), (uint)c.W, (uint)(c.W * c.H));
                        var tex2 = device.CreateTexture2D(new Texture2DDescription
                        {
                            Width = (uint)c.W, Height = (uint)c.H, MipLevels = 1, ArraySize = 1,
                            Format = Format.R8_UNorm, SampleDescription = new SampleDescription(1, 0),
                            Usage = ResourceUsage.Default, BindFlags = BindFlags.ShaderResource,
                            CPUAccessFlags = CpuAccessFlags.None, MiscFlags = ResourceOptionFlags.None,
                        }, new[] { sd });
                        c.Tex.Dispose(); c.Srv.Dispose();
                        c.Tex = tex2; c.Srv = device.CreateShaderResourceView(tex2);
                    }
                    finally { h2.Free(); }
                    cachedFpyrValue = FlowpyrOverride.Value;
                }
                fp = c;
            }
            Img CoarsePick(string ch) => Coarse switch
            {
                CoarseSource.Zero => Get("zeroFlow"),
                CoarseSource.CurFeat0 => Get($"featCur_l{k}_{ch}"),
                CoarseSource.PrevFeat0 => Get($"featPrev_l{k}_{ch}"),
                _ => k > 0 ? Get($"flow{(ch == "0" ? "Fwd" : "Bwd")}_{k - 1}") : Get("initFlow8"),
            };
            var coarserFwd = CoarsePick("0");
            var coarserBwd = CoarsePick("1");

            Img[] N(string prefix, int n) => Enumerable.Range(0, n).Select(j => Get($"{prefix}_{j}")).ToArray();
            var f3 = N($"fwd3_{k}", 3);
            var fA = N($"fwdA_{k}", 4);
            var fB = N($"fwdB_{k}", 4);
            var b2 = N($"bwd2_{k}", 2);
            var bA = N($"bwdA_{k}", 4);
            var bB = N($"bwdB_{k}", 4);
            var l2 = N($"bl2_{k}", 2);
            var lA = N($"blA_{k}", 2);
            var lB = N($"blB_{k}", 2);
            var fwd = Get($"flowFwd_{k}");
            var bwd = Get($"flowBwd_{k}");
            var blend = Get($"flowBlend_{k}");

            var curFeat = Enumerable.Range(0, 4).Select(j => Get($"featCur_l{k}_{j}")).ToArray();
            var prevFeat = Enumerable.Range(0, 4).Select(j => Get($"featPrev_l{k}_{j}")).ToArray();

            // FirstIter：每级第一刀 = 1（首轮），后续 = 0（续算，用上一级流场做初值）
            var pc = p;
            pc.FirstIter = (uint)(k == 0 ? 1 : 0);
            pc.FirstIterS = (uint)(k == 0 ? 1 : 0);

            // —— 正向链：156(9→3) → 162(3→4=A) → 160(4A→4B) → 164(4B→4A) → 165(4A→流场) ——
            var feat9 = FeatCurFirst
                ? curFeat.Concat(prevFeat).ToArray()
                : prevFeat.Concat(curFeat).ToArray();
            D($"156.f{k}", shaders.FlowMid, pc,
              feat9.Append(coarserFwd).ToArray(), f3, G(w, 8), G(h, 8));
            D($"162.f{k}", shaders.FlowRefine3to4, pc, f3, fA, G(w, 8), G(h, 8));
            D($"160.f{k}", shaders.FlowPing, pc, fA, fB, G(w, 8), G(h, 8));
            D($"164.f{k}", shaders.FlowPing2, pc, fB, fA, G(w, 8), G(h, 8));
            D($"165.f{k}", shaders.FlowField, pc,
              fA.Append(Get("zeroFlow")).Append(fp).ToArray(), new[] { fwd }, G(w, 8), G(h, 8));

            // —— 反向链：157(10→2) → 158(2→A) → 163(A→B) → 159(B→A) → 161(A→流场) ——
            D($"157.b{k}", shaders.FlowFine, pc,
              feat9.Append(coarserBwd).Append(Get("initFlow8")).ToArray(),
              b2, G(w, 8), G(h, 8));
            D($"158.b{k}", shaders.FlowPing, pc,
              b2.Concat(b2).ToArray(), bA, G(w, 8), G(h, 8));
            D($"163.b{k}", shaders.FlowPing2, pc, bA, bB, G(w, 8), G(h, 8));
            D($"159.b{k}", shaders.FlowPing, pc, bB, bA, G(w, 8), G(h, 8));
            D($"161.b{k}", shaders.FlowField2, pc,
              bA.Append(Get("zeroFlow")).Append(fp).ToArray(), new[] { bwd }, G(w, 8), G(h, 8));

            // —— blend 链：176(2→2) → 172(2→2=LA) → 170(2LA→2LB) → 173(2LB→blend) ——
            D($"176.x{k}", shaders.BlendA, pc, new[] { curFeat[0], curFeat[1] }, l2, G(w, 8), G(h, 8));
            D($"172.x{k}", shaders.BlendB, pc, l2, lA, G(w, 8), G(h, 8));
            D($"170.x{k}", shaders.BlendC, pc, lA, lB, G(w, 8), G(h, 8));
            D($"173.x{k}", shaders.BlendFinal, pc,
              lB.Append(Get("zeroFlow")).Append(k > 0 ? Get($"flowBlend_{k - 1}") : Get("zeroFlow")).ToArray(),
              new[] { blend }, G(w, 8), G(h, 8));

        }

        // 7) 合成（#155：2 帧 + 3 张最细流场）
        {
            int top = Levels - 1;
            var ps = p;
            ps.ResolutionInvScale = p.ResolutionInvScale * SynthFlowScale;
            Img flowA = Get($"flowFwd_{top}"), flowB = Get($"flowBwd_{top}");
            if (NegateFlow)
            {
                NegateInto(flowA, Get("flowFwdNeg"));
                NegateInto(flowB, Get("flowBwdNeg"));
                flowA = Get("flowFwdNeg"); flowB = Get("flowBwdNeg");
            }
            D("155.synth", shaders.Synthesis, ps,
              new[]
              {
                  frameA, frameB,
                  ForceZeroFlow ? Get("zeroFlow") : (SwapFlow ? flowB : flowA),
                  ForceZeroFlow ? Get("zeroFlow") : (SwapFlow ? flowA : flowB),
                  UseFlatWeight ? Get("weightOne") : Get($"flowBlend_{top}")
              },
              new[] { Get("synthOut") }, G(Width, 16), G(Height, 16));
        }
    }

    /// <summary>对一帧做完整的 7 级 feature prep 四重奏（4 shader × 7 级）。</summary>
    void FeaturePrep(Img frame, string prefix, CbParams p)
    {
        // 先把该帧降到 7 级
        D($"154.pyr.{prefix}", shaders.Pyramid, p, new[] { frame },
          Enumerable.Range(0, Levels).Select(i => Get($"pyr{i}")).ToArray(),
          G(Width, 32), G(Height, 32));

        for (int lv = 0; lv < Levels; lv++)
        {
            int pi = Levels - 1 - lv;
            int w  = Math.Max(2, PyrW(pi) / 2), h  = Math.Max(2, PyrH(pi) / 2);
            int w2 = Math.Max(2, PyrW(pi) / 4), h2 = Math.Max(2, PyrH(pi) / 4);
            var src = Get($"pyr{pi}");

            // 四段必须各自独立的缓冲，否则尺寸不匹配的写入只会写左上角（实测：feature 变成彩色噪点）
            var a0 = Get($"{prefix}_l{lv}_0"); var a1 = Get($"{prefix}_l{lv}_1");
            var a2 = Get($"{prefix}_l{lv}_2"); var a3 = Get($"{prefix}_l{lv}_3");
            var m0 = Get($"featMid_l{lv}_0"); var m1 = Get($"featMid_l{lv}_1");
            var m2 = Get($"featMid_l{lv}_2"); var m3 = Get($"featMid_l{lv}_3");
            var t0 = Get($"featTmp_l{lv}_0"); var t1 = Get($"featTmp_l{lv}_1");
            var t2 = Get($"featTmp_l{lv}_2"); var t3 = Get($"featTmp_l{lv}_3");

            D($"166.l{lv}.{prefix}", shaders.FeatureDown, p, new[] { src }, new[] { m0, m1 }, G(w, 8), G(h, 8));
            D($"167.l{lv}.{prefix}", shaders.FeatA, p, new[] { m0, m1 }, new[] { m2, m3 }, G(w, 8), G(h, 8));
            D($"168.l{lv}.{prefix}", shaders.FeatB, p, new[] { m2, m3 }, new[] { t0, t1, t2, t3 }, G(w2, 8), G(h2, 8));
            D($"169.l{lv}.{prefix}", shaders.FeatC, p, new[] { t0, t1, t2, t3 }, new[] { a0, a1, a2, a3 }, G(w2, 8), G(h2, 8));
        }
    }

    /// <summary>自写块匹配光流：只跑一次 dispatch，双向 SAD 搜索。</summary>
    void BlockMatchFlow(Img frameA, Img frameB, CbParams p)
    {
        int top = Levels - 1;
        var flow = Get($"flowFwd_{top}");
        var flowB = Get($"flowBwd_{top}");
        var buf = new byte[16];
        BitConverter.GetBytes((float)flow.W).CopyTo(buf, 0);
        BitConverter.GetBytes((float)flow.H).CopyTo(buf, 4);
        BitConverter.GetBytes((float)SearchRadius).CopyTo(buf, 8);
        BitConverter.GetBytes((float)Width / flow.W).CopyTo(buf, 12);   // 全分辨率/流场 比例
        ctx.UpdateSubresource(buf, bmCb);

        ctx.CSSetShader(blockMatchCs);
        ctx.CSSetConstantBuffer(0, bmCb);
        ctx.CSSetSampler(0, sampLinear);
        ctx.CSSetShaderResources(0, new[] { frameA.Srv, frameB.Srv });
        ctx.CSSetUnorderedAccessView(0, flow.Uav);
        ctx.Dispatch((uint)((flow.W + 7) / 8), (uint)((flow.H + 7) / 8), 1);
        ctx.CSSetUnorderedAccessView(0, null as ID3D11UnorderedAccessView);
        ctx.CSSetShaderResources(0, new ID3D11ShaderResourceView[2]);

        // 反向链也用同一份（synthesis 的 t3），先复制
        ctx.CopyResource(flowB.Tex, flow.Tex);
        _ = p;
    }

    /// <summary>dst = -src（同尺寸 RGBA16F）。</summary>
    void NegateInto(Img src, Img dst)
    {
        var kb = new byte[16];
        BitConverter.GetBytes(FlowGain).CopyTo(kb, 0);
        ctx.UpdateSubresource(kb, scaleCb);
        ctx.CSSetShader(negateCs);
        ctx.CSSetConstantBuffer(0, scaleCb);
        ctx.CSSetShaderResource(0, src.Srv);
        ctx.CSSetUnorderedAccessView(0, dst.Uav);
        ctx.Dispatch((uint)((src.W + 7) / 8), (uint)((src.H + 7) / 8), 1);
        ctx.CSSetUnorderedAccessView(0, null as ID3D11UnorderedAccessView);
        ctx.CSSetShaderResource(0, null as ID3D11ShaderResourceView);
    }

    /// <summary>只跑合成一步（隔离诊断：判断 synthesis 是否被前面的 dispatch 污染）。</summary>
    public void RunSynthesisOnly(Img frameA, Img frameB, float t)
    {
        // 全槽位清空：D3D11 允许"部分槽位残留"，读到的会是旧绑定或空视图而不报错。
        ctx.CSSetShaderResources(0, new ID3D11ShaderResourceView[16]);
        ctx.CSSetUnorderedAccessViews(0, 8, new ID3D11UnorderedAccessView[8], new uint[8]);
        ctx.CSSetConstantBuffers(0, new ID3D11Buffer[2]);
        ctx.CSSetShader(null);

        var p = CbParams.Default(t);
        UploadCb(p);
        ctx.CSSetShader(shaders.Synthesis);
        ctx.CSSetConstantBuffer(0, cb);
        ctx.CSSetSampler(0, sampLinear);
        ctx.CSSetSampler(1, sampLinear);
        // 逐个槽位绑定（数组重载疑似把槽位搞错，先隔离验证）
        ctx.CSSetShaderResource(0, frameA.Srv);
        ctx.CSSetShaderResource(1, frameB.Srv);
        ctx.CSSetShaderResource(2, Get("zeroFlow").Srv);
        ctx.CSSetShaderResource(3, Get("zeroFlow").Srv);
        ctx.CSSetShaderResource(4, Get("weightOne").Srv);
        ctx.CSSetUnorderedAccessView(0, Get("synthOut").Uav);
        ctx.Dispatch((uint)((Width + 15) / 16), (uint)((Height + 15) / 16), 1);
        ctx.CSSetUnorderedAccessView(0, null as ID3D11UnorderedAccessView);
    }

    public Img Output => Get("synthOut");


    /// <summary>按名字取中间产物（A2 调参/出图用）。</summary>
    public Img Find(string name) => imgs.TryGetValue(name, out var i) ? i : null;

    /// <summary>当前所有中间产物的名字（调试用）。</summary>
    public IEnumerable<string> Names => imgs.Keys;

    public void Dispose()
    {
        foreach (var i in imgs.Values) i.Dispose();
        cb?.Dispose(); sampLinear?.Dispose(); sampPoint?.Dispose();
        shaders.Dispose();
    }
}

/// <summary>按 DAG 角色加载 23 个 pass（不是全部 202 个）。</summary>
public sealed class ShaderBank : IDisposable
{
    readonly List<ID3D11ComputeShader> all = new();
    readonly ID3D11Device device;
    readonly string dir;

    public ID3D11ComputeShader Pyramid, FlowInit, FlowMid, FlowFine, FeatureDown;
    public ID3D11ComputeShader FeatA, FeatB, FeatC, FlowRefine3to4, FlowPyramid;
    public ID3D11ComputeShader FlowPing, FlowPing2, FlowField, FlowField2;
    public ID3D11ComputeShader RefineA, RefineB, RefineC;
    public ID3D11ComputeShader BlendA, BlendB, BlendC, BlendFinal, Synthesis;

    public ShaderBank(ID3D11Device device, string shaderDir)
    {
        this.device = device;
        dir = shaderDir ?? DefaultShaderDir();
        Pyramid = L("154");
        FlowInit = L("174");
        FlowMid = L("156");
        FlowFine = L("157");
        FeatureDown = L("166");
        FeatA = L("167");
        FeatB = L("168");
        FeatC = L("169");
        FlowRefine3to4 = L("158");
        FlowPyramid = L("178");
        FlowPing = L("160");
        FlowPing2 = L("164");
        FlowField = L("165");
        FlowField2 = L("161");
        RefineA = L("177");
        RefineB = L("175");
        RefineC = L("171");
        BlendA = L("176");
        BlendB = L("172");
        BlendC = L("170");
        BlendFinal = L("173");
        Synthesis = L("155");
    }

    ID3D11ComputeShader L(string idx)
    {
        var f = Directory.GetFiles(dir, $"*_{idx}_*.dxbc").FirstOrDefault()
                ?? throw new FileNotFoundException($"shader #{idx} 不在 {dir}");
        var cs = device.CreateComputeShader(File.ReadAllBytes(f).AsSpan(), null);
        all.Add(cs);
        return cs;
    }

    static string DefaultShaderDir()
    {
        var d = AppContext.BaseDirectory;
        for (int i = 0; i < 6 && d != null; i++)
        {
            var cand = Path.Combine(d, "shaders");
            if (Directory.Exists(cand) && Directory.GetFiles(cand, "*.dxbc").Length > 100) return cand;
            d = Path.GetDirectoryName(d);
        }
        throw new DirectoryNotFoundException("找不到 shaders/ 目录");
    }

    public void Dispose() { foreach (var s in all) s.Dispose(); }
}
