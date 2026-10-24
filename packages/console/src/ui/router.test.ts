/**
 * Tests for the hash router's pure parts: parsing locations, matching patterns and
 * building links.
 */

import { describe, expect, it } from "vitest";
import { buildHref, matchPath, parseLocation, segment } from "./router.ts";

describe("parseLocation", () => {
  it("treats an empty hash as the root path", () => {
    expect(parseLocation("").path).toBe("/");
    expect(parseLocation("#").path).toBe("/");
  });

  it("splits the path from the query inside the hash", () => {
    const location = parseLocation("#/backups/s3/abc?tab=browse&x=1");
    expect(location.path).toBe("/backups/s3/abc");
    expect(location.query.get("tab")).toBe("browse");
    expect(location.query.get("x")).toBe("1");
  });

  it("adds a missing leading slash", () => {
    expect(parseLocation("#plans").path).toBe("/plans");
  });
});

describe("matchPath", () => {
  it("returns decoded parameters for a matching path", () => {
    expect(
      matchPath("/backups/:storageId/:backupId", "/backups/s3%20main/2026-10-21T02-00-04Z_7f3a9c"),
    ).toEqual({
      storageId: "s3 main",
      backupId: "2026-10-21T02-00-04Z_7f3a9c",
    });
  });

  it("requires the same number of segments and equal literal segments", () => {
    expect(matchPath("/plans/:id", "/plans")).toBeUndefined();
    expect(matchPath("/plans/:id", "/plans/a/b")).toBeUndefined();
    expect(matchPath("/plans/new", "/plans/abc")).toBeUndefined();
    expect(matchPath("/plans/new", "/plans/new/")).toEqual({});
  });

  it("does not match malformed escapes", () => {
    expect(matchPath("/jobs/:id", "/jobs/%E0%A4%A")).toBeUndefined();
  });
});

describe("buildHref", () => {
  it("builds hash links and leaves out empty query values", () => {
    expect(buildHref("/jobs")).toBe("#/jobs");
    expect(buildHref("/backups/s3", { tab: "browse", empty: "", missing: undefined })).toBe(
      "#/backups/s3?tab=browse",
    );
  });

  it("round-trips encoded segments through matchPath", () => {
    const href = buildHref(`/jobs/${segment("job/1 ü")}`);
    const { path } = parseLocation(href);
    expect(matchPath("/jobs/:id", path)).toEqual({ id: "job/1 ü" });
  });
});
