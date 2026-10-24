/**
 * Unit tests for the small browser helpers: theme storage (including blocked storage),
 * number, byte, duration and date formatting, manifest summaries of odd manifests, and
 * namespace patterns and renames.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  formatBytes,
  formatDateTime,
  formatDateTimeInZone,
  formatDuration,
  formatRelative,
  humanize,
  plural,
} from "./format.ts";
import { summarizeManifest } from "./manifest.ts";
import {
  applyRename,
  isSelected,
  matchesPattern,
  namespacesOf,
  patternProblem,
  splitNamespace,
} from "./namespaces.ts";
import { applyTheme, nextTheme, storedTheme } from "./theme.ts";

afterEach(() => {
  vi.restoreAllMocks();
  window.localStorage.clear();
  delete document.documentElement.dataset.theme;
});

describe("theme", () => {
  it("stores light and dark and forgets system", () => {
    applyTheme("dark");
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(storedTheme()).toBe("dark");
    applyTheme("system");
    expect(document.documentElement.dataset.theme).toBeUndefined();
    expect(storedTheme()).toBe("system");
  });

  it("ignores unknown stored values", () => {
    window.localStorage.setItem("mongoshield.theme", "purple");
    expect(storedTheme()).toBe("system");
  });

  it("still works when storage throws", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(storedTheme()).toBe("system");
    applyTheme("light");
    expect(document.documentElement.dataset.theme).toBe("light");
  });

  it("cycles system → light → dark → system", () => {
    expect(nextTheme("system")).toBe("light");
    expect(nextTheme("light")).toBe("dark");
    expect(nextTheme("dark")).toBe("system");
  });
});

describe("format", () => {
  it("formats bytes with sensible precision", () => {
    expect(formatBytes(undefined)).toBe("–");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1536)).toBe("1.5 KiB");
    expect(formatBytes(200 * 1024 * 1024)).toBe("200 MiB");
  });

  it("formats durations in the largest useful units", () => {
    expect(formatDuration(undefined)).toBe("–");
    expect(formatDuration(Number.NaN)).toBe("–");
    expect(formatDuration(-5)).toBe("0 s");
    expect(formatDuration(95_000)).toBe("1 min 35 s");
    expect(formatDuration(3_600_000)).toBe("1 h 0 min");
  });

  it("returns unparseable dates as they are", () => {
    expect(formatDateTime(undefined)).toBe("–");
    expect(formatDateTime("yesterday")).toBe("yesterday");
    expect(formatRelative(undefined)).toBe("–");
    expect(formatRelative("soon")).toBe("soon");
  });

  it("formats relative times in the past and future", () => {
    const now = Date.parse("2026-10-21T12:00:00Z");
    expect(formatRelative("2026-10-21T11:59:58Z", now)).toMatch(/2/);
    expect(formatRelative("2026-10-24T12:00:00Z", now)).toMatch(/3/);
  });

  it("falls back to ISO for an unknown time zone", () => {
    const date = new Date("2026-10-21T12:00:00Z");
    expect(formatDateTimeInZone(date, "Nowhere/Land")).toBe(date.toISOString());
    expect(formatDateTimeInZone(date, "UTC")).toMatch(/2026/);
  });

  it("humanizes keys and pluralizes nouns", () => {
    expect(humanize("verification.ok")).toBe("Verification ok");
    expect(plural(1, "plan")).toBe("1 plan");
    expect(plural(1200, "plan")).toBe("1,200 plans");
  });
});

describe("summarizeManifest", () => {
  it("never throws on manifests of the wrong shape", () => {
    expect(summarizeManifest(undefined).namespaces).toEqual([]);
    expect(summarizeManifest([1, 2]).labels).toEqual({});
    const summary = summarizeManifest({
      labels: { good: "yes", bad: 3 },
      namespaces: [
        null,
        { ns: 5 },
        { ns: "a.b", files: "nope" },
        { ns: "a.c", files: [{ size: 3 }, {}] },
      ],
      encryption: { recipients: ["age1x", 7] },
      totals: { bytesRaw: Number.POSITIVE_INFINITY },
    });
    expect(summary.labels).toEqual({ good: "yes" });
    expect(summary.namespaces).toEqual([
      { ns: "a.b", type: "collection", documents: 0, bytesRaw: 0, bytesStored: 0 },
      { ns: "a.c", type: "collection", documents: 0, bytesRaw: 0, bytesStored: 3 },
    ]);
    expect(summary.encryption).toEqual({ scheme: "unknown", recipients: ["age1x"] });
    expect(summary.bytesRaw).toBeUndefined();
  });
});

describe("namespaces", () => {
  it("splits namespaces at the first dot", () => {
    expect(splitNamespace("db")).toEqual({ database: "db", collection: "" });
    expect(splitNamespace("db.a.b")).toEqual({ database: "db", collection: "a.b" });
  });

  it("explains invalid patterns", () => {
    expect(patternProblem("*")).toBeUndefined();
    expect(patternProblem("")).toBe("the pattern is empty");
    expect(patternProblem(".users")).toBe("the database part is empty");
    expect(patternProblem("shop.")).toBe("the collection part is empty");
    expect(patternProblem("my db.users")).toMatch(/cannot contain/);
  });

  it("matches wildcards and never matches invalid patterns", () => {
    expect(matchesPattern("*", "a.b")).toBe(true);
    expect(matchesPattern("shop", "shop.users")).toBe(false);
    expect(matchesPattern("sh*.u(s)ers", "shop.u(s)ers")).toBe(true);
    expect(isSelected("a.b", [], ["a.*"])).toBe(false);
    expect(isSelected("a.b", ["x.*"], [])).toBe(false);
  });

  it("lists every namespace of a tree", () => {
    expect(
      namespacesOf([
        {
          name: "a",
          collections: [{ name: "x", type: "collection", estimatedDocuments: 0, indexes: 0 }],
        },
        { name: "b", collections: [] },
      ]),
    ).toEqual(["a.x"]);
  });

  it("renames exact and single-wildcard rules and leaves others alone", () => {
    expect(applyRename("shop.users", { "shop.users": "copy.users" })).toBe("copy.users");
    expect(applyRename("shop.users", { "shop.*": "copy.*" })).toBe("copy.users");
    expect(applyRename("shop.users", { "*.*": "x.y", "other.*": "o.*" })).toBe("shop.users");
  });
});
