/* DJ Free user interface. */
import { settings, saveSettings, SAMPLE_NAMES } from './engine.js';
import { FX_LIST, BEAT_DIVS } from './fx.js';
import { Knob, Fader, toggle, seg, toast, h, esc } from './widgets.js';
import { TRANSITIONS, fmt } from './automix.js';
import { camelotColor, camelotParse } from './library.js';
import * as AM from './applemusic.js';

const COLORS = ['#00e5ff', '#ff2d7a'];
const CUE_COLORS = ['#ff3b3b', '#ff9f1c', '#ffe14d', '#3ddc84', '#00e5ff', '#4d7cff', '#b04dff', '#ff4dc4'];

export class UI {
  constructor(engine, library) {
    this.E = engine; this.L = library; this.AM = null;
    this.knobs = [{}, {}];
    this.zoom = [1, 1];
    this.libSrc = 'local'; this.libFilter = '';
    this.appleResults = []; this.appleTitle = '';
    this.padMode = ['cues', 'cues'];
    this.cueDelete = [false, false];
    this.loadConfirm = {};
  }

  init(automix) {
    this.AM = automix;
    this.buildTabs();
    this.buildDecks();
    this.buildMixer();
    this.buildFx();
    this.buildPads();
    this.buildLibrary();
    this.buildAutomix();
    this.buildHeader();
    this.setupWaves();
    for (const d of this.E.decks) d.on((ev) => this.onDeck(ev, d));
    this.L.on(() => this.renderLibSoon());
    automix.on((ev) => this.onAutomix(ev));
    window.addEventListener('resize', () => this.resizeCanvases());
    this.resizeCanvases();
    requestAnimationFrame(() => this.frame());
  }

  /* ---------------- tabs ---------------- */
  buildTabs() {
    document.querySelectorAll('#tabs button').forEach((b) => b.addEventListener('click', () => this.showPage(b.dataset.page)));
  }
  showPage(p) {
    document.querySelectorAll('#tabs button').forEach((x) => x.classList.toggle('active', x.dataset.page === p));
    document.querySelectorAll('.page').forEach((x) => x.classList.toggle('active', x.id === 'page-' + p));
    this.page = p;
    if (p === 'library') this.renderLib();
    if (p === 'automix') this.renderQueue();
    requestAnimationFrame(() => this.resizeCanvases());
  }

  /* ---------------- header ---------------- */
  buildHeader() {
    const E = this.E;
    this.masterKnob = new Knob(document.getElementById('masterKnob'), { label: 'MST', value: 0.8, def: 0.8, onChange: (v) => E.setMasterVolume(v) });
    E.setMasterVolume(0.8);
    document.getElementById('amToggle').addEventListener('click', () => this.toggleAutomix());
    document.getElementById('settingsBtn').addEventListener('click', () => this.openSettings());
    document.getElementById('modalClose').addEventListener('click', () => this.closeModal());
    document.getElementById('modal').addEventListener('click', (e) => { if (e.target.id === 'modal') this.closeModal(); });
    document.getElementById('recBtn').addEventListener('click', () => this.toggleRecord());
  }

  toggleAutomix(force) {
    const on = force != null ? force : !this.AM.enabled;
    if (on && !this.AM.queue.length && !this.E.decks.some(d => d.playing)) {
      const src = this.L.local.length ? this.L.local : this.L.demo;
      this.AM.add(src.slice());
      toast(`Queued ${src.length} ${this.L.local.length ? 'tracks' : 'demo tracks'} for automix`);
    }
    this.AM.setEnabled(on);
  }

  async toggleRecord() {
    const btn = document.getElementById('recBtn');
    if (!this.E.rec) {
      try { this.E.startRecording(); btn.classList.add('on'); toast('Recording mix…'); }
      catch (e) { toast('Recording not supported on this device'); }
      return;
    }
    btn.classList.remove('on'); document.getElementById('recTime').textContent = 'REC';
    const blob = await this.E.stopRecording(); if (!blob) return;
    const ext = blob.type.includes('mp4') ? 'm4a' : blob.type.includes('ogg') ? 'ogg' : 'webm';
    const name = `DJFree-Mix-${new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19)}.${ext}`;
    if (window.DJNative) {
      toast('Saving mix…');
      const id = 's' + Date.now();
      window.DJNative.saveBegin(id);
      const buf = new Uint8Array(await blob.arrayBuffer());
      const CH = 384 * 1024;
      for (let i = 0; i < buf.length; i += CH) {
        let s = ''; const part = buf.subarray(i, i + CH);
        for (let j = 0; j < part.length; j += 8192) s += String.fromCharCode.apply(null, part.subarray(j, j + 8192));
        window.DJNative.saveChunk(id, btoa(s));
      }
      const path = window.DJNative.saveEnd(id, name, blob.type.split(';')[0]);
      toast(path ? 'Saved to ' + path : 'Could not save recording', 4000);
    } else {
      const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; a.click();
      toast('Mix downloaded');
    }
  }

  /* ---------------- decks ---------------- */
  buildDecks() {
    this.deckUI = [];
    document.querySelectorAll('.deck-col').forEach((col) => {
      const i = +col.dataset.deck, d = this.E.decks[i];
      const ui = {};
      const tr = h('div', 'transport');
      ui.sync = h('button', 'sync', 'SYNC'); ui.cue = h('button', 'cue', 'CUE'); ui.play = h('button', 'play', '▶︎');
      tr.append(ui.sync, ui.cue, ui.play);
      ui.sync.addEventListener('click', () => { if (!d.sync()) toast('Load tracks on both decks to sync'); });
      ui.play.addEventListener('click', () => { if (!d.track) return this.showPage('library'); d.toggle(); });
      ui.cue.addEventListener('pointerdown', () => d.cueDown());
      ui.cue.addEventListener('pointerup', () => d.cueUp());
      ui.cue.addEventListener('pointercancel', () => d.cueUp());

      const pw = h('div', 'platter-wrap');
      ui.platter = h('canvas', 'platter'); pw.appendChild(ui.platter);
      const btns = h('div', 'deck-btns');
      ui.keylock = h('button', settings.keylock ? 'on' : '', 'KEY LOCK');
      ui.slip = h('button', settings.slip ? 'on' : '', 'SLIP');
      ui.vinyl = h('button', settings.vinyl ? 'on' : '', 'VINYL');
      const load = h('button', '', 'LOAD');
      btns.append(ui.keylock, ui.slip, ui.vinyl, load);
      pw.appendChild(btns);
      ui.keylock.addEventListener('click', () => { settings.keylock = !settings.keylock; saveSettings(); this.E.decks.forEach(x => x.applyRate()); this.deckUI.forEach(u => u.keylock.classList.toggle('on', settings.keylock)); });
      ui.slip.addEventListener('click', () => { settings.slip = !settings.slip; saveSettings(); this.E.decks.forEach(x => x.setSlip(settings.slip)); this.deckUI.forEach(u => u.slip.classList.toggle('on', settings.slip)); });
      ui.vinyl.addEventListener('click', () => { settings.vinyl = !settings.vinyl; saveSettings(); this.deckUI.forEach(u => u.vinyl.classList.toggle('on', settings.vinyl)); });
      load.addEventListener('click', () => { this.loadTarget = i; this.showPage('library'); toast('Pick a track for deck ' + d.name); });
      this.jog(ui.platter, d, 'platter');

      const pitch = h('div', 'pitch');
      ui.pitchVal = h('div', 'val', '0.0%');
      pitch.appendChild(ui.pitchVal);
      ui.pitchFader = new Fader(pitch, { vertical: true, value: 0.5, def: 0.5, center: true, onChange: (v) => d.setPitch((v - 0.5) * 2 * settings.pitchRange) });
      const bend = h('div', 'bend'); const bm = h('button', '', '−'), bp = h('button', '', '+'); bend.append(bm, bp); pitch.appendChild(bend);
      const hold = (b, val) => { b.addEventListener('pointerdown', () => d.setBend(val)); ['pointerup', 'pointercancel', 'pointerleave'].forEach(ev => b.addEventListener(ev, () => d.setBend(0))); };
      hold(bm, -4); hold(bp, 4);

      col.append(tr, pw, pitch);
      this.deckUI[i] = ui;
    });
  }

  /** Jog wheel / waveform touch: scratch (vinyl mode) or pitch bend. */
  jog(el, d, kind) {
    let id = null, lastA = 0, lastX = 0, lastT = 0, idle = null, scratching = false;
    const angle = (e) => { const r = el.getBoundingClientRect(); return Math.atan2(e.clientY - (r.top + r.height / 2), e.clientX - (r.left + r.width / 2)); };
    el.addEventListener('pointerdown', (e) => {
      if (!d.track) return;
      id = e.pointerId; el.setPointerCapture(id);
      lastA = angle(e); lastX = e.clientX; lastT = performance.now();
      scratching = settings.vinyl || kind === 'wave' || !d.playing;
      if (scratching) { d.scratch(true); d.scratchVel(0); }
    });
    el.addEventListener('pointermove', (e) => {
      if (e.pointerId !== id) return;
      const now = performance.now(), dt = Math.max(1, now - lastT) / 1000;
      let secs;
      if (kind === 'platter') { let da = angle(e) - lastA; if (da > Math.PI) da -= 2 * Math.PI; if (da < -Math.PI) da += 2 * Math.PI; secs = da / (2 * Math.PI) * 1.8; lastA = angle(e); }
      else { secs = -(e.clientX - lastX) / this.pxPerSec(d.index); lastX = e.clientX; }
      lastT = now;
      const vel = secs / dt;
      if (scratching) {
        d.scratchVel(Math.max(-8, Math.min(8, vel)));
        clearTimeout(idle); idle = setTimeout(() => d.scratchVel(0), 50);
      } else d.setBend(Math.max(-12, Math.min(12, vel * 6)));
    });
    const end = (e) => {
      if (e.pointerId !== id) return; id = null; clearTimeout(idle);
      if (scratching) d.scratch(false); else d.setBend(0);
    };
    el.addEventListener('pointerup', end); el.addEventListener('pointercancel', end);
  }

  /* ---------------- mixer ---------------- */
  buildMixer() {
    const m = document.getElementById('mixer');
    const strips = h('div', 'strips');
    this.mixUI = [];
    for (let i = 0; i < 2; i++) {
      const d = this.E.decks[i], color = COLORS[i];
      const s = h('div', 'strip');
      const knobs = h('div', 'knobs');
      const k = this.knobs[i];
      const kill = (band) => () => { const killed = k[band].value > 0.02; k[band].set(killed ? 0 : 0.5); };
      k.trim = new Knob(knobs, { label: 'GAIN', value: 0.5, def: 0.5, color, onChange: (v) => d.setTrim(v) });
      k.high = new Knob(knobs, { label: 'HI', value: 0.5, def: 0.5, color, onChange: (v) => { d.setEq('high', v); k.high.setKilled(v < 0.02); }, onLong: kill('high') });
      k.mid = new Knob(knobs, { label: 'MID', value: 0.5, def: 0.5, color, onChange: (v) => { d.setEq('mid', v); k.mid.setKilled(v < 0.02); }, onLong: kill('mid') });
      k.low = new Knob(knobs, { label: 'LOW', value: 0.5, def: 0.5, color, onChange: (v) => { d.setEq('low', v); k.low.setKilled(v < 0.02); }, onLong: kill('low') });
      k.filter = new Knob(knobs, { label: 'FILTER', value: 0.5, def: 0.5, color: '#ffb020', onChange: (v) => d.setFilter(v) });
      const fcol = h('div', 'fcol');
      const cue = h('button', '', 'CUE 🎧');
      cue.addEventListener('click', () => { d.setCue(!d.cueOn); cue.classList.toggle('on', d.cueOn); if (d.cueOn && !settings.splitCue) toast('Enable Split Cue in Settings to pre-listen with a splitter cable'); });
      const fr = h('div', ''); fr.style.cssText = 'display:flex;gap:3px;flex:1;min-height:0';
      const vu = h('div', 'vu'); const vuBar = h('i'); vu.appendChild(vuBar);
      const fader = new Fader(fr, { vertical: true, value: 0.85, def: 0.85, onChange: (v) => d.setVolume(v) });
      fr.appendChild(vu);
      fcol.append(cue, fr);
      if (i === 0) s.append(knobs, fcol); else s.append(fcol, knobs);
      strips.appendChild(s);
      this.mixUI[i] = { fader, vuBar, cue };
    }
    m.appendChild(strips);
    const xr = h('div', 'xfader-row');
    xr.appendChild(h('b', '', '<span style="color:var(--a)">A</span>'));
    this.xfader = new Fader(xr, { vertical: false, value: 0.5, def: 0.5, center: true, onChange: (v) => this.E.setCrossfader(v) });
    xr.appendChild(h('b', '', '<span style="color:var(--b)">B</span>'));
    m.appendChild(xr);
  }

  syncMixer() {
    this.xfader.set(this.E.xfader, true);
    for (const d of this.E.decks) this.syncDeckKnobs(d);
  }
  syncDeckKnobs(d) {
    const k = this.knobs[d.index], u = d.uiEq; if (!u || !k.low) return;
    for (const b of ['low', 'mid', 'high']) if (u[b] != null) { k[b].set(u[b], true); k[b].setKilled(u[b] < 0.02); }
    if (u.filter != null) k.filter.set(u.filter, true);
  }

  /* ---------------- FX ---------------- */
  buildFx() {
    this.fxUI = [[], []];
    document.querySelectorAll('.fx-col').forEach((col) => {
      const i = +col.dataset.deck, d = this.E.decks[i];
      const head = h('div', 'sampler-head', `<span>DECK ${d.name} FX</span>`); col.appendChild(head);
      d.fx.forEach((slot, si) => {
        const row = h('div', 'fx-slot');
        const sel = h('select');
        sel.appendChild(new Option('— FX ' + (si + 1) + ' —', ''));
        FX_LIST.forEach((f) => sel.appendChild(new Option(f.name, f.id)));
        const def = ['echo', 'reverb', 'flanger'][si];
        sel.value = def; slot.setType(def);
        const on = h('button', 'on-btn', 'ON');
        const amt = new Knob(row, { label: 'AMT', value: 0.5, def: 0.5, color: COLORS[i], onChange: (v) => slot.setWet(v) });
        const prm = new Knob(row, { label: (FX_LIST.find(f => f.id === def) || {}).param || 'PRM', value: 0.5, def: 0.5, color: '#b04dff', onChange: (v) => slot.setParam(v) });
        row.prepend(sel, on);
        sel.addEventListener('change', () => { slot.setType(sel.value || null); const f = FX_LIST.find(x => x.id === sel.value); prm.el.querySelector('.klabel').textContent = f ? f.param.toUpperCase().slice(0, 6) : 'PRM'; this.buildXyTargets(); });
        on.addEventListener('click', () => { slot.setOn(!slot.on); on.classList.toggle('on', slot.on); });
        col.appendChild(row);
        this.fxUI[i][si] = { sel, on, amt, prm, slot };
      });
      d.fxDiv = 0.5;
      col.appendChild(h('div', 'lbl', 'BEAT'));
      seg(col, BEAT_DIVS, 0.5, (v) => d.setFxBeat(v));
      const perf = h('div', 'perf');
      const pb = (label, down, up, toggleMode) => {
        const b = h('button', '', label);
        if (toggleMode) b.addEventListener('click', () => { const on = !b.classList.contains('on'); b.classList.toggle('on', on); down(on); });
        else {
          b.addEventListener('pointerdown', () => { b.classList.add('on'); down(); });
          const u = () => { if (b.classList.contains('on')) { b.classList.remove('on'); up && up(); } };
          b.addEventListener('pointerup', u); b.addEventListener('pointercancel', u); b.addEventListener('pointerleave', u);
        }
        perf.appendChild(b);
      };
      pb('BRAKE', () => d.brake(1.5));
      pb('SPINBACK', () => d.spinback(1.6));
      pb('REVERSE', (on) => d.reverse(on), null, true);
      pb('CENSOR', () => { d.setSlip(true); d.reverse(true); }, () => { d.reverse(false); setTimeout(() => d.setSlip(settings.slip), 30); });
      pb('ECHO OUT', () => this.echoOut(d, false));
      pb('WASH OUT', () => this.echoOut(d, true));
      pb('STUTTER', () => d.roll(0.125, true), () => d.roll(0, false));
      pb('KILL ALL', () => { ['low', 'mid', 'high'].forEach(b => d.setEq(b, 0)); }, () => { ['low', 'mid', 'high'].forEach(b => d.setEq(b, this.knobs[i][b].value)); });
      col.appendChild(perf);
    });
    this.E.decks.forEach(d => d.setFxBeat(0.5));
    this.buildXyTargets();
    this.setupXy();
  }

  echoOut(d, wash) {
    if (!d.playing) return;
    const t = d.ctx.currentTime;
    d.sendDelay.delayTime.setValueAtTime(d.beatLen / d.rate * 0.75, t);
    d.sendFb.gain.setValueAtTime(wash ? 0.2 : 0.62, t);
    d.sendRevG.gain.setValueAtTime(wash ? 1.4 : 0, t);
    d.send.gain.setValueAtTime(1, t);
    const wait = d.beatLen / d.rate * (1 - d.beatPhase());
    setTimeout(() => { d.pause(); d.send.gain.setTargetAtTime(0, d.ctx.currentTime, 0.02); setTimeout(() => d.sendRevG.gain.setTargetAtTime(0, d.ctx.currentTime, 1), 200); }, wait * 1000);
  }

  buildXyTargets() {
    const sel = document.getElementById('xyTarget'); const prev = sel.value;
    sel.innerHTML = '';
    this.fxUI.forEach((slots, i) => slots.forEach((s, si) => {
      const f = FX_LIST.find(x => x.id === s.sel.value);
      sel.appendChild(new Option(`${'AB'[i]} · ${f ? f.name : 'FX ' + (si + 1) + ' (empty)'}`, i + ':' + si));
    }));
    if (prev) sel.value = prev;
  }

  setupXy() {
    const pad = document.getElementById('xyPad'), dot = pad.querySelector('.xy-dot');
    let id = null, target = null, wasOn = false;
    const apply = (e) => {
      const r = pad.getBoundingClientRect();
      const x = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)), y = Math.max(0, Math.min(1, 1 - (e.clientY - r.top) / r.height));
      dot.style.left = (x * 100) + '%'; dot.style.top = ((1 - y) * 100) + '%';
      target.prm.set(x); target.amt.set(y);
    };
    pad.addEventListener('pointerdown', (e) => {
      const [i, si] = document.getElementById('xyTarget').value.split(':').map(Number);
      target = this.fxUI[i][si]; if (!target.slot.fx) { toast('Pick an effect for that slot first'); return; }
      id = e.pointerId; pad.setPointerCapture(id); pad.classList.add('active');
      wasOn = target.slot.on; target.slot.setOn(true); target.on.classList.add('on');
      apply(e);
    });
    pad.addEventListener('pointermove', (e) => { if (e.pointerId === id) apply(e); });
    const end = (e) => { if (e.pointerId !== id) return; id = null; pad.classList.remove('active'); target.slot.setOn(wasOn); target.on.classList.toggle('on', wasOn); };
    pad.addEventListener('pointerup', end); pad.addEventListener('pointercancel', end);
  }

  /* ---------------- pads ---------------- */
  buildPads() {
    this.padUI = [];
    document.querySelectorAll('.pads-col').forEach((col) => {
      const i = +col.dataset.deck;
      const modes = [{ label: 'CUES', v: 'cues' }, { label: 'LOOP', v: 'loop' }, { label: 'ROLL', v: 'roll' }, { label: 'JUMP', v: 'jump' }, { label: 'KEY', v: 'key' }];
      seg(col, modes, 'cues', (v) => { this.padMode[i] = v; this.renderPads(i); });
      const grid = h('div', 'pad-grid'); col.appendChild(grid);
      const sub = h('div', 'pad-sub'); col.appendChild(sub);
      this.padUI[i] = { grid, sub };
      this.renderPads(i);
    });
    const s = document.getElementById('sampler');
    const head = h('div', 'sampler-head', '<span>SAMPLER</span>'); s.appendChild(head);
    new Knob(head, { value: 0.7, def: 0.7, onChange: (v) => this.E.sampler.setVolume(v) });
    const grid = h('div', 'pad-grid'); s.appendChild(grid);
    SAMPLE_NAMES.forEach((n, k) => { const p = h('button', 'pad', n); p.addEventListener('pointerdown', () => { this.E.sampler.trigger(k); p.classList.add('on'); setTimeout(() => p.classList.remove('on'), 150); }); grid.appendChild(p); });
  }

  renderPads(i) {
    const d = this.E.decks[i], { grid, sub } = this.padUI[i], mode = this.padMode[i];
    grid.innerHTML = ''; sub.innerHTML = '';
    const pad = (label, small, opts = {}) => {
      const p = h('button', 'pad' + (opts.set ? ' set' : '') + (opts.on ? ' on' : ''), `${label}${small ? `<small>${small}</small>` : ''}`);
      if (opts.color) p.style.background = opts.color;
      if (opts.down) p.addEventListener('pointerdown', opts.down);
      if (opts.up) { p.addEventListener('pointerup', opts.up); p.addEventListener('pointercancel', opts.up); p.addEventListener('pointerleave', opts.up); }
      grid.appendChild(p); return p;
    };
    const subBtn = (label, fn, on) => { const b = h('button', on ? 'on' : '', label); b.addEventListener('click', fn); sub.appendChild(b); return b; };
    if (mode === 'cues') {
      for (let k = 0; k < 8; k++) {
        const c = d.hotcues[k];
        pad(String(k + 1), c != null ? fmt(c) : 'set', { set: c != null, color: c != null ? CUE_COLORS[k] : null, down: () => { d.hotcue(k, this.cueDelete[i]); if (this.cueDelete[i]) { this.cueDelete[i] = false; } this.renderPads(i); } });
      }
      subBtn(this.cueDelete[i] ? 'TAP A CUE TO DELETE' : 'DELETE CUE', () => { this.cueDelete[i] = !this.cueDelete[i]; this.renderPads(i); }, this.cueDelete[i]);
    } else if (mode === 'loop') {
      [0.25, 0.5, 1, 2, 4, 8, 16, 32].forEach(b => pad(b < 1 ? '1/' + (1 / b) : String(b), 'beats', { on: d.loop && Math.abs(d.loop.beats - b) < 1e-6, down: () => { d.autoLoop(b); this.renderPads(i); } }));
      subBtn('IN', () => d.loopIn()); subBtn('OUT', () => { d.loopOut(); this.renderPads(i); });
      subBtn('½', () => { d.loopScale(0.5); this.renderPads(i); }); subBtn('×2', () => { d.loopScale(2); this.renderPads(i); });
      subBtn('EXIT', () => { if (d.loop) d.lastLoop = d.loop; d.exitLoop(); this.renderPads(i); }, !!d.loop);
      subBtn('RELOOP', () => { d.reloop(); this.renderPads(i); });
    } else if (mode === 'roll') {
      [1 / 32, 1 / 16, 1 / 8, 1 / 4, 1 / 2, 1, 2, 4].forEach(b => pad(b < 1 ? '1/' + Math.round(1 / b) : String(b), 'roll', { down: () => d.roll(b, true), up: () => d.roll(b, false) }));
      sub.appendChild(h('div', 'muted small', 'Hold a pad — the track keeps running underneath (slip).'));
    } else if (mode === 'jump') {
      [-16, -8, -4, -1, 1, 4, 8, 16].forEach(b => pad((b > 0 ? '+' : '') + b, 'beats', { down: () => d.beatJump(b) }));
    } else if (mode === 'key') {
      [-3, -2, -1, 0, 1, 2, 3].forEach(k => pad(k === 0 ? 'RESET' : (k > 0 ? '+' : '') + k, 'semitone', { on: d.keyShift === k, down: () => { d.setKeyShift(k); this.renderPads(i); } }));
      pad('MATCH', 'key sync', { down: () => { this.keyMatch(d); this.renderPads(i); } });
    }
  }

  keyMatch(d) {
    const o = this.E.decks[1 - d.index];
    const a = camelotParse(d.an_ && d.an_.camelot), b = camelotParse(o.an_ && o.an_.camelot);
    if (!a || !b) return toast('Both decks need a detected key');
    // semitone shift moves 7 steps on the camelot wheel per semitone
    let best = 0, bestD = 99;
    for (let s = -6; s <= 6; s++) {
      const n = (((a.n - 1 + 7 * s) % 12) + 12) % 12 + 1;
      const dist = n === b.n ? 0 : Math.min((n - b.n + 12) % 12, (b.n - n + 12) % 12);
      const score = dist * 10 + Math.abs(s) + (a.l !== b.l ? 0 : 0);
      if (dist <= 1 && score < bestD) { bestD = score; best = s; }
    }
    d.setKeyShift(best); toast(`Deck ${d.name} key shifted ${best >= 0 ? '+' : ''}${best} st`);
  }

  /* ---------------- library ---------------- */
  buildLibrary() {
    document.querySelectorAll('#libSrc button').forEach((b) => b.addEventListener('click', () => {
      document.querySelectorAll('#libSrc button').forEach(x => x.classList.toggle('active', x === b));
      this.libSrc = b.dataset.src; this.libFilter = ''; this.renderLib();
    }));
    const fi = document.getElementById('fileInput');
    fi.addEventListener('change', () => { const added = this.L.addFiles(fi.files); toast(`Added ${added.length} track${added.length === 1 ? '' : 's'} — analysing BPM & key…`); fi.value = ''; this.renderLib(); });
  }

  renderLibSoon() { if (this.libT) return; this.libT = setTimeout(() => { this.libT = null; if (this.page === 'library') this.renderLib(); if (this.page === 'automix') this.renderQueue(); }, 120); }

  renderLib() {
    const bar = document.getElementById('libBar'), list = document.getElementById('libList');
    bar.innerHTML = '';
    const search = (ph, onEnter, live) => {
      const inp = h('input'); inp.type = 'search'; inp.placeholder = ph; inp.value = this.libFilter;
      inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { inp.blur(); onEnter(inp.value); } });
      if (live) inp.addEventListener('input', () => { this.libFilter = inp.value; this.renderList(); });
      bar.appendChild(inp); return inp;
    };
    const btn = (label, fn) => { const b = h('button', '', label); b.addEventListener('click', fn); bar.appendChild(b); return b; };
    if (this.libSrc === 'local') {
      btn('＋ ADD MUSIC', () => document.getElementById('fileInput').click());
      search('Filter…', () => {}, true);
      btn('QUEUE ALL', () => { this.AM.add(this.L.local.slice()); toast('Added to automix queue'); });
    } else if (this.libSrc === 'apple') {
      const inp = search('Search Apple Music…', (v) => this.appleSearch(v));
      btn('SEARCH', () => this.appleSearch(inp.value));
      if (AM.isConnected()) {
        btn('MY LIBRARY', () => this.appleLibrary());
        btn('PLAYLISTS', () => this.applePlaylists());
      } else btn('CONNECT ACCOUNT', () => this.appleConnect());
    } else if (this.libSrc === 'demo') {
      btn('QUEUE ALL DEMOS', () => { this.AM.add(this.L.demo.slice()); toast('Demo tracks queued'); });
      bar.appendChild(h('span', 'muted small', 'Synthesised house loops for testing the mixer & automix'));
    } else if (this.libSrc === 'queue') {
      btn('OPEN AUTOMIX', () => this.showPage('automix'));
    }
    this.renderList();
  }

  libTracks() {
    switch (this.libSrc) {
      case 'local': return this.L.local;
      case 'demo': return this.L.demo;
      case 'apple': return this.appleResults;
      case 'queue': return this.AM.queue;
      case 'history': return this.AM.history.slice().reverse();
    }
    return [];
  }

  renderList() {
    const list = document.getElementById('libList');
    let tracks = this.libTracks();
    const f = this.libFilter.toLowerCase();
    if (f && this.libSrc === 'local') tracks = tracks.filter(t => (t.title + ' ' + t.artist).toLowerCase().includes(f));
    list.innerHTML = '';
    if (this.libSrc === 'apple' && this.appleTitle) list.appendChild(h('div', 'qhead', esc(this.appleTitle)));
    if (this.libSrc === 'apple' && this.applePl) {
      for (const p of this.applePl) {
        const r = h('div', 'trow', `${p.artwork ? `<img src="${esc(p.artwork)}">` : '<div class="noart"></div>'}<div class="meta"><div>${esc(p.name)}</div><div class="ar">Playlist</div></div><div class="acts"><button>OPEN</button><button>QUEUE</button></div>`);
        const [open, q] = r.querySelectorAll('button');
        open.addEventListener('click', () => this.applePlaylist(p, false));
        q.addEventListener('click', () => this.applePlaylist(p, true));
        list.appendChild(r);
      }
      return;
    }
    if (!tracks.length) {
      const msg = {
        local: '<b>No music yet.</b><br>Tap <b>＋ ADD MUSIC</b> to pick songs from your phone (MP3, M4A, WAV, FLAC, OGG).<br>BPM, key and waveform are analysed automatically.',
        apple: this.appleEmptyMsg(),
        demo: '', queue: 'The automix queue is empty. Use <b>+</b> on any track or <b>QUEUE ALL</b>.', history: 'Nothing played yet.',
      }[this.libSrc];
      list.innerHTML = `<div class="empty">${msg}</div>`;
      return;
    }
    const frag = document.createDocumentFragment();
    tracks.forEach((t, idx) => frag.appendChild(this.trackRow(t, idx)));
    list.appendChild(frag);
  }

  appleEmptyMsg() {
    return `<b>Apple Music</b><br>Search the Apple Music catalog above — every result can be loaded on a deck as a 30-second preview with full FX, sync and automix.<br>` +
      `To browse <b>your own library & playlists</b>, tap <b>CONNECT ACCOUNT</b> (needs an Apple Music developer token in ⚙ Settings).<br>` +
      `<span class="muted">Full-length Apple Music streams are DRM-protected, so Apple only allows mixing of previews in third-party apps. For full tracks, add your own audio files under My Files.</span>`;
  }

  trackRow(t, idx) {
    const loadedOn = this.E.decks.findIndex(d => d.track === t);
    const r = h('div', 'trow' + (loadedOn >= 0 ? ' loaded-' + loadedOn : ''));
    const keyCol = t.camelot ? camelotColor(t.camelot) : '#333';
    const status = t.loading ? '<span class="spin"></span>' : (t.bpm ? t.bpm.toFixed(1) : (t.error ? '⚠' : '—'));
    r.innerHTML = `${t.artwork ? `<img loading="lazy" src="${esc(t.artwork)}">` : '<div class="noart"></div>'}
      <div class="meta"><div>${esc(t.title)}${t.preview ? '<span class="badge">PREVIEW</span>' : ''}</div><div class="ar">${esc(t.artist || '')}</div></div>
      <div class="bpm">${status}</div><div class="key" style="background:${keyCol}">${esc(t.camelot || '')}</div>
      <div class="dur">${t.duration ? fmt(t.duration) : ''}</div><div class="acts"></div>`;
    const acts = r.querySelector('.acts');
    const b = (label, cls, fn) => { const x = h('button', cls, label); x.addEventListener('click', (e) => { e.stopPropagation(); fn(); }); acts.appendChild(x); };
    if (this.libSrc === 'queue') {
      b('▲', '', () => { this.AM.move(idx, -1); this.renderList(); });
      b('▼', '', () => { this.AM.move(idx, 1); this.renderList(); });
      b('✕', '', () => { this.AM.remove(idx); this.renderList(); });
    }
    b('A', 'la', () => this.loadTo(t, 0));
    b('B', 'lb', () => this.loadTo(t, 1));
    if (this.libSrc !== 'queue') b('+', '', () => { this.AM.add([t]); toast('Queued: ' + t.title); });
    return r;
  }

  async loadTo(t, i) {
    const d = this.E.decks[i];
    if (d.playing) {
      const k = t.id + ':' + i;
      if (this.loadConfirm[k] && performance.now() - this.loadConfirm[k] < 2500) { delete this.loadConfirm[k]; }
      else { this.loadConfirm[k] = performance.now(); return toast(`Deck ${d.name} is playing — tap again to replace`); }
    }
    toast(`Loading on deck ${d.name}…`, 1200);
    try {
      await this.L.loadToDeck(t, d);
      d.uiEq = { low: 0.5, mid: 0.5, high: 0.5, filter: 0.5 };
      if (this.loadTarget != null) { this.loadTarget = null; this.showPage('mixer'); }
      this.renderList();
    } catch (e) {
      console.error(e);
      toast('Could not load: ' + (e.message || e), 3500);
    }
  }

  async appleSearch(term) {
    term = (term || '').trim(); if (!term) return;
    this.libFilter = term; this.applePl = null;
    const list = document.getElementById('libList'); list.innerHTML = '<div class="empty"><span class="spin"></span> Searching…</div>';
    try {
      this.appleResults = AM.isConnected() ? await AM.catalogSearch(term) : await AM.searchCatalogPreviews(term);
      this.appleTitle = `Results for “${term}”`;
    } catch (e) { this.appleResults = []; this.appleTitle = 'Search failed — check your internet connection'; }
    this.renderList();
  }
  async appleConnect() {
    if (!settings.appleToken) { this.openSettings(); toast('Paste your Apple Music developer token first'); return; }
    try { toast('Opening Apple sign-in…'); await AM.connect(); toast('Apple Music connected'); this.renderLib(); this.appleLibrary(); }
    catch (e) { toast('Apple Music: ' + (e.message || e), 4000); }
  }
  async appleLibrary() {
    this.applePl = null; const list = document.getElementById('libList'); list.innerHTML = '<div class="empty"><span class="spin"></span> Loading your library…</div>';
    try { const r = await AM.librarySongs(0); this.appleResults = r.tracks; this.appleTitle = 'My Library (previews)'; }
    catch (e) { this.appleResults = []; this.appleTitle = 'Could not load library: ' + (e.message || e); }
    this.renderList();
  }
  async applePlaylists() {
    const list = document.getElementById('libList'); list.innerHTML = '<div class="empty"><span class="spin"></span> Loading playlists…</div>';
    try { this.applePl = await AM.playlists(); this.appleTitle = 'My Playlists'; }
    catch (e) { this.applePl = null; this.appleTitle = 'Could not load playlists'; }
    this.renderList();
  }
  async applePlaylist(p, queue) {
    const tracks = await AM.playlistTracks(p.id);
    if (queue) { this.AM.add(tracks); toast(`Queued ${tracks.length} previews from ${p.name}`); }
    else { this.applePl = null; this.appleResults = tracks; this.appleTitle = p.name; this.renderList(); }
  }

  /* ---------------- automix page ---------------- */
  buildAutomix() {
    const sel = document.getElementById('amTrans');
    TRANSITIONS.forEach(t => sel.appendChild(new Option(t.name, t.id)));
    sel.value = settings.amTransition;
    sel.addEventListener('change', () => { settings.amTransition = sel.value; saveSettings(); });
    seg(document.getElementById('amBeats'), [4, 8, 16, 32, 64].map(v => ({ label: String(v), v })), settings.amBeats, (v) => { settings.amBeats = v; saveSettings(); });
    const tg = document.getElementById('amToggles');
    const t = (label, key, after) => toggle(tg, label, settings[key], (v) => { settings[key] = v; saveSettings(); after && after(v); });
    t('Tempo sync', 'amSync'); t('Harmonic order', 'amHarmonic', (v) => { if (v) this.AM.harmonicSort(); });
    t('Skip silence', 'amSkipSilence'); t('Shuffle', 'amShuffle', (v) => { if (v) this.AM.shuffle(); });
    document.getElementById('amPower').addEventListener('click', () => this.toggleAutomix());
    document.getElementById('amMixNow').addEventListener('click', () => { if (!this.AM.enabled) return toast('Start automix first'); this.AM.mixNow(); });
    document.getElementById('amSkip').addEventListener('click', () => this.AM.skip());
    document.getElementById('amShuffleNow').addEventListener('click', () => this.AM.shuffle());
    document.getElementById('amSortNow').addEventListener('click', () => { this.AM.harmonicSort(); toast('Sorted by key & tempo'); });
    document.getElementById('amAddAll').addEventListener('click', () => { const s = this.L.local.length ? this.L.local : this.L.demo; this.AM.add(s.slice()); });
    document.getElementById('amClear').addEventListener('click', () => this.AM.clear());
  }

  onAutomix(ev) {
    if (ev === 'queue') { this.renderQueue(); if (this.page === 'library' && (this.libSrc === 'queue' || this.libSrc === 'history')) this.renderList(); }
    const on = this.AM.enabled;
    const pill = document.getElementById('amToggle'); pill.classList.toggle('on', on); pill.querySelector('b').textContent = on ? 'ON' : 'OFF';
    const pw = document.getElementById('amPower'); pw.textContent = on ? 'STOP AUTOMIX' : 'START AUTOMIX'; pw.classList.toggle('accent', !on);
  }

  renderQueue() {
    const q = document.getElementById('amQueue'); if (!q) return;
    q.innerHTML = '';
    q.appendChild(h('div', 'qhead', `QUEUE · ${this.AM.queue.length} TRACKS`));
    if (!this.AM.queue.length) { q.appendChild(h('div', 'empty', 'Queue is empty.<br>Add tracks from the Library (<b>+</b>) or tap <b>Queue all files</b>.')); return; }
    const prevSrc = this.libSrc; this.libSrc = 'queue';
    this.AM.queue.forEach((t, i) => q.appendChild(this.trackRow(t, i)));
    this.libSrc = prevSrc;
  }

  /* ---------------- settings ---------------- */
  openSettings() {
    const body = document.getElementById('modalBody');
    document.getElementById('modalTitle').textContent = 'Settings';
    body.innerHTML = '';
    const row = (label, el) => { const r = h('div', 'set-row'); r.appendChild(h('span', '', label)); r.appendChild(el); body.appendChild(r); return r; };
    const selectEl = (opts, val, fn) => { const s = h('select'); opts.forEach(([v, l]) => s.appendChild(new Option(l, v))); s.value = String(val); s.addEventListener('change', () => fn(s.value)); return s; };
    const tgl = (key, after) => { const w = h('div'); toggle(w, '', settings[key], (v) => { settings[key] = v; saveSettings(); after && after(v); }); return w.firstChild; };

    body.appendChild(h('h4', '', 'DECKS'));
    row('Pitch fader range', selectEl([[4, '±4%'], [8, '±8%'], [16, '±16%'], [50, '±50%']], settings.pitchRange, (v) => { settings.pitchRange = +v; saveSettings(); this.E.decks.forEach(d => this.syncPitchFader(d)); }));
    row('Key lock (master tempo)', tgl('keylock', () => { this.E.decks.forEach(d => d.applyRate()); this.deckUI.forEach(u => u.keylock.classList.toggle('on', settings.keylock)); }));
    row('Quantize cues & loops to beat', tgl('quantize'));
    row('Vinyl mode (jog scratches)', tgl('vinyl', () => this.deckUI.forEach(u => u.vinyl.classList.toggle('on', settings.vinyl))));
    row('Slip mode', tgl('slip', (v) => { this.E.decks.forEach(d => d.setSlip(v)); this.deckUI.forEach(u => u.slip.classList.toggle('on', v)); }));
    body.appendChild(h('h4', '', 'MIXER'));
    row('Crossfader curve', selectEl([['smooth', 'Smooth (mix)'], ['linear', 'Linear'], ['sharp', 'Sharp (scratch)']], settings.xfCurve, (v) => { settings.xfCurve = v; saveSettings(); this.E.setCrossfader(this.E.xfader); }));
    row('Filter resonance', selectEl([[0.7, 'Low'], [1.2, 'Medium'], [3, 'High'], [6, 'Screaming']], settings.filterRes, (v) => { settings.filterRes = +v; saveSettings(); }));
    row('Master limiter', tgl('limiter', () => this.E.applyLimiter()));
    row('Split cue (L = master, R = headphones)', tgl('splitCue', () => this.E.applyRouting()));
    body.appendChild(h('h4', '', 'APPLE MUSIC'));
    const ta = h('textarea'); ta.placeholder = 'Paste your MusicKit developer token (JWT)…'; ta.value = settings.appleToken || '';
    ta.addEventListener('change', () => { settings.appleToken = ta.value.trim(); saveSettings(); });
    body.appendChild(ta);
    const sf = h('input'); sf.type = 'text'; sf.value = settings.storefront; sf.style.width = '70px';
    sf.addEventListener('change', () => { settings.storefront = sf.value.trim().toLowerCase() || 'us'; saveSettings(); });
    row('Storefront (country code)', sf);
    const conn = h('button', 'btn', AM.isConnected() ? 'Disconnect Apple Music' : 'Connect Apple Music');
    conn.addEventListener('click', async () => { if (AM.isConnected()) { await AM.disconnect(); toast('Disconnected'); this.closeModal(); } else { settings.appleToken = ta.value.trim(); saveSettings(); this.closeModal(); this.showPage('library'); document.querySelector('#libSrc [data-src=apple]').click(); this.appleConnect(); } });
    body.appendChild(conn);
    body.appendChild(h('div', 'note', `<b>How Apple Music works here:</b> catalog search works without an account. Connecting your account (MusicKit) needs a developer token from an Apple Developer membership. ` +
      `Apple Music full-length songs are FairPlay DRM-protected — Apple does not let third-party apps route them through their own audio engine, so <b>no app outside Apple's partner program can beat-match, EQ or add FX to full Apple Music streams</b>. ` +
      `DJ Free therefore mixes the 30-second previews of your Apple Music songs. For full songs, add audio files you own (My Files).`));
    body.appendChild(h('h4', '', 'ABOUT'));
    body.appendChild(h('div', 'muted small', 'DJ Free 1.0 · 2 decks · automix with 9 transition styles · 22 FX + 8 performance FX · hot cues, loops, rolls, beat jump, key shift · BPM/key detection · sampler · split cue · mix recording.'));
    document.getElementById('modal').classList.remove('hidden');
  }
  closeModal() { document.getElementById('modal').classList.add('hidden'); }
  syncPitchFader(d) { const ui = this.deckUI[d.index]; ui.pitchFader.set(Math.max(0, Math.min(1, 0.5 + d.pitch / (2 * settings.pitchRange))), true); }

  /* ---------------- deck events ---------------- */
  onDeck(ev, d) {
    const ui = this.deckUI[d.index];
    if (ev === 'state') { ui.play.classList.toggle('on', d.playing); ui.play.textContent = d.playing ? '❚❚' : '▶︎'; }
    if (ev === 'pitch' || ev === 'sync' || ev === 'load') { this.syncPitchFader(d); d.updateFxTempo(); }
    if (ev === 'load') {
      const w = this.waves[d.index];
      w.info.title.textContent = d.track ? (d.track.title + (d.track.artist ? ' — ' + d.track.artist : '')) : 'Load a track';
      const c = d.an_ && d.an_.camelot; w.info.key.textContent = c || '-'; w.info.key.style.background = c ? camelotColor(c) : '#555';
      this.renderOverview(d);
      this.renderPads(d.index);
      this.syncDeckKnobs(d);
      if (this.page === 'library') this.renderList();
    }
    if (ev === 'cues' || ev === 'loop') this.renderPads(d.index);
    if (ev === 'sync') ui.sync.classList.add('on'), setTimeout(() => ui.sync.classList.remove('on'), 400);
  }

  /* ---------------- waveforms ---------------- */
  setupWaves() {
    this.waves = [];
    document.querySelectorAll('#waves .wave').forEach((w) => {
      const i = +w.dataset.deck;
      const canvas = w.querySelector('canvas');
      const ov = document.querySelector(`.overview[data-deck="${i}"]`);
      this.waves[i] = { canvas, ctx: canvas.getContext('2d'), ov, ovCtx: ov.getContext('2d'), ovImg: null,
        info: { title: w.querySelector('.t-title'), bpm: w.querySelector('.t-bpm'), key: w.querySelector('.t-key'), time: w.querySelector('.t-time') } };
      const d = this.E.decks[i];
      this.jog(canvas, d, 'wave');
      let lastTap = 0;
      canvas.addEventListener('pointerdown', () => { const n = performance.now(); if (n - lastTap < 280) { this.zoom[i] = this.zoom[i] >= 2 ? 0.5 : this.zoom[i] * 2; } lastTap = n; });
      const seekOv = (e) => { if (!d.track) return; const r = ov.getBoundingClientRect(); d.seek((e.clientX - r.left) / r.width * d.duration); };
      ov.addEventListener('pointerdown', (e) => { ov.setPointerCapture(e.pointerId); seekOv(e); });
      ov.addEventListener('pointermove', (e) => { if (e.buttons) seekOv(e); });
    });
  }

  pxPerSec(i) { return 110 * this.zoom[i]; }

  resizeCanvases() {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const fit = (c) => { const r = c.getBoundingClientRect(); if (!r.width) return; c.width = Math.round(r.width * dpr); c.height = Math.round(r.height * dpr); };
    if (this.waves) this.waves.forEach((w, i) => { fit(w.canvas); fit(w.ov); this.renderOverview(this.E.decks[i]); });
    if (this.deckUI) this.deckUI.forEach(u => fit(u.platter));
    this.dpr = dpr;
  }

  renderOverview(d) {
    const w = this.waves[d.index]; const W = w.ov.width, H = w.ov.height;
    if (!W) return;
    const off = document.createElement('canvas'); off.width = W; off.height = H;
    const c = off.getContext('2d');
    if (d.an_) {
      const pk = d.an_.peaks, n = pk.low.length;
      for (let x = 0; x < W; x++) {
        const a = Math.floor(x / W * n), b = Math.max(a + 1, Math.floor((x + 1) / W * n));
        let lo = 0, mi = 0, hi = 0; for (let k = a; k < b; k++) { lo = Math.max(lo, pk.low[k]); mi = Math.max(mi, pk.mid[k]); hi = Math.max(hi, pk.high[k]); }
        const v = Math.max(lo, mi, hi);
        c.fillStyle = lo > mi ? '#2c6bff' : (mi > hi ? '#ff9f1c' : '#e8ecf5');
        c.fillRect(x, H * (1 - v) / 2, 1, Math.max(1, H * v));
      }
    }
    w.ovImg = off;
  }

  drawWave(d) {
    const w = this.waves[d.index], c = w.ctx, W = w.canvas.width, H = w.canvas.height;
    c.fillStyle = '#07080b'; c.fillRect(0, 0, W, H);
    if (!d.an_) { c.fillStyle = '#1a1e29'; c.fillRect(0, H / 2, W, 1); return; }
    const dpr = this.dpr || 1;
    const pos = d.position(), pps = this.pxPerSec(d.index) * dpr;
    const pk = d.an_.peaks, rate = pk.rate, n = pk.low.length;
    const mid = H / 2, cx = W / 2;
    // loop region
    if (d.loop) { const x1 = cx + (d.loop.a - pos) * pps, x2 = cx + (d.loop.b - pos) * pps; c.fillStyle = 'rgba(61,220,132,.18)'; c.fillRect(x1, 0, x2 - x1, H); }
    const step = Math.max(1, Math.round(dpr));
    const bands = [[pk.low, '#2c6bff', 1], [pk.mid, '#ff9f1c', 0.85], [pk.high, '#e8ecf5', 0.6]];
    for (const [arr, color, scale] of bands) {
      c.fillStyle = color; c.beginPath();
      for (let x = 0; x < W; x += step) {
        const t = pos + (x - cx) / pps;
        const i0 = Math.floor(t * rate), i1 = Math.max(i0 + 1, Math.floor((t + step / pps) * rate));
        if (i1 <= 0 || i0 >= n) continue;
        let v = 0; for (let k = Math.max(0, i0); k < Math.min(n, i1); k++) if (arr[k] > v) v = arr[k];
        const hh = v * scale * (H / 2 - 2);
        c.rect(x, mid - hh, step, hh * 2);
      }
      c.fill();
    }
    // played part dim
    c.fillStyle = 'rgba(7,8,11,.45)'; c.fillRect(0, 0, cx, H);
    // beat grid
    const bl = d.beatLen, fb = d.an_.firstBeat;
    const tStart = pos - cx / pps, tEnd = pos + cx / pps;
    let k = Math.ceil((tStart - fb) / bl);
    for (let t = fb + k * bl; t < tEnd; t += bl, k++) {
      const x = cx + (t - pos) * pps; const bar = ((k % 4) + 4) % 4 === 0;
      c.fillStyle = bar ? 'rgba(255,255,255,.55)' : 'rgba(255,255,255,.16)';
      c.fillRect(x, 0, bar ? 2 : 1, bar ? H : H * 0.18); if (!bar) c.fillRect(x, H * 0.82, 1, H * 0.18);
    }
    // hot cues + cue point
    d.hotcues.forEach((t, i) => { if (t == null) return; const x = cx + (t - pos) * pps; if (x < -10 || x > W + 10) return; c.fillStyle = CUE_COLORS[i]; c.fillRect(x, 0, 2, H); c.beginPath(); c.moveTo(x, 0); c.lineTo(x + 9, 0); c.lineTo(x, 9); c.fill(); });
    if (d.cuePoint != null) { const x = cx + (d.cuePoint - pos) * pps; c.fillStyle = '#ffb020'; c.beginPath(); c.moveTo(x - 6, H); c.lineTo(x + 6, H); c.lineTo(x, H - 8); c.fill(); }
    // slip ghost
    if (d.slipPos >= 0) { const x = cx + (d.slipPos - pos) * pps; c.fillStyle = 'rgba(255,45,122,.8)'; c.fillRect(x, 0, 1, H); }
    // playhead
    c.fillStyle = COLORS[d.index]; c.fillRect(cx - 1, 0, 2, H);
  }

  drawOverview(d) {
    const w = this.waves[d.index], c = w.ovCtx, W = w.ov.width, H = w.ov.height;
    c.clearRect(0, 0, W, H);
    if (w.ovImg) c.drawImage(w.ovImg, 0, 0);
    if (!d.track || !d.duration) return;
    const x = d.position() / d.duration * W;
    c.fillStyle = 'rgba(7,8,11,.55)'; c.fillRect(0, 0, x, H);
    if (d.an_ && this.AM.enabled) { c.fillStyle = '#3ddc84'; c.fillRect(d.an_.mixIn / d.duration * W, 0, 2, H); c.fillStyle = '#ff3b3b'; c.fillRect(d.an_.mixOut / d.duration * W, 0, 2, H); }
    c.fillStyle = COLORS[d.index]; c.fillRect(x - 1, 0, 2, H);
  }

  drawPlatter(d) {
    const cv = this.deckUI[d.index].platter, c = cv.getContext('2d'), W = cv.width, H = cv.height;
    if (!W) return;
    const r = Math.min(W, H) / 2 - 2, cx = W / 2, cy = H / 2;
    c.clearRect(0, 0, W, H);
    c.fillStyle = '#10131a'; c.beginPath(); c.arc(cx, cy, r, 0, Math.PI * 2); c.fill();
    for (let g = 0.45; g < 0.95; g += 0.07) { c.strokeStyle = 'rgba(255,255,255,.04)'; c.lineWidth = 1; c.beginPath(); c.arc(cx, cy, r * g, 0, Math.PI * 2); c.stroke(); }
    // progress ring
    const prog = d.duration ? d.position() / d.duration : 0;
    c.lineWidth = Math.max(3, r * 0.07); c.strokeStyle = '#1f2433'; c.beginPath(); c.arc(cx, cy, r - c.lineWidth / 2, 0, Math.PI * 2); c.stroke();
    const remain = d.duration - d.position();
    c.strokeStyle = remain < 30 && d.playing && Math.floor(performance.now() / 400) % 2 ? '#ff3b3b' : COLORS[d.index];
    c.beginPath(); c.arc(cx, cy, r - c.lineWidth / 2, -Math.PI / 2, -Math.PI / 2 + prog * Math.PI * 2); c.stroke();
    // rotating marker (33 rpm)
    const ang = d.position() / 1.8 * Math.PI * 2;
    c.save(); c.translate(cx, cy); c.rotate(ang);
    c.fillStyle = '#e8ecf5'; c.fillRect(-1.5, -r * 0.88, 3, r * 0.3);
    c.restore();
    // label
    c.fillStyle = '#181c27'; c.beginPath(); c.arc(cx, cy, r * 0.38, 0, Math.PI * 2); c.fill();
    c.fillStyle = '#e7ebf3'; c.textAlign = 'center'; c.textBaseline = 'middle';
    c.font = `800 ${Math.round(r * 0.22)}px system-ui`; c.fillText(d.track ? d.liveBpm.toFixed(1) : '—', cx, cy - r * 0.06);
    c.fillStyle = '#7d8597'; c.font = `700 ${Math.round(r * 0.12)}px system-ui`; c.fillText('BPM', cx, cy + r * 0.16);
  }

  frame() {
    const E = this.E;
    for (const d of E.decks) {
      if (this.waves[d.index].canvas.width) { this.drawWave(d); this.drawOverview(d); }
      if (this.page === 'mixer' || !this.page) this.drawPlatter(d);
      const w = this.waves[d.index].info;
      if (d.track) {
        w.bpm.textContent = d.liveBpm.toFixed(1) + ' BPM';
        w.time.textContent = '-' + fmt((d.duration - d.position()) / (d.rate || 1));
        this.deckUI[d.index].pitchVal.textContent = (d.pitch >= 0 ? '+' : '') + d.pitch.toFixed(1) + '%' + (d.keyShift ? ` ${d.keyShift > 0 ? '+' : ''}${d.keyShift}st` : '');
      }
      // VU
      const an = d.an, buf = this.vuBuf || (this.vuBuf = new Float32Array(512));
      an.getFloatTimeDomainData(buf); let pk = 0; for (let i = 0; i < buf.length; i += 2) pk = Math.max(pk, Math.abs(buf[i]));
      d.vu = Math.max(pk, (d.vu || 0) * 0.9);
      this.mixUI[d.index].vuBar.style.height = Math.min(100, d.vu * 100) + '%';
    }
    // master meter
    const mm = document.getElementById('masterMeter'), mc = mm.getContext('2d');
    const buf = this.mBuf || (this.mBuf = new Float32Array(1024)); E.masterAn.getFloatTimeDomainData(buf);
    let pk = 0; for (let i = 0; i < buf.length; i += 2) pk = Math.max(pk, Math.abs(buf[i]));
    this.mPk = Math.max(pk, (this.mPk || 0) * 0.92);
    mc.clearRect(0, 0, 12, 28); const hgt = Math.min(28, this.mPk * 28);
    mc.fillStyle = this.mPk > 0.95 ? '#ff3b3b' : this.mPk > 0.7 ? '#ffb020' : '#3ddc84'; mc.fillRect(2, 28 - hgt, 8, hgt);
    // automix status
    const st = document.getElementById('amStatus'); st.textContent = this.AM.enabled ? this.AM.status : '';
    if (this.page === 'automix') {
      const act = this.AM.active;
      document.getElementById('amNow').textContent = act && act.track ? `${act.name} · ${act.track.title}` : '—';
      const nx = this.AM.queue[0]; document.getElementById('amNext').textContent = nx ? nx.title + (nx.bpm ? ` · ${nx.bpm.toFixed(0)} BPM ${nx.camelot || ''}` : '') : '—';
      const p = this.AM.trans ? this.AM.progress : (act && act.track ? act.position() / act.duration : 0);
      document.getElementById('amProg').style.width = (p * 100) + '%';
    }
    if (E.rec) { const s = (Date.now() - E.recStart) / 1000; document.getElementById('recTime').textContent = fmt(s); }
    requestAnimationFrame(() => this.frame());
  }
}
