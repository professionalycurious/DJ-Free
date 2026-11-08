/* Track library: local files, demo tracks, Apple Music previews. Handles decoding, analysis and caching. */
import { analyzeBuffer } from './engine.js';
import { renderDemo, demoTracks } from './demo.js';
import { proxied } from './applemusic.js';

export class Library {
  constructor(engine) {
    this.engine = engine;
    this.local = [];
    this.demo = demoTracks();
    this.cache = new Map(); // id -> {buffer, analysis}
    this.order = [];
    this.analysisQueue = [];
    this.busy = false;
    this.listeners = new Set();
    this.metaCache = loadMeta();
  }
  on(f) { this.listeners.add(f); }
  emit(ev, t) { for (const f of this.listeners) f(ev, t); }

  addFiles(files) {
    const added = [];
    for (const f of files) {
      if (!/^audio\/|^video\/mp4|ogg$/.test(f.type) && !/\.(mp3|m4a|aac|wav|flac|ogg|opus|webm|mp4|aiff?)$/i.test(f.name)) continue;
      const id = 'f-' + f.name + '-' + f.size;
      if (this.local.find(t => t.id === id)) continue;
      const base = f.name.replace(/\.[^.]+$/, '');
      const m = base.split(' - ');
      const t = { id, source: 'local', file: f, title: m.length > 1 ? m.slice(1).join(' - ') : base, artist: m.length > 1 ? m[0] : '' };
      Object.assign(t, this.metaCache[id] || {});
      this.local.push(t); added.push(t);
    }
    for (const t of added) if (!t.bpm) this.queueAnalysis(t);
    this.emit('change');
    return added;
  }

  queueAnalysis(t) { this.analysisQueue.push(t); this.pump(); }
  async pump() {
    if (this.busy) return;
    const t = this.analysisQueue.shift(); if (!t) return;
    this.busy = true;
    try { if (!t.bpm) await this.get(t, true); } catch (e) { t.error = true; }
    this.busy = false;
    this.emit('meta', t);
    setTimeout(() => this.pump(), 30);
  }

  async decode(t) {
    let ab;
    if (t.source === 'local') ab = await t.file.arrayBuffer();
    else if (t.source === 'demo') return renderDemo(t.demo, this.engine.ctx.sampleRate);
    else if (t.source === 'apple') {
      const r = await fetch(proxied(t.previewUrl));
      if (!r.ok) throw new Error('Preview download failed (' + r.status + ')');
      ab = await r.arrayBuffer();
    } else throw new Error('Unknown source');
    return this.engine.ctx.decodeAudioData(ab);
  }

  /** Returns {buffer, analysis}; keeps the 4 most recent decoded tracks in memory. */
  async get(t, metaOnly = false) {
    if (this.cache.has(t.id)) { this.touch(t.id); return this.cache.get(t.id); }
    t.loading = true; this.emit('meta', t);
    try {
      const buffer = await this.decode(t);
      const analysis = await analyzeBuffer(buffer);
      Object.assign(t, { bpm: analysis.bpm, key: analysis.key, camelot: analysis.camelot, duration: analysis.duration, energy: avg(analysis.energy) });
      this.metaCache[t.id] = { bpm: t.bpm, key: t.key, camelot: t.camelot, duration: t.duration, energy: t.energy };
      saveMeta(this.metaCache);
      const entry = { buffer, analysis };
      if (!metaOnly) { this.cache.set(t.id, entry); this.touch(t.id); }
      return entry;
    } finally { t.loading = false; this.emit('meta', t); }
  }
  touch(id) {
    this.order = this.order.filter(x => x !== id); this.order.push(id);
    while (this.order.length > 4) {
      const old = this.order.shift();
      const inUse = this.engine.decks.some(d => d.track && d.track.id === old);
      if (inUse) { this.order.unshift(old); break; }
      this.cache.delete(old);
    }
  }

  async loadToDeck(t, deck) {
    const { buffer, analysis } = await this.get(t);
    await deck.load(t, buffer, analysis);
    return deck;
  }
}

function avg(a) { if (!a || !a.length) return 0; let s = 0; for (const v of a) s += v; return s / a.length; }
function loadMeta() { try { return JSON.parse(localStorage.getItem('djfree.meta')) || {}; } catch (e) { return {}; } }
function saveMeta(m) { try { localStorage.setItem('djfree.meta', JSON.stringify(m)); } catch (e) { /* quota */ } }

/* Camelot helpers */
export function camelotParse(c) { const m = /^(\d+)([AB])$/.exec(c || ''); return m ? { n: +m[1], l: m[2] } : null; }
export function camelotCompatible(a, b) {
  const x = camelotParse(a), y = camelotParse(b); if (!x || !y) return true;
  if (x.n === y.n) return true;
  const d = Math.min((x.n - y.n + 12) % 12, (y.n - x.n + 12) % 12);
  return d === 1 && x.l === y.l;
}
export function camelotColor(c) {
  const p = camelotParse(c); if (!p) return '#555';
  return `hsl(${(p.n - 1) * 30 + 10}, ${p.l === 'A' ? 75 : 55}%, ${p.l === 'A' ? 55 : 65}%)`;
}
