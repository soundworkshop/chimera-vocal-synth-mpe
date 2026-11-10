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

function load(): { body2: BodyMix; linked: boolean } {
  try {
    const raw = localStorage.getItem(KEY);
    const v = raw ? JSON.parse(raw) : {};
    return { body2: v.body2 && typeof v.body2.female === "number" ? v.body2 : PRESETS.female, linked: v.linked === true };
  } catch {
    return { body2: PRESETS.female, linked: false };
  }
}

function persist(s: { body2: BodyMix; linked: boolean }): void {
  try {
    localStorage.setItem(KEY, JSON.stringify({ body2: s.body2, linked: s.linked }));
  } catch {
    // storage blocked: kept until reload
  }
}

interface DuetState {
  /** voice 2's body (voice 1's is the store's) */
  body2: BodyMix;
  /** a drag in progress: shown, not yet rebuilt into the voice */
  preview2: BodyMix | null;
  /**
   * Linked: the right voice takes the left one's settings (body, vowel sweep); either side's
   * controls then edit both. Each voice still follows its own pressure along the shared line.
   */
  linked: boolean;
  setBody2: (b: BodyMix) => void;
  previewBody2: (b: BodyMix | null) => void;
  setLinked: (on: boolean) => void;
}

export const useDuet = create<DuetState>((set, get) => {
  const saved = load();
  return {
    ...saved,
    preview2: null,
    setBody2: (b) => {
      set({ body2: b, preview2: null });
      if (!get().linked) engine.setVoice2Body(b);
      persist(get());
    },
    previewBody2: (b) => set({ preview2: b }),
    setLinked: (on) => {
      set({ linked: on });
      engine.setVoice2Body(voice2Body());
      persist(get());
    },
  };
});

/** The right voice's body now: the left one's while linked, else its own. */
export function voice2Body(): BodyMix {
  const d = useDuet.getState();
  return d.linked ? useStore.getState().body : d.body2;
}

/**
 * Whose settings a voice's controls show and edit: the right voice's are the left one's while
 * linked (0), else its own.
 */
export function settingsOf(voice: number): number {
  return voice === 1 && useDuet.getState().linked ? 0 : voice;
}

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

// voice 2 has its own mouth exactly while the duet shows; its body follows the left one's while
// linked
engine.setVoice2Body(voice2Body());
engine.setOwnMouths(duetOn());
let lastBody = useStore.getState().body;
useStore.subscribe((s) => {
  engine.setOwnMouths(duetOn());
  if (s.body !== lastBody) {
    lastBody = s.body;
    if (useDuet.getState().linked) engine.setVoice2Body(s.body);
  }
});
