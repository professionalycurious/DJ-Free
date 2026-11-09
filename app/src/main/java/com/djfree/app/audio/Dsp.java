package com.djfree.app.audio;

/** Small DSP building blocks shared by the deck chain and the effects. */
final class Dsp {
    private Dsp() {}

    static float clamp(float v, float lo, float hi) { return v < lo ? lo : (v > hi ? hi : v); }

    static double expMap(double min, double max, double v) { return min * Math.pow(max / min, v); }

    /** One-pole smoother with a JS setTargetAtTime-like time constant. */
    static final class Smooth {
        float cur, target, coef;
        final int sr;
        Smooth(float v, int sr) { cur = target = v; this.sr = sr; coef = c(0.01f); }
        float c(float tc) { return tc <= 0 ? 1f : (float) (1 - Math.exp(-1.0 / (tc * sr))); }
        void set(float v, float tc) { target = v; coef = c(tc); if (tc <= 0) cur = v; }
        void jump(float v) { cur = target = v; }
        float next() { cur += (target - cur) * coef; return cur; }
        boolean idleAt(float v) { return Math.abs(cur - v) < 1e-5f && target == v; }
    }

    /** Fractional delay line (linear interpolation). Read before write. */
    static final class DelayLine {
        final float[] b;
        int w;
        DelayLine(int len) { b = new float[Math.max(4, len)]; }
        float read(double d) {
            double p = w - d;
            while (p < 0) p += b.length;
            int i = (int) p;
            if (i >= b.length) i -= b.length;
            float f = (float) (p - (int) p);
            int j = i + 1; if (j >= b.length) j = 0;
            return b[i] * (1 - f) + b[j] * f;
        }
        void write(float x) { b[w] = x; if (++w == b.length) w = 0; }
        void clear() { java.util.Arrays.fill(b, 0); }
    }

    /** Topology-preserving state variable filter, stereo. mode: 0 LP, 1 BP, 2 HP. */
    static final class Svf {
        double a1, a2, a3, k;
        double i1l, i2l, i1r, i2r;
        final int sr;
        Svf(int sr) { this.sr = sr; set(1000, 0.707); }
        void set(double fc, double q) {
            fc = Math.max(10, Math.min(fc, 0.45 * sr));
            double g = Math.tan(Math.PI * fc / sr);
            k = 1.0 / Math.max(0.05, q);
            a1 = 1.0 / (1 + g * (g + k)); a2 = g * a1; a3 = g * a2;
        }
        float tickL(float x, int mode) {
            double v3 = x - i2l, v1 = a1 * i1l + a2 * v3, v2 = i2l + a2 * i1l + a3 * v3;
            i1l = 2 * v1 - i1l; i2l = 2 * v2 - i2l;
            return (float) (mode == 0 ? v2 : mode == 1 ? v1 : x - k * v1 - v2);
        }
        float tickR(float x, int mode) {
            double v3 = x - i2r, v1 = a1 * i1r + a2 * v3, v2 = i2r + a2 * i1r + a3 * v3;
            i1r = 2 * v1 - i1r; i2r = 2 * v2 - i2r;
            return (float) (mode == 0 ? v2 : mode == 1 ? v1 : x - k * v1 - v2);
        }
    }

    /** RBJ biquad (shelves / peaking), stereo, direct form I. */
    static final class Biquad {
        double b0 = 1, b1, b2, a1, a2;
        double x1l, x2l, y1l, y2l, x1r, x2r, y1r, y2r;
        final int sr;
        Biquad(int sr) { this.sr = sr; }

        void set(int type, double f, double q, double gainDb) {
            double A = Math.pow(10, gainDb / 40), w0 = 2 * Math.PI * f / sr;
            double cs = Math.cos(w0), sn = Math.sin(w0);
            double B0, B1, B2, A0, A1, A2;
            if (type == 1) { // peaking
                double alpha = sn / (2 * q);
                B0 = 1 + alpha * A; B1 = -2 * cs; B2 = 1 - alpha * A;
                A0 = 1 + alpha / A; A1 = -2 * cs; A2 = 1 - alpha / A;
            } else {
                double alpha = sn / 2 * Math.sqrt(2), sa = 2 * Math.sqrt(A) * alpha;
                if (type == 0) { // low shelf
                    B0 = A * ((A + 1) - (A - 1) * cs + sa); B1 = 2 * A * ((A - 1) - (A + 1) * cs); B2 = A * ((A + 1) - (A - 1) * cs - sa);
                    A0 = (A + 1) + (A - 1) * cs + sa; A1 = -2 * ((A - 1) + (A + 1) * cs); A2 = (A + 1) + (A - 1) * cs - sa;
                } else { // high shelf
                    B0 = A * ((A + 1) + (A - 1) * cs + sa); B1 = -2 * A * ((A - 1) + (A + 1) * cs); B2 = A * ((A + 1) + (A - 1) * cs - sa);
                    A0 = (A + 1) - (A - 1) * cs + sa; A1 = 2 * ((A - 1) - (A + 1) * cs); A2 = (A + 1) - (A - 1) * cs - sa;
                }
            }
            b0 = B0 / A0; b1 = B1 / A0; b2 = B2 / A0; a1 = A1 / A0; a2 = A2 / A0;
        }

        void process(float[] L, float[] R, int n) {
            for (int i = 0; i < n; i++) {
                double x = L[i];
                double y = b0 * x + b1 * x1l + b2 * x2l - a1 * y1l - a2 * y2l;
                x2l = x1l; x1l = x; y2l = y1l; y1l = y; L[i] = (float) y;
                x = R[i];
                y = b0 * x + b1 * x1r + b2 * x2r - a1 * y1r - a2 * y2r;
                x2r = x1r; x1r = x; y2r = y1r; y1r = y; R[i] = (float) y;
            }
            // flush denormals
            if (Math.abs(y1l) < 1e-20) { y1l = 0; y2l = 0; }
            if (Math.abs(y1r) < 1e-20) { y1r = 0; y2r = 0; }
        }
    }

    /** Fast xorshift noise in -1..1. */
    static final class Noise {
        int s = 0x1234567;
        float next() { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return (s & 0xffffff) / (float) 0x800000 - 1f; }
    }
}
