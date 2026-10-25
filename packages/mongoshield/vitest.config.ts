import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          include: ["src/**/*.test.ts"],
          environment: "node",
        },
      },
      {
        extends: true,
        test: {
          name: "integration",
          include: ["test/integration/**/*.test.ts"],
          environment: "node",
          globalSetup: ["test/helpers/global-setup.ts"],
          testTimeout: 60_000,
          hookTimeout: 120_000,
        },
      },
      {
        // Multi-node replica sets, access control and a sharded cluster (Docker).
        // Each file starts its own deployment in `beforeAll`, so this project is not
        // part of `pnpm test` / `pnpm coverage`: run it with `pnpm test:topology`.
        // Files run one after another (the deployments are heavy) with generous
        // timeouts, because elections and container start-up are slow on busy machines.
        extends: true,
        test: {
          name: "topology",
          include: ["test/topology/**/*.test.ts"],
          environment: "node",
          fileParallelism: false,
          testTimeout: 180_000,
          hookTimeout: 600_000,
        },
      },
      {
        // Opt-in tests against real cloud services (S3, R2, GCS, Azure, SFTP, KMS).
        // Each suite runs only when its environment variables are set and skips with
        // a message naming them otherwise (see docs/testing-real-clouds.md). Never
        // part of `pnpm test` / `pnpm coverage`: run it with `pnpm test:cloud`.
        // Files run one after another so a run's request rate stays modest, with long
        // timeouts because every operation crosses the internet.
        extends: true,
        test: {
          name: "cloud",
          include: ["test/cloud/**/*.test.ts"],
          environment: "node",
          globalSetup: ["test/cloud/global-setup.ts"],
          fileParallelism: false,
          testTimeout: 600_000,
          hookTimeout: 600_000,
        },
      },
    ],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts", "src/cli/index.ts"],
      reporter: ["text", "html", "json-summary"],
      // Floors just under the measured coverage (Oct 2026: lines 98.1, branches 92.5,
      // functions 97.9, statements 97.2), with about a point of margin because some
      // paths only run under certain timings (retries, slow drains). Raise them as
      // tests improve.
      thresholds: { lines: 97, branches: 91, functions: 96, statements: 96 },
    },
  },
});
