import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { execSync } from "node:child_process";

/** which commit this build is (Vercel names it; locally ask git), shown in the top bar */
function buildId(): string {
  const sha = process.env.VERCEL_GIT_COMMIT_SHA ?? (() => {
    try {
      return execSync("git rev-parse HEAD", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
    } catch {
      return "dev";
    }
  })();
  return sha.slice(0, 7);
}

export default defineConfig({
  plugins: [react()],
  define: { __BUILD_ID__: JSON.stringify(buildId()), __BUILD_TIME__: JSON.stringify(new Date().toISOString()) },
  worker: { format: "es" },
  build: { target: "es2022", sourcemap: true },
  server: { host: "127.0.0.1", port: 5317, strictPort: true, allowedHosts: true },
  preview: { host: "127.0.0.1", port: 5318, strictPort: true, allowedHosts: true },
});
