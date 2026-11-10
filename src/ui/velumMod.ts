/** The soft palate's range (cm²; at or below 0 it is shut), as on the Throat page. */
export const VELUM_MIN = -0.25;
export const VELUM_MAX = 1.2;

/** A voice's soft palate at the quiet and the loud end of the volume envelope. */
export interface NosePair {
  quiet: number;
  loud: number;
}

/** The opening at envelope t (0 quiet … 1 full): straight between the ends, inside the range. */
export function noseAt(p: NosePair, t: number): number {
  const e = Math.min(1, Math.max(0, t));
  const v = p.quiet + (p.loud - p.quiet) * e;
  return Math.min(VELUM_MAX, Math.max(VELUM_MIN, v));
}
