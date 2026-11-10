/**
 * Mic words: the performer's own vowels shape Chimera's mouth. Every animation frame, the
 * microphone's F1/F2 (formants.ts) are mapped into the model's vowel space (a per-performer
 * calibration from "ee", "ah", "oo"), smoothed, and turned into tongue, jaw and lips by the same
 * vowel blend the Vowels screen uses when dragged (VoiceModel.articForFormants). Pitch and breath
 * stay with the keys / MPE; below the gate (silence, breaths) the mouth holds its last shape.
 * Play mode only: Speak and Sing plan their own articulation.
 */
import { create } from "zustand";
import { engine } from "../audio/AudioEngine.ts";
import { MicInput, listInputs } from "../audio/micInput.ts";
import { analyzeFormants, applyCalibration, fitCalibration, IDENTITY_CALIBRATION, median, type FormantCalibration } from "../audio/formants.ts";
import { useStore } from "./store.ts";
import { getModel } from "./useModel.ts";

export type MicStatus = "off" | "starting" | "on" | "denied" | "error";

interface MicSettings {
  /** level (dBFS) above which the mic drives the mouth */
  gate: number;
  /** smoothing time constant (ms) */
  smooth: number;
  calibration: FormantCalibration;
  /** chosen input ("" = the system default) */
  deviceId: string;
}

interface MicState extends MicSettings {
  status: MicStatus;
  /** shown while calibrating */
  prompt: string | null;
  calibrated: boolean;
  inputs: { id: string; label: string }[];
  setOn: (on: boolean) => void;
  set: (v: Partial<MicSettings>) => void;
  calibrate: () => void;
  cancelCalibration: () => void;
}

const KEY = "chimera-mic-settings";
const DEFAULTS: MicSettings = { gate: -50, smooth: 30, calibration: { ...IDENTITY_CALIBRATION }, deviceId: "" };

function load(): MicSettings {
  try {
    const raw = localStorage.getItem(KEY);
    return { ...DEFAULTS, ...(raw ? JSON.parse(raw) : {}) };
  } catch {
    return { ...DEFAULTS };
  }
}
function save(s: MicSettings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify({ gate: s.gate, smooth: s.smooth, calibration: s.calibration, deviceId: s.deviceId }));
  } catch {
    // storage blocked: settings last until reload
  }
}

/** live readings for the meter (not React state: they change every frame) */
export const micLive = { db: -120, f1: 0, f2: 0, active: false };

const mic = new MicInput();
let raf = 0;
let lastT = 0;
/** smoothed log formants (model space) */
let s1 = 0, s2 = 0;

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
  prompt: null,
  calibrated: saved.calibration.a1 !== 1 || saved.calibration.b1 !== 0 || saved.calibration.a2 !== 1 || saved.calibration.b2 !== 0,
  inputs: [],
  setOn: (on) => {
    if (!on) {
      stop();
      set({ status: "off", prompt: null });
      cal = null;
      return;
    }
    if (get().status === "on" || get().status === "starting") return;
    set({ status: "starting" });
    void (async () => {
      try {
        await useStore.getState().start();
        if (!engine.ctx) throw new Error("no audio");
        await mic.open(engine.ctx, get().deviceId || undefined);
        set({ status: "on", inputs: await listInputs() });
        s1 = s2 = 0;
        lastT = performance.now();
        cancelAnimationFrame(raf);
        raf = requestAnimationFrame(tick);
      } catch (e) {
        const denied = e instanceof DOMException && (e.name === "NotAllowedError" || e.name === "SecurityError");
        console.error("mic:", e);
        set({ status: denied ? "denied" : "error" });
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
    set({ prompt: STEPS[0].prompt });
  },
  cancelCalibration: () => {
    cal = null;
    set({ prompt: null });
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
  const r = analyzeFormants(frame, ctx.sampleRate);
  micLive.db = r.db;
  const voiced = r.db > m.gate && r.f1 > 0 && r.f2 > 0;
  micLive.active = voiced;
  if (voiced) (micLive.f1 = r.f1), (micLive.f2 = r.f2);

  if (cal) return calibrateStep(voiced, r.f1, r.f2);

  const st = useStore.getState();
  if (!voiced || st.mode !== "play") return;
  const t = applyCalibration(r.f1, r.f2, m.calibration);
  const l1 = Math.log(t.f1), l2 = Math.log(t.f2);
  // one-pole smoothing in log Hz; a fresh start (or a long silence) jumps straight there
  const a = 1 - Math.exp(-dt / Math.max(0.001, m.smooth / 1000));
  if (s1 === 0) (s1 = l1), (s2 = l2);
  else (s1 += a * (l1 - s1)), (s2 += a * (l2 - s2));
  const model = getModel(st.body, ctx.sampleRate);
  st.setArtic(model.articForFormants(Math.exp(s1), Math.exp(s2)), true);
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
  useMic.getState().set({ calibration: fitCalibration(got, target) });
  useMic.setState({ prompt: null, calibrated: true });
  s1 = s2 = 0;
}
