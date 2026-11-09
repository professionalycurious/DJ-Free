package com.djfree.app.audio;

import java.util.concurrent.ConcurrentLinkedQueue;

/**
 * The native DJ mixer. Pure Java (no Android APIs) so it can be tested on a desktop JVM.
 * All state changes arrive as Runnables through {@link #post} and run on the audio thread
 * at the start of the next block.
 */
public final class AudioEngine {
    public static final int MAX_BLOCK = 512;

    public interface Tap { void onBlock(float[] L, float[] R, int n); }

    public final int sr;
    public final Deck[] decks;
    private final ConcurrentLinkedQueue<Runnable> queue = new ConcurrentLinkedQueue<>();
    private final float[] mL = new float[MAX_BLOCK], mR = new float[MAX_BLOCK], cL = new float[MAX_BLOCK], cR = new float[MAX_BLOCK];
    private final Dsp.Smooth mvol;
    boolean limiter = true, split = false;
    private float limGain = 1, peak;
    private final float limRel;
    // sampler
    private final Track[] samples = new Track[16];
    private final Track[] vTrack = new Track[24];
    private final double[] vPos = new double[24];
    private final Dsp.Smooth sVol;
    public volatile Tap tap;

    long frame;
    public volatile double timeSec;
    public volatile float masterLevel;

    public AudioEngine(int sr) {
        this.sr = sr;
        decks = new Deck[]{new Deck(sr), new Deck(sr)};
        mvol = new Dsp.Smooth(0.96f, sr);
        sVol = new Dsp.Smooth(0.7f, sr);
        limRel = (float) (1 - Math.exp(-1.0 / (0.12 * sr)));
        // built-in test tone (sample slot 15)
        int len = (int) (0.8 * sr);
        short[] pcm = new short[len * 2];
        for (int i = 0; i < len; i++) {
            double t = i / (double) sr, env = Math.min(1, t / 0.01) * Math.exp(-t * 4);
            short v = (short) (Math.sin(2 * Math.PI * 440 * t) * env * 0.45 * 32767);
            pcm[i * 2] = v; pcm[i * 2 + 1] = v;
        }
        samples[15] = new Track("tone", pcm, len, sr);
    }

    public void post(Runnable r) { queue.add(r); }

    public long nowFrame() { return frame; }

    /* -------- called on the audio thread through post() -------- */
    public void setMasterVolume(float v) { mvol.set(v, 0.02f); }
    public void setLimiter(boolean on) { limiter = on; }
    public void setSplit(boolean on) { split = on; }
    public void setSample(int i, Track t) { if (i >= 0 && i < samples.length) samples[i] = t; }
    public void setSamplerVolume(float v) { sVol.set(v, 0.02f); }
    public void trigger(int i) {
        if (i < 0 || i >= samples.length || samples[i] == null) return;
        for (int v = 0; v < vTrack.length; v++) if (vTrack[v] == null) { vTrack[v] = samples[i]; vPos[v] = 0; return; }
        vTrack[0] = samples[i]; vPos[0] = 0;
    }

    /** Renders n (<= MAX_BLOCK) frames into L/R. */
    public void render(float[] outL, float[] outR, int n) {
        Runnable r;
        while ((r = queue.poll()) != null) {
            try { r.run(); } catch (Throwable ignored) { /* never kill the audio thread */ }
        }
        for (int i = 0; i < n; i++) { mL[i] = 0; mR[i] = 0; cL[i] = 0; cR[i] = 0; }
        for (Deck d : decks) d.render(mL, mR, cL, cR, n, frame);

        // sampler voices
        for (int v = 0; v < vTrack.length; v++) {
            Track t = vTrack[v]; if (t == null) continue;
            double step = (double) t.rate / sr, p = vPos[v];
            for (int i = 0; i < n; i++) {
                if (p >= t.frames - 1) { vTrack[v] = null; break; }
                float g = sVol.cur;
                mL[i] += t.sample(0, p) * g; mR[i] += t.sample(1, p) * g;
                p += step;
            }
            vPos[v] = p;
        }
        for (int i = 0; i < n; i++) sVol.next();

        float pk = 0;
        for (int i = 0; i < n; i++) {
            float g = mvol.next();
            float l = mL[i] * g, rr = mR[i] * g;
            if (limiter) {
                float a = Math.max(Math.abs(l), Math.abs(rr)) * limGain;
                if (a > 0.89f) limGain *= 0.89f / a; else limGain += (1 - limGain) * limRel;
                l *= limGain; rr *= limGain;
                l = soft(l); rr = soft(rr);
            } else { l = Math.max(-1, Math.min(1, l)); rr = Math.max(-1, Math.min(1, rr)); }
            float a = Math.max(Math.abs(l), Math.abs(rr)); if (a > pk) pk = a;
            if (split) {
                outL[i] = (l + rr) * 0.5f;
                outR[i] = soft((cL[i] + cR[i]) * 0.5f);
            } else { outL[i] = l; outR[i] = rr; }
        }
        peak = Math.max(pk, peak * 0.9f);
        masterLevel = peak;
        Tap t = tap;
        if (t != null) t.onBlock(split ? mL : outL, split ? mR : outR, n);
        frame += n;
        timeSec = frame / (double) sr;
    }

    private static float soft(float x) {
        if (x > 0.95f) return 0.95f + 0.05f * (float) Math.tanh((x - 0.95f) * 20);
        if (x < -0.95f) return -0.95f + 0.05f * (float) Math.tanh((x + 0.95f) * 20);
        return x;
    }
}
