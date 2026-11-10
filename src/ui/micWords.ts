/**
 * Mic words: the performer's own vowels shape Chimera's mouth. Every animation frame, the
 * microphone's F1/F2 (formants.ts) are mapped into the model's vowel space (a per-performer
 * calibration from "ee", "ah", "oo"), smoothed, and turned into tongue, jaw and lips by the same
 * mouth Chimera's own acoustics say gives those formants (formantTable.ts; the Vowels screen's
 * blend until the table is measured). Pitch and breath
 * stay with the keys / MPE; between words (silence, breaths, the end of a word fading out, the
 * room's noise) the mouth holds the last vowel said (VoiceGate).
 * Play mode only: Speak and Sing plan their own articulation.
 */
import { create } from "zustand";
import { engine } from "../audio/AudioEngine.ts";
import { MicInput, listInputs } from "../audio/micInput.ts";
import { VoiceGate } from "../audio/voiceGate.ts";
import { ConsonantDetector } from "../audio/consonants.ts";
import { hissSlice, stopGestures } from "./consonantGestures.ts";
import { analyzeFormants, applyCalibration, calibrationProblem, fitCalibration, FormantFollower, IDENTITY_CALIBRATION, median, type FormantCalibration } from "../audio/formants.ts";
import { useStore } from "./store.ts";
import { getModel } from "./useModel.ts";
import { useSweep } from "./vowelSweep.ts";
import { ENGLISH_VOWELS, formantTable as tableFor } from "./formantTable.ts";
import { NEUTRAL, restTip } from "../wasm/engine.ts";

export type MicStatus = "off" | "starting" | "on" | "denied" | "error";

interface MicSettings {
  /** level (dBFS) above which the mic drives the mouth */
  gate: number;
  /** smoothing time constant (ms) */
  smooth: number;
  calibration: FormantCalibration;
  /** chosen input ("" = the system default) */
  deviceId: string;
  /** hiss and bursts become Chimera's consonants (s, ʃ, f; t, k) */
  consonants: boolean;
  /** 0 needs a strong hiss … 1 takes a faint one */
  hissSense: number;
}

interface MicState extends MicSettings {
  status: MicStatus;
  /** why the mic isn't on, in words the performer can act on (null when fine) */
  problem: string | null;
  /** shown while calibrating */
  prompt: string | null;
  calibrated: boolean;
  inputs: { id: string; label: string }[];
  setOn: (on: boolean) => void;
  set: (v: Partial<MicSettings>) => void;
  calibrate: () => void;
  cancelCalibration: () => void;
  /** recording a raw mic sample to send for diagnosis */
  sampling: boolean;
  saveSample: () => void;
}

const KEY = "chimera-mic-settings";
const DEFAULTS: MicSettings = { gate: -50, smooth: 15, calibration: { ...IDENTITY_CALIBRATION }, deviceId: "", consonants: true, hissSense: 0.6 };

function load(): MicSettings {
  try {
    const raw = localStorage.getItem(KEY);
    const v = raw ? JSON.parse(raw) : {};
    // settings saved before v2 kept the old 30 ms default, which smeared vowel-to-vowel motion
    if (!v.v && v.smooth === 30) v.smooth = DEFAULTS.smooth;
    // calibrations from before captures were checked (v < 3) may have taken "oo"'s F3 for its
    // F2, which bends every "oo" toward "ee": drop them (the panel asks for a new one)
    if (!(v.v >= 3)) delete v.calibration;
    return { ...DEFAULTS, ...v };
  } catch {
    return { ...DEFAULTS };
  }
}
function save(s: MicSettings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify({ v: 3, gate: s.gate, smooth: s.smooth, calibration: s.calibration, deviceId: s.deviceId, consonants: s.consonants, hissSense: s.hissSense }));
  } catch {
    // storage blocked: settings last until reload
  }
}

/** live readings for the meter (not React state: they change every frame) */
export const micLive = { db: -120, f1: 0, f2: 0, active: false, consonant: "", consonantAt: 0, aim: "" };

const mic = new MicInput();
const voiceGate = new VoiceGate();
const consonants = new ConsonantDetector();
/** hiss sensitivity → the detector's (mid + high) / low power ratio (0.6 → 2.5) */
const hissRatio = (sense: number) => 8 * Math.pow(0.15, Math.min(1, Math.max(0, sense)));
/** bumped by every on/off, so a slow permission answer for an older attempt is ignored */
let attempt = 0;
let waitTimer: ReturnType<typeof setTimeout> | undefined;
let raf = 0;
let lastT = 0;
/** smoothed log formants (model space) */
const follower = new FormantFollower();
const formantTable = (model: Parameters<typeof tableFor>[0]) => tableFor(model, { neutral: NEUTRAL, restTip });

/** "ee", "ah", "oo": the corners of the vowel space, as the model's calibrated vowels */
const STEPS = [
  { ipa: "i", prompt: "Say “ee” (as in see) and hold it" },
  { ipa: "ɑ", prompt: "Say “ah” (as in father) and hold it" },
  { ipa: "u", prompt: "Say “oo” (as in food) and hold it" },
];
/** frames of voice to capture per vowel (~1.2 s at 60 fps) */
const CAPTURE = 70;
let cal: { step: number; f1: number[]; f2: number[]; got: { f1: number; f2: number }[] } | null = null;

const saved = load();

export const useMic = create<MicState>((set, get) => ({
  ...saved,
  status: "off",
  problem: null,
  prompt: null,
  calibrated: saved.calibration.a1 !== 1 || saved.calibration.b1 !== 0 || saved.calibration.a2 !== 1 || saved.calibration.b2 !== 0,
  inputs: [],
  setOn: (on) => {
    attempt++;
    clearTimeout(waitTimer);
    if (!on) {
      stop();
      set({ status: "off", prompt: null, problem: null });
      cal = null;
      return;
    }
    if (get().status === "on") return;
    const mine = attempt;
    set({ status: "starting", problem: null });
    // Chrome sometimes asks quietly (an icon in the address bar, no pop-up): say where to look
    waitTimer = setTimeout(() => {
      if (attempt === mine && get().status === "starting") set({ problem: "Waiting for permission: click the microphone icon at the right of the address bar and allow it" });
    }, 4000);
    void (async () => {
      try {
        if (!navigator.mediaDevices?.getUserMedia) throw new Error("This browser can't use a microphone here (it needs https)");
        await useStore.getState().start();
        if (!engine.ctx) throw new Error("Audio didn't start");
        await mic.open(engine.ctx, get().deviceId || undefined);
        // turned off (or retried) while the browser was asking
        if (attempt !== mine) return void mic.close();
        clearTimeout(waitTimer);
        set({ status: "on", problem: null, inputs: await listInputs() });
        follower.reset();
        voiceGate.reset();
        consonants.reset();
        lastT = performance.now();
        cancelAnimationFrame(raf);
        raf = requestAnimationFrame(tick);
      } catch (e) {
        if (attempt !== mine) return;
        clearTimeout(waitTimer);
        console.error("mic:", e);
        const name = e instanceof DOMException ? e.name : "";
        const msg = e instanceof Error ? e.message : String(e);
        const problem =
          name === "NotAllowedError" && /system/i.test(msg)
            ? "macOS is blocking Chrome's microphone: System Settings → Privacy & Security → Microphone → turn on Google Chrome, then quit and reopen Chrome"
            : name === "NotAllowedError" || name === "SecurityError"
              ? "Microphone blocked for this site: click the icon at the left of the address bar → Site settings → Microphone → Allow, then reload"
              : name === "NotFoundError" || name === "OverconstrainedError"
                ? "No microphone found: check the earbuds are plugged in (or choose System default)"
                : name === "NotReadableError"
                  ? "The microphone is busy or blocked by macOS: check System Settings → Privacy & Security → Microphone"
                  : msg;
        // a chosen input that has gone away: fall back to the default next time
        if (name === "NotFoundError" || name === "OverconstrainedError") get().set({ deviceId: "" });
        set({ status: name === "NotAllowedError" || name === "SecurityError" ? "denied" : "error", problem });
      }
    })();
  },
  set: (v) => {
    const deviceChanged = v.deviceId !== undefined && v.deviceId !== get().deviceId;
    set(v);
    save(get());
    if (deviceChanged && get().status === "on") {
      get().setOn(false);
      get().setOn(true);
    }
  },
  calibrate: () => {
    if (get().status !== "on") return;
    cal = { step: 0, f1: [], f2: [], got: [] };
    set({ prompt: STEPS[0].prompt, problem: null });
  },
  cancelCalibration: () => {
    cal = null;
    set({ prompt: null });
  },
  sampling: false,
  saveSample: () => {
    const stream = mic.mediaStream;
    if (!stream || get().sampling) return;
    // the raw mic, as heard by the tracker (no processing), high-bitrate so formants survive
    const type = ["audio/webm;codecs=opus", "audio/mp4", "audio/webm"].find((t) => MediaRecorder.isTypeSupported(t)) ?? "";
    const rec = new MediaRecorder(stream, { mimeType: type, audioBitsPerSecond: 256_000 });
    const chunks: Blob[] = [];
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    rec.onstop = () => {
      set({ sampling: false, prompt: null });
      const t = rec.mimeType || type || "audio/webm";
      const url = URL.createObjectURL(new Blob(chunks, { type: t }));
      const a = document.createElement("a");
      a.href = url;
      a.download = `mic-sample-${new Date().toISOString().slice(0, 19).replace(/[T:]/g, "-")}.${t.startsWith("audio/mp4") ? "m4a" : "webm"}`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    };
    set({ sampling: true, prompt: "Recording 8 s: say “oo”, “ee”, “ah”, then “oo” again, each held ~1 s" });
    rec.start();
    setTimeout(() => rec.state !== "inactive" && rec.stop(), 8000);
  },
}));

function stop(): void {
  cancelAnimationFrame(raf);
  raf = 0;
  mic.close();
  micLive.active = false;
  micLive.db = -120;
}

function tick(): void {
  raf = requestAnimationFrame(tick);
  const frame = mic.read();
  const ctx = engine.ctx;
  if (!frame || !ctx) return;
  const now = performance.now();
  const dt = Math.min(0.1, (now - lastT) / 1000);
  lastT = now;
  const m = useMic.getState();
  // measure the formant table for this body in the background (a few ms a frame)
  const growModel = getModel(useStore.getState().body, ctx.sampleRate);
  formantTable(growModel).grow(3);
  // the newest 30 ms: shorter than the analyser's 43 ms, so the vowel lags less
  const r = analyzeFormants(frame.subarray(frame.length - Math.round(0.03 * ctx.sampleRate)), ctx.sampleRate);
  micLive.db = r.db;
  // only frames of the voice itself: not the noise floor, nor the fading end of a word (the
  // mouth then holds the last vowel said)
  const voiced = voiceGate.update(r.db, dt, m.gate) && r.f1 > 0 && r.f2 > 0;
  micLive.active = voiced;
  if (voiced) (micLive.f1 = r.f1), (micLive.f2 = r.f2);

  if (cal) return calibrateStep(voiced, r.f1, r.f2);

  const st = useStore.getState();
  if (st.mode !== "play") return;
  if (m.consonants) {
    consonants.hissRatio = hissRatio(m.hissSense);
    for (const e of consonants.update(frame, ctx.sampleRate, dt, m.gate)) {
      if (e.type === "stop") engine.scheduleGestures(stopGestures(e.ipa, st.body));
      if (e.type !== "hissEnd") (micLive.consonant = e.ipa), (micLive.consonantAt = now);
    }
    // a hiss follows how hard it is hissed, frame by frame (overlapping short gestures)
    const h = consonants.hissNow;
    if (h && h.amount > 0.02) engine.scheduleGestures(hissSlice(h.ipa, st.body, h.amount, Math.max(1 / 120, Math.min(1 / 30, dt))));
  }
  // a hiss's or a burst's formants are noise: the vowel holds meanwhile
  const consonant = m.consonants && (consonants.hissing || consonants.recentStop);
  // confidence: full near the current speaking level, little at the edges of words
  const confidence = Math.min(1, Math.max(0.1, (r.db - (voiceGate.peak - 12)) / 8));
  const v = follower.update(r, voiced && !consonant, confidence, dt, m.smooth / 1000);
  if (!v) return;
  const t = applyCalibration(v.f1, v.f2, m.calibration);
  const model = getModel(st.body, ctx.sampleRate);
  // the English vowel nearest the calibrated target, for the readout (a quick check that "oo" → u)
  let near = "", nd = Infinity;
  for (const vw of model.vowels) {
    if (!ENGLISH_VOWELS.has(vw.ipa)) continue;
    const d = Math.hypot(Math.log(t.f1 / vw.F1) * 2.2, Math.log(t.f2 / vw.F2));
    if (d < nd) (nd = d), (near = vw.ipa);
  }
  micLive.aim = near;
  const table = formantTable(model);
  // until the table's vowels are measured (the first frame or two), hold still; while the
  // vowel sweep is on, it owns the vowel (the consonants above still play)
  if (!table.ready || useSweep.getState().on) return;
  st.setArtic(table.lookup(t.f1, t.f2), true);
}

function calibrateStep(voiced: boolean, f1: number, f2: number): void {
  if (!cal) return;
  if (voiced) cal.f1.push(f1), cal.f2.push(f2);
  if (cal.f1.length < CAPTURE) return;
  cal.got.push({ f1: median(cal.f1), f2: median(cal.f2) });
  cal.f1 = [];
  cal.f2 = [];
  cal.step++;
  if (cal.step < STEPS.length) {
    useMic.setState({ prompt: STEPS[cal.step].prompt });
    return;
  }
  // fit the performer's corners onto this body's calibrated vowels
  const st = useStore.getState();
  const model = getModel(st.body, engine.ctx?.sampleRate ?? 48000);
  const target = STEPS.map((s) => model.vowels.find((v) => v.ipa === s.ipa)).map((v) => ({ f1: v?.F1 ?? 0, f2: v?.F2 ?? 0 }));
  const got = cal.got;
  cal = null;
  if (target.some((t) => !t.f1)) {
    useMic.setState({ prompt: null });
    return;
  }
  const problem = calibrationProblem(got);
  if (problem) {
    // keep the old calibration: a capture with a formant mistaken would bake the mistake in
    useMic.setState({ prompt: null, problem });
    return;
  }
  useMic.getState().set({ calibration: fitCalibration(got, target) });
  useMic.setState({ prompt: null, problem: null, calibrated: true });
  follower.reset();
}
