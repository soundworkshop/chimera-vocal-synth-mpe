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

test("two voices: each note keeps its voice, high-note priority when both are busy", async () => {
  const { assignSlots } = await import("../src/ui/voiceSlots.ts");
  let serial = 0;
  const v = (id: string, note: number) => ({ id, note, velocity: 100, bend: 0, pressure: 0.5, serial: ++serial });
  const slots: (string | null)[] = [null, null];
  const notes = (p: ReturnType<typeof assignSlots>) => p.map((x) => x?.note ?? null);
  const a = v("ch2", 60), b = v("ch3", 67);
  expect(notes(assignSlots(slots, [a]))).toEqual([60, null]);
  expect(notes(assignSlots(slots, [a, b]))).toEqual([60, 67]);
  // bends crossing don't swap voices
  const aUp = { ...a, note: 70 };
  expect(notes(assignSlots(slots, [aUp, b]))).toEqual([70, 67]);
  // a third, higher note takes the voice with the lowest note
  const c = v("ch4", 72);
  expect(notes(assignSlots(slots, [aUp, b, c]))).toEqual([70, 72]);
  // a third, lower note waits…
  const d = v("ch5", 50);
  expect(notes(assignSlots(slots, [aUp, c, d, b]))).toEqual([70, 72]);
  // …and takes the voice that lets go
  expect(notes(assignSlots(slots, [c, d, b]))).toEqual([67, 72]);
  expect(notes(assignSlots(slots, []))).toEqual([null, null]);
  // one voice: plain high-note priority, and the lower note returns on release
  const one: (string | null)[] = [null];
  expect(notes(assignSlots(one, [a]))).toEqual([60]);
  expect(notes(assignSlots(one, [a, b]))).toEqual([67]);
  expect(notes(assignSlots(one, [a]))).toEqual([60]);
});

/** a vowel: pulses (voiced, tilted −6 dB/oct like a real voice) or noise (whisper) through four resonances */
function synthVowel(F: number[], f0: number, sr: number, n = 2048, noiseSeed = 7): Float32Array {
  const len = n + 4000;
  let x = new Float64Array(len);
  let seed = noiseSeed;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
  for (let i = 0; i < len; i++) x[i] = f0 ? (i % Math.round(sr / f0) === 0 ? 1 : 0) : rnd() * 0.1;
  if (f0) for (let i = 0, y = 0; i < len; i++) x[i] = y = x[i] + 0.987 * y;
  [80, 100, 150, 200].forEach((bw, k) => {
    const r = Math.exp((-Math.PI * bw) / sr), c = 2 * r * Math.cos((2 * Math.PI * F[k]) / sr);
    const y = new Float64Array(len);
    for (let i = 0; i < len; i++) y[i] = x[i] + c * (i > 0 ? y[i - 1] : 0) - r * r * (i > 1 ? y[i - 2] : 0);
    x = y;
  });
  const tail = x.slice(len - n);
  const peak = tail.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
  return Float32Array.from(tail, (v) => (v / peak) * 0.3);
}

test("formant tracker: F1/F2 within 12% voiced (110, 220 Hz), 20% whispered", async () => {
  const { analyzeFormants } = await import("../src/audio/formants.ts");
  const vowels: number[][] = [[300, 2250, 3000, 3600], [730, 1100, 2450, 3500], [320, 870, 2250, 3400], [550, 1800, 2500, 3500], [480, 900, 2500, 3500]];
  for (const sr of [44100, 48000])
    for (const F of vowels)
      for (const f0 of [0, 110, 220]) {
        // a whisper's single frame is noisy: average a few (the app smooths over frames too)
        const runs = f0 ? [7] : [7, 11, 13, 17, 19, 23, 29, 31];
        const rs = runs.map((seed) => analyzeFormants(synthVowel(F, f0, sr, 2048, seed), sr));
        const r = { f1: rs.reduce((s, v) => s + v.f1, 0) / rs.length, f2: rs.reduce((s, v) => s + v.f2, 0) / rs.length };
        // a whispered "oo" reads F1 ~16% high (whispers do raise F1); it is a calibration vowel, so
        // the fit maps it back
        const tol = f0 ? 0.12 : 0.2;
        expect(Math.abs(r.f1 - F[0]) / F[0]).toBeLessThan(tol);
        expect(Math.abs(r.f2 - F[1]) / F[1]).toBeLessThan(tol);
      }
});

test("formant calibration: maps a speaker's corner vowels onto the model's", async () => {
  const { fitCalibration, applyCalibration } = await import("../src/audio/formants.ts");
  const model = [{ f1: 337, f2: 2225 }, { f1: 731, f2: 1337 }, { f1: 378, f2: 997 }];
  // a speaker 15% higher across the board
  const user = model.map((m) => ({ f1: m.f1 * 1.15, f2: m.f2 * 1.15 }));
  const c = fitCalibration(user, model);
  for (let i = 0; i < 3; i++) {
    const m = applyCalibration(user[i].f1, user[i].f2, c);
    expect(m.f1).toBeCloseTo(model[i].f1, 0);
    expect(m.f2).toBeCloseTo(model[i].f2, 0);
  }
});

test("voice gate: follows a word, ignores its fading end, the noise floor and a steady hum", async () => {
  const { VoiceGate } = await import("../src/audio/voiceGate.ts");
  const g = new VoiceGate();
  const dt = 1 / 60;
  const run = (db: number, seconds: number) => {
    const out: boolean[] = [];
    for (let t = 0; t < seconds; t += dt) out.push(g.update(db, dt, -60));
    return out;
  };
  // quiet room (above the -60 gate: an earbud mic's hiss)
  expect(run(-55, 1).some(Boolean)).toBe(false);
  // a word
  expect(run(-30, 0.5).every(Boolean)).toBe(true);
  // its end fading out: once 15 dB down, ignored
  const fade: boolean[] = [];
  for (let db = -30; db > -55; db -= 2.5) fade.push(g.update(db, dt, -60));
  expect(fade.slice(0, 3).every(Boolean)).toBe(true);
  expect(fade.slice(7).some(Boolean)).toBe(false);
  // back to the hiss: ignored
  expect(run(-55, 2).some(Boolean)).toBe(false);
  // a quieter next word still counts
  expect(run(-38, 0.5).every(Boolean)).toBe(true);
  // a steady hum that starts later is learnt within a few seconds
  const hum = run(-44, 6);
  expect(hum.slice(-60).some(Boolean)).toBe(false);
});

test("consonants: s, ʃ, f held as hiss, t and k bursts; no trigger on vowels, pauses or a vowel onset", async () => {
  const { ConsonantDetector } = await import("../src/audio/consonants.ts");
  const sr = 48000;
  let seed = 3;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
  const amp = (d: number) => Math.pow(10, d / 20);
  const norm = (x: Float64Array, d: number) => {
    const rms = Math.sqrt(x.reduce((s, v) => s + v * v, 0) / x.length);
    return x.map((v) => (v / rms) * amp(d));
  };
  const band = (n: number, lo: number, hi: number, d: number) => {
    const x = Float64Array.from({ length: n }, rnd), out = new Float64Array(n), c = Math.sqrt(lo * hi);
    for (const f of [c * 0.9, c * 1.1]) {
      const r = Math.exp((-Math.PI * (hi - lo)) / sr), k = 2 * r * Math.cos((2 * Math.PI * f) / sr);
      for (let i = 0, y1 = 0, y2 = 0; i < n; i++) {
        const y = x[i] + k * y1 - r * r * y2;
        (y2 = y1), (y1 = y), (out[i] += y);
      }
    }
    return norm(out, d);
  };
  const vowel = (n: number, d: number) => {
    let x = new Float64Array(n);
    for (let i = 0; i < n; i++) x[i] = i % 400 === 0 ? 1 : 0;
    for (let i = 0, y = 0; i < n; i++) x[i] = y = x[i] + 0.987 * y;
    [[730, 80], [1100, 100], [2450, 150]].forEach(([F, bw]) => {
      const r = Math.exp((-Math.PI * bw) / sr), c = 2 * r * Math.cos((2 * Math.PI * F) / sr), y = new Float64Array(n);
      for (let i = 0; i < n; i++) y[i] = x[i] + c * (i > 0 ? y[i - 1] : 0) - r * r * (i > 1 ? y[i - 2] : 0);
      x = y;
    });
    return norm(x, d);
  };
  const quiet = (n: number) => Float64Array.from({ length: n }, () => 0);
  const ms = (t: number) => Math.round((t * sr) / 1000);
  const parts = [
    quiet(ms(400)), vowel(ms(300), -28),
    band(ms(200), 4500, 9000, -36), vowel(ms(250), -28), // s
    band(ms(200), 2200, 4200, -36), vowel(ms(250), -28), // ʃ
    Float64Array.from({ length: ms(180) }, () => rnd() * amp(-52)), vowel(ms(250), -28), // f
    quiet(ms(70)), band(ms(8), 3500, 8000, -30), vowel(ms(250), -28), // t
    quiet(ms(70)), band(ms(10), 1700, 2800, -32), vowel(ms(250), -28), // k
    quiet(ms(500)), vowel(ms(300), -28), quiet(ms(400)), // a vowel after a pause: nothing
  ];
  const total = parts.reduce((s, x) => s + x.length, 0);
  const sig = new Float32Array(total);
  let off = 0;
  for (const x of parts) {
    sig.set(Float32Array.from(x, (v) => v + rnd() * amp(-68)), off);
    off += x.length;
  }
  const det = new ConsonantDetector();
  const got: string[] = [];
  for (let end = 2048; end <= total; end += 800)
    for (const e of det.update(sig.subarray(end - 2048, end), sr, 800 / sr, -50)) got.push(e.type === "hissEnd" ? "end" : `${e.type}:${e.ipa}`);
  expect(got).toEqual(["hissStart:s", "end", "hissStart:ʃ", "end", "hissStart:f", "end", "stop:t", "stop:k"]);
});

test("consonant gestures: a hiss owns its constriction until released, a stop closes and lets go", async () => {
  const { hissGestures, stopGestures } = await import("../src/ui/consonantGestures.ts");
  const male = { female: 0, child: 0 };
  const s = hissGestures("s", male, 1_000_001);
  expect(s.every((g) => g.tag === 1_000_001)).toBe(true);
  const main = s.find((g) => g.label === "s" && g.strength === 40)!;
  expect(main.targets.ttY).toBeCloseTo(9.111, 3); // the body's calibrated constriction
  expect(s.some((g) => g.targets.abduction! > 0)).toBe(true); // voiceless
  const f = hissGestures("f", { female: 1, child: 0 }, 1_000_002).find((g) => g.strength === 40)!;
  expect(f.targets.lipAp).toBeCloseTo(0.013, 3);
  const t = stopGestures("t", male);
  const close = t.find((g) => g.strength === 40)!;
  expect(close.targets.ttY).toBeCloseTo(9.68, 2);
  expect(close.t1).toBeLessThan(0.06);
  expect(t.every((g) => g.tag === undefined)).toBe(true);
  const k = stopGestures("k", male).find((g) => g.strength === 40)!;
  expect(k.targets.tbY).toBeCloseTo(8.35, 2);
});

test("formant follower: continuity, outliers, quiet edges and fresh starts", async () => {
  const { FormantFollower, pickFormants } = await import("../src/audio/formants.ts");
  const fr = (...fs: number[]) => ({ f1: 0, f2: 0, db: -30, candidates: fs.map((f) => ({ f, bw: 80 })) });
  // a stray resonance between F1 and F2: the lowest-pick takes it, continuity doesn't
  expect(pickFormants(fr(700, 900, 1150).candidates, 0, 0).f2).toBe(900);
  expect(pickFormants(fr(700, 900, 1150).candidates, 700, 1150).f2).toBe(1150);

  const dt = 1 / 60, tau = 0.03;
  const f = new FormantFollower();
  // a phrase starts: an onset frame of junk, then two that agree → straight to "ah"
  expect(f.update(fr(400, 2600), true, 0.3, dt, tau)).toBe(null);
  expect(f.update(fr(730, 1100), true, 1, dt, tau)).toBe(null);
  const start = f.update(fr(735, 1105), true, 1, dt, tau)!;
  expect(start.f1).toBeCloseTo(732, -1);
  // one wild frame (F2 jumps to F3) barely moves it: the median of three
  for (let i = 0; i < 5; i++) f.update(fr(730, 1100), true, 1, dt, tau);
  const before = f.update(fr(730, 1100), true, 1, dt, tau)!;
  const wild = f.update(fr(730, 2450), true, 1, dt, tau)!;
  expect(Math.abs(Math.log(wild.f2 / before.f2))).toBeLessThan(0.01);
  // quiet frames (a fading edge) toward "ee" move it far less than full-voice ones
  const g = new FormantFollower(), h = new FormantFollower();
  for (const x of [g, h]) for (let i = 0; i < 4; i++) x.update(fr(730, 1100), true, 1, dt, tau);
  let quiet = { f1: 0, f2: 0 }, loud = { f1: 0, f2: 0 };
  for (let i = 0; i < 3; i++) (quiet = g.update(fr(320, 2250), true, 0.1, dt, tau)!), (loud = h.update(fr(320, 2250), true, 1, dt, tau)!);
  expect(Math.log(quiet.f2 / 1100)).toBeLessThan(Math.log(loud.f2 / 1100) / 3);
  // after a pause, the next phrase jumps rather than gliding from the old vowel
  for (let i = 0; i < 15; i++) h.update(fr(0), false, 0, dt, tau);
  h.update(fr(320, 2250), true, 1, dt, tau);
  const next = h.update(fr(325, 2240), true, 1, dt, tau)!;
  expect(next.f2).toBeGreaterThan(2200);
});
