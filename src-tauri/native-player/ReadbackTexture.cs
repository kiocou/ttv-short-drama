namespace NativePlayer;

public static class ReadbackTexture
{
    public static bool Matches(uint width, uint height, uint targetWidth, uint targetHeight) =>
        width == targetWidth && height == targetHeight;
}
