import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        extends: true,
        test: {
          // Reconcile logic against the in-memory fake API server: fast, no cluster.
          name: "unit",
          include: ["src/**/*.test.ts", "test/unit/**/*.test.ts"],
          environment: "node",
        },
      },
      {
        extends: true,
        test: {
          // Against a real cluster with the operator installed. Run through
          // `pnpm --filter @mongoshield/operator test:e2e` (scripts/e2e.ts), which
          // creates the cluster, builds and loads the images and installs the chart.
          name: "e2e",
          include: ["test/e2e/**/*.test.ts"],
          environment: "node",
          testTimeout: 600_000,
          hookTimeout: 600_000,
          // One cluster, one namespace per test file: run files one after another.
          fileParallelism: false,
        },
      },
    ],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      // main.ts only wires process signals and the kubeconfig (covered by the e2e test).
      exclude: ["src/**/*.test.ts", "src/main.ts"],
      // Floors just under the measured coverage (Oct 2026: lines 99.1, branches 85.7,
      // functions 97.6, statements 98.0). Raise them as tests improve.
      thresholds: { lines: 98, branches: 84, functions: 96, statements: 96 },
    },
  },
});
