package com.djfree.app.audio;

/**
 * One FX slot. Insert effects crossfade dry/wet. Time-based (send) effects keep the dry signal,
 * add the wet on top, and let their tail ring out after being switched off.
 */
final class FxSlot {
    private final int sr;
    Effects.Effect fx;
    boolean insert, on;
    float wet = 0.5f, param = 0.5f, beat = 0.5f;
    private final Dsp.Smooth dry, wetG, feed;
    private int hold;
    private final float[] wl = new float[AudioEngine.MAX_BLOCK], wr = new float[AudioEngine.MAX_BLOCK];

    FxSlot(int sr) {
        this.sr = sr;
        dry = new Dsp.Smooth(1, sr); wetG = new Dsp.Smooth(0, sr); feed = new Dsp.Smooth(0, sr);
        dry.set(1, 0.02f); wetG.set(0, 0.02f); feed.set(0, 0.02f);
    }

    void setEffect(Effects.Effect e, boolean ins) {
        fx = e; insert = ins;
        if (e != null) { e.setParam(param); e.setBeat(beat); }
        apply();
    }
    void setOn(boolean v) { on = v; apply(); }
    void setWet(float v) { wet = v; apply(); }
    void setParam(float v) { param = v; if (fx != null) fx.setParam(v); }
    void setBeat(float s) { beat = s; if (fx != null) fx.setBeat(s); }

    private void apply() {
        boolean active = on && fx != null;
        if (insert) {
            wetG.set(active ? wet : 0, 0.02f); dry.set(active ? 1 - wet : 1, 0.02f); feed.set(1, 0);
        } else {
            dry.set(1, 0.02f); feed.set(active ? 1 : 0, 0.01f); wetG.set(fx != null ? wet * 0.9f : 0, 0.02f);
        }
    }

    void process(float[] L, float[] R, int n) {
        final Effects.Effect e = fx;
        if (e == null) return;
        if (insert) {
            if (wetG.idleAt(0) && dry.idleAt(1)) return;
            System.arraycopy(L, 0, wl, 0, n); System.arraycopy(R, 0, wr, 0, n);
            e.process(wl, wr, n);
            for (int i = 0; i < n; i++) {
                float d = dry.next(), w = wetG.next();
                L[i] = L[i] * d + wl[i] * w; R[i] = R[i] * d + wr[i] * w;
            }
        } else {
            if (on) hold = 8 * sr; else hold -= n;
            if (hold <= 0 && feed.idleAt(0)) return;
            for (int i = 0; i < n; i++) { float f = feed.next(); wl[i] = L[i] * f; wr[i] = R[i] * f; }
            e.process(wl, wr, n);
            for (int i = 0; i < n; i++) { float w = wetG.next(); L[i] += wl[i] * w; R[i] += wr[i] * w; }
        }
    }
}
