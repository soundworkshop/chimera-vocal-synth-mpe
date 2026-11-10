/**
 * MPE input, the touch curve and the plate reverb: plain TypeScript, no wasm needed.
 */
import { expect, test } from "bun:test";
import { connectMidi, type MpeVoice } from "../src/ui/midi.ts";
import { DEFAULT_TOUCH, touchToBreath } from "../src/ui/touch.ts";
import { PlateReverb } from "../src/audio/plateReverb.ts";

test("MPE: per-channel bend (with RPN range), pressure, and every held note reported", async () => {
  let send: (d: number[]) => void = () => {};
  const g = globalThis as unknown as { navigator: unknown };
  const before = g.navigator;
  g.navigator = {
    requestMIDIAccess: async () => {
      const input = { id: "pt2", name: "PT2", state: "connected", onmidimessage: null as null | ((e: { data: Uint8Array }) => void) };
      send = (d) => input.onmidimessage?.({ data: new Uint8Array(d) });
      return { inputs: new Map([["pt2", input]]), onstatechange: null };
    },
  };
  try {
    let last: MpeVoice[] = [];
    let sends = false;
    const ons: number[] = [];
    await connectMidi({ noteOn: (n) => ons.push(n), noteOff: () => {}, inputs: () => {}, expression: (v, s) => ((last = v), (sends = s)) });
    send([0xe1, 0, 0x40]);
    send([0x91, 60, 100]);
    expect(last[0].note).toBe(60);
    expect(last[0].pressure).toBe(null);
    send([0xd1, 127]);
    expect(last[0].pressure).toBe(1);
    expect(sends).toBe(true);
    send([0xe1, 0x7f, 0x7f]);
    expect(last[0].bend).toBeCloseTo((48 * 8191) / 8192, 3);
    send([0xb1, 101, 0]);
    send([0xb1, 100, 0]);
    send([0xb1, 6, 2]);
    send([0xe1, 0, 0x60]);
    expect(last[0].bend).toBeCloseTo(1, 3);
    send([0x92, 67, 90]);
    send([0xd2, 64]);
    const top = last.reduce((a, b) => (b.note > a.note ? b : a));
    expect(top.note).toBe(67);
    expect(top.pressure).toBeCloseTo(64 / 127, 5);
    send([0x82, 67, 0]);
    expect(last.map((v) => v.note)).toEqual([60]);
    send([0x81, 60, 0]);
    expect(last).toEqual([]);
    expect(ons).toEqual([60, 67]);
  } finally {
    g.navigator = before;
  }
});

test("touch curve: silent below the floor, jumps to start, reaches the knob, monotonic", () => {
  const t = { ...DEFAULT_TOUCH, floor: 0.05, start: 0.4, curve: 1.7 };
  expect(touchToBreath(0, t)).toBe(0);
  expect(touchToBreath(0.05, t)).toBe(0);
  expect(touchToBreath(0.051, t)).toBeCloseTo(0.4, 2);
  expect(touchToBreath(1, t)).toBeCloseTo(1, 6);
  let prev = 0;
  for (let p = 0; p <= 1; p += 0.01) {
    const b = touchToBreath(p, t);
    expect(b).toBeGreaterThanOrEqual(prev);
    prev = b;
  }
});

/** a 2 s impulse response (block by block, as the worklet runs it) */
function impulse(sr: number, s: { mix: number; time: number; tone: number; diffusion: number }) {
  const rv = new PlateReverb(sr);
  const n = Math.ceil((sr * 2) / 128) * 128, outL = new Float32Array(n), outR = new Float32Array(n);
  for (let i = 0; i < n; i += 128) {
    const l = new Float32Array(128), r = new Float32Array(128);
    if (i === 0) l[0] = r[0] = 1;
    rv.process(l, r, s);
    outL.set(l, i);
    outR.set(r, i);
  }
  return { outL, outR };
}
const rms = (a: Float32Array, from: number, to: number) => Math.sqrt(a.slice(from, to).reduce((s, v) => s + v * v, 0) / (to - from));

test("plate reverb: dry at mix 0, a decaying stereo tail, stable at full decay", () => {
  const sr = 48000;
  const dry = impulse(sr, { mix: 0, time: 1, tone: 1, diffusion: 1 });
  expect(dry.outL[0]).toBe(1);
  expect(rms(dry.outL, 1, dry.outL.length)).toBe(0);

  const wet = impulse(sr, { mix: 1, time: 0.55, tone: 0.55, diffusion: 0.6 });
  const early = rms(wet.outL, 0, sr / 4), late = rms(wet.outL, sr + sr / 2, 2 * sr);
  expect(early).toBeGreaterThan(1e-4);
  expect(late).toBeLessThan(early / 10);
  // the two branches differ (stereo, not a copy)
  expect(Math.abs(wet.outL[sr / 4] - wet.outR[sr / 4])).toBeGreaterThan(0);

  const long = impulse(44100, { mix: 1, time: 1, tone: 1, diffusion: 1 });
  for (const v of long.outL) expect(Number.isFinite(v)).toBe(true);
  expect(rms(long.outL, 44100 + 22050, 88200)).toBeLessThan(rms(long.outL, 0, 22050));
});

test("distortion: clean at drive 0, saturating and lopsided at full drive, level kept in check", async () => {
  const { shapeCurve, driveMakeup, DEFAULT_DISTORTION } = await import("../src/audio/distortion.ts");
  const at = (c: Float32Array, x: number) => c[Math.round(((x + 1) / 2) * (c.length - 1))];
  const clean = shapeCurve(0);
  for (const x of [-1, -0.5, -0.1, 0.1, 0.5, 1]) expect(Math.abs(at(clean, x) - x)).toBeLessThan(0.005 + 0.001);
  expect(driveMakeup(0)).toBeCloseTo(1, 2);
  expect(DEFAULT_DISTORTION.drive).toBe(0);
  const hot = shapeCurve(1);
  expect(at(hot, 1)).toBeCloseTo(1, 5);
  expect(at(hot, 0.3)).toBeGreaterThan(0.95); // saturated well before full scale
  expect(Math.abs(at(hot, -1))).not.toBeCloseTo(1, 2); // lopsided: even harmonics
  for (let i = 1; i < hot.length; i++) expect(hot[i]).toBeGreaterThanOrEqual(hot[i - 1]);
  // a typical voice peak (0.2) comes out within about ±6 dB of where it went in
  const out = at(hot, 0.2) * driveMakeup(1);
  expect(out).toBeGreaterThan(0.1);
  expect(out).toBeLessThan(0.4);
});
