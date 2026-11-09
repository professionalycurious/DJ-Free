package com.djfree.app.audio;

/**
 * Track player: variable / negative speed, scratch, brake, spinback, loops,
 * loop roll with slip, sample-accurate scheduled start. Runs on the audio thread only.
 */
final class DeckPlayer {
    static final int NORMAL = 0, SCRATCH = 1, BRAKE = 2, SPIN = 3;

    private final int outRate;
    Track t;
    double pos;              // source frames
    boolean playing;
    double rate = 1, cur = 0;
    int mode = NORMAL;
    double scratchVel;
    double modeT, modeDur = 1, modeFrom = 1;
    boolean reverse, loopOn, slip, slipActive;
    double loopA, loopB, slipPos;
    long startAt = -1;
    float declick = 1;
    int endedCount;

    DeckPlayer(int outRate) { this.outRate = outRate; }

    void load(Track track) {
        t = track; pos = 0; playing = false; loopOn = false; mode = NORMAL; cur = 0;
        slipActive = false; startAt = -1; reverse = false;
    }

    void unload() { t = null; playing = false; startAt = -1; }

    void play(long atFrame, long nowFrame) {
        if (atFrame > nowFrame) startAt = atFrame; else { playing = true; startAt = -1; }
        if (mode == BRAKE || mode == SPIN) mode = NORMAL;
        declick = 0;
    }

    void pause() { playing = false; startAt = -1; }

    void seek(double sec, boolean slipToo) {
        if (t == null) return;
        double p = Math.max(0, Math.min(t.frames - 1, sec * t.rate));
        if (slipActive) slipPos = p; else pos = p;
        if (slipToo) slipPos = p;
        declick = 0;
    }

    void setLoop(boolean on, double a, double b, boolean jump) {
        loopOn = on;
        if (on && t != null) {
            loopA = a * t.rate; loopB = b * t.rate;
            if (jump) { pos = loopA; declick = 0; }
        }
    }

    void roll(boolean on, double a, double b) {
        if (t == null) return;
        if (on) {
            slipPos = pos; slipActive = true;
            loopA = a * t.rate; loopB = b * t.rate; loopOn = true;
            pos = loopA; declick = 0;
        } else {
            loopOn = false; endSlip();
        }
    }

    void setReverse(boolean on) { reverse = on; syncSlip(on); }

    void setScratch(boolean on) {
        if (on) { mode = SCRATCH; scratchVel = 0; syncSlip(true); }
        else { mode = NORMAL; syncSlip(false); }
    }

    void brake(double dur) { mode = BRAKE; modeT = 0; modeDur = dur * outRate; modeFrom = cur != 0 ? cur : rate; }

    void spin(double dur) {
        mode = SPIN; modeT = 0; modeDur = dur * outRate;
        modeFrom = -Math.max(2.5, Math.abs(cur) * 3); playing = true;
    }

    private void syncSlip(boolean on) {
        if (!slip) return;
        if (on && !slipActive) { slipPos = pos; slipActive = true; }
        else if (!on) endSlip();
    }

    private void endSlip() {
        if (slipActive) { pos = slipPos; slipActive = false; declick = 0; }
    }

    double posSec() { return t == null ? 0 : pos / t.rate; }
    double slipSec() { return t == null || !slipActive ? -1 : slipPos / t.rate; }

    void render(float[] L, float[] R, int n, long frame) {
        final Track tr = t;
        if (tr == null) {
            for (int i = 0; i < n; i++) { L[i] = 0; R[i] = 0; }
            return;
        }
        final double ratio = (double) tr.rate / outRate;
        final double kScr = 1 - Math.exp(-1.0 / (0.0011 * outRate));   // ~ JS 0.02 / sample @ 44.1k
        final double kNorm = 1 - Math.exp(-1.0 / (0.0023 * outRate));  // ~ JS 0.01 / sample @ 44.1k
        final float declickStep = 1f / (0.002f * outRate);
        final int last = tr.frames - 1;
        for (int i = 0; i < n; i++) {
            if (startAt >= 0 && frame + i >= startAt) { playing = true; startAt = -1; declick = 0; }
            double target;
            if (mode == SCRATCH) target = scratchVel;
            else if (mode == BRAKE) {
                double tt = modeT++ / modeDur;
                target = modeFrom * Math.max(0, 1 - tt);
                if (tt >= 1) { playing = false; mode = NORMAL; target = 0; cur = 0; }
            } else if (mode == SPIN) {
                double tt = modeT++ / modeDur;
                target = modeFrom * Math.max(0, 1 - tt) * (1 - tt);
                if (tt >= 1) { playing = false; mode = NORMAL; target = 0; cur = 0; }
            } else target = playing ? (reverse ? -rate : rate) : 0;

            if (mode == SCRATCH) cur += (target - cur) * kScr;
            else if (mode == NORMAL) cur += (target - cur) * kNorm;
            else cur = target;
            if (!playing && mode == NORMAL && Math.abs(cur) < 1e-4) cur = 0;

            float sl = 0, sr = 0;
            if (cur != 0 && pos >= 0 && pos < last) { sl = tr.sample(0, pos); sr = tr.sample(1, pos); }
            if (declick < 1) { declick = Math.min(1, declick + declickStep); sl *= declick; sr *= declick; }
            L[i] = sl; R[i] = sr;

            pos += cur * ratio;
            if (slipActive) slipPos += (playing ? rate : 0) * ratio;
            if (loopOn && loopB > loopA) {
                if (cur > 0 && pos >= loopB) pos = loopA + (pos - loopB);
                else if (cur < 0 && pos < loopA) pos = loopB - (loopA - pos);
            }
            if (pos < 0) { pos = 0; if (mode != SCRATCH) cur = 0; }
            if (pos >= last) {
                pos = last;
                if (playing && mode == NORMAL) { playing = false; endedCount++; }
            }
        }
    }
}
