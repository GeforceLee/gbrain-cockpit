import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Where the built bundle is mounted. "/" is the default and what the
// release artifacts carry. A proxy that strips a path prefix in front of
// :8787 (say /cockpit/ → 127.0.0.1:8787) needs the bundle built with that
// prefix — COCKPIT_BASE=/cockpit/ bun run build — so index.html asset refs
// and withBase() (it reads import.meta.env.BASE_URL) carry it. Only a path
// is accepted: a full origin would point the API calls at another host.
function mountBase(): string {
  const raw = (process.env.COCKPIT_BASE ?? "/").trim();
  const base = raw === "" || raw === "/" ? "/" : raw.endsWith("/") ? raw : `${raw}/`;
  if (/^\/(?:[A-Za-z0-9._~-]+\/)*$/.test(base)) return base;
  throw new Error(`COCKPIT_BASE must be a path such as /cockpit/ — got ${JSON.stringify(raw)}`);
}

export default defineConfig(({ command, isPreview }) => ({
  // Dev serves from "/" — import.meta.env.BASE_URL mirrors this, keeping
  // withBase() a no-op locally and the /api dev proxy untouched.
  base: command === "build" || isPreview ? mountBase() : "/",
  plugins: [react()],
  server: {
    port: 5173,
    // Dev loop: the API lives on the cockpit server; the browser never talks
    // to gbrain directly.
    proxy: {
      "/api": "http://127.0.0.1:8787",
    },
  },
}));
