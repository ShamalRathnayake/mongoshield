/**
 * Tests for exporting the console's plans as a `mongoshield.config.ts`: secrets
 * become environment references, and no stored value can inject code.
 */

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

  it("renders every plan option and keeps identifiers unique", () => {
    const base = state.plans[0];
    if (base === undefined) throw new Error("fixture");
    const rich: ConsoleState = {
      ...state,
      storage: [
        ...state.storage,
        {
          id: "s2",
          name: "s3",
          url: "s3://bucket/prefix",
          credentialNames: ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"],
          createdAt: "",
          updatedAt: "",
        },
      ],
      plans: [
        {
          ...base,
          id: "p1",
          name: "nightly",
          storageId: "s2",
          include: ["app.*"],
          exclude: ["app.cache"],
          encryption: { kind: "recipients", recipients: ["age1abc"] },
          retention: { last: 7, daily: 14 },
          schedule: { cron: "0 3 * * *", timezone: "Europe/Berlin" },
          notify: [
            { type: "slack", url: "v1.sealed-slack", urlPreview: "https://hooks.slack.com/***" },
          ],
        },
        { ...base, id: "p2", name: "nightly", include: [], encryption: { kind: "none" } },
        { ...base, id: "p3", name: "!!!", connectionId: "missing" },
        { ...base, id: "p4", name: "???", include: [] },
      ],
    };
    const { content } = renderConfig(rich, "/data", new Date("2026-10-21T00:00:00Z"));
    expect(content).toContain("export const planNightly = defineConfig({");
    expect(content).toContain("export const planNightly2 = defineConfig({");
    // A plan whose connection is gone is skipped; a name without letters still gets an identifier.
    expect(content).toContain("export const plan = defineConfig({");
    expect(content).toContain('storage: "s3://bucket/prefix"');
    expect(content).toContain('encryption: { recipients: ["age1abc"] }');
    expect(content).toContain(
      'backup: { include: ["app.*"], exclude: ["app.cache"], consistency: "auto" }',
    );
    expect(content).toContain('retention: {"last":7,"daily":14}');
    expect(content).toContain(
      'schedule: { cron: "0 3 * * *", timezone: "Europe/Berlin", verify: "fast" }',
    );
    expect(content).toContain("url: process.env.MONGOSHIELD_NOTIFY_NIGHTLY_1");
    expect(content).toContain("//   AWS_SECRET_ACCESS_KEY  credential of storage");
    expect(content).toContain("MONGOSHIELD_PASSPHRASE_UNNAMED");
    expect(content).toContain("export default planNightly;");
    expect(content).not.toContain("sealed");
  });

  it("exports a minimal default config when there are no plans", () => {
    const { content } = renderConfig({ ...state, plans: [] }, "/data", new Date());
    expect(content).toContain('export default defineConfig({ storage: "./backups" });');
  });
});
