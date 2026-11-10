/**
 * The performer's microphone, for the formant tracker: raw (no echo cancellation, noise
 * suppression or automatic gain, which smear formants and pump the level), into an analyser that
 * never reaches the speakers. `read` returns the newest ~43 ms.
 */
export class MicInput {
  private stream: MediaStream | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private analyser: AnalyserNode | null = null;
  private sink: GainNode | null = null;
  private buf = new Float32Array(2048);
  deviceLabel = "";

  async open(ctx: AudioContext, deviceId?: string): Promise<void> {
    this.close();
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: deviceId ? { exact: deviceId } : undefined,
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        channelCount: 1,
      },
    });
    this.stream = stream;
    this.deviceLabel = stream.getAudioTracks()[0]?.label ?? "";
    this.source = ctx.createMediaStreamSource(stream);
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 2048;
    // an analyser with no path to the output may not be pulled; a muted path keeps it running
    this.sink = ctx.createGain();
    this.sink.gain.value = 0;
    this.source.connect(this.analyser).connect(this.sink).connect(ctx.destination);
  }

  /** The raw microphone stream (for saving a sample), or null when closed. */
  get mediaStream(): MediaStream | null {
    return this.stream;
  }

  /** The newest samples (the analyser's window), or null when closed. */
  read(): Float32Array | null {
    if (!this.analyser) return null;
    this.analyser.getFloatTimeDomainData(this.buf);
    return this.buf;
  }

  close(): void {
    this.source?.disconnect();
    this.analyser?.disconnect();
    this.sink?.disconnect();
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.source = null;
    this.analyser = null;
    this.sink = null;
  }
}

/** The audio inputs the browser will name (names appear once the mic has been allowed once). */
export async function listInputs(): Promise<{ id: string; label: string }[]> {
  if (!navigator.mediaDevices?.enumerateDevices) return [];
  const all = await navigator.mediaDevices.enumerateDevices();
  return all.filter((d) => d.kind === "audioinput").map((d, i) => ({ id: d.deviceId, label: d.label || `Microphone ${i + 1}` }));
}
