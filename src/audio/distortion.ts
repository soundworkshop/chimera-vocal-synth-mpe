/**
 * Distortion before the reverb: drive into a soft clipper (tanh, a little lopsided at higher
 * drive so it adds even harmonics like a tube stage), a low-pass to tame the fizz, then a dry/wet
 * mix and an output level. Built from native Web Audio nodes (the WaveShaper oversamples 4×, so
 * high drive doesn't alias); this file only computes the shaping curve and the gains.
 */

/**
 * The clipper's character:
 * - soft: tanh, a little lopsided as drive rises (even harmonics, tube-like)
 * - hard: a straight line until it hits the rails (buzzy, odd harmonics)
 * - fold: a wavefolder (Buchla/Serge "West Coast"): past the rails the wave folds back instead
 *   of flattening, so turning Drive up sweeps bright, vocal overtones through the sound
 */
export type DistortionType = "soft" | "hard" | "fold";
export const DISTORTION_TYPES: { id: DistortionType; name: string }[] = [
  { id: "soft", name: "Soft" },
  { id: "hard", name: "Hard" },
  { id: "fold", name: "Fold" },
];

/** The knobs (each 0..1) and the type. */
export interface DistortionSettings {
  type: DistortionType;
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
export const DEFAULT_DISTORTION: DistortionSettings = { type: "soft", drive: 0, tone: 1, mix: 1, level: 0.5 };

const CURVE_POINTS = 4096;

/**
 * The gain into the curve: 0.1 at drive 0 (every type's straight middle: clean) to 63 at
 * drive 1 (soft, hard: well into the rails); the fold goes to ~5 folds instead. Soft's
 * lopsidedness grows with drive.
 */
const shape = (drive: number, type: DistortionType) => {
  const d = clamp01(drive);
  if (type === "fold") return { g: 0.1 * Math.pow(160, d), b: 0 };
  return { g: Math.pow(10, -1 + 2.8 * d), b: type === "soft" ? 0.25 * d : 0 };
};

/** the curve's value at input x (before normalising) */
function raw(x: number, g: number, b: number, type: DistortionType): number {
  if (type === "hard") return Math.max(-1, Math.min(1, g * x));
  if (type === "fold") return Math.sin(g * x);
  return Math.tanh(g * x + b) - Math.tanh(b);
}

/** what +1 maps to before normalising, so +1 → +1 (a fold past its first peak: its peak, 1) */
function norm(g: number, b: number, type: DistortionType): number {
  if (type === "fold") return g < Math.PI / 2 ? Math.sin(g) : 1;
  return raw(1, g, b, type);
}

/**
 * The WaveShaper curve over input -1..1, scaled so +1 maps to +1 (a fold: its peaks to ±1). At
 * drive 0 every type is a straight line to within half a percent.
 */
export function shapeCurve(drive: number, type: DistortionType = "soft", n = CURVE_POINTS): Float32Array<ArrayBuffer> {
  const { g, b } = shape(drive, type);
  const k = norm(g, b, type);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = raw((i / (n - 1)) * 2 - 1, g, b, type) / k;
  return out;
}

/**
 * Gain after the clipper that offsets part of the drive: quiet signals come out only as much
 * louder as the square root of the curve's gain at zero, so the Drive knob changes the character
 * more than the volume.
 */
export function driveMakeup(drive: number, type: DistortionType = "soft"): number {
  const { g, b } = shape(drive, type);
  const slope = type === "soft" ? g * (1 - Math.tanh(b) ** 2) : g;
  return 1 / Math.sqrt(Math.max(1, slope / norm(g, b, type)));
}

/** low-pass cutoff (Hz) for the tone knob, log from 700 Hz to 16 kHz */
export const toneHz = (tone: number): number => 700 * Math.pow(16000 / 700, clamp01(tone));

/** output gain for the level knob (0.5 = unity, 1 = +6 dB) */
export const levelGain = (level: number): number => 2 * clamp01(level);

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
