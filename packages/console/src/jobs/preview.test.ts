import { describe, expect, it } from "vitest";
import {
  MAX_PREVIEWS,
  PREVIEW_TTL_MS,
  type PreviewRecord,
  PreviewStore,
  previewPage,
  restoreEffect,
  resultOf,
} from "./preview.ts";

const documents = { backup: 10, live: 9, backupOnly: 2, liveOnly: 1, changed: 3, identical: 5 };

describe("restoreEffect", () => {
  it("follows the plan's action", () => {
    expect(restoreEffect("create", documents)).toEqual({
      inserted: 2,
      replaced: 0,
      deleted: 0,
      kept: 0,
    });
    expect(restoreEffect("drop-and-create", documents)).toEqual({
      inserted: 2,
      replaced: 3,
      deleted: 1,
      kept: 5,
    });
    expect(restoreEffect("upsert", documents)).toEqual({
      inserted: 2,
      replaced: 3,
      deleted: 0,
      kept: 6,
    });
    expect(restoreEffect("insert", documents)).toEqual({
      inserted: 2,
      replaced: 0,
      deleted: 0,
      kept: 9,
    });
  });

  it("has no effect for namespaces the restore would not touch", () => {
    expect(restoreEffect("conflict", documents)).toBeUndefined();
    expect(restoreEffect("skip", documents)).toBeUndefined();
  });
});

function record(jobId: string, createdAt: Date, withResult = true): PreviewRecord {
  return {
    jobId,
    storageId: "s",
    backupId: "b",
    targetConnectionId: "c",
    mode: "upsert",
    createdAt,
    outcome: withResult
      ? {
          result: {
            namespaces: [],
            ids: new Map([
              [
                "app.users",
                {
                  changed: ['{"$numberInt":"1"}', '{"$numberInt":"2"}', '{"$numberInt":"3"}'],
                  "backup-only": [],
                  "live-only": [],
                },
              ],
            ]),
          },
        }
      : {},
  };
}

describe("PreviewStore", () => {
  it("forgets previews after their time to live", () => {
    let now = new Date("2026-10-21T10:00:00Z");
    const store = new PreviewStore(() => now);
    store.add(record("a", now));
    expect(store.get("a").jobId).toBe("a");
    expect(store.expiresAt(store.get("a")).getTime() - now.getTime()).toBe(PREVIEW_TTL_MS);
    now = new Date(now.getTime() + PREVIEW_TTL_MS);
    expect(() => store.get("a")).toThrow(/preview was not found/);
  });

  it("keeps at most MAX_PREVIEWS, dropping the oldest", () => {
    const now = new Date("2026-10-21T10:00:00Z");
    const store = new PreviewStore(() => now);
    for (let index = 0; index <= MAX_PREVIEWS; index++) store.add(record(`p${index}`, now));
    expect(() => store.get("p0")).toThrow(/not found/);
    expect(store.get(`p${MAX_PREVIEWS}`).jobId).toBe(`p${MAX_PREVIEWS}`);
  });
});

describe("previewPage", () => {
  const result = resultOf(record("a", new Date()));

  it("pages by position and labels ids as relaxed Extended JSON", () => {
    const first = previewPage(result, "app.users", "changed", 2, 0);
    expect(first).toEqual({
      documents: [
        { id: '{"$numberInt":"1"}', label: "1" },
        { id: '{"$numberInt":"2"}', label: "2" },
      ],
      listed: 3,
      next: "2",
    });
    expect(previewPage(result, "app.users", "changed", 2, 2)).toEqual({
      documents: [{ id: '{"$numberInt":"3"}', label: "3" }],
      listed: 3,
    });
    expect(previewPage(result, "app.users", "live-only", 2, 0)).toEqual({
      documents: [],
      listed: 0,
    });
  });

  it("refuses namespaces outside the preview and previews without a result", () => {
    expect(() => previewPage(result, "app.other", "changed", 2, 0)).toThrow(/not found/);
    expect(() => resultOf(record("b", new Date(), false))).toThrow(/no result/);
  });
});
