// ControlsServer.cs —— 控制条（WebView2）与播放器进程的 HTTP 桥。
//
// 为什么不走命名管道：控制条是 Chromium 页面，fetch 到命名管道在 WebView2 里
// 没有原生支持；而一个 127.0.0.1 上的极简 HTTP 服务（两个端点：POST /cmd、
// GET /state）就是最短路径。管道仍保留给 Rust 主程序（进程间正式协议）。
//
// 安全边界：只绑定 127.0.0.1，端口随机；state 里不暴露 URL/key —— 控制条
// 只需要播放状态，不应该看到源地址。
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Text.Json;

namespace NativePlayer;

internal sealed class ControlsServer
{
    readonly PlayerForm form;
    TcpListener? listener;
    Thread? loop;
    volatile bool running;
    public int Port { get; private set; }
    string lastTitle = "";
    int lastEp;

    public ControlsServer(PlayerForm owner) => form = owner;

    public void Start()
    {
        listener = new TcpListener(IPAddress.Loopback, 0);
        listener.Start();
        Port = ((IPEndPoint)listener.LocalEndpoint).Port;
        running = true;
        loop = new Thread(AcceptLoop) { IsBackground = true, Name = "http" };
        loop.Start();
        Program.Log($"controls http -> 127.0.0.1:{Port}");
    }

    public void PushTitle(string title, int ep)
    {
        lastTitle = title; lastEp = ep;
    }

    void AcceptLoop()
    {
        while (running)
        {
            try
            {
                var client = listener!.AcceptTcpClient();
                _ = Task.Run(() => Handle(client));
            }
            catch { break; }
        }
    }

    async void Handle(TcpClient client)
    {
        try
        {
            using var _ = client;
            client.NoDelay = true;
            var stream = client.GetStream();
            var buf = new byte[8192];
            int n = await stream.ReadAsync(buf);
            if (n <= 0) return;
            var head = Encoding.UTF8.GetString(buf, 0, n);
            var line = head.Split('\n')[0];
            var parts = line.Split(' ');
            if (parts.Length < 2) return;
            string method = parts[0], path = parts[1].Split('?')[0];

            // CORS：控制条页面来自 dev server（5175），跨源 fetch 需要允许。
            const string cors =
                "Access-Control-Allow-Origin: *\r\n" +
                "Access-Control-Allow-Methods: GET, POST, OPTIONS\r\n" +
                "Access-Control-Allow-Headers: Content-Type\r\n";

            if (method == "OPTIONS")
            {
                Write(stream, 204, "HTTP/1.1 204 No Content\r\n" + cors + "\r\n", "");
                return;
            }

            if (path == "/state" && method == "GET")
            {
                var st = new State();
                form.Invoke(() =>
                {
                    st.playing = !form.GetPaused();
                    st.pos = form.GetPosition();
                    st.dur = Math.Max(0.1, form.GetDuration());
                    st.volume = (int)Math.Round(form.GetVolume());
                    st.speed = form.GetSpeed();
                    st.fg = form.IsFgOn();
                    st.mult = form.GetFgMult();
                    st.title = lastTitle;
                    st.ep = lastEp;
                });
                var json = JsonSerializer.Serialize(st);
                Write(stream, 200,
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n" + cors + "\r\n", json);
                return;
            }

            if (path == "/cmd" && method == "POST")
            {
                // body 在同一个读缓冲里（命令都极短）
                int bodyStart = head.IndexOf("\r\n\r\n");
                string body = bodyStart >= 0 ? head[(bodyStart + 4)..] : "";
                try
                {
                    using var doc = JsonDocument.Parse(body);
                    var root = doc.RootElement;
                    string action = root.GetProperty("action").GetString() ?? "";
                    switch (action)
                    {
                        case "pause": form.Invoke(form.CmdPause); break;
                        case "seek": form.Invoke(() => form.CmdSeek(root.GetProperty("pos").GetDouble())); break;
                        case "volume": form.Invoke(() => form.CmdVolume(root.GetProperty("v").GetInt32())); break;
                        case "speed": form.Invoke(() => form.CmdSpeed(root.GetProperty("rate").GetDouble())); break;
                        case "fg": form.Invoke(() => form.SetFg(root.GetProperty("on").GetBoolean(),
                            root.TryGetProperty("mult", out var m) ? m.GetInt32() : 2)); break;
                        case "prev": form.Invoke(() => form.PrevEpisode()); break;
                        case "next": form.Invoke(() => form.NextEpisode()); break;
                        case "quit": form.Invoke(form.Close); break;
                        case "fullscreen": form.Invoke(form.ToggleFullscreenPublic); break;
                    }
                }
                catch (Exception ex) { Program.Log("cmd parse: " + ex.Message); }
                Write(stream, 200, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n" + cors + "\r\n", "{\"ok\":true}");
                return;
            }

            Write(stream, 404, "HTTP/1.1 404 Not Found\r\n" + cors + "\r\n", "");
        }
        catch { }
    }

    static void Write(NetworkStream s, int code, string head, string body)
    {
        var bytes = Encoding.UTF8.GetBytes(body);
        var full = Encoding.UTF8.GetBytes(
            head + $"Content-Length: {bytes.Length}\r\nConnection: close\r\n\r\n");
        s.Write(full);
        if (bytes.Length > 0) s.Write(bytes);
        s.Flush();
    }

    /// <summary>UI 定时器驱动：把播放位置推给管道（进度上报给 Rust 存历史）。</summary>
    public void Poll() { }

    public void Stop()
    {
        running = false;
        try { listener?.Stop(); } catch { }
    }

    class State
    {
        public bool playing { get; set; }
        public double pos { get; set; }
        public double dur { get; set; }
        public int volume { get; set; }
        public double speed { get; set; }
        public bool fg { get; set; }
        public int mult { get; set; }
        public string title { get; set; } = "";
        public int ep { get; set; }
    }
}
