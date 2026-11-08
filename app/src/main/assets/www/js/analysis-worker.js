/* Track analysis worker: BPM + beat grid, musical key (Camelot), 3-band waveform peaks,
 * and smart mix-in / mix-out points for automix. Input: mono Float32Array + sampleRate. */

const PEAKS_PER_SEC = 120;

self.onmessage = (e) => {
  const { id, mono, sampleRate } = e.data;
  try {
    const res = analyze(mono, sampleRate);
    self.postMessage({ id, ok: true, res }, [res.peaks.low.buffer, res.peaks.mid.buffer, res.peaks.high.buffer]);
  } catch (err) {
    self.postMessage({ id, ok: false, error: String(err && err.stack || err) });
  }
};

function analyze(x, sr) {
  const duration = x.length / sr;
  const peaks = bandPeaks(x, sr);
  const { bpm, firstBeat } = detectTempo(x, sr);
  const key = detectKey(x, sr);
  const { mixIn, mixOut, energy } = mixPoints(x, sr, bpm, firstBeat, duration);
  return { duration, bpm, firstBeat, key: key.name, camelot: key.camelot, keyIndex: key.index, mixIn, mixOut, energy, peaks };
}

/* ---------- waveform (low / mid / high peaks) ---------- */
function bandPeaks(x, sr) {
  const hop = Math.max(1, Math.round(sr / PEAKS_PER_SEC));
  const n = Math.ceil(x.length / hop);
  const low = new Float32Array(n), mid = new Float32Array(n), high = new Float32Array(n);
  const a1 = 1 - Math.exp(-2 * Math.PI * 220 / sr);
  const a2 = 1 - Math.exp(-2 * Math.PI * 2500 / sr);
  let l1 = 0, l2 = 0;
  for (let b = 0, i = 0; b < n; b++) {
    let pl = 0, pm = 0, ph = 0;
    const end = Math.min(x.length, i + hop);
    for (; i < end; i++) {
      const s = x[i];
      l1 += a1 * (s - l1); l2 += a2 * (s - l2);
      const lo = Math.abs(l1), md = Math.abs(l2 - l1), hi = Math.abs(s - l2);
      if (lo > pl) pl = lo; if (md > pm) pm = md; if (hi > ph) ph = hi;
    }
    low[b] = pl; mid[b] = pm; high[b] = ph;
  }
  // normalise to the loudest band peak
  let mx = 1e-6;
  for (let i = 0; i < n; i++) mx = Math.max(mx, low[i], mid[i], high[i]);
  const g = 1 / mx;
  for (let i = 0; i < n; i++) { low[i] *= g; mid[i] *= g; high[i] *= g; }
  return { rate: sr / hop, low, mid, high };
}

/* ---------- tempo ---------- */
function onsetEnvelope(x, sr, hop) {
  const n = Math.floor(x.length / hop);
  const env = new Float32Array(n);
  const aLow = 1 - Math.exp(-2 * Math.PI * 150 / sr);
  let lp = 0, prevLow = 0, prevAll = 0;
  const onsetLow = new Float32Array(n), onsetAll = new Float32Array(n);
  for (let f = 0; f < n; f++) {
    let eL = 0, eA = 0;
    const base = f * hop;
    for (let i = 0; i < hop; i++) {
      const s = x[base + i];
      lp += aLow * (s - lp);
      eL += lp * lp; eA += s * s;
    }
    const lL = Math.log(1e-9 + eL), lA = Math.log(1e-9 + eA);
    onsetLow[f] = Math.max(0, lL - prevLow); onsetAll[f] = Math.max(0, lA - prevAll);
    prevLow = lL; prevAll = lA;
  }
  normalise(onsetLow); normalise(onsetAll);
  for (let f = 0; f < n; f++) env[f] = onsetLow[f] * 0.65 + onsetAll[f] * 0.35;
  // remove local mean (adaptive threshold)
  const w = 8, out = new Float32Array(n);
  let acc = 0;
  for (let f = 0; f < n; f++) {
    acc += env[f]; if (f >= 2 * w) acc -= env[f - 2 * w];
    const mean = acc / Math.min(f + 1, 2 * w);
    out[f] = Math.max(0, env[f] - mean);
  }
  return out;
}

function normalise(a) {
  let m = 1e-9; for (let i = 0; i < a.length; i++) if (a[i] > m) m = a[i];
  for (let i = 0; i < a.length; i++) a[i] /= m;
}

function detectTempo(x, sr) {
  const hop = Math.round(sr / 200); // 200 fps
  const fps = sr / hop;
  const env = onsetEnvelope(x, sr, hop);
  if (env.length < fps * 4) return { bpm: 120, firstBeat: 0 };
  // autocorrelation on up to 90 s from the middle of the track
  const span = Math.min(env.length, Math.round(fps * 90));
  const start = Math.max(0, Math.floor((env.length - span) / 2));
  const seg = env.subarray(start, start + span);
  const minLag = Math.floor(fps * 60 / 200), maxLag = Math.ceil(fps * 60 / 60);
  const ac = new Float32Array(maxLag + 2);
  for (let lag = minLag; lag <= maxLag + 1; lag++) {
    let s = 0;
    for (let i = 0; i + lag < seg.length; i++) s += seg[i] * seg[i + lag];
    ac[lag] = s / (seg.length - lag);
  }
  let best = -1, bestLag = minLag;
  for (let lag = minLag; lag <= maxLag; lag++) {
    const bpm = 60 * fps / lag;
    // prefer musical range around 125 BPM, add harmonic support
    const w = Math.exp(-0.5 * Math.pow(Math.log2(bpm / 125) / 0.9, 2));
    let s = ac[lag];
    if (lag * 2 <= maxLag + 1) s += 0.5 * ac[lag * 2];
    if (Math.round(lag / 2) >= minLag) s += 0.25 * ac[Math.round(lag / 2)];
    s *= w;
    if (s > best) { best = s; bestLag = lag; }
  }
  let bpm = 60 * fps / bestLag;
  while (bpm < 78) bpm *= 2;
  while (bpm > 165) bpm /= 2;

  // fine search: comb over whole track (bpm +-2%), then phase
  let bestScore = -1, bestBpm = bpm, bestPhase = 0;
  for (let c = bpm * 0.98; c <= bpm * 1.02; c += 0.02) {
    const period = 60 * fps / c;
    const { score, phase } = combScore(env, period);
    if (score > bestScore) { bestScore = score; bestBpm = c; bestPhase = phase; }
  }
  // snap to common integer / half BPMs when very close
  const r = Math.round(bestBpm);
  if (Math.abs(bestBpm - r) < 0.06) {
    const p = 60 * fps / r; const cs = combScore(env, p);
    if (cs.score >= bestScore * 0.985) { bestBpm = r; bestPhase = cs.phase; }
  }
  const period = 60 * fps / bestBpm;
  let firstBeat = bestPhase / fps;
  // phase refers to beat positions; pick the earliest beat >= 0
  firstBeat = firstBeat % (period / fps);
  return { bpm: Math.round(bestBpm * 100) / 100, firstBeat };
}

function combScore(env, period) {
  let bestS = -1, bestP = 0;
  const steps = Math.ceil(period);
  for (let p = 0; p < steps; p += 1) {
    let s = 0, k = 0;
    for (let t = p; t < env.length; t += period) {
      const i = Math.round(t);
      s += env[i] + 0.5 * ((env[i - 1] || 0) + (env[i + 1] || 0));
      k++;
    }
    s /= Math.max(1, k);
    if (s > bestS) { bestS = s; bestP = p; }
  }
  return { score: bestS, phase: bestP };
}

/* ---------- key ---------- */
const MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];
const NOTES = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
// Camelot numbers indexed by tonic pitch class
const CAM_MAJ = [8, 3, 10, 5, 12, 7, 2, 9, 4, 11, 6, 1];
const CAM_MIN = [5, 12, 7, 2, 9, 4, 11, 6, 1, 8, 3, 10];

function detectKey(x, sr) {
  // decimate to ~11 kHz
  const dec = Math.max(1, Math.round(sr / 11025));
  const fs = sr / dec;
  const N = 8192;
  const len = Math.floor(x.length / dec);
  if (len < N * 2) return { name: '-', camelot: '-', index: -1 };
  const y = new Float32Array(len);
  for (let i = 0; i < len; i++) { let s = 0; for (let j = 0; j < dec; j++) s += x[i * dec + j]; y[i] = s / dec; }
  const frames = Math.min(160, Math.floor(len / N));
  const stepF = Math.floor((len - N) / Math.max(1, frames - 1));
  const chroma = new Float64Array(12);
  const re = new Float64Array(N), im = new Float64Array(N);
  const win = new Float64Array(N);
  for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (N - 1));
  // precompute bin -> pitch class mapping
  const binPc = new Int8Array(N / 2).fill(-1), binW = new Float32Array(N / 2);
  for (let k = 1; k < N / 2; k++) {
    const f = k * fs / N;
    if (f < 55 || f > 1760) continue;
    const midi = 69 + 12 * Math.log2(f / 440);
    const pc = ((Math.round(midi) % 12) + 12) % 12;
    const dev = Math.abs(midi - Math.round(midi));
    if (dev > 0.35) continue;
    binPc[k] = pc; binW[k] = 1 - dev;
  }
  for (let fi = 0; fi < frames; fi++) {
    const off = fi * stepF;
    for (let i = 0; i < N; i++) { re[i] = y[off + i] * win[i]; im[i] = 0; }
    fft(re, im);
    const fr = new Float64Array(12);
    for (let k = 1; k < N / 2; k++) {
      if (binPc[k] < 0) continue;
      const mag = Math.sqrt(re[k] * re[k] + im[k] * im[k]);
      fr[binPc[k]] += Math.log(1 + mag) * binW[k];
    }
    let s = 0; for (let i = 0; i < 12; i++) s += fr[i];
    if (s > 0) for (let i = 0; i < 12; i++) chroma[i] += fr[i] / s;
  }
  let best = -2, bi = 0, minor = false;
  for (let t = 0; t < 12; t++) {
    const cMaj = corr(chroma, MAJOR, t), cMin = corr(chroma, MINOR, t);
    if (cMaj > best) { best = cMaj; bi = t; minor = false; }
    if (cMin > best) { best = cMin; bi = t; minor = true; }
  }
  const name = NOTES[bi] + (minor ? 'm' : '');
  const camelot = (minor ? CAM_MIN[bi] : CAM_MAJ[bi]) + (minor ? 'A' : 'B');
  return { name, camelot, index: bi + (minor ? 12 : 0) };
}

function corr(c, prof, shift) {
  let mc = 0, mp = 0;
  for (let i = 0; i < 12; i++) { mc += c[i]; mp += prof[i]; }
  mc /= 12; mp /= 12;
  let num = 0, dc = 0, dp = 0;
  for (let i = 0; i < 12; i++) {
    const a = c[(i + shift) % 12] - mc, b = prof[i] - mp;
    num += a * b; dc += a * a; dp += b * b;
  }
  return num / Math.sqrt(dc * dp + 1e-12);
}

function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len, wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let j = 0; j < len / 2; j++) {
        const ar = re[i + j], ai = im[i + j];
        const br = re[i + j + len / 2] * cr - im[i + j + len / 2] * ci;
        const bi = re[i + j + len / 2] * ci + im[i + j + len / 2] * cr;
        re[i + j] = ar + br; im[i + j] = ai + bi;
        re[i + j + len / 2] = ar - br; im[i + j + len / 2] = ai - bi;
        const nr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = nr;
      }
    }
  }
}

/* ---------- mix points ---------- */
function mixPoints(x, sr, bpm, firstBeat, duration) {
  const hop = Math.round(sr / 4); // 0.25 s
  const n = Math.floor(x.length / hop);
  const rms = new Float32Array(n);
  for (let f = 0; f < n; f++) {
    let s = 0; const b = f * hop;
    for (let i = 0; i < hop; i += 4) s += x[b + i] * x[b + i];
    rms[f] = Math.sqrt(s / (hop / 4));
  }
  const sorted = Array.from(rms).filter(v => v > 1e-4).sort((a, b) => a - b);
  const median = sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0;
  const thIn = median * 0.25, thOut = median * 0.45;
  let first = 0; while (first < n && rms[first] < thIn) first++;
  let last = n - 1; while (last > first && rms[last] < thOut) last--;
  const beat = 60 / bpm, bar = beat * 4;
  const snapUp = (t) => firstBeat + Math.ceil((t - firstBeat) / beat - 0.15) * beat;
  const snapBar = (t) => firstBeat + Math.round((t - firstBeat) / bar) * bar;
  let mixIn = Math.max(0, snapUp(first * 0.25));
  let mixOut = Math.min(duration, snapBar((last + 1) * 0.25));
  if (mixOut - mixIn < 20) { mixIn = 0; mixOut = duration; }
  // energy profile (1 value / second, 0..1) for UI + smart automix
  const secs = Math.max(1, Math.floor(duration));
  const energy = [];
  for (let s = 0; s < secs; s++) {
    let m = 0; for (let k = 0; k < 4; k++) m += rms[s * 4 + k] || 0;
    energy.push(Math.min(1, (m / 4) / (median * 2 + 1e-9)));
  }
  return { mixIn, mixOut, energy };
}
