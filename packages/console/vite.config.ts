/**
 * Builds the browser UI (src/ui) into dist/ui, which the server serves as static files.
 * In development, `pnpm dev` serves the UI with hot reload and forwards /api to a
 * console server started separately with `pnpm dev:server`.
 */
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  root: "src/ui",
  plugins: [react()],
  build: {
    outDir: "../../dist/ui",
    emptyOutDir: true,
    // Source maps help when debugging a deployed console; they contain no secrets.
    sourcemap: true,
  },
  server: {
    // "/api/" with the slash: a bare "/api" prefix would also catch the UI's own
    // module /api.ts and break the dev server (and mock mode, `?mock=1`).
    proxy: { "/api/": "http://localhost:8080" },
  },
});
