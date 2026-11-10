/**
 * Entry: load the engine (wasm) first — UI modules call into it as they load (Sing mode builds
 * its syllables at import time) — then import and render the app. A failed load can be retried.
 */
import "./ui/styles.css";
import { initChimera } from "./wasm/chimera.ts";

const root = document.getElementById("root")!;

async function boot(): Promise<void> {
  try {
    await initChimera();
  } catch (err) {
    root.replaceChildren();
    const box = document.createElement("div");
    box.className = "boot-error";
    const msg = document.createElement("p");
    msg.textContent = `The voice engine could not load: ${err instanceof Error ? err.message : String(err)}`;
    const retry = document.createElement("button");
    retry.className = "primary";
    retry.textContent = "Try again";
    retry.onclick = () => void boot();
    box.append(msg, retry);
    root.append(box);
    return;
  }
  let ui: typeof import("./ui/mount.tsx");
  try {
    ui = await import("./ui/mount.tsx");
  } catch (err) {
    // A browser can hold on to a "not found" for the UI's file (asked for mid-deploy, then
    // cached): ask again at an address it hasn't cached. The URL is in the browser's message.
    const url = /https?:\/\/\S+\.js/.exec(String(err))?.[0];
    if (!url) throw err;
    ui = (await import(/* @vite-ignore */ `${url}?retry=${Date.now()}`)) as typeof import("./ui/mount.tsx");
  }
  ui.mount(root);
}

void boot();
