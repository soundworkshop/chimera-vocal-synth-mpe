/**
 * Formant tracking from a microphone frame: F1 and F2 of the performer's own voice (spoken,
 * sung or whispered), the way Praat does it: down-sample to ~11 kHz, adaptive pre-emphasis, Hamming
 * window, autocorrelation LPC (Levinson-Durbin), then the roots of the predictor polynomial —
 * each sharp pair of complex roots is a resonance of the vocal tract. Pure maths (no Web Audio),
 * fast enough to run every animation frame on the main thread (~0.5 ms).
 */

export interface Resonance {
  f: number;
  bw: number;
}

export interface FormantFrame {
  /** Hz, or 0 when not found (the simple pick: the lowest in each range) */
  f1: number;
  f2: number;
  /** every sharp resonance found (Hz, bandwidth Hz), ascending: for picking by continuity */
  candidates: Resonance[];
  /** frame level (dBFS, RMS) */
  db: number;
}

/** LPC order for ~11 kHz: two poles per kHz plus two */
const ORDER = 12;
const TARGET_RATE = 11025;

export function analyzeFormants(frame: Float32Array, sampleRate: number): FormantFrame {
  // RMS level on the full-rate signal
  let ss = 0;
  for (let i = 0; i < frame.length; i++) ss += frame[i] * frame[i];
  const db = 10 * Math.log10(ss / Math.max(1, frame.length) + 1e-12);

  // down-sample by averaging (a crude but adequate anti-alias for F1/F2 below 3.5 kHz)
  const d = Math.max(1, Math.round(sampleRate / TARGET_RATE));
  const fs = sampleRate / d;
  const n = Math.floor(frame.length / d);
  if (n < ORDER * 4) return { f1: 0, f2: 0, db, candidates: [] };
  const x = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let j = 0; j < d; j++) s += frame[i * d + j];
    x[i] = s / d;
  }
  // adaptive pre-emphasis: remove this frame's own overall tilt (its first-order prediction), so
  // a voiced frame (falling ~6 dB/oct) and a whisper (nearly flat) are both levelled, not one
  // over-tilted, which would drag F1 upward; then Hamming
  let r0 = 0, r1 = 0;
  for (let i = 0; i < n; i++) (r0 += x[i] * x[i]), i > 0 && (r1 += x[i] * x[i - 1]);
  const pre = r0 > 0 ? Math.min(0.97, Math.max(0, r1 / r0)) : 0;
  for (let i = n - 1; i > 0; i--) x[i] -= pre * x[i - 1];
  x[0] *= 1 - pre;
  for (let i = 0; i < n; i++) x[i] *= 0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (n - 1));

  const a = lpc(x, ORDER);
  if (!a) return { f1: 0, f2: 0, db, candidates: [] };
  const candidates = rootFormants(a, fs);
  const { f1, f2 } = pickFormants(candidates, 0, 0);
  return { f1, f2, db, candidates };
}

/** Autocorrelation + Levinson-Durbin: predictor a[0..p] (a[0] = 1), or null if degenerate. */
function lpc(x: Float64Array, p: number): Float64Array | null {
  const r = new Float64Array(p + 1);
  for (let k = 0; k <= p; k++) {
    let s = 0;
    for (let i = k; i < x.length; i++) s += x[i] * x[i - k];
    r[k] = s;
  }
  if (!(r[0] > 1e-12)) return null;
  r[0] *= 1 + 1e-9; // white-noise floor keeps it stable
  const a = new Float64Array(p + 1);
  a[0] = 1;
  let err = r[0];
  const tmp = new Float64Array(p + 1);
  for (let i = 1; i <= p; i++) {
    let acc = r[i];
    for (let j = 1; j < i; j++) acc += a[j] * r[i - j];
    const k = -acc / err;
    tmp.set(a);
    for (let j = 1; j < i; j++) a[j] = tmp[j] + k * tmp[i - j];
    a[i] = k;
    err *= 1 - k * k;
    if (!(err > 0)) return null;
  }
  return a;
}

/**
 * Resonances of 1/A(z): the roots of A, as frequencies (Hz, ascending), keeping only sharp
 * ones (bandwidth under 500 Hz) above 90 Hz. Durand-Kerner iteration on the polynomial.
 */
function rootFormants(a: Float64Array, fs: number): Resonance[] {
  const p = a.length - 1;
  // z^p + a1 z^(p-1) + … + ap
  const re = new Float64Array(p), im = new Float64Array(p);
  for (let i = 0; i < p; i++) {
    const ang = (2 * Math.PI * i) / p + 0.4;
    re[i] = 0.9 * Math.cos(ang);
    im[i] = 0.9 * Math.sin(ang);
  }
  for (let iter = 0; iter < 80; iter++) {
    let moved = 0;
    for (let i = 0; i < p; i++) {
      // numerator: polynomial at root i (Horner)
      let nr = 1, ni = 0;
      for (let k = 1; k <= p; k++) {
        const t = nr * re[i] - ni * im[i] + a[k];
        ni = nr * im[i] + ni * re[i];
        nr = t;
      }
      // denominator: product of (z_i - z_j)
      let dr = 1, di = 0;
      for (let j = 0; j < p; j++) {
        if (j === i) continue;
        const xr = re[i] - re[j], xi = im[i] - im[j];
        const t = dr * xr - di * xi;
        di = dr * xi + di * xr;
        dr = t;
      }
      const den = dr * dr + di * di || 1e-30;
      const qr = (nr * dr + ni * di) / den, qi = (ni * dr - nr * di) / den;
      re[i] -= qr;
      im[i] -= qi;
      moved = Math.max(moved, Math.abs(qr) + Math.abs(qi));
    }
    if (moved < 1e-10) break;
  }
  const out: Resonance[] = [];
  for (let i = 0; i < p; i++) {
    if (im[i] <= 0) continue; // one of each conjugate pair
    const mag = Math.hypot(re[i], im[i]);
    const f = (Math.atan2(im[i], re[i]) * fs) / (2 * Math.PI);
    const bw = (-Math.log(Math.max(1e-9, mag)) * fs) / Math.PI;
    if (f > 90 && bw < 500 && mag < 1) out.push({ f, bw });
  }
  return out.sort((x, y) => x.f - y.f);
}

const F1_RANGE = [180, 1100], F2_RANGE = [550, 3200];

/**
 * F1 and F2 among the resonances. With no history, the lowest in each range (F2 above F1).
 * Given the previous F1/F2, the candidate closest to each (in log Hz, a broad peak counting as a
 * little further away): a formant moves continuously, so a stray root that appears between F1
 * and F2 for a frame doesn't get taken for F2.
 */
export function pickFormants(c: Resonance[], prev1: number, prev2: number): { f1: number; f2: number } {
  const cost = (r: Resonance, prev: number) => Math.abs(Math.log(r.f / prev)) + r.bw / 800;
  const best = (list: Resonance[], prev: number) => (prev > 0 ? list.reduce<Resonance | null>((b, r) => (!b || cost(r, prev) < cost(b, prev) ? r : b), null) : (list[0] ?? null));
  const r1 = best(c.filter((r) => r.f >= F1_RANGE[0] && r.f <= F1_RANGE[1]), prev1);
  if (!r1) return { f1: 0, f2: 0 };
  const r2 = best(c.filter((r) => r.f > r1.f * 1.15 && r.f >= F2_RANGE[0] && r.f <= F2_RANGE[1]), prev2);
  return { f1: r1.f, f2: r2?.f ?? 0 };
}

/**
 * The vowel the mic is saying, steadied for the mouth: F1/F2 picked by continuity, a spike filter
 * (one bad frame can't steer, and ordinary movement isn't delayed), then one-pole smoothing in log Hz whose speed
 * scales with confidence (frames well under the current speaking level, the starts and ends of
 * words, move it only a little). After a pause it waits for two frames that agree and jumps
 * there, rather than gliding from the old vowel through the onset's noise.
 */
export class FormantFollower {
  private hist: { f1: number; f2: number }[] = [];
  private prev1 = 0;
  private prev2 = 0;
  /** smoothed log F1, log F2 (0: none yet) */
  private s1 = 0;
  private s2 = 0;
  private silent = Infinity;
  /** after a pause (or at the start): waiting for two frames that agree, to jump there */
  private waiting = true;
  /** a pause longer than this starts afresh (s) */
  static PAUSE = 0.15;

  /**
   * One frame: `voiced` whether the gate accepted it, `confidence` 0..1, `tau` the smoothing
   * time (s). Returns the steadied raw (performer-space) F1/F2, or null to hold still.
   */
  update(frame: FormantFrame, voiced: boolean, confidence: number, dt: number, tau: number): { f1: number; f2: number } | null {
    if (!voiced) {
      this.silent += dt;
      if (this.silent > FormantFollower.PAUSE) (this.hist = []), (this.prev1 = this.prev2 = 0), (this.waiting = true);
      return null;
    }
    this.silent = 0;
    const pick = pickFormants(frame.candidates, this.prev1, this.prev2);
    if (!pick.f1 || !pick.f2) return null;
    this.prev1 = pick.f1;
    this.prev2 = pick.f2;
    this.hist.push(pick);
    if (this.hist.length > 3) this.hist.shift();
    if (this.waiting) {
      // a new phrase: wait for two frames that agree (within ~10%), then go straight there
      const n = this.hist.length;
      if (n < 2) return null;
      const [a, b] = [this.hist[n - 2], this.hist[n - 1]];
      if (Math.abs(Math.log(a.f1 / b.f1)) > 0.1 || Math.abs(Math.log(a.f2 / b.f2)) > 0.1) return null;
      this.s1 = Math.log((a.f1 + b.f1) / 2);
      this.s2 = Math.log((a.f2 + b.f2) / 2);
      this.waiting = false;
      return { f1: Math.exp(this.s1), f2: Math.exp(this.s2) };
    }
    // spike filter: a big jump away from two steady frames is held back one frame (a real
    // movement is confirmed by the next frame; a glitch isn't). Unlike a running median, an
    // ordinary transition passes with no delay.
    const n = this.hist.length;
    let m1 = pick.f1, m2 = pick.f2;
    if (n >= 3) {
      const [a, b] = [this.hist[n - 3], this.hist[n - 2]];
      const steady = Math.abs(Math.log(a.f1 / b.f1)) < 0.1 && Math.abs(Math.log(a.f2 / b.f2)) < 0.1;
      const jump = Math.abs(Math.log(pick.f1 / b.f1)) > 0.25 || Math.abs(Math.log(pick.f2 / b.f2)) > 0.3;
      if (steady && jump) (m1 = b.f1), (m2 = b.f2);
    }
    const k = 1 - Math.exp((-dt * Math.min(1, Math.max(0, confidence))) / Math.max(0.001, tau));
    this.s1 += k * (Math.log(m1) - this.s1);
    this.s2 += k * (Math.log(m2) - this.s2);
    return { f1: Math.exp(this.s1), f2: Math.exp(this.s2) };
  }

  reset(): void {
    this.hist = [];
    this.prev1 = this.prev2 = 0;
    this.s1 = this.s2 = 0;
    this.silent = Infinity;
    this.waiting = true;
  }
}

/** Median of the middle of a list (for calibration captures). */
export function median(v: number[]): number {
  if (!v.length) return 0;
  const s = [...v].sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)];
}

/**
 * The map from the performer's vowel space to the model's, per formant, in log Hz:
 * log F_model = a · log F_user + b. Fitted from the performer's "ee", "ah", "oo".
 */
export interface FormantCalibration {
  a1: number;
  b1: number;
  a2: number;
  b2: number;
}
export const IDENTITY_CALIBRATION: FormantCalibration = { a1: 1, b1: 0, a2: 1, b2: 0 };

/** Least squares in log Hz; the slope is kept to 0.5..1.6 so a bad capture can't fold the map. */
export function fitCalibration(user: { f1: number; f2: number }[], model: { f1: number; f2: number }[]): FormantCalibration {
  const fit = (xs: number[], ys: number[]) => {
    const lx = xs.map(Math.log), ly = ys.map(Math.log);
    const mx = lx.reduce((s, v) => s + v, 0) / lx.length, my = ly.reduce((s, v) => s + v, 0) / ly.length;
    let sxy = 0, sxx = 0;
    for (let i = 0; i < lx.length; i++) (sxy += (lx[i] - mx) * (ly[i] - my)), (sxx += (lx[i] - mx) ** 2);
    const a = sxx > 1e-6 ? Math.min(1.6, Math.max(0.5, sxy / sxx)) : 1;
    return [a, my - a * mx];
  };
  const [a1, b1] = fit(user.map((u) => u.f1), model.map((m) => m.f1));
  const [a2, b2] = fit(user.map((u) => u.f2), model.map((m) => m.f2));
  return { a1, b1, a2, b2 };
}

export function applyCalibration(f1: number, f2: number, c: FormantCalibration): { f1: number; f2: number } {
  return { f1: Math.exp(c.a1 * Math.log(f1) + c.b1), f2: Math.exp(c.a2 * Math.log(f2) + c.b2) };
}

/**
 * A capture whose vowels aren't in their places (ee, ah, oo): "oo" must have a much lower F2 than
 * "ee" (else the tracker took F3 for its F2), and "ah" the highest F1.
 */
export function calibrationProblem(got: { f1: number; f2: number }[]): string | null {
  const [ee, ah, oo] = got;
  const fmt = (v: { f1: number; f2: number }) => `F1 ${Math.round(v.f1)}, F2 ${Math.round(v.f2)} Hz`;
  if (!(oo.f2 < ee.f2 * 0.75)) return `Calibration not saved: your “oo” (${fmt(oo)}) looked too much like your “ee” (${fmt(ee)}). Try a rounder, darker “oo”, closer to the mic.`;
  if (!(ah.f1 > Math.max(ee.f1, oo.f1) * 1.15)) return `Calibration not saved: your “ah” (${fmt(ah)}) wasn't open enough. Try a wide-open “ah”.`;
  return null;
}
