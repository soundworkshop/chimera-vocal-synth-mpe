/**
 * Record a short video for posting: the Chimera tab's picture (the browser asks which tab or
 * window, offering this one first) with Chimera's own sound tapped from the engine's output, so
 * the performer's voice into the mic isn't in it. Light by design: 720p at most, 30 fps, about
 * 2.5 Mb/s video and 128 kb/s audio, MP4 (H.264/AAC) where the browser can (current Chrome), and
 * at most 2 min 20 s (X's limit for most accounts). The file downloads when recording stops.
 */
import { engine } from "./AudioEngine.ts";

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
      // scaled down to 720p (a Retina tab is captured at twice its size otherwise)
      video: { width: { ideal: 1280, max: 1280 }, height: { ideal: 720, max: 720 }, frameRate: { ideal: 30, max: 30 }, resizeMode: "crop-and-scale" } as MediaTrackConstraints,
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
  const stream = new MediaStream([...screen.getVideoTracks(), ...tap.stream.getAudioTracks()]);
  const mimeType = TYPES.find((t) => MediaRecorder.isTypeSupported(t)) ?? "";
  const rec = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 2_500_000, audioBitsPerSecond: 128_000 });
  const chunks: Blob[] = [];
  rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  const t0 = performance.now();
  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearTimeout(limit);
    if (rec.state !== "inactive") rec.stop();
  };
  rec.onstop = () => {
    screen.getTracks().forEach((t) => t.stop());
    engine.releaseTap(tap);
    if (!chunks.length) return onDone({ error: "Nothing was recorded" });
    const type = rec.mimeType || mimeType || "video/webm";
    const ext = type.startsWith("video/mp4") ? "mp4" : "webm";
    const stamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, "-");
    const file = `chimera-${stamp}.${ext}`;
    const url = URL.createObjectURL(new Blob(chunks, { type }));
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
  // the browser's own "Stop sharing" ends it too
  screen.getVideoTracks()[0]?.addEventListener("ended", stop);
  const limit = setTimeout(stop, MAX_SECONDS * 1000);
  rec.start(1000);
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
