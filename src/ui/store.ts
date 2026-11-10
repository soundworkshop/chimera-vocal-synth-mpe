import { create } from "zustand";
import { engine } from "../audio/AudioEngine.ts";
import { DEFAULT_SOURCE, type VoiceSource } from "../wasm/engine.ts";
import { NEUTRAL, restTip, type HumanArtic } from "../wasm/engine.ts";
import { defaultF0, PRESETS, sameBody, type BodyMix } from "./body.ts";
import { creatureById } from "../wasm/engine.ts";
import type { ParamDef } from "../wasm/types.ts";
import { BEAT_PRESETS, BASS_NOTE, beatReady, parseBeat, type BeatStep } from "../wasm/engine.ts";
import { singNoteOn, singNoteOff, stopSinging, ensureDictionary } from "./singing.ts";
import { stopSpeaking } from "./speech.ts";
import { connectMidi, disconnectMidi, type MidiStatus, type MpeVoice } from "./midi.ts";
import { DEFAULT_REVERB, type ReverbSettings } from "../audio/plateReverb.ts";
import { DEFAULT_DISTORTION, type DistortionSettings } from "../audio/distortion.ts";
import { DEFAULT_TOUCH, touchToBreath, type TouchCurve } from "./touch.ts";
import { assignSlots } from "./voiceSlots.ts";
export { touchToBreath };

/** the live controller, for the curve display: pressure 0..1, or null when nothing is held */
export const mpeLive: { pressure: number | null; breath: number } = { pressure: null, breath: 0 };

/** settings kept across visits (this browser only) */
const SAVED_KEY = "chimera-mpe-settings";
interface Saved {
  touch: TouchCurve;
  reverb: ReverbSettings;
  distortion: DistortionSettings;
  /** two-voice MPE (a second engine; about twice the CPU) */
  /** how many voices play MPE notes (1, 2 or 8) */
  polyphony: number;
}
/** the polyphony choices */
export const POLYPHONY = [1, 2, 8];

function loadSaved(): Saved {
  try {
    const raw = typeof localStorage !== "undefined" ? localStorage.getItem(SAVED_KEY) : null;
    const v = raw ? JSON.parse(raw) : {};
    return { touch: { ...DEFAULT_TOUCH, ...v.touch }, reverb: { ...DEFAULT_REVERB, ...v.reverb }, distortion: { ...DEFAULT_DISTORTION, ...v.distortion }, polyphony: POLYPHONY.includes(v.polyphony) ? v.polyphony : v.twoVoices === false ? 1 : 2 };
  } catch {
    return { touch: { ...DEFAULT_TOUCH }, reverb: { ...DEFAULT_REVERB }, distortion: { ...DEFAULT_DISTORTION }, polyphony: 2 };
  }
}
function save(v: Saved): void {
  try {
    localStorage.setItem(SAVED_KEY, JSON.stringify(v));
  } catch {
    // private window or storage blocked: settings last until reload
  }
}
const saved = loadSaved();
// only stored until the audio starts (no engine call)
engine.setReverb(saved.reverb);
engine.setDistortion(saved.distortion);
engine.setVoices(saved.polyphony);

export type Mode = "play" | "speak" | "sing" | "bestiary" | "beatbox";

export interface BeatState {
  steps: (BeatStep | null)[];
  bpm: number;
  swing: number;
  playing: boolean;
  /** preset the pattern came from (null once edited) */
  preset: string | null;
}

export interface ViewOptions {
  pressure: boolean;
  particles: boolean;
  grid: boolean;
  calipers: boolean;
  /** the face screen shows the head in 3D (turn it with the pointer; no handles) */
  threeD: boolean;
}

interface State {
  started: boolean;
  starting: boolean;
  startError: string | null;
  /** the body shown; while the body pad is dragged it runs ahead of the voice (see previewBody) */
  body: BodyMix;
  source: VoiceSource;
  artic: HumanArtic;
  tipFree: boolean;
  volume: number;
  /** sustained breath (drone) independent of keys */
  hold: boolean;
  heldNotes: number[];
  view: ViewOptions;
  mode: Mode;
  setMode: (m: Mode) => void;
  /** active non-human creature in the bestiary */
  creature: string;
  cparams: Record<string, Record<string, number>>;
  setCreature: (id: string) => void;
  setCParam: (key: string, v: number) => void;
  playCall: (id: string, pitch?: number) => void;
  /** what the keys do in the bestiary: hold the voice at a pitch (null) or trigger this call */
  keyCall: string | null;
  setKeyCall: (id: string | null) => void;
  beat: BeatState;
  /** close-mic sound (proximity bass + compression) in beatbox mode */
  mic: boolean;
  /** hum note for new hum steps: follows the last key played */
  bassNote: number;
  setBeatSteps: (steps: (BeatStep | null)[], preset?: string | null) => void;
  /** one sound per step: set it, or clear the step if that sound is already there */
  toggleBeatStep: (i: number, id: string) => void;
  setBeatTempo: (v: { bpm?: number; swing?: number }) => void;
  setBeatPlaying: (on: boolean) => void;
  loadBeatPreset: (name: string) => void;
  beatHit: (id: string) => void;
  setMic: (on: boolean) => void;
  start: () => Promise<void>;
  /** switch the voice to this body (rebuilds its airway) */
  setBody: (b: BodyMix) => void;
  /** show this body without rebuilding the voice yet (a drag in progress; setBody commits it) */
  previewBody: (b: BodyMix) => void;
  setSource: (v: Partial<VoiceSource>) => void;
  setArtic: (v: Partial<HumanArtic>, tipFree?: boolean) => void;
  setVolume: (v: number) => void;
  setHold: (h: boolean) => void;
  /** a key went down (velocity 1..127; the on-screen keys send 96) */
  noteOn: (midi: number, velocity?: number) => void;
  noteOff: (midi: number) => void;
  midi: { status: MidiStatus; inputs: string[] };
  setMidi: (on: boolean) => void;
  touch: TouchCurve;
  setTouch: (v: Partial<TouchCurve>) => void;
  reverb: ReverbSettings;
  setReverb: (v: Partial<ReverbSettings>) => void;
  distortion: DistortionSettings;
  setDistortion: (v: Partial<DistortionSettings>) => void;
  polyphony: number;
  setPolyphony: (n: number) => void;
  setView: (v: Partial<ViewOptions>) => void;
}

const midiToHz = (m: number) => 440 * Math.pow(2, (m - 69) / 12);

/**
 * Map a key to a creature's pitch range: shift the whole keyboard by whole octaves so middle C
 * lands near the middle of the range (adjacent octaves stay distinct), then fold stragglers in.
 */
export function creatureKeyHz(midi: number, p: Pick<ParamDef, "min" | "max">): number {
  const shift = Math.round(Math.log2(Math.sqrt(p.min * p.max) / midiToHz(60)));
  let f = midiToHz(midi) * Math.pow(2, shift);
  while (f > p.max) f /= 2;
  while (f < p.min) f *= 2;
  return Math.min(p.max, f);
}

function updateGate(s: { hold: boolean; heldNotes: number[]; mode: Mode; keyCall: string | null }) {
  // keys that trigger calls leave the breath to the call; sung notes breathe by themselves
  const keysBreathe = !(s.mode === "bestiary" && s.keyCall) && s.mode !== "sing";
  engine.gate(s.hold || (keysBreathe && s.heldNotes.length > 0) ? 1 : 0);
}

/**
 * MPE in Play mode: the highest held note sounds (high-note priority), at its note plus its
 * channel's pitch bend, with its pressure scaling the Breath knob (the knob is the full-pressure
 * breath). These go to the engine directly, not through the store: pitch bend and pressure arrive
 * hundreds of times a second. The Keys readout catches up once a frame.
 *
 * The pitch glide is cut to a few ms while MPE notes are held, or the default 60 ms glide would
 * smooth away vibrato and slides. Glide and breath go back to the knobs a moment after the last
 * note lets go (not at once: the breath's release would jump back up to the knob's level).
 */
const MPE_GLIDE = 0.004;
let mpeActive = false;
let mpeRestore: ReturnType<typeof setTimeout> | null = null;
let mpeFrame = 0;
let mpeF0 = 0;

/** each voice's MPE channel (index 0: the main voice, 1…: the others) */
let slots: (string | null)[] = [null];
/**
 * The extra voices (1…): awake while they have a note, with the gate open; a voice without one
 * is silent at pressure 0, and after a moment (its release rings out) shuts its gate and sleeps,
 * costing nothing. The main voice (0) never sleeps.
 */
let awake: boolean[] = [];
let sleepTimers: (ReturnType<typeof setTimeout> | undefined)[] = [];
const SLEEP_AFTER = 400;

function wake(i: number): void {
  clearTimeout(sleepTimers[i]);
  sleepTimers[i] = undefined;
  if (awake[i]) return;
  awake[i] = true;
  engine.sleepVoice(i, false);
  engine.gateVoice(i, 1);
}

function idle(i: number): void {
  if (!awake[i] || sleepTimers[i]) return;
  sleepTimers[i] = setTimeout(() => {
    sleepTimers[i] = undefined;
    awake[i] = false;
    engine.gateVoice(i, 0);
    engine.sleepVoice(i, true);
  }, SLEEP_AFTER);
}

/** The voices were rebuilt (polyphony changed): all extras start asleep. */
function forgetVoices(): void {
  sleepTimers.forEach((t) => clearTimeout(t));
  sleepTimers = [];
  awake = [];
}

/** Forget the voices' notes; the extra ones fall asleep after their release (mode switch, MIDI off). */
function resetMpe(): void {
  slots = slots.map(() => null);
  for (let i = 1; i < awake.length; i++) idle(i);
  mpeLive.pressure = null;
  mpeLive.breath = 0;
}

function applyMpe(voices: MpeVoice[], sendsPressure: boolean): void {
  const s = useStore.getState();
  if (s.mode !== "play") return;
  if (!voices.length) {
    resetMpe();
    if (mpeActive && !mpeRestore)
      mpeRestore = setTimeout(() => {
        mpeRestore = null;
        mpeActive = false;
        const t = useStore.getState();
        engine.setSource({ glide: t.source.glide, pressure: t.source.pressure });
      }, 400);
    return;
  }
  if (mpeRestore) clearTimeout(mpeRestore), (mpeRestore = null);
  mpeActive = true;
  const n = s.polyphony;
  if (slots.length !== n) slots = Array.from({ length: n }, (_, i) => slots[i] ?? null);
  const playing = assignSlots(slots, voices);
  // the volume envelope (breath after the touch curve, 0..1): the louder voice's, as the two
  // share one mouth
  let env = 0;
  playing.forEach((v, i) => {
    const voice = i;
    // a voice with no note: silent (its gate stays open a moment, so a quick next note starts
    // at once), then asleep
    if (!v) {
      if (i > 0) idle(i);
      return engine.setSourceNow({ pressure: 0, glide: MPE_GLIDE }, voice);
    }
    if (i > 0) wake(i);
    // no pressure from this controller: the knob's breath, as before; pressure not yet sent for
    // this note (it follows the note-on): silent until it arrives
    const amount = v.pressure === null ? (sendsPressure ? 0 : 1) : touchToBreath(v.pressure, s.touch);
    env = Math.max(env, amount);
    const f0 = midiToHz(v.note + v.bend);
    engine.setSourceNow({ f0, glide: MPE_GLIDE, pressure: amount * s.source.pressure }, voice);
    if (i === 0) mpeF0 = f0;
  });
  mpeLive.breath = env;
  const main = playing[0] ?? playing[1];
  mpeLive.pressure = main ? (main.pressure ?? (sendsPressure ? 0 : null)) : null;
  if (!mpeFrame)
    mpeFrame = requestAnimationFrame(() => {
      mpeFrame = 0;
      useStore.setState((t) => ({ source: { ...t.source, f0: mpeF0 } }));
    });
}

const saveAll = () => {
  const s = useStore.getState();
  save({ touch: s.touch, reverb: s.reverb, distortion: s.distortion, polyphony: s.polyphony });
};

let startPromise: Promise<void> | null = null;

/**
 * A key pressed before the audio exists is sent once it does: only if that same press is still
 * down (not a later press of the same key) and the mode and body have not changed since.
 */
let pressSerial = 0;
const pressOf = new Map<number, number>();
let session = 0;

const FIRST_BEAT = BEAT_PRESETS[0];

export const useStore = create<State>((set, get) => ({
  started: false,
  starting: false,
  startError: null,
  body: PRESETS.male,
  source: { ...DEFAULT_SOURCE },
  artic: (() => {
    const tip = restTip(NEUTRAL.jaw, NEUTRAL.tbX, NEUTRAL.tbY);
    return { ...NEUTRAL, ttX: tip.x, ttY: tip.y };
  })(),
  tipFree: true,
  volume: 0.8,
  hold: false,
  heldNotes: [],
  view: { pressure: true, particles: true, grid: false, calipers: true, threeD: false },
  mode: "play",
  setMode: (m) => {
    const prev = get().mode;
    if (prev === m) return;
    session++;
    // notes held across the switch would keep breathing into the other voice
    set({ mode: m, heldNotes: [] });
    // the second voice only plays MPE in Play mode
    resetMpe();
    // speech belongs to Speak: under a creature the human clock stops and it would resume later
    if (prev === "speak" || m === "bestiary") stopSpeaking();
    if ((prev === "bestiary") !== (m === "bestiary")) {
      // a sustain belongs to the voice it was started on
      set({ hold: false });
      const s = get();
      engine.setCreature(m === "bestiary" ? s.creature : "human", s.cparams[s.creature]);
    }
    if (prev === "beatbox") {
      get().setBeatPlaying(false);
      engine.setMic(false);
    }
    if (prev === "sing") stopSinging();
    // speech and song breathe by themselves: a held breath would drone under them
    if (m === "speak" || m === "sing") set({ hold: false });
    if (m === "sing") ensureDictionary();
    if (m === "beatbox") {
      // a beatboxer waits with the jaw nearly closed; the sounds bring their own breath
      set({ hold: false });
      get().setArtic(beatReady(get().body));
      engine.setMic(get().mic);
    }
    updateGate(get());
  },
  creature: "songbird",
  cparams: {},
  keyCall: null,
  setKeyCall: (id) => {
    set({ keyCall: id, heldNotes: [] });
    updateGate(get());
  },
  beat: { steps: parseBeat(FIRST_BEAT.text), bpm: FIRST_BEAT.bpm, swing: FIRST_BEAT.swing, playing: false, preset: FIRST_BEAT.name },
  mic: true,
  bassNote: BASS_NOTE,
  setBeatSteps: (steps, preset = null) => {
    set((s) => ({ beat: { ...s.beat, steps, preset } }));
    engine.setBeat({ steps });
  },
  toggleBeatStep: (i, id) => {
    const steps = get().beat.steps.slice();
    steps[i] = steps[i]?.id === id ? null : id === "m" ? { id, note: get().bassNote } : { id };
    get().setBeatSteps(steps);
  },
  setBeatTempo: (v) => {
    set((s) => ({ beat: { ...s.beat, ...v } }));
    engine.setBeat(v);
  },
  setBeatPlaying: (on) => {
    if (on === get().beat.playing) return;
    set((s) => ({ beat: { ...s.beat, playing: on } }));
    if (!on) {
      engine.setBeat({ playing: false });
      return;
    }
    void get()
      .start()
      .then(() => {
        const b = get().beat;
        if (get().started && b.playing) engine.setBeat({ steps: b.steps, bpm: b.bpm, swing: b.swing, playing: true });
      });
  },
  loadBeatPreset: (name) => {
    const p = BEAT_PRESETS.find((x) => x.name === name);
    if (!p) return;
    get().setBeatSteps(parseBeat(p.text), p.name);
    get().setBeatTempo({ bpm: p.bpm, swing: p.swing });
  },
  beatHit: (id) => {
    void get()
      .start()
      .then(() => {
        if (get().started) engine.beatHit(id, id === "m" ? get().bassNote : undefined);
      });
  },
  setMic: (on) => {
    set({ mic: on });
    if (get().mode === "beatbox") engine.setMic(on);
  },
  setCreature: (id) => {
    if (id === get().creature) return;
    set({ creature: id, keyCall: null, heldNotes: [] });
    if (get().mode === "bestiary") engine.setCreature(id, get().cparams[id]);
    updateGate(get());
  },
  setCParam: (key, v) => {
    const id = get().creature;
    set((s) => ({ cparams: { ...s.cparams, [id]: { ...(s.cparams[id] ?? {}), [key]: v } } }));
    engine.setCreatureParams({ [key]: v });
  },
  playCall: (id, pitch) => {
    void get()
      .start()
      .then(() => {
        if (get().started) engine.playCall(id, pitch);
      });
  },
  start: () => {
    if (get().started) return Promise.resolve();
    if (startPromise) return startPromise;
    set({ starting: true, startError: null });
    startPromise = (async () => {
      try {
        await engine.start();
        // anything set before audio existed was not delivered: send the whole state now
        const s = get();
        engine.setVolume(s.volume);
        if (!sameBody(s.body, PRESETS.male)) engine.setBody(s.body);
        engine.setSource(s.source);
        engine.setArtic(s.artic, s.tipFree);
        if (s.mode === "bestiary") engine.setCreature(s.creature, s.cparams[s.creature]);
        if (s.mode === "beatbox") {
          engine.setMic(s.mic);
          engine.setBeat({ steps: s.beat.steps, bpm: s.beat.bpm, swing: s.beat.swing, playing: s.beat.playing });
        }
        updateGate(s);
        set({ started: true, starting: false });
      } catch (e) {
        set({ starting: false, startError: e instanceof Error ? e.message : String(e) });
      } finally {
        startPromise = null;
      }
    })();
    return startPromise;
  },
  setBody: (b) => {
    session++;
    // the new voice starts without the old one's score: a sung note would hang
    if (get().mode === "sing") stopSinging();
    const f0 = defaultF0(b);
    // nor does speech carry over (and the new voice's clock starts again from zero)
    if (get().mode === "speak") stopSpeaking();
    set((s) => ({ body: b, source: { ...s.source, f0 } }));
    engine.setBody(b);
  },
  previewBody: (b) => set({ body: b }),
  setSource: (v) => {
    set((s) => ({ source: { ...s.source, ...v } }));
    engine.setSource(v);
  },
  setArtic: (v, tipFree) => {
    set((s) => ({ artic: { ...s.artic, ...v }, tipFree: tipFree ?? s.tipFree }));
    engine.setArtic(v, tipFree);
  },
  setVolume: (v) => {
    set({ volume: v });
    engine.setVolume(v);
  },
  setHold: (h) => {
    set({ hold: h });
    updateGate(get());
  },
  noteOn: (midi, velocity = 96) => {
    const held = get().heldNotes.filter((n) => n !== midi).concat(midi);
    set({ heldNotes: held });
    const s = get();
    const press = ++pressSerial;
    pressOf.set(midi, press);
    // a sung note or a call is a one-off message, lost if sent before the audio exists (held
    // pitches and breath are resent at startup): send it once audio is up, if still pressed
    if (!s.started && (s.mode === "sing" || (s.mode === "bestiary" && s.keyCall))) {
      const sess = session;
      void s.start().then(() => {
        const t = get();
        if (t.started && session === sess && pressOf.get(midi) === press) t.noteOn(midi, velocity);
      });
      return;
    }
    if (s.mode === "sing") singNoteOn(midi, velocity, s.body);
    else if (s.mode === "bestiary") {
      const pp = creatureById(s.creature)?.params.find((p) => p.role === "pitch");
      const f = pp ? creatureKeyHz(midi, pp) : undefined;
      if (s.keyCall) s.playCall(s.keyCall, f);
      else if (pp && f) s.setCParam(pp.key, f);
    } else if (s.mode === "beatbox") {
      // keys hum a bass note under the beat (lips shut, nose open); new hum steps take it too
      set({ bassNote: midi });
      if (held.length === 1) s.setArtic({ lipAp: -0.25, velum: 0.9 });
      s.setSource({ f0: midiToHz(midi) });
    } else s.setSource({ f0: midiToHz(midi) });
    updateGate(get());
  },
  noteOff: (midi) => {
    pressOf.delete(midi);
    const held = get().heldNotes.filter((n) => n !== midi);
    set({ heldNotes: held });
    const s = get();
    if (s.mode === "sing") {
      singNoteOff(midi, s.body);
      return;
    }
    if (s.mode === "beatbox" && !held.length) s.setArtic({ lipAp: beatReady(s.body).lipAp, velum: NEUTRAL.velum });
    if (held.length) {
      // fall back to the most recent note still held (legato)
      const last = held[held.length - 1];
      if (s.mode !== "bestiary") s.setSource({ f0: midiToHz(last) });
      else if (!s.keyCall) {
        const pp = creatureById(s.creature)?.params.find((p) => p.role === "pitch");
        if (pp) s.setCParam(pp.key, creatureKeyHz(last, pp));
      }
    }
    updateGate(get());
  },
  setView: (v) => set((s) => ({ view: { ...s.view, ...v } })),
  midi: { status: "off", inputs: [] },
  touch: saved.touch,
  setTouch: (v) => {
    set((s) => ({ touch: { ...s.touch, ...v } }));
    saveAll();
  },
  polyphony: saved.polyphony,
  setPolyphony: (n) => {
    resetMpe();
    if (!POLYPHONY.includes(n)) return;
    set({ polyphony: n });
    engine.setVoices(n);
    forgetVoices();
    saveAll();
  },
  distortion: saved.distortion,
  setDistortion: (v) => {
    set((s) => ({ distortion: { ...s.distortion, ...v } }));
    engine.setDistortion(v);
    saveAll();
  },
  reverb: saved.reverb,
  setReverb: (v) => {
    set((s) => ({ reverb: { ...s.reverb, ...v } }));
    engine.setReverb(v);
    saveAll();
  },
  setMidi: (on) => {
    const noteOff = (n: number) => get().noteOff(n);
    if (!on) {
      disconnectMidi();
      set({ midi: { status: "off", inputs: [] } });
      return;
    }
    set({ midi: { status: "connecting", inputs: [] } });
    // the click that connects is also the gesture that may start audio
    void get().start();
    connectMidi({
      noteOn: (n, v) => {
        void get().start();
        get().noteOn(n, v);
      },
      noteOff,
      expression: applyMpe,
      inputs: (names) => set({ midi: { status: "on", inputs: names } }),
    }).catch(() => {
      if (get().midi.status === "connecting") set({ midi: { status: "denied", inputs: [] } });
    });
  },
}));
