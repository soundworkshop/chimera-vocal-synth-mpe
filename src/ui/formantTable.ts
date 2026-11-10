/**
 * Formants → mouth by measurement, for the mic: the vowel blend (VoiceModel.articForFormants)
 * mixes the calibrated vowel shapes as if formants mixed linearly with them, but they don't — in
 * the middle of a transition it misses by up to ~19% (ɛ→o halfway: F2 1438 Hz for 1272), which
 * scrambles exactly the vowel-to-vowel movement words are heard by. Here the model itself is
 * measured instead: mixes of two or three calibrated vowels, each one's formants from the
 * airway's transfer function, and the inverse is a weighted nearest-neighbour look-up in that
 * measured space (natively: mean error 7.3% → 1.5%, worst 19% → 6% along common vowel paths).
 *
 * Built incrementally (a few ms per frame) per body, from English vowels only (ENGLISH_VOWELS).
 */
import type { HumanArtic } from "../wasm/types.ts";
import type { VoiceModel } from "./analysis.ts";

/** what the table needs from the engine (passed in, so the class runs without the wasm) */
export interface TableDeps {
  neutral: HumanArtic;
  restTip: (jaw: number, tbX: number, tbY: number) => { x: number; y: number };
}

/** the keys the vowels set (the same as the blend's); the tip follows the tongue body */
const KEYS = ["tbX", "tbY", "jaw", "lipAp", "lipProt", "lipWidth", "root", "larynx", "ttCurl"] as const;
type Key = (typeof KEYS)[number];

interface Entry {
  a: Float64Array;
  l1: number;
  l2: number;
}

/**
 * The vowels English uses. Chimera's set also has y, ø, œ, ɨ, ɯ, ɤ, which share F1/F2 with
 * English vowels but not their lips: F1/F2 can't tell rounded from spread, so a performer's "oo"
 * landed nearer ɯ (an unrounded "oo") and ɨ than u, and came out with spread lips: "ee".
 */
export const ENGLISH_VOWELS = new Set(["i", "ɪ", "e", "ɛ", "æ", "a", "ɑ", "ɒ", "ɔ", "o", "ʊ", "u", "ʌ", "ə", "ɐ", "ɝ"]);

/** F1 differences count more (as in the blend): perceptually larger */
const F1_WEIGHT = 2.2;

export class FormantTable {
  readonly entries: Entry[] = [];
  private queue: Float64Array[] = [];
  private seed = 12345;
  private vowelsDone = false;

  private readonly vowels: VoiceModel["vowels"];

  constructor(
    private readonly model: Pick<VoiceModel, "vowels" | "transfer">,
    private readonly deps: TableDeps,
    readonly size = 1200,
    allowed: Set<string> = ENGLISH_VOWELS,
  ) {
    this.vowels = model.vowels.filter((v) => allowed.has(v.ipa));
  }

  /** usable once the vowels themselves are measured (it is then a blend of them; mixes refine it) */
  get ready(): boolean {
    return this.entries.length >= this.vowels.length;
  }

  get complete(): boolean {
    return this.entries.length >= this.size;
  }

  /** Measure more of the table, for about `budgetMs`. */
  grow(budgetMs: number): void {
    if (this.complete) return;
    const t0 = performance.now();
    if (!this.vowelsDone) {
      // the calibrated vowels themselves first (measured, like everything else)
      for (const v of this.vowels) this.queue.push(this.vec(v.artic));
      this.vowelsDone = true;
    }
    let tries = 0;
    while (this.entries.length < this.size && performance.now() - t0 < budgetMs && tries++ < 400) {
      const a = this.queue.pop() ?? this.mix();
      const fm = this.model.transfer(this.full(a)).formants;
      if (fm.length >= 2 && fm[0] > 0 && fm[1] > 0) this.entries.push({ a, l1: Math.log(fm[0]), l2: Math.log(fm[1]) });
    }
  }

  /** The mouth whose measured F1/F2 are nearest (four neighbours, inverse-square weights). */
  lookup(F1: number, F2: number): Partial<HumanArtic> {
    const l1 = Math.log(F1), l2 = Math.log(F2);
    const best: { e: Entry; d: number }[] = [];
    for (const e of this.entries) {
      const d = Math.hypot((l1 - e.l1) * F1_WEIGHT, l2 - e.l2);
      if (best.length < 4 || d < best[3].d) {
        best.push({ e, d });
        best.sort((x, y) => x.d - y.d);
        if (best.length > 4) best.pop();
      }
    }
    const out: Partial<HumanArtic> = {};
    let ws = 0;
    const acc = new Float64Array(KEYS.length);
    for (const { e, d } of best) {
      const w = 1 / (d + 0.005) ** 2;
      ws += w;
      for (let k = 0; k < KEYS.length; k++) acc[k] += e.a[k] * w;
    }
    KEYS.forEach((k, i) => (out[k] = acc[i] / ws));
    return out;
  }

  private vec(a: Partial<HumanArtic>): Float64Array {
    return Float64Array.from(KEYS, (k: Key) => (a[k] as number | undefined) ?? this.deps.neutral[k]);
  }

  /** a random mix of two or three calibrated vowels */
  private mix(): Float64Array {
    const vs = this.vowels;
    const n = this.rnd() < 0.6 ? 2 : 3;
    const out = new Float64Array(KEYS.length);
    const picks = Array.from({ length: n }, () => ({ v: this.vec(vs[Math.floor(this.rnd() * vs.length) % vs.length].artic), w: this.rnd() + 0.05 }));
    const sum = picks.reduce((s, p) => s + p.w, 0);
    for (const p of picks) for (let k = 0; k < KEYS.length; k++) out[k] += (p.v[k] * p.w) / sum;
    return out;
  }

  /** the full articulation the voice would get (other keys neutral, the tip resting on the body) */
  private full(a: Float64Array): HumanArtic {
    const out: HumanArtic = { ...this.deps.neutral };
    KEYS.forEach((k, i) => (out[k] = a[i]));
    const tip = this.deps.restTip(out.jaw, out.tbX, out.tbY);
    out.ttX = tip.x;
    out.ttY = tip.y;
    return out;
  }

  private rnd(): number {
    // xorshift: the same table every time for a body
    let s = this.seed;
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    this.seed = s >>> 0 || 1;
    return this.seed / 4294967296;
  }
}

const tables = new WeakMap<VoiceModel, FormantTable>();

/** The table for this body's model (created empty; grow it). */
export function formantTable(model: VoiceModel, deps: TableDeps): FormantTable {
  let t = tables.get(model);
  if (!t) tables.set(model, (t = new FormantTable(model, deps)));
  return t;
}
