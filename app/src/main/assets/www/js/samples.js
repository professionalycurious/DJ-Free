/* Sampler one-shots, synthesised directly into sample arrays (no Web Audio needed). */
export const SAMPLE_NAMES = ['Air Horn', 'Siren', 'Kick', 'Clap', 'Laser', 'Riser', 'Impact', 'Scratch'];

export function renderSamples(sr = 44100) {
  let seed = 12345;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff * 2 - 1; };
  const mk = (secs) => new Float32Array(Math.ceil(secs * sr));
  const saw = (ph) => 2 * (ph - Math.floor(ph + 0.5));
  const out = [];

  { // air horn: three blasts of detuned saws through a low-pass
    const x = mk(1.6); const fr = [415, 420, 622], ph = [0, 0, 0]; let lp = 0;
    const blasts = [[0, 0.22], [0.25, 0.47], [0.5, 1.05]];
    for (let i = 0; i < x.length; i++) {
      const t = i / sr; let env = 0;
      for (const [a, b] of blasts) if (t >= a && t < b) env = Math.min(1, (t - a) / 0.02, (b - t) / 0.04);
      let s = 0; for (let k = 0; k < 3; k++) { ph[k] += fr[k] / sr; s += saw(ph[k]); }
      lp += 0.35 * (s * env * 0.22 - lp); x[i] = lp;
    }
    out.push(x);
  }
  { // siren
    const x = mk(2.5); let ph = 0, lp = 0;
    for (let i = 0; i < x.length; i++) { const t = i / sr; ph += (900 + 250 * Math.sin(2 * Math.PI * 3 * t)) / sr; const sq = (ph % 1) < 0.5 ? 1 : -1; lp += 0.25 * (sq - lp); x[i] = lp * 0.3 * (1 - t / 2.5); }
    out.push(x);
  }
  { // kick
    const x = mk(0.6); let ph = 0;
    for (let i = 0; i < x.length; i++) { const t = i / sr; ph += (42 + 108 * Math.exp(-t * 25)) / sr; x[i] = Math.sin(2 * Math.PI * ph) * Math.exp(-t * 7) * 0.95; }
    out.push(x);
  }
  { // clap
    const x = mk(0.5); let b1 = 0, b2 = 0;
    for (let i = 0; i < x.length; i++) { const t = i / sr; const n = rnd(); b1 += 0.3 * (n - b1); b2 += 0.06 * (b1 - b2);
      const burst = t < 0.036 ? (Math.floor(t / 0.012) % 1 === 0 ? Math.exp(-(t % 0.012) * 250) : 0) : Math.exp(-(t - 0.036) * 12);
      x[i] = (b1 - b2) * burst * 1.6; }
    out.push(x);
  }
  { // laser
    const x = mk(0.8); let ph = 0;
    for (let i = 0; i < x.length; i++) { const t = i / sr; ph += 2800 * Math.pow(120 / 2800, Math.min(1, t / 0.6)) / sr; x[i] = saw(ph) * 0.3 * Math.exp(-t * 6); }
    out.push(x);
  }
  { // riser
    const x = mk(4); let ph = 0, l1 = 0, l2 = 0;
    for (let i = 0; i < x.length; i++) { const t = i / sr, p = Math.min(1, t / 3.9);
      const fc = 300 * Math.pow(30, p), a = 1 - Math.exp(-2 * Math.PI * fc / sr);
      const n = rnd(); l1 += a * (n - l1); l2 += a * 0.5 * (l1 - l2);
      ph += 110 * Math.pow(8, p) / sr;
      const env = 0.02 + 0.6 * p * p, end = t > 3.9 ? Math.max(0, 1 - (t - 3.9) / 0.1) : 1;
      x[i] = ((l1 - l2) * 1.5 + saw(ph) * 0.08) * env * end; }
    out.push(x);
  }
  { // impact / boom
    const x = mk(3); let ph = 0, lp = 0;
    for (let i = 0; i < x.length; i++) { const t = i / sr; ph += (28 + 62 * Math.exp(-t * 1.2)) / sr;
      const fc = 100 + 5900 * Math.exp(-t * 3), a = 1 - Math.exp(-2 * Math.PI * fc / sr); lp += a * (rnd() - lp);
      x[i] = Math.sin(2 * Math.PI * ph) * Math.exp(-t * 2.2) * 0.9 + lp * Math.exp(-t * 4) * 0.6; }
    out.push(x);
  }
  { // scratch: band-passed noise with a moving centre
    const x = mk(0.7); let lo = 0, bp = 0;
    const pts = [[0, 400], [0.12, 2200], [0.22, 300], [0.36, 2600], [0.5, 500], [0.65, 1800], [0.7, 1800]];
    for (let i = 0; i < x.length; i++) { const t = i / sr;
      let k = 0; while (k < pts.length - 2 && t > pts[k + 1][0]) k++;
      const [t0, f0] = pts[k], [t1, f1] = pts[k + 1], u = Math.min(1, (t - t0) / (t1 - t0)), fc = f0 + (f1 - f0) * u;
      const a = 1 - Math.exp(-2 * Math.PI * fc / sr); const n = rnd(); lo += a * (n - lo); bp += a * (lo - bp);
      const env = k % 2 ? 0.15 + 0.85 * (1 - u) : 0.15 + 0.85 * u;
      x[i] = (lo - bp) * 3 * env * Math.min(1, (0.7 - t) / 0.03); }
    out.push(x);
  }
  // normalise each pad to the same peak
  for (const x of out) { let m = 0; for (let i = 0; i < x.length; i++) m = Math.max(m, Math.abs(x[i])); const g = 0.85 / (m || 1); for (let i = 0; i < x.length; i++) x[i] *= g; }
  return out;
}
