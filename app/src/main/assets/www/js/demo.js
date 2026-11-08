/* Procedurally generated demo tracks (direct sample synthesis — fast even on phones)
 * so the app is usable and testable before any music is added. */

const DEMOS = [
  { title: 'Neon Drive', artist: 'DJ Free Demo', bpm: 124, root: 57, minor: true, seed: 1 },   // A minor  (8A)
  { title: 'Midnight Pulse', artist: 'DJ Free Demo', bpm: 126, root: 60, minor: false, seed: 2 }, // C major (8B)
  { title: 'Sunset Tool', artist: 'DJ Free Demo', bpm: 128, root: 52, minor: true, seed: 3 },  // E minor  (9A)
  { title: 'Deep Current', artist: 'DJ Free Demo', bpm: 122, root: 62, minor: true, seed: 4 }, // D minor  (7A)
];

export function demoTracks() {
  return DEMOS.map((d, i) => ({ id: 'demo-' + i, source: 'demo', title: d.title, artist: d.artist, demo: d }));
}

const midiHz = (m) => 440 * Math.pow(2, (m - 69) / 12);

export async function renderDemo(d, sr = 44100) {
  const beat = 60 / d.bpm, bar = beat * 4, bars = 48, lead = 0.5;
  const len = Math.ceil((lead + bars * bar + 2) * sr);
  const L = new Float32Array(len), R = new Float32Array(len);
  let seed = d.seed * 7919;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff * 2 - 1; };

  const kick = (t) => {
    const s0 = Math.floor(t * sr), n = Math.floor(0.38 * sr); let ph = 0;
    for (let i = 0; i < n && s0 + i < len; i++) {
      const tt = i / sr, f = 45 + 95 * Math.exp(-tt * 28);
      ph += 2 * Math.PI * f / sr;
      const v = Math.sin(ph) * Math.exp(-tt * 9) * 0.9;
      L[s0 + i] += v; R[s0 + i] += v;
    }
  };
  const hat = (t, open, vol) => {
    const s0 = Math.floor(t * sr), n = Math.floor((open ? 0.2 : 0.05) * sr); let prev = 0;
    for (let i = 0; i < n && s0 + i < len; i++) {
      const x = rnd(), hp = x - prev; prev = x;
      const v = hp * vol * Math.exp(-i / sr * (open ? 18 : 70));
      L[s0 + i] += v * 0.8; R[s0 + i] += v;
    }
  };
  const clap = (t) => {
    const s0 = Math.floor(t * sr), n = Math.floor(0.2 * sr); let b1 = 0, b2 = 0;
    for (let i = 0; i < n && s0 + i < len; i++) {
      const x = rnd(); b1 += 0.35 * (x - b1); b2 += 0.08 * (b1 - b2);
      const env = Math.exp(-i / sr * 22) * (i < sr * 0.03 ? (Math.floor(i / (sr * 0.01)) % 2 ? 0.4 : 1) : 1);
      const v = (b1 - b2) * env * 0.9;
      L[s0 + i] += v; R[s0 + i] += v;
    }
  };
  const saw = (ph) => 2 * (ph - Math.floor(ph + 0.5));
  const bass = (t, m, dur) => {
    const s0 = Math.floor(t * sr), n = Math.floor(dur * sr), f = midiHz(m); let ph = 0, lp = 0;
    for (let i = 0; i < n && s0 + i < len; i++) {
      ph += f / sr; const tt = i / sr;
      const cut = 0.02 + 0.12 * Math.exp(-tt * 18);
      lp += cut * (saw(ph) - lp);
      const v = lp * 0.55 * Math.min(1, i / 60) * Math.exp(-tt * 4);
      L[s0 + i] += v; R[s0 + i] += v;
    }
  };
  const chord = (t, notes, dur, vol) => {
    const s0 = Math.floor(t * sr), n = Math.floor(dur * sr);
    const fs = []; for (const m of notes) fs.push(midiHz(m) * 0.997, midiHz(m) * 1.003);
    const ph = fs.map(() => Math.random()); let lpL = 0, lpR = 0;
    for (let i = 0; i < n && s0 + i < len; i++) {
      const tt = i / sr; let sL = 0, sR = 0;
      for (let k = 0; k < fs.length; k++) { ph[k] += fs[k] / sr; const s = saw(ph[k]); if (k & 1) sR += s; else sL += s; }
      const cut = 0.03 + 0.25 * Math.exp(-tt * 6);
      lpL += cut * (sL - lpL); lpR += cut * (sR - lpR);
      const env = Math.min(1, i / 200) * Math.exp(-tt * 3.5) * vol;
      L[s0 + i] += lpL * env; R[s0 + i] += lpR * env;
    }
  };

  const scale = d.minor ? [0, 2, 3, 5, 7, 8, 10] : [0, 2, 4, 5, 7, 9, 11];
  const prog = d.minor ? [0, 5, 3, 4] : [0, 4, 5, 3];
  const degree = (deg, oct = 0) => d.root + 12 * oct + scale[((deg % 7) + 7) % 7] + 12 * Math.floor(deg / 7);

  for (let b = 0; b < bars; b++) {
    const t0 = lead + b * bar;
    const intro = b < 8, outro = b >= 40, breakdown = b >= 24 && b < 28;
    const cd = prog[Math.floor(b / 2) % 4];
    for (let q = 0; q < 4; q++) {
      const t = t0 + q * beat;
      if (!breakdown) kick(t);
      hat(t + beat / 2, true, intro ? 0.12 : 0.16);
      if (!intro && !outro) { hat(t + beat / 4, false, 0.07); hat(t + 3 * beat / 4, false, 0.07); }
      if ((q === 1 || q === 3) && b >= 4 && !breakdown) clap(t);
    }
    if (!intro && !outro) {
      for (let q = 0; q < 4; q++) bass(t0 + q * beat + beat / 2, degree(cd, -2), beat * 0.45);
      const notes = [degree(cd), degree(cd + 2), degree(cd + 4)];
      const pattern = d.seed % 2 ? [0, 1.5, 3] : [0.5, 2, 2.5];
      for (const p of pattern) chord(t0 + p * beat, notes, beat * 0.7, breakdown ? 0.07 : 0.05);
    }
    if (breakdown) chord(t0, [degree(cd), degree(cd + 2), degree(cd + 4), degree(cd + 7)], bar * 0.95, 0.05);
    if (b % 4 === 0) await new Promise(r => setTimeout(r, 0)); // keep UI responsive
  }
  // soft clip + normalise
  let mx = 0; for (let i = 0; i < len; i++) { L[i] = Math.tanh(L[i] * 0.8); R[i] = Math.tanh(R[i] * 0.8); mx = Math.max(mx, Math.abs(L[i]), Math.abs(R[i])); }
  const g = 0.89 / (mx || 1); for (let i = 0; i < len; i++) { L[i] *= g; R[i] *= g; }
  const buf = new AudioBuffer({ numberOfChannels: 2, length: len, sampleRate: sr });
  buf.copyToChannel(L, 0); buf.copyToChannel(R, 1);
  return buf;
}
