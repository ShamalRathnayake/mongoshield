// Integration tests for checkpointed, resumable copies: a copy interrupted mid-way
// (deterministically, by a mask function that fails after N documents) continues from
// its checkpoint, and the result is exactly what one uninterrupted copy produces,
// masked and subset alike. Also: what refuses to resume, and time series restarts.

import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Document, Int32 } from "mongodb";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { planCopy, runCopy } from "../../src/copy/copy.ts";
import type { CopyEngineOptions } from "../../src/copy/copy-plan.ts";
import { isMongoShieldError } from "../../src/errors.ts";
import type { LogFields, Logger } from "../../src/logger.ts";
import { silentLogger } from "../../src/logger.ts";
import type { MaskConfig } from "../../src/mask/index.ts";
import { uniqueDb, useMongoClient } from "../helpers/mongo.ts";

const client = useMongoClient();

const SECRET = "resume-test-secret-0123456789abcdef";

/** More than two checkpoint chunks (10 000 documents each). */
const DOCUMENTS = 25_000;

let workDir: string;

beforeAll(async () => {
  workDir = await mkdtemp(join(tmpdir(), "mongoshield-copy-resume-"));
});

afterAll(async () => {
  await rm(workDir, { recursive: true, force: true });
});

function copy(options: CopyEngineOptions, logger: Logger = silentLogger) {
  return runCopy({ source: client(), target: client(), logger }, options);
}

/** Inserts `count` users with Int32 ids, emails and a group number. */
async function seedUsers(database: string, count: number): Promise<void> {
  const users = client().db(database).collection<{ _id: Int32 }>("users");
  const documents = Array.from({ length: count }, (_, index) => ({
    _id: new Int32(index + 1),
    email: `user${index + 1}@corp.com`,
    group: index % 10,
    managerId: index === 0 ? null : new Int32(Math.ceil(index / 2)),
  }));
  for (let start = 0; start < documents.length; start += 5000) {
    await users.insertMany(documents.slice(start, start + 5000));
  }
}

/**
 * A mask whose custom function can be told to fail after `limit` documents, which
 * stops the copy mid-way at a deterministic point. The function's source is the
 * same in every run, so the checkpoint's fingerprint matches when resuming.
 */
function failingMask(database: string): { mask: MaskConfig; failAfter: (limit?: number) => void } {
  let seen = 0;
  let limit: number | undefined;
  const mask: MaskConfig = {
    secret: SECRET,
    rules: {
      [`${database}.users`]: {
        _id: "hash",
        managerId: "hash",
        email: { fake: "email" },
        group: (value: unknown) => {
          seen += 1;
          if (limit !== undefined && seen > limit) throw new Error("interrupted on purpose");
          return value;
        },
      },
    },
  };
  return {
    mask,
    failAfter: (next) => {
      seen = 0;
      limit = next;
    },
  };
}

/** The same options for an ordinary (not checkpointed) copy. */
function withoutCheckpoint(options: CopyEngineOptions): CopyEngineOptions {
  const { checkpoint: _checkpoint, ...rest } = options;
  return rest;
}

async function sortedDocuments(database: string, collection: string): Promise<Document[]> {
  return client().db(database).collection(collection).find().sort({ _id: 1 }).toArray();
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

function recordingLogger(): Logger & { readonly warnings: string[] } {
  const warnings: string[] = [];
  const ignore = (_message: string, _fields?: LogFields): void => {};
  return {
    warnings,
    debug: ignore,
    info: ignore,
    error: ignore,
    warn: (message) => warnings.push(message),
  };
}

describe("resumable copy", () => {
  it("continues an interrupted copy and ends with exactly the uninterrupted result", async () => {
    const source = uniqueDb("src");
    const target = uniqueDb("dst");
    const reference = uniqueDb("ref");
    await seedUsers(source, DOCUMENTS);
    const checkpoint = join(workDir, `${target}.json`);
    const { mask, failAfter } = failingMask(source);
    const base = {
      include: [`${source}.users`],
      rename: { [`${source}.*`]: `${target}.*` },
      mask,
      checkpoint,
      // Several parts of about 300 KB each, copied two at a time.
      partSizeBytes: 300_000,
      parallelism: 2,
    };

    failAfter(15_000);
    const failure = await copy(base).catch((error: unknown) => error);
    expect(isMongoShieldError(failure, "MS_CONFIG_INVALID")).toBe(true);
    expect(String(failure)).toContain("interrupted on purpose");
    expect(isMongoShieldError(failure) && failure.hint).toContain("--resume");
    const saved = JSON.parse(await readFile(checkpoint, "utf8"));
    expect(saved.namespaces[0].parts.length).toBeGreaterThan(1);
    const copiedBefore = await client().db(target).collection("users").countDocuments();
    expect(copiedBefore).toBeGreaterThan(0);
    expect(copiedBefore).toBeLessThan(DOCUMENTS);

    // The plan of the resumed copy shows what is left; the target is not a conflict.
    const plan = await planCopy(
      { source: client(), target: client(), logger: silentLogger },
      { ...base, resume: true },
    );
    expect(plan.entries[0]).toMatchObject({ action: "create", resume: "partial" });

    failAfter(undefined);
    const resumed = await copy({ ...base, resume: true });
    expect(resumed.resumed).toBe(true);
    // Only what was missing was written, and the checkpoint is gone.
    expect(resumed.documentsCopied).toBe(DOCUMENTS - copiedBefore);
    expect(await exists(checkpoint)).toBe(false);

    await copy({ ...withoutCheckpoint(base), rename: { [`${source}.*`]: `${reference}.*` } });
    const copied = await sortedDocuments(target, "users");
    expect(copied).toHaveLength(DOCUMENTS);
    expect(copied).toEqual(await sortedDocuments(reference, "users"));
  });

  it("selects the same subset when resumed, even if the filter changed meanwhile", async () => {
    const source = uniqueDb("src");
    const target = uniqueDb("dst");
    const reference = uniqueDb("ref");
    await seedUsers(source, DOCUMENTS);
    const checkpoint = join(workDir, `${target}.json`);
    const { mask, failAfter } = failingMask(source);
    // Like a filter computed from the clock: different on the second run.
    const subsetFor = (groups: number[]) => ({
      filters: { [`${source}.users`]: { group: { $in: groups } } },
      follow: [{ from: `${source}.users.managerId`, to: `${source}.users._id` }],
    });
    const base = {
      include: [`${source}.users`],
      rename: { [`${source}.*`]: `${target}.*` },
      mask,
      checkpoint,
    };

    failAfter(12_000);
    await expect(copy({ ...base, subset: subsetFor([1, 2, 3, 4, 5, 6]) })).rejects.toThrow(
      /interrupted on purpose/,
    );
    failAfter(undefined);
    const logger = recordingLogger();
    await copy({ ...base, subset: subsetFor([7]), resume: true }, logger);
    expect(logger.warnings.join("\n")).toContain("subset filters differ");

    await copy({
      ...withoutCheckpoint(base),
      rename: { [`${source}.*`]: `${reference}.*` },
      subset: subsetFor([1, 2, 3, 4, 5, 6]),
    });
    const copied = await sortedDocuments(target, "users");
    expect(copied).toEqual(await sortedDocuments(reference, "users"));
    // The managers of the filtered users were followed (more than the filter's 60%).
    expect(copied.length).toBeGreaterThan(15_000);
  });

  it("refuses to resume with different options, without a checkpoint, or after the target changed", async () => {
    const source = uniqueDb("src");
    const target = uniqueDb("dst");
    await seedUsers(source, DOCUMENTS);
    const checkpoint = join(workDir, `${target}.json`);
    const { mask, failAfter } = failingMask(source);
    const base = {
      include: [`${source}.users`],
      rename: { [`${source}.*`]: `${target}.*` },
      mask,
      checkpoint,
    };
    failAfter(12_000);
    await expect(copy(base)).rejects.toThrow(/interrupted on purpose/);
    failAfter(undefined);

    const otherSecret = await copy({
      ...base,
      mask: { ...mask, secret: `${SECRET}-other` },
      resume: true,
    }).catch((error: unknown) => error);
    expect(isMongoShieldError(otherSecret, "MS_CONFIG_INVALID")).toBe(true);
    expect(String(otherSecret)).toContain("the mask rules or secret");

    const missing = await copy({
      ...base,
      checkpoint: join(workDir, "none.json"),
      resume: true,
    }).catch((error: unknown) => error);
    expect(String(missing)).toContain("There is no interrupted copy to resume");
    await expect(copy({ ...withoutCheckpoint(base), resume: true })).rejects.toThrow(
      /resume needs the checkpoint file/,
    );

    await client().db(target).collection("users").drop();
    await client().db(target).createCollection("users");
    const replaced = await copy({ ...base, resume: true }).catch((error: unknown) => error);
    expect(String(replaced)).toContain(`${target}.users was dropped or replaced since`);
  });

  it("copies an interrupted time series again from the start instead of duplicating measurements", async () => {
    const source = uniqueDb("src");
    const target = uniqueDb("dst");
    const db = client().db(source);
    await db.createCollection("metrics", { timeseries: { timeField: "at", metaField: "host" } });
    const start = Date.UTC(2026, 9, 1);
    const measurements = Array.from({ length: 12_000 }, (_, index) => ({
      at: new Date(start + index * 1000),
      host: `h${index % 3}`,
      cpu: index,
    }));
    await db.collection("metrics").insertMany(measurements);
    const checkpoint = join(workDir, `${target}.json`);
    let seen = 0;
    let limit: number | undefined;
    const options = {
      include: [`${source}.metrics`],
      rename: { [`${source}.*`]: `${target}.*` },
      checkpoint,
      mask: {
        secret: SECRET,
        rules: {
          [`${source}.metrics`]: {
            cpu: (value: unknown) => {
              seen += 1;
              if (limit !== undefined && seen > limit) throw new Error("interrupted on purpose");
              return value;
            },
          },
        },
      },
    };
    limit = 5000;
    await expect(copy(options)).rejects.toThrow(/interrupted on purpose/);
    expect(await client().db(target).collection("metrics").countDocuments()).toBeGreaterThan(0);

    limit = undefined;
    const plan = await planCopy(
      { source: client(), target: client(), logger: silentLogger },
      { ...options, resume: true },
    );
    expect(plan.entries[0]?.resume).toBe("restart");
    await copy({ ...options, resume: true });
    expect(await client().db(target).collection("metrics").countDocuments()).toBe(12_000);
  });

  it("skips namespaces that were finished and still builds what was left", async () => {
    const source = uniqueDb("src");
    const target = uniqueDb("dst");
    await seedUsers(source, 100);
    await client().db(source).collection("users").createIndex({ email: 1 }, { name: "email_1" });
    await client()
      .db(source)
      .collection("orders")
      .insertOne({ userId: new Int32(1) });
    await client()
      .db(source)
      .createCollection("recent", { viewOn: "orders", pipeline: [{ $match: {} }] });
    const checkpoint = join(workDir, `${target}.json`);
    let fail = true;
    const options = {
      include: [`${source}.*`],
      rename: { [`${source}.*`]: `${target}.*` },
      checkpoint,
      parallelism: 1,
      mask: {
        secret: SECRET,
        rules: {
          [`${source}.orders`]: {
            userId: (value: unknown) => {
              if (fail) throw new Error("interrupted on purpose");
              return value;
            },
          },
        },
      },
    };
    await expect(copy(options)).rejects.toThrow(/interrupted on purpose/);
    fail = false;
    const plan = await planCopy(
      { source: client(), target: client(), logger: silentLogger },
      { ...options, resume: true },
    );
    const states = Object.fromEntries(plan.entries.map((entry) => [entry.from, entry.resume]));
    expect(states).toMatchObject({ [`${source}.recent`]: "not-started" });
    expect(states[`${source}.orders`]).toBe("partial");

    const result = await copy({ ...options, resume: true });
    expect(result.resumed).toBe(true);
    expect(await client().db(target).collection("orders").countDocuments()).toBe(1);
    expect(await client().db(target).collection("users").countDocuments()).toBe(100);
    expect(await client().db(target).collection("recent").countDocuments()).toBe(1);
    const indexes = await client().db(target).collection("users").listIndexes().toArray();
    expect(indexes.map((index) => index.name)).toContain("email_1");
  });

  it("skips what was finished before an abort, and follows references again after one", async () => {
    const source = uniqueDb("src");
    const target = uniqueDb("dst");
    await seedUsers(source, 200);
    await client()
      .db(source)
      .collection("orders")
      .insertMany(Array.from({ length: 50 }, (_, index) => ({ userId: new Int32(index + 1) })));
    const checkpoint = join(workDir, `${target}.json`);
    let failFollowing = true;
    const options = {
      include: [`${source}.*`],
      rename: { [`${source}.*`]: `${target}.*` },
      checkpoint,
      parallelism: 1,
      subset: {
        filters: { [`${source}.orders`]: {} },
        follow: [
          { from: `${source}.orders.userId`, to: `${source}.users._id` },
          { from: `${source}.users.managerId`, to: `${source}.users._id` },
        ],
      },
      mask: {
        secret: SECRET,
        rules: {
          // Users are only copied by following: failing there stops the follow phase.
          [`${source}.users`]: {
            email: (value: unknown) => {
              if (failFollowing) throw new Error("interrupted on purpose");
              return value;
            },
          },
        },
      },
    };
    await expect(copy(options)).rejects.toThrow(/interrupted on purpose/);
    const saved = JSON.parse(await readFile(checkpoint, "utf8"));
    expect(saved.referencesDone).toBe(false);
    expect(saved.namespaces.find((state: Document) => state.to.endsWith(".orders"))).toMatchObject({
      rootsDone: true,
    });

    failFollowing = false;
    await copy({ ...options, resume: true });
    const reference = uniqueDb("ref");
    await copy({ ...withoutCheckpoint(options), rename: { [`${source}.*`]: `${reference}.*` } });
    expect(await sortedDocuments(target, "users")).toEqual(
      await sortedDocuments(reference, "users"),
    );
    expect(await sortedDocuments(target, "orders")).toEqual(
      await sortedDocuments(reference, "orders"),
    );

    // An abort right after the first collection is finished: it is "done" next time.
    const second = uniqueDb("dst");
    const controller = new AbortController();
    const aborting = {
      ...withoutCheckpoint(options),
      checkpoint: join(workDir, `${second}.json`),
      rename: { [`${source}.*`]: `${second}.*` },
      onProgress: (event: { type: string }) => {
        if (event.type === "namespace:done") controller.abort();
      },
      signal: controller.signal,
    };
    const aborted = await copy(aborting).catch((error: unknown) => error);
    expect(isMongoShieldError(aborted, "MS_ABORTED")).toBe(true);
    const { onProgress: _onProgress, signal: _signal, ...again } = aborting;
    const plan = await planCopy(
      { source: client(), target: client(), logger: silentLogger },
      { ...again, resume: true },
    );
    expect(plan.entries.map((entry) => entry.resume)).toContain("done");
    await copy({ ...again, resume: true });
    expect(await sortedDocuments(second, "users")).toEqual(
      await sortedDocuments(reference, "users"),
    );
  });

  it("resumes upserts, and empties a time series it merged into before copying it again", async () => {
    const source = uniqueDb("src");
    const target = uniqueDb("dst");
    await seedUsers(source, DOCUMENTS);
    await client()
      .db(target)
      .collection<{ _id: Int32; email: string }>("users")
      .insertOne({ _id: new Int32(1), email: "stale" });
    const db = client().db(source);
    await db.createCollection("metrics", { timeseries: { timeField: "at", metaField: "host" } });
    await db.collection("metrics").insertMany(
      Array.from({ length: 3000 }, (_, index) => ({
        at: new Date(Date.UTC(2026, 0, 1) + index * 1000),
        host: "h",
      })),
    );
    // An existing, empty time series target: merged into in insert/upsert mode.
    await client()
      .db(target)
      .createCollection("metrics", { timeseries: { timeField: "at", metaField: "host" } });
    const checkpoint = join(workDir, `${target}.json`);
    const { mask, failAfter } = failingMask(source);
    let failMetrics = true;
    const options = {
      include: [`${source}.*`],
      rename: { [`${source}.*`]: `${target}.*` },
      mode: "upsert" as const,
      mask: {
        ...mask,
        rules: {
          ...mask.rules,
          [`${source}.metrics`]: {
            host: (value: unknown) => {
              if (failMetrics) throw new Error("interrupted on purpose");
              return value;
            },
          },
        },
      },
      checkpoint,
      parallelism: 2,
    };
    failAfter(12_000);
    await expect(copy(options)).rejects.toThrow(/interrupted on purpose/);
    failAfter(undefined);
    failMetrics = false;
    const plan = await planCopy(
      { source: client(), target: client(), logger: silentLogger },
      { ...options, resume: true },
    );
    const metrics = plan.entries.find((entry) => entry.from.endsWith(".metrics"));
    // Time series are only merged into empty targets, so it can be emptied again.
    expect(metrics).toMatchObject({ action: "insert", resume: "restart" });
    await copy({ ...options, resume: true });
    expect(await client().db(target).collection("users").countDocuments()).toBe(DOCUMENTS + 1);
    expect(await client().db(target).collection("metrics").countDocuments()).toBe(3000);
  });
});
