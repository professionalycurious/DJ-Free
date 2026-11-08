/* Touch widgets: Knob, Fader, Toggle. */

const h = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; };
export { h };

function doubleTap(el, fn) {
  let last = 0;
  el.addEventListener('pointerdown', (e) => { const n = performance.now(); if (n - last < 300) { fn(e); last = 0; } else last = n; });
}

export class Knob {
  constructor(parent, { label = '', value = 0.5, def = 0.5, color = null, onChange = () => {}, onLong = null }) {
    this.def = def; this.onChange = onChange;
    this.el = h('div', 'knob');
    this.body = h('div', 'kbody'); this.body.appendChild(h('div', 'kcap'));
    this.el.appendChild(this.body);
    if (label) this.el.appendChild(h('div', 'klabel', label));
    if (color) this.el.style.setProperty('--kc', color);
    parent.appendChild(this.el);
    this.set(value, true);
    let sy = 0, sx = 0, sv = 0, id = null, longT = null, moved = false;
    this.body.addEventListener('pointerdown', (e) => {
      id = e.pointerId; this.body.setPointerCapture(id); sy = e.clientY; sx = e.clientX; sv = this.value; moved = false;
      if (onLong) longT = setTimeout(() => { if (!moved) onLong(); }, 550);
    });
    this.body.addEventListener('pointermove', (e) => {
      if (e.pointerId !== id) return;
      const d = (sy - e.clientY) / 140 + (e.clientX - sx) / 260;
      if (Math.abs(d) > 0.01) { moved = true; clearTimeout(longT); }
      this.set(Math.max(0, Math.min(1, sv + d)));
    });
    const end = (e) => { if (e.pointerId === id) { id = null; clearTimeout(longT); } };
    this.body.addEventListener('pointerup', end); this.body.addEventListener('pointercancel', end);
    doubleTap(this.body, () => this.set(this.def));
  }
  set(v, silent) {
    this.value = v;
    this.body.style.setProperty('--deg', (v * 270) + 'deg');
    this.body.style.setProperty('--rot', (-135 + v * 270) + 'deg');
    if (!silent) this.onChange(v);
  }
  setKilled(k) { this.el.classList.toggle('killed', k); }
}

export class Fader {
  constructor(parent, { vertical = true, value = 0.5, def = 0.5, onChange = () => {}, center = false, cls = '' }) {
    this.v = vertical; this.def = def; this.onChange = onChange;
    this.el = h('div', 'fader ' + (vertical ? 'v ' : 'h ') + cls);
    if (center) this.el.appendChild(h('div', 'mid'));
    this.thumb = h('div', 'thumb'); this.el.appendChild(this.thumb);
    parent.appendChild(this.el);
    this.set(value, true);
    let id = null, start = 0, sv = 0;
    this.el.addEventListener('pointerdown', (e) => {
      id = e.pointerId; this.el.setPointerCapture(id);
      const r = this.el.getBoundingClientRect();
      const tr = this.thumb.getBoundingClientRect();
      const onThumb = this.v ? (e.clientY >= tr.top - 8 && e.clientY <= tr.bottom + 8) : (e.clientX >= tr.left - 8 && e.clientX <= tr.right + 8);
      if (!onThumb) { // jump to touch position
        const v = this.v ? 1 - (e.clientY - r.top) / r.height : (e.clientX - r.left) / r.width;
        this.set(Math.max(0, Math.min(1, v)));
      }
      start = this.v ? e.clientY : e.clientX; sv = this.value;
    });
    this.el.addEventListener('pointermove', (e) => {
      if (e.pointerId !== id) return;
      const r = this.el.getBoundingClientRect();
      const d = this.v ? (start - e.clientY) / r.height : (e.clientX - start) / r.width;
      this.set(Math.max(0, Math.min(1, sv + d)));
    });
    const end = (e) => { if (e.pointerId === id) id = null; };
    this.el.addEventListener('pointerup', end); this.el.addEventListener('pointercancel', end);
    doubleTap(this.el, () => this.set(this.def));
  }
  set(v, silent) {
    this.value = v;
    if (this.v) { this.thumb.style.top = `calc(${(1 - v) * 100}% - ${(1 - v) * 16}px)`; }
    else { this.thumb.style.left = `calc(${v * 100}% - ${v * 18}px)`; }
    if (!silent) this.onChange(v);
  }
}

export function toggle(parent, label, on, onChange) {
  const el = h('div', 'tg' + (on ? ' on' : ''), `<span>${label}</span><i></i>`);
  el.addEventListener('click', () => { const v = !el.classList.contains('on'); el.classList.toggle('on', v); onChange(v); });
  parent.appendChild(el);
  return el;
}

export function seg(parent, items, active, onPick) {
  const el = h('div', 'seg');
  const btns = items.map((it) => {
    const b = h('button', it.v === active ? 'on' : '', it.label);
    b.addEventListener('click', () => { btns.forEach(x => x.classList.remove('on')); b.classList.add('on'); onPick(it.v); });
    el.appendChild(b); return b;
  });
  parent.appendChild(el);
  el.setActive = (v) => btns.forEach((b, i) => b.classList.toggle('on', items[i].v === v));
  return el;
}

let toastT = null;
export function toast(msg, ms = 2200) {
  const t = document.getElementById('toast');
  t.textContent = msg; t.classList.add('show');
  clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), ms);
}

export function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
