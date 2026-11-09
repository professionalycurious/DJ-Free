/* Engine core: settings, analysis, shared deck logic (DeckCore) and the Web Audio backend.
 * On Android the native backend in native-engine.js is used instead (real AudioTrack output). */
import { FxSlot } from './fx.js';
import { renderSamples, SAMPLE_NAMES } from './samples.js';

export { SAMPLE_NAMES };

export const settings = Object.assign({
  pitchRange: 8, keylock: true, quantize: true, xfCurve: 'smooth', limiter: true, splitCue: false,
  vinyl: true, slip: false, filterRes: 1.2, appleToken: '', storefront: 'us',
  amTransition: 'smart', amBeats: 32, amSync: true, amHarmonic: false, amSkipSilence: true, amShuffle: false,
}, safeLoad('djfree.settings'));

function safeLoad(k) { try { return JSON.parse(localStorage.getItem(k)) || {}; } catch (e) { return {}; } }
export function saveSettings() { try { localStorage.setItem('djfree.settings', JSON.stringify(settings)); } catch (e) { /* ignore */ } }

export const dB = (v) => Math.pow(10, v / 20);
export const diag = { backend: '-', worklet: '-', worker: '-', lastError: '' };

/* ---------------- analysis (worker with main-thread fallback) ---------------- */
let workerSeq = 0;
const pending = new Map();
let workerP = null;
let mainAnalyze = null;
async function analysisSource() { return (await fetch('js/analysis-worker.js')).text(); }
async function fallbackAnalyze() {
  if (!mainAnalyze) mainAnalyze = new Function('self', (await analysisSource()) + '\nreturn analyze;')({});
  return mainAnalyze;
}
function getWorker() {
  if (!workerP) workerP = (async () => {
    try {
      const url = URL.createObjectURL(new Blob([await analysisSource()], { type: 'text/javascript' }));
      const w = new Worker(url);
      w.onmessage = (e) => { const p = pending.get(e.data.id); if (!p) return; pending.delete(e.data.id); e.data.ok ? p.res(e.data.res) : p.rej(new Error(e.data.error)); };
      w.onerror = (e) => { diag.worker = 'failed: ' + (e.message || 'error'); for (const p of pending.values()) p.fail(); pending.clear(); workerP = Promise.resolve(null); };
      diag.worker = 'ok';
      return w;
    } catch (e) { diag.worker = 'main thread'; return null; }
  })();
  return workerP;
}
/** Analyses a mono Float32Array. makeCopy() must return a fresh copy (used if the worker fails). */
export async function analyzeMono(mono, sampleRate, makeCopy) {
  const onMain = async () => (await fallbackAnalyze())(makeCopy ? makeCopy() : mono, sampleRate);
  const w = await getWorker();
  if (!w) return onMain();
  const id = ++workerSeq;
  return new Promise((res, rej) => {
    let done = false;
    const fail = () => { if (done) return; done = true; pending.delete(id); onMain().then(res, rej); };
    const timer = setTimeout(() => { diag.worker = 'timed out (main thread)'; fail(); }, 45000);
    pending.set(id, {
      res: (v) => { if (done) return; done = true; clearTimeout(timer); res(v); },
      rej: (e) => { if (done) return; done = true; clearTimeout(timer); rej(e); },
      fail: () => { clearTimeout(timer); fail(); },
    });
    try { w.postMessage({ id, mono, sampleRate }, [mono.buffer]); } catch (e) { clearTimeout(timer); fail(); }
  });
}
export function analyzeBuffer(buf) {
  const makeMono = () => {
    const n = buf.length, mono = new Float32Array(n);
    const c0 = buf.getChannelData(0), c1 = buf.numberOfChannels > 1 ? buf.getChannelData(1) : c0;
    for (let i = 0; i < n; i++) mono[i] = (c0[i] + c1[i]) * 0.5;
    return mono;
  };
  return analyzeMono(makeMono(), buf.sampleRate, makeMono);
}

export function xfGains(x) {
  let a, b;
  if (settings.xfCurve === 'sharp') { a = x < 0.95 ? 1 : (1 - x) * 20; b = x > 0.05 ? 1 : x * 20; }
  else if (settings.xfCurve === 'linear') { a = Math.min(1, 2 * (1 - x)); b = Math.min(1, 2 * x); }
  else { a = Math.min(1, Math.cos(x * Math.PI / 2) * 1.414); b = Math.min(1, Math.sin(x * Math.PI / 2) * 1.414); }
  return [a, b];
}

/* ---------------- shared engine behaviour ---------------- */
export class EngineBase {
  masterDeck() {
    const [A, B] = this.decks;
    const la = A.playing ? A.volume * (this.xfader < 0.5 ? 1 : 2 * (1 - this.xfader)) : 0;
    const lb = B.playing ? B.volume * (this.xfader > 0.5 ? 1 : 2 * this.xfader) : 0;
    if (!la && !lb) return null;
    return la >= lb ? A : B;
  }
}

/* ---------------- shared deck logic ---------------- */
export class DeckCore {
  constructor(engine, index) {
    this.engine = engine; this.index = index; this.name = index ? 'B' : 'A';
    this.track = null; this.an_ = null; this.duration = 0;
    this.pos = 0; this.posT = 0; this.speed = 0; this.playing = false; this.slipPos = -1;
    this.pitch = 0; this.bend = 0; this.keyShift = 0;
    this.volume = 1; this.cueOn = false;
    this.hotcues = new Array(8).fill(null);
    this.loop = null;
    this.listeners = new Set();
  }
  on(fn) { this.listeners.add(fn); }
  emit(ev) { for (const f of this.listeners) f(ev, this); }

  position() {
    if (!this.track) return 0;
    const dt = Math.max(0, Math.min(0.15, this.engine.now() - this.posT));
    return Math.max(0, Math.min(this.duration, this.pos + dt * this.speed));
  }
  get bpm() { return this.an_ ? this.an_.bpm : 0; }
  get rate() { return 1 + (this.pitch + this.bend) / 100; }
  get liveBpm() { return this.bpm * this.rate; }
  get beatLen() { return this.bpm ? 60 / this.bpm : 0.5; }

  afterLoad(track, analysis, duration) {
    this.track = track; this.an_ = analysis; this.duration = duration;
    this.pos = 0; this.posT = this.engine.now(); this.playing = false; this.speed = 0;
    this.loop = null; this.hotcues = (track.cues || new Array(8).fill(null)).slice();
    this.post({ type: 'slip', on: settings.slip });
    this.cuePoint = 0;
    this.setPitch(0);
    this.emit('load'); this.emit('state');
  }

  play(at) { if (!this.track) return; this.engine.resume(); this.post({ type: 'play', at }); this.playing = true; this.emit('state'); }
  pause() { this.post({ type: 'pause' }); this.playing = false; this.emit('state'); }
  toggle() { this.playing ? this.pause() : this.play(); }
  seek(t) { if (!this.track) return; t = Math.max(0, Math.min(this.duration - 0.05, t)); this.post({ type: 'seek', pos: t }); this.pos = t; this.posT = this.engine.now(); }
  cueDown() {
    if (!this.track) return;
    if (this.playing) { this.pause(); this.seek(this.cuePoint); }
    else { this.cuePoint = settings.quantize ? this.snap(this.position()) : this.position(); this.seek(this.cuePoint); this.cuePreview = true; this.play(); }
  }
  cueUp() { if (this.cuePreview) { this.cuePreview = false; this.pause(); this.seek(this.cuePoint); } }

  snap(t, div = 1) {
    if (!this.an_) return t;
    const b = this.beatLen * div; const fb = this.an_.firstBeat;
    return fb + Math.round((t - fb) / b) * b;
  }
  beatPhase(t = this.position()) { if (!this.an_) return 0; const b = this.beatLen; let p = ((t - this.an_.firstBeat) / b) % 1; if (p < 0) p += 1; return p; }

  setPitch(pct) { this.pitch = pct; this.applyRate(); this.emit('pitch'); }
  setBend(pct) { this.bend = pct; this.applyRate(); }
  setKeyShift(semis) { this.keyShift = semis; this.applyRate(); this.emit('pitch'); }
  applyRate() {
    const r = this.rate;
    this.post({ type: 'rate', value: r });
    let ratio = Math.pow(2, this.keyShift / 12);
    if (settings.keylock) ratio /= r;
    this.setShift(Math.max(0.5, Math.min(2, ratio)));
  }

  sync() {
    const other = this.engine.decks[1 - this.index];
    if (!other.track || !this.bpm || !other.bpm) return false;
    let target = other.liveBpm;
    if (target / this.bpm > 1.5) target /= 2; else if (this.bpm / target > 1.5) target *= 2;
    const pct = (target / this.bpm - 1) * 100;
    this.setPitch(Math.max(-50, Math.min(50, pct)));
    if (this.playing && other.playing) this.alignPhase(other);
    this.emit('sync');
    return true;
  }
  alignPhase(other) {
    const d = other.beatPhase() - this.beatPhase();
    let delta = d; if (delta > 0.5) delta -= 1; if (delta < -0.5) delta += 1;
    this.seek(this.position() + delta * this.beatLen);
  }

  /* knob values 0..1 -> physical values, then the backend applies them */
  setEq(band, v) {
    const g = v <= 0.01 ? -60 : v < 0.5 ? -40 * Math.pow(1 - v * 2, 1.4) : (v - 0.5) * 12;
    this.applyEq(band === 'low' ? 0 : band === 'mid' ? 1 : 2, g);
  }
  setTrim(v) { this.applyTrim(dB((v - 0.5) * 24)); }
  setVolume(v) { this.volume = v; this.applyVolume(v * v); }
  setFilter(v) {
    this.filterVal = v;
    const q = settings.filterRes;
    if (v < 0.48) this.applyFilter(22000 * Math.pow(60 / 22000, (0.48 - v) / 0.48), 10, q);
    else if (v > 0.52) this.applyFilter(22000, 10 * Math.pow(900, (v - 0.52) / 0.48), q);
    else this.applyFilter(22000, 10, 0.7);
  }
  setFxBeat(div) { this.fxDiv = div; for (const s of this.fx) s.setBeat(this.beatLen / this.rate * div); }
  updateFxTempo() { this.setFxBeat(this.fxDiv || 0.5); }

  /* wash send helpers (echo out / reverb wash) */
  resetSend() { this.setSend(0, 0.05); this.setSendFx({ rev: 0, revTc: 0.05 }); }
  echoPulse(delay, fb) { this.setSendFx({ delay, fb, rev: 0 }); this.setSend(1, 0); this.setSend(0, 0.02); }
  echoOut(wash) {
    if (!this.playing) return;
    this.setSendFx({ delay: this.beatLen / this.rate * 0.75, fb: wash ? 0.2 : 0.62, rev: wash ? 1.4 : 0 });
    this.setSend(1, 0);
    const wait = this.beatLen / this.rate * (1 - this.beatPhase());
    setTimeout(() => { this.pause(); this.setSend(0, 0.02); setTimeout(() => this.setSendFx({ rev: 0, revTc: 1 }), 200); }, wait * 1000);
  }

  hotcue(i, del) {
    if (!this.track) return;
    if (del) this.hotcues[i] = null;
    else if (this.hotcues[i] == null) { const p = this.position(); this.hotcues[i] = settings.quantize ? Math.max(0, this.snap(p)) : p; }
    else { this.seek(this.hotcues[i]); if (!this.playing) this.play(); }
    this.track.cues = this.hotcues.slice();
    this.emit('cues');
  }

  autoLoop(beats) {
    if (!this.track) return;
    if (this.loop && this.loop.beats === beats) return this.exitLoop();
    const p = this.position(), b = this.beatLen;
    let a = settings.quantize && this.an_ ? this.an_.firstBeat + Math.floor((p - this.an_.firstBeat) / b + 1e-6) * b : p;
    if (beats < 1 && settings.quantize) a = this.snap(p, beats) <= p ? this.snap(p, beats) : this.snap(p, beats) - b * beats;
    this.setLoop(Math.max(0, a), Math.max(0, a) + beats * b, beats, false);
  }
  setLoop(a, b, beats, jump) { this.loop = { a, b, beats }; this.post({ type: 'loop', on: true, a, b, jump }); this.emit('loop'); }
  loopIn() { this.loopInPt = settings.quantize ? this.snap(this.position()) : this.position(); this.emit('loop'); }
  loopOut() {
    if (this.loopInPt == null) return;
    let b = settings.quantize ? this.snap(this.position()) : this.position();
    if (b <= this.loopInPt + 0.05) b = this.loopInPt + this.beatLen;
    this.setLoop(this.loopInPt, b, (b - this.loopInPt) / this.beatLen, false);
  }
  loopScale(f) { if (!this.loop) return; const len = (this.loop.b - this.loop.a) * f; if (len < 0.02 || len > 120) return; this.setLoop(this.loop.a, this.loop.a + len, this.loop.beats * f, false); }
  loopMove(beats) { if (!this.loop) return; const d = beats * this.beatLen; this.setLoop(this.loop.a + d, this.loop.b + d, this.loop.beats, true); }
  exitLoop() { if (this.loop) this.lastLoop = this.loop; this.loop = null; this.post({ type: 'loop', on: false }); this.emit('loop'); }
  reloop() { if (this.lastLoop) this.setLoop(this.lastLoop.a, this.lastLoop.b, this.lastLoop.beats, true); }
  roll(beats, on) {
    if (on) {
      const b = this.beatLen * beats, p = this.position();
      const a = this.an_ ? this.an_.firstBeat + Math.floor((p - this.an_.firstBeat) / b) * b : p;
      this.post({ type: 'roll', on: true, a: Math.max(0, a), b: Math.max(0, a) + b });
    } else this.post({ type: 'roll', on: false });
  }
  beatJump(beats) { this.seek(this.position() + beats * this.beatLen); if (this.loop) this.loopMove(beats); }

  brake(dur = 1.2) { this.post({ type: 'brake', dur }); }
  spinback(dur = 1.4) { this.post({ type: 'spin', dur }); }
  reverse(on) { this.post({ type: 'reverse', on }); }
  setSlip(on) { this.post({ type: 'slip', on }); }
  scratch(on) { this.post({ type: 'scratch', on }); }
  scratchVel(v) { this.post({ type: 'scratchVel', v }); }
  eject() { this.pause(); this.post({ type: 'unload' }); this.track = null; this.an_ = null; this.duration = 0; this.emit('load'); this.emit('state'); }
}

/* ================= Web Audio backend (desktop browsers) ================= */
export class Engine extends EngineBase {
  async init() {
    diag.backend = window.DJDesktop ? 'desktop' : 'Web Audio';
    this.ctx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: window.DJDesktop ? 'interactive' : 'playback' });
    this.unlock();
    if (!this.ctx.audioWorklet) throw new Error('This browser has no AudioWorklet support.');
    try {
      const src = await (await fetch('js/worklets.js')).text();
      await this.ctx.audioWorklet.addModule(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
      diag.worklet = 'ok (blob)';
    } catch (e) { await this.ctx.audioWorklet.addModule('js/worklets.js'); diag.worklet = 'ok (url)'; }
    const ctx = this.ctx;
    this.sampleRate = ctx.sampleRate;
    this.master = ctx.createGain();
    this.masterVol = ctx.createGain();
    this.limiter = ctx.createDynamicsCompressor();
    this.limiter.threshold.value = -1.5; this.limiter.knee.value = 0; this.limiter.ratio.value = 20;
    this.limiter.attack.value = 0.002; this.limiter.release.value = 0.12;
    this.masterOut = ctx.createGain();
    this.master.connect(this.masterVol); this.masterVol.connect(this.limiter); this.limiter.connect(this.masterOut);
    this.masterAn = ctx.createAnalyser(); this.masterAn.fftSize = 1024; this.masterOut.connect(this.masterAn);
    this.cueBus = ctx.createGain();
    this.outNormal = ctx.createGain(); this.masterOut.connect(this.outNormal); this.outNormal.connect(ctx.destination);
    this.splitMerger = ctx.createChannelMerger(2);
    this.splitM = ctx.createGain(); this.splitM.channelCount = 1; this.splitM.channelCountMode = 'explicit';
    this.splitC = ctx.createGain(); this.splitC.channelCount = 1; this.splitC.channelCountMode = 'explicit';
    this.masterOut.connect(this.splitM); this.cueBus.connect(this.splitC);
    this.splitM.connect(this.splitMerger, 0, 0); this.splitC.connect(this.splitMerger, 0, 1);
    this.splitOut = ctx.createGain(); this.splitMerger.connect(this.splitOut); this.splitOut.connect(ctx.destination);
    this.recDest = ctx.createMediaStreamDestination(); this.masterOut.connect(this.recDest);
    this.decks = [new Deck(this, 0), new Deck(this, 1)];
    this.xfader = 0.5;
    this.sampler = new Sampler(this);
    this.applyRouting(); this.applyLimiter(); this.setCrossfader(0.5);
  }
  now() { return this.ctx.currentTime; }
  resume() { if (this.ctx.state !== 'running') { this.ctx.resume().catch(() => {}); this.unlock(); } }
  unlock() {
    try { const b = this.ctx.createBuffer(1, 1, 22050), s = this.ctx.createBufferSource(); s.buffer = b; s.connect(this.ctx.destination); s.start(0); this.ctx.resume().catch(() => {}); } catch (e) { /* ignore */ }
  }
  testTone() {
    this.resume();
    const t = this.ctx.currentTime, o = this.ctx.createOscillator(), g = this.ctx.createGain();
    o.frequency.value = 440; g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.4, t + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.8);
    o.connect(g); g.connect(this.ctx.destination); o.start(t); o.stop(t + 0.85);
  }
  info() { return `Web Audio · ${this.ctx.state} · ${this.ctx.sampleRate} Hz · worklet ${diag.worklet}`; }
  applyLimiter() { const t = this.ctx.currentTime; this.limiter.threshold.setValueAtTime(settings.limiter ? -1.5 : 0, t); this.limiter.ratio.setValueAtTime(settings.limiter ? 20 : 1, t); }
  applyRouting() { const t = this.ctx.currentTime; this.outNormal.gain.setTargetAtTime(settings.splitCue ? 0 : 1, t, 0.01); this.splitOut.gain.setTargetAtTime(settings.splitCue ? 1 : 0, t, 0.01); }
  setMasterVolume(v) { this.masterVol.gain.setTargetAtTime(v * v * 1.5, this.ctx.currentTime, 0.02); }
  setCrossfader(x) {
    this.xfader = x; const [a, b] = xfGains(x), t = this.ctx.currentTime;
    this.decks[0].xf.gain.setTargetAtTime(a, t, 0.008); this.decks[1].xf.gain.setTargetAtTime(b, t, 0.008);
  }
  masterLevel() { const b = this.mBuf || (this.mBuf = new Float32Array(1024)); this.masterAn.getFloatTimeDomainData(b); let pk = 0; for (let i = 0; i < b.length; i += 2) pk = Math.max(pk, Math.abs(b[i])); return pk; }
  isRecording() { return !!this.rec; }
  recSeconds() { return this.rec ? (Date.now() - this.recStart) / 1000 : 0; }
  startRecording() {
    const types = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/webm', 'audio/mp4'];
    const mime = types.find(t => window.MediaRecorder && MediaRecorder.isTypeSupported(t)) || '';
    this.recChunks = [];
    this.rec = new MediaRecorder(this.recDest.stream, mime ? { mimeType: mime, audioBitsPerSecond: 256000 } : {});
    this.rec.ondataavailable = (e) => { if (e.data.size) this.recChunks.push(e.data); };
    this.rec.start(1000); this.recStart = Date.now();
  }
  stopRecording() {
    return new Promise((res) => {
      if (!this.rec) return res(null);
      this.rec.onstop = () => { const type = this.rec.mimeType || 'audio/webm'; res({ blob: new Blob(this.recChunks, { type }) }); this.rec = null; };
      this.rec.stop();
    });
  }
  decode(arrayBuffer) { return this.ctx.decodeAudioData(arrayBuffer); }
}

export class Deck extends DeckCore {
  constructor(engine, index) {
    super(engine, index);
    const ctx = this.ctx = engine.ctx;
    this.player = new AudioWorkletNode(ctx, 'deck-player', { numberOfInputs: 0, outputChannelCount: [2] });
    this.player.port.onmessage = (e) => this.onPlayerMsg(e.data);
    this.shifter = new AudioWorkletNode(ctx, 'pitch-shifter', { outputChannelCount: [2] });
    this.trim = ctx.createGain();
    this.eqs = [['lowshelf', 180], ['peaking', 1100], ['highshelf', 4500]].map(([type, f]) => { const b = ctx.createBiquadFilter(); b.type = type; b.frequency.value = f; if (type === 'peaking') b.Q.value = 0.6; return b; });
    this.lp = ctx.createBiquadFilter(); this.lp.type = 'lowpass'; this.lp.frequency.value = 22000;
    this.hp = ctx.createBiquadFilter(); this.hp.type = 'highpass'; this.hp.frequency.value = 10;
    this.fx = [new FxSlot(ctx), new FxSlot(ctx), new FxSlot(ctx)];
    this.fader = ctx.createGain(); this.xf = ctx.createGain();
    this.an = ctx.createAnalyser(); this.an.fftSize = 512;
    this.cue = ctx.createGain(); this.cue.gain.value = 0;
    this.send = ctx.createGain(); this.send.gain.value = 0;
    this.sendDelay = ctx.createDelay(4); this.sendFb = ctx.createGain(); this.sendFb.gain.value = 0.55;
    this.sendRev = ctx.createConvolver();
    const len = ctx.sampleRate * 4, ir = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let c = 0; c < 2; c++) { const d = ir.getChannelData(c); for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3); }
    this.sendRev.buffer = ir;
    this.sendRevG = ctx.createGain(); this.sendRevG.gain.value = 0;
    this.player.connect(this.shifter); this.shifter.connect(this.trim);
    this.trim.connect(this.eqs[0]); this.eqs[0].connect(this.eqs[1]); this.eqs[1].connect(this.eqs[2]);
    this.eqs[2].connect(this.lp); this.lp.connect(this.hp);
    let prev = this.hp; for (const s of this.fx) { prev.connect(s.input); prev = s.output; }
    this.postNode = prev;
    prev.connect(this.fader); this.fader.connect(this.an); this.fader.connect(this.xf); this.xf.connect(engine.master);
    prev.connect(this.cue); this.cue.connect(engine.cueBus);
    prev.connect(this.send); this.send.connect(this.sendDelay); this.sendDelay.connect(this.sendFb); this.sendFb.connect(this.sendDelay);
    this.sendDelay.connect(engine.master);
    this.send.connect(this.sendRevG); this.sendRevG.connect(this.sendRev); this.sendRev.connect(engine.master);
    this.setVolume(0.85); this.setFilter(0.5);
  }
  post(m, transfer) { this.player.port.postMessage(m, transfer || []); }
  onPlayerMsg(m) {
    if (m.type === 'pos') {
      this.pos = m.pos; this.posT = m.t; this.speed = m.speed; this.slipPos = m.slip;
      const was = this.playing; this.playing = m.playing;
      if (was !== this.playing) this.emit('state');
    } else if (m.type === 'ended') { this.playing = false; this.emit('ended'); this.emit('state'); }
  }
  async load(track, buffer, analysis) {
    this.post({ type: 'pause' });
    const L = buffer.getChannelData(0).slice(0), R = buffer.numberOfChannels > 1 ? buffer.getChannelData(1).slice(0) : null;
    this.post({ type: 'load', L, R, sampleRate: buffer.sampleRate }, R ? [L.buffer, R.buffer] : [L.buffer]);
    this.afterLoad(track, analysis, buffer.duration);
  }
  setShift(r) { this.shifter.parameters.get('ratio').setTargetAtTime(r, this.ctx.currentTime, 0.01); }
  applyEq(i, db) { this.eqs[i].gain.setTargetAtTime(db, this.ctx.currentTime, 0.015); }
  applyTrim(g) { this.trim.gain.setTargetAtTime(g, this.ctx.currentTime, 0.02); }
  applyVolume(g) { this.fader.gain.setTargetAtTime(g, this.ctx.currentTime, 0.01); }
  applyFilter(lp, hp, q) {
    const t = this.ctx.currentTime;
    this.lp.frequency.setTargetAtTime(lp, t, 0.015); this.hp.frequency.setTargetAtTime(hp, t, 0.015);
    this.lp.Q.setTargetAtTime(lp < 20000 ? q : 0.7, t, 0.02); this.hp.Q.setTargetAtTime(hp > 12 ? q : 0.7, t, 0.02);
  }
  setCue(on) { this.cueOn = on; this.cue.gain.setTargetAtTime(on ? 1 : 0, this.ctx.currentTime, 0.01); }
  setSend(v, tc) { const t = this.ctx.currentTime; if (tc > 0) this.send.gain.setTargetAtTime(v, t, tc); else this.send.gain.setValueAtTime(v, t); }
  setSendFx({ delay, fb, rev, revTc = 0 }) {
    const t = this.ctx.currentTime;
    if (delay != null) this.sendDelay.delayTime.setValueAtTime(Math.min(3.9, delay), t);
    if (fb != null) this.sendFb.gain.setValueAtTime(fb, t);
    if (rev != null) { if (revTc > 0) this.sendRevG.gain.setTargetAtTime(rev, t, revTc); else this.sendRevG.gain.setValueAtTime(rev, t); }
  }
  level() { const b = this.vb || (this.vb = new Float32Array(512)); this.an.getFloatTimeDomainData(b); let pk = 0; for (let i = 0; i < b.length; i += 2) pk = Math.max(pk, Math.abs(b[i])); return pk; }
}

class Sampler {
  constructor(engine) {
    this.engine = engine; this.ctx = engine.ctx;
    this.out = this.ctx.createGain(); this.out.gain.value = 0.7; this.out.connect(engine.master);
    const sr = this.ctx.sampleRate;
    this.buffers = renderSamples(sr).map((x) => { const b = this.ctx.createBuffer(1, x.length, sr); b.copyToChannel(x, 0); return b; });
  }
  setVolume(v) { this.out.gain.setTargetAtTime(v, this.ctx.currentTime, 0.02); }
  trigger(i) { const b = this.buffers[i]; if (!b) return; this.engine.resume(); const s = this.ctx.createBufferSource(); s.buffer = b; s.connect(this.out); s.start(); }
}
