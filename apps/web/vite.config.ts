import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Phase 1: proxy /api to the local NestJS server so the web shell and the
// API can be developed on separate ports without a CORS dance. Revisit
// once real auth/session handling (Phase 3) is in place.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://localhost:4000",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ""),
      },
    },
  },
});
