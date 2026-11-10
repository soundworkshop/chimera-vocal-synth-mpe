/**
 * MP4 recording by hand (WebCodecs + mp4-muxer), instead of MediaRecorder's MP4: on the
 * performer's Mac that produced a broken H.264 stream (a 938×720 tab, six keyframes in the first
 * 150 ms as the capture settled, decode errors in nearly every frame, so the GUI came out as
 * fragments on black). Here nothing about the picture can change mid-stream:
 *
 * - picture: the newest frame of the shared tab is drawn, letterboxed, onto a fixed 1280×720
 *   canvas 30 times a second, and that canvas is what's encoded (H.264, a keyframe every 2 s)
 * - sound: the audio track's samples, re-stamped on the same clock as the picture, encoded as AAC
 *   (Opus where the browser has no AAC encoder; X wants AAC, which Chrome on Mac and Windows has)
 * - container: mp4-muxer, moov at the front (plays and uploads without a second pass)
 *
 * `supported()` says whether this browser can; otherwise the caller falls back to MediaRecorder.
 */
import { ArrayBufferTarget, Muxer } from "mp4-muxer";

export const W = 1280;
export const H = 720;
const FPS = 30;
const KEY_EVERY = FPS * 2;

type Processor = new (init: { track: MediaStreamTrack }) => { readable: ReadableStream<VideoFrame | AudioData> };
const TrackProcessor = (globalThis as unknown as { MediaStreamTrackProcessor?: Processor }).MediaStreamTrackProcessor;

const VIDEO_CODECS = ["avc1.4D0028", "avc1.42E028", "avc1.42002A"];

/** Whether WebCodecs can record here, and with what: null if not. */
export async function supported(sampleRate: number): Promise<{ video: string; audio: "aac" | "opus" } | null> {
  if (!TrackProcessor || typeof VideoEncoder === "undefined" || typeof AudioEncoder === "undefined") return null;
  let video = "";
  for (const codec of VIDEO_CODECS) {
    const r = await VideoEncoder.isConfigSupported({ codec, width: W, height: H, bitrate: 2_500_000, framerate: FPS, avc: { format: "avc" } }).catch(() => null);
    if (r?.supported) {
      video = codec;
      break;
    }
  }
  if (!video) return null;
  const aac = await AudioEncoder.isConfigSupported({ codec: "mp4a.40.2", sampleRate, numberOfChannels: 2, bitrate: 128_000 }).catch(() => null);
  if (aac?.supported) return { video, audio: "aac" };
  const opus = await AudioEncoder.isConfigSupported({ codec: "opus", sampleRate, numberOfChannels: 2, bitrate: 128_000 }).catch(() => null);
  return opus?.supported ? { video, audio: "opus" } : null;
}

export interface Mp4Recording {
  /** stop and get the file */
  stop: () => Promise<Blob>;
}

/**
 * Record `video` (any size, may change) and `audio` until stop(). `background` fills the
 * letterbox bars.
 */
export function recordMp4(video: MediaStreamTrack, audio: MediaStreamTrack, sampleRate: number, codecs: { video: string; audio: "aac" | "opus" }, background = "#000"): Mp4Recording {
  const target = new ArrayBufferTarget();
  const muxer = new Muxer({
    target,
    video: { codec: "avc", width: W, height: H, frameRate: FPS },
    audio: { codec: codecs.audio, sampleRate, numberOfChannels: 2 },
    fastStart: "in-memory",
    firstTimestampBehavior: "offset",
  });
  let failed: unknown = null;
  const venc = new VideoEncoder({ output: (c, m) => muxer.addVideoChunk(c, m), error: (e) => (failed ??= e) });
  venc.configure({ codec: codecs.video, width: W, height: H, bitrate: 2_500_000, framerate: FPS, avc: { format: "avc" }, latencyMode: "quality" });
  const aenc = new AudioEncoder({ output: (c, m) => muxer.addAudioChunk(c, m), error: (e) => (failed ??= e) });
  aenc.configure({ codec: codecs.audio === "aac" ? "mp4a.40.2" : "opus", sampleRate, numberOfChannels: 2, bitrate: 128_000 });

  const t0 = performance.now();
  const canvas = new OffscreenCanvas(W, H);
  const g = canvas.getContext("2d", { alpha: false })!;
  g.fillStyle = background;
  g.fillRect(0, 0, W, H);

  // the newest frame of the tab (older ones are closed as newer arrive)
  let latest: VideoFrame | null = null;
  let running = true;
  const vreader = new TrackProcessor!({ track: video }).readable.getReader();
  void (async () => {
    while (running) {
      const r = await vreader.read().catch(() => ({ done: true, value: undefined }));
      if (r.done || !r.value) break;
      latest?.close();
      latest = r.value as VideoFrame;
    }
  })();

  // a steady 30 fps from whatever the tab gives (it sends frames only when the page changes)
  let n = 0;
  const tick = () => {
    if (!running || failed) return;
    const due = Math.floor(((performance.now() - t0) / 1000) * FPS);
    while (n <= due) {
      if (latest) {
        const fw = latest.displayWidth, fh = latest.displayHeight;
        const k = Math.min(W / fw, H / fh);
        const dw = Math.round(fw * k), dh = Math.round(fh * k);
        g.fillStyle = background;
        g.fillRect(0, 0, W, H);
        g.drawImage(latest, Math.round((W - dw) / 2), Math.round((H - dh) / 2), dw, dh);
      }
      // a backed-up encoder drops a frame rather than falling behind
      if (venc.encodeQueueSize < 8) {
        const frame = new VideoFrame(canvas, { timestamp: Math.round((n * 1e6) / FPS), duration: Math.round(1e6 / FPS) });
        venc.encode(frame, { keyFrame: n % KEY_EVERY === 0 });
        frame.close();
      }
      n++;
    }
  };
  const timer = setInterval(tick, 1000 / FPS / 2);

  // sound: re-stamped from the shared start (its own clock may differ from the picture's)
  let samples = 0;
  let audioStart = -1;
  const areader = new TrackProcessor!({ track: audio }).readable.getReader();
  const audioDone = (async () => {
    while (running) {
      const r = await areader.read().catch(() => ({ done: true, value: undefined }));
      if (r.done || !r.value) break;
      const d = r.value as AudioData;
      if (audioStart < 0) audioStart = ((performance.now() - t0) * 1000) | 0;
      const stereo = toStereo(d, audioStart + Math.round((samples * 1e6) / d.sampleRate));
      samples += d.numberOfFrames;
      d.close();
      if (!failed) aenc.encode(stereo);
      stereo.close();
    }
  })();

  return {
    stop: async () => {
      tick();
      running = false;
      clearInterval(timer);
      await vreader.cancel().catch(() => {});
      await areader.cancel().catch(() => {});
      await audioDone;
      latest?.close();
      await venc.flush().catch((e) => (failed ??= e));
      await aenc.flush().catch((e) => (failed ??= e));
      venc.close();
      aenc.close();
      if (failed) throw failed instanceof Error ? failed : new Error(String(failed));
      muxer.finalize();
      return new Blob([target.buffer], { type: "video/mp4" });
    },
  };
}

/** The same samples as planar float stereo, with a new timestamp (µs). */
function toStereo(d: AudioData, timestamp: number): AudioData {
  const n = d.numberOfFrames;
  const out = new Float32Array(n * 2);
  const ch = (i: number) => {
    const buf = new Float32Array(n);
    // asking for planar float: the plane is the channel, whatever the source's own layout
    d.copyTo(buf, { planeIndex: Math.min(i, d.numberOfChannels - 1), format: "f32-planar" });
    return buf;
  };
  out.set(ch(0), 0);
  out.set(d.numberOfChannels > 1 ? ch(1) : out.subarray(0, n), n);
  return new AudioData({ format: "f32-planar", sampleRate: d.sampleRate, numberOfFrames: n, numberOfChannels: 2, timestamp, data: out });
}
