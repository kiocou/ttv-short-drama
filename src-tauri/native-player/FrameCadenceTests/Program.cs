using NativePlayer;

var checks = 0;
void Equal<T>(T actual, T expected, string name)
{
    if (!EqualityComparer<T>.Default.Equals(actual, expected))
        throw new InvalidOperationException($"{name}: expected {expected}, got {actual}");
    Console.WriteLine($"PASS {name}");
    checks++;
}

Equal(FrameCadence.TargetFps(30, 2), 60, "30 fps 2x targets 60 fps");
Equal(FrameCadence.TargetFps(24, 2), 48, "24 fps 2x targets 48 fps");
Equal(FrameCadence.TargetFps(30, 5), 150, "30 fps 5x targets 150 fps");
Equal(FrameCadence.TargetFps(60, 5), 240, "output target is capped at 240 fps");
Equal(FrameCadence.TargetFps(0, 2), 0, "invalid source fps disables interpolation");

const long frequency = 10_000_000;
var interval = FrameCadence.IntervalTicks(60, frequency);
Equal(interval, 166_667L, "60 fps interval rounds to the nearest stopwatch tick");

var first = FrameCadence.Evaluate(100, 0, interval, frequency);
Equal(first.Due, true, "the first frame presents immediately");
Equal(first.NextTick, 166_767L, "the next deadline advances by one frame interval");

var early = FrameCadence.Evaluate(160, first.NextTick, interval, frequency);
Equal(early.Due, false, "frames before the deadline are withheld");
Equal(early.WaitMilliseconds, 10, "the scheduler bounds each wait to 10 ms");

var onTime = FrameCadence.Evaluate(first.NextTick, first.NextTick, interval, frequency);
Equal(onTime.Due, true, "a frame at its deadline is presented");

Equal(ReadbackTexture.Matches(960, 540, 960, 540), true, "readback texture matches unchanged backbuffer");
Equal(ReadbackTexture.Matches(960, 540, 1280, 720), false, "fullscreen resize invalidates old readback texture");
Equal(ReadbackTexture.Matches(1280, 720, 1280, 720), true, "readback texture matches resized backbuffer");
Console.WriteLine($"{checks} passed, 0 failed");
