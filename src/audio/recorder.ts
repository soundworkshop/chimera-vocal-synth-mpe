/**
 * Record a short video for posting: the Chimera tab's picture (the browser asks which tab or
 * window, offering this one first) with Chimera's own sound tapped from the engine's output, so
 * the performer's voice into the mic isn't in it. The tab's own shape up to 1080 tall, 30 fps,
 * ~6 Mb/s video (small text survives) and 128 kb/s audio, MP4 (H.264/AAC), built by hand with WebCodecs where the
 * browser can (mp4Recorder.ts; Chrome's own MP4 recording came out corrupted), and
 * at most 2 min 20 s (X's limit for most accounts). The file downloads when recording stops.
 */
import { engine } from "./AudioEngine.ts";
import { outputSize, recordMp4, supported } from "./mp4Recorder.ts";

export const MAX_SECONDS = 140;

/**
 * MP4 first, letting Chrome pick the H.264 profile and level (a fixed Baseline 3.1 can't hold a
 * Retina-sized frame, and Chrome then drops the picture and keeps only the sound).
 */
const TYPES = ["video/mp4;codecs=avc1,mp4a.40.2", "video/mp4", "video/webm;codecs=vp9,opus", "video/webm"];

export interface Recording {
  stop: () => void;
  /** seconds so far */
  elapsed: () => number;
}

/**
 * Start recording (call from a click: the browser's screen picker needs it). `onDone` gets the
 * file name (or an error message) when it has stopped and downloaded.
 */
export async function startRecording(onDone: (result: { file?: string; error?: string; warning?: string }) => void): Promise<Recording> {
  if (!navigator.mediaDevices?.getDisplayMedia) throw new Error("This browser can't record the screen");
  const tap = engine.recordTap();
  if (!tap) throw new Error("Start the audio first");
  let screen: MediaStream;
  try {
    screen = await navigator.mediaDevices.getDisplayMedia({
      // the tab at its full (Retina) size: the recorder scales it down itself, in high quality
      // (the browser's own scaling to 720p blurred away thin lines and small text)
      video: { frameRate: { ideal: 30, max: 30 } },
      audio: false,
      // offer this tab first, and don't make the person hunt for it
      preferCurrentTab: true,
      selfBrowserSurface: "include",
    } as DisplayMediaStreamOptions);
  } catch (e) {
    engine.releaseTap(tap);
    throw e;
  }
  const video = screen.getVideoTracks()[0];
  // what was shared: a whole screen or window shows black without macOS's Screen Recording
  // permission for Chrome (this tab doesn't need it)
  const surface = (video?.getSettings() as { displaySurface?: string } | undefined)?.displaySurface;
  const t0 = performance.now();
  let stopped = false;
  const finish = (blob: Blob | null, ext: string) => {
    screen.getTracks().forEach((t) => t.stop());
    engine.releaseTap(tap);
    if (!blob || !blob.size) return onDone({ error: "Nothing was recorded" });
    const stamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, "-");
    const file = `chimera-${stamp}.${ext}`;
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = file;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
    // check the file has a picture, and say how big
    void probePicture(url).then((size) => {
      if (!size) onDone({ file, warning: `${file} has sound but no picture. Record again and choose “This tab” in Chrome's picker.` });
      else if (surface && surface !== "browser") onDone({ file, warning: `Saved ${file} (${size}). It recorded a ${surface}, not the tab: if the picture is black, choose “This tab”, or allow Chrome in System Settings → Privacy & Security → Screen Recording.` });
      else onDone({ file: `${file} (${size})` });
    });
  };

  // by hand where the browser can (a fixed 1280×720 picture, nothing changes mid-stream);
  // MediaRecorder otherwise
  const ctxRate = engine.ctx?.sampleRate ?? 48000;
  const vs = video?.getSettings();
  const size = outputSize(vs?.width ?? window.innerWidth * devicePixelRatio, vs?.height ?? window.innerHeight * devicePixelRatio);
  const codecs = await supported(ctxRate, size.w, size.h);
  const audioTrack = tap.stream.getAudioTracks()[0];
  let stopNow: () => void;
  if (codecs && video && audioTrack) {
    const bg = getComputedStyle(document.body).backgroundColor || "#000";
    const rec = recordMp4(video, audioTrack, ctxRate, codecs, size, bg);
    stopNow = () =>
      void rec.stop().then(
        (blob) => finish(blob, "mp4"),
        (e) => {
          screen.getTracks().forEach((t) => t.stop());
          engine.releaseTap(tap);
          onDone({ error: `Recording failed: ${e instanceof Error ? e.message : String(e)}` });
        },
      );
  } else {
    const stream = new MediaStream([...screen.getVideoTracks(), ...tap.stream.getAudioTracks()]);
    const mimeType = TYPES.find((t) => MediaRecorder.isTypeSupported(t)) ?? "";
    const rec = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 2_500_000, audioBitsPerSecond: 128_000 });
    const chunks: Blob[] = [];
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    rec.onstop = () => {
      const type = rec.mimeType || mimeType || "video/webm";
      finish(chunks.length ? new Blob(chunks, { type }) : null, type.startsWith("video/mp4") ? "mp4" : "webm");
    };
    rec.start(1000);
    stopNow = () => rec.state !== "inactive" && rec.stop();
  }
  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearTimeout(limit);
    stopNow();
  };
  // the browser's own "Stop sharing" ends it too
  screen.getVideoTracks()[0]?.addEventListener("ended", stop);
  const limit = setTimeout(stop, MAX_SECONDS * 1000);
  return { stop, elapsed: () => (performance.now() - t0) / 1000 };
}

/** The video's picture size ("1280×720"), or null if it has none (sound only). */
function probePicture(url: string): Promise<string | null> {
  return new Promise((resolve) => {
    const v = document.createElement("video");
    v.muted = true;
    v.preload = "metadata";
    const done = (r: string | null) => {
      clearTimeout(timer);
      v.removeAttribute("src");
      v.load();
      resolve(r);
    };
    const timer = setTimeout(() => done(v.videoWidth ? `${v.videoWidth}×${v.videoHeight}` : null), 4000);
    v.onloadedmetadata = () => done(v.videoWidth ? `${v.videoWidth}×${v.videoHeight}` : null);
    v.onerror = () => done(null);
    v.src = url;
  });
}
