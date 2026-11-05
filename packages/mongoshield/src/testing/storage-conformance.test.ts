/**
 * Tests for the contract test kit itself (`mongoshield/testing/storage`): that it runs
 * under any framework shaped like `{ describe, it, beforeEach, afterEach }`, here a
 * tiny hand-written one, that it really fails a broken adapter, and that it skips
 * capability tests through a node:test-style context.
 */

import { describe, expect, it } from "vitest";
import { throwIfAborted } from "../errors.ts";
import { memoryStorage } from "../storage/memory.ts";
import type { StorageAdapter, StorageSpace } from "../storage/types.ts";
import {
  describeStorageConformance,
  type StorageConformanceFixture,
  type StorageTestApi,
  type StorageTestBody,
} from "./storage-conformance.ts";

/** The outcome of one test run by the mini framework. */
interface Outcome {
  readonly name: string;
  readonly status: "passed" | "failed" | "skipped";
  readonly error?: unknown;
}

/** A group of tests and hooks, as `describe` builds it. */
interface Group {
  readonly name: string;
  readonly beforeEach: StorageTestBody[];
  readonly afterEach: StorageTestBody[];
  readonly tests: { name: string; body: StorageTestBody; timeoutMs: number | undefined }[];
  readonly groups: Group[];
}

/**
 * A minimal test framework: collects tests, then runs each one with the `beforeEach`
 * hooks of its enclosing groups (outermost first) and the `afterEach` hooks after it
 * (innermost first). Each test gets a context with `skip()`, like node:test's.
 */
function miniFramework(): {
  api: StorageTestApi;
  run: () => Promise<Outcome[]>;
  bodies: () => StorageTestBody[];
} {
  const root: Group = { name: "", beforeEach: [], afterEach: [], tests: [], groups: [] };
  let current = root;

  const api: StorageTestApi = {
    describe(name, body) {
      const group: Group = { name, beforeEach: [], afterEach: [], tests: [], groups: [] };
      current.groups.push(group);
      const parent = current;
      current = group;
      body();
      current = parent;
    },
    it(name, body, timeoutMs) {
      current.tests.push({ name, body, timeoutMs });
    },
    beforeEach(hook) {
      current.beforeEach.push(hook);
    },
    afterEach(hook) {
      current.afterEach.push(hook);
    },
  };

  async function runGroup(group: Group, parents: Group[], outcomes: Outcome[]): Promise<void> {
    const chain = [...parents, group];
    for (const test of group.tests) {
      const name = [...chain.map((each) => each.name), test.name].filter(Boolean).join(" > ");
      let skipped = false;
      const context = {
        skip() {
          skipped = true;
        },
      };
      try {
        for (const each of chain) for (const hook of each.beforeEach) await hook(context);
        try {
          await test.body(context);
        } finally {
          for (const each of [...chain].reverse())
            for (const hook of each.afterEach) await hook(context);
        }
        outcomes.push({ name, status: skipped ? "skipped" : "passed" });
      } catch (error) {
        outcomes.push({ name, status: "failed", error });
      }
    }
    for (const child of group.groups) await runGroup(child, chain, outcomes);
  }

  function allBodies(group: Group): StorageTestBody[] {
    return [...group.tests.map((test) => test.body), ...group.groups.flatMap(allBodies)];
  }

  return {
    api,
    run: async () => {
      const outcomes: Outcome[] = [];
      await runGroup(root, [], outcomes);
      return outcomes;
    },
    bodies: () => allBodies(root),
  };
}

const memoryFixture = async (): Promise<StorageConformanceFixture> => ({
  storage: memoryStorage(),
  cleanup: async () => {},
});

describe("the storage contract test kit", () => {
  it("runs without a test framework of its own and passes a correct adapter", async () => {
    const framework = miniFramework();
    describeStorageConformance("memory", memoryFixture, framework.api);
    const outcomes = await framework.run();

    expect(outcomes.length).toBeGreaterThan(50);
    expect(outcomes.filter((outcome) => outcome.status === "failed")).toEqual([]);
    // The memory store cannot lock objects and has no space(): those tests skip themselves.
    const skipped = outcomes.filter((outcome) => outcome.status === "skipped").map((o) => o.name);
    expect(skipped).toContain(
      "memory storage conformance > write-once retention > stores a retained object that reads back normally",
    );
    expect(skipped.some((name) => name.includes("free space"))).toBe(true);
  });

  it("fails an adapter that breaks the contract, with an assertion error", async () => {
    const framework = miniFramework();
    describeStorageConformance(
      "unsorted",
      async () => ({ storage: unsortedListing(memoryStorage()), cleanup: async () => {} }),
      framework.api,
    );
    const outcomes = await framework.run();
    const failed = outcomes.filter((outcome) => outcome.status === "failed");
    expect(failed.map((outcome) => outcome.name)).toContain(
      "unsorted storage conformance > list > lists every object recursively in lexicographic key order",
    );
    expect(failed[0]?.error).toBeInstanceOf(Error);
    expect(failed[0]?.error instanceof Error && failed[0].error.name).toBe("AssertionError");
  });

  it("checks space() when the adapter has one, and catches inconsistent numbers", async () => {
    const framework = miniFramework();
    describeStorageConformance(
      "bad space",
      async () => ({
        storage: withSpace(memoryStorage(), { totalBytes: 100, usedBytes: 50, trashBytes: 80 }),
        cleanup: async () => {},
      }),
      framework.api,
    );
    const outcomes = await framework.run();
    const failed = outcomes.filter((outcome) => outcome.status === "failed");
    expect(failed.map((outcome) => outcome.name)).toEqual([
      "bad space storage conformance > free space > reports consistent byte counts from space(), when it has one",
    ]);
    expect(String(failed[0]?.error)).toContain("trashBytes must be included in usedBytes");
  });

  it("registers test bodies without declared parameters, so Jest and Mocha never wait for done()", () => {
    const framework = miniFramework();
    describeStorageConformance("memory", memoryFixture, framework.api);
    const bodies = framework.bodies();
    expect(bodies.length).toBeGreaterThan(50);
    for (const body of bodies) expect(body.length).toBe(0);
  });

  it("asks for a longer timeout only for the 10 MiB streaming test", () => {
    const timeouts: { name: string; timeoutMs: number | undefined }[] = [];
    const framework = miniFramework();
    describeStorageConformance("memory", memoryFixture, {
      ...framework.api,
      it(name, body, timeoutMs) {
        timeouts.push({ name, timeoutMs });
        framework.api.it(name, body, timeoutMs);
      },
    });
    expect(timeouts.filter((entry) => entry.timeoutMs !== undefined)).toEqual([
      { name: "streams an object larger than 10 MiB without corrupting it", timeoutMs: 60_000 },
    ]);
  });
});

/** The memory adapter, but listing in reverse order: a contract violation. */
function unsortedListing(storage: StorageAdapter): StorageAdapter {
  return {
    ...storage,
    async *list(prefix, options) {
      const infos = [];
      for await (const info of storage.list(prefix, options)) infos.push(info);
      yield* infos.reverse();
    },
  };
}

/** The memory adapter with a fixed `space()` answer. */
function withSpace(storage: StorageAdapter, space: StorageSpace): StorageAdapter {
  return {
    ...storage,
    async space(options) {
      throwIfAborted(options?.signal);
      return space;
    },
  };
}
