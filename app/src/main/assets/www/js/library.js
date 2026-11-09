/* Track library: local files, demo tracks, Apple Music previews. Handles decoding, analysis and caching.
 * Native mode (Android): audio is decoded by the app (MediaCodec) and only analysis data comes to JS. */
import { analyzeBuffer, analyzeMono } from './engine.js';
import { renderDemo, demoTracks } from './demo.js';
import { proxied } from './applemusic.js';
import { nativePrepare, nativeMono, nativeHasTrack, uploadPcm } from './native-engine.js';

export class Library {
  constructor(engine) {
    this.engine = engine;
    this.native = !!engine.native;
    this.local = [];
    this.demo = demoTracks();
    this.cache = new Map(); // id -> {buffer?, analysis, duration}
    this.order = [];
    this.analysisQueue = [];
    this.busy = false;
    this.listeners = new Set();
    this.metaCache = loadMeta();
    this.desktop = !!window.DJDesktop;
    if (this.native || this.desktop) this.restoreLocal();
  }
  on(f) { this.listeners.add(f); }
  emit(ev, t) { for (const f of this.listeners) f(ev, t); }

  /* ---- browser: File objects ---- */
  addFiles(files) {
    const added = [];
    for (const f of files) {
      if (/^(image|text)\//.test(f.type)) continue;
      const path = this.desktop ? window.DJDesktop.pathForFile(f) : '';
      const id = path ? 'p:' + path : 'f-' + f.name + '-' + f.size;
      if (this.local.find(t => t.id === id)) continue;
      const t = Object.assign(path ? { id, source: 'path', path } : { id, source: 'local', file: f }, splitName(f.name), this.metaCache[id] || {});
      this.local.push(t); added.push(t);
    }
    this.saveLocal();
    for (const t of added) if (!t.bpm) this.queueAnalysis(t);
    this.emit('change');
    return added;
  }

  /* ---- Android: content URIs picked natively (kept across app restarts) ---- */
  addNativeFiles(files) {
    const added = [];
    for (const f of files) {
      const id = 'u:' + f.uri;
      if (this.local.find(t => t.id === id)) continue;
      const nm = splitName(f.name || 'Track');
      const t = Object.assign({ id, source: 'uri', uri: f.uri, title: f.title || nm.title, artist: f.artist || nm.artist, duration: f.duration || 0 }, this.metaCache[id] || {});
      this.local.push(t); added.push(t);
    }
    this.saveLocal();
    for (const t of added) if (!t.bpm) this.queueAnalysis(t);
    this.emit('change');
    return added;
  }
  removeLocal(t) { this.local = this.local.filter(x => x !== t); this.saveLocal(); this.emit('change'); }
  clearLocal() { this.local = []; this.saveLocal(); this.emit('change'); }
  saveLocal() {
    if (!this.native && !this.desktop) return;
    const keep = this.local.filter(t => t.source === 'uri' || t.source === 'path');
    try { localStorage.setItem('djfree.lib', JSON.stringify(keep.map(t => ({ uri: t.uri, path: t.path, title: t.title, artist: t.artist, duration: t.duration })))); } catch (e) { /* quota */ }
  }
  restoreLocal() {
    let list = []; try { list = JSON.parse(localStorage.getItem('djfree.lib')) || []; } catch (e) { /* ignore */ }
    for (const f of list) {
      if (f.uri && this.native) {
        const id = 'u:' + f.uri;
        this.local.push(Object.assign({ id, source: 'uri', uri: f.uri, title: f.title, artist: f.artist, duration: f.duration }, this.metaCache[id] || {}));
      } else if (f.path && this.desktop) {
        const id = 'p:' + f.path;
        this.local.push(Object.assign({ id, source: 'path', path: f.path, title: f.title, artist: f.artist, duration: f.duration }, this.metaCache[id] || {}));
      }
    }
    for (const t of this.local) if (!t.bpm) this.queueAnalysis(t);
  }

  queueAnalysis(t) { this.analysisQueue.push(t); this.pump(); }
  async pump() {
    if (this.busy) return;
    const t = this.analysisQueue.shift(); if (!t) return;
    this.busy = true;
    try { if (!t.bpm) await this.get(t, true); } catch (e) { t.error = true; t.errorMsg = e.message; }
    this.busy = false;
    this.emit('meta', t);
    setTimeout(() => this.pump(), 30);
  }

  srcOf(t) {
    if (t.source === 'uri') return { type: 'uri', uri: t.uri };
    if (t.source === 'apple') return { type: 'url', url: t.previewUrl };
    throw new Error('Unknown source');
  }

  /* web backend decoding */
  async decode(t) {
    let ab;
    if (t.source === 'local') ab = await t.file.arrayBuffer();
    else if (t.source === 'path') {
      const r = await fetch('/__file?p=' + encodeURIComponent(t.path));
      if (!r.ok) throw new Error('file not found (moved or deleted?)');
      ab = await r.arrayBuffer();
    }
    else if (t.source === 'demo') return renderDemo(t.demo, this.engine.sampleRate);
    else if (t.source === 'apple') {
      const r = await fetch(proxied(t.previewUrl));
      if (!r.ok) throw new Error('Preview download failed (' + r.status + ')');
      ab = await r.arrayBuffer();
    } else throw new Error('Unknown source');
    try { return await this.engine.decode(ab); }
    catch (e) { throw new Error('this file format can\'t be decoded'); }
  }

  /** Returns {buffer?, analysis, duration}. metaOnly = background BPM/key scan. */
  async get(t, metaOnly = false) {
    if (this.cache.has(t.id)) {
      this.touch(t.id);
      if (this.native && !metaOnly) await this.ensureNative(t);
      return this.cache.get(t.id);
    }
    t.loading = true; this.emit('meta', t);
    try {
      let entry;
      if (this.native) {
        if (t.source === 'demo') {
          const buf = await renderDemo(t.demo, 44100);
          uploadPcm(t.id, [buf.getChannelData(0), buf.getChannelData(1)], 44100, -1);
          entry = { analysis: await analyzeBuffer(buf), duration: buf.duration };
        } else {
          const r = await nativePrepare(t.id, this.srcOf(t), !metaOnly, true);
          if (!r.ok) throw new Error(r.error || 'could not decode this file');
          const mono = await nativeMono(t.id), copy = mono.slice(0);
          entry = { analysis: await analyzeMono(mono, r.monoRate, () => copy), duration: r.duration };
        }
      } else {
        const buffer = await this.decode(t);
        entry = { buffer, analysis: await analyzeBuffer(buffer), duration: buffer.duration };
      }
      const a = entry.analysis;
      Object.assign(t, { bpm: a.bpm, key: a.key, camelot: a.camelot, duration: entry.duration, energy: avg(a.energy) });
      t.error = false;
      this.metaCache[t.id] = { bpm: t.bpm, key: t.key, camelot: t.camelot, duration: t.duration, energy: t.energy };
      saveMeta(this.metaCache);
      if (this.native || !metaOnly) { this.cache.set(t.id, entry); this.touch(t.id); }
      return entry;
    } finally { t.loading = false; this.emit('meta', t); }
  }

  /** Makes sure the native engine holds the full PCM of a track (re-decodes after eviction). */
  async ensureNative(t) {
    if (nativeHasTrack(t.id)) return;
    if (t.source === 'demo') {
      const buf = await renderDemo(t.demo, 44100);
      uploadPcm(t.id, [buf.getChannelData(0), buf.getChannelData(1)], 44100, -1);
      return;
    }
    t.loading = true; this.emit('meta', t);
    try {
      const r = await nativePrepare(t.id, this.srcOf(t), true, false);
      if (!r.ok) throw new Error(r.error || 'could not decode this file');
    } finally { t.loading = false; this.emit('meta', t); }
  }

  touch(id) {
    const cap = this.native ? 24 : 4;
    this.order = this.order.filter(x => x !== id); this.order.push(id);
    while (this.order.length > cap) {
      const old = this.order.shift();
      const inUse = this.engine.decks.some(d => d.track && d.track.id === old);
      if (inUse) { this.order.unshift(old); break; }
      this.cache.delete(old);
    }
  }

  async loadToDeck(t, deck) {
    const e = await this.get(t);
    await deck.load(t, e.buffer, e.analysis, e.duration);
    return deck;
  }
}

function splitName(name) {
  const base = String(name).replace(/\.[^.]+$/, ''); const m = base.split(' - ');
  return m.length > 1 ? { title: m.slice(1).join(' - '), artist: m[0] } : { title: base, artist: '' };
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
