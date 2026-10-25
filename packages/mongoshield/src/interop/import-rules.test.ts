// What each namespace of a mongodump output becomes in an import.

import { describe, expect, it } from "vitest";
import { importRole } from "./import-rules.ts";

describe("importRole", () => {
  it.each([
    ["app", "users", { kind: "namespace" }],
    ["app", "system.js", { kind: "namespace" }],
    ["app", "system.buckets.metrics", { kind: "buckets", collection: "metrics" }],
    ["admin", "system.users", { kind: "users" }],
    ["admin", "system.roles", { kind: "roles" }],
    ["app", "$admin.system.users", { kind: "users" }],
    ["app", "$admin.system.roles", { kind: "roles" }],
    // Only admin's system.users holds users; elsewhere it is an ordinary system collection.
    [
      "app",
      "system.users",
      { kind: "skip", reason: expect.stringContaining("system collections") },
    ],
    [
      "app",
      "system.profile",
      { kind: "skip", reason: expect.stringContaining("system collections") },
    ],
    [
      "admin",
      "system.version",
      { kind: "skip", reason: expect.stringContaining("auth schema version") },
    ],
    [
      "app",
      "$admin.system.version",
      { kind: "skip", reason: expect.stringContaining("auth schema version") },
    ],
    ["app", "$cmd", { kind: "skip", reason: expect.stringContaining("not a namespace") }],
  ])("treats %s.%s as %o", (db, collection, role) => {
    expect(importRole(db, collection)).toEqual(role);
  });
});
