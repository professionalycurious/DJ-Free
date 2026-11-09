/* Native backend: all audio is decoded, mixed and played by the Android app itself
 * (MediaCodec + AudioTrack). This file only sends commands and reads back state. */
import { settings, diag, EngineBase, DeckCore, xfGains } from './engine.js';
import { renderSamples } from './samples.js';

const N = () => window.DJNative;
const waiters = new Map();
let seq = 0;
const handlers = { files: null, recSaved: null };

window.__djNative = {
  cb(m) {
    if (!m) return;
    if (m.type === 'prepared') { const w = waiters.get(m.reqId); if (w) { waiters.delete(m.reqId); w(m); } }
    else if (m.type === 'files') { if (handlers.files) handlers.files(m.files || []); }
    else if (m.type === 'recSaved') { if (handlers.recSaved) handlers.recSaved(m.path); }
  },
};

export function nativeAvailable() { return !!(window.DJNative && typeof window.DJNative.engineStart === 'function'); }
export function onNativeFiles(fn) { handlers.files = fn; }
export function pickNativeFiles() { N().pickFiles(); }

function send(o) { N().cmd(JSON.stringify(o)); }

/** Decodes a track natively. keep = hold full PCM for playback, mono = produce analysis data. */
export function nativePrepare(id, src, keep, mono = true) {
  return new Promise((res) => {
    const reqId = 'r' + (++seq);
    waiters.set(reqId, res);
    N().prepare(reqId, id, JSON.stringify(src), keep, mono);
  });
}
export function nativeHasTrack(id) { return N().hasTrack(id); }

export async function nativeMono(id) {
  const r = await fetch('/__pcm?id=' + encodeURIComponent(id));
  if (!r.ok) throw new Error('analysis data missing');
  const i16 = new Int16Array(await r.arrayBuffer());
  const f = new Float32Array(i16.length);
  for (let i = 0; i < i16.length; i++) f[i] = i16[i] / 32768;
  return f;
}

/** Sends JS-generated audio (demo tracks, sampler pads) to the native engine as 16-bit PCM. */
export function uploadPcm(id, chans, rate, sampleIdx = -1) {
  const L = chans[0], R = chans[1] || chans[0], n = L.length;
  N().uploadBegin(id, rate, n);
  const CH = 49152;
  for (let off = 0; off < n; off += CH) {
    const m = Math.min(CH, n - off), i16 = new Int16Array(m * 2);
    for (let k = 0; k < m; k++) {
      i16[2 * k] = Math.max(-32768, Math.min(32767, L[off + k] * 32767));
      i16[2 * k + 1] = Math.max(-32768, Math.min(32767, R[off + k] * 32767));
    }
    const u8 = new Uint8Array(i16.buffer); let s = '';
    for (let j = 0; j < u8.length; j += 8192) s += String.fromCharCode.apply(null, u8.subarray(j, j + 8192));
    N().uploadChunk(id, btoa(s));
  }
  return N().uploadEnd(id, sampleIdx);
}

export class NativeEngine extends EngineBase {
  async init() {
    const r = JSON.parse(N().engineStart());
    if (!r.ok) throw new Error('Native audio failed to start: ' + r.error);
    diag.backend = 'native';
    this.native = true; this.sampleRate = r.sr;
    this.t = 0; this.pollPerf = performance.now(); this.mLevel = 0; this.recSec = -1;
    this.decks = [new NativeDeck(this, 0), new NativeDeck(this, 1)];
    this.xfader = 0.5;
    this.sampler = new NativeSampler();
    this.applyRouting(); this.applyLimiter(); this.setCrossfader(0.5);
    this.poll();
  }
  poll() {
    let s; try { s = JSON.parse(N().state()); } catch (e) { return; }
    if (s.t == null) return;
    this.t = s.t; this.pollPerf = performance.now(); this.mLevel = s.m; this.recSec = s.r;
    s.d.forEach((x, i) => this.decks[i].update(x));
  }
  now() { return this.t + Math.min(0.25, (performance.now() - this.pollPerf) / 1000); }
  resume() {}
  unlock() {}
  testTone() { N().testTone(); }
  info() { return N().engineInfo(); }
  applyLimiter() { send({ c: 'limiter', on: !!settings.limiter }); }
  applyRouting() { send({ c: 'split', on: !!settings.splitCue }); }
  setMasterVolume(v) { send({ c: 'mvol', v: v * v * 1.5 }); }
  setCrossfader(x) { this.xfader = x; const [a, b] = xfGains(x); send({ c: 'xf', a, b }); }
  masterLevel() { return this.mLevel || 0; }
  isRecording() { return !!this.recOn; }
  recSeconds() { return Math.max(0, this.recSec || 0); }
  startRecording() { if (!N().recStart()) throw new Error('could not start recording'); this.recOn = true; }
  stopRecording() {
    return new Promise((res) => {
      handlers.recSaved = (path) => { handlers.recSaved = null; res({ path }); };
      this.recOn = false; N().recStop();
    });
  }
}

class NativeDeck extends DeckCore {
  constructor(engine, index) {
    super(engine, index);
    this.fx = [0, 1, 2].map((s) => new NativeFxSlot(index, s));
    this.lvl = 0; this.endedSeen = null; this.cmdT = 0;
    this.setVolume(0.85); this.setFilter(0.5);
  }
  post(m) {
    if (m.type === 'play' || m.type === 'pause' || m.type === 'seek') this.cmdT = performance.now();
    send({ c: 'p', d: this.index, m });
  }
  update(x) {
    this.lvl = x.v;
    const fresh = performance.now() - this.cmdT > 150; // ignore stale reports right after a local command
    if (fresh) { this.pos = x.p; this.posT = this.engine.t; this.speed = x.s; this.slipPos = x.sl; }
    const pl = !!x.pl;
    if (fresh && pl !== this.playing) { this.playing = pl; this.emit('state'); }
    if (this.endedSeen !== x.e) {
      const first = this.endedSeen == null; this.endedSeen = x.e;
      if (!first && this.track) { this.playing = false; this.emit('ended'); this.emit('state'); }
    }
  }
  async load(track, _buffer, analysis, duration) {
    this.post({ type: 'pause' });
    if (!N().assign(this.index, track.id)) throw new Error('track is not decoded yet');
    this.afterLoad(track, analysis, duration || analysis.duration);
  }
  setShift(r) { send({ c: 'shift', d: this.index, ratio: r }); }
  applyEq(i, db) { send({ c: 'eq', d: this.index, band: i, db }); }
  applyTrim(g) { send({ c: 'trim', d: this.index, v: g }); }
  applyVolume(g) { send({ c: 'vol', d: this.index, v: g }); }
  applyFilter(lp, hp, q) { send({ c: 'flt', d: this.index, lp, hp, q }); }
  setCue(on) { this.cueOn = on; send({ c: 'cue', d: this.index, on }); }
  setSend(v, tc) { send({ c: 'send', d: this.index, v, tc: tc || 0 }); }
  setSendFx(o) { send(Object.assign({ c: 'sendfx', d: this.index }, o)); }
  level() { return this.lvl; }
}

class NativeFxSlot {
  constructor(d, s) { this.d = d; this.s = s; this.fx = null; this.id = null; this.on = false; }
  setType(id) { if (id === this.id) return; this.id = id || null; this.fx = id ? {} : null; send({ c: 'fx', d: this.d, s: this.s, type: id || '' }); }
  setOn(on) { this.on = on; send({ c: 'fxon', d: this.d, s: this.s, on }); }
  setWet(v) { send({ c: 'fxwet', d: this.d, s: this.s, v }); }
  setParam(v) { send({ c: 'fxprm', d: this.d, s: this.s, v }); }
  setBeat(sec) { send({ c: 'fxbeat', d: this.d, s: this.s, v: sec }); }
}

class NativeSampler {
  constructor() {
    renderSamples(44100).forEach((x, i) => uploadPcm('smp' + i, [x], 44100, i));
  }
  setVolume(v) { send({ c: 'smpvol', v }); }
  trigger(i) { send({ c: 'smp', i }); }
}
