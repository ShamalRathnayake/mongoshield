// Integration tests for discoverNamespaces and orderForRestore against a real server.
// One database is filled with every kind of namespace and index MongoShield must
// capture, then discovery is checked spec by spec.

import { Binary, BSON, type CommandSucceededEvent, type Document, MongoClient } from "mongodb";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isMongoShieldError } from "../../src/errors.ts";
import type { Logger } from "../../src/logger.ts";
import { type CollectionSpec, discoverNamespaces, orderForRestore } from "../../src/mongo/index.ts";
import { mongoUri, uniqueDb, useMongoClient } from "../helpers/mongo.ts";

const client = useMongoClient();
const database = uniqueDb("disc");

/** Discovers only this file's database, so parallel test files never interfere. */
async function discoverOwn(): Promise<Map<string, CollectionSpec>> {
  const specs = await discoverNamespaces(client(), { include: [`${database}.*`] });
  return new Map(specs.map((spec) => [spec.name, spec]));
}

/** Looks up a spec by collection name, failing the test if it is missing. */
function specNamed(specs: Map<string, CollectionSpec>, name: string): CollectionSpec {
  const spec = specs.get(name);
  if (spec === undefined) throw new Error(`no spec for ${name}`);
  return spec;
}

function indexNamed(spec: CollectionSpec, name: string): Document | undefined {
  return spec.indexes.find((index) => index.name === name);
}

/** A logger that records warnings for assertions. */
function recordingLogger(): Logger & { warnings: { message: string; fields?: unknown }[] } {
  const warnings: { message: string; fields?: unknown }[] = [];
  const noop = (): void => {};
  return {
    warnings,
    debug: noop,
    info: noop,
    error: noop,
    warn: (message, fields) => warnings.push({ message, fields }),
  };
}

beforeAll(async () => {
  const db = client().db(database);
  await db.collection("plain").insertMany([{ a: 1 }, { a: 2 }, { a: 3 }]);
  await db.collection("events.2024").insertOne({ dotted: true });
  await db.createCollection("capped", { capped: true, size: 4096, max: 10 });
  await db.createCollection("clustered", {
    clusteredIndex: { key: { _id: 1 }, unique: true },
    expireAfterSeconds: 3600,
  });
  await db.createCollection("metrics", {
    timeseries: { timeField: "t", metaField: "sensor", granularity: "minutes" },
    expireAfterSeconds: 86_400,
  });
  await db.collection("metrics").insertMany([
    { t: new Date(), sensor: "a", value: 1 },
    { t: new Date(), sensor: "b", value: 2 },
  ]);
  await db.createCollection("validated", {
    validator: { $jsonSchema: { bsonType: "object", required: ["email"] } },
    validationLevel: "moderate",
    validationAction: "warn",
    collation: { locale: "fr", strength: 2 },
  });
  await db.createCollection("prepost", { changeStreamPreAndPostImages: { enabled: true } });
  // `z_base` sorts after `a_top`, so discovery order alone would create them backwards.
  await db.createCollection("z_base", {
    viewOn: "plain",
    pipeline: [{ $match: { a: { $gt: 1 } } }],
  });
  await db.createCollection("a_top", { viewOn: "z_base", pipeline: [{ $project: { a: 1 } }] });

  const indexed = db.collection("indexed");
  await indexed.insertOne({ email: "x@example.com" });
  await indexed.createIndex({ createdAt: 1 }, { name: "ttl", expireAfterSeconds: 60 });
  await indexed.createIndex(
    { status: 1 },
    { name: "partial", partialFilterExpression: { status: { $exists: true } } },
  );
  await indexed.createIndex({ email: 1 }, { name: "unique_email", unique: true });
  await indexed.createIndex(
    { title: "text", body: "text" },
    { name: "text", weights: { title: 10 }, default_language: "english" },
  );
  await indexed.createIndex({ location: "2dsphere" }, { name: "geo" });
  await indexed.createIndex({ "attrs.$**": 1 }, { name: "wildcard" });
  await indexed.createIndex({ a: 1, b: -1 }, { name: "compound" });

  // `system.js` is user data; `system.views` and `system.buckets.metrics` exist already.
  await db
    .collection<{ _id: string; value: string }>("system.js")
    .insertOne({ _id: "double", value: "function (x) { return 2 * x; }" });
});

afterAll(async () => {
  await client().db(database).dropDatabase();
});

describe("discoverNamespaces", () => {
  it("returns specs sorted by namespace", async () => {
    const specs = await discoverNamespaces(client(), { include: [`${database}.*`] });
    const namespaces = specs.map((spec) => spec.ns);
    expect(namespaces).toEqual([...namespaces].sort());
    expect(specs.every((spec) => spec.db === database)).toBe(true);
  });

  it("captures a plain collection with its uuid, _id index and document estimate", async () => {
    const plain = specNamed(await discoverOwn(), "plain");
    expect(plain).toMatchObject({ ns: `${database}.plain`, type: "collection", options: {} });
    expect(plain.uuid).toMatch(/^[0-9a-f]{32}$/);
    expect(plain.estimatedDocuments).toBe(3);
    expect(plain.indexes.map((index) => index.name)).toEqual(["_id_"]);
  });

  it("keeps dots in collection names", async () => {
    const dotted = specNamed(await discoverOwn(), "events.2024");
    expect(dotted.ns).toBe(`${database}.events.2024`);
    expect(dotted.estimatedDocuments).toBe(1);
  });

  it("captures capped collection options", async () => {
    const capped = specNamed(await discoverOwn(), "capped");
    expect(capped.options).toMatchObject({ capped: true, size: 4096, max: 10 });
  });

  it("captures clustered collections, whose clustered index also appears in listIndexes", async () => {
    const clustered = specNamed(await discoverOwn(), "clustered");
    expect(clustered.options).toMatchObject({
      clusteredIndex: { key: { _id: 1 }, unique: true },
      expireAfterSeconds: 3600,
    });
    // The restore engine must skip this index: it is created by the clusteredIndex option.
    expect(indexNamed(clustered, "_id_")).toMatchObject({ clustered: true });
  });

  it("captures time series through the user-facing namespace with the bucket uuid", async () => {
    const specs = await discoverOwn();
    const metrics = specNamed(specs, "metrics");
    expect(metrics.type).toBe("timeseries");
    expect(metrics.options).toMatchObject({
      timeseries: { timeField: "t", metaField: "sensor", granularity: "minutes" },
      expireAfterSeconds: 86_400,
    });
    expect(metrics.estimatedDocuments).toBe(2);

    const listed = await client()
      .db(database)
      .listCollections({ name: "system.buckets.metrics" }, { nameOnly: false })
      .toArray();
    const bucketUuid: unknown = listed[0]?.info?.uuid;
    expect(bucketUuid).toBeInstanceOf(Binary);
    expect(metrics.uuid).toBe((bucketUuid as Binary).toString("hex"));
  });

  it("captures validators, validation settings and collation", async () => {
    const validated = specNamed(await discoverOwn(), "validated");
    expect(validated.options).toMatchObject({
      validator: { $jsonSchema: { bsonType: "object", required: ["email"] } },
      validationLevel: "moderate",
      validationAction: "warn",
      collation: { locale: "fr", strength: 2 },
    });
  });

  it("captures changeStreamPreAndPostImages", async () => {
    const prepost = specNamed(await discoverOwn(), "prepost");
    expect(prepost.options).toMatchObject({ changeStreamPreAndPostImages: { enabled: true } });
  });

  it("captures views with their pipeline, no indexes, no uuid and no documents", async () => {
    const view = specNamed(await discoverOwn(), "z_base");
    expect(view.type).toBe("view");
    expect(view.options).toEqual({ viewOn: "plain", pipeline: [{ $match: { a: { $gt: 1 } } }] });
    expect(view.indexes).toEqual([]);
    expect(view.uuid).toBeUndefined();
    expect(view.estimatedDocuments).toBe(0);
  });

  it("captures every index kind with its options", async () => {
    const indexed = specNamed(await discoverOwn(), "indexed");
    expect(indexNamed(indexed, "ttl")).toMatchObject({
      key: { createdAt: 1 },
      expireAfterSeconds: 60,
    });
    expect(indexNamed(indexed, "partial")).toMatchObject({
      partialFilterExpression: { status: { $exists: true } },
    });
    expect(indexNamed(indexed, "unique_email")).toMatchObject({ key: { email: 1 }, unique: true });
    expect(indexNamed(indexed, "text")).toMatchObject({
      key: { _fts: "text", _ftsx: 1 },
      weights: { title: 10, body: 1 },
      default_language: "english",
    });
    expect(indexNamed(indexed, "geo")).toMatchObject({ key: { location: "2dsphere" } });
    expect(indexNamed(indexed, "wildcard")).toMatchObject({ key: { "attrs.$**": 1 } });
    expect(indexNamed(indexed, "compound")?.key).toEqual({ a: 1, b: -1 });
  });

  it("skips system collections except system.js", async () => {
    const names = [...(await discoverOwn()).keys()];
    expect(names).toContain("system.js");
    expect(names).not.toContain("system.views");
    expect(names).not.toContain("system.buckets.metrics");
    expect(names.some((name) => name.startsWith("system.") && name !== "system.js")).toBe(false);
  });

  it("applies include and exclude patterns", async () => {
    const specs = await discoverNamespaces(client(), {
      include: [`${database}.*`],
      exclude: [`${database}.*_*`, "*.capped", `${database}.events.*`],
    });
    const names = specs.map((spec) => spec.name);
    expect(names).toContain("plain");
    expect(names).toContain("metrics");
    expect(names).not.toContain("capped");
    expect(names).not.toContain("a_top");
    expect(names).not.toContain("events.2024");
    // `system.js` contains no `_`, so only the system rule and include decide it.
    expect(names).toContain("system.js");
  });

  it("selects single namespaces across databases with *.name", async () => {
    const specs = await discoverNamespaces(client(), { include: ["*.validated"] });
    expect(specs.map((spec) => spec.ns)).toContain(`${database}.validated`);
    expect(specs.every((spec) => spec.name === "validated")).toBe(true);
  });

  it("skips admin, config and local unless a pattern names them literally", async () => {
    const marker = `ms_${database}`;
    const admin = client().db("admin");
    await admin.collection(marker).insertOne({ marker: true });
    try {
      const everything = await discoverNamespaces(client());
      const internal = everything.filter((spec) => ["admin", "config", "local"].includes(spec.db));
      expect(internal).toEqual([]);
      expect(everything.some((spec) => spec.ns === `${database}.plain`)).toBe(true);

      const wildcardDb = await discoverNamespaces(client(), { include: [`*.${marker}`] });
      expect(wildcardDb).toEqual([]);

      // Other test files restore users and roles in parallel, which stages them in
      // temporary `admin` collections (restore-authz.ts, mongorestore), so `admin.*`
      // may list more than the marker: only the marker is this test's to expect.
      const named = await discoverNamespaces(client(), { include: ["admin.*"] });
      expect(named.map((spec) => spec.ns)).toContain(`admin.${marker}`);
      expect(named.every((spec) => spec.db === "admin")).toBe(true);
      const literal = await discoverNamespaces(client(), { include: [`admin.${marker}`] });
      expect(literal.map((spec) => spec.ns)).toEqual([`admin.${marker}`]);
    } finally {
      await admin.collection(marker).drop();
    }
  });

  it("rejects malformed patterns with MS_CONFIG_INVALID before touching the server", async () => {
    await expect(discoverNamespaces(client(), { include: ["no_dot"] })).rejects.toSatisfy((error) =>
      isMongoShieldError(error, "MS_CONFIG_INVALID"),
    );
  });

  it("stops with MS_ABORTED when the signal is aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      discoverNamespaces(client(), { include: [`${database}.*`], signal: controller.signal }),
    ).rejects.toSatisfy((error) => isMongoShieldError(error, "MS_ABORTED"));
  });

  it("skips a collection dropped between listing and reading, with a warning", async () => {
    // The test server has no fail points, so the race is staged with command monitoring:
    // as soon as listCollections replies, drop the LAST listed collection. Discovery
    // reaches it only after a few round trips for every collection before it, which is
    // nearly always later than the drop; on a server busy with the other test files the
    // drop can still lose, and then discovery rightly sees the collection. Such an
    // attempt staged nothing, so it is repeated with a fresh database.
    for (let attempt = 1; ; attempt++) {
      const outcome = await stageDropDuringDiscovery();
      if (outcome.dropLost && attempt < 5) continue;
      expect(outcome.dropLost).toBe(false);
      expect(outcome.specs).toHaveLength(29);
      expect(outcome.specs.some((spec) => spec.name === outcome.victim)).toBe(false);
      expect(outcome.warnings).toEqual([
        {
          message: expect.stringMatching(/dropped/),
          fields: { ns: `${outcome.database}.${outcome.victim}` },
        },
      ]);
      return;
    }
  });
});

/** One attempt of the race above: discovery of 30 collections while the last is dropped. */
async function stageDropDuringDiscovery(): Promise<{
  database: string;
  victim: string;
  specs: CollectionSpec[];
  warnings: { message: string; fields?: unknown }[];
  /** True when discovery read the victim before the drop took effect. */
  dropLost: boolean;
}> {
  const racyDb = uniqueDb("race");
  const setup = client().db(racyDb);
  for (let index = 0; index < 30; index++) await setup.collection(`c${index}`).insertOne({ index });

  const monitored = new MongoClient(mongoUri(), { monitorCommands: true });
  let victim: string | undefined;
  let dropped: Promise<unknown> = Promise.resolve();
  monitored.on("commandSucceeded", (event: CommandSucceededEvent) => {
    if (event.commandName !== "listCollections" || victim !== undefined) return;
    const reply: Document = event.reply ?? {};
    // Discovery lists collections with `raw: true` (to keep their stored field order),
    // and the event then carries the cursor as raw BSON.
    const cursor: unknown = reply.cursor;
    const parsed: Document | undefined =
      cursor instanceof Uint8Array ? BSON.deserialize(cursor) : (cursor as Document | undefined);
    const batch: unknown = parsed?.firstBatch;
    if (!Array.isArray(batch) || batch.length === 0) return;
    const last: unknown = batch[batch.length - 1]?.name;
    if (typeof last !== "string") return;
    victim = last;
    dropped = client().db(racyDb).collection(last).drop();
  });

  const logger = recordingLogger();
  try {
    const specs = await discoverNamespaces(monitored, { include: [`${racyDb}.*`], logger });
    await dropped;
    if (victim === undefined) throw new Error("listCollections was never seen");
    const name = victim;
    const dropLost = specs.some((spec) => spec.name === name) && logger.warnings.length === 0;
    return { database: racyDb, victim: name, specs, warnings: logger.warnings, dropLost };
  } finally {
    await monitored.close();
    await client().db(racyDb).dropDatabase();
  }
}

describe("orderForRestore with discovered specs", () => {
  it("creates collections first and the view-on-view after the view it reads", async () => {
    const specs = await discoverNamespaces(client(), { include: [`${database}.*`] });
    const ordered = orderForRestore(specs).map((spec) => spec.name);

    expect(ordered.slice(-2)).toEqual(["z_base", "a_top"]);
    const firstView = ordered.indexOf("z_base");
    expect(ordered.indexOf("plain")).toBeLessThan(firstView);
    expect(ordered.indexOf("metrics")).toBeLessThan(firstView);
    expect(ordered).toHaveLength(specs.length);
  });
});
