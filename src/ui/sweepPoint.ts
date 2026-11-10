/** An end of the vowel sweep's line (Hz). */
export interface SweepEnd {
  F1: number;
  F2: number;
}

/** The point at envelope `t` (0 quiet … 1 loud, clamped): straight between the ends in log Hz. */
export function sweepPoint(a: SweepEnd, b: SweepEnd, t: number): SweepEnd {
  const u = Math.min(1, Math.max(0, t));
  return { F1: Math.exp(Math.log(a.F1) + u * (Math.log(b.F1) - Math.log(a.F1))), F2: Math.exp(Math.log(a.F2) + u * (Math.log(b.F2) - Math.log(a.F2))) };
}
