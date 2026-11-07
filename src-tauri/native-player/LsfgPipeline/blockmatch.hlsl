Texture2D<float4> FA : register(t0);
Texture2D<float4> FB : register(t1);
SamplerState S : register(s0);
RWTexture2D<float4> OUT_ : register(u0);

cbuffer P : register(b0)
{
    float4 dimsAndRadius;   // xy = , z = , w = /
};

[numthreads(8, 8, 1)]
void main(uint3 tid : SV_DispatchThreadID)
{
    float2 dims = dimsAndRadius.xy;
    int R = (int)dimsAndRadius.z;

    if (tid.x >= (uint)dims.x || tid.y >= (uint)dims.y)
        return;

    float2 uv = (float2(tid.xy) + 0.5) / dims;
    float bestF = 999999.0;
    float bestB = 999999.0;
    float2 bestDf = float2(0.0, 0.0);
    float2 bestDb = float2(0.0, 0.0);

    int dy = -R;
    while (dy <= R)
    {
        int dx = -R;
        while (dx <= R)
        {
            float2 d = float2((float)dx, (float)dy) / dims;
            float sf = 0.0;
            float sb = 0.0;
            int by = -1;
            while (by <= 1)
            {
                int bx = -1;
                while (bx <= 1)
                {
                    float2 o = float2((float)bx, (float)by) / dims;
                    float3 ca = FA.SampleLevel(S, uv + o, 0).rgb;
                    float3 cb = FB.SampleLevel(S, uv + d + o, 0).rgb;
                    sf = sf + abs(ca.r - cb.r) + abs(ca.g - cb.g) + abs(ca.b - cb.b);
                    float3 ca2 = FA.SampleLevel(S, uv - d + o, 0).rgb;
                    float3 cb2 = FB.SampleLevel(S, uv + o, 0).rgb;
                    sb = sb + abs(ca2.r - cb2.r) + abs(ca2.g - cb2.g) + abs(ca2.b - cb2.b);
                    bx = bx + 1;
                }
                by = by + 1;
            }
            if (sf < bestF)
            {
                bestF = sf;
                bestDf = float2((float)dx, (float)dy);
            }
            if (sb < bestB)
            {
                bestB = sb;
                bestDb = float2((float)(0 - dx), (float)(0 - dy));
            }
            dx = dx + 1;
        }
        dy = dy + 1;
    }

    //  1/4 d
    // synthesis   0.5  scale
    float k = 0.5 * dimsAndRadius.w;
    OUT_[tid.xy] = float4(-bestDf * k, -bestDb * k);
}
