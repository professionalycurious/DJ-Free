package com.djfree.app.audio;

/**
 * One mixer channel: player -> key lock -> gain -> 3-band EQ -> filter -> 3 FX slots ->
 * (fader -> crossfader -> master) + (cue bus) + (echo/reverb wash send -> master).
 */
public final class Deck {
    final int sr;
    final DeckPlayer player;
    final PitchShifter shifter;
    final Dsp.Biquad eqL, eqM, eqH;
    final Dsp.Svf lp, hp;
    final FxSlot[] fx = new FxSlot[3];
    private final Dsp.Biquad[] eqs;
    final Dsp.Smooth trim, fader, xf, cue, send, revIn;
    final Dsp.DelayLine sdl, sdr;
    final Effects.Freeverb srev;
    double shiftRatio = 1;
    final double[] eqT = new double[3], eqC = new double[3];
    double lpT = 22000, hpT = 10, lpQ = 0.7, hpQ = 0.7, lpC = Math.log(22000), hpC = Math.log(10);
    double sDelay, sDelayT;
    float sFb = 0.55f;
    private int sendHold, revHold;
    private final float[] bl = new float[AudioEngine.MAX_BLOCK], br = new float[AudioEngine.MAX_BLOCK];
    private final float[] tl = new float[AudioEngine.MAX_BLOCK], tr = new float[AudioEngine.MAX_BLOCK];

    // published for the UI thread
    public volatile double posSec, slipSec = -1;
    public volatile float speed, level;
    public volatile boolean playing;
    public volatile int ended;
    private float peak;

    Deck(int sr) {
        this.sr = sr;
        player = new DeckPlayer(sr);
        shifter = new PitchShifter(sr);
        eqL = new Dsp.Biquad(sr); eqM = new Dsp.Biquad(sr); eqH = new Dsp.Biquad(sr);
        eqs = new Dsp.Biquad[]{eqL, eqM, eqH};
        lp = new Dsp.Svf(sr); hp = new Dsp.Svf(sr);
        for (int i = 0; i < 3; i++) fx[i] = new FxSlot(sr);
        trim = new Dsp.Smooth(1, sr); fader = new Dsp.Smooth(0.72f, sr); xf = new Dsp.Smooth(1, sr);
        cue = new Dsp.Smooth(0, sr); send = new Dsp.Smooth(0, sr); revIn = new Dsp.Smooth(0, sr);
        sdl = new Dsp.DelayLine(sr * 4 + 8); sdr = new Dsp.DelayLine(sr * 4 + 8);
        sDelay = sDelayT = 0.375 * sr;
        srev = new Effects.Freeverb(sr); srev.room = 0.9f; srev.damp = 0.3f;
    }

    void setEq(int band, double db) { eqT[band] = db; }

    void render(float[] mL, float[] mR, float[] cL, float[] cR, int n, long frame) {
        player.render(bl, br, n, frame);
        shifter.ratio = shiftRatio;
        shifter.process(bl, br, n);

        // EQ (coefficients updated per block with smoothing)
        for (int i = 0; i < n; i++) { float g = trim.next(); bl[i] *= g; br[i] *= g; }
        for (int b = 0; b < 3; b++) {
            double c = eqC[b], t = eqT[b];
            if (Math.abs(c - t) > 1e-3) {
                c = Math.abs(t - c) < 0.05 ? t : c + (t - c) * 0.35;
                eqC[b] = c;
                eqs[b].set(b, b == 0 ? 180 : b == 1 ? 1100 : 4500, b == 1 ? 0.6 : 0.7, c);
            }
            if (Math.abs(c) > 0.01) eqs[b].process(bl, br, n);
        }

        // DJ filter (LPF left / HPF right of centre)
        double lpTarget = Math.log(lpT), hpTarget = Math.log(hpT);
        boolean lpOn = lpT < 20000 || lpC < Math.log(20000), hpOn = hpT > 12 || hpC > Math.log(12);
        if (lpOn || hpOn) {
            for (int i = 0; i < n; i++) {
                if ((i & 15) == 0) {
                    lpC += (lpTarget - lpC) * 0.06; hpC += (hpTarget - hpC) * 0.06;
                    lp.set(Math.exp(lpC), lpQ); hp.set(Math.exp(hpC), hpQ);
                }
                float l = bl[i], r = br[i];
                if (lpOn) { l = lp.tickL(l, 0); r = lp.tickR(r, 0); }
                if (hpOn) { l = hp.tickL(l, 2); r = hp.tickR(r, 2); }
                bl[i] = l; br[i] = r;
            }
        }

        for (FxSlot s : fx) s.process(bl, br, n);

        // wash send (echo + reverb), output survives the channel fader
        boolean sendActive = send.target > 0 || send.cur > 1e-5f;
        if (sendActive) sendHold = 10 * sr; else sendHold -= n;
        if (sendHold > 0) {
            double k = 1.0 / (0.05 * sr);
            for (int i = 0; i < n; i++) {
                float s = send.next();
                sDelay += (sDelayT - sDelay) * k;
                float yl = sdl.read(sDelay), yr = sdr.read(sDelay);
                sdl.write(bl[i] * s + yl * sFb); sdr.write(br[i] * s + yr * sFb);
                mL[i] += yl; mR[i] += yr;
                tl[i] = bl[i] * s; tr[i] = br[i] * s;
            }
            boolean revActive = revIn.target > 0 || revIn.cur > 1e-5f;
            if (revActive) revHold = 8 * sr; else revHold -= n;
            if (revHold > 0) {
                for (int i = 0; i < n; i++) { float g = revIn.next() * 4f; tl[i] *= g; tr[i] *= g; }
                srev.process(tl, tr, n, 1f);
                for (int i = 0; i < n; i++) { mL[i] += tl[i]; mR[i] += tr[i]; }
            }
        }

        float pk = 0;
        for (int i = 0; i < n; i++) {
            float c = cue.next();
            if (c > 0) { cL[i] += bl[i] * c; cR[i] += br[i] * c; }
            float f = fader.next();
            float l = bl[i] * f, r = br[i] * f;
            float a = Math.abs(l); if (a > pk) pk = a;
            float x = xf.next();
            mL[i] += l * x; mR[i] += r * x;
        }
        peak = Math.max(pk, peak * 0.85f);
        level = peak;
        posSec = player.posSec();
        slipSec = player.slipSec();
        speed = (float) player.cur;
        playing = player.playing || player.startAt >= 0;
        ended = player.endedCount;
    }
}
