// Unit tests for the restore `rename` option: exact rules, database wildcards,
// precedence, and validation of rules and target names.

import { describe, expect, it } from "vitest";
import { isMongoShieldError } from "../errors.ts";
import { assertValidTargetNamespace, compileRenameMap } from "./restore-rename.ts";

function expectConfigError(action: () => unknown): void {
  try {
    action();
  } catch (error) {
    expect(isMongoShieldError(error, "MS_CONFIG_INVALID")).toBe(true);
    return;
  }
  throw new Error("expected MS_CONFIG_INVALID");
}

describe("compileRenameMap", () => {
  it("keeps every namespace when there are no rules", () => {
    const map = compileRenameMap(undefined);
    expect(map("app.users")).toBe("app.users");
  });

  it("renames one collection with an exact rule", () => {
    const map = compileRenameMap({ "app.users": "app.users_old" });
    expect(map("app.users")).toBe("app.users_old");
    expect(map("app.orders")).toBe("app.orders");
  });

  it("moves a collection to another database with an exact rule", () => {
    expect(compileRenameMap({ "app.users": "archive.people" })("app.users")).toBe("archive.people");
  });

  it("moves a whole database with a wildcard rule, keeping dotted collection names", () => {
    const map = compileRenameMap({ "app.*": "app_restored.*" });
    expect(map("app.users")).toBe("app_restored.users");
    expect(map("app.events.2024")).toBe("app_restored.events.2024");
    expect(map("other.users")).toBe("other.users");
  });

  it("lets an exact rule win over a database wildcard", () => {
    const map = compileRenameMap({ "app.*": "staging.*", "app.users": "staging.people" });
    expect(map("app.users")).toBe("staging.people");
    expect(map("app.orders")).toBe("staging.orders");
  });

  it("does not treat a wildcard database rule as a prefix of another database", () => {
    expect(compileRenameMap({ "app.*": "x.*" })("app2.users")).toBe("app2.users");
  });

  it("rejects a wildcard source with an exact target", () => {
    expectConfigError(() => compileRenameMap({ "app.*": "other.users" }));
  });

  it("rejects partial wildcards", () => {
    expectConfigError(() => compileRenameMap({ "app.user*": "app.people*" }));
    expectConfigError(() => compileRenameMap({ "*.users": "*.people" }));
    expectConfigError(() => compileRenameMap({ "app.users": "app.*" }));
  });

  it("rejects invalid target names", () => {
    expectConfigError(() => compileRenameMap({ "app.users": "bad db.users" }));
    expectConfigError(() => compileRenameMap({ "app.users": "app.$users" }));
    expectConfigError(() => compileRenameMap({ "app.users": "app.system.users" }));
    expectConfigError(() => compileRenameMap({ "app.users": "app." }));
    expectConfigError(() => compileRenameMap({ "app.*": "a/b.*" }));
    expectConfigError(() => compileRenameMap({ "app.*": `${"d".repeat(64)}.*` }));
  });
});

describe("assertValidTargetNamespace", () => {
  it("accepts ordinary and dotted names", () => {
    expect(() => assertValidTargetNamespace("app.users")).not.toThrow();
    expect(() => assertValidTargetNamespace("app.events.2024")).not.toThrow();
  });

  it("rejects namespaces longer than 255 bytes", () => {
    expectConfigError(() => assertValidTargetNamespace(`app.${"c".repeat(260)}`));
  });

  it("rejects an empty collection name", () => {
    expectConfigError(() => assertValidTargetNamespace("app"));
  });
});
