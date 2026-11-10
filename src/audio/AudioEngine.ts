/**
 * Main-thread side of the audio engine: AudioContext + worklet node + analyser, coalesced
 * parameter messages (at most one per animation frame per kind) and telemetry fan-out.
 */
import workletUrl from "../worklet/processor.ts?worker&url";
import reverbUrl from "./reverbWorklet.ts?worker&url";
import { DEFAULT_REVERB, type ReverbSettings } from "./plateReverb.ts";
import { DEFAULT_DISTORTION, driveMakeup, levelGain, shapeCurve, toneHz, type DistortionSettings } from "./distortion.ts";
import { chimeraModule } from "../wasm/chimera.ts";
import type { ToWorklet, FromWorklet, TelemetryMessage, PlannedMessage, CreatureTelemetryMessage } from "../worklet/protocol.ts";
import type { BodyMix } from "../wasm/types.ts";
import type { HumanArtic } from "../wasm/types.ts";
import type { VoiceSource } from "../wasm/types.ts";

type Listener = (t: TelemetryMessage) => void;

export class AudioEngine {
  ctx: AudioContext | null = null;
  private node: AudioWorkletNode | null = null;
  analyser: AnalyserNode | null = null;
  /** unsmoothed, short-window analyser for the spectrogram */
  analyserFast: AnalyserNode | null = null;
  /** long time-domain window for the waveform scope */
  analyserScope: AnalyserNode | null = null;
  private master: GainNode | null = null;
  /** plate reverb after the master (the analysers read the dry voice) */
  private reverb: AudioWorkletNode | null = null;
  private reverbSettings: ReverbSettings = { ...DEFAULT_REVERB };
  /**
   * Second voice (two-voice MPE): another engine instance, created only while two voices are on.
   * It mirrors the first voice's body, articulation and tone (same mouth, same formants); only
   * its pitch, glide, breath and gate are its own. Both feed the same distortion and reverb.
   */
  private node2: AudioWorkletNode | null = null;
  private twoVoices = false;
  private mirrorBody: BodyMix | null = null;
  private mirrorArtic: Partial<HumanArtic> = {};
  private mirrorTipFree: boolean | undefined;
  private mirrorSource: Partial<VoiceSource> = {};
  /** distortion between the voice (or its close-mic chain) and the master */
  private dist: { input: GainNode; shaper: WaveShaperNode; tone: BiquadFilterNode; makeup: GainNode; wet: GainNode; dry: GainNode; level: GainNode } | null = null;
  private distSettings: DistortionSettings = { ...DEFAULT_DISTORTION };
  private distDrive = -1;
  /** "close mic" chain: proximity bass, presence, compression (beatboxers cup the mic) */
  private micIn: AudioNode | null = null;
  private micOn = false;
  latest: TelemetryMessage | null = null;
  /** performance.now() when `latest` arrived */
  private latestAt = 0;
  latestCreature: CreatureTelemetryMessage | null = null;
  /** load of the most recent telemetry of either kind */
  load = 0;
  sampleRate = 48000;
  private listeners = new Set<Listener>();
  private pendingArtic: Partial<HumanArtic> | null = null;
  private pendingTipFree: boolean | undefined;
  private pendingSource: Partial<VoiceSource> | null = null;
  private pendingCParams: Record<string, number> | null = null;
  private flushScheduled = false;
  private readyListeners = new Set<() => void>();
  private plannedListeners = new Set<(p: PlannedMessage) => void>();
  /** most recent planned utterance (for timelines) */
  lastPlan: PlannedMessage | null = null;
  private speakId = 0;
  error: string | null = null;

  /** The human voice's clock now (s), extrapolated from the latest telemetry; null if none. */
  voiceClock(): number | null {
    if (!this.latest) return null;
    return this.latest.t.clock + Math.min(0.25, (performance.now() - this.latestAt) / 1000);
  }

  get running(): boolean {
    return !!this.ctx && this.ctx.state === "running";
  }

  async start(): Promise<void> {
    if (this.ctx) {
      await this.ctx.resume();
      return;
    }
    const ctx = new AudioContext({ latencyHint: "interactive" });
    this.ctx = ctx;
    this.sampleRate = ctx.sampleRate;
    await ctx.audioWorklet.addModule(workletUrl);
    // the worklet instantiates the engine from the module compiled at startup (main.tsx)
    const node = new AudioWorkletNode(ctx, "chimera", { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2], processorOptions: { module: chimeraModule() } });
    this.node = node;
    const master = ctx.createGain();
    master.gain.value = 0.8;
    this.master = master;
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 4096;
    analyser.smoothingTimeConstant = 0.6;
    this.analyser = analyser;
    const fast = ctx.createAnalyser();
    fast.fftSize = 2048;
    fast.smoothingTimeConstant = 0;
    this.analyserFast = fast;
    const scope = ctx.createAnalyser();
    scope.fftSize = 16384;
    this.analyserScope = scope;
    // close-mic chain: proximity effect (low shelf), presence peak, fast compressor, make-up
    const shelf = ctx.createBiquadFilter();
    shelf.type = "lowshelf";
    shelf.frequency.value = 120;
    shelf.gain.value = 9;
    const presence = ctx.createBiquadFilter();
    presence.type = "peaking";
    presence.frequency.value = 3500;
    presence.Q.value = 0.8;
    presence.gain.value = 3;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -28;
    comp.knee.value = 8;
    comp.ratio.value = 5;
    comp.attack.value = 0.002;
    comp.release.value = 0.12;
    const makeup = ctx.createGain();
    makeup.gain.value = 2.2;
    // distortion: input → (shaper → tone → makeup → wet) + dry → level → master
    const dist = {
      input: ctx.createGain(),
      shaper: ctx.createWaveShaper(),
      tone: ctx.createBiquadFilter(),
      makeup: ctx.createGain(),
      wet: ctx.createGain(),
      dry: ctx.createGain(),
      level: ctx.createGain(),
    };
    dist.shaper.oversample = "4x";
    dist.tone.type = "lowpass";
    dist.tone.Q.value = Math.SQRT1_2; // Butterworth: flat until the cutoff
    dist.input.connect(dist.shaper).connect(dist.tone).connect(dist.makeup).connect(dist.wet).connect(dist.level);
    dist.input.connect(dist.dry).connect(dist.level);
    dist.level.connect(master);
    this.dist = dist;
    this.applyDistortion(0);
    shelf.connect(presence).connect(comp).connect(makeup).connect(dist.input);
    this.micIn = shelf;
    node.connect(this.micOn ? shelf : dist.input);
    if (this.twoVoices) this.createVoice2();
    // the reverb is optional: if its module fails to load, the voice still plays dry
    try {
      await ctx.audioWorklet.addModule(reverbUrl);
      this.reverb = new AudioWorkletNode(ctx, "chimera-plate", { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2] });
      this.applyReverb(0);
    } catch (e) {
      console.error("reverb:", e);
      this.reverb = null;
    }
    if (this.reverb) master.connect(this.reverb).connect(ctx.destination);
    else master.connect(ctx.destination);
    master.connect(analyser);
    master.connect(fast);
    master.connect(scope);
    node.port.onmessage = (e: MessageEvent<FromWorklet>) => {
      const m = e.data;
      if (m.type === "telemetry") {
        this.latest = m;
        this.latestAt = performance.now();
        this.latestCreature = null;
        this.load = m.load;
        for (const l of this.listeners) l(m);
      } else if (m.type === "ctelemetry") {
        this.latestCreature = m;
        this.latest = null;
        this.load = m.load;
      } else if (m.type === "planned") {
        this.lastPlan = m;
        for (const l of this.plannedListeners) l(m);
      } else if (m.type === "ready") {
        for (const l of this.readyListeners) l();
      } else if (m.type === "error") {
        this.error = m.message;
        console.error("worklet:", m.message);
      }
    };
    await ctx.resume();
  }

  onTelemetry(l: Listener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  onPlanned(l: (p: PlannedMessage) => void): () => void {
    this.plannedListeners.add(l);
    return () => this.plannedListeners.delete(l);
  }

  /** Send a gestural plan (times relative to now). Returns the request id. */
  schedule(plan: { gestures: import("../wasm/types.ts").Gesture[]; segments: import("../wasm/types.ts").PlannedSegment[]; end: number }, replace = true): number {
    const id = ++this.speakId;
    this.send({ type: "schedule", gestures: plan.gestures, segments: plan.segments, end: plan.end, id, replace });
    return id;
  }

  /** Switch voice ("human" or a creature id), starting the creature from the given settings. */
  setCreature(id: string, params?: Record<string, number>): void {
    // settings still waiting for the next frame belong to the previous creature
    this.pendingCParams = null;
    this.send({ type: "creature", id, params });
  }

  setCreatureParams(values: Record<string, number>): void {
    this.pendingCParams = { ...(this.pendingCParams ?? {}), ...values };
    this.scheduleFlush();
  }

  playCall(id: string, pitch?: number, amp?: number): void {
    this.send({ type: "call", id, pitch, amp });
  }

  stopCall(): void {
    this.send({ type: "stopCall" });
  }

  stopSpeech(): void {
    this.send({ type: "stopSpeech" });
  }

  onReady(l: () => void): () => void {
    this.readyListeners.add(l);
    return () => this.readyListeners.delete(l);
  }

  private send(m: ToWorklet): void {
    this.node?.port.postMessage(m);
  }

  /** Route the voice through the close-mic chain (on) or straight to the output (off). */
  setMic(on: boolean): void {
    if (on === this.micOn) return;
    this.micOn = on;
    if (!this.node || !this.dist || !this.micIn) return;
    this.node.disconnect();
    this.node.connect(on ? this.micIn : this.dist.input);
    if (this.node2) {
      this.node2.disconnect();
      this.node2.connect(on ? this.micIn : this.dist.input);
    }
  }

  setBeat(m: { steps?: import("../wasm/types.ts").BeatStep[] | (import("../wasm/types.ts").BeatStep | null)[]; bpm?: number; swing?: number; playing?: boolean }): void {
    this.send({ type: "beat", ...m });
  }

  /** End the sung note (open-ended gestures) with this tag. */
  release(tag: number): void {
    this.send({ type: "release", tag });
  }

  /** Gestures planned on the main thread, times relative to arrival + lead (live playing). */
  scheduleGestures(gestures: import("../wasm/types.ts").Gesture[], lead = 0.006): void {
    this.send({ type: "schedule", gestures, segments: [], end: 0, id: ++this.speakId, replace: false, lead });
  }

  beatHit(id: string, note?: number, accent?: number): void {
    this.send({ type: "beatHit", id, note, accent });
  }

  setVolume(v: number): void {
    if (this.master && this.ctx) this.master.gain.setTargetAtTime(v, this.ctx.currentTime, 0.02);
  }

  setBody(body: BodyMix): void {
    this.mirrorBody = body;
    this.send({ type: "body", body });
    this.node2?.port.postMessage({ type: "body", body } satisfies ToWorklet);
  }

  /** Turn the second voice on or off (created now, or when audio starts). */
  setTwoVoices(on: boolean): void {
    this.twoVoices = on;
    if (!this.ctx) return;
    if (on && !this.node2) this.createVoice2();
    else if (!on && this.node2) {
      this.node2.port.onmessage = null;
      this.node2.disconnect();
      this.node2 = null;
    }
  }

  private createVoice2(): void {
    const ctx = this.ctx, dist = this.dist;
    if (!ctx || !dist || this.node2) return;
    const node = new AudioWorkletNode(ctx, "chimera", { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2], processorOptions: { module: chimeraModule() } });
    node.port.onmessage = (e: MessageEvent<FromWorklet>) => {
      if (e.data.type === "error") console.error("voice 2:", e.data.message);
    };
    const send = (m: ToWorklet) => node.port.postMessage(m);
    // nothing reads its telemetry: skip the work
    send({ type: "telemetry", enabled: false });
    if (this.mirrorBody) send({ type: "body", body: this.mirrorBody });
    send({ type: "artic", values: this.mirrorArtic, tipFree: this.mirrorTipFree });
    send({ type: "source", values: this.mirrorSource });
    send({ type: "gate", level: 0 });
    node.connect(this.micOn && this.micIn ? this.micIn : dist.input);
    this.node2 = node;
  }

  /** The second voice's breath gate (0 shut … 1 open). */
  gate2(level: number): void {
    this.node2?.port.postMessage({ type: "gate", level } satisfies ToWorklet);
  }

  gate(level: number): void {
    this.send({ type: "gate", level });
  }

  /** Coalesced: many calls within a frame become one message. */
  setArtic(values: Partial<HumanArtic>, tipFree?: boolean): void {
    this.pendingArtic = { ...(this.pendingArtic ?? {}), ...values };
    if (tipFree !== undefined) this.pendingTipFree = tipFree;
    this.scheduleFlush();
  }

  /** Distortion knobs (each 0..1); kept for when audio starts. */
  setDistortion(values: Partial<DistortionSettings>): void {
    this.distSettings = { ...this.distSettings, ...values };
    this.applyDistortion(0.02);
  }

  private applyDistortion(smooth: number): void {
    const d = this.dist, ctx = this.ctx;
    if (!d || !ctx) return;
    const s = this.distSettings;
    // the curve is rebuilt only when drive moves (a 4096-point table)
    if (s.drive !== this.distDrive) {
      d.shaper.curve = shapeCurve(s.drive);
      this.distDrive = s.drive;
    }
    const set = (p: AudioParam, v: number) => (smooth > 0 ? p.setTargetAtTime(v, ctx.currentTime, smooth) : (p.value = v));
    set(d.makeup.gain, driveMakeup(s.drive));
    set(d.tone.frequency, toneHz(s.tone));
    // equal-power crossfade, so half-way isn't a dip
    set(d.wet.gain, Math.sin((s.mix * Math.PI) / 2));
    set(d.dry.gain, Math.cos((s.mix * Math.PI) / 2));
    set(d.level.gain, levelGain(s.level));
  }

  /** Reverb knobs (each 0..1); kept for when audio starts. */
  setReverb(values: Partial<ReverbSettings>): void {
    this.reverbSettings = { ...this.reverbSettings, ...values };
    this.applyReverb(0.03);
  }

  private applyReverb(smooth: number): void {
    if (!this.reverb || !this.ctx) return;
    for (const [k, v] of Object.entries(this.reverbSettings)) {
      const p = this.reverb.parameters.get(k);
      if (!p) continue;
      if (smooth > 0) p.setTargetAtTime(v, this.ctx.currentTime, smooth);
      else p.value = v;
    }
  }

  /**
   * Sent now, not at the next frame: a live controller (MPE pitch bend, pressure) moves faster
   * than 60 Hz, and frame-rate steps would zipper. Drops the same keys from the frame's pending
   * batch, which would otherwise arrive later and undo these.
   */
  setSourceNow(values: Partial<VoiceSource>, voice: 0 | 1 = 0): void {
    if (voice === 1) {
      this.node2?.port.postMessage({ type: "source", values } satisfies ToWorklet);
      return;
    }
    if (this.pendingSource) for (const k of Object.keys(values) as (keyof VoiceSource)[]) delete this.pendingSource[k];
    this.send({ type: "source", values });
  }

  setSource(values: Partial<VoiceSource>): void {
    this.pendingSource = { ...(this.pendingSource ?? {}), ...values };
    this.scheduleFlush();
  }

  private scheduleFlush(): void {
    if (this.flushScheduled) return;
    this.flushScheduled = true;
    const flush = () => {
      this.flushScheduled = false;
      if (this.pendingArtic || this.pendingTipFree !== undefined) {
        const m: ToWorklet = { type: "artic", values: this.pendingArtic ?? {}, tipFree: this.pendingTipFree };
        this.send(m);
        this.node2?.port.postMessage(m);
        this.mirrorArtic = { ...this.mirrorArtic, ...m.values };
        if (m.tipFree !== undefined) this.mirrorTipFree = m.tipFree;
        this.pendingArtic = null;
        this.pendingTipFree = undefined;
      }
      if (this.pendingSource) {
        this.send({ type: "source", values: this.pendingSource });
        // the second voice shares the tone, not the pitch, glide or breath
        const { f0: _f, pressure: _p, glide: _g, ...shared } = this.pendingSource;
        if (Object.keys(shared).length) {
          this.mirrorSource = { ...this.mirrorSource, ...shared };
          this.node2?.port.postMessage({ type: "source", values: shared } satisfies ToWorklet);
        }
        this.pendingSource = null;
      }
      if (this.pendingCParams) {
        this.send({ type: "cparams", values: this.pendingCParams });
        this.pendingCParams = null;
      }
    };
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(flush);
    else setTimeout(flush, 16);
  }
}

export const engine = new AudioEngine();
