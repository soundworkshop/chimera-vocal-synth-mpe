/**
 * How an MPE controller's pressure (0..1) becomes breath (0..1 of the Breath knob). Below
 * `floor` it is silent (sensor noise at rest); at the floor the breath jumps to `start`, so the
 * lightest touch already reaches the voice's onset instead of sitting below the lungs' phonation
 * threshold; then it rises to the knob at full pressure, bent by `curve` (below 1: fast rise and a
 * long top; above 1: slow start).
 */
export interface TouchCurve {
  floor: number;
  start: number;
  curve: number;
}
export const DEFAULT_TOUCH: TouchCurve = { floor: 0.02, start: 0.4, curve: 1 };

export function touchToBreath(p: number, t: TouchCurve): number {
  if (!(p > t.floor)) return 0;
  const u = Math.min(1, (p - t.floor) / Math.max(1e-6, 1 - t.floor));
  return t.start + (1 - t.start) * Math.pow(u, t.curve);
}
