/**
 * AudioWorklet wrapper for the plate reverb: stereo in, stereo out, four k-rate parameters.
 * Its own module (not Chimera's processor), so the voice engine is untouched.
 */
import { PlateReverb } from "./plateReverb.ts";

declare const sampleRate: number;
declare function registerProcessor(name: string, ctor: unknown): void;
declare class AudioWorkletProcessor {
  constructor(options?: unknown);
}

class PlateProcessor extends AudioWorkletProcessor {
  private reverb = new PlateReverb(sampleRate);
  private l = new Float32Array(128);
  private r = new Float32Array(128);

  static get parameterDescriptors() {
    const p = (name: string, defaultValue: number) => ({ name, defaultValue, minValue: 0, maxValue: 1, automationRate: "k-rate" });
    return [p("mix", 0.25), p("time", 0.55), p("tone", 0.55), p("diffusion", 0.6)];
  }

  process(inputs: Float32Array[][], outputs: Float32Array[][], params: Record<string, Float32Array>): boolean {
    const out = outputs[0];
    if (!out || !out.length) return true;
    const n = out[0].length;
    if (this.l.length !== n) (this.l = new Float32Array(n)), (this.r = new Float32Array(n));
    const input = inputs[0];
    // no input connected or silent: keep running so the tail rings out
    if (input && input.length) {
      this.l.set(input[0]);
      this.r.set(input[1] ?? input[0]);
    } else {
      this.l.fill(0);
      this.r.fill(0);
    }
    this.reverb.process(this.l, this.r, { mix: params.mix[0], time: params.time[0], tone: params.tone[0], diffusion: params.diffusion[0] });
    out[0].set(this.l);
    if (out[1]) out[1].set(this.r);
    return true;
  }
}

registerProcessor("chimera-plate", PlateProcessor);
