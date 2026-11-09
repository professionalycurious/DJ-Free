/* Automix: beat-matched, phrase-aligned automatic transitions between queued tracks. */
import { settings } from './engine.js';
import { camelotCompatible, camelotParse } from './library.js';

export const TRANSITIONS = [
  { id: 'smart', name: 'Smart (auto pick)' },
  { id: 'eq', name: 'EQ Bass Swap' },
  { id: 'fade', name: 'Smooth Fade' },
  { id: 'filter', name: 'Filter Sweep' },
  { id: 'echo', name: 'Echo Out' },
  { id: 'reverb', name: 'Reverb Wash' },
  { id: 'spin', name: 'Spinback' },
  { id: 'brake', name: 'Tape Stop' },
  { id: 'cut', name: 'Cut on the One' },
];

export class Automix {
  constructor(engine, library, ui) {
    this.engine = engine; this.lib = library; this.ui = ui;
    this.enabled = false; this.queue = []; this.history = [];
    this.active = null;      // deck currently "on air"
    this.trans = null;       // running transition
    this.loadingNext = false;
    this.mixNowFlag = false;
    this.status = 'Off';
    this.listeners = new Set();
    setInterval(() => this.tick(), 50);
  }
  on(f) { this.listeners.add(f); }
  emit(ev) { for (const f of this.listeners) f(ev); }

  add(tracks, front = false) {
    if (front) this.queue.unshift(...tracks); else this.queue.push(...tracks);
    if (settings.amHarmonic) this.harmonicSort();
    this.emit('queue');
  }
  remove(i) { this.queue.splice(i, 1); this.emit('queue'); this.invalidateNext(); }
  move(i, d) { const j = i + d; if (j < 0 || j >= this.queue.length) return; [this.queue[i], this.queue[j]] = [this.queue[j], this.queue[i]]; this.emit('queue'); if (i === 0 || j === 0) this.invalidateNext(); }
  clear() { this.queue = []; this.emit('queue'); }
  shuffle() { for (let i = this.queue.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [this.queue[i], this.queue[j]] = [this.queue[j], this.queue[i]]; } this.emit('queue'); this.invalidateNext(); }

  /** Greedy harmonic + tempo ordering starting from what's playing now. */
  harmonicSort() {
    const cur = this.active && this.active.track;
    let prev = cur || this.queue[0]; if (!prev) return;
    const rest = this.queue.filter(t => t !== prev); const out = cur ? [] : [prev];
    while (rest.length) {
      let bi = 0, bs = Infinity;
      rest.forEach((t, i) => {
        const bpmD = prev.bpm && t.bpm ? Math.abs(Math.log2(t.bpm / prev.bpm)) * 100 : 5;
        const keyPen = camelotCompatible(prev.camelot, t.camelot) ? 0 : 6;
        const energyBonus = (t.energy || 0) >= (prev.energy || 0) ? 0 : 1;
        const s = bpmD + keyPen + energyBonus;
        if (s < bs) { bs = s; bi = i; }
      });
      prev = rest.splice(bi, 1)[0]; out.push(prev);
    }
    this.queue = out; this.emit('queue');
  }

  setEnabled(on) {
    this.enabled = on;
    if (on) {
      const playing = this.engine.decks.filter(d => d.playing);
      this.active = playing.length ? this.engine.masterDeck() : null;
      if (settings.amShuffle) this.shuffle();
      if (settings.amHarmonic) this.harmonicSort();
    } else if (this.trans) this.finish(true);
    this.status = on ? 'Ready' : 'Off';
    this.emit('state');
  }

  other(d) { return this.engine.decks[1 - d.index]; }
  invalidateNext() { if (this.active && !this.trans) { const n = this.other(this.active); if (n.automixLoaded && !n.playing) n.automixLoaded = null; } }
  mixNow() { if (this.enabled) this.mixNowFlag = true; }
  skip() { if (this.queue.length) { this.queue.shift(); this.emit('queue'); this.invalidateNext(); } }

  async startFirst() {
    const t = this.queue.shift(); if (!t) { this.status = 'Queue empty — add tracks'; this.emit('state'); return; }
    this.emit('queue');
    const deck = this.engine.decks[0];
    this.loadingNext = true; this.status = 'Loading ' + t.title; this.emit('state');
    try {
      await this.lib.loadToDeck(t, deck);
      this.resetDeck(deck); this.resetDeck(this.other(deck));
      this.engine.setCrossfader(0); this.ui.syncMixer();
      deck.setVolume(0.85);
      if (settings.amSkipSilence) deck.seek(deck.an_.mixIn);
      deck.play();
      this.active = deck; this.history.push(t);
      this.status = 'Playing'; this.emit('state');
    } catch (e) { this.status = 'Could not load ' + t.title; this.emit('state'); }
    this.loadingNext = false;
  }

  async prepareNext() {
    const cur = this.active, next = this.other(cur);
    const t = this.queue[0];
    if (!t || this.loadingNext) return;
    this.loadingNext = true;
    try {
      await this.lib.loadToDeck(t, next);
      next.automixLoaded = t;
      this.resetDeck(next);
      next.setVolume(0.85);
      next.seek(settings.amSkipSilence ? next.an_.mixIn : 0);
      if (settings.amSync && next.bpm && cur.bpm) this.matchTempo(next, cur);
    } catch (e) { this.queue.shift(); this.emit('queue'); }
    this.loadingNext = false;
    this.emit('state');
  }

  matchTempo(next, cur) {
    let target = cur.liveBpm;
    if (target / next.bpm > 1.5) target /= 2; else if (next.bpm / target > 1.5) target *= 2;
    const pct = (target / next.bpm - 1) * 100;
    // only beat-match within a sane range; otherwise use a tempo-independent transition
    next.tempoMatched = Math.abs(pct) <= 12;
    next.setPitch(next.tempoMatched ? pct : 0);
  }

  resetDeck(d) {
    d.setEq('low', 0.5); d.setEq('mid', 0.5); d.setEq('high', 0.5); d.setFilter(0.5);
    d.resetSend();
    d.uiEq = { low: 0.5, mid: 0.5, high: 0.5, filter: 0.5 };
    this.ui.syncDeckKnobs(d);
  }

  pickTransition(cur, next) {
    let id = settings.amTransition;
    if (id !== 'smart') return id;
    const synced = settings.amSync && next.tempoMatched;
    if (!synced) return ['echo', 'spin', 'reverb', 'brake'][Math.floor(Math.random() * 4)];
    const harmonic = camelotCompatible(cur.an_.camelot, next.an_.camelot);
    const r = Math.random();
    if (harmonic) return r < 0.55 ? 'eq' : r < 0.8 ? 'fade' : 'filter';
    return r < 0.45 ? 'filter' : r < 0.75 ? 'echo' : 'eq';
  }

  tick() {
    if (this.engine.poll) this.engine.poll();
    if (!this.enabled) return;
    const E = this.engine;
    if (this.trans) return this.runTransition();
    if (!this.active || (!this.active.playing && !this.active.track)) {
      if (!this.loadingNext) this.startFirst();
      return;
    }
    const cur = this.active, next = this.other(cur);
    if (!cur.playing && !this.loadingNext && !cur.cuePreview) {
      // track ended or user stopped it: jump straight to the next track
      if (next.automixLoaded) { this.beginTransition(true); return; }
      if (!this.queue.length) { this.status = 'Queue finished'; this.emit('state'); return; }
    }
    if (this.queue.length && next.automixLoaded !== this.queue[0] && !this.loadingNext && !next.playing) this.prepareNext();
    if (!next.automixLoaded || !cur.an_) { this.status = this.queue.length ? 'Preparing next…' : 'Last track — add more to the queue'; return; }

    const beats = this.transBeats(cur);
    const startAt = Math.max(cur.an_.mixIn + 8 * cur.beatLen, cur.an_.mixOut - beats * cur.beatLen);
    const pos = cur.position();
    const remain = (startAt - pos) / cur.rate;
    this.countdown = remain;
    this.status = remain > 0 ? `Next mix in ${fmt(remain)}` : 'Mixing…';
    if (this.mixNowFlag || pos >= startAt - 0.05 || (cur.duration - pos) / cur.rate < 4) {
      this.mixNowFlag = false;
      this.beginTransition(false);
    }
    this.emit('tick');
  }

  transBeats(cur) {
    let beats = settings.amBeats;
    const avail = (cur.an_.mixOut - cur.an_.mixIn) / cur.beatLen;
    while (beats > 4 && beats > avail / 3) beats /= 2;
    return beats;
  }

  beginTransition(immediate) {
    const cur = this.active, next = this.other(cur), E = this.engine;
    const type = immediate ? 'cut' : this.pickTransition(cur, next);
    // next downbeat (bar boundary) of the outgoing track, converted to context time
    let startCtx = E.now() + 0.08;
    if (!immediate && cur.an_ && cur.playing) {
      const pos = cur.position(), bar = cur.beatLen * 4, fb = cur.an_.firstBeat;
      let nb = fb + Math.ceil((pos - fb) / bar - 1e-3) * bar;
      if (nb - pos < 0.08) nb += bar;
      // a beat is enough for quick transitions
      if (type === 'spin' || type === 'brake' || type === 'cut') { nb = fb + Math.ceil((pos - fb) / cur.beatLen) * cur.beatLen; if (nb - pos < 0.08) nb += cur.beatLen; }
      startCtx = E.now() + (nb - pos) / cur.rate;
    }
    const beatSec = cur.beatLen / cur.rate;
    let beats = this.transBeats(cur);
    if (type === 'cut' || type === 'spin' || type === 'brake') beats = 2;
    if (type === 'echo') beats = Math.min(beats, 16);
    const dur = beats * beatSec;
    let nextStart = startCtx;
    if (type === 'spin' || type === 'brake') nextStart = startCtx + beatSec * 2;
    next.play(nextStart);
    this.trans = { type, cur, next, start: startCtx, dur, nextStart, fired: {}, xStart: E.xfader };
    this.status = 'Mixing: ' + (TRANSITIONS.find(t => t.id === type) || {}).name;
    this.emit('state');
  }

  runTransition() {
    const tr = this.trans, E = this.engine;
    const { cur, next, type } = tr;
    const now = E.now();
    const p = Math.max(0, Math.min(1, (now - tr.start) / Math.max(0.001, tr.dur)));
    this.progress = p;
    const toNext = next.index === 1 ? (v) => v : (v) => 1 - v; // crossfader position heading towards next deck
    const setX = (v) => { E.setCrossfader(toNext(v)); };
    const eq = (d, band, v) => { d.setEq(band, v); d.uiEq = d.uiEq || {}; d.uiEq[band] = v; };
    const flt = (d, v) => { d.setFilter(v); d.uiEq = d.uiEq || {}; d.uiEq.filter = v; };
    if (now < tr.start) { if (type === 'eq' || type === 'filter') eq(next, 'low', 0); return; }
    switch (type) {
      case 'fade': setX(smooth(p)); break;
      case 'cut': setX(1); break;
      case 'eq': {
        // bring next in without bass, swap basslines on the halfway bar, then fade out
        setX(Math.min(0.5, p * 1.2) + (p > 0.6 ? (p - 0.6) * 1.25 : 0));
        if (p < 0.5) { eq(next, 'low', 0); eq(cur, 'low', 0.5); } else { eq(next, 'low', 0.5); eq(cur, 'low', 0); }
        eq(cur, 'high', 0.5 - Math.max(0, p - 0.6) * 0.8);
        break;
      }
      case 'filter': {
        flt(cur, 0.5 + p * 0.45); // HPF sweep out
        flt(next, Math.min(0.5, 0.12 + p * 0.6)); // LPF opening in
        if (p < 0.5) eq(next, 'low', 0); else { eq(next, 'low', 0.5); eq(cur, 'low', 0); }
        setX(smooth(Math.min(1, p * 1.15)));
        break;
      }
      case 'echo': {
        setX(Math.min(0.5, p * 0.7));
        eq(next, 'low', p < 0.75 ? 0 : 0.5);
        if (p >= 0.75 && !tr.fired.echo) {
          tr.fired.echo = true;
          cur.echoPulse(cur.beatLen / cur.rate * 0.75, 0.6);
          setX(1);
        }
        if (p >= 0.75) setX(1);
        break;
      }
      case 'reverb': {
        cur.setSendFx({ rev: p * 1.2, revTc: 0.05, fb: 0 }); cur.setSend(p < 0.85 ? 1 : 0, 0.05);
        flt(cur, 0.5 + p * 0.4);
        eq(next, 'low', p < 0.7 ? 0 : 0.5);
        setX(p < 0.85 ? smooth(p * 0.6) : 1);
        break;
      }
      case 'spin': case 'brake': {
        if (!tr.fired.stop) { tr.fired.stop = true; type === 'spin' ? cur.spinback(beatsToSec(cur, 2)) : cur.brake(beatsToSec(cur, 2)); }
        if (now >= tr.nextStart) setX(1);
        break;
      }
    }
    this.ui.syncMixer();
    if (p >= 1 && now >= tr.nextStart) this.finish(false);
  }

  finish(aborted) {
    const tr = this.trans; if (!tr) return;
    const { cur, next } = tr;
    this.trans = null; this.progress = 0;
    if (!aborted) {
      // let echo / reverb tails ring out
      setTimeout(() => { cur.pause(); this.resetDeck(cur); cur.automixLoaded = null; cur.setPitch(0); }, tr.type === 'echo' || tr.type === 'reverb' ? 3000 : 50);
      this.engine.setCrossfader(next.index === 1 ? 1 : 0);
      this.resetDeck(next);
      next.automixLoaded = null;
      if (this.queue[0] === next.track) this.queue.shift();
      this.history.push(next.track);
      this.active = next;
      this.glideTempo(next);
      this.emit('queue');
    }
    this.ui.syncMixer();
    this.emit('state');
  }

  /** Slowly return a beat-matched track to its original tempo (over ~30 s) once it is alone. */
  glideTempo(d) {
    const start = d.pitch; if (Math.abs(start) < 0.05) return;
    const t0 = performance.now(), len = 30000;
    const step = () => {
      if (this.active !== d || this.trans) return;
      const p = Math.min(1, (performance.now() - t0) / len);
      d.setPitch(start * (1 - p));
      if (p < 1) setTimeout(step, 250);
    };
    setTimeout(step, 2000);
  }
}

function beatsToSec(d, b) { return d.beatLen / d.rate * b; }
const smooth = (p) => p * p * (3 - 2 * p);
export function fmt(s) { if (!isFinite(s)) return '--:--'; s = Math.max(0, s); const m = Math.floor(s / 60), ss = Math.floor(s % 60); return m + ':' + String(ss).padStart(2, '0'); }
export { camelotParse };
