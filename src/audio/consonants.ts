/**
 * Consonants from the microphone, for quiet speech: what kind of constriction the performer just
 * made, not which phoneme (Chimera makes the sound itself from its own articulation). Two kinds:
 *
 * - Hiss (fricatives s, ʃ, f): aperiodic noise whose energy sits above the vowel range. Held for
 *   as long as it lasts. s is high (centroid above ~4.6 kHz), ʃ lower, f weak and flat (well
 *   below the level of the words around it).
 * - Bursts (stops t, k): a gap well below the speech level, then a sudden onset with energy
 *   above the vowel range. The place is read from the burst's spectrum: t is high, k a compact
 *   mid peak. A vowel starting after a pause is low-heavy, so it isn't a burst; nor, alas, is a
 *   labial burst (p, b), which looks the same in 10 ms.
 *
 * Pure DSP on the analyser's newest samples, once per animation frame; the caller turns events
 * into Chimera's own articulatory gestures.
 */

export type HissClass = "s" | "ʃ" | "f";
export type StopClass = "t" | "k";

export type ConsonantEvent = { type: "hissStart"; ipa: HissClass } | { type: "hissChange"; ipa: HissClass } | { type: "hissEnd" } | { type: "stop"; ipa: StopClass };

export interface ConsonantFeatures {
  /** dB, newest ~21 ms */
  db: number;
  /** dB, newest ~5 ms (onsets) */
  dbShort: number;
  /** band energies (linear) */
  low: number;
  mid: number;
  high: number;
  /** spectral centroid above 1.5 kHz (Hz) */
  centroid: number;
  /** normalised autocorrelation peak for 70–400 Hz (voicing) */
  periodicity: number;
}

const LOW = [80, 1500], MID = [1500, 3500], HIGH = [3500, 10000];

/** Spectral and voicing features of the newest `n` samples. */
export function consonantFeatures(frame: Float32Array, sampleRate: number, n = 1024): ConsonantFeatures {
  const x = frame.subarray(Math.max(0, frame.length - n));
  const len = 1 << Math.floor(Math.log2(x.length));
  const re = new Float64Array(len), im = new Float64Array(len);
  let ss = 0;
  for (let i = 0; i < len; i++) {
    const v = x[x.length - len + i];
    ss += v * v;
    re[i] = v * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (len - 1)));
  }
  fft(re, im);
  const binHz = sampleRate / len;
  let low = 0, mid = 0, high = 0, cNum = 0, cDen = 0;
  for (let k = 1; k < len / 2; k++) {
    const f = k * binHz;
    const p = re[k] * re[k] + im[k] * im[k];
    if (f >= LOW[0] && f < LOW[1]) low += p;
    else if (f >= MID[0] && f < MID[1]) mid += p;
    else if (f >= HIGH[0] && f < HIGH[1]) high += p;
    if (f >= 1500 && f < 10000) (cNum += f * p), (cDen += p);
  }
  const short = x.subarray(Math.max(0, x.length - Math.round(sampleRate * 0.005)));
  let sss = 0;
  for (let i = 0; i < short.length; i++) sss += short[i] * short[i];
  return {
    db: 10 * Math.log10(ss / Math.max(1, len) + 1e-12),
    dbShort: 10 * Math.log10(sss / Math.max(1, short.length) + 1e-12),
    low,
    mid,
    high,
    centroid: cDen > 0 ? cNum / cDen : 0,
    periodicity: periodicity(x, sampleRate),
  };
}

/** Peak of the normalised autocorrelation over pitch lags 70–400 Hz (0 noise … 1 periodic). */
function periodicity(x: Float32Array, sr: number): number {
  // every second sample is plenty for 400 Hz
  const n = Math.floor(x.length / 2);
  const y = new Float64Array(n);
  let mean = 0;
  for (let i = 0; i < n; i++) mean += y[i] = x[i * 2];
  mean /= n;
  for (let i = 0; i < n; i++) y[i] -= mean;
  const fs = sr / 2;
  const lo = Math.floor(fs / 400), hi = Math.min(n - 8, Math.ceil(fs / 70));
  let best = 0;
  for (let lag = lo; lag <= hi; lag++) {
    let num = 0, e1 = 0, e2 = 0;
    for (let i = 0; i + lag < n; i++) {
      num += y[i] * y[i + lag];
      e1 += y[i] * y[i];
      e2 += y[i + lag] * y[i + lag];
    }
    const r = num / Math.sqrt(e1 * e2 + 1e-20);
    if (r > best) best = r;
  }
  return best;
}

export class ConsonantDetector {
  /** how hissy a frame must be: (mid + high) / low energy, as a power ratio */
  hissRatio = 2.5;
  /** loudest recent speech (dB, decays), and the quietest (the room) */
  private peak = -120;
  private floor = Infinity;
  private hiss: HissClass | null = null;
  private hissFrames = 0;
  private quietFrames = 0;
  private pending: HissClass | null = null;
  private pendingFrames = 0;
  /** how strongly the hiss sounds, 0..1, smoothed (quick to rise, a little slower to fall) */
  private amount = 0;
  /** after a burst, its aspiration is not a new hiss, nor a second burst */
  private sinceStop = 1;

  /**
   * Feed the analyser's newest samples (dt: seconds since the last call, so the samples new
   * since then are known). Returns what happened.
   */
  update(frame: Float32Array, sampleRate: number, dt: number, gate: number): ConsonantEvent[] {
    const ev: ConsonantEvent[] = [];
    const f = consonantFeatures(frame, sampleRate);
    this.sinceStop += dt;
    // levels: a decaying peak of what is said, a floor that falls at once and rises slowly
    if (f.db > this.peak) this.peak = f.db;
    else this.peak -= 10 * dt;
    if (f.db < this.floor) this.floor = f.db;
    else this.floor += 2 * dt;

    // ---- bursts first (a burst's noise would otherwise start a hiss)
    if (!this.hiss && this.sinceStop > 0.08) {
      const ipa = this.findBurst(frame, sampleRate, dt, gate);
      if (ipa) {
        ev.push({ type: "stop", ipa });
        this.sinceStop = 0;
      }
    }

    // ---- hiss
    const loudEnough = f.db > gate - 10 && f.db > this.floor + 8;
    const ratio = (f.mid + f.high) / (f.low + 1e-20);
    const hissy = loudEnough && ratio > this.hissRatio && f.periodicity < 0.7 && this.sinceStop > 0.06;
    const cls: HissClass = f.db < this.peak - 22 ? "f" : f.centroid > 4600 ? "s" : "ʃ";
    // how much: how far the hiss ratio is past the threshold (±5 dB around it), how far the
    // level is above the room, and how noise-like it is (voicing pulls it down)
    const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
    const q = clamp01((10 * Math.log10(ratio) - (10 * Math.log10(this.hissRatio) - 5)) / 10);
    const lvl = clamp01((f.db - (this.floor + 6)) / 15);
    const noise = clamp01((0.85 - f.periodicity) / 0.25);
    const raw = this.sinceStop > 0.06 ? q * lvl * noise : 0;
    this.amount += (raw - this.amount) * (1 - Math.exp(-dt / (raw > this.amount ? 0.012 : 0.035)));
    if (hissy) {
      this.hissFrames++;
      this.quietFrames = 0;
      // one strongly hissy frame is enough; a marginal one needs a second
      if (!this.hiss && (ratio > this.hissRatio * 2 || this.hissFrames >= 2)) {
        this.hiss = cls;
        this.pending = null;
        ev.push({ type: "hissStart", ipa: cls });
      } else if (this.hiss && cls !== this.hiss) {
        // a class change must hold for 3 frames (no flicker between s and ʃ)
        if (this.pending === cls) this.pendingFrames++;
        else (this.pending = cls), (this.pendingFrames = 1);
        if (this.pendingFrames >= 3) {
          this.hiss = cls;
          this.pending = null;
          ev.push({ type: "hissEnd" }, { type: "hissStart", ipa: cls });
        }
      } else this.pending = null;
    } else {
      this.hissFrames = 0;
      // ends after two frames without (noise has dips)
      if (this.hiss && ++this.quietFrames >= 2) {
        this.hiss = null;
        ev.push({ type: "hissEnd" });
      }
    }
    return ev;
  }

  /**
   * A stop's release among the samples new since the last call: 2.5 ms blocks, a run of at
   * least 20 ms below the speech level, then a block 12 dB louder. The place comes from the
   * 10 ms after that onset, wherever it falls in the frame.
   */
  private findBurst(frame: Float32Array, sr: number, dt: number, gate: number): StopClass | null {
    const B = Math.round(sr * 0.0025);
    const nb = Math.floor(frame.length / B);
    const e = new Float64Array(nb);
    for (let b = 0; b < nb; b++) {
      let s = 0;
      for (let i = b * B; i < (b + 1) * B; i++) s += frame[i] * frame[i];
      e[b] = 10 * Math.log10(s / B + 1e-12);
    }
    const gapLevel = Math.max(this.floor + 6, this.peak - 22);
    const fresh = Math.min(nb, Math.ceil((dt * sr) / B) + 2);
    const need = 8; // 20 ms of gap
    // leave 10 ms after the onset to read the burst; a later onset is caught next frame
    for (let b = Math.max(need, nb - fresh - 4); b <= nb - 4; b++) {
      let quiet = true, gapDb = -Infinity;
      for (let k = b - need; k < b; k++) {
        if (e[k] >= gapLevel) quiet = false;
        gapDb = Math.max(gapDb, e[k]);
      }
      if (!quiet) continue;
      if (!(e[b] > gapDb + 12 && e[b] > this.floor + 15 && e[b] > gate - 10)) continue;
      const burst = frame.subarray(b * B, Math.min(frame.length, (b + 4) * B));
      const pad = new Float32Array(512);
      pad.set(burst.subarray(0, 512));
      const place = stopPlace(consonantFeatures(pad, sr, 512));
      if (place) return place;
    }
    return null;
  }

  /** whether a hiss is sounding (the vowel tracker should hold still meanwhile) */
  get hissing(): boolean {
    return this.hiss !== null;
  }

  /** the hiss sounding now (null: none) and how strongly, 0..1 */
  get hissNow(): { ipa: HissClass; amount: number } | null {
    return this.hiss ? { ipa: this.hiss, amount: this.amount } : null;
  }

  get recentStop(): boolean {
    return this.sinceStop < 0.06;
  }

  reset(): void {
    this.peak = -120;
    this.floor = Infinity;
    this.hiss = null;
    this.hissFrames = 0;
    this.quietFrames = 0;
    this.pending = null;
    this.amount = 0;
    this.sinceStop = 1;
  }
}

/**
 * Place of a stop from the 10 ms after its onset: t high, k a compact mid peak. A low-heavy
 * onset is left alone: a labial burst (p, b) is low noise that in 10 ms can't be told from a
 * vowel simply starting, so it would fire on every vowel after a pause (lips: see the camera).
 */
export function stopPlace(f: ConsonantFeatures): StopClass | null {
  const hf = (f.mid + f.high) / (f.low + 1e-20);
  if (hf <= 0.6) return null;
  return f.centroid > 4000 && f.high > f.mid ? "t" : "k";
}

/** In-place radix-2 FFT (length a power of two). */
function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let j = 0; j < len / 2; j++) {
        const a = i + j, b = a + len / 2;
        const tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr;
        im[b] = im[a] - ti;
        re[a] += tr;
        im[a] += ti;
        const t = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = t;
      }
    }
  }
}
