/* AudioWorklet processors for DJ Free.
 *  - deck-player : sample-accurate track player (variable/negative speed, scratch,
 *                  brake, spinback, loops, loop-roll with slip, scheduled start)
 *  - pitch-shifter: granular pitch shifter used for key-lock and key-shift FX
 *  - bitcrusher   : bit depth + sample rate reduction
 */

class DeckPlayer extends AudioWorkletProcessor {
  constructor() {
    super();
    this.L = null; this.R = null; this.len = 0; this.srcRate = sampleRate;
    this.pos = 0;            // position in source samples (float)
    this.playing = false;
    this.rate = 1;           // tempo rate set by pitch fader (+ bend)
    this.cur = 0;            // smoothed actual speed (source samples per output sample, normalised)
    this.mode = 'normal';    // normal | scratch | brake | spin
    this.scratchVel = 0;
    this.modeT = 0; this.modeDur = 1; this.modeFrom = 1;
    this.reverse = false;
    this.loopOn = false; this.loopA = 0; this.loopB = 0;
    this.slip = false; this.slipPos = 0; this.slipActive = false;
    this.startAt = -1;
    this.declick = 0;
    this.reportCounter = 0;
    this.port.onmessage = (e) => this.onMsg(e.data);
  }

  onMsg(m) {
    switch (m.type) {
      case 'load':
        this.L = m.L; this.R = m.R || m.L; this.len = this.L.length; this.srcRate = m.sampleRate;
        this.pos = 0; this.playing = false; this.loopOn = false; this.mode = 'normal'; this.cur = 0;
        this.slipActive = false; this.startAt = -1;
        break;
      case 'unload':
        this.L = this.R = null; this.len = 0; this.playing = false; break;
      case 'play':
        if (m.at && m.at > currentTime) { this.startAt = m.at; }
        else { this.playing = true; this.startAt = -1; }
        if (this.mode === 'brake' || this.mode === 'spin') this.mode = 'normal';
        this.declick = 1;
        break;
      case 'pause': this.playing = false; this.startAt = -1; break;
      case 'seek': {
        const p = Math.max(0, Math.min(this.len - 1, m.pos * this.srcRate));
        if (this.slipActive) this.slipPos = p; else this.pos = p;
        if (m.slipToo) this.slipPos = p;
        this.declick = 1;
        break;
      }
      case 'rate': this.rate = m.value; break;
      case 'reverse': this.reverse = !!m.on; this.syncSlip(m.on); break;
      case 'loop':
        this.loopOn = !!m.on;
        if (m.on) { this.loopA = m.a * this.srcRate; this.loopB = m.b * this.srcRate;
          if (m.jump) { this.pos = this.loopA; this.declick = 1; } }
        break;
      case 'roll':
        if (m.on) {
          this.slipPos = this.pos; this.slipActive = true;
          this.loopA = m.a * this.srcRate; this.loopB = m.b * this.srcRate; this.loopOn = true;
          this.pos = this.loopA; this.declick = 1;
        } else {
          this.loopOn = false; this.endSlip();
        }
        break;
      case 'slip': this.slip = !!m.on; break;
      case 'scratch':
        if (m.on) { this.mode = 'scratch'; this.scratchVel = 0; this.syncSlip(true); }
        else { this.mode = 'normal'; this.syncSlip(false); }
        break;
      case 'scratchVel': this.scratchVel = m.v; break;
      case 'brake': this.mode = 'brake'; this.modeT = 0; this.modeDur = m.dur * sampleRate; this.modeFrom = this.cur || this.rate; break;
      case 'spin': this.mode = 'spin'; this.modeT = 0; this.modeDur = m.dur * sampleRate; this.modeFrom = -Math.max(2.5, Math.abs(this.cur) * 3); this.playing = true; break;
    }
  }

  syncSlip(on) {
    if (!this.slip) return;
    if (on && !this.slipActive) { this.slipPos = this.pos; this.slipActive = true; }
    else if (!on) this.endSlip();
  }

  endSlip() {
    if (this.slipActive) { this.pos = this.slipPos; this.slipActive = false; this.declick = 1; }
  }

  sample(buf, p) {
    // cubic hermite interpolation
    const i = Math.floor(p), f = p - i, n = this.len;
    const xm1 = buf[i > 0 ? i - 1 : 0], x0 = buf[i] || 0,
      x1 = i + 1 < n ? buf[i + 1] : 0, x2 = i + 2 < n ? buf[i + 2] : 0;
    const c = (x1 - xm1) * 0.5, v = x0 - x1, w = c + v, a = w + v + (x2 - x0) * 0.5, b = w + a;
    return ((((a * f) - b) * f + c) * f + x0);
  }

  process(inputs, outputs) {
    const out = outputs[0], oL = out[0], oR = out[1] || out[0];
    const N = oL.length;
    if (!this.L) { oL.fill(0); if (oR !== oL) oR.fill(0); return true; }
    const ratio = this.srcRate / sampleRate;
    if (this.startAt > 0 && currentTime >= this.startAt) { this.playing = true; this.startAt = -1; this.declick = 1; }
    let gainRamp = this.declick ? 0 : 1;
    for (let n = 0; n < N; n++) {
      let target;
      if (this.mode === 'scratch') target = this.scratchVel;
      else if (this.mode === 'brake') {
        const t = this.modeT++ / this.modeDur; target = this.modeFrom * Math.max(0, 1 - t);
        if (t >= 1) { this.playing = false; this.mode = 'normal'; target = 0; this.cur = 0; }
      } else if (this.mode === 'spin') {
        const t = this.modeT++ / this.modeDur; target = this.modeFrom * Math.max(0, 1 - t) * (1 - t);
        if (t >= 1) { this.playing = false; this.mode = 'normal'; target = 0; this.cur = 0; }
      } else target = this.playing ? (this.reverse ? -this.rate : this.rate) : 0;

      const k = this.mode === 'scratch' ? 0.02 : (this.mode === 'normal' ? 0.01 : 1);
      this.cur += (target - this.cur) * k;
      if (!this.playing && this.mode === 'normal' && Math.abs(this.cur) < 1e-4) this.cur = 0;

      let sL = 0, sR = 0;
      if (this.cur !== 0 && this.pos >= 0 && this.pos < this.len - 1) {
        sL = this.sample(this.L, this.pos); sR = this.sample(this.R, this.pos);
      }
      if (this.declick) {
        gainRamp = Math.min(1, gainRamp + 1 / 96);
        if (gainRamp >= 1) this.declick = 0;
        sL *= gainRamp; sR *= gainRamp;
      }
      oL[n] = sL; oR[n] = sR;

      this.pos += this.cur * ratio;
      if (this.slipActive) this.slipPos += (this.playing ? this.rate : 0) * ratio;
      if (this.loopOn && this.loopB > this.loopA) {
        if (this.cur > 0 && this.pos >= this.loopB) this.pos = this.loopA + (this.pos - this.loopB);
        else if (this.cur < 0 && this.pos < this.loopA) this.pos = this.loopB - (this.loopA - this.pos);
      }
      if (this.pos < 0) { this.pos = 0; if (this.mode !== 'scratch') this.cur = 0; }
      if (this.pos >= this.len - 1) {
        this.pos = this.len - 1;
        if (this.playing && this.mode === 'normal') { this.playing = false; this.port.postMessage({ type: 'ended' }); }
      }
    }
    if (++this.reportCounter >= 4) {
      this.reportCounter = 0;
      this.port.postMessage({ type: 'pos', pos: this.pos / this.srcRate, t: currentTime,
        speed: this.cur, playing: this.playing || this.startAt > 0, slip: this.slipActive ? this.slipPos / this.srcRate : -1 });
    }
    return true;
  }
}
registerProcessor('deck-player', DeckPlayer);

class PitchShifter extends AudioWorkletProcessor {
  static get parameterDescriptors() { return [{ name: 'ratio', defaultValue: 1, minValue: 0.25, maxValue: 4, automationRate: 'k-rate' }]; }
  constructor() {
    super();
    this.size = 16384; this.mask = this.size - 1;
    this.buf = [new Float32Array(this.size), new Float32Array(this.size)];
    this.w = 0; this.phase = 0; this.win = 2048; this.mix = 0;
  }
  read(b, d) {
    let p = this.w - d; while (p < 0) p += this.size;
    const i = Math.floor(p), f = p - i;
    return b[i & this.mask] * (1 - f) + b[(i + 1) & this.mask] * f;
  }
  process(inputs, outputs, params) {
    const inp = inputs[0], out = outputs[0];
    const r = params.ratio[0];
    const N = out[0].length;
    const active = Math.abs(r - 1) > 0.0015;
    const targetMix = active ? 1 : 0;
    const chans = out.length;
    for (let n = 0; n < N; n++) {
      this.mix += (targetMix - this.mix) * 0.002;
      const ph1 = this.phase, ph2 = (this.phase + 0.5) % 1;
      const d1 = 64 + ph1 * this.win, d2 = 64 + ph2 * this.win;
      const g1 = Math.sin(Math.PI * ph1) ** 2, g2 = Math.sin(Math.PI * ph2) ** 2;
      for (let c = 0; c < chans; c++) {
        const x = inp[c] ? inp[c][n] : (inp[0] ? inp[0][n] : 0);
        const b = this.buf[c & 1];
        b[this.w] = x;
        if (this.mix > 0.0005) {
          const y = this.read(b, d1) * g1 + this.read(b, d2) * g2;
          out[c][n] = x * (1 - this.mix) + y * this.mix;
        } else out[c][n] = x;
      }
      this.w = (this.w + 1) & this.mask;
      this.phase += (1 - r) / this.win;
      if (this.phase >= 1) this.phase -= 1; else if (this.phase < 0) this.phase += 1;
    }
    return true;
  }
}
registerProcessor('pitch-shifter', PitchShifter);

class BitCrusher extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [{ name: 'bits', defaultValue: 8, minValue: 1, maxValue: 16, automationRate: 'k-rate' },
      { name: 'reduction', defaultValue: 4, minValue: 1, maxValue: 64, automationRate: 'k-rate' }];
  }
  constructor() { super(); this.hold = [0, 0]; this.count = 0; }
  process(inputs, outputs, params) {
    const inp = inputs[0], out = outputs[0];
    const step = Math.pow(0.5, params.bits[0]); const red = Math.max(1, Math.round(params.reduction[0]));
    for (let n = 0; n < out[0].length; n++) {
      if (this.count++ % red === 0) {
        for (let c = 0; c < out.length; c++) {
          const x = inp[c] ? inp[c][n] : 0;
          this.hold[c & 1] = step * Math.round(x / step);
        }
      }
      for (let c = 0; c < out.length; c++) out[c][n] = this.hold[c & 1];
    }
    return true;
  }
}
registerProcessor('bitcrusher', BitCrusher);
