/**
 * Formant tracking from a microphone frame: F1 and F2 of the performer's own voice (spoken,
 * sung or whispered), the way Praat does it: down-sample to ~11 kHz, adaptive pre-emphasis, Hamming
 * window, autocorrelation LPC (Levinson-Durbin), then the roots of the predictor polynomial —
 * each sharp pair of complex roots is a resonance of the vocal tract. Pure maths (no Web Audio),
 * fast enough to run every animation frame on the main thread (~0.5 ms).
 */

export interface FormantFrame {
  /** Hz, or 0 when not found */
  f1: number;
  f2: number;
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
  if (n < ORDER * 4) return { f1: 0, f2: 0, db };
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
  if (!a) return { f1: 0, f2: 0, db };
  const formants = rootFormants(a, fs);
  // F1 within the vowel range; F2 the next resonance up
  const f1 = formants.find((f) => f >= 180 && f <= 1100) ?? 0;
  const f2 = f1 ? (formants.find((f) => f > f1 + 120 && f >= 550 && f <= 3200) ?? 0) : 0;
  return { f1, f2: f2 ? f2 : 0, db };
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
function rootFormants(a: Float64Array, fs: number): number[] {
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
  const out: number[] = [];
  for (let i = 0; i < p; i++) {
    if (im[i] <= 0) continue; // one of each conjugate pair
    const mag = Math.hypot(re[i], im[i]);
    const f = (Math.atan2(im[i], re[i]) * fs) / (2 * Math.PI);
    const bw = (-Math.log(Math.max(1e-9, mag)) * fs) / Math.PI;
    if (f > 90 && bw < 500 && mag < 1) out.push(f);
  }
  return out.sort((x, y) => x - y);
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
