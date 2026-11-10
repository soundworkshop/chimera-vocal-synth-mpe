/** The soft palate's range on the Throat page (cm²; at or below 0 it is shut). */
export const VELUM_MIN = -0.25;
export const VELUM_MAX = 1.2;

/**
 * The soft palate opening with the volume envelope's modulation: the dial's setting plus
 * depth × envelope, where depth ±1 sweeps the whole range. Positive depth opens the nose as the
 * voice gets louder, negative closes it.
 */
export function modVelum(base: number, depth: number, env: number): number {
  const e = Math.min(1, Math.max(0, env));
  const v = base + depth * e * (VELUM_MAX - VELUM_MIN);
  return Math.min(VELUM_MAX, Math.max(VELUM_MIN, v));
}
