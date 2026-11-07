// LsfgPipeline —— 实时补帧管线骨架（A2 的实现底座）。
//
// 这里只做「结构」，不含调参：纹理池、尺寸递推、pass 调度顺序、cbuffer 打包。
// 任何依赖实验才能定的量（迭代轮数、每级是否跑 #166、t4 从哪张图取）都抽成 Options，
// 便于 A2 阶段用一次运行扫一组候选，而不是改代码重编译。
//
// 已确定的语义（来自 A1 的静态逆向 + M2 的两个验证）：
//   * 流场单位 = 像素；xy 喂 frameA（-d/2）、zw 喂 frameB（+d/2）
//   * pyramid：输入 → 7 级，尺寸逐级减半（第 i 级 = w>>(i+1)）
//   * #166：读「分辨率 ×2」的那一级（UV = (tid*2+0.5)/srcW），输出 2×float4 = 双向流场
//   * #173：FirstIter=1 时只用 9 邻域拟合；=0 时把自己上一轮输出加回来（增量迭代）
//   * #155：2 帧 + 3 张流场/权重，Timestamp ∈ (0,1) 决定插值位置
using Vortice.Direct3D;
using Vortice.Direct3D11;
using Vortice.DXGI;
using static Vortice.Direct3D11.D3D11;

namespace LsfgPipeline;

/// <summary>一张中间纹理的描述（尺寸 + 格式 + 用途），用于纹理池去重。</summary>
public readonly record struct TexKey(int W, int H, Format Fmt, TexUse Use);

public enum TexUse
{
    /// <summary>金字塔 mip（单通道 R8）。</summary>
    Pyramid,
    /// <summary>流场（双向，float4：xy 正向、zw 反向）。</summary>
    Flow,
    /// <summary>权重/遮挡（4 个方向的置信度）。</summary>
    Weight,
    /// <summary>呈现输出（RGB，进 swapchain）。</summary>
    Output,
}

public sealed class PipelineOptions
{
    /// <summary>流场/细化在什么分辨率上算（相对输出尺寸的倒数）。官方 FlowScale 也是这个意思。</summary>
    public int FlowScalePercent { get; set; } = 100;

    /// <summary>#173 迭代轮数。A1 里已确认 shader 只认 FirstIter 开关，轮数由宿主决定。</summary>
    public int RefineIterations { get; set; } = 2;

    /// <summary>是否启用 UI 掩码（#178）。关闭时 syncthesis 的 t4 用全 1 权重。</summary>
    public bool UseUiMask { get; set; } = true;

    /// <summary>金字塔级数（#154 固定输出 7 级）。</summary>
    public int PyramidLevels { get; set; } = 7;
}

/// <summary>
/// 补帧管线。生命周期：构造（建纹理池 + 编译 shader）→ 每帧 RunFrame → Dispose。
/// 纹理池按 (w,h,format,use) 去重，避免每帧重建。
/// </summary>
public sealed class LsfgPipeline : IDisposable
{
    readonly ID3D11Device device;
    readonly ID3D11DeviceContext ctx;
    readonly PipelineOptions opt;
    readonly ShaderSet shaders;

    readonly Dictionary<TexKey, ID3D11Texture2D> pool = new();
    readonly Dictionary<TexKey, ID3D11UnorderedAccessView> uavs = new();
    readonly Dictionary<TexKey, ID3D11ShaderResourceView> srvs = new();

    ID3D11Buffer cbuffer;
    ID3D11SamplerState samplerLinear;
    ID3D11SamplerState samplerPoint;

    public int Width { get; }
    public int Height { get; }

    /// <summary>每个 pass 的 dump 回调（A2 调参时用来导出中间结果）。</summary>
    public Action<string, ID3D11Texture2D> OnPassOutput { get; set; }

    public LsfgPipeline(ID3D11Device device, ID3D11DeviceContext ctx, int width, int height,
                        PipelineOptions options = null, string shaderDir = null)
    {
        this.device = device;
        this.ctx = ctx;
        opt = options ?? new PipelineOptions();
        Width = width; Height = height;
        shaders = new ShaderSet(device, shaderDir);

        cbuffer = device.CreateBuffer(new BufferDescription(32, BindFlags.ConstantBuffer,
            ResourceUsage.Default, CpuAccessFlags.None, ResourceOptionFlags.None, 0));

        samplerLinear = device.CreateSamplerState(new SamplerDescription
        {
            Filter = Filter.MinMagMipLinear,
            AddressU = TextureAddressMode.Clamp, AddressV = TextureAddressMode.Clamp, AddressW = TextureAddressMode.Clamp,
            ComparisonFunc = ComparisonFunction.Never, MaxLOD = float.MaxValue,
        });
        samplerPoint = device.CreateSamplerState(new SamplerDescription
        {
            Filter = Filter.MinMagMipPoint,
            AddressU = TextureAddressMode.Clamp, AddressV = TextureAddressMode.Clamp, AddressW = TextureAddressMode.Clamp,
            ComparisonFunc = ComparisonFunction.Never, MaxLOD = float.MaxValue,
        });

        BuildPool();
    }

    /// <summary>按尺寸递推建好所有中间纹理。这里是 A2 要验证的重点：每级的实际尺寸。</summary>
    void BuildPool()
    {
        // 金字塔：第 i 级 = (w>>(i+1), h>>(i+1))，格式 R8_UNORM（#154 的 UAV 是 float 单通道）
        for (int i = 0; i < opt.PyramidLevels; i++)
            GetOrCreate(new TexKey(Math.Max(1, Width >> (i + 1)), Math.Max(1, Height >> (i + 1)),
                                   Format.R8_UNorm, TexUse.Pyramid));

        // 流场分辨率：官方 FlowScale 就是把它降下来省算力
        float s = Math.Clamp(opt.FlowScalePercent, 25, 100) / 100f;
        int fw = Math.Max(8, (int)(Width * s)), fh = Math.Max(8, (int)(Height * s));
        GetOrCreate(new TexKey(fw, fh, Format.R16G16B16A16_Float, TexUse.Flow));   // #166 输出 2×float4 合一
        GetOrCreate(new TexKey(fw, fh, Format.R16G16B16A16_Float, TexUse.Weight)); // t4
        GetOrCreate(new TexKey(Width, Height, Format.R8G8B8A8_UNorm, TexUse.Output));
    }

    ID3D11Texture2D GetOrCreate(TexKey key)
    {
        if (pool.TryGetValue(key, out var t)) return t;
        var bind = key.Use == TexUse.Output
            ? BindFlags.RenderTarget | BindFlags.ShaderResource
            : BindFlags.UnorderedAccess | BindFlags.ShaderResource;
        t = device.CreateTexture2D(new Texture2DDescription
        {
            Width = (uint)key.W, Height = (uint)key.H, MipLevels = 1, ArraySize = 1,
            Format = key.Fmt, SampleDescription = new SampleDescription(1, 0),
            Usage = ResourceUsage.Default, BindFlags = bind,
            CPUAccessFlags = CpuAccessFlags.None, MiscFlags = ResourceOptionFlags.None,
        });
        pool[key] = t;
        if ((bind & BindFlags.UnorderedAccess) != 0) uavs[key] = device.CreateUnorderedAccessView(t);
        srvs[key] = device.CreateShaderResourceView(t);
        return t;
    }

    void SetCb(uint inputOffsetX, uint inputOffsetY, uint firstIter, uint firstIterS,
               float resInvScale, float timestamp, float uiThreshold = 0.5f)
    {
        var d = new byte[32];
        BitConverter.GetBytes(inputOffsetX).CopyTo(d, 0);
        BitConverter.GetBytes(inputOffsetY).CopyTo(d, 4);
        BitConverter.GetBytes(firstIter).CopyTo(d, 8);
        BitConverter.GetBytes(firstIterS).CopyTo(d, 12);
        BitConverter.GetBytes(0u).CopyTo(d, 16);              // AdvancedColorKind = SDR
        BitConverter.GetBytes(0u).CopyTo(d, 20);              // HdrSupport = 0
        BitConverter.GetBytes(resInvScale).CopyTo(d, 24);
        BitConverter.GetBytes(timestamp).CopyTo(d, 28);
        // 注：UiThreshold(#178) 在 +32，官方声明 32B cbuffer；若变体真读到 +32 需要扩容到 48B
        ctx.UpdateSubresource(d, cbuffer);
    }

    /// <summary>
    /// 跑一帧：把 frameA/frameB 之间的插值帧写到 outTex。t∈(0,1)。
    /// 顺序来自 A1 的 DAG 判定；标了 [A2] 的地方是还需要实测确认的。
    /// </summary>
    public void RunFrame(ID3D11ShaderResourceView frameA, ID3D11ShaderResourceView frameB,
                         float t, ID3D11RenderTargetView outputRtv = null)
    {
        uint gw = (uint)Math.Max(1, (Width + 15) / 16);
        uint gh = (uint)Math.Max(1, (Height + 15) / 16);

        // 1) 金字塔（frameB → 7 级 mip）
        {
            SetCb(0, 0, 1, 1, 1f, t);
            var levelKeys = Enumerable.Range(0, opt.PyramidLevels)
                .Select(i => new TexKey(Math.Max(1, Width >> (i + 1)), Math.Max(1, Height >> (i + 1)),
                                        Format.R8_UNorm, TexUse.Pyramid)).ToArray();
            ctx.CSSetShader(shaders.Pyramid);
            ctx.CSSetConstantBuffer(0, cbuffer);
            ctx.CSSetSampler(0, samplerLinear);
            ctx.CSSetShaderResource(0, frameB);
            var u = levelKeys.Select(k => uavs[k]).ToArray();
            ctx.CSSetUnorderedAccessViews(0, (uint)u.Length, u, new uint[u.Length]);
            ctx.Dispatch((uint)((Width + 31) / 32), (uint)((Height + 31) / 32), 1);
            ctx.CSSetUnorderedAccessViews(0, (uint)u.Length, null, null);
            OnPassOutput?.Invoke("154-pyramid0", pool[levelKeys[0]]);
        }

        // 2) 代价 → 流场（#166，逐级）
        //    [A2] 具体读哪一级、是否需要每级都跑一次，需要实测
        {
            SetCb(0, 0, 1, 1, 1f, t);
            var src = new TexKey(Math.Max(1, Width >> 1), Math.Max(1, Height >> 1), Format.R8_UNorm, TexUse.Pyramid);
            var flowKey = new TexKey(Math.Max(8, (int)(Width * opt.FlowScalePercent / 100f)),
                                     Math.Max(8, (int)(Height * opt.FlowScalePercent / 100f)),
                                     Format.R16G16B16A16_Float, TexUse.Flow);
            ctx.CSSetShader(shaders.Flow166);
            ctx.CSSetConstantBuffer(0, cbuffer);
            ctx.CSSetSampler(0, samplerLinear);
            ctx.CSSetShaderResource(0, srvs[src]);
            ctx.CSSetUnorderedAccessView(0, uavs[flowKey]);   // [A2] 166 有 2 个 UAV，这里只绑第一个
            ctx.Dispatch((uint)((flowKey.W + 7) / 8), (uint)((flowKey.H + 7) / 8), 1);
            ctx.CSSetUnorderedAccessView(0, null);
            OnPassOutput?.Invoke("166-flow", pool[flowKey]);
        }

        // 3) 迭代细化（#173，FirstIter=1 首轮，之后 FirstIter=0 且把自己上一轮加回来）
        //    [A2] 轮数由 opt.RefineIterations 控制；每轮需要双缓冲（这里先单缓冲占位）
        {
            var flowKey = new TexKey(Math.Max(8, (int)(Width * opt.FlowScalePercent / 100f)),
                                     Math.Max(8, (int)(Height * opt.FlowScalePercent / 100f)),
                                     Format.R16G16B16A16_Float, TexUse.Flow);
            for (int it = 0; it < Math.Max(1, opt.RefineIterations); it++)
            {
                SetCb(0, 0, it == 0 ? 1u : 0u, it == 0 ? 1u : 0u, 1f, t);
                ctx.CSSetShader(shaders.Refine173);
                ctx.CSSetConstantBuffer(0, cbuffer);
                ctx.CSSetSampler(0, samplerLinear);
                ctx.CSSetSampler(1, samplerPoint);
                ctx.CSSetShaderResources(0, new[] { srvs[flowKey], srvs[flowKey], srvs[flowKey] });
                ctx.CSSetUnorderedAccessView(0, uavs[flowKey]);
                ctx.Dispatch((uint)((flowKey.W + 7) / 8), (uint)((flowKey.H + 7) / 8), 1);
                ctx.CSSetUnorderedAccessView(0, null);
                ctx.CSSetShaderResources(0, new ID3D11ShaderResourceView[3]);
            }
            OnPassOutput?.Invoke("173-refined", pool[flowKey]);
        }

        // 4) 合成（#155：2 帧 + 3 张流场/权重，Timestamp 就在这里生效）
        {
            SetCb(0, 0, 1, 1, 1f, t);
            var flowKey = new TexKey(Math.Max(8, (int)(Width * opt.FlowScalePercent / 100f)),
                                     Math.Max(8, (int)(Height * opt.FlowScalePercent / 100f)),
                                     Format.R16G16B16A16_Float, TexUse.Flow);
            var weightKey = new TexKey(flowKey.W, flowKey.H, Format.R16G16B16A16_Float, TexUse.Weight);
            var outKey = new TexKey(Width, Height, Format.R8G8B8A8_UNorm, TexUse.Output);
            ctx.CSSetShader(shaders.Synthesis155);
            ctx.CSSetConstantBuffer(0, cbuffer);
            ctx.CSSetSampler(0, samplerLinear);
            ctx.CSSetSampler(1, samplerLinear);
            ctx.CSSetShaderResources(0, new[] { frameA, frameB, srvs[flowKey], srvs[flowKey], srvs[weightKey] });
            ctx.CSSetUnorderedAccessView(0, uavs[outKey]);
            ctx.Dispatch(gw, gh, 1);
            ctx.CSSetUnorderedAccessView(0, null);
            ctx.CSSetShaderResources(0, new ID3D11ShaderResourceView[5]);
            OnPassOutput?.Invoke("155-synthesis", pool[outKey]);
        }
    }

    public ID3D11Texture2D OutputTexture =>
        pool[new TexKey(Width, Height, Format.R8G8B8A8_UNorm, TexUse.Output)];

    public void Dispose()
    {
        foreach (var v in uavs.Values) v.Dispose();
        foreach (var v in srvs.Values) v.Dispose();
        foreach (var v in pool.Values) v.Dispose();
        cbuffer?.Dispose();
        samplerLinear?.Dispose();
        samplerPoint?.Dispose();
        shaders.Dispose();
    }
}

/// <summary>按 A1 的判定，只加载真正要用的那几个 pass（而不是全部 202 个）。</summary>
public sealed class ShaderSet : IDisposable
{
    public ID3D11ComputeShader Pyramid { get; }      // #154
    public ID3D11ComputeShader Flow166 { get; }      // #166（代价→双向流场）
    public ID3D11ComputeShader Refine173 { get; }    // #173（迭代细化）
    public ID3D11ComputeShader Synthesis155 { get; } // #155（合成）

    readonly List<ID3D11ComputeShader> all = new();

    public ShaderSet(ID3D11Device device, string dir)
    {
        dir ??= DefaultShaderDir();
        Pyramid = Load(device, dir, "154");
        Flow166 = Load(device, dir, "166");
        Refine173 = Load(device, dir, "173");
        Synthesis155 = Load(device, dir, "155");
    }

    ID3D11ComputeShader Load(ID3D11Device device, string dir, string idx)
    {
        var f = Directory.GetFiles(dir, $"*_{idx}_*.dxbc").FirstOrDefault()
                ?? throw new FileNotFoundException($"shader #{idx} not found in {dir}");
        var bytes = File.ReadAllBytes(f);
        var cs = device.CreateComputeShader(bytes.AsSpan(), null);
        all.Add(cs);
        return cs;
    }

    static string DefaultShaderDir()
    {
        // 相对当前程序目录向上找 shaders/（开发时）或同级 shaders/（发布时）
        var d = AppContext.BaseDirectory;
        for (int i = 0; i < 6 && d != null; i++)
        {
            var cand = Path.Combine(d, "shaders");
            if (Directory.Exists(cand) && Directory.GetFiles(cand, "*.dxbc").Length > 100) return cand;
            d = Path.GetDirectoryName(d);
        }
        throw new DirectoryNotFoundException("shaders/ 目录没找到（需要 lsfg_research/shaders）");
    }

    public void Dispose() { foreach (var s in all) s.Dispose(); }
}
