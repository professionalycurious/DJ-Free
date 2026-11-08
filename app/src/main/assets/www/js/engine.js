/* Audio engine: decks, mixer, master bus, sampler, recorder, split-cue. */
import { FxSlot } from './fx.js';

export const settings = Object.assign({
  pitchRange: 8, keylock: true, quantize: true, xfCurve: 'smooth', limiter: true, splitCue: false,
  vinyl: true, slip: false, filterRes: 1.2, appleToken: '', storefront: 'us',
  amTransition: 'smart', amBeats: 32, amSync: true, amHarmonic: false, amSkipSilence: true, amShuffle: false,
}, safeLoad('djfree.settings'));

function safeLoad(k) { try { return JSON.parse(localStorage.getItem(k)) || {}; } catch (e) { return {}; } }
export function saveSettings() { try { localStorage.setItem('djfree.settings', JSON.stringify(settings)); } catch (e) { /* ignore */ } }

const dB = (v) => Math.pow(10, v / 20);

let workerSeq = 0;
const pending = new Map();
let workerP = null;
let mainAnalyze = null;
export const diag = { worklet: '-', worker: '-', lastError: '' };

/* Analysis runs in a Web Worker created from a Blob (Android WebView does not always route
 * worker script requests through the app's asset server). If the worker can't start or
 * stalls, the same code runs on the main thread instead. */
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
    } catch (e) { diag.worker = 'unavailable (main thread)'; return null; }
  })();
  return workerP;
}
export async function analyzeBuffer(buf) {
  const makeMono = () => {
    const n = buf.length, mono = new Float32Array(n);
    const c0 = buf.getChannelData(0), c1 = buf.numberOfChannels > 1 ? buf.getChannelData(1) : c0;
    for (let i = 0; i < n; i++) mono[i] = (c0[i] + c1[i]) * 0.5;
    return mono;
  };
  const onMain = async () => (await fallbackAnalyze())(makeMono(), buf.sampleRate);
  const w = await getWorker();
  if (!w) return onMain();
  const mono = makeMono();
  const id = ++workerSeq;
  return new Promise((res, rej) => {
    let done = false;
    const fail = () => { if (done) return; done = true; pending.delete(id); onMain().then(res, rej); };
    const timer = setTimeout(() => { diag.worker = 'timed out (main thread)'; fail(); }, 45000);
    pending.set(id, { res: (v) => { if (done) return; done = true; clearTimeout(timer); res(v); }, rej: (e) => { if (done) return; done = true; clearTimeout(timer); rej(e); }, fail: () => { clearTimeout(timer); fail(); } });
    try { w.postMessage({ id, mono, sampleRate: buf.sampleRate }, [mono.buffer]); } catch (e) { clearTimeout(timer); fail(); }
  });
}

export class Engine {
  async init() {
    this.ctx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'playback' });
    this.unlock(); // must happen synchronously inside the tap gesture
    if (!this.ctx.audioWorklet) throw new Error('This Android System WebView is too old (no AudioWorklet). Update "Android System WebView" / Chrome from the Play Store.');
    try {
      const src = await (await fetch('js/worklets.js')).text();
      await this.ctx.audioWorklet.addModule(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
      diag.worklet = 'ok (blob)';
    } catch (e) {
      await this.ctx.audioWorklet.addModule('js/worklets.js');
      diag.worklet = 'ok (url)';
    }
    const ctx = this.ctx;
    this.master = ctx.createGain();
    this.masterVol = ctx.createGain();
    this.limiter = ctx.createDynamicsCompressor();
    this.limiter.threshold.value = -1.5; this.limiter.knee.value = 0; this.limiter.ratio.value = 20;
    this.limiter.attack.value = 0.002; this.limiter.release.value = 0.12;
    this.masterOut = ctx.createGain();
    this.master.connect(this.masterVol);
    this.masterVol.connect(this.limiter); this.limiter.connect(this.masterOut);
    this.masterAn = ctx.createAnalyser(); this.masterAn.fftSize = 1024;
    this.masterOut.connect(this.masterAn);
    this.cueBus = ctx.createGain();
    // output routing (normal stereo or split cue: L = master mono, R = cue mono)
    this.outNormal = ctx.createGain();
    this.masterOut.connect(this.outNormal); this.outNormal.connect(ctx.destination);
    this.splitMerger = ctx.createChannelMerger(2);
    this.splitM = ctx.createGain(); this.splitM.channelCount = 1; this.splitM.channelCountMode = 'explicit';
    this.splitC = ctx.createGain(); this.splitC.channelCount = 1; this.splitC.channelCountMode = 'explicit';
    this.masterOut.connect(this.splitM); this.cueBus.connect(this.splitC);
    this.splitM.connect(this.splitMerger, 0, 0); this.splitC.connect(this.splitMerger, 0, 1);
    this.splitOut = ctx.createGain(); this.splitMerger.connect(this.splitOut); this.splitOut.connect(ctx.destination);
    this.recDest = ctx.createMediaStreamDestination();
    this.masterOut.connect(this.recDest);
    this.decks = [new Deck(this, 0), new Deck(this, 1)];
    this.xfader = 0.5;
    this.sampler = new Sampler(this);
    this.applyRouting();
    this.applyLimiter();
    this.setCrossfader(0.5);
  }
  resume() { if (this.ctx.state !== 'running') { this.ctx.resume().catch(() => {}); this.unlock(); } }
  /** Plays a tiny silent buffer: required on some Android WebViews before any sound comes out. */
  unlock() {
    try {
      const b = this.ctx.createBuffer(1, 1, 22050), s = this.ctx.createBufferSource();
      s.buffer = b; s.connect(this.ctx.destination); s.start(0);
      this.ctx.resume().catch(() => {});
    } catch (e) { /* ignore */ }
  }
  testTone() {
    this.resume();
    const t = this.ctx.currentTime, o = this.ctx.createOscillator(), g = this.ctx.createGain();
    o.frequency.value = 440; g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.4, t + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.8);
    o.connect(g); g.connect(this.ctx.destination); o.start(t); o.stop(t + 0.85);
  }
  applyLimiter() {
    const t = this.ctx.currentTime;
    this.limiter.threshold.setValueAtTime(settings.limiter ? -1.5 : 0, t);
    this.limiter.ratio.setValueAtTime(settings.limiter ? 20 : 1, t);
  }
  applyRouting() {
    const t = this.ctx.currentTime;
    this.outNormal.gain.setTargetAtTime(settings.splitCue ? 0 : 1, t, 0.01);
    this.splitOut.gain.setTargetAtTime(settings.splitCue ? 1 : 0, t, 0.01);
  }
  setMasterVolume(v) { this.masterVol.gain.setTargetAtTime(v * v * 1.5, this.ctx.currentTime, 0.02); }
  setCrossfader(x) {
    this.xfader = x;
    let a, b;
    if (settings.xfCurve === 'sharp') { a = x < 0.95 ? 1 : (1 - x) * 20; b = x > 0.05 ? 1 : x * 20; }
    else if (settings.xfCurve === 'linear') { a = Math.min(1, 2 * (1 - x)); b = Math.min(1, 2 * x); }
    else { a = Math.cos(x * Math.PI / 2); b = Math.sin(x * Math.PI / 2); a = Math.min(1, a * 1.414); b = Math.min(1, b * 1.414); }
    const t = this.ctx.currentTime;
    this.decks[0].xf.gain.setTargetAtTime(a, t, 0.008);
    this.decks[1].xf.gain.setTargetAtTime(b, t, 0.008);
  }
  /** Deck that is currently most audible (used as tempo master). */
  masterDeck() {
    const [A, B] = this.decks;
    const la = A.playing ? A.volume * (this.xfader < 0.5 ? 1 : 2 * (1 - this.xfader)) : 0;
    const lb = B.playing ? B.volume * (this.xfader > 0.5 ? 1 : 2 * this.xfader) : 0;
    if (!la && !lb) return null;
    return la >= lb ? A : B;
  }

  /* ----- recording ----- */
  startRecording() {
    const types = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/webm', 'audio/mp4'];
    const mime = types.find(t => window.MediaRecorder && MediaRecorder.isTypeSupported(t)) || '';
    this.recChunks = [];
    this.rec = new MediaRecorder(this.recDest.stream, mime ? { mimeType: mime, audioBitsPerSecond: 256000 } : {});
    this.rec.ondataavailable = (e) => { if (e.data.size) this.recChunks.push(e.data); };
    this.rec.start(1000);
    this.recStart = Date.now();
  }
  stopRecording() {
    return new Promise((res) => {
      if (!this.rec) return res(null);
      this.rec.onstop = () => { const type = this.rec.mimeType || 'audio/webm'; res(new Blob(this.recChunks, { type })); this.rec = null; };
      this.rec.stop();
    });
  }
}

export class Deck {
  constructor(engine, index) {
    this.engine = engine; this.index = index; this.name = index ? 'B' : 'A';
    const ctx = this.ctx = engine.ctx;
    this.player = new AudioWorkletNode(ctx, 'deck-player', { numberOfInputs: 0, outputChannelCount: [2] });
    this.player.port.onmessage = (e) => this.onPlayerMsg(e.data);
    this.shifter = new AudioWorkletNode(ctx, 'pitch-shifter', { outputChannelCount: [2] });
    this.trim = ctx.createGain();
    this.eqL = ctx.createBiquadFilter(); this.eqL.type = 'lowshelf'; this.eqL.frequency.value = 180;
    this.eqM = ctx.createBiquadFilter(); this.eqM.type = 'peaking'; this.eqM.frequency.value = 1100; this.eqM.Q.value = 0.6;
    this.eqH = ctx.createBiquadFilter(); this.eqH.type = 'highshelf'; this.eqH.frequency.value = 4500;
    this.lp = ctx.createBiquadFilter(); this.lp.type = 'lowpass'; this.lp.frequency.value = 22000;
    this.hp = ctx.createBiquadFilter(); this.hp.type = 'highpass'; this.hp.frequency.value = 10;
    this.fx = [new FxSlot(ctx), new FxSlot(ctx), new FxSlot(ctx)];
    this.fader = ctx.createGain();
    this.xf = ctx.createGain();
    this.an = ctx.createAnalyser(); this.an.fftSize = 512;
    this.cue = ctx.createGain(); this.cue.gain.value = 0;
    // automix wash send (echo + reverb tail that survives the fader)
    this.send = ctx.createGain(); this.send.gain.value = 0;
    this.sendDelay = ctx.createDelay(4); this.sendFb = ctx.createGain(); this.sendFb.gain.value = 0.55;
    this.sendRev = ctx.createConvolver();
    const len = ctx.sampleRate * 4, ir = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let c = 0; c < 2; c++) { const d = ir.getChannelData(c); for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3); }
    this.sendRev.buffer = ir;
    this.sendRevG = ctx.createGain(); this.sendRevG.gain.value = 0;

    this.player.connect(this.shifter); this.shifter.connect(this.trim);
    this.trim.connect(this.eqL); this.eqL.connect(this.eqM); this.eqM.connect(this.eqH);
    this.eqH.connect(this.lp); this.lp.connect(this.hp);
    let prev = this.hp; for (const s of this.fx) { prev.connect(s.input); prev = s.output; }
    this.post = prev;
    this.post.connect(this.fader); this.fader.connect(this.an); this.fader.connect(this.xf); this.xf.connect(engine.master);
    this.post.connect(this.cue); this.cue.connect(engine.cueBus);
    this.post.connect(this.send); this.send.connect(this.sendDelay); this.sendDelay.connect(this.sendFb); this.sendFb.connect(this.sendDelay);
    this.sendDelay.connect(engine.master);
    this.send.connect(this.sendRevG); this.sendRevG.connect(this.sendRev); this.sendRev.connect(engine.master);

    this.track = null; this.an_ = null; this.duration = 0;
    this.pos = 0; this.posT = 0; this.speed = 0; this.playing = false; this.slipPos = -1;
    this.pitch = 0; this.bend = 0; this.keyShift = 0;
    this.volume = 1; this.cueOn = false;
    this.hotcues = new Array(8).fill(null);
    this.loop = null; // {a,b,beats}
    this.listeners = new Set();
    this.setVolume(0.85); this.setFilter(0.5);
  }

  on(fn) { this.listeners.add(fn); }
  emit(ev) { for (const f of this.listeners) f(ev, this); }

  onPlayerMsg(m) {
    if (m.type === 'pos') {
      this.pos = m.pos; this.posT = m.t; this.speed = m.speed; this.slipPos = m.slip;
      const was = this.playing; this.playing = m.playing;
      if (was !== this.playing) this.emit('state');
    } else if (m.type === 'ended') { this.playing = false; this.emit('ended'); this.emit('state'); }
  }

  /** Interpolated current position in seconds. */
  position() {
    if (!this.track) return 0;
    const dt = Math.max(0, Math.min(0.1, this.ctx.currentTime - this.posT));
    return Math.max(0, Math.min(this.duration, this.pos + dt * this.speed));
  }

  get bpm() { return this.an_ ? this.an_.bpm : 0; }
  get rate() { return 1 + (this.pitch + this.bend) / 100; }
  get liveBpm() { return this.bpm * this.rate; }
  get beatLen() { return this.bpm ? 60 / this.bpm : 0.5; }

  async load(track, buffer, analysis) {
    this.player.port.postMessage({ type: 'pause' });
    this.track = track; this.an_ = analysis; this.duration = buffer.duration;
    const L = buffer.getChannelData(0).slice(0), R = buffer.numberOfChannels > 1 ? buffer.getChannelData(1).slice(0) : null;
    this.player.port.postMessage({ type: 'load', L, R, sampleRate: buffer.sampleRate }, R ? [L.buffer, R.buffer] : [L.buffer]);
    this.pos = 0; this.posT = this.ctx.currentTime; this.playing = false; this.speed = 0;
    this.loop = null; this.hotcues = (track.cues || new Array(8).fill(null)).slice();
    this.player.port.postMessage({ type: 'slip', on: settings.slip });
    this.cuePoint = 0;
    this.setPitch(0);
    this.emit('load'); this.emit('state');
  }

  play(at) { if (!this.track) return; this.engine.resume(); this.player.port.postMessage({ type: 'play', at }); this.playing = true; this.emit('state'); }
  pause() { this.player.port.postMessage({ type: 'pause' }); this.playing = false; this.emit('state'); }
  toggle() { this.playing ? this.pause() : this.play(); }
  seek(t) { if (!this.track) return; t = Math.max(0, Math.min(this.duration - 0.05, t)); this.player.port.postMessage({ type: 'seek', pos: t }); this.pos = t; this.posT = this.ctx.currentTime; }
  /** CUE button: when playing jump back to cue point and stop; when stopped set cue point at the (quantised) position. */
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
    this.player.port.postMessage({ type: 'rate', value: r });
    let ratio = Math.pow(2, this.keyShift / 12);
    if (settings.keylock) ratio /= r;
    this.shifter.parameters.get('ratio').setTargetAtTime(Math.max(0.5, Math.min(2, ratio)), this.ctx.currentTime, 0.01);
  }

  sync() {
    const other = this.engine.decks[1 - this.index];
    if (!other.track || !this.bpm || !other.bpm) return false;
    let target = other.liveBpm;
    // allow half/double time matching
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

  /* EQ / filter / gain (values 0..1, 0.5 = neutral for knobs) */
  setEq(band, v) {
    const g = v < 0.5 ? -40 * Math.pow(1 - v * 2, 1.4) : (v - 0.5) * 12;
    const node = band === 'low' ? this.eqL : band === 'mid' ? this.eqM : this.eqH;
    node.gain.setTargetAtTime(v <= 0.01 ? -60 : g, this.ctx.currentTime, 0.015);
  }
  setTrim(v) { this.trim.gain.setTargetAtTime(dB((v - 0.5) * 24), this.ctx.currentTime, 0.02); }
  setVolume(v) { this.volume = v; this.fader.gain.setTargetAtTime(v * v, this.ctx.currentTime, 0.01); }
  setFilter(v) {
    this.filterVal = v;
    const t = this.ctx.currentTime, q = settings.filterRes;
    if (v < 0.48) { const x = (0.48 - v) / 0.48; this.lp.frequency.setTargetAtTime(22000 * Math.pow(60 / 22000, x), t, 0.015); this.lp.Q.setTargetAtTime(q, t, 0.02); this.hp.frequency.setTargetAtTime(10, t, 0.015); }
    else if (v > 0.52) { const x = (v - 0.52) / 0.48; this.hp.frequency.setTargetAtTime(10 * Math.pow(9000 / 10, x), t, 0.015); this.hp.Q.setTargetAtTime(q, t, 0.02); this.lp.frequency.setTargetAtTime(22000, t, 0.015); }
    else { this.lp.frequency.setTargetAtTime(22000, t, 0.015); this.hp.frequency.setTargetAtTime(10, t, 0.015); this.lp.Q.setTargetAtTime(0.7, t, 0.02); this.hp.Q.setTargetAtTime(0.7, t, 0.02); }
  }
  setCue(on) { this.cueOn = on; this.cue.gain.setTargetAtTime(on ? 1 : 0, this.ctx.currentTime, 0.01); }
  setFxBeat(div) { this.fxDiv = div; for (const s of this.fx) s.setBeat(this.beatLen / this.rate * div); }
  updateFxTempo() { this.setFxBeat(this.fxDiv || 0.5); }

  /* Hot cues */
  hotcue(i, del) {
    if (!this.track) return;
    if (del) { this.hotcues[i] = null; }
    else if (this.hotcues[i] == null) { const p = this.position(); this.hotcues[i] = settings.quantize ? Math.max(0, this.snap(p)) : p; }
    else { this.seek(this.hotcues[i]); if (!this.playing) this.play(); }
    this.track.cues = this.hotcues.slice();
    this.emit('cues');
  }

  /* Loops */
  autoLoop(beats) {
    if (!this.track) return;
    if (this.loop && this.loop.beats === beats) return this.exitLoop();
    const p = this.position();
    const b = this.beatLen;
    let a = settings.quantize && this.an_ ? this.an_.firstBeat + Math.floor((p - this.an_.firstBeat) / b + 1e-6) * b : p;
    if (beats < 1 && settings.quantize) a = this.snap(p, beats) <= p ? this.snap(p, beats) : this.snap(p, beats) - b * beats;
    this.setLoop(Math.max(0, a), Math.max(0, a) + beats * b, beats, false);
  }
  setLoop(a, b, beats, jump) {
    this.loop = { a, b, beats };
    this.player.port.postMessage({ type: 'loop', on: true, a, b, jump });
    this.emit('loop');
  }
  loopIn() { this.loopInPt = settings.quantize ? this.snap(this.position()) : this.position(); this.emit('loop'); }
  loopOut() {
    if (this.loopInPt == null) return;
    let b = settings.quantize ? this.snap(this.position()) : this.position();
    if (b <= this.loopInPt + 0.05) b = this.loopInPt + this.beatLen;
    this.setLoop(this.loopInPt, b, (b - this.loopInPt) / this.beatLen, false);
  }
  loopScale(f) { if (!this.loop) return; const len = (this.loop.b - this.loop.a) * f; if (len < 0.02 || len > 120) return; this.setLoop(this.loop.a, this.loop.a + len, this.loop.beats * f, false); }
  loopMove(beats) { if (!this.loop) return; const d = beats * this.beatLen; this.setLoop(this.loop.a + d, this.loop.b + d, this.loop.beats, true); }
  exitLoop() { if (this.loop) this.lastLoop = this.loop; this.loop = null; this.player.port.postMessage({ type: 'loop', on: false }); this.emit('loop'); }
  reloop() { if (this.lastLoop) this.setLoop(this.lastLoop.a, this.lastLoop.b, this.lastLoop.beats, true); }
  roll(beats, on) {
    if (on) {
      const b = this.beatLen * beats; const p = this.position();
      const a = this.an_ ? this.an_.firstBeat + Math.floor((p - this.an_.firstBeat) / b) * b : p;
      this.player.port.postMessage({ type: 'roll', on: true, a: Math.max(0, a), b: Math.max(0, a) + b });
    } else this.player.port.postMessage({ type: 'roll', on: false });
  }
  beatJump(beats) { this.seek(this.position() + beats * this.beatLen); if (this.loop) this.loopMove(beats); }

  /* Performance FX */
  brake(dur = 1.2) { this.player.port.postMessage({ type: 'brake', dur }); }
  spinback(dur = 1.4) { this.player.port.postMessage({ type: 'spin', dur }); }
  reverse(on) { this.player.port.postMessage({ type: 'reverse', on }); }
  setSlip(on) { this.player.port.postMessage({ type: 'slip', on }); }
  scratch(on) { this.player.port.postMessage({ type: 'scratch', on }); }
  scratchVel(v) { this.player.port.postMessage({ type: 'scratchVel', v }); }

  eject() { this.pause(); this.player.port.postMessage({ type: 'unload' }); this.track = null; this.an_ = null; this.duration = 0; this.emit('load'); this.emit('state'); }
}

/* ---------- Sampler with synthesized one-shots ---------- */
export const SAMPLE_NAMES = ['Air Horn', 'Siren', 'Kick', 'Clap', 'Laser', 'Riser', 'Impact', 'Scratch'];
class Sampler {
  constructor(engine) {
    this.engine = engine; this.ctx = engine.ctx;
    this.out = this.ctx.createGain(); this.out.gain.value = 0.7; this.out.connect(engine.master);
    this.buffers = new Array(8).fill(null);
    this.ready = this.render();
  }
  setVolume(v) { this.out.gain.setTargetAtTime(v, this.ctx.currentTime, 0.02); }
  async render() {
    const sr = this.ctx.sampleRate;
    const mk = async (dur, fn) => { const oc = new OfflineAudioContext(2, Math.ceil(sr * dur), sr); fn(oc); return oc.startRendering(); };
    const noiseBuf = (oc, dur) => { const b = oc.createBuffer(1, Math.ceil(sr * dur), sr); const d = b.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1; return b; };
    this.buffers[0] = await mk(1.6, (oc) => { // air horn
      const g = oc.createGain(); g.connect(oc.destination);
      const f = oc.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 3500; f.connect(g);
      [0, 0.25, 0.5].forEach((st) => {
        for (const fr of [415, 420, 622]) { const o = oc.createOscillator(); o.type = 'sawtooth'; o.frequency.value = fr; const og = oc.createGain(); og.gain.setValueAtTime(0, st); og.gain.linearRampToValueAtTime(0.12, st + 0.02); og.gain.setValueAtTime(0.12, st + (st === 0.5 ? 0.9 : 0.18)); og.gain.linearRampToValueAtTime(0, st + (st === 0.5 ? 1.05 : 0.22)); o.connect(og); og.connect(f); o.start(st); o.stop(st + 1.1); }
      });
    });
    this.buffers[1] = await mk(2.5, (oc) => { // siren
      const o = oc.createOscillator(); o.type = 'square'; const l = oc.createOscillator(); l.frequency.value = 3; const lg = oc.createGain(); lg.gain.value = 250; l.connect(lg); lg.connect(o.frequency); o.frequency.value = 900;
      const f = oc.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 2500; const g = oc.createGain(); g.gain.setValueAtTime(0.18, 0); g.gain.linearRampToValueAtTime(0, 2.5);
      o.connect(f); f.connect(g); g.connect(oc.destination); o.start(); l.start();
    });
    this.buffers[2] = await mk(0.6, (oc) => { // kick
      const o = oc.createOscillator(); o.frequency.setValueAtTime(150, 0); o.frequency.exponentialRampToValueAtTime(42, 0.12);
      const g = oc.createGain(); g.gain.setValueAtTime(1, 0); g.gain.exponentialRampToValueAtTime(0.001, 0.55); o.connect(g); g.connect(oc.destination); o.start();
    });
    this.buffers[3] = await mk(0.5, (oc) => { // clap
      const n = oc.createBufferSource(); n.buffer = noiseBuf(oc, 0.5); const f = oc.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = 1500; f.Q.value = 1.2;
      const g = oc.createGain(); g.gain.setValueAtTime(0, 0);
      [0, 0.012, 0.024].forEach(t => { g.gain.setValueAtTime(0.9, t); g.gain.exponentialRampToValueAtTime(0.1, t + 0.01); });
      g.gain.setValueAtTime(0.8, 0.035); g.gain.exponentialRampToValueAtTime(0.001, 0.45);
      n.connect(f); f.connect(g); g.connect(oc.destination); n.start();
    });
    this.buffers[4] = await mk(0.8, (oc) => { // laser
      const o = oc.createOscillator(); o.type = 'sawtooth'; o.frequency.setValueAtTime(2800, 0); o.frequency.exponentialRampToValueAtTime(120, 0.6);
      const g = oc.createGain(); g.gain.setValueAtTime(0.25, 0); g.gain.exponentialRampToValueAtTime(0.001, 0.75); o.connect(g); g.connect(oc.destination); o.start();
    });
    this.buffers[5] = await mk(4, (oc) => { // riser
      const n = oc.createBufferSource(); n.buffer = noiseBuf(oc, 4); const f = oc.createBiquadFilter(); f.type = 'bandpass'; f.Q.value = 3;
      f.frequency.setValueAtTime(300, 0); f.frequency.exponentialRampToValueAtTime(9000, 3.9);
      const o = oc.createOscillator(); o.type = 'sawtooth'; o.frequency.setValueAtTime(110, 0); o.frequency.exponentialRampToValueAtTime(880, 3.9); const og = oc.createGain(); og.gain.value = 0.05;
      const g = oc.createGain(); g.gain.setValueAtTime(0.01, 0); g.gain.exponentialRampToValueAtTime(0.5, 3.8); g.gain.linearRampToValueAtTime(0, 4);
      n.connect(f); f.connect(g); o.connect(og); og.connect(g); g.connect(oc.destination); n.start(); o.start();
    });
    this.buffers[6] = await mk(3, (oc) => { // impact / boom
      const o = oc.createOscillator(); o.frequency.setValueAtTime(90, 0); o.frequency.exponentialRampToValueAtTime(28, 2.5);
      const g = oc.createGain(); g.gain.setValueAtTime(1, 0); g.gain.exponentialRampToValueAtTime(0.001, 2.9);
      const n = oc.createBufferSource(); n.buffer = noiseBuf(oc, 3); const nf = oc.createBiquadFilter(); nf.type = 'lowpass'; nf.frequency.setValueAtTime(6000, 0); nf.frequency.exponentialRampToValueAtTime(100, 1.5);
      const ng = oc.createGain(); ng.gain.setValueAtTime(0.5, 0); ng.gain.exponentialRampToValueAtTime(0.001, 1.5);
      o.connect(g); g.connect(oc.destination); n.connect(nf); nf.connect(ng); ng.connect(oc.destination); o.start(); n.start();
    });
    this.buffers[7] = await mk(0.7, (oc) => { // scratch
      const n = oc.createBufferSource(); n.buffer = noiseBuf(oc, 0.7); const f = oc.createBiquadFilter(); f.type = 'bandpass'; f.Q.value = 6;
      const pts = [[0, 400], [0.12, 2200], [0.22, 300], [0.36, 2600], [0.5, 500], [0.65, 1800]];
      pts.forEach(([t, fr]) => f.frequency.linearRampToValueAtTime(fr, t));
      const g = oc.createGain(); g.gain.setValueAtTime(0, 0);
      pts.forEach(([t], i) => { g.gain.linearRampToValueAtTime(i % 2 ? 0.1 : 0.9, t); });
      n.connect(f); f.connect(g); g.connect(oc.destination); n.start();
    });
  }
  trigger(i) {
    const b = this.buffers[i]; if (!b) return;
    this.engine.resume();
    const s = this.ctx.createBufferSource(); s.buffer = b; s.connect(this.out); s.start();
  }
}
