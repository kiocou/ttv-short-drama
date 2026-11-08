// ControlsServer.cs —— 控制条（WebView2）与播放器进程的 HTTP 桥。
//
// React 控制条通过本机 HTTP 读取静态 bundle 并调用状态/命令；播放器本身仍与
// Tauri 主进程通过命名管道通信。两类连接都只绑定 127.0.0.1。
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
    readonly string webRoot;
    TcpListener? listener;
    Thread? loop;
    volatile bool running;
    public int Port { get; private set; }
    public string NativePageUrl => $"http://127.0.0.1:{Port}/native-player.html?controlPort={Port}";
    string lastTitle = "";
    int lastEp;

    public ControlsServer(PlayerForm owner, string controlsRoot)
    {
        form = owner;
        webRoot = Path.GetFullPath(controlsRoot);
    }

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
                    st.fullscreen = form.IsFullscreen();
                    st.title = lastTitle;
                    st.ep = lastEp;
                });
                var json = JsonSerializer.Serialize(st);
                Write(stream, 200,
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n", json);
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
                Write(stream, 200, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n", "{\"ok\":true}");
                return;
            }

            if (method is "GET" or "HEAD")
            {
                await ServeStatic(stream, path, method == "HEAD");
                return;
            }

            Write(stream, 404, "HTTP/1.1 404 Not Found\r\n\r\n", "");
        }
        catch { }
    }

    static void Write(NetworkStream s, int code, string head, string body)
    {
        var bytes = Encoding.UTF8.GetBytes(body);
        var full = Encoding.UTF8.GetBytes(
            head.TrimEnd('\r', '\n') + $"\r\nContent-Length: {bytes.Length}\r\nConnection: close\r\n\r\n");
        s.Write(full);
        if (bytes.Length > 0) s.Write(bytes);
        s.Flush();
    }

    async Task ServeStatic(NetworkStream stream, string path, bool headOnly)
    {
        try
        {
            var relative = Uri.UnescapeDataString(path.TrimStart('/').Replace('/', Path.DirectorySeparatorChar));
            if (string.IsNullOrEmpty(relative)) relative = "native-player.html";
            var target = Path.GetFullPath(Path.Combine(webRoot, relative));
            var prefix = webRoot.TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
            if (!target.StartsWith(prefix, StringComparison.OrdinalIgnoreCase) || !File.Exists(target))
            {
                Write(stream, 404, "HTTP/1.1 404 Not Found\r\n\r\n", "");
                return;
            }

            var bytes = await File.ReadAllBytesAsync(target);
            var contentType = Path.GetExtension(target).ToLowerInvariant() switch
            {
                ".html" => "text/html; charset=utf-8",
                ".js" => "text/javascript; charset=utf-8",
                ".css" => "text/css; charset=utf-8",
                ".svg" => "image/svg+xml",
                ".woff2" => "font/woff2",
                ".png" => "image/png",
                ".webp" => "image/webp",
                _ => "application/octet-stream",
            };
            Write(stream, 200,
                $"HTTP/1.1 200 OK\r\nContent-Type: {contentType}\r\n\r\n",
                headOnly ? Array.Empty<byte>() : bytes,
                bytes.Length);
        }
        catch (Exception ex)
        {
            Program.Log("static controls asset failed: " + ex.GetType().Name);
            Write(stream, 500, "HTTP/1.1 500 Internal Server Error\r\n\r\n", "");
        }
    }

    static void Write(NetworkStream stream, int code, string head, byte[] body, int? contentLength = null)
    {
        var header = Encoding.UTF8.GetBytes(
            head.TrimEnd('\r', '\n') + $"\r\nContent-Length: {contentLength ?? body.Length}\r\nConnection: close\r\n\r\n");
        stream.Write(header);
        if (body.Length > 0) stream.Write(body);
        stream.Flush();
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
        public bool fullscreen { get; set; }
        public string title { get; set; } = "";
        public int ep { get; set; }
    }
}
