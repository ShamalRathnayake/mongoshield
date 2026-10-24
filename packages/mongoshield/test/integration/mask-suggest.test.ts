// suggestMasks against the shared test replica set: what is found in seeded
// collections, how sampling is bounded, what is skipped, coverage by a mask config,
// read-only behaviour, cancellation, and how sampling failures are reported.

import { type Document, type MongoClient, MongoServerError, ObjectId } from "mongodb";
import { beforeAll, describe, expect, it } from "vitest";
import { isMongoShieldError } from "../../src/errors.ts";
import { suggestMasks } from "../../src/mask/suggest/index.ts";
import { uniqueDb, useMongoClient } from "../helpers/mongo.ts";

const client = useMongoClient();

/** The seeded database (one per file: the tests only read it). */
const database = uniqueDb("pii");

const USER_COUNT = 300;

beforeAll(async () => {
  const db = client().db(database);
  await db.collection("users").insertMany(
    Array.from({ length: USER_COUNT }, (_unused, index) => ({
      _id: new ObjectId(),
      email: `user${index}@corp.example`,
      firstName: ["Ada", "Grace", "Linus", "Mei", "Tariq"][index % 5],
      phone: `+1 415 555 ${String(1000 + index)}`,
      address: { street: `${index + 1} Market Street`, zip: `9410${index % 10}` },
      status: ["active", "pending"][index % 2],
      visits: index * 7,
    })),
  );
  await db.collection("orders").insertMany(
    Array.from({ length: 50 }, (_unused, index) => ({
      sku: `SKU-${index}`,
      total: index * 3.5,
      shipping: { ip: `10.1.0.${index}` },
    })),
  );
  await db.createCollection("empty");
  await db.createCollection("active_users", {
    viewOn: "users",
    pipeline: [{ $match: { status: "active" } }],
  });
});

describe("suggestMasks", () => {
  it("finds personal data per collection and suggests rules in the mask file format", async () => {
    const report = await suggestMasks(client(), { include: [`${database}.*`] });
    const users = report.collections.find((collection) => collection.ns === `${database}.users`);
    expect(users?.documents).toBe(USER_COUNT);
    expect(users?.suggestions.map((suggestion) => [suggestion.path, suggestion.kind])).toEqual(
      expect.arrayContaining([
        ["email", "email"],
        ["firstName", "person-name"],
        ["phone", "phone"],
        ["address.street", "address"],
        ["address.zip", "postal-code"],
      ]),
    );
    expect(
      users?.suggestions.some((suggestion) =>
        ["status", "visits", "_id"].includes(suggestion.path),
      ),
    ).toBe(false);
    expect(report.rules[`${database}.users`]).toMatchObject({
      email: { fake: "email" },
      firstName: { fake: "name" },
      phone: { fake: "phone" },
      "address.street": { fake: "address" },
      "address.zip": "redact",
    });
    expect(report.rules[`${database}.orders`]).toEqual({ "shipping.ip": { fake: "ip" } });
    expect(report.skipped).toEqual([
      { ns: `${database}.active_users`, reason: "view" },
      { ns: `${database}.empty`, reason: "empty" },
    ]);
    expect(report).toMatchObject({ sampleSize: 1000, minConfidence: 0.5 });
  });

  it("samples at most sampleSize documents per collection", async () => {
    const report = await suggestMasks(client(), {
      include: [`${database}.users`],
      sampleSize: 40,
      readPreference: "primary",
    });
    expect(report.collections[0]?.documents).toBe(40);
    expect(report.collections[0]?.suggestions[0]?.sampled).toBeLessThanOrEqual(40);
  });

  it("marks fields the current mask already covers or keeps", async () => {
    const report = await suggestMasks(client(), {
      include: [`${database}.users`],
      mask: {
        rules: { "*.*": { email: { fake: "email" } }, [`${database}.users`]: { phone: "keep" } },
      },
    });
    const statuses = Object.fromEntries(
      (report.collections[0]?.suggestions ?? []).map((suggestion) => [
        suggestion.path,
        suggestion.status,
      ]),
    );
    expect(statuses).toMatchObject({ email: "covered", phone: "kept", firstName: "new" });
    expect(report.rules[`${database}.users`]).not.toHaveProperty("email");
    expect(report.rules[`${database}.users`]).not.toHaveProperty("phone");
  });

  it("reads only: no collection or document is added, changed or removed", async () => {
    const db = client().db(database);
    const before = await snapshotOf(db.databaseName);
    await suggestMasks(client(), { include: [`${database}.*`], sampleSize: 25 });
    expect(await snapshotOf(db.databaseName)).toEqual(before);
  });

  it("reports progress per sampled collection", async () => {
    const seen: string[] = [];
    await suggestMasks(client(), {
      include: [`${database}.*`],
      onCollection: (ns, index, total) => seen.push(`${ns} ${index + 1}/${total}`),
    });
    expect(seen).toEqual([
      `${database}.empty 2/4`,
      `${database}.orders 3/4`,
      `${database}.users 4/4`,
    ]);
  });

  it("stops when cancelled", async () => {
    const controller = new AbortController();
    const run = suggestMasks(client(), {
      include: [`${database}.users`],
      signal: controller.signal,
      onCollection: () => controller.abort(),
    });
    await expect(run).rejects.toSatisfy((error) => isMongoShieldError(error, "MS_ABORTED"));
  });

  it("rejects invalid options and masks before reading anything", async () => {
    for (const options of [
      { sampleSize: 0 },
      { sampleSize: 10_001 },
      { sampleSize: 1.5 },
      { minConfidence: 2 },
      { minConfidence: Number.NaN },
    ]) {
      await expect(suggestMasks(client(), options)).rejects.toSatisfy((error) =>
        isMongoShieldError(error, "MS_CONFIG_INVALID"),
      );
    }
    await expect(
      suggestMasks(client(), { mask: { rules: { "app.users": { email: "scramble" as never } } } }),
    ).rejects.toThrow(/unknown operation/);
  });

  it("says when the patterns match nothing", async () => {
    await expect(suggestMasks(client(), { include: [`${uniqueDb("none")}.*`] })).rejects.toThrow(
      "No namespace matches the include/exclude patterns.",
    );
  });

  it.each([
    [13, "MS_PERMISSION_DENIED", /refused/],
    [50, "MS_TIMEOUT", /took longer than allowed/],
    [11_600, "MS_CONNECTION_FAILED", /failed/],
  ] as const)(
    "reports a sampling failure with server code %i as %s",
    async (code, expected, message) => {
      const failing = failingSamples(
        client(),
        new MongoServerError({ message: "injected", code, errmsg: "injected" }),
      );
      const run = suggestMasks(failing, { include: [`${database}.users`] });
      await expect(run).rejects.toSatisfy((error) => isMongoShieldError(error, expected));
      await expect(suggestMasks(failing, { include: [`${database}.users`] })).rejects.toThrow(
        message,
      );
    },
  );

  it("reports a non-Error failure too", async () => {
    const failing = failingSamples(client(), "a string thrown by a driver plugin");
    await expect(suggestMasks(failing, { include: [`${database}.users`] })).rejects.toThrow(
      /a string thrown by a driver plugin/,
    );
  });
});

/** Every collection's name and documents, to prove nothing changed. */
async function snapshotOf(name: string): Promise<Record<string, Document[]>> {
  const db = client().db(name);
  const collections = await db.listCollections({}, { nameOnly: true }).toArray();
  const snapshot: Record<string, Document[]> = {};
  for (const { name: collection } of collections.sort((left, right) =>
    left.name.localeCompare(right.name),
  )) {
    snapshot[collection] = await db
      .collection(collection)
      .find({}, { sort: { _id: 1 } })
      .toArray();
  }
  return snapshot;
}

/**
 * The client, with every `$sample` aggregation failing with `error` while it is being
 * read; discovery and everything else reach the real server. (A server fail point
 * would also hit discovery's own `$listSearchIndexes` aggregations.)
 */
function failingSamples(real: MongoClient, error: unknown): MongoClient {
  const failingCursor = {
    async *[Symbol.asyncIterator]() {
      yield* [];
      throw error;
    },
    close: async () => undefined,
  };
  return new Proxy(real, {
    get(target, property) {
      if (property !== "db") return bound(target, property);
      return (name: string) =>
        new Proxy(target.db(name), {
          get(db, dbProperty) {
            if (dbProperty !== "collection") return bound(db, dbProperty);
            return (collectionName: string) =>
              new Proxy(db.collection(collectionName), {
                get(collection, collectionProperty) {
                  if (collectionProperty !== "aggregate")
                    return bound(collection, collectionProperty);
                  return (pipeline: Document[], options: Document) =>
                    pipeline[0]?.$sample === undefined
                      ? collection.aggregate(pipeline, options)
                      : failingCursor;
                },
              });
          },
        });
    },
  });
}

/** A property of `target`, with functions bound to it (driver objects keep private state). */
function bound(target: object, property: string | symbol): unknown {
  const value: unknown = Reflect.get(target, property, target);
  return typeof value === "function" ? value.bind(target) : value;
}
