import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const apiTarget = process.env.VITE_API_PROXY_TARGET ?? "http://localhost:4000";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    // The entry chunk is React DOM + Zod (shared with the API so validation is identical) + Motion:
    // ~156 kB gzipped. Chat and admin are split into their own chunks.
    chunkSizeWarningLimit: 550,
  },
  server: {
    port: 5173,
    proxy: { "/api": { target: apiTarget, changeOrigin: true } },
  },
  preview: {
    port: 4173,
    proxy: { "/api": { target: apiTarget, changeOrigin: true } },
  },
});
