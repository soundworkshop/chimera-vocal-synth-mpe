/**
 * Vowel sweep: a line in vowel space (F1/F2) between two ends the performer drags on the Vowels
 * screen, and the vowel rides along it with the volume envelope: the breath PT2's pressure gives
 * after the touch curve (mpeLive.breath, 0..1). Quiet sits at end A, full at end B, in between in
 * proportion (straight in log Hz, as the map draws it). The mouth for each point comes from the
 * measured formant table (Chimera's own acoustics, English vowels). Play mode only; while on, it
 * owns the vowel (Mic words keeps its consonants).
 */
import { create } from "zustand";
import { engine } from "../audio/AudioEngine.ts";
import { NEUTRAL, restTip } from "../wasm/engine.ts";
import { mpeLive, useStore } from "./store.ts";
import { getModel } from "./useModel.ts";
import { formantTable } from "./formantTable.ts";
import { sweepPoint, type SweepEnd } from "./sweepPoint.ts";

export type { SweepEnd };

interface SweepState {
  on: boolean;
  /** quiet end */
  a: SweepEnd;
  /** loud end */
  b: SweepEnd;
  setOn: (on: boolean) => void;
  setEnd: (which: "a" | "b", e: SweepEnd) => void;
}

const KEY = "chimera-vowel-sweep";
/** "oo" opening to "ah" as it gets louder: the way a singer's mouth opens */
const DEFAULTS = { on: false, a: { F1: 340, F2: 900 }, b: { F1: 720, F2: 1250 } };

function load(): typeof DEFAULTS {
  try {
    const raw = localStorage.getItem(KEY);
    return { ...DEFAULTS, ...(raw ? JSON.parse(raw) : {}) };
  } catch {
    return { ...DEFAULTS };
  }
}

function save(s: SweepState): void {
  try {
    localStorage.setItem(KEY, JSON.stringify({ on: s.on, a: s.a, b: s.b }));
  } catch {
    // storage blocked: settings last until reload
  }
}

/** where the sweep is now (for the map's dot), or null when off or not playing */
export const sweepLive: { at: SweepEnd | null; t: number } = { at: null, t: 0 };

let raf = 0;
let last: SweepEnd | null = null;

function tick(): void {
  raf = requestAnimationFrame(tick);
  const s = useSweep.getState();
  const st = useStore.getState();
  const ctx = engine.ctx;
  if (!s.on || st.mode !== "play" || !ctx) return void (sweepLive.at = null);
  const model = getModel(st.body, ctx.sampleRate);
  const table = formantTable(model, { neutral: NEUTRAL, restTip });
  table.grow(3);
  if (!table.ready) return;
  const t = mpeLive.breath;
  const p = sweepPoint(s.a, s.b, t);
  sweepLive.at = p;
  sweepLive.t = t;
  // only when it moves (the articulators smooth the rest)
  if (last && Math.abs(Math.log(last.F1 / p.F1)) < 0.002 && Math.abs(Math.log(last.F2 / p.F2)) < 0.002) return;
  last = p;
  st.setArtic(table.lookup(p.F1, p.F2), true);
}

export const useSweep = create<SweepState>((set, get) => {
  const saved = load();
  if (saved.on) queueMicrotask(() => (raf = requestAnimationFrame(tick)));
  return {
    ...saved,
    setOn: (on) => {
      set({ on });
      save(get());
      cancelAnimationFrame(raf);
      last = null;
      if (on) raf = requestAnimationFrame(tick);
      else sweepLive.at = null;
    },
    setEnd: (which, e) => {
      set({ [which]: e } as Pick<SweepState, "a" | "b">);
      last = null;
      save(get());
    },
  };
});
