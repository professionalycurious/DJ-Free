package com.djfree.app.audio;

import com.djfree.app.audio.Dsp.DelayLine;
import com.djfree.app.audio.Dsp.Noise;
import com.djfree.app.audio.Dsp.Svf;

/** The 22 effects. process() turns the input block into the effect's wet signal in place. */
final class Effects {
    private Effects() {}

    abstract static class Effect {
        final int sr;
        float param = 0.5f;
        float beat = 0.5f;   // seconds
        Effect(int sr) { this.sr = sr; }
        void setParam(float v) { param = v; }
        void setBeat(float s) { beat = Math.max(0.01f, s); }
        abstract void process(float[] L, float[] R, int n);
    }

    static boolean isInsert(String id) {
        switch (id) {
            case "gate": case "tremolo": case "autofilter": case "wah": case "lpf": case "hpf": case "bitcrush":
            case "distortion": case "lofi": case "autopan": case "ringmod": case "pitch": case "punch": case "stereo": case "noise":
                return true;
            default:
                return false;
        }
    }

    static Effect create(String id, int sr) {
        switch (id) {
            case "echo": return new Echo(sr);
            case "pingpong": return new PingPong(sr);
            case "reverb": return new Reverb(sr);
            case "flanger": return new Mod(sr, false);
            case "chorus": return new Mod(sr, true);
            case "phaser": return new Phaser(sr);
            case "gate": return new Gate(sr, true);
            case "tremolo": return new Gate(sr, false);
            case "autofilter": return new AutoFilter(sr);
            case "wah": return new Wah(sr);
            case "lpf": return new Filter(sr, true);
            case "hpf": return new Filter(sr, false);
            case "bitcrush": return new Crush(sr);
            case "distortion": return new Distortion(sr);
            case "lofi": return new LoFi(sr);
            case "autopan": return new AutoPan(sr);
            case "ringmod": return new RingMod(sr);
            case "pitch": return new Pitch(sr);
            case "noise": return new NoiseSweep(sr);
            case "reverse_echo": return new Spiral(sr);
            case "punch": return new Punch(sr);
            case "stereo": return new Stereo(sr);
            default: return null;
        }
    }

    /* ---------------- time based ---------------- */
    static final class Echo extends Effect {
        final DelayLine dl, dr; double d, dT; float lpL, lpR; final float hpA;
        Echo(int sr) { super(sr); dl = new DelayLine(sr * 4 + 8); dr = new DelayLine(sr * 4 + 8); d = dT = 0.5 * sr; hpA = (float) (1 - Math.exp(-2 * Math.PI * 150 / sr)); }
        @Override void setBeat(float s) { super.setBeat(s); dT = Math.min(3.9, s) * sr; }
        @Override void process(float[] L, float[] R, int n) {
            float fb = param * 0.92f; double k = 1.0 / (0.05 * sr);
            for (int i = 0; i < n; i++) {
                d += (dT - d) * k;
                float yl = dl.read(d), yr = dr.read(d);
                lpL += hpA * (yl - lpL); lpR += hpA * (yr - lpR);
                dl.write(L[i] + (yl - lpL) * fb); dr.write(R[i] + (yr - lpR) * fb);
                L[i] = yl; R[i] = yr;
            }
        }
    }

    static final class PingPong extends Effect {
        final DelayLine dl, dr; double d, dT;
        PingPong(int sr) { super(sr); dl = new DelayLine(sr * 4 + 8); dr = new DelayLine(sr * 4 + 8); d = dT = 0.5 * sr; }
        @Override void setBeat(float s) { super.setBeat(s); dT = Math.min(3.9, s) * sr; }
        @Override void process(float[] L, float[] R, int n) {
            float fb = param * 0.9f; double k = 1.0 / (0.05 * sr);
            for (int i = 0; i < n; i++) {
                d += (dT - d) * k;
                float x = (L[i] + R[i]) * 0.5f;
                float yl = dl.read(d), yr = dr.read(d);
                dl.write(x + yr * fb); dr.write(yl);
                L[i] = yl; R[i] = yr;
            }
        }
    }

    /** Freeverb-style algorithmic reverb. */
    static final class Freeverb {
        private static final int[] COMBS = {1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617};
        private static final int[] APS = {556, 441, 341, 225};
        final float[][] cb = new float[16][]; final int[] ci = new int[16]; final float[] cf = new float[16];
        final float[][] ab = new float[8][]; final int[] ai = new int[8];
        float room = 0.84f, damp = 0.25f;
        Freeverb(int sr) {
            double s = sr / 44100.0;
            for (int i = 0; i < 8; i++) { cb[i] = new float[(int) (COMBS[i] * s)]; cb[i + 8] = new float[(int) ((COMBS[i] + 23) * s)]; }
            for (int i = 0; i < 4; i++) { ab[i] = new float[(int) (APS[i] * s)]; ab[i + 4] = new float[(int) ((APS[i] + 23) * s)]; }
        }
        void process(float[] L, float[] R, int n, float inGain) {
            final float fbk = room, d1 = damp, d2 = 1 - damp;
            for (int i = 0; i < n; i++) {
                float in = (L[i] + R[i]) * 0.015f * inGain, ol = 0, or = 0;
                for (int c = 0; c < 16; c++) {
                    float[] b = cb[c]; int idx = ci[c];
                    float y = b[idx];
                    cf[c] = y * d2 + cf[c] * d1;
                    b[idx] = in + cf[c] * fbk;
                    if (++idx >= b.length) idx = 0; ci[c] = idx;
                    if (c < 8) ol += y; else or += y;
                }
                for (int a = 0; a < 8; a++) {
                    float[] b = ab[a]; int idx = ai[a];
                    float bo = b[idx], x = a < 4 ? ol : or;
                    float y = -x + bo;
                    b[idx] = x + bo * 0.5f;
                    if (++idx >= b.length) idx = 0; ai[a] = idx;
                    if (a < 4) ol = y; else or = y;
                }
                L[i] = ol; R[i] = or;
            }
            for (int c = 0; c < 16; c++) if (Math.abs(cf[c]) < 1e-18f) cf[c] = 0;
        }
    }

    static final class Reverb extends Effect {
        final Freeverb fv; final Svf hp;
        Reverb(int sr) { super(sr); fv = new Freeverb(sr); hp = new Svf(sr); hp.set(200, 0.7); }
        @Override void process(float[] L, float[] R, int n) {
            fv.room = 0.72f + param * 0.26f; fv.damp = 0.35f - param * 0.15f;
            for (int i = 0; i < n; i++) { L[i] = hp.tickL(L[i], 2); R[i] = hp.tickR(R[i], 2); }
            fv.process(L, R, n, 3f);
        }
    }

    /** Flanger (feedback, beat-synced) or chorus (free running, stereo). */
    static final class Mod extends Effect {
        final boolean chorus; final DelayLine dl, dr; double ph;
        Mod(int sr, boolean chorus) { super(sr); this.chorus = chorus; dl = new DelayLine((int) (0.06 * sr)); dr = new DelayLine((int) (0.06 * sr)); }
        @Override void process(float[] L, float[] R, int n) {
            double f = chorus ? 0.8 : 1.0 / (beat * 8);
            double base = (chorus ? 0.020 : 0.004) * sr, depth = (chorus ? 0.008 : 0.0035) * param * sr;
            float fb = chorus ? 0 : 0.6f;
            for (int i = 0; i < n; i++) {
                ph += f / sr; if (ph >= 1) ph -= 1;
                double ml = Math.sin(2 * Math.PI * ph), mr = chorus ? Math.sin(2 * Math.PI * (ph + 0.25)) : ml;
                float yl = dl.read(Math.max(1, base + depth * ml)), yr = dr.read(Math.max(1, base + depth * mr));
                dl.write(L[i] + yl * fb); dr.write(R[i] + yr * fb);
                L[i] = yl; R[i] = yr;
            }
        }
    }

    static final class Phaser extends Effect {
        final double[] xl = new double[6], yl = new double[6], xr = new double[6], yr = new double[6];
        double ph, a, fbl, fbr;
        Phaser(int sr) { super(sr); }
        @Override void process(float[] L, float[] R, int n) {
            double f = 1.0 / (beat * 4);
            for (int i = 0; i < n; i++) {
                ph += f / sr; if (ph >= 1) ph -= 1;
                if ((i & 15) == 0) {
                    double fc = Math.max(80, 700 + 650 * param * Math.sin(2 * Math.PI * ph));
                    double t = Math.tan(Math.PI * fc / sr); a = (t - 1) / (t + 1);
                }
                double sl = L[i] + fbl * 0.5, sr2 = R[i] + fbr * 0.5;
                for (int s = 0; s < 6; s++) {
                    double y = a * sl + xl[s] - a * yl[s]; xl[s] = sl; yl[s] = y; sl = y;
                    y = a * sr2 + xr[s] - a * yr[s]; xr[s] = sr2; yr[s] = y; sr2 = y;
                }
                fbl = sl; fbr = sr2;
                L[i] = (float) sl; R[i] = (float) sr2;
            }
        }
    }

    /* ---------------- modulation / filters ---------------- */
    static final class Gate extends Effect {
        final boolean square; double ph; float g = 1;
        Gate(int sr, boolean square) { super(sr); this.square = square; }
        @Override void process(float[] L, float[] R, int n) {
            double f = 1.0 / beat; float k = (float) (1 - Math.exp(-1.0 / (0.002 * sr)));
            for (int i = 0; i < n; i++) {
                ph += f / sr; if (ph >= 1) ph -= 1;
                float m = square ? (ph < 0.5 ? 1f : -1f) : (float) Math.sin(2 * Math.PI * ph);
                float target = 1 - param * 0.5f + 0.5f * param * m;
                g += (target - g) * (square ? k : 1);
                L[i] *= g; R[i] *= g;
            }
        }
    }

    static final class AutoFilter extends Effect {
        final Svf f; double ph;
        AutoFilter(int sr) { super(sr); f = new Svf(sr); }
        @Override void process(float[] L, float[] R, int n) {
            double fr = 1.0 / (beat * 2);
            for (int i = 0; i < n; i++) {
                ph += fr / sr; if (ph >= 1) ph -= 1;
                if ((i & 15) == 0) { double tri = 1 - 4 * Math.abs(ph - 0.5); f.set(1500 + 1400 * tri, 0.7 + param * 14); }
                L[i] = f.tickL(L[i], 0); R[i] = f.tickR(R[i], 0);
            }
        }
    }

    static final class Wah extends Effect {
        final Svf f; double lf = Math.log(1000);
        Wah(int sr) { super(sr); f = new Svf(sr); }
        @Override void process(float[] L, float[] R, int n) {
            double target = Math.log(Dsp.expMap(300, 3500, param));
            for (int i = 0; i < n; i++) {
                if ((i & 15) == 0) { lf += (target - lf) * 0.08; f.set(Math.exp(lf), 5); }
                L[i] = f.tickL(L[i], 1) * 2.5f; R[i] = f.tickR(R[i], 1) * 2.5f;
            }
        }
    }

    static final class Filter extends Effect {
        final boolean low; final Svf f; double lf;
        Filter(int sr, boolean low) { super(sr); this.low = low; f = new Svf(sr); lf = Math.log(low ? 20000 : 20); }
        @Override void process(float[] L, float[] R, int n) {
            double target = Math.log(low ? Dsp.expMap(20000, 120, param) : Dsp.expMap(20, 6000, param));
            int mode = low ? 0 : 2;
            for (int i = 0; i < n; i++) {
                if ((i & 15) == 0) { lf += (target - lf) * 0.08; f.set(Math.exp(lf), 4); }
                L[i] = f.tickL(L[i], mode); R[i] = f.tickR(R[i], mode);
            }
        }
    }

    static final class Crush extends Effect {
        float hl, hr; int count; float bits = 8, red = 4;
        Crush(int sr) { super(sr); }
        @Override void process(float[] L, float[] R, int n) {
            float step = (float) Math.pow(0.5, 16 - param * 13); int r = Math.max(1, Math.round(1 + param * 20));
            for (int i = 0; i < n; i++) {
                if (count++ % r == 0) { hl = step * Math.round(L[i] / step); hr = step * Math.round(R[i] / step); }
                L[i] = hl; R[i] = hr;
            }
        }
    }

    static final class Distortion extends Effect {
        Distortion(int sr) { super(sr); }
        @Override void process(float[] L, float[] R, int n) {
            float pre = 1 + param * 12, post = 0.7f / (1 + param * 3);
            for (int i = 0; i < n; i++) { L[i] = (float) Math.tanh(L[i] * pre * 3) * post; R[i] = (float) Math.tanh(R[i] * pre * 3) * post; }
        }
    }

    static final class LoFi extends Effect {
        final Svf bp, hp; final Noise noise = new Noise(); double ph; float hl, hr; int count;
        LoFi(int sr) { super(sr); bp = new Svf(sr); hp = new Svf(sr); hp.set(3000, 0.7); }
        @Override void process(float[] L, float[] R, int n) {
            float step = (float) Math.pow(0.5, 12 - param * 6);
            for (int i = 0; i < n; i++) {
                ph += 0.6 / sr; if (ph >= 1) ph -= 1;
                if ((i & 15) == 0) bp.set(1500 + 300 * Math.sin(2 * Math.PI * ph), 0.5 + param * 2);
                float l = bp.tickL(L[i], 1), r = bp.tickR(R[i], 1);
                if (count++ % 3 == 0) { hl = step * Math.round(l / step); hr = step * Math.round(r / step); }
                float c = hp.tickL(noise.next(), 2) * param * 0.04f;
                if (noise.next() > 0.9996f) c += 0.3f * param;
                L[i] = hl * 1.6f + c; R[i] = hr * 1.6f + c;
            }
        }
    }

    static final class AutoPan extends Effect {
        double ph;
        AutoPan(int sr) { super(sr); }
        @Override void process(float[] L, float[] R, int n) {
            double f = 1.0 / (beat * 2);
            for (int i = 0; i < n; i++) {
                ph += f / sr; if (ph >= 1) ph -= 1;
                float p = (float) Math.sin(2 * Math.PI * ph) * param;
                L[i] *= Math.min(1, 1 - p); R[i] *= Math.min(1, 1 + p);
            }
        }
    }

    static final class RingMod extends Effect {
        double ph, f = 400;
        RingMod(int sr) { super(sr); }
        @Override void process(float[] L, float[] R, int n) {
            double target = Dsp.expMap(30, 2000, param);
            for (int i = 0; i < n; i++) {
                f += (target - f) * 0.001;
                ph += f / sr; if (ph >= 1) ph -= 1;
                float m = (float) Math.sin(2 * Math.PI * ph);
                L[i] *= m; R[i] *= m;
            }
        }
    }

    static final class Pitch extends Effect {
        final PitchShifter ps;
        Pitch(int sr) { super(sr); ps = new PitchShifter(sr); }
        @Override void process(float[] L, float[] R, int n) {
            int semis = Math.round((param - 0.5f) * 24);
            ps.ratio = Math.pow(2, semis / 12.0);
            ps.process(L, R, n);
        }
    }

    static final class NoiseSweep extends Effect {
        final Svf f; final Noise nl = new Noise(), nr = new Noise(); double lf = Math.log(1000);
        NoiseSweep(int sr) { super(sr); f = new Svf(sr); nr.s = 0x7654321; }
        @Override void process(float[] L, float[] R, int n) {
            double target = Math.log(Dsp.expMap(200, 12000, param));
            for (int i = 0; i < n; i++) {
                if ((i & 15) == 0) { lf += (target - lf) * 0.08; f.set(Math.exp(lf), 2); }
                L[i] += f.tickL(nl.next(), 1) * 0.35f; R[i] += f.tickR(nr.next(), 1) * 0.35f;
            }
        }
    }

    /** "Spiral": echo whose repeats climb in pitch. */
    static final class Spiral extends Effect {
        final DelayLine dl, dr; final PitchShifter ps; double d, dT;
        Spiral(int sr) { super(sr); dl = new DelayLine(sr * 4 + 8); dr = new DelayLine(sr * 4 + 8); ps = new PitchShifter(sr); ps.ratio = 1.06; d = dT = 0.25 * sr; }
        @Override void setBeat(float s) { super.setBeat(s); dT = Math.min(3.9, s / 2) * sr; }
        @Override void process(float[] L, float[] R, int n) {
            float fb = param * 0.9f; double k = 1.0 / (0.05 * sr);
            for (int i = 0; i < n; i++) {
                d += (dT - d) * k;
                float yl = dl.read(d), yr = dr.read(d);
                ps.tick(yl, yr);
                dl.write(L[i] + ps.oL * fb); dr.write(R[i] + ps.oR * fb);
                L[i] = yl; R[i] = yr;
            }
        }
    }

    static final class Punch extends Effect {
        double env; final double att, rel;
        Punch(int sr) { super(sr); att = 1 - Math.exp(-1.0 / (0.01 * sr)); rel = 1 - Math.exp(-1.0 / (0.12 * sr)); }
        @Override void process(float[] L, float[] R, int n) {
            double thr = -6 - param * 30, ratio = 2 + param * 10, makeup = 1 + param * 2;
            for (int i = 0; i < n; i++) {
                double x = Math.max(Math.abs(L[i]), Math.abs(R[i]));
                env += (x - env) * (x > env ? att : rel);
                double edb = 20 * Math.log10(env + 1e-9), gdb = edb > thr ? (thr + (edb - thr) / ratio) - edb : 0;
                float g = (float) (Math.pow(10, gdb / 20) * makeup);
                L[i] *= g; R[i] *= g;
            }
        }
    }

    static final class Stereo extends Effect {
        final DelayLine dr; double d;
        Stereo(int sr) { super(sr); dr = new DelayLine((int) (0.03 * sr)); }
        @Override void process(float[] L, float[] R, int n) {
            double target = param * 0.025 * sr;
            for (int i = 0; i < n; i++) {
                d += (target - d) * 0.001;
                float y = dr.read(Math.max(1, d)); dr.write(R[i]); R[i] = y;
            }
        }
    }
}
