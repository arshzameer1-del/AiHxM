import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Phase 1: proxy /api to the local NestJS server so the web shell and the
// API can be developed on separate ports without a CORS dance. Revisit
// once real auth/session handling (Phase 3) is in place.
export default defineConfig({
  plugins: [react()],
  resolve: {
    // @aihxm/shared-types's package.json now points "main"/"types" at a
    // real compiled dist/index.js (apps/api, plain Node at runtime, needs
    // an actual JS file there — see that package's package.json for why
    // it can no longer point straight at its .ts source). Vite doesn't
    // need that detour at all: esbuild already compiles .ts straight from
    // source for dev and build, so this alias sends it there directly,
    // the exact same thing "main" used to do for every consumer before
    // apps/api needed a real build. Without this, Rollup's production
    // build resolves the compiled CommonJS dist/index.js instead and
    // fails to statically see its named exports ("MODULE_KEYS is not
    // exported by .../dist/index.js") — a CJS-interop wrinkle specific to
    // bundling a workspace package, not a real ambiguity in what the
    // module exports. Array form (not the plain-object shorthand) because
    // this needs an EXACT match, not a prefix match that would also
    // rewrite a hypothetical "@aihxm/shared-types-something-else".
    alias: [
      {
        find: /^@aihxm\/shared-types$/,
        replacement: fileURLToPath(new URL("../../packages/shared-types/src/index.ts", import.meta.url)),
      },
    ],
  },
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
