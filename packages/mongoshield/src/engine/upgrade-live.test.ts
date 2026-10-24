// The live checks of upgrade rehearsals against a scripted fake database, for the
// outcomes a healthy test server never produces (invalid collections, failing
// validators, undefined values). The real thing runs in
// test/integration/upgrade-rehearsal.test.ts.

import type { Db, Document, MongoClient } from "mongodb";
import { describe, expect, it } from "vitest";
import type { BackedUpCollection } from "./upgrade-compat.ts";
import {
  countUndefined,
  evaluateValidator,
  queryView,
  runLiveChecks,
  VIEW_SAMPLE,
  validateCollection,
} from "./upgrade-live.ts";

/** How the fake database answers. */
interface Script {
  readonly validate?: Document | Error;
  readonly find?: Document[] | Error;
  /** Answers countDocuments, by the JSON of its filter (default 0). */
  readonly counts?: Readonly<Record<string, number | Error>>;
}

/** A Db that answers from the script and records what was asked. */
function fakeDb(script: Script, asked: string[] = []): Db {
  const db = {
    command: async (command: Document) => {
      asked.push(`command ${JSON.stringify(command)}`);
      if (script.validate instanceof Error) throw script.validate;
      return script.validate ?? { valid: true, warnings: [], nrecords: 1, nIndexes: 1 };
    },
    collection: (name: string) => ({
      find: (filter: Document, options: Document) => ({
        toArray: async () => {
          asked.push(`find ${name} ${JSON.stringify(filter)} ${JSON.stringify(options)}`);
          if (script.find instanceof Error) throw script.find;
          return script.find ?? [];
        },
      }),
      countDocuments: async (filter: Document) => {
        const key = JSON.stringify(filter);
        asked.push(`count ${name} ${key}`);
        const answer = script.counts?.[key] ?? 0;
        if (answer instanceof Error) throw answer;
        return answer;
      },
    }),
  };
  return db as unknown as Db;
}

describe("validateCollection", () => {
  it("passes a valid collection and says what it checked", async () => {
    expect(
      await validateCollection(
        fakeDb({ validate: { valid: true, warnings: [], nrecords: 3, nIndexes: 2 } }),
        "c",
        "app.c",
      ),
    ).toEqual({
      ns: "app.c",
      check: "validate",
      outcome: "passed",
      message: "validate passed (3 records, 2 indexes)",
    });
    expect(
      (
        await validateCollection(
          fakeDb({ validate: { valid: true, nrecords: 1, nIndexes: 1 } }),
          "c",
          "app.c",
        )
      ).message,
    ).toBe("validate passed (1 record, 1 index)");
    expect(
      (await validateCollection(fakeDb({ validate: { valid: true } }), "c", "app.c")).message,
    ).toBe("validate passed (? indexes)");
  });

  it("reports an invalid collection with its first errors", async () => {
    const check = await validateCollection(
      fakeDb({ validate: { valid: false, errors: ["e1", "e2", "e3", "e4"] } }),
      "c",
      "app.c",
    );
    expect(check).toMatchObject({
      outcome: "problem",
      message: "validate found the restored collection invalid: e1; e2; e3",
    });
    expect(
      (await validateCollection(fakeDb({ validate: { valid: false } }), "c", "app.c")).message,
    ).toBe("validate found the restored collection invalid");
  });

  it("turns warnings and a failing command into warnings", async () => {
    expect(
      await validateCollection(
        fakeDb({ validate: { valid: true, warnings: ["w"] } }),
        "c",
        "app.c",
      ),
    ).toMatchObject({
      outcome: "warning",
      message: "validate passed with warnings: w",
    });
    expect(
      await validateCollection(fakeDb({ validate: new Error("not\n  allowed") }), "c", "app.c"),
    ).toMatchObject({
      outcome: "warning",
      message: "could not run validate: not allowed",
    });
  });
});

describe("queryView", () => {
  it("reads the first documents of the view", async () => {
    const asked: string[] = [];
    const check = await queryView(fakeDb({ find: [{}, {}] }, asked), "v", "app.v");
    expect(check).toMatchObject({ outcome: "passed", message: "the view runs (2 documents read)" });
    expect(asked).toEqual([`find v {} {"limit":${VIEW_SAMPLE}}`]);
  });

  it("reports a view the server cannot run, on one line", async () => {
    const check = await queryView(
      fakeDb({ find: new Error("TypeError: Array.concat is not a function :\n@:1:29\n") }),
      "v",
      "app.v",
    );
    expect(check).toMatchObject({
      outcome: "problem",
      message: "querying the view fails: TypeError: Array.concat is not a function : @:1:29",
    });
  });
});

describe("evaluateValidator", () => {
  const validator = { a: { $gt: 1 } };
  const failing = JSON.stringify({ $nor: [validator] });

  it("passes when every document satisfies the validator", async () => {
    expect(await evaluateValidator(fakeDb({}), "c", "app.c", validator)).toMatchObject({
      outcome: "passed",
    });
  });

  it("warns about documents that do not", async () => {
    expect(
      (await evaluateValidator(fakeDb({ counts: { [failing]: 1 } }), "c", "app.c", validator))
        .message,
    ).toMatch(/^1 document does not satisfy .* updates to it will be rejected/);
    expect(
      (await evaluateValidator(fakeDb({ counts: { [failing]: 4 } }), "c", "app.c", validator))
        .message,
    ).toMatch(/^4 documents do not satisfy .* updates to them/);
  });

  it("reports a validator the server cannot evaluate", async () => {
    expect(
      await evaluateValidator(
        fakeDb({ counts: { [failing]: new Error("unknown operator") } }),
        "c",
        "app.c",
        validator,
      ),
    ).toMatchObject({
      outcome: "problem",
      message: "the validator cannot be evaluated: unknown operator",
    });
  });
});

describe("countUndefined", () => {
  const validator = { $or: [{ deletedAt: null }, { archivedAt: null }, { ownerId: null }] };
  const filter = (path: string) => JSON.stringify({ [path]: { $type: "undefined" } });

  it("counts undefined values in every field compared with null", async () => {
    const checks = await countUndefined(
      fakeDb({
        counts: {
          [filter("archivedAt")]: 1,
          [filter("deletedAt")]: 3,
          [filter("ownerId")]: new Error("boom"),
        },
      }),
      "c",
      "app.c",
      validator,
    );
    expect(checks.map((check) => check.outcome)).toEqual(["problem", "problem", "warning"]);
    expect(checks[0]?.message).toMatch(/^1 document holds undefined in "archivedAt"/);
    expect(checks[1]?.message).toMatch(/^3 documents hold undefined in "deletedAt"/);
    expect(checks[2]?.message).toBe('could not count undefined values in "ownerId": boom');
    expect(checks[0]?.message).toContain("updates to it fail validation");
    expect(checks[1]?.message).toContain("updates to them fail validation");
  });

  it("passes fields without undefined values", async () => {
    expect(await countUndefined(fakeDb({}), "c", "app.c", { a: null })).toEqual([
      {
        ns: "app.c",
        check: "undefined",
        outcome: "passed",
        message: 'no document holds undefined in "a"',
      },
    ]);
  });
});

describe("runLiveChecks", () => {
  /** A client whose every database is the same fake. */
  function fakeClient(db: Db): MongoClient {
    return { db: () => db } as unknown as MongoClient;
  }

  const withValidator: BackedUpCollection = {
    ns: "app.c",
    type: "collection",
    metadata: {
      collectionName: "c",
      type: "collection",
      options: { validator: { a: null } },
      indexes: [],
    },
  };

  it("validates collections, queries views, evaluates validators, and counts undefined when asked", async () => {
    const asked: string[] = [];
    const entries = [
      { from: "app.c", to: "tmp_app.c", type: "collection" as const },
      { from: "app.v", to: "tmp_app.v", type: "view" as const },
      { from: "app.t", to: "tmp_app.t", type: "timeseries" as const },
    ];
    const collections = new Map([["app.c", withValidator]]);
    const checks = await runLiveChecks({
      client: fakeClient(fakeDb({}, asked)),
      entries: entries as never,
      collections,
      checkUndefined: true,
    });
    expect(checks.map((check) => `${check.ns} ${check.check}`)).toEqual([
      "app.c validate",
      "app.c validator",
      "app.c undefined",
      "app.v view",
      "app.t validate",
    ]);

    const without = await runLiveChecks({
      client: fakeClient(fakeDb({})),
      entries: entries.slice(0, 1) as never,
      collections,
      checkUndefined: false,
    });
    expect(without.map((check) => check.check)).toEqual(["validate", "validator"]);
  });

  it("stops when aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      runLiveChecks({
        client: fakeClient(fakeDb({})),
        entries: [{ from: "app.c", to: "t.c", type: "collection" }] as never,
        collections: new Map(),
        checkUndefined: false,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ code: "MS_ABORTED" });
  });
});
