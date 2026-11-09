package com.djfree.app.audio;

/**
 * Applies UI commands to the engine. Commands are tiny key/value messages (JSON on Android);
 * effects are constructed here on the caller's thread and swapped in on the audio thread.
 */
public final class Control {
    /** Read-only view of one command message. */
    public interface Msg {
        String str(String k);
        double num(String k, double def);
        boolean bool(String k);
        boolean has(String k);
        Msg obj(String k);
    }

    private final AudioEngine e;

    public Control(AudioEngine e) { this.e = e; }

    public void dispatch(Msg m) {
        final String c = m.str("c");
        final int di = (int) m.num("d", 0);
        final Deck d = e.decks[Math.max(0, Math.min(1, di))];
        switch (c) {
            case "p": player(d, m.obj("m")); break;
            case "eq": { int band = (int) m.num("band", 0); double db = m.num("db", 0); e.post(() -> d.setEq(band, db)); break; }
            case "trim": { float v = (float) m.num("v", 1); e.post(() -> d.trim.set(v, 0.02f)); break; }
            case "vol": { float v = (float) m.num("v", 0.72); e.post(() -> d.fader.set(v, 0.01f)); break; }
            case "flt": { double lp = m.num("lp", 22000), hp = m.num("hp", 10), q = m.num("q", 0.7);
                e.post(() -> { d.lpT = lp; d.hpT = hp; d.lpQ = lp < 20000 ? q : 0.7; d.hpQ = hp > 12 ? q : 0.7; }); break; }
            case "cue": { boolean on = m.bool("on"); e.post(() -> d.cue.set(on ? 1 : 0, 0.01f)); break; }
            case "shift": { double r = m.num("ratio", 1); e.post(() -> d.shiftRatio = Math.max(0.5, Math.min(2, r))); break; }
            case "xf": { float a = (float) m.num("a", 1), b = (float) m.num("b", 1);
                e.post(() -> { e.decks[0].xf.set(a, 0.008f); e.decks[1].xf.set(b, 0.008f); }); break; }
            case "fx": {
                int s = (int) m.num("s", 0); String type = m.str("type");
                Effects.Effect fx = type == null || type.isEmpty() ? null : Effects.create(type, e.sr);
                boolean ins = fx != null && Effects.isInsert(type);
                e.post(() -> d.fx[s].setEffect(fx, ins)); break;
            }
            case "fxon": { int s = (int) m.num("s", 0); boolean on = m.bool("on"); e.post(() -> d.fx[s].setOn(on)); break; }
            case "fxwet": { int s = (int) m.num("s", 0); float v = (float) m.num("v", 0.5); e.post(() -> d.fx[s].setWet(v)); break; }
            case "fxprm": { int s = (int) m.num("s", 0); float v = (float) m.num("v", 0.5); e.post(() -> d.fx[s].setParam(v)); break; }
            case "fxbeat": { int s = (int) m.num("s", 0); float v = (float) m.num("v", 0.5); e.post(() -> d.fx[s].setBeat(v)); break; }
            case "send": { float v = (float) m.num("v", 0), tc = (float) m.num("tc", 0); e.post(() -> d.send.set(v, tc)); break; }
            case "sendfx": {
                final boolean hd = m.has("delay"), hf = m.has("fb"), hr = m.has("rev");
                final double delay = m.num("delay", 0.375); final float fb = (float) m.num("fb", 0.55), rev = (float) m.num("rev", 0), rtc = (float) m.num("revTc", 0);
                e.post(() -> {
                    if (hd) d.sDelayT = Math.min(3.9, Math.max(0.01, delay)) * e.sr;
                    if (hf) d.sFb = Math.min(0.95f, fb);
                    if (hr) d.revIn.set(rev, rtc);
                });
                break;
            }
            case "mvol": { float v = (float) m.num("v", 1); e.post(() -> e.setMasterVolume(v)); break; }
            case "limiter": { boolean on = m.bool("on"); e.post(() -> e.setLimiter(on)); break; }
            case "split": { boolean on = m.bool("on"); e.post(() -> e.setSplit(on)); break; }
            case "smp": { int i = (int) m.num("i", 0); e.post(() -> e.trigger(i)); break; }
            case "smpvol": { float v = (float) m.num("v", 0.7); e.post(() -> e.setSamplerVolume(v)); break; }
            default: break;
        }
    }

    private void player(Deck d, Msg m) {
        if (m == null) return;
        final DeckPlayer p = d.player;
        final String type = m.str("type");
        switch (type) {
            case "play": {
                final double at = m.num("at", -1);
                e.post(() -> p.play(at > 0 ? (long) (at * e.sr) : -1, e.nowFrame())); break;
            }
            case "pause": e.post(p::pause); break;
            case "seek": { double pos = m.num("pos", 0); boolean st = m.bool("slipToo"); e.post(() -> p.seek(pos, st)); break; }
            case "rate": { double v = m.num("value", 1); e.post(() -> p.rate = v); break; }
            case "reverse": { boolean on = m.bool("on"); e.post(() -> p.setReverse(on)); break; }
            case "loop": { boolean on = m.bool("on"), jump = m.bool("jump"); double a = m.num("a", 0), b = m.num("b", 0); e.post(() -> p.setLoop(on, a, b, jump)); break; }
            case "roll": { boolean on = m.bool("on"); double a = m.num("a", 0), b = m.num("b", 0); e.post(() -> p.roll(on, a, b)); break; }
            case "slip": { boolean on = m.bool("on"); e.post(() -> p.slip = on); break; }
            case "scratch": { boolean on = m.bool("on"); e.post(() -> p.setScratch(on)); break; }
            case "scratchVel": { double v = m.num("v", 0); e.post(() -> p.scratchVel = v); break; }
            case "brake": { double dur = m.num("dur", 1.2); e.post(() -> p.brake(dur)); break; }
            case "spin": { double dur = m.num("dur", 1.4); e.post(() -> p.spin(dur)); break; }
            case "unload": e.post(p::unload); break;
            default: break;
        }
    }

    /** Puts a decoded track on a deck (audio thread swap). */
    public void load(int deck, Track t) {
        final Deck d = e.decks[deck];
        e.post(() -> d.player.load(t));
    }
}
