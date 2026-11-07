// PlayerBar.cs —— 播放器控制条（WinForms 自绘）。
//
// 为什么自绘而不是用现成控件：TrackBar / Button 的默认外观和播放页的晶体材质
// 差得太远（灰色方块 + 系统蓝），而控制条是用户每集都要看的东西。这里用
// `crystal.css` 的同一组配色手绘：深底、18% 白边框、蓝色主色、圆角胶囊按钮。
//
// 布局（贴底，与前端 HUD 的排布顺序一致）：
//   ▶/⏸  ──进度轨──  时间  1.0x  音量  补帧 2X/3X/4X/5X  ⏮ ⏭ ✕
using System.Drawing.Drawing2D;

namespace NativePlayer;

internal sealed class PlayerBar : Panel
{
    // 配色取自 src/styles/crystal.css（--crystal-scrim-deep / --crystal-border）
    static readonly Color Bg = Color.FromArgb(22, 22, 28);
    static readonly Color Surface = Color.FromArgb(44, 44, 54);
    static readonly Color SurfaceHover = Color.FromArgb(58, 58, 70);
    static readonly Color Border = Color.FromArgb(46, 255, 255, 255);   // 18% 白
    static readonly Color Accent = Color.FromArgb(91, 124, 250);        // 蓝紫主色
    static readonly Color TextMain = Color.FromArgb(222, 222, 232);
    static readonly Color TextDim = Color.FromArgb(138, 138, 152);
    static readonly Font FUi = new("Microsoft YaHei UI", 9f);
    static readonly Font FTime = new("Consolas", 9.5f);

    public event Action? OnTogglePlay;
    public event Action<double>? OnSeek;          // 秒
    public event Action<double>? OnVolume;        // 0..1
    public event Action<double>? OnSpeed;         // 倍率
    public event Action<bool, int>? OnFg;         // 开关, 倍率
    public event Action? OnPrev;
    public event Action? OnNext;
    public event Action? OnClose;
    public event Action? OnFullscreen;

    readonly PillButton btnPlay, btnPrev, btnNext, btnClose, btnFs, btnFg;
    readonly PillButton[] fgMultBtns = new PillButton[4];
    readonly SpeedCombo cmbSpeed;
    readonly SeekTrack track;
    readonly Volume trackVol;
    readonly Label lblTime, lblTitle;

    bool playing;
    bool fgOn;
    int fgMult = 2;

    public PlayerBar()
    {
        BackColor = Bg;
        DoubleBuffered = true;
        Padding = new Padding(10, 0, 10, 0);

        btnPlay = new PillButton("▶", 36) { Tip = "播放/暂停 (空格)" };
        btnPlay.Click += (_, _) => OnTogglePlay?.Invoke();

        track = new SeekTrack();
        track.SeekRequested += (s) => OnSeek?.Invoke(s);

        lblTime = new Label
        {
            AutoSize = false, Text = "00:00 / 00:00", ForeColor = TextDim,
            Font = FTime, TextAlign = ContentAlignment.MiddleCenter,
        };
        lblTitle = new Label
        {
            AutoSize = false, Text = "", ForeColor = TextDim, Font = FUi,
            TextAlign = ContentAlignment.MiddleLeft, AutoEllipsis = true,
        };

        cmbSpeed = new SpeedCombo();
        cmbSpeed.SpeedChanged += (r) => OnSpeed?.Invoke(r);

        trackVol = new Volume();
        trackVol.VolumeChanged += (v) => OnVolume?.Invoke(v);

        btnFg = new PillButton("补帧 关", 74) { Tip = "补帧开关 (B)" };
        btnFg.Click += (_, _) => { SetFg(!fgOn, fgMult); };
        for (int i = 0; i < 4; i++)
        {
            int m = i + 2;
            fgMultBtns[i] = new PillButton($"{m}X", 30) { Tip = $"补帧 {m} 倍 (按 {m})" };
            fgMultBtns[i].Click += (_, _) => { SetFg(true, m); };
        }

        btnPrev = new PillButton("⏮", 34) { Tip = "上一集 ([" };
        btnPrev.Click += (_, _) => OnPrev?.Invoke();
        btnNext = new PillButton("⏭", 34) { Tip = "下一集 (]" };
        btnNext.Click += (_, _) => OnNext?.Invoke();
        btnFs = new PillButton("⛶", 34) { Tip = "全屏 (F)" };
        btnFs.Click += (_, _) => OnFullscreen?.Invoke();
        btnClose = new PillButton("✕", 34) { Tip = "关闭 (Esc)" };
        btnClose.Click += (_, _) => OnClose?.Invoke();

        Controls.AddRange(new Control[]
        {
            btnPlay, track, lblTime, lblTitle, cmbSpeed, trackVol, btnFg,
            fgMultBtns[0], fgMultBtns[1], fgMultBtns[2], fgMultBtns[3],
            btnPrev, btnNext, btnFs, btnClose,
        });
        RefreshFg();
    }

    public void SetPlaying(bool v) { playing = v; btnPlay.Text = v ? "⏸" : "▶"; btnPlay.Invalidate(); }

    public void SetPosition(double pos, double dur)
    {
        track.Position = pos; track.Duration = dur; track.Invalidate();
        lblTime.Text = $"{Fmt(pos)} / {Fmt(dur)}";
    }

    public void SetTitle(string t) => lblTitle.Text = t;

    public void SetVolume(double v) { trackVol.Value = v; trackVol.Invalidate(); }

    public void SetSpeed(double r) => cmbSpeed.SetRate(r);

    public void SetFg(bool on, int mult)
    {
        fgOn = on;
        fgMult = Math.Clamp(mult, 2, 5);
        RefreshFg();
        OnFg?.Invoke(fgOn, fgMult);
    }

    void RefreshFg()
    {
        btnFg.Text = fgOn ? $"补帧 {fgMult}X" : "补帧 关";
        btnFg.Active = fgOn;
        btnFg.Invalidate();
        for (int i = 0; i < 4; i++)
        {
            fgMultBtns[i].Active = fgOn && fgMultBtns[i].Text == $"{fgMult}X";
            fgMultBtns[i].Invalidate();
        }
    }

    static string Fmt(double s)
    {
        var t = TimeSpan.FromSeconds(Math.Max(0, s));
        return t.TotalHours >= 1 ? t.ToString(@"h\:mm\:ss") : t.ToString(@"mm\:ss");
    }

    protected override void OnResize(EventArgs e)
    {
        base.OnResize(e);
        Layout();
    }

    void Layout()
    {
        const int pad = 10, y = 18, h = 28;
        int x = pad;
        btnPlay.SetBounds(x, y, 40, h); x += 46;

        // 右侧固定宽度的一组，先算出来再给进度条留空间
        int right = Width - pad;
        btnClose.SetBounds(right - 34, y, 34, h); right -= 38;
        btnFs.SetBounds(right - 34, y, 34, h); right -= 38;
        btnNext.SetBounds(right - 34, y, 34, h); right -= 38;
        btnPrev.SetBounds(right - 34, y, 34, h); right -= 42;
        for (int i = 3; i >= 0; i--) { fgMultBtns[i].SetBounds(right - 30, y, 30, h); right -= 32; }
        btnFg.SetBounds(right - 74, y, 74, h); right -= 80;
        trackVol.SetBounds(right - 70, y + 4, 70, h - 8); right -= 76;
        cmbSpeed.SetBounds(right - 62, y, 62, h); right -= 66;
        lblTime.SetBounds(right - 120, y, 120, h); right -= 124;

        int trackW = Math.Max(60, right - x - 8);
        track.SetBounds(x, y + 9, trackW, 10);
        lblTitle.SetBounds(x, 2, Math.Min(320, trackW), 14);
    }

    // ── 胶囊按钮：圆角 + 18% 白边框 + 悬停变亮 ──
    sealed class PillButton : Control
    {
        [System.ComponentModel.DesignerSerializationVisibility(System.ComponentModel.DesignerSerializationVisibility.Hidden)]
        public string? Tip { get; set; }
        [System.ComponentModel.DesignerSerializationVisibility(System.ComponentModel.DesignerSerializationVisibility.Hidden)]
        public bool Active { get; set; }
        bool hover;
        public PillButton(string text, int w)
        {
            Text = text;
            Font = FUi;
            SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer
                     | ControlStyles.UserPaint | ControlStyles.SupportsTransparentBackColor, true);
            BackColor = Color.Transparent;
        }
        protected override void OnMouseEnter(EventArgs e) { hover = true; Invalidate(); base.OnMouseEnter(e); }
        protected override void OnMouseLeave(EventArgs e) { hover = false; Invalidate(); base.OnMouseLeave(e); }
        protected override void OnPaint(PaintEventArgs e)
        {
            var g = e.Graphics;
            g.SmoothingMode = SmoothingMode.AntiAlias;
            var rect = new Rectangle(0, 0, Width - 1, Height - 1);
            using var path = Round(rect, 8);
            var fill = Active ? Accent : (hover ? SurfaceHover : Surface);
            using (var b = new SolidBrush(fill)) g.FillPath(b, path);
            if (!Active)
            {
                using var p = new Pen(Border, 1f);
                g.DrawPath(p, path);
            }
            using var fg = new SolidBrush(Active ? Color.White : TextMain);
            var sf = new StringFormat { Alignment = StringAlignment.Center, LineAlignment = StringAlignment.Center };
            g.DrawString(Text, Font, fg, new RectangleF(0, 0, Width, Height), sf);
        }
    }

    // ── 进度轨：自绘，支持点击与拖动 ──
    sealed class SeekTrack : Control
    {
        public double Position, Duration;
        public event Action<double>? SeekRequested;
        bool dragging;

        public SeekTrack()
        {
            SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer
                     | ControlStyles.UserPaint | ControlStyles.SupportsTransparentBackColor, true);
            BackColor = Color.Transparent;
            Cursor = Cursors.Hand;
            Height = 10;
        }

        double RatioFrom(int x) => Width <= 0 ? 0 : Math.Clamp(x / (double)Width, 0, 1);

        protected override void OnMouseDown(MouseEventArgs e)
        {
            dragging = true;
            if (Duration > 0) SeekRequested?.Invoke(RatioFrom(e.X) * Duration);
            base.OnMouseDown(e);
        }
        protected override void OnMouseMove(MouseEventArgs e)
        {
            if (dragging && Duration > 0) { Position = RatioFrom(e.X) * Duration; Invalidate(); }
            base.OnMouseMove(e);
        }
        protected override void OnMouseUp(MouseEventArgs e)
        {
            dragging = false;
            if (Duration > 0) SeekRequested?.Invoke(RatioFrom(e.X) * Duration);
            base.OnMouseUp(e);
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            var g = e.Graphics;
            g.SmoothingMode = SmoothingMode.AntiAlias;
            int mid = Height / 2;
            using (var bg = new Pen(Color.FromArgb(64, 255, 255, 255), 4f) { StartCap = LineCap.Round, EndCap = LineCap.Round })
                g.DrawLine(bg, 2, mid, Width - 2, mid);
            double r = Duration > 0 ? Math.Clamp(Position / Duration, 0, 1) : 0;
            int px = (int)(2 + (Width - 4) * r);
            using (var fg = new Pen(Accent, 4f) { StartCap = LineCap.Round, EndCap = LineCap.Round })
                if (px > 2) g.DrawLine(fg, 2, mid, px, mid);
            using var dot = new SolidBrush(Color.White);
            g.FillEllipse(dot, px - 5, mid - 5, 10, 10);
        }
    }

    // ── 音量：细横条 ──
    sealed class Volume : Control
    {
        public double Value = 0.8;
        public event Action<double>? VolumeChanged;
        bool dragging;

        public Volume()
        {
            SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer
                     | ControlStyles.UserPaint | ControlStyles.SupportsTransparentBackColor, true);
            BackColor = Color.Transparent;
            Cursor = Cursors.Hand;
        }

        double RatioFrom(int x) => Width <= 0 ? 0 : Math.Clamp(x / (double)Width, 0, 1);

        protected override void OnMouseDown(MouseEventArgs e) { dragging = true; Apply(e.X); base.OnMouseDown(e); }
        protected override void OnMouseMove(MouseEventArgs e) { if (dragging) Apply(e.X); base.OnMouseMove(e); }
        protected override void OnMouseUp(MouseEventArgs e) { dragging = false; Apply(e.X); base.OnMouseUp(e); }
        void Apply(int x) { Value = RatioFrom(x); VolumeChanged?.Invoke(Value); Invalidate(); }

        protected override void OnPaint(PaintEventArgs e)
        {
            var g = e.Graphics;
            g.SmoothingMode = SmoothingMode.AntiAlias;
            int mid = Height / 2;
            using (var bg = new Pen(Color.FromArgb(64, 255, 255, 255), 3f)) g.DrawLine(bg, 1, mid, Width - 1, mid);
            int px = (int)(1 + (Width - 2) * Math.Clamp(Value, 0, 1));
            using (var fg = new Pen(TextMain, 3f)) g.DrawLine(fg, 1, mid, px, mid);
            using var dot = new SolidBrush(Color.White);
            g.FillEllipse(dot, px - 4, mid - 4, 8, 8);
        }
    }

    // ── 倍速下拉（自绘触发器 + 原生下拉）──
    sealed class SpeedCombo : Control
    {
        static readonly double[] Rates = { 0.5, 0.75, 1.0, 1.25, 1.5, 2.0, 3.0 };
        double rate = 1.0;
        public event Action<double>? SpeedChanged;

        public SpeedCombo()
        {
            SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer
                     | ControlStyles.UserPaint | ControlStyles.SupportsTransparentBackColor, true);
            BackColor = Color.Transparent;
            Cursor = Cursors.Hand;
            Height = 28;
        }

        public void SetRate(double r) { rate = r; Invalidate(); }

        protected override void OnClick(EventArgs e)
        {
            var menu = new ContextMenuStrip { BackColor = Color.FromArgb(32, 32, 40), ForeColor = TextMain };
            foreach (var r in Rates)
            {
                var item = new ToolStripMenuItem($"{r:0.0}x") { ForeColor = TextMain };
                if (Math.Abs(r - rate) < 0.01) item.Font = new Font(FUi, FontStyle.Bold);
                double captured = r;
                item.Click += (_, _) => { rate = captured; Invalidate(); SpeedChanged?.Invoke(captured); };
                menu.Items.Add(item);
            }
            menu.Show(this, new Point(0, Height));
            base.OnClick(e);
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            var g = e.Graphics;
            g.SmoothingMode = SmoothingMode.AntiAlias;
            using var path = Round(new Rectangle(0, 0, Width - 1, Height - 1), 8);
            using (var b = new SolidBrush(Surface)) g.FillPath(b, path);
            using (var p = new Pen(Border, 1f)) g.DrawPath(p, path);
            using var fg = new SolidBrush(TextMain);
            var sf = new StringFormat { Alignment = StringAlignment.Center, LineAlignment = StringAlignment.Center };
            g.DrawString($"{rate:0.0}x", FUi, fg, new RectangleF(0, 0, Width, Height), sf);
        }
    }

    static GraphicsPath Round(Rectangle r, int radius)
    {
        var p = new GraphicsPath();
        int d = radius * 2;
        p.AddArc(r.X, r.Y, d, d, 180, 90);
        p.AddArc(r.Right - d, r.Y, d, d, 270, 90);
        p.AddArc(r.Right - d, r.Bottom - d, d, d, 0, 90);
        p.AddArc(r.X, r.Bottom - d, d, d, 90, 90);
        p.CloseFigure();
        return p;
    }
}
