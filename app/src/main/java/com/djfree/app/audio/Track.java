package com.djfree.app.audio;

/** Decoded audio: interleaved stereo 16-bit PCM at the file's own sample rate. */
public final class Track {
    public final String id;
    public final short[] pcm;
    public final int frames;
    public final int rate;

    public Track(String id, short[] pcm, int frames, int rate) {
        this.id = id;
        this.pcm = pcm;
        this.frames = frames;
        this.rate = rate;
    }

    public double durationSec() { return frames / (double) rate; }

    /** Cubic hermite interpolated sample of channel ch (0/1) at fractional frame p, range -1..1. */
    float sample(int ch, double p) {
        final int i = (int) p;
        final float f = (float) (p - i);
        final short[] d = pcm;
        final int n = frames;
        final float xm1 = i > 0 ? d[(i - 1) * 2 + ch] : d[ch];
        final float x0 = i < n ? d[i * 2 + ch] : 0;
        final float x1 = i + 1 < n ? d[(i + 1) * 2 + ch] : 0;
        final float x2 = i + 2 < n ? d[(i + 2) * 2 + ch] : 0;
        final float c = (x1 - xm1) * 0.5f, v = x0 - x1, w = c + v, a = w + v + (x2 - x0) * 0.5f, b = w + a;
        return ((((a * f) - b) * f + c) * f + x0) * (1f / 32768f);
    }
}
