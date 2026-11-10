/**
 * Vowel sweep: a line in vowel space (F1/F2) between two ends the performer drags on a Vowels
 * screen, and the vowel rides along it with the volume envelope: the breath PT2's pressure gives
 * after the touch curve (0..1). Quiet sits at end A, full at end B, in between in proportion
 * (straight in log Hz, as the map draws it). The mouth for each point comes from the measured
 * formant table (Chimera's own acoustics, English vowels). Play mode only; while on, it owns its
 * voice's vowel (Mic words keeps its consonants).
 *
 * One sweep per voice. Voice 1's follows the louder voice's breath (as before: with two voices
 * sharing a mouth) or, in the duet, its own; voice 2's exists in the duet only, follows voice 2's
 * breath, and moves voice 2's own mouth.
 */
import { create } from "zustand";
import { engine } from "../audio/AudioEngine.ts";
import { NEUTRAL, restTip } from "../wasm/engine.ts";
import { mpeLive, useStore } from "./store.ts";
import { getModel } from "./useModel.ts";
import { formantTable } from "./formantTable.ts";
import { sweepPoint, type SweepEnd } from "./sweepPoint.ts";
import { duetOn, setVoice2Artic, settingsOf, voice2Body } from "./duet.ts";

export type { SweepEnd };

export interface Sweep {
  on: boolean;
  /** quiet end */
  a: SweepEnd;
  /** loud end */
  b: SweepEnd;
}

interface SweepState {
  /** [voice 1, voice 2] */
  voices: [Sweep, Sweep];
  setOn: (voice: number, on: boolean) => void;
  setEnd: (voice: number, which: "a" | "b", e: SweepEnd) => void;
}

const KEY = "chimera-vowel-sweep";
/** "oo" opening to "ah" as it gets louder: the way a singer's mouth opens */
const DEFAULT: Sweep = { on: false, a: { F1: 340, F2: 900 }, b: { F1: 720, F2: 1250 } };

function load(): [Sweep, Sweep] {
  try {
    const raw = localStorage.getItem(KEY);
    const v = raw ? JSON.parse(raw) : {};
    // one sweep saved before the duet: it is voice 1's, and voice 2 starts as its copy
    if (!Array.isArray(v.voices)) {
      const one = { ...DEFAULT, ...v };
      return [one, { ...one }];
    }
    return [{ ...DEFAULT, ...v.voices[0] }, { ...DEFAULT, ...v.voices[1] }];
  } catch {
    return [{ ...DEFAULT }, { ...DEFAULT }];
  }
}

function save(voices: [Sweep, Sweep]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify({ voices }));
  } catch {
    // storage blocked: settings last until reload
  }
}

/** where each voice's sweep is now (for the maps' dots), null when off or not playing */
export const sweepLive: { at: SweepEnd | null; t: number }[] = [
  { at: null, t: 0 },
  { at: null, t: 0 },
];

let raf = 0;
const last: (SweepEnd | null)[] = [null, null];

function tick(): void {
  raf = requestAnimationFrame(tick);
  const s = useSweep.getState();
  const st = useStore.getState();
  const ctx = engine.ctx;
  const duet = duetOn();
  for (let i = 0; i < 2; i++) {
    // the right voice uses the left one's sweep while linked
    const sw = s.voices[settingsOf(i)];
    if (!sw.on || st.mode !== "play" || !ctx || (i === 1 && !duet)) {
      sweepLive[i].at = null;
      continue;
    }
    const body = i === 0 ? st.body : voice2Body();
    const table = formantTable(getModel(body, ctx.sampleRate), { neutral: NEUTRAL, restTip });
    table.grow(3);
    if (!table.ready) continue;
    const t = duet ? (mpeLive.breaths[i] ?? 0) : mpeLive.breath;
    const p = sweepPoint(sw.a, sw.b, t);
    sweepLive[i].at = p;
    sweepLive[i].t = t;
    // only when it moves (the articulators smooth the rest)
    const l = last[i];
    if (l && Math.abs(Math.log(l.F1 / p.F1)) < 0.002 && Math.abs(Math.log(l.F2 / p.F2)) < 0.002) continue;
    last[i] = p;
    const artic = table.lookup(p.F1, p.F2);
    if (i === 0) st.setArtic(artic, true);
    else setVoice2Artic(artic, true);
  }
}

/** Whether a voice's sweep owns its vowel right now (Mic words then leaves that voice alone). */
export function sweepOwns(voice: number): boolean {
  const sw = useSweep.getState().voices[settingsOf(voice)];
  return !!sw?.on && (voice === 0 || duetOn());
}

export const useSweep = create<SweepState>((set, get) => {
  const voices = load();
  queueMicrotask(() => (raf = requestAnimationFrame(tick)));
  return {
    voices,
    setOn: (voice, on) => {
      const v = [...get().voices] as [Sweep, Sweep];
      v[voice] = { ...v[voice], on };
      set({ voices: v });
      save(v);
      last[voice] = null;
      if (!on) sweepLive[voice].at = null;
      if (!raf) raf = requestAnimationFrame(tick);
    },
    setEnd: (voice, which, e) => {
      const v = [...get().voices] as [Sweep, Sweep];
      v[voice] = { ...v[voice], [which]: e };
      set({ voices: v });
      last[voice] = null;
      save(v);
    },
  };
});
