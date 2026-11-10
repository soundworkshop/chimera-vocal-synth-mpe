/**
 * Chimera's own articulation for the consonants the mic hears, as live gestures layered over the
 * vowel the mic is holding. Targets, strengths, ramps and speeds follow the speech planner
 * (crates/chimera/src/phonetics/inventory.rs and planner.rs oral_gestures_into), with the
 * fricatives' calibrated constriction for the current body; a hiss follows the performer's
 * strength frame by frame, a stop is a quick closure and release with a puff of aspiration.
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

/**
 * One frame's worth of a hiss whose strength follows the performer's (0..1), sent every frame:
 * short gestures that overlap their neighbours (ramps one frame long), so the constriction and
 * the open glottis glide with the hiss instead of switching on and off.
 *
 * The engine blends a key's target with the performer's posture by weight, the posture weighing
 * 0.05 (planner: a strength-40 consonant owns its articulators). A weight w moves the tongue
 * w / (0.05 + w) of the way, so the strength is chosen for the share wanted: from a little past
 * halfway at the faintest hiss (a wide gap, barely noisy) to all the way at full. The glottis
 * opens in proportion (its weight acts linearly up to 2).
 */
export function hissSlice(ipa: HissClass, body: BodyMix, amount: number, frame = 1 / 60): Gesture[] {
  const a = Math.min(1, Math.max(0, amount));
  const share = 0.55 + 0.45 * Math.pow(a, 0.7);
  const strength = share >= 0.998 ? 40 : Math.min(40, (0.05 * share) / (1 - share));
  const d = DEFS[ipa];
  const t1 = frame * 2;
  const out = [
    g(0, t1, frame, frame, strength, forBody(ipa, body), { speed: 1.3, label: ipa }),
    g(0, t1, frame, frame, 2 * a, { abduction: 0.3 }, { label: "voiceless" }),
  ];
  if (d.alveolar) out.push(g(0, t1, frame, frame, 1.2 * a, { tbX: 3.2, tbY: 7.4 }, { label: ipa }));
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
