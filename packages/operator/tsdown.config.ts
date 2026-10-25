/** Bundles the operator (src/main.ts) into dist/main.mjs, the package's bin and the image's entrypoint. */
import { defineConfig } from "tsdown";

export default defineConfig({
  entry: { main: "src/main.ts" },
  format: "esm",
  platform: "node",
  target: "node22.12",
  fixedExtension: true,
  // An application, not a library: nobody imports its types.
  dts: false,
  sourcemap: true,
  clean: true,
  // Runtime dependencies are installed next to the package, never bundled.
  external: [
    "mongoshield",
    /^mongoshield\//,
    "mongodb",
    "@kubernetes/client-node",
    "undici",
    "croner",
  ],
});
