/**
 * The duet: Play mode with two voices. Each voice then has its own head, body (the man / woman /
 * child triangle) and mouth (its own vowel sweep, or the mic), while the rest of the voice controls
 * (pitch handling, breath, tone, drive, reverb…) stay shared and both voices mix into the one
 * distortion and reverb. Voice 1 is the store's body and mouth, as always; voice 2's body lives
 * here and its mouth goes straight to its engine (AudioEngine.setVoice2Artic).
 */
import { create } from "zustand";
import { engine } from "../audio/AudioEngine.ts";
import { PRESETS, type BodyMix } from "./body.ts";
import { useStore } from "./store.ts";
import type { HumanArtic } from "../wasm/types.ts";

const KEY = "chimera-duet";

function load(): BodyMix {
  try {
    const raw = localStorage.getItem(KEY);
    const v = raw ? JSON.parse(raw) : {};
    return v.body2 && typeof v.body2.female === "number" ? v.body2 : PRESETS.female;
  } catch {
    return PRESETS.female;
  }
}

interface DuetState {
  /** voice 2's body (voice 1's is the store's) */
  body2: BodyMix;
  /** a drag in progress: shown, not yet rebuilt into the voice */
  preview2: BodyMix | null;
  setBody2: (b: BodyMix) => void;
  previewBody2: (b: BodyMix | null) => void;
}

export const useDuet = create<DuetState>((set) => {
  const body2 = load();
  engine.setVoice2Body(body2);
  return {
    body2,
    preview2: null,
    setBody2: (b) => {
      set({ body2: b, preview2: null });
      engine.setVoice2Body(b);
      try {
        localStorage.setItem(KEY, JSON.stringify({ body2: b }));
      } catch {
        // storage blocked: kept until reload
      }
    },
    previewBody2: (b) => set({ preview2: b }),
  };
});

/** Whether the duet is showing: Play mode with exactly two voices. */
export function duetOn(): boolean {
  const s = useStore.getState();
  return s.mode === "play" && s.polyphony === 2;
}

/** voice 2's latest articulation as sent (its head holds it when there's no telemetry yet) */
export const voice2Live: { artic: Partial<HumanArtic> } = { artic: {} };

/** Voice 2's mouth (the sweep or the mic call this once a frame). */
export function setVoice2Artic(values: Partial<HumanArtic>, tipFree = true): void {
  voice2Live.artic = { ...voice2Live.artic, ...values };
  engine.setVoice2Artic(values, tipFree);
}

// voice 2 has its own mouth exactly while the duet shows
engine.setOwnMouths(duetOn());
useStore.subscribe(() => engine.setOwnMouths(duetOn()));
