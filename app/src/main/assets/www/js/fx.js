/* Effect library. Every effect exposes:
 *   input, output (GainNodes), setOn(bool), setWet(0..1), setParam(0..1), setBeat(seconds), dispose()
 * Wet/dry is handled by the FxUnit wrapper so the dry signal is always clean.
 */

export const FX_LIST = [
  { id: 'echo', name: 'Echo', param: 'Fdbk', synced: true },
  { id: 'pingpong', name: 'Ping Pong', param: 'Fdbk', synced: true },
  { id: 'reverb', name: 'Reverb', param: 'Size', synced: false },
  { id: 'flanger', name: 'Flanger', param: 'Depth', synced: true },
  { id: 'phaser', name: 'Phaser', param: 'Depth', synced: true },
  { id: 'chorus', name: 'Chorus', param: 'Depth', synced: false },
  { id: 'gate', name: 'Trance Gate', param: 'Depth', synced: true },
  { id: 'autofilter', name: 'Auto Filter', param: 'Reso', synced: true },
  { id: 'wah', name: 'Wah', param: 'Freq', synced: false },
  { id: 'lpf', name: 'LP Filter', param: 'Cutoff', synced: false },
  { id: 'hpf', name: 'HP Filter', param: 'Cutoff', synced: false },
  { id: 'bitcrush', name: 'Bitcrusher', param: 'Bits', synced: false },
  { id: 'distortion', name: 'Distortion', param: 'Drive', synced: false },
  { id: 'lofi', name: 'Lo-Fi', param: 'Age', synced: false },
  { id: 'autopan', name: 'Auto Pan', param: 'Width', synced: true },
  { id: 'tremolo', name: 'Tremolo', param: 'Depth', synced: true },
  { id: 'ringmod', name: 'Ring Mod', param: 'Freq', synced: false },
  { id: 'pitch', name: 'Pitch Shift', param: 'Semi', synced: false },
  { id: 'noise', name: 'Noise Sweep', param: 'Sweep', synced: false },
  { id: 'reverse_echo', name: 'Spiral', param: 'Fdbk', synced: true },
  { id: 'punch', name: 'Punch (Comp)', param: 'Amount', synced: false },
  { id: 'stereo', name: 'Stereo Wide', param: 'Width', synced: false },
];

let impulseCache = {};
function impulse(ctx, seconds, decay) {
  const key = seconds.toFixed(1) + ':' + decay;
  if (impulseCache[key]) return impulseCache[key];
  const len = Math.floor(ctx.sampleRate * seconds);
  const b = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let c = 0; c < 2; c++) {
    const d = b.getChannelData(c);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
  }
  return (impulseCache[key] = b);
}

let noiseBuf = null;
function noise(ctx) {
  if (noiseBuf) return noiseBuf;
  const len = ctx.sampleRate * 2;
  noiseBuf = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let c = 0; c < 2; c++) { const d = noiseBuf.getChannelData(c); for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1; }
  return noiseBuf;
}

function lfo(ctx, type = 'sine') {
  const o = ctx.createOscillator(); o.type = type; o.frequency.value = 1; o.start();
  const g = ctx.createGain(); o.connect(g);
  return { osc: o, out: g };
}

const exp = (min, max, v) => min * Math.pow(max / min, v);
const T = 0.03;

/** Builds the wet path of an effect: returns { input, output, param(v), beat(sec), extraStop() } */
function build(ctx, id) {
  const input = ctx.createGain(), output = ctx.createGain();
  const nodes = [];
  const s = { input, output, param: () => {}, beat: () => {}, stop: () => {} };
  const now = () => ctx.currentTime;
  switch (id) {
    case 'echo': {
      const d = ctx.createDelay(4), fb = ctx.createGain(), hp = ctx.createBiquadFilter();
      hp.type = 'highpass'; hp.frequency.value = 150;
      input.connect(d); d.connect(hp); hp.connect(fb); fb.connect(d); d.connect(output);
      s.param = v => fb.gain.setTargetAtTime(v * 0.92, now(), T);
      s.beat = sec => d.delayTime.setTargetAtTime(Math.min(3.9, sec), now(), 0.05);
      break;
    }
    case 'pingpong': {
      const m = ctx.createChannelMerger(2), dl = ctx.createDelay(4), dr = ctx.createDelay(4);
      const fb = ctx.createGain(), mono = ctx.createGain(); mono.channelCount = 1; mono.channelCountMode = 'explicit';
      input.connect(mono); mono.connect(dl); dl.connect(dr); dr.connect(fb); fb.connect(dl);
      dl.connect(m, 0, 0); dr.connect(m, 0, 1); m.connect(output);
      s.param = v => fb.gain.setTargetAtTime(v * 0.9, now(), T);
      s.beat = sec => { dl.delayTime.setTargetAtTime(Math.min(3.9, sec), now(), 0.05); dr.delayTime.setTargetAtTime(Math.min(3.9, sec), now(), 0.05); };
      break;
    }
    case 'reverb': {
      const pre = ctx.createBiquadFilter(); pre.type = 'highpass'; pre.frequency.value = 200;
      const cv = ctx.createConvolver(); cv.buffer = impulse(ctx, 3.5, 2.5);
      const cvL = ctx.createConvolver(); cvL.buffer = impulse(ctx, 7, 2);
      const gS = ctx.createGain(), gL = ctx.createGain();
      input.connect(pre); pre.connect(cv); pre.connect(cvL); cv.connect(gS); cvL.connect(gL); gS.connect(output); gL.connect(output);
      s.param = v => { gS.gain.setTargetAtTime(1 - v, now(), T); gL.gain.setTargetAtTime(v, now(), T); };
      break;
    }
    case 'flanger': case 'chorus': {
      const isCh = id === 'chorus';
      const d = ctx.createDelay(0.1), fb = ctx.createGain(), l = lfo(ctx);
      d.delayTime.value = isCh ? 0.02 : 0.004;
      input.connect(d); d.connect(output); d.connect(fb); fb.connect(d);
      l.out.connect(d.delayTime); fb.gain.value = isCh ? 0 : 0.6;
      if (isCh) l.osc.frequency.value = 0.8;
      s.param = v => l.out.gain.setTargetAtTime((isCh ? 0.008 : 0.0035) * v, now(), T);
      s.beat = sec => { if (!isCh) l.osc.frequency.setTargetAtTime(1 / (sec * 8), now(), 0.1); };
      s.stop = () => l.osc.stop();
      break;
    }
    case 'phaser': {
      const l = lfo(ctx); let prev = input; const aps = [];
      for (let i = 0; i < 6; i++) { const ap = ctx.createBiquadFilter(); ap.type = 'allpass'; ap.frequency.value = 700; ap.Q.value = 0.6; prev.connect(ap); prev = ap; aps.push(ap); l.out.connect(ap.frequency); }
      const fb = ctx.createGain(); fb.gain.value = 0.5; prev.connect(fb); fb.connect(aps[0]);
      prev.connect(output);
      s.param = v => l.out.gain.setTargetAtTime(650 * v, now(), T);
      s.beat = sec => l.osc.frequency.setTargetAtTime(1 / (sec * 4), now(), 0.1);
      s.stop = () => l.osc.stop();
      break;
    }
    case 'gate': case 'tremolo': {
      const g = ctx.createGain(), l = lfo(ctx, id === 'gate' ? 'square' : 'sine');
      const depth = ctx.createGain(); l.out.connect(depth); depth.connect(g.gain);
      l.out.gain.value = 0.5; g.gain.value = 0.5;
      input.connect(g); g.connect(output);
      s.param = v => { depth.gain.setTargetAtTime(v, now(), T); g.gain.setTargetAtTime(1 - v * 0.5, now(), T); };
      s.beat = sec => l.osc.frequency.setTargetAtTime(1 / sec, now(), 0.05);
      s.stop = () => l.osc.stop();
      break;
    }
    case 'autofilter': {
      const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 1500; const l = lfo(ctx, 'triangle');
      l.out.gain.value = 1400; l.out.connect(f.frequency);
      input.connect(f); f.connect(output);
      s.param = v => f.Q.setTargetAtTime(0.7 + v * 14, now(), T);
      s.beat = sec => l.osc.frequency.setTargetAtTime(1 / (sec * 2), now(), 0.05);
      s.stop = () => l.osc.stop();
      break;
    }
    case 'wah': {
      const f = ctx.createBiquadFilter(); f.type = 'bandpass'; f.Q.value = 5;
      const mk = ctx.createGain(); mk.gain.value = 2.5;
      input.connect(f); f.connect(mk); mk.connect(output);
      s.param = v => f.frequency.setTargetAtTime(exp(300, 3500, v), now(), 0.02);
      break;
    }
    case 'lpf': case 'hpf': {
      const f = ctx.createBiquadFilter(); f.type = id === 'lpf' ? 'lowpass' : 'highpass'; f.Q.value = 4;
      input.connect(f); f.connect(output);
      s.param = v => f.frequency.setTargetAtTime(id === 'lpf' ? exp(20000, 120, v) : exp(20, 6000, v), now(), 0.02);
      break;
    }
    case 'bitcrush': {
      const bc = new AudioWorkletNode(ctx, 'bitcrusher', { outputChannelCount: [2] });
      input.connect(bc); bc.connect(output);
      s.param = v => { bc.parameters.get('bits').setValueAtTime(16 - v * 13, now()); bc.parameters.get('reduction').setValueAtTime(1 + v * 20, now()); };
      break;
    }
    case 'distortion': {
      const ws = ctx.createWaveShaper(); ws.oversample = '2x';
      const pre = ctx.createGain(), post = ctx.createGain(); post.gain.value = 0.5;
      const curve = new Float32Array(2048);
      for (let i = 0; i < 2048; i++) { const x = i / 1024 - 1; curve[i] = Math.tanh(x * 3); }
      ws.curve = curve;
      input.connect(pre); pre.connect(ws); ws.connect(post); post.connect(output);
      s.param = v => { pre.gain.setTargetAtTime(1 + v * 12, now(), T); post.gain.setTargetAtTime(0.7 / (1 + v * 3), now(), T); };
      break;
    }
    case 'lofi': {
      const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 1500; bp.Q.value = 0.5;
      const bc = new AudioWorkletNode(ctx, 'bitcrusher', { outputChannelCount: [2] });
      bc.parameters.get('bits').value = 10; bc.parameters.get('reduction').value = 3;
      const crackle = ctx.createBufferSource(); crackle.buffer = noise(ctx); crackle.loop = true;
      const cg = ctx.createGain(), cf = ctx.createBiquadFilter(); cf.type = 'highpass'; cf.frequency.value = 3000; crackle.connect(cf); cf.connect(cg); cg.connect(output); crackle.start();
      const wob = lfo(ctx); wob.osc.frequency.value = 0.6; wob.out.gain.value = 300; wob.out.connect(bp.frequency);
      input.connect(bp); bp.connect(bc); bc.connect(output);
      s.param = v => { bp.Q.setTargetAtTime(0.5 + v * 2, now(), T); cg.gain.setTargetAtTime(v * 0.04, now(), T); bc.parameters.get('bits').setValueAtTime(12 - v * 6, now()); };
      s.stop = () => { crackle.stop(); wob.osc.stop(); };
      break;
    }
    case 'autopan': {
      const p = ctx.createStereoPanner(), l = lfo(ctx); l.out.connect(p.pan);
      input.connect(p); p.connect(output);
      s.param = v => l.out.gain.setTargetAtTime(v, now(), T);
      s.beat = sec => l.osc.frequency.setTargetAtTime(1 / (sec * 2), now(), 0.05);
      s.stop = () => l.osc.stop();
      break;
    }
    case 'ringmod': {
      const g = ctx.createGain(); g.gain.value = 0; const o = ctx.createOscillator(); o.frequency.value = 400; o.connect(g.gain); o.start();
      input.connect(g); g.connect(output);
      s.param = v => o.frequency.setTargetAtTime(exp(30, 2000, v), now(), 0.02);
      s.stop = () => o.stop();
      break;
    }
    case 'pitch': {
      const ps = new AudioWorkletNode(ctx, 'pitch-shifter', { outputChannelCount: [2] });
      input.connect(ps); ps.connect(output);
      s.param = v => { const semis = Math.round((v - 0.5) * 24); ps.parameters.get('ratio').setValueAtTime(Math.pow(2, (semis || 0.0001) / 12), now()); };
      break;
    }
    case 'noise': {
      const src = ctx.createBufferSource(); src.buffer = noise(ctx); src.loop = true;
      const f = ctx.createBiquadFilter(); f.type = 'bandpass'; f.Q.value = 2;
      const g = ctx.createGain(); g.gain.value = 0.25;
      src.connect(f); f.connect(g); g.connect(output); src.start();
      input.connect(output); // pass the music through the wet side as well
      s.param = v => f.frequency.setTargetAtTime(exp(200, 12000, v), now(), 0.02);
      s.stop = () => src.stop();
      break;
    }
    case 'reverse_echo': { // "spiral": echo whose repeats climb in pitch
      const d = ctx.createDelay(4), fb = ctx.createGain(), ps = new AudioWorkletNode(ctx, 'pitch-shifter', { outputChannelCount: [2] });
      ps.parameters.get('ratio').value = 1.06;
      input.connect(d); d.connect(ps); ps.connect(fb); fb.connect(d); d.connect(output);
      s.param = v => fb.gain.setTargetAtTime(v * 0.9, now(), T);
      s.beat = sec => d.delayTime.setTargetAtTime(Math.min(3.9, sec / 2), now(), 0.05);
      break;
    }
    case 'punch': {
      const c = ctx.createDynamicsCompressor(); c.knee.value = 6; c.attack.value = 0.01; c.release.value = 0.12;
      const mk = ctx.createGain();
      input.connect(c); c.connect(mk); mk.connect(output);
      s.param = v => { c.threshold.setTargetAtTime(-6 - v * 30, now(), T); c.ratio.setTargetAtTime(2 + v * 10, now(), T); mk.gain.setTargetAtTime(1 + v * 2, now(), T); };
      break;
    }
    case 'stereo': {
      const sp = ctx.createChannelSplitter(2), m = ctx.createChannelMerger(2);
      const dR = ctx.createDelay(0.05); const gL = ctx.createGain(), gR = ctx.createGain();
      input.connect(sp); sp.connect(gL, 0); sp.connect(dR, 1); dR.connect(gR); gL.connect(m, 0, 0); gR.connect(m, 0, 1); m.connect(output);
      s.param = v => dR.delayTime.setTargetAtTime(v * 0.025, now(), T);
      break;
    }
    default:
      input.connect(output);
  }
  s.nodes = nodes;
  return s;
}

/** One FX slot: dry passes untouched, wet path is added on top (or replaces dry for insert-style FX). */
const INSERT = new Set(['gate', 'tremolo', 'autofilter', 'wah', 'lpf', 'hpf', 'bitcrush', 'distortion', 'lofi', 'autopan', 'ringmod', 'pitch', 'punch', 'stereo', 'noise']);

export class FxSlot {
  constructor(ctx) {
    this.ctx = ctx;
    this.input = ctx.createGain(); this.output = ctx.createGain();
    this.dry = ctx.createGain(); this.wetGain = ctx.createGain(); this.wetGain.gain.value = 0;
    this.input.connect(this.dry); this.dry.connect(this.output);
    this.wetGain.connect(this.output);
    this.fx = null; this.id = null; this.on = false; this.wet = 0.5; this.p = 0.5; this.beatSec = 0.5;
  }
  setType(id) {
    if (id === this.id) return;
    const old = this.fx;
    if (old) {
      try { this.input.disconnect(old.input); } catch (e) { /* not connected */ }
      setTimeout(() => { try { old.output.disconnect(); old.stop(); } catch (e) { /* ignore */ } }, 4000);
    }
    this.id = id;
    if (!id) { this.fx = null; this.apply(); return; }
    this.fx = build(this.ctx, id);
    this.input.connect(this.fx.input); this.fx.output.connect(this.wetGain);
    this.fx.param(this.p); this.fx.beat(this.beatSec);
    this.apply();
  }
  setOn(on) { this.on = on; this.apply(); }
  setWet(v) { this.wet = v; this.apply(); }
  setParam(v) { this.p = v; if (this.fx) this.fx.param(v); }
  setBeat(sec) { this.beatSec = sec; if (this.fx) this.fx.beat(sec); }
  apply() {
    const t = this.ctx.currentTime;
    const active = this.on && this.fx;
    const insert = INSERT.has(this.id);
    // equal-ish power crossfade for insert FX, additive send for time-based FX
    const wet = active ? (insert ? this.wet : this.wet * 0.9) : 0;
    const dry = active && insert ? 1 - this.wet : 1;
    this.wetGain.gain.setTargetAtTime(wet, t, 0.02);
    this.dry.gain.setTargetAtTime(dry, t, 0.02);
  }
}

export const BEAT_DIVS = [
  { label: '1/8', v: 0.125 }, { label: '1/4', v: 0.25 }, { label: '1/2', v: 0.5 }, { label: '3/4', v: 0.75 },
  { label: '1', v: 1 }, { label: '2', v: 2 }, { label: '4', v: 4 },
];
