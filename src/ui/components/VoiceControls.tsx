import { useEffect, useRef } from "react";
import { mpeLive, touchToBreath, useStore } from "../store.ts";
import { V } from "../colors.ts";
import { micLive, useMic } from "../micWords.ts";
import { EncoderPages, type EncoderPage } from "./Encoder.tsx";
import { Chip } from "./Screen.tsx";

const NOTE = ["C", "C♯", "D", "D♯", "E", "F", "F♯", "G", "G♯", "A", "A♯", "B"];
export const noteName = (f: number) => {
  const m = Math.round(69 + 12 * Math.log2(f / 440));
  return `${NOTE[((m % 12) + 12) % 12]}${Math.floor(m / 12) - 1}`;
};

const pct = (v: number) => ({ value: String(Math.round(v * 100)), unit: "%" });
const cm = (v: number) => ({ value: v.toFixed(1), unit: "cm" });
const signedCm = (v: number) => ({ value: `${v >= 0 ? "+" : ""}${v.toFixed(1)}`, unit: "cm" });

/**
 * Play mode's controls: the voice and the articulators without a handle, four at a time
 * (OP-1 style). Values live in the store as before.
 */
export function VoiceControls() {
  const s = useStore((st) => st.source);
  const setSource = useStore((st) => st.setSource);
  const a = useStore((st) => st.artic);
  const setArtic = useStore((st) => st.setArtic);
  const t = useStore((st) => st.touch);
  const setTouch = useStore((st) => st.setTouch);
  const d = useStore((st) => st.distortion);
  const setDistortion = useStore((st) => st.setDistortion);
  const mic = useMic();
  const r = useStore((st) => st.reverb);
  const setReverb = useStore((st) => st.setReverb);
  const pages: EncoderPage[] = [
    {
      name: "Voice",
      encoders: [
        { label: "Pitch", value: s.f0, min: 40, max: 1100, log: true, onChange: (v) => setSource({ f0: v }), format: (v) => ({ value: v.toFixed(0), unit: `Hz ${noteName(v)}` }) },
        { label: "Breath", value: s.pressure, min: 2, max: 22, onChange: (v) => setSource({ pressure: v }), format: (v) => ({ value: v.toFixed(1), unit: "cmH₂O" }) },
        { label: "Pressed", value: s.tension, min: 0, max: 1, onChange: (v) => setSource({ tension: v }), format: pct },
        { label: "Vibrato", value: s.vibratoDepth, min: 0, max: 120, onChange: (v) => setSource({ vibratoDepth: v }), format: (v) => ({ value: v.toFixed(0), unit: "cents" }) },
      ],
    },
    {
      name: "Tone",
      encoders: [
        { label: "Bright", value: s.brightness, min: 0, max: 1, onChange: (v) => setSource({ brightness: v }), format: pct },
        { label: "Breathy", value: s.breathiness, min: 0, max: 1, onChange: (v) => setSource({ breathiness: v }), format: pct },
        { label: "Rough", value: s.roughness, min: 0, max: 1, onChange: (v) => setSource({ roughness: v }), format: pct },
        { label: "Fry", value: s.fry, min: 0, max: 1, onChange: (v) => setSource({ fry: v }), format: pct },
      ],
    },
    {
      name: "Pitch",
      encoders: [{ label: "Glide", value: s.glide, min: 0.005, max: 0.6, log: true, onChange: (v) => setSource({ glide: v }), format: (v) => ({ value: (v * 1000).toFixed(0), unit: "ms" }) }],
    },
    {
      // MPE pressure → breath (see touchToBreath); the graph shows the curve and the live touch
      name: "Touch",
      encoders: [
        { label: "Start", value: t.start, min: 0, max: 0.9, onChange: (v) => setTouch({ start: v }), format: pct },
        { label: "Curve", value: t.curve, min: 0.3, max: 3, log: true, onChange: (v) => setTouch({ curve: v }), format: (v) => ({ value: v.toFixed(2), unit: v < 0.95 ? "fast rise" : v > 1.05 ? "slow rise" : "linear" }) },
        { label: "Floor", value: t.floor, min: 0, max: 0.3, onChange: (v) => setTouch({ floor: v }), format: pct },
      ],
      panel: <TouchGraph />,
    },
    {
      // before the reverb: Drive 0 is clean, Level 50% is unity
      name: "Drive",
      encoders: [
        { label: "Drive", value: d.drive, min: 0, max: 1, onChange: (v) => setDistortion({ drive: v }), format: pct },
        { label: "Tone", value: d.tone, min: 0, max: 1, onChange: (v) => setDistortion({ tone: v }), format: (v) => { const hz = 700 * Math.pow(16000 / 700, v); return { value: hz >= 1000 ? (hz / 1000).toFixed(1) : hz.toFixed(0), unit: hz >= 1000 ? "kHz" : "Hz" }; } },
        { label: "Mix", value: d.mix, min: 0, max: 1, onChange: (v) => setDistortion({ mix: v }), format: pct },
        { label: "Level", value: d.level, min: 0, max: 1, onChange: (v) => setDistortion({ level: v }), format: (v) => ({ value: v <= 0.001 ? "−∞" : (20 * Math.log10(2 * v)).toFixed(1), unit: "dB" }) },
      ],
    },
    {
      // the performer's vowels shape the mouth (micWords.ts)
      name: "Mic",
      encoders: [
        { label: "Gate", value: mic.gate, min: -80, max: -20, onChange: (v) => mic.set({ gate: v }), format: (v) => ({ value: v.toFixed(0), unit: "dB" }) },
        { label: "Smooth", value: mic.smooth, min: 5, max: 200, log: true, onChange: (v) => mic.set({ smooth: v }), format: (v) => ({ value: v.toFixed(0), unit: "ms" }) },
      ],
      panel: <MicPanel />,
    },
    {
      // the performer's s, ʃ, f, t, k become Chimera's own (consonants.ts)
      name: "Consonants",
      encoders: [{ label: "Hiss", value: mic.hissSense, min: 0, max: 1, onChange: (v) => mic.set({ hissSense: v }), format: (v) => (mic.consonants ? pct(v) : { value: "Off", unit: "" }) }],
      panel: <ConsonantPanel />,
    },
    {
      name: "Reverb",
      encoders: [
        { label: "Mix", value: r.mix, min: 0, max: 1, onChange: (v) => setReverb({ mix: v }), format: pct },
        { label: "Decay", value: r.time, min: 0, max: 1, onChange: (v) => setReverb({ time: v }), format: pct },
        { label: "Tone", value: r.tone, min: 0, max: 1, onChange: (v) => setReverb({ tone: v }), format: pct },
        { label: "Diffuse", value: r.diffusion, min: 0, max: 1, onChange: (v) => setReverb({ diffusion: v }), format: pct },
      ],
    },
    {
      name: "Mouth",
      encoders: [
        { label: "Rounding", value: 1 - a.lipWidth, min: 0, max: 1, onChange: (v) => setArtic({ lipWidth: 1 - v }), format: pct },
        { label: "Lips open", value: a.lipAp, min: -0.3, max: 2.2, onChange: (v) => setArtic({ lipAp: v }), format: cm },
        { label: "Protrude", value: a.lipProt, min: -0.1, max: 1.4, onChange: (v) => setArtic({ lipProt: v }), format: cm },
        { label: "Jaw", value: a.jaw, min: 0, max: 2.4, onChange: (v) => setArtic({ jaw: v }), format: cm },
      ],
    },
    {
      name: "Tongue",
      encoders: [
        { label: "Root", value: a.root, min: -0.9, max: 0.9, onChange: (v) => setArtic({ root: v }), format: signedCm },
        { label: "Tip curl", value: a.ttCurl, min: 0, max: 1, onChange: (v) => setArtic({ ttCurl: v }), format: pct },
      ],
    },
    {
      name: "Throat",
      encoders: [
        { label: "Soft palate", value: a.velum, min: -0.25, max: 1.2, onChange: (v) => setArtic({ velum: v }), format: (v) => (v <= 0 ? { value: "Shut", unit: "" } : { value: v.toFixed(2), unit: "cm²" }) },
        { label: "Larynx", value: a.larynx, min: -1.5, max: 1.5, onChange: (v) => setArtic({ larynx: v }), format: signedCm },
        { label: "Twang", value: a.epilarynx, min: 0, max: 1, onChange: (v) => setArtic({ epilarynx: v }), format: pct },
        { label: "False folds", value: a.ventricular, min: 0, max: 1, onChange: (v) => setArtic({ ventricular: v }), format: pct },
      ],
    },
  ];
  return <EncoderPages label="Voice" pages={pages} />;
}

/** Hold breath and Whisper, for the voice screen's header. */
export function VoiceToggles() {
  const voiced = useStore((st) => st.source.voiced);
  const setSource = useStore((st) => st.setSource);
  const hold = useStore((st) => st.hold);
  const setHold = useStore((st) => st.setHold);
  const two = useStore((st) => st.twoVoices);
  const setTwo = useStore((st) => st.setTwoVoices);
  const micStatus = useMic((m) => m.status);
  const micProblem = useMic((m) => m.problem);
  const setMic = useMic((m) => m.setOn);
  const micOn = micStatus === "on" || micStatus === "starting";
  return (
    <>
      <Chip on={micOn} onClick={() => setMic(!micOn)} title={micProblem ?? (micOn ? "Stop listening" : "Your vowels shape the mouth (asks for the microphone)")}>
        {micStatus === "starting" ? "Mic words…" : micStatus === "denied" || micStatus === "error" ? "Mic words ⚠" : "Mic words"}
      </Chip>
      {micProblem && <span className="mic-problem" role="alert">{micProblem}</span>}
      <Chip on={two} onClick={() => setTwo(!two)}>
        2 voices
      </Chip>
      <Chip on={hold} onClick={() => setHold(!hold)}>
        Hold breath
      </Chip>
      <Chip on={!voiced} onClick={() => setSource({ voiced: !voiced })}>
        Whisper
      </Chip>
    </>
  );
}

/**
 * The touch curve: controller pressure (across) to breath (up, as a share of the Breath knob),
 * with a dot where the highest held note's pressure is now.
 */
function TouchGraph() {
  const ref = useRef<HTMLCanvasElement>(null);
  const touch = useStore((st) => st.touch);
  useEffect(() => {
    const cv = ref.current;
    if (!cv) return;
    let raf = 0;
    const draw = () => {
      raf = requestAnimationFrame(draw);
      const dpr = window.devicePixelRatio || 1;
      const w = cv.clientWidth, h = cv.clientHeight;
      if (!w || !h) return;
      if (cv.width !== Math.round(w * dpr)) cv.width = Math.round(w * dpr);
      if (cv.height !== Math.round(h * dpr)) cv.height = Math.round(h * dpr);
      const ctx = cv.getContext("2d");
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      const pad = 4;
      const X = (p: number) => pad + p * (w - 2 * pad);
      const Y = (b: number) => h - pad - b * (h - 2 * pad);
      ctx.strokeStyle = V.blueDim;
      ctx.lineWidth = 1;
      ctx.strokeRect(pad, pad, w - 2 * pad, h - 2 * pad);
      ctx.strokeStyle = V.amber;
      ctx.lineWidth = 2;
      ctx.beginPath();
      for (let i = 0; i <= 120; i++) {
        const p = i / 120;
        const b = touchToBreath(p, touch);
        if (i === 0) ctx.moveTo(X(p), Y(b));
        else ctx.lineTo(X(p), Y(b));
      }
      ctx.stroke();
      const p = mpeLive.pressure;
      if (p !== null) {
        ctx.fillStyle = V.green;
        ctx.beginPath();
        ctx.arc(X(p), Y(touchToBreath(p, touch)), 4, 0, 2 * Math.PI);
        ctx.fill();
      }
    };
    draw();
    return () => cancelAnimationFrame(raf);
  }, [touch]);
  return <canvas ref={ref} className="touch-graph" role="img" aria-label="Touch curve: pressure to breath" />;
}

const MIC_STATUS: Record<string, string> = { off: "Mic off: turn on Mic words", starting: "Asking for the mic…", denied: "Mic blocked by the browser", error: "Mic didn't start" };

/**
 * The mic's level against the gate, the calibration (and its prompts), and the input choice.
 */
function MicPanel() {
  const m = useMic();
  const meter = useRef<HTMLDivElement>(null);
  const readout = useRef<HTMLSpanElement>(null);
  const gateRef = useRef(m.gate);
  gateRef.current = m.gate;
  useEffect(() => {
    let raf = 0;
    const draw = () => {
      raf = requestAnimationFrame(draw);
      const el = meter.current;
      if (!el) return;
      const u = Math.min(1, Math.max(0, (micLive.db + 80) / 70));
      el.style.setProperty("--level", String(u));
      el.style.setProperty("--gate", String(Math.min(1, Math.max(0, (gateRef.current + 80) / 70))));
      el.classList.toggle("over", micLive.active);
      // what the tracker hears right now (your voice, before calibration)
      // and, after calibration, the vowel Chimera aims for
      if (readout.current) readout.current.textContent = micLive.active ? `F1 ${Math.round(micLive.f1)} · F2 ${Math.round(micLive.f2)} Hz${micLive.aim ? ` → ${micLive.aim}` : ""}` : "";
    };
    draw();
    return () => cancelAnimationFrame(raf);
  }, []);
  const on = m.status === "on";
  return (
    <div className="mic-panel">
      <div className="mic-status">{m.prompt ?? m.problem ?? (on ? (m.calibrated ? "Listening" : "Listening: calibrate for your voice") : MIC_STATUS[m.status])}</div>
      <div className="mic-meter" ref={meter} aria-hidden="true">
        <span className="mic-meter-level" />
        <span className="mic-meter-gate" />
      </div>
      <div className="mic-actions">
        {m.sampling ? null : m.prompt ? (
          <button type="button" className="mic-btn" onClick={m.cancelCalibration}>
            Cancel
          </button>
        ) : (
          <button type="button" className="mic-btn" disabled={!on} onClick={m.calibrate} title="Say ee, ah and oo so the mouth follows your voice">
            Calibrate
          </button>
        )}
        <button type="button" className="mic-btn" disabled={!on || m.sampling || !!m.prompt} onClick={m.saveSample} title="Save 8 s of the raw mic to send for diagnosis">
          Save sample
        </button>
        <span className="mic-readout" ref={readout} />
        {m.inputs.length > 1 && (
          <select className="mic-input" value={m.deviceId} onChange={(e) => m.set({ deviceId: e.target.value })} aria-label="Microphone">
            <option value="">System default</option>
            {m.inputs.map((d) => (
              <option key={d.id} value={d.id}>
                {d.label}
              </option>
            ))}
          </select>
        )}
      </div>
    </div>
  );
}

/** Consonants on/off, what they cover, and the last one heard (for a moment). */
function ConsonantPanel() {
  const m = useMic();
  const heard = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    let raf = 0;
    const draw = () => {
      raf = requestAnimationFrame(draw);
      if (heard.current) heard.current.textContent = micLive.consonant && performance.now() - micLive.consonantAt < 700 ? micLive.consonant : "";
    };
    draw();
    return () => cancelAnimationFrame(raf);
  }, []);
  return (
    <div className="mic-panel">
      <div className="mic-status">{m.status === "on" ? "Hiss: s, sh, f · bursts: t, k (hold a note on PT2)" : "Turn on Mic words to use consonants"}</div>
      <div className="mic-actions">
        <button type="button" className={`mic-btn${m.consonants ? " on" : ""}`} aria-pressed={m.consonants} onClick={() => m.set({ consonants: !m.consonants })}>
          {m.consonants ? "On" : "Off"}
        </button>
        <span className="mic-heard" ref={heard} aria-label="Last consonant heard" />
      </div>
    </div>
  );
}
