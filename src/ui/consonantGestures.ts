/**
 * Chimera's own articulation for the consonants the mic hears, as live gestures layered over the
 * vowel the mic is holding. Targets, strengths, ramps and speeds follow the speech planner
 * (crates/chimera/src/phonetics/inventory.rs and planner.rs oral_gestures_into), with the
 * fricatives' calibrated constriction for the current body; a hiss is open-ended (released by
 * its tag when the hiss ends), a stop is a quick closure and release with a puff of aspiration.
 */
import calibrated from "../../crates/chimera/src/phonetics/consonantTargets.generated.json";
import type { BodyMix, ControlKey, Gesture } from "../wasm/types.ts";
import { bodyWeights } from "./body.ts";
import type { HissClass, StopClass } from "../audio/consonants.ts";

type Targets = Partial<Record<ControlKey, number>>;

interface Def {
  /** the constriction itself: strength 40, owns these articulators */
  dom: Targets;
  /** support (a velar's jaw): weak */
  sec?: Targets;
  /** alveolars front the tongue body (the alveolar F2 locus) */
  alveolar?: boolean;
  /** the dorsum is heavy: slower releases */
  bodyOnly?: boolean;
}

const DEFS: Record<HissClass | StopClass, Def> = {
  s: { dom: { ttX: 6.3, ttY: 9.15, jaw: 0.3 }, alveolar: true },
  ʃ: { dom: { ttX: 5.7, ttY: 9.5, jaw: 0.35, lipProt: 0.75, lipWidth: 0.2 } },
  f: { dom: { labiodental: 1, lipAp: 0.05 } },
  t: { dom: { ttX: 6.25, ttY: 9.68 }, alveolar: true },
  k: { dom: { tbY: 8.35 }, sec: { jaw: 0.7 }, bodyOnly: true },
};

/** the velar's front-back place follows the vowel: its own tbX only weakly */
const VELAR_TBX = 2.3;
/** long enough to outlast any hiss; the hiss's end releases it by tag */
const OPEN_END = 30;

/** The calibrated constriction for this body (blended like the vowels). */
function forBody(ipa: HissClass | StopClass, body: BodyMix): Targets {
  const dom: Targets = { ...DEFS[ipa].dom };
  const table = calibrated as Record<string, Record<string, Record<string, number>>>;
  const acc: Record<string, { v: number; w: number }> = {};
  for (const [name, w] of bodyWeights(body)) {
    if (!(w > 0)) continue;
    for (const [k, v] of Object.entries(table[name]?.[ipa] ?? {})) {
      acc[k] ??= { v: 0, w: 0 };
      acc[k].v += v * w;
      acc[k].w += w;
    }
  }
  for (const [k, { v, w }] of Object.entries(acc)) if (w > 0) dom[k as ControlKey] = v / w;
  return dom;
}

const g = (t0: number, t1: number, rampIn: number, rampOut: number, strength: number, targets: Targets, extra: Partial<Gesture> = {}): Gesture => ({ t0, t1, rampIn, rampOut, strength, targets, ...extra });

/** A held hiss: the constriction and an open glottis (voiceless), until released by `tag`. */
export function hissGestures(ipa: HissClass, body: BodyMix, tag: number): Gesture[] {
  const d = DEFS[ipa];
  const out = [
    g(0, OPEN_END, 0.03, 0.018, 40, forBody(ipa, body), { speed: 1.3, releaseHold: 0.045, label: ipa, tag }),
    g(0, OPEN_END, 0.03, 0.03, 6, { abduction: 0.3 }, { label: "voiceless", tag }),
  ];
  if (d.alveolar) out.push(g(0, OPEN_END, 0.05, 0.05, 1.2, { tbX: 3.2, tbY: 7.4 }, { label: ipa, tag }));
  return out;
}

/** A stop: close quickly, hold briefly, release with aspiration (the vowel then returns). */
export function stopGestures(ipa: StopClass, body: BodyMix): Gesture[] {
  const d = DEFS[ipa];
  const hold = 0.035;
  // tip and lips release in ~18 ms, the dorsum slower (planner: body-only speed and ramps)
  const speed = d.bodyOnly ? 1 + (1.55 - 1) * 0.35 : 1.55;
  const out = [
    g(0, hold, 0.012, d.bodyOnly ? 0.03 : 0.018, 40, forBody(ipa, body), { speed, releaseHold: 0.045, label: ipa }),
    g(hold * 0.25, hold + 0.02, 0.035, 0.045, 6, { abduction: 0.3 }, { label: "aspiration" }),
  ];
  if (d.sec) out.push(g(0, hold, 0.05, 0.05, 2.2, d.sec, { label: ipa }));
  if (d.bodyOnly) out.push(g(0, hold, 0.05, 0.05, 0.25, { tbX: VELAR_TBX }, { label: ipa }));
  if (d.alveolar) out.push(g(0, hold, 0.05, 0.05, 1.2, { tbX: 3.2, tbY: 7.4 }, { label: ipa }));
  return out;
}
