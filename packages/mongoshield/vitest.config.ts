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
    ],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts", "src/cli/index.ts"],
      reporter: ["text", "html", "json-summary"],
      // Floors at the measured coverage (Oct 2026: lines 91.9, branches 78.8, functions
      // 94.0, statements 90.0), so coverage can only go up. Raise them as tests improve;
      // branches is the one to work on.
      thresholds: { lines: 90, branches: 78, functions: 90, statements: 90 },
    },
  },
});
