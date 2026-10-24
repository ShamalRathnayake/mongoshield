/**
 * Unit tests for view-prefs.ts, pacer.ts and viewer-model.ts: remembering views, columns
 * and query history per collection (and surviving broken or blocked storage), pacing the
 * background queries (one at a time, with a gap on Atlas shared tiers, dropping cancelled
 * ones), and the viewer's document and sort model.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { Pacer, PacerAbortError, pacerFor } from "./pacer.ts";
import {
  HISTORY_LIMIT,
  isViewMode,
  lastCollection,
  loadPrefs,
  rememberCollection,
  rememberQuery,
  updatePrefs,
} from "./view-prefs.ts";
import { nextSort, sortJsonOf, sortStateOf, toViewerDocuments } from "./viewer-model.ts";

afterEach(() => {
  window.localStorage.clear();
  vi.restoreAllMocks();
});

describe("viewer preferences", () => {
  it("remembers the view per collection, and offers the last one used for new collections", () => {
    expect(loadPrefs("live:a:db.c")).toEqual({});
    updatePrefs("live:a:db.c", { view: "cards" });
    expect(loadPrefs("live:a:db.c").view).toBe("cards");
    expect(loadPrefs("live:a:db.other").view).toBe("cards");
    updatePrefs("live:a:db.other", { view: "schema" });
    expect(loadPrefs("live:a:db.c").view).toBe("cards");
  });

  it("validates what it reads: bad views, widths and history entries are dropped or fixed", () => {
    window.localStorage.setItem(
      "mongoshield.viewer.s",
      JSON.stringify({
        view: "spreadsheet",
        columns: {
          order: ["a", 1],
          hidden: "nope",
          widths: { a: 5, b: 99_999, c: "wide", d: 200 },
        },
        cardTitle: "",
        chartField: "status",
        history: [{ filter: '{"a":1}' }, {}, "x", { sort: '{"a":-1}', projection: '{"a":1}' }],
      }),
    );
    expect(loadPrefs("s")).toEqual({
      columns: { order: ["a"], hidden: [], widths: { a: 60, b: 1200, d: 200 } },
      chartField: "status",
      history: [{ filter: '{"a":1}' }, { sort: '{"a":-1}', projection: '{"a":1}' }],
    });
    window.localStorage.setItem("mongoshield.viewer.t", "not json");
    expect(loadPrefs("t")).toEqual({});
    expect(isViewMode("table")).toBe(true);
    expect(isViewMode(3)).toBe(false);
  });

  it("keeps a query history, newest first, without duplicates or empty queries", () => {
    rememberQuery("h", { filter: '{"a":1}' });
    rememberQuery("h", { filter: '{"b":1}' });
    rememberQuery("h", { filter: '{"a":1}' });
    expect(rememberQuery("h", {})).toHaveLength(2);
    expect(loadPrefs("h").history?.map((entry) => entry.filter)).toEqual(['{"a":1}', '{"b":1}']);
    for (let index = 0; index < HISTORY_LIMIT + 5; index += 1)
      rememberQuery("h", { filter: `${index}` });
    expect(loadPrefs("h").history).toHaveLength(HISTORY_LIMIT);
  });

  it("remembers the last collection per connection", () => {
    expect(lastCollection("conn")).toBeUndefined();
    rememberCollection("conn", "shop.orders");
    expect(lastCollection("conn")).toBe("shop.orders");
  });

  it("works without storage (private windows, blocked site data)", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("SecurityError");
    });
    expect(updatePrefs("x", { view: "json" }).view).toBe("json");
    expect(loadPrefs("x")).toEqual({});
    expect(lastCollection("conn")).toBeUndefined();
  });
});

describe("pacing background queries", () => {
  /** A fake clock: `sleep` advances time at once and records each wait. */
  function fakeClock() {
    let now = 1_000;
    const waits: number[] = [];
    return {
      waits,
      clock: {
        now: () => now,
        sleep: async (ms: number) => {
          waits.push(ms);
          now += ms;
        },
      },
      advance: (ms: number) => {
        now += ms;
      },
    };
  }

  it("runs one task at a time, in order", async () => {
    const pacer = new Pacer(0);
    const events: string[] = [];
    const task = (name: string) => async () => {
      events.push(`start ${name}`);
      await Promise.resolve();
      events.push(`end ${name}`);
      return name;
    };
    const results = await Promise.all([
      pacer.run(task("a")),
      pacer.run(task("b")),
      pacer.run(task("c")),
    ]);
    expect(results).toEqual(["a", "b", "c"]);
    expect(events).toEqual(["start a", "end a", "start b", "end b", "start c", "end c"]);
    expect(pacer.pending).toBe(0);
  });

  it("waits the gap between task starts on a throttled (Atlas shared tier) connection", async () => {
    const { clock, waits } = fakeClock();
    const pacer = new Pacer(1_000, clock);
    await Promise.all([
      pacer.run(async () => 1),
      pacer.run(async () => 2),
      pacer.run(async () => 3),
    ]);
    // The first starts at once; the next two wait a whole gap each.
    expect(waits).toEqual([1_000, 1_000]);
  });

  it("does not wait when the gap has already passed, and can change the gap", async () => {
    const { clock, waits, advance } = fakeClock();
    const pacer = new Pacer(1_000, clock);
    await pacer.run(async () => 1);
    advance(5_000);
    await pacer.run(async () => 2);
    expect(waits).toEqual([]);
    pacer.setGap(0);
    await Promise.all([pacer.run(async () => 3), pacer.run(async () => 4)]);
    expect(waits).toEqual([]);
  });

  it("drops tasks whose caller went away before they started", async () => {
    const { clock } = fakeClock();
    const pacer = new Pacer(1_000, clock);
    const before = new AbortController();
    before.abort();
    await expect(pacer.run(async () => 1, before.signal)).rejects.toBeInstanceOf(PacerAbortError);

    // Aborted while waiting in the queue behind another task.
    const queued = new AbortController();
    let ran = false;
    const first = pacer.run(async () => {
      queued.abort();
      return "first";
    });
    const second = pacer.run(async () => {
      ran = true;
    }, queued.signal);
    expect(await first).toBe("first");
    await expect(second).rejects.toBeInstanceOf(PacerAbortError);
    expect(ran).toBe(false);
  });

  it("drops a task cancelled during the gap, and passes errors through", async () => {
    const controller = new AbortController();
    const pacer = new Pacer(1_000, {
      now: () => 0,
      sleep: async () => controller.abort(),
    });
    await pacer.run(async () => 1);
    await expect(pacer.run(async () => 2, controller.signal)).rejects.toBeInstanceOf(
      PacerAbortError,
    );
    await expect(
      pacer.run(async () => {
        throw new Error("refused");
      }),
    ).rejects.toThrow("refused");
  });

  it("shares one pacer per connection", () => {
    expect(pacerFor("live:x")).toBe(pacerFor("live:x"));
    expect(pacerFor("live:x")).not.toBe(pacerFor("live:y"));
  });

  it("uses real timers by default", async () => {
    const pacer = new Pacer(1);
    await expect(
      Promise.all([pacer.run(async () => 1), pacer.run(async () => 2)]),
    ).resolves.toEqual([1, 2]);
  });
});

describe("viewer model", () => {
  it("builds documents with stable, unique keys and labels from their _id", () => {
    const documents = toViewerDocuments(
      [
        '{"_id": {"$oid": "65f1c2a0e4b0a1b2c3d4e5f6"}}',
        '{"_id": 1}',
        '{"_id": 1}',
        '{"a": 1}',
        "not json",
      ],
      ["canonical text"],
    );
    expect(documents.map((document) => document.key)).toEqual([
      '{"$oid":"65f1c2a0e4b0a1b2c3d4e5f6"}',
      "1",
      "1~1",
      "#3",
      "#4",
    ]);
    expect(documents[0]?.label).toBe('ObjectId("65f1c2a0e4b0a1b2c3d4e5f6")');
    expect(documents[0]?.canonical).toBe("canonical text");
    expect(documents[3]?.idJson).toBeUndefined();
    expect(documents[4]?.value).toBeUndefined();
  });

  it("cycles a header sort: ascending, descending, off", () => {
    const ascending = nextSort(undefined, "a");
    expect(ascending).toEqual({ path: "a", direction: 1 });
    const descending = nextSort(ascending, "a");
    expect(descending).toEqual({ path: "a", direction: -1 });
    expect(nextSort(descending, "a")).toBeUndefined();
    expect(nextSort(descending, "b")).toEqual({ path: "b", direction: 1 });
  });

  it("reads single-field sorts from the sort box, and writes them back", () => {
    expect(sortStateOf('{"a":-1}')).toEqual({ path: "a", direction: -1 });
    expect(sortStateOf('{"a":1,"b":1}')).toBeUndefined();
    expect(sortStateOf('{"a":2}')).toBeUndefined();
    expect(sortStateOf("[1]")).toBeUndefined();
    expect(sortStateOf("nope")).toBeUndefined();
    expect(sortStateOf(undefined)).toBeUndefined();
    expect(sortJsonOf({ path: "a", direction: -1 })).toBe('{"a":-1}');
    expect(sortJsonOf(undefined)).toBe("");
  });
});
