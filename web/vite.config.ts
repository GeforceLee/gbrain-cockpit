import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // Dev loop: the API lives on the cockpit server; the browser never talks
    // to gbrain directly.
    proxy: {
      "/api": "http://127.0.0.1:8787",
    },
  },
});
