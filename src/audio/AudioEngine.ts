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
  /** the last node before the speakers (what a recording should hear) */
  private out: AudioNode | null = null;
  private reverbSettings: ReverbSettings = { ...DEFAULT_REVERB };
  /**
   * Polyphony: voices 2…N, each another engine instance, created only while polyphony is on. They
   * mirror the first voice's body, articulation and tone (same mouth, same formants); only their
   * pitch, glide, breath and gate are their own. All feed the same distortion and reverb. A voice
   * with no note sleeps (renders nothing), so the cost is the notes held: they all share the
   * browser's one audio thread. (A lighter 1× airway for the extras was tried and ran away into
   * noise under live playing; the engine now refuses an internal rate under 60 kHz.)
   */
  private extras: { node: AudioWorkletNode; asleep: boolean }[] = [];
  private voiceCount = 1;
  /** the airway oversampling the extra voices were built with (0: the default) */
  private extrasOs = -1;
  private mirrorBody: BodyMix | null = null;
  private mirrorArtic: Partial<HumanArtic> = {};
  private mirrorTipFree: boolean | undefined;
  private mirrorSource: Partial<VoiceSource> = {};
  /** distortion between the voice (or its close-mic chain) and the master */
  private dist: { input: GainNode; shaper: WaveShaperNode; tone: BiquadFilterNode; makeup: GainNode; wet: GainNode; dry: GainNode; level: GainNode } | null = null;
  private distSettings: DistortionSettings = { ...DEFAULT_DISTORTION };
  /** the drive and type the shaper's curve was built for */
  private distCurve = "";
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
    this.syncVoices();
    // the reverb is optional: if its module fails to load, the voice still plays dry
    try {
      await ctx.audioWorklet.addModule(reverbUrl);
      this.reverb = new AudioWorkletNode(ctx, "chimera-plate", { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2] });
      this.applyReverb(0);
    } catch (e) {
      console.error("reverb:", e);
      this.reverb = null;
    }
    this.out = this.reverb ?? master;
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
    for (const x of this.extras) {
      x.node.disconnect();
      x.node.connect(on ? this.micIn : this.dist.input);
    }
  }

  setBeat(m: { steps?: import("../wasm/types.ts").BeatStep[] | (import("../wasm/types.ts").BeatStep | null)[]; bpm?: number; swing?: number; playing?: boolean }): void {
    this.send({ type: "beat", ...m });
  }

  /** End the sung note (open-ended gestures) with this tag. */
  release(tag: number): void {
    this.send({ type: "release", tag });
    // the other voices share the mouth: they get the same gestures (silent outside Play); a
    // sleeping one would play them late on waking, so it doesn't
    this.toAwake({ type: "release", tag });
  }

  /** Gestures planned on the main thread, times relative to arrival + lead (live playing). */
  scheduleGestures(gestures: import("../wasm/types.ts").Gesture[], lead = 0.006): void {
    const m: ToWorklet = { type: "schedule", gestures, segments: [], end: 0, id: ++this.speakId, replace: false, lead };
    this.send(m);
    this.toAwake(m);
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
    this.toExtras({ type: "body", body });
  }

  /** How many voices play (1 … 8): the extra ones are created now, or when audio starts. */
  setVoices(n: number): void {
    this.voiceCount = Math.max(1, Math.min(8, Math.round(n)));
    this.syncVoices();
  }

  private syncVoices(): void {
    const ctx = this.ctx, dist = this.dist;
    if (!ctx || !dist) return;
    const want = this.voiceCount - 1;
    // every voice the full, stable airway (see above)
    const os = 0;
    // a different airway for the extras: build them again
    if (os !== this.extrasOs) {
      this.removeExtras(0);
      this.extrasOs = os;
    }
    this.removeExtras(want);
    while (this.extras.length < want) {
      const node = new AudioWorkletNode(ctx, "chimera", { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2], processorOptions: { module: chimeraModule(), oversample: os } });
      const n = this.extras.length + 2;
      node.port.onmessage = (e: MessageEvent<FromWorklet>) => {
        if (e.data.type === "error") console.error(`voice ${n}:`, e.data.message);
      };
      const send = (m: ToWorklet) => node.port.postMessage(m);
      // nothing reads its telemetry: skip the work
      send({ type: "telemetry", enabled: false });
      if (this.mirrorBody) send({ type: "body", body: this.mirrorBody });
      send({ type: "artic", values: this.mirrorArtic, tipFree: this.mirrorTipFree });
      send({ type: "source", values: this.mirrorSource });
      send({ type: "gate", level: 0 });
      // asleep until it gets a note
      send({ type: "sleep", asleep: true });
      node.connect(this.micOn && this.micIn ? this.micIn : dist.input);
      this.extras.push({ node, asleep: true });
    }
  }

  /** Remove the extra voices beyond the first `keep`. */
  private removeExtras(keep: number): void {
    while (this.extras.length > keep) {
      const x = this.extras.pop()!;
      x.node.port.onmessage = null;
      x.node.disconnect();
    }
  }

  private toExtras(m: ToWorklet): void {
    for (const x of this.extras) x.node.port.postMessage(m);
  }

  private toAwake(m: ToWorklet): void {
    for (const x of this.extras) if (!x.asleep) x.node.port.postMessage(m);
  }

  /** Voice `voice`'s (1 … N-1: the extra ones) breath gate, 0 shut … 1 open. */
  gateVoice(voice: number, level: number): void {
    this.extras[voice - 1]?.node.port.postMessage({ type: "gate", level } satisfies ToWorklet);
  }

  /** Put an extra voice to sleep (no note: renders nothing) or wake it. */
  sleepVoice(voice: number, asleep: boolean): void {
    const x = this.extras[voice - 1];
    if (!x || x.asleep === asleep) return;
    x.asleep = asleep;
    x.node.port.postMessage({ type: "sleep", asleep } satisfies ToWorklet);
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

  /**
   * What the speakers hear, for recording: a tap on the engine's output (after distortion and
   * reverb), not a microphone, so the room and the performer's own voice stay out. Null before
   * audio starts. Release it with releaseTap.
   */
  recordTap(): MediaStreamAudioDestinationNode | null {
    if (!this.ctx || !this.out) return null;
    const dest = this.ctx.createMediaStreamDestination();
    this.out.connect(dest);
    return dest;
  }

  releaseTap(dest: MediaStreamAudioDestinationNode): void {
    try {
      this.out?.disconnect(dest);
    } catch {
      // already gone (audio restarted)
    }
    dest.stream.getTracks().forEach((t) => t.stop());
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
    const key = `${s.type}:${s.drive}`;
    if (key !== this.distCurve) {
      d.shaper.curve = shapeCurve(s.drive, s.type);
      this.distCurve = key;
    }
    const set = (p: AudioParam, v: number) => (smooth > 0 ? p.setTargetAtTime(v, ctx.currentTime, smooth) : (p.value = v));
    set(d.makeup.gain, driveMakeup(s.drive, s.type));
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
  setSourceNow(values: Partial<VoiceSource>, voice = 0): void {
    if (voice > 0) {
      this.extras[voice - 1]?.node.port.postMessage({ type: "source", values } satisfies ToWorklet);
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
        this.toExtras(m);
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
          this.toExtras({ type: "source", values: shared });
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
