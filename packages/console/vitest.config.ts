import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          include: [
            "src/server/**/*.test.ts",
            "src/state/**/*.test.ts",
            "src/jobs/**/*.test.ts",
            "src/shared/**/*.test.ts",
          ],
          environment: "node",
        },
      },
      {
        extends: true,
        test: {
          name: "ui",
          include: ["src/ui/**/*.test.tsx", "src/ui/**/*.test.ts"],
          environment: "jsdom",
          // The page tests type whole forms with simulated keystrokes in jsdom, which
          // takes longer than Vitest's default 5 s on CI runners with coverage on.
          testTimeout: 20_000,
        },
      },
      {
        extends: true,
        test: {
          name: "integration",
          include: ["test/integration/**/*.test.ts"],
          environment: "node",
          // Reuse the library's harness: one real single-node replica set per run.
          globalSetup: ["../mongoshield/test/helpers/global-setup.ts"],
          testTimeout: 60_000,
          hookTimeout: 120_000,
        },
      },
    ],
    coverage: {
      provider: "v8",
      // Floors just under the measured coverage (Oct 2026: lines 97.1, branches 90.5,
      // functions 95.4, statements 96.1), with about a point of margin for paths that
      // only run under certain timings. Raise them as tests improve.
      thresholds: { lines: 96, branches: 89, functions: 94, statements: 95 },
    },
  },
});
