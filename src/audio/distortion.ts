/**
 * Distortion before the reverb: drive into a soft clipper (tanh, a little lopsided at higher
 * drive so it adds even harmonics like a tube stage), a low-pass to tame the fizz, then a dry/wet
 * mix and an output level. Built from native Web Audio nodes (the WaveShaper oversamples 4×, so
 * high drive doesn't alias); this file only computes the shaping curve and the gains.
 */

/** The four knobs, each 0..1. */
export interface DistortionSettings {
  /** 0: clean … 1: heavy */
  drive: number;
  /** low-pass after the clipper: 0 dark (700 Hz) … 1 open (16 kHz) */
  tone: number;
  /** dry/wet crossfade */
  mix: number;
  /** output level: 0.5 = unity, 0 silent, 1 = +6 dB */
  level: number;
}

/** transparent: drive 0 is a straight line, the tone filter fully open */
export const DEFAULT_DISTORTION: DistortionSettings = { drive: 0, tone: 1, mix: 1, level: 0.5 };

const CURVE_POINTS = 4096;

/**
 * Gain into the tanh: 0.1 at drive 0 (the tanh's straight middle: clean) to 63 at drive 1 (hard
 * saturation), and the lopsidedness, which grows with drive.
 */
const shape = (drive: number) => {
  const d = clamp01(drive);
  return { g: Math.pow(10, -1 + 2.8 * d), b: 0.25 * d };
};

/**
 * The WaveShaper curve over input -1..1, scaled so +1 maps to +1. At drive 0 it is a straight
 * line to within half a percent.
 */
export function shapeCurve(drive: number, n = CURVE_POINTS): Float32Array<ArrayBuffer> {
  const { g, b } = shape(drive);
  const norm = Math.tanh(g + b) - Math.tanh(b);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    out[i] = (Math.tanh(g * x + b) - Math.tanh(b)) / norm;
  }
  return out;
}

/**
 * Gain after the clipper that offsets part of the drive: quiet signals come out only as much
 * louder as the square root of the curve's gain, and loud (clipped) ones a little quieter, so the
 * Drive knob changes the character more than the volume.
 */
export function driveMakeup(drive: number): number {
  const { g, b } = shape(drive);
  const slope0 = (g * (1 - Math.tanh(b) ** 2)) / (Math.tanh(g + b) - Math.tanh(b));
  return 1 / Math.sqrt(Math.max(1, slope0));
}

/** low-pass cutoff (Hz) for the tone knob, log from 700 Hz to 16 kHz */
export const toneHz = (tone: number): number => 700 * Math.pow(16000 / 700, clamp01(tone));

/** output gain for the level knob (0.5 = unity, 1 = +6 dB) */
export const levelGain = (level: number): number => 2 * clamp01(level);

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
