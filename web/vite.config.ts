import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig(({ command, isPreview }) => ({
  // Mount point: release builds live under /cockpit/ (the edge proxy strips
  // the prefix in front of :8787, so index.html asset refs must carry it).
  // Dev serves from "/" — import.meta.env.BASE_URL mirrors this, keeping
  // withBase() a no-op locally and the /api dev proxy untouched.
  base: command === "build" || isPreview ? "/cockpit/" : "/",
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
