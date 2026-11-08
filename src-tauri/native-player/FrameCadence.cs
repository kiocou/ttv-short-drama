namespace NativePlayer;

public readonly record struct FramePresentation(bool Due, long NextTick, int WaitMilliseconds);

public static class FrameCadence
{
    public static int TargetFps(double sourceFps, int multiplier)
    {
        if (!double.IsFinite(sourceFps) || sourceFps <= 0) return 0;
        return (int)Math.Clamp(Math.Round(sourceFps * Math.Clamp(multiplier, 2, 5)), 1, 240);
    }

    public static long IntervalTicks(int targetFps, long clockFrequency)
    {
        if (targetFps <= 0 || clockFrequency <= 0) return 0;
        return Math.Max(1, (long)Math.Round((double)clockFrequency / targetFps));
    }

    public static FramePresentation Evaluate(long now, long nextTick, long intervalTicks, long clockFrequency)
    {
        if (intervalTicks <= 0 || clockFrequency <= 0)
            return new FramePresentation(true, 0, 0);

        if (nextTick <= 0 || now >= nextTick)
            return new FramePresentation(true, now + intervalTicks, 0);

        int wait = (int)Math.Ceiling((nextTick - now) * 1000d / clockFrequency);
        return new FramePresentation(false, nextTick, Math.Clamp(wait, 1, 10));
    }
}
