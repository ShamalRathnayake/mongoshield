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
  },
});
