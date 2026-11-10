/**
 * Plate reverb: a port of Mutable Instruments' Rings/Clouds reverb (Émilie Gillet, MIT licence;
 * notice below). The Griesinger topology from Dattorro's paper: four allpass diffusers on the
 * input, then a loop of two branches, each 2 allpasses + a long delay that feeds the other
 * branch, with slow LFOs on the long delays for a gentle chorus.
 *
 * As in MI's FxEngine, every delay line lives in one circular buffer whose write pointer moves
 * back one slot per sample: reading a line at offset k gives what it was written k samples ago.
 * Lengths are MI's (at 48 kHz), scaled to the context's rate. Pure DSP, no Web Audio, so it can
 * be tested outside an AudioWorklet.
 *
 * Copyright 2014 Emilie Gillet. Permission is hereby granted, free of charge, to any person
 * obtaining a copy of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights to use, copy,
 * modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to
 * permit persons to whom the Software is furnished to do so, subject to the following conditions:
 * The above copyright notice and this permission notice shall be included in all copies or
 * substantial portions of the Software. THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY
 * KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR
 * COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF
 * CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE
 * OR OTHER DEALINGS IN THE SOFTWARE.
 */

/** The four knobs, each 0..1. */
export interface ReverbSettings {
  /** dry/wet crossfade */
  mix: number;
  /** decay: the loop's gain, 0.35..0.98 (MI Clouds' range) */
  time: number;
  /** damping in the loop: 0 dark … 1 bright */
  tone: number;
  /** allpass coefficient, 0.4..0.75 (MI: 0.625) */
  diffusion: number;
}

export const DEFAULT_REVERB: ReverbSettings = { mix: 0.25, time: 0.55, tone: 0.55, diffusion: 0.6 };

/** MI's line lengths at 48 kHz: ap1..ap4, dap1a, dap1b, del1, dap2a, dap2b, del2 */
const LENGTHS = [150, 214, 319, 527, 2182, 2690, 4501, 2525, 2197, 6312];
/** MI's modulated taps into del2 and del1 (centre, depth in samples at 48 kHz) */
const TAP2 = [6261, 50], TAP1 = [4460, 40];
const INPUT_GAIN = 0.2;
/** MI updates its LFOs every 32 samples */
const LFO_EVERY = 32;

export class PlateReverb {
  private buf: Float32Array;
  private mask: number;
  private wp = 0;
  /** each line's base offset and tail (length - 1) */
  private base: number[] = [];
  private tail: number[] = [];
  private tap1: number[];
  private tap2: number[];
  private lp1 = 0;
  private lp2 = 0;
  private lfo1 = 0;
  private lfo2 = 0;
  private phase1 = 0;
  private phase2 = 0;
  private dPhase1: number;
  private dPhase2: number;
  private n = 0;

  constructor(sampleRate: number) {
    const k = sampleRate / 48000;
    let total = 0;
    for (const l of LENGTHS) {
      const len = Math.max(2, Math.round(l * k));
      this.base.push(total);
      this.tail.push(len - 1);
      total += len + 1;
    }
    let size = 1;
    while (size < total) size <<= 1;
    this.buf = new Float32Array(size);
    this.mask = size - 1;
    // keep the modulated taps inside their lines (the +1 reads the next sample)
    const fit = (t: number[], line: number) => {
      const depth = t[1] * k;
      return [Math.min(t[0] * k, this.tail[line] - depth - 1), depth];
    };
    this.tap2 = fit(TAP2, 9);
    this.tap1 = fit(TAP1, 6);
    // MI: 0.5 Hz and 0.3 Hz, read once per LFO_EVERY samples
    this.dPhase1 = (2 * Math.PI * 0.5 * LFO_EVERY) / sampleRate;
    this.dPhase2 = (2 * Math.PI * 0.3 * LFO_EVERY) / sampleRate;
  }

  /** Clear the tail (e.g. after a long silence or a glitch). */
  reset(): void {
    this.buf.fill(0);
    this.lp1 = this.lp2 = 0;
  }

  /**
   * In place: left/right hold the dry signal and come back mixed. Mono input: pass the same
   * array as both (it comes back as the left channel's mix).
   */
  process(left: Float32Array, right: Float32Array, s: ReverbSettings): void {
    const buf = this.buf, mask = this.mask, base = this.base, tail = this.tail;
    const kap = 0.4 + 0.35 * clamp01(s.diffusion);
    const krt = 0.35 + 0.63 * clamp01(s.time);
    const klp = 0.3 + 0.6 * clamp01(s.tone);
    const amount = clamp01(s.mix);
    const [c2, d2] = this.tap2, [c1, d1] = this.tap1;
    let lp1 = this.lp1, lp2 = this.lp2, wp = this.wp;
    const at = (line: number, offset: number) => (wp + base[line] + offset) & mask;
    for (let i = 0; i < left.length; i++) {
      wp = (wp - 1) & mask;
      if ((this.n++ & (LFO_EVERY - 1)) === 0) {
        this.phase1 += this.dPhase1;
        this.phase2 += this.dPhase2;
        if (this.phase1 > 2 * Math.PI) this.phase1 -= 2 * Math.PI;
        if (this.phase2 > 2 * Math.PI) this.phase2 -= 2 * Math.PI;
        this.lfo1 = 0.5 + 0.5 * Math.cos(this.phase1);
        this.lfo2 = 0.5 + 0.5 * Math.cos(this.phase2);
      }
      const dryL = left[i], dryR = right[i];
      let acc = (dryL + (right === left ? dryL : dryR)) * INPUT_GAIN;
      // four input diffusers: read the tail, write acc, then acc = -kap·acc + tail
      for (let line = 0; line < 4; line++) {
        const r = buf[at(line, tail[line])];
        acc += r * kap;
        buf[at(line, 0)] = acc;
        acc = acc * -kap + r;
      }
      const apout = acc;

      // branch 1: del2's modulated tap, damping, two allpasses, into del1
      acc = apout + interp(buf, mask, wp + base[9], c2 + d2 * this.lfo2) * krt;
      lp1 += klp * (acc - lp1);
      acc = lp1;
      let r = buf[at(4, tail[4])];
      acc += r * -kap;
      buf[at(4, 0)] = acc;
      acc = acc * kap + r;
      r = buf[at(5, tail[5])];
      acc += r * kap;
      buf[at(5, 0)] = acc;
      acc = acc * -kap + r;
      buf[at(6, 0)] = acc;
      const wetL = acc * 2;

      // branch 2: del1's modulated tap, damping, two allpasses, into del2
      acc = apout + interp(buf, mask, wp + base[6], c1 + d1 * this.lfo1) * krt;
      lp2 += klp * (acc - lp2);
      acc = lp2;
      r = buf[at(7, tail[7])];
      acc += r * kap;
      buf[at(7, 0)] = acc;
      acc = acc * -kap + r;
      r = buf[at(8, tail[8])];
      acc += r * -kap;
      buf[at(8, 0)] = acc;
      acc = acc * kap + r;
      buf[at(9, 0)] = acc;
      const wetR = acc * 2;

      left[i] = dryL + (wetL - dryL) * amount;
      if (right !== left) right[i] = dryR + (wetR - dryR) * amount;
    }
    // a silent tail stays exactly silent (no denormal crawl)
    this.lp1 = Math.abs(lp1) < 1e-20 ? 0 : lp1;
    this.lp2 = Math.abs(lp2) < 1e-20 ? 0 : lp2;
    this.wp = wp;
  }
}

function interp(buf: Float32Array, mask: number, start: number, offset: number): number {
  const i = Math.floor(offset), f = offset - i;
  const a = buf[(start + i) & mask], b = buf[(start + i + 1) & mask];
  return a + (b - a) * f;
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
