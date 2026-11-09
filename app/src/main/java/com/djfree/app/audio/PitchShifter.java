package com.djfree.app.audio;

/** Granular (two-tap crossfaded delay) pitch shifter, stereo. Used for key lock and key shift. */
final class PitchShifter {
    private static final int SIZE = 16384, MASK = SIZE - 1;
    private final float[] bl = new float[SIZE], br = new float[SIZE];
    private final double win;
    private int w;
    private double phase, mix;
    double ratio = 1;
    float oL, oR;

    PitchShifter(int sr) { win = 2048.0 * sr / 44100.0; }

    private float read(float[] b, double d) {
        double p = w - d;
        while (p < 0) p += SIZE;
        int i = (int) p;
        float f = (float) (p - i);
        return b[i & MASK] * (1 - f) + b[(i + 1) & MASK] * f;
    }

    boolean idle() { return Math.abs(ratio - 1) <= 0.0015 && mix < 0.0005; }

    void tick(float l, float r) {
        boolean active = Math.abs(ratio - 1) > 0.0015;
        mix += ((active ? 1 : 0) - mix) * 0.002;
        bl[w] = l; br[w] = r;
        if (mix > 0.0005) {
            double ph1 = phase, ph2 = (phase + 0.5) % 1;
            double d1 = 64 + ph1 * win, d2 = 64 + ph2 * win;
            double s1 = Math.sin(Math.PI * ph1), s2 = Math.sin(Math.PI * ph2);
            float g1 = (float) (s1 * s1), g2 = (float) (s2 * s2);
            float yl = read(bl, d1) * g1 + read(bl, d2) * g2;
            float yr = read(br, d1) * g1 + read(br, d2) * g2;
            float m = (float) mix;
            oL = l * (1 - m) + yl * m; oR = r * (1 - m) + yr * m;
        } else { oL = l; oR = r; }
        w = (w + 1) & MASK;
        phase += (1 - ratio) / win;
        if (phase >= 1) phase -= 1; else if (phase < 0) phase += 1;
    }

    void process(float[] L, float[] R, int n) {
        if (idle()) {
            // keep the buffer filled so switching on is seamless
            for (int i = 0; i < n; i++) { bl[w] = L[i]; br[w] = R[i]; w = (w + 1) & MASK; }
            return;
        }
        for (int i = 0; i < n; i++) { tick(L[i], R[i]); L[i] = oL; R[i] = oR; }
    }
}
