/**
 * Volume-envelope modulation: the envelope (the breath PT2's pressure gives after the touch curve,
 * 0..1, the same one the vowel sweep rides) moves the soft palate by a bipolar depth. The Throat
 * page's Soft palate dial stays the base; the modulated opening goes straight to the engine, so the
 * dial doesn't jump around. Play mode only. In the duet each voice follows its own envelope, and
 * voice 2 (whose mouth is its own there) gets the base too, so the dial reaches it.
 */
import { create } from "zustand";
import { engine } from "../audio/AudioEngine.ts";
import { mpeLive, useStore } from "./store.ts";
import { duetOn, setVoice2Artic } from "./duet.ts";
import { modVelum } from "./velumMod.ts";

const KEY = "chimera-env-mod";

function load(): number {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "{}");
    return typeof v.velum === "number" ? Math.max(-1, Math.min(1, v.velum)) : 0;
  } catch {
    return 0;
  }
}

interface EnvModState {
  /** soft palate depth, -1..1 (0 off) */
  velum: number;
  setVelum: (v: number) => void;
}

export const useEnvMod = create<EnvModState>((set) => ({
  velum: load(),
  setVelum: (v) => {
    const velum = Math.abs(v) < 0.01 ? 0 : Math.max(-1, Math.min(1, v));
    set({ velum });
    try {
      localStorage.setItem(KEY, JSON.stringify({ velum }));
    } catch {
      // storage blocked: kept until reload
    }
  },
}));

/** what each voice was last sent (null: not driven) */
const sent: (number | null)[] = [null, null];

function tick(): void {
  requestAnimationFrame(tick);
  const st = useStore.getState();
  const depth = useEnvMod.getState().velum;
  const play = st.mode === "play" && !!engine.ctx;
  const duet = play && duetOn();
  const base = st.artic.velum ?? 0;
  // voice 1 (and the voices that share its mouth): driven while the depth is on; back to the dial
  // once when it goes off
  if (play && depth !== 0) {
    const v = modVelum(base, depth, duet ? (mpeLive.breaths[0] ?? 0) : mpeLive.breath);
    // every frame: something else may have sent the dial's value since (coalesced, so cheap)
    engine.setArtic({ velum: v });
    sent[0] = v;
  } else if (sent[0] !== null) {
    if (play) engine.setArtic({ velum: base });
    sent[0] = null;
  }
  // voice 2 in the duet has its own mouth: it follows the dial, plus its own envelope
  if (duet) {
    const v = depth !== 0 ? modVelum(base, depth, mpeLive.breaths[1] ?? 0) : base;
    if (sent[1] === null || Math.abs(v - sent[1]) > 0.003) {
      setVoice2Artic({ velum: v });
      sent[1] = v;
    }
  } else sent[1] = null;
}

requestAnimationFrame(tick);
