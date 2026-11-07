// IpcPipe.cs —— 与 Tauri 主程序（Rust）之间的命名管道 JSON 行协议。
//
// 职责边界（刻意的）：主程序持有签名缓存、剧集列表、观看历史；本进程只负责
// "渲染 + 播放"。所以协议只有两类消息：
//   主程序 → 播放器：控制（load/pause/play/seek/volume/speed/fg/quit）
//   播放器 → 主程序：事件（ready/progress/ended/next/prev/closed/error）
//
// 实现要点：
//   * 播放器是管道**服务端**（名字由 spawn 参数传入），主程序连上来；
//   * 一行一条 JSON（UTF-8，无 BOM，\n 结尾）——与 Rust 侧 std::io::BufRead
//     的按行读取天然对齐，双方都不需要引入 WebSocket/HTTP 依赖；
//   * 写侧加锁：progress 心跳与 ended 可能从不同线程发出；
//   * 任何管道错误都只记日志不抛：主程序挂了播放器应继续播完当前集，
//     播放器挂了主程序按"进程退出"处理，双向都不需要握手保活。
using System.IO.Pipes;
using System.Text;
using System.Text.Json;

namespace NativePlayer;

internal sealed class IpcPipe : IDisposable
{
    readonly string pipeName;
    NamedPipeServerStream? server;
    StreamWriter? writer;
    readonly object writeGate = new();
    public Action<JsonElement>? OnCommand { get; set; }

    public IpcPipe(string name) => pipeName = name;

    /// <summary>开始监听（后台线程，非阻塞）。主程序随时可连。</summary>
    public void StartListen()
    {
        _ = Task.Run(async () =>
        {
            // 主程序 spawn 本进程后立刻连接；给它 30 秒余量（覆盖杀软拖慢启动的场景）。
            for (int attempt = 0; attempt < 300; attempt++)
            {
                try
                {
                    server = new NamedPipeServerStream(pipeName, PipeDirection.InOut,
                        NamedPipeServerStream.MaxAllowedServerInstances,
                        PipeTransmissionMode.Byte, PipeOptions.Asynchronous);
                    using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(30));
                    await server.WaitForConnectionAsync(cts.Token);
                    writer = new StreamWriter(server, new UTF8Encoding(false)) { AutoFlush = true };
                    Log("pipe: connected");
                    _ = Task.Run(ReadLoop);
                    return;
                }
                catch (Exception ex)
                {
                    try { server?.Dispose(); } catch { }
                    server = null;
                    Log($"pipe: listen retry {attempt}: {ex.GetType().Name} {ex.Message}");
                    await Task.Delay(100);
                }
            }
            Log("pipe: give up listening");
        });
    }

    async void ReadLoop()
    {
        var buf = new StringBuilder();
        var readBuf = new byte[8192];
        try
        {
            while (server is { IsConnected: true })
            {
                int n = await server.ReadAsync(readBuf);
                if (n <= 0) break;
                for (int i = 0; i < n; i++)
                {
                    char c = (char)readBuf[i];
                    if (c == '\n')
                    {
                        var line = buf.ToString().Trim();
                        buf.Clear();
                        if (line.Length > 0) HandleLine(line);
                    }
                    else buf.Append(c);
                }
            }
        }
        catch (Exception ex) { Log("pipe: read end: " + ex.GetType().Name); }
        Log("pipe: disconnected");
    }

    void HandleLine(string line)
    {
        try
        {
            using var doc = JsonDocument.Parse(line);
            OnCommand?.Invoke(doc.RootElement);
        }
        catch (Exception ex)
        {
            Log("pipe: bad line: " + ex.GetType().Name + " " + line[..Math.Min(line.Length, 80)]);
        }
    }

    /// <summary>发事件给主程序。管道未连接/已断开时静默丢弃。</summary>
    public void Send(string json)
    {
        lock (writeGate)
        {
            try { writer?.Write(json + "\n"); }
            catch (Exception ex) { Log("pipe: send failed: " + ex.GetType().Name); }
        }
    }

    public void SendEvent(object payload)
    {
        try { Send(JsonSerializer.Serialize(payload)); }
        catch (Exception ex) { Log("pipe: serialize failed: " + ex.GetType().Name); }
    }

    static void Log(string s)
    {
        try
        {
            File.AppendAllText(Path.Combine(AppContext.BaseDirectory, "nativeplayer.log"),
                DateTime.Now.ToString("HH:mm:ss.fff") + " " + s + Environment.NewLine);
        }
        catch { }
    }

    public void Dispose()
    {
        try { writer?.Dispose(); } catch { }
        try { server?.Dispose(); } catch { }
    }
}
