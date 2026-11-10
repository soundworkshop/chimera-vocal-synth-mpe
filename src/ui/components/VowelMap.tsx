import { useRef } from "react";
import { usePhosphor } from "../usePhosphor.ts";
import { engine } from "../../audio/AudioEngine.ts";
import { useStore } from "../store.ts";
import { blendLog, sameBody, type BodyMix } from "../body.ts";
import { useModel } from "../useModel.ts";
import { VoiceModel } from "../analysis.ts";
import { TEXT, V } from "../colors.ts";
import { beamPts, handle, ipaGlyph, label, seg, type Pt } from "../render/vector.ts";
import { nearestVowel } from "./AnatomyView.tsx";
import { Chip } from "./Screen.tsx";
import { sweepLive, useSweep, type SweepEnd } from "../vowelSweep.ts";
import { getModel } from "../useModel.ts";
import { setVoice2Artic, useDuet, voice2Live } from "../duet.ts";

/**
 * Vowel map in the phonetician's orientation: F2 decreasing left→right, F1 increasing downward.
 * Calibrated vowels are plotted where this body actually produces them; dragging morphs the
 * articulation between them; the green ring is the live tract's measured (F1, F2), with a trail.
 *
 * `voice` 1 is the duet's second voice: its own body, mouth and sweep. With the sweep on, a press
 * anywhere snaps the nearer end of the line to the pointer and drags it.
 */
export function VowelMap(props: { voice?: number }) {
  const voice = props.voice ?? 0;
  const mainModel = useModel();
  /** this voice's body (voice 2's lives in the duet store) */
  const bodyOf = (): BodyMix => (voice === 0 ? useStore.getState().body : (useDuet.getState().preview2 ?? useDuet.getState().body2));
  const model = {
    get current(): VoiceModel | null {
      return voice === 0 ? mainModel.current : getModel(bodyOf(), engine.ctx?.sampleRate ?? 48000);
    },
  };
  const dragging = useRef(false);
  /** which sweep end is being dragged, if any */
  const dragEnd = useRef<"a" | "b" | null>(null);
  const range = () => {
    const b = bodyOf();
    const at = (male: number, female: number, child: number) => blendLog(b, { male, female, child });
    return { f1: [at(230, 280, 300), at(950, 1150, 1250)], f2: [at(700, 800, 900), at(2700, 3200, 3500)] };
  };
  const toXY = (F1: number, F2: number, w: number, h: number) => {
    const r = range();
    const pad = 18;
    const x = pad + ((Math.log(r.f2[1]) - Math.log(F2)) / (Math.log(r.f2[1]) - Math.log(r.f2[0]))) * (w - 2 * pad);
    const y = pad + ((Math.log(F1) - Math.log(r.f1[0])) / (Math.log(r.f1[1]) - Math.log(r.f1[0]))) * (h - 2 * pad);
    return { x, y };
  };
  const fromXY = (x: number, y: number, w: number, h: number) => {
    const r = range();
    const pad = 18;
    const u = Math.min(1, Math.max(0, (x - pad) / (w - 2 * pad)));
    const v = Math.min(1, Math.max(0, (y - pad) / (h - 2 * pad)));
    const F2 = Math.exp(Math.log(r.f2[1]) - u * (Math.log(r.f2[1]) - Math.log(r.f2[0])));
    const F1 = Math.exp(Math.log(r.f1[0]) + v * (Math.log(r.f1[1]) - Math.log(r.f1[0])));
    return { F1, F2 };
  };
  /** recent (F1, F2) of the live tract, so the trail survives resizes and fades out */
  const trail = useRef<{ F1: number; F2: number; t: number; body: BodyMix }[]>([]);
  const ref = usePhosphor(({ ctx, w, h }) => {
    const m = model.current;
    if (!m) return;
    const st = useStore.getState();
    const body = bodyOf();
    // vowel trapezoid guide, like a border on a map
    const corners = [toXY(300, 2500, w, h), toXY(320, 850, w, h), toXY(720, 1050, w, h), toXY(780, 1650, w, h)];
    beamPts(ctx, corners.map((p) => [p.x, p.y] as Pt), V.blueDim, 1, { close: true, alpha: 0.9 });
    const src = voice === 0 ? engine.latest : (engine.latestExtra[0] ?? null);
    const tele = src && sameBody(src.body, body) ? src : null;
    const a = tele ? VoiceModel.articFromArray(tele.t.artic) : voice === 0 ? st.artic : { ...st.artic, ...voice2Live.artic };
    const fm = m.transfer(a).formants;
    const live = fm.length >= 2 ? toXY(fm[0], fm[1], w, h) : null;
    const near = fm.length >= 2 ? nearestVowel(m, fm[0], fm[1]) : "";
    for (const v of m.vowels) {
      if (v.ipa === near && live) continue;
      const p = toXY(v.F1, v.F2, w, h);
      ipaGlyph(ctx, p.x, p.y + 5, v.ipa, 15, TEXT.secondary);
    }
    if (live) {
      // where the tongue has been: a trail of the last 1.5 s, fading with age
      const now = performance.now();
      const tr = (trail.current = trail.current.filter((p) => sameBody(p.body, body) && now - p.t < 1500));
      const last = tr[tr.length - 1];
      if (!last || Math.abs(Math.log(last.F1 / fm[0])) + Math.abs(Math.log(last.F2 / fm[1])) > 0.004) tr.push({ F1: fm[0], F2: fm[1], t: now, body });
      for (let i = 1; i < tr.length; i++) {
        const p0 = toXY(tr[i - 1].F1, tr[i - 1].F2, w, h), p1 = toXY(tr[i].F1, tr[i].F2, w, h);
        seg(ctx, p0.x, p0.y, p1.x, p1.y, V.green, 1.2, { alpha: 0.7 * (1 - (now - tr[i].t) / 1500) });
      }
      handle(ctx, live.x, live.y, V.green, 8);
      ipaGlyph(ctx, live.x + 20, live.y - 8, near, 17, V.green);
    }
    // the vowel sweep: its line, its two ends (quiet, loud), and where the volume has it now
    const sw = useSweep.getState().voices[voice];
    const at = sweepLive[voice]?.at;
    if (sw.on) {
      const pa = toXY(sw.a.F1, sw.a.F2, w, h), pb = toXY(sw.b.F1, sw.b.F2, w, h);
      seg(ctx, pa.x, pa.y, pb.x, pb.y, V.amber, 1.5, { alpha: 0.9 });
      handle(ctx, pa.x, pa.y, V.amber, 7);
      handle(ctx, pb.x, pb.y, V.amber, 7);
      label(ctx, "QUIET", pa.x, pa.y + 18, { size: 9, color: V.amber, align: "center", ls: 0.1 });
      label(ctx, "LOUD", pb.x, pb.y + 18, { size: 9, color: V.amber, align: "center", ls: 0.1 });
      if (at) {
        const p = toXY(at.F1, at.F2, w, h);
        ctx.save();
        ctx.fillStyle = V.amber;
        ctx.beginPath();
        ctx.arc(p.x, p.y, 3.5, 0, 2 * Math.PI);
        ctx.fill();
        ctx.restore();
      }
    }
    label(ctx, "F2", w - 6, h - 5, { size: 9, color: TEXT.secondary, align: "right", ls: 0.1 });
    label(ctx, "F1", 4, h - 5, { size: 9, color: TEXT.secondary, ls: 0.1 });
  });

  const apply = (e: React.PointerEvent) => {
    const m = model.current;
    if (!m) return;
    const r = (e.currentTarget as HTMLCanvasElement).getBoundingClientRect();
    const { F1, F2 } = fromXY(e.clientX - r.left, e.clientY - r.top, r.width, r.height);
    const sweep = useSweep.getState();
    // with the sweep on, drags move its ends (the volume places the vowel)
    if (sweep.voices[voice].on) {
      if (dragEnd.current) sweep.setEnd(voice, dragEnd.current, { F1, F2 });
      return;
    }
    const artic = m.articForFormants(F1, F2);
    if (voice === 0) useStore.getState().setArtic(artic, true);
    else setVoice2Artic(artic, true);
  };

  /** the nearer end of the sweep's line (a press anywhere snaps it to the pointer) */
  const pickEnd = (e: React.PointerEvent): "a" | "b" | null => {
    const sw = useSweep.getState().voices[voice];
    if (!sw.on) return null;
    const r = (e.currentTarget as HTMLCanvasElement).getBoundingClientRect();
    const x = e.clientX - r.left, y = e.clientY - r.top;
    const d = (end: SweepEnd) => {
      const p = toXY(end.F1, end.F2, r.width, r.height);
      return Math.hypot(p.x - x, p.y - y);
    };
    return d(sw.a) <= d(sw.b) ? "a" : "b";
  };

  return (
    <canvas
      ref={ref}
      className="vowel-map"
      onPointerDown={(e) => {
        dragEnd.current = pickEnd(e);
        dragging.current = true;
        (e.target as Element).setPointerCapture(e.pointerId);
        apply(e);
      }}
      onPointerMove={(e) => dragging.current && apply(e)}
      onPointerUp={() => ((dragging.current = false), (dragEnd.current = null))}
      onPointerCancel={() => ((dragging.current = false), (dragEnd.current = null))}
      aria-label="Vowel map. Drag to morph between vowels."
      role="slider"
      aria-valuetext="vowel position"
    />
  );
}

/** On/off for a voice's vowel sweep (its Vowels screen's tools). */
export function SweepToggle(props: { voice?: number }) {
  const voice = props.voice ?? 0;
  const on = useSweep((s) => s.voices[voice].on);
  const setOn = useSweep((s) => s.setOn);
  return (
    <Chip on={on} onClick={() => setOn(voice, !on)} title="The vowel moves along a line with the volume: press anywhere to bring the nearer end of the line there">
      Sweep
    </Chip>
  );
}
