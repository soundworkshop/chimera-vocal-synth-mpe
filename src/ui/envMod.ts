/**
 * The soft palate under the volume envelope: each voice has a quiet end and a loud end (the two
 * sliders on the left of its Vowels map), and the envelope (the breath PT2's pressure gives after
 * the touch curve, 0..1, the one the vowel sweep rides) places the opening between them. Ends
 * equal: a fixed opening. Play mode only.
 *
 * In the duet each voice has its own pair and follows its own envelope; linked, the right voice
 * uses the left one's pair. Elsewhere voice 1's pair moves every voice (they share its mouth).
 * The Throat page's Soft palate dial sets both of voice 1's ends at once.
 */
import { create } from "zustand";
import { engine } from "../audio/AudioEngine.ts";
import { NEUTRAL } from "../wasm/engine.ts";
import { mpeLive, useStore } from "./store.ts";
import { duetOn, setVoice2Artic, settingsOf } from "./duet.ts";
import { noseAt, VELUM_MAX, VELUM_MIN, type NosePair } from "./velumMod.ts";

export type { NosePair };

const KEY = "chimera-nose";

const clamp = (v: number) => Math.min(VELUM_MAX, Math.max(VELUM_MIN, v));

function load(): [NosePair, NosePair] {
  const flat = (): NosePair => ({ quiet: NEUTRAL.velum, loud: NEUTRAL.velum });
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "{}");
    const ok = (p: unknown): p is NosePair => !!p && typeof (p as NosePair).quiet === "number" && typeof (p as NosePair).loud === "number";
    return Array.isArray(v.voices) ? [ok(v.voices[0]) ? v.voices[0] : flat(), ok(v.voices[1]) ? v.voices[1] : flat()] : [flat(), flat()];
  } catch {
    return [flat(), flat()];
  }
}

interface NoseState {
  /** [voice 1, voice 2] */
  voices: [NosePair, NosePair];
  setEnd: (voice: number, which: keyof NosePair, v: number) => void;
  /** both ends (a fixed opening) */
  setBoth: (voice: number, v: number) => void;
}

export const useNose = create<NoseState>((set, get) => {
  const put = (voice: number, p: NosePair) => {
    const voices = [...get().voices] as [NosePair, NosePair];
    voices[voice] = p;
    set({ voices });
    try {
      localStorage.setItem(KEY, JSON.stringify({ voices }));
    } catch {
      // storage blocked: kept until reload
    }
  };
  return {
    voices: load(),
    setEnd: (voice, which, v) => put(voice, { ...get().voices[voice], [which]: clamp(v) }),
    setBoth: (voice, v) => put(voice, { quiet: clamp(v), loud: clamp(v) }),
  };
});

/** where each voice's opening is now, for the sliders' dot (null when not in Play) */
export const noseLive: { t: number; v: number | null }[] = [
  { t: 0, v: null },
  { t: 0, v: null },
];

let wasPlay = false;

function tick(): void {
  requestAnimationFrame(tick);
  const st = useStore.getState();
  const play = st.mode === "play" && !!engine.ctx;
  const duet = play && duetOn();
  const pairs = useNose.getState().voices;
  if (!play) {
    // back to the store's posture once on leaving Play
    if (wasPlay && engine.ctx) engine.setArtic({ velum: st.artic.velum });
    wasPlay = false;
    noseLive[0].v = noseLive[1].v = null;
    return;
  }
  wasPlay = true;
  const t0 = duet ? (mpeLive.breaths[0] ?? 0) : mpeLive.breath;
  const v0 = noseAt(pairs[0], t0);
  noseLive[0].t = t0;
  noseLive[0].v = v0;
  // every frame: something else (a posture, a preset) may have sent another opening since; the
  // engine coalesces it with the frame's other changes
  engine.setArtic({ velum: v0 });
  if (duet) {
    const t1 = mpeLive.breaths[1] ?? 0;
    const v1 = noseAt(pairs[settingsOf(1)], t1);
    noseLive[1].t = t1;
    noseLive[1].v = v1;
    setVoice2Artic({ velum: v1 });
  } else {
    noseLive[1].v = null;
  }
}

requestAnimationFrame(tick);
