/** Bundles the console server (src/server/main.ts) into dist/server. The UI is built by Vite. */
import { defineConfig } from "tsdown";

export default defineConfig({
  entry: { "server/main": "src/server/main.ts" },
  format: "esm",
  platform: "node",
  target: "node22.12",
  fixedExtension: true,
  dts: false,
  sourcemap: true,
  // Keep dist/ui (built by Vite) when rebuilding the server.
  clean: false,
  // Runtime dependencies are installed alongside the package, never bundled.
  external: ["mongoshield", /^mongoshield\//, "mongodb", "hono", /^hono\//, "@hono/node-server"],
});
