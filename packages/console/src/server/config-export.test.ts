import { describe, expect, it } from "vitest";
import type { ConsoleState } from "../state/types.ts";
import { renderConfig } from "./config-export.ts";

const state: ConsoleState = {
  version: 1,
  keySalt: "",
  keyCheck: "",
  users: [],
  sessions: [],
  jobs: [],
  connections: [
    {
      id: "c1",
      name: "Prod EU",
      uri: "v1.sealed",
      uriPreview: "mongodb://app:***@db",
      production: true,
      createdAt: "",
    },
  ],
  storage: [{ id: "s1", name: "local", url: "backups", createdAt: "", updatedAt: "" }],
  plans: [
    {
      id: "p1",
      // A hostile name: tries to close the comment/string and inject code.
      name: 'delete"); process.exit(1); //',
      connectionId: "c1",
      storageId: "s1",
      include: ["app.*"],
      exclude: [],
      compression: "zstd",
      encryption: { kind: "passphrase", passphrase: "v1.sealed" },
      consistency: "auto",
      verify: "fast",
      notify: [],
      createdAt: "",
    },
  ],
};

describe("renderConfig", () => {
  it("renders env references, absolute local paths and escaped names", () => {
    const { filename, content } = renderConfig(state, "/data", new Date("2026-10-21T00:00:00Z"));
    expect(filename).toBe("mongoshield.config.ts");
    expect(content).toContain("uri: process.env.MONGODB_URI_PROD_EU");
    expect(content).toContain('storage: "/data/backups"');
    expect(content).toContain(
      "passphrase: process.env.MONGOSHIELD_PASSPHRASE_DELETE_PROCESS_EXIT_1",
    );
    expect(content).toContain("export const planDeleteProcessExit1 = defineConfig({");
    expect(content).toContain("export default planDeleteProcessExit1;");
    // The hostile name only ever appears JSON-escaped.
    expect(content).not.toContain('delete"); process.exit(1)');
    expect(content).not.toContain("v1.sealed");
  });
});
