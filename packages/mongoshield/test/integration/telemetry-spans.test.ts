/**
 * Engine-internal spans (`mongoshield.backup.namespace`, `mongoshield.restore.namespace`,
 * `mongoshield.restore.replay`, `mongoshield.verify.namespace`) recorded by the fake
 * tracer from src/telemetry/test-fakes.ts, around real backups, restores and
 * verifications against the shared test replica set.
 */

import { SpanStatusCode } from "@opentelemetry/api";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { resolveBackupKey } from "../../src/format/layout.ts";
import { MongoShield } from "../../src/shield.ts";
import { memoryStorage } from "../../src/storage/memory.ts";
import { ATTRIBUTES, ENGINE_SPANS } from "../../src/telemetry/names.ts";
import {
  createFakeMetrics,
  createFakeTracing,
  type FakeTracing,
  type RecordedSpan,
  registerFakes,
  unregisterFakes,
} from "../../src/telemetry/test-fakes.ts";
import { mongoUri, uniqueDb, useMongoClient } from "../helpers/mongo.ts";

const client = useMongoClient();
const source = uniqueDb("otel_src");
const target = uniqueDb("otel_dst");

beforeAll(async () => {
  const db = client().db(source);
  await db.collection("users").insertMany(Array.from({ length: 30 }, (_, n) => ({ n })));
  await db.collection("orders").insertMany(Array.from({ length: 12 }, (_, n) => ({ n })));
});

afterEach(() => {
  unregisterFakes();
});

afterAll(async () => {
  await client().db(source).dropDatabase();
  await client().db(target).dropDatabase();
});

/** Registers a fresh fake tracer (and meter) like an application's SDK would. */
function tracing(): FakeTracing {
  const fake = createFakeTracing();
  registerFakes(fake, createFakeMetrics());
  return fake;
}

function named(spans: readonly RecordedSpan[], name: string): RecordedSpan[] {
  return spans.filter((span) => span.name === name);
}

function namespacesOf(spans: readonly RecordedSpan[]): unknown[] {
  return spans.map((span) => span.attributes[ATTRIBUTES.namespace]).sort();
}

describe("engine spans", () => {
  it("records one span per namespace for backup, verify and restore, with names when allowed", async () => {
    const fake = tracing();
    const storage = memoryStorage();
    const shield = new MongoShield({
      source: { uri: mongoUri() },
      storage,
      telemetry: { includeNamespaces: true },
    });
    const backup = await shield.backup({ include: [`${source}.*`], consistency: "converge" });

    const backups = named(fake.spans, ENGINE_SPANS.backupNamespace);
    expect(namespacesOf(backups)).toEqual([`${source}.orders`, `${source}.users`]);
    const users = backups.find(
      (span) => span.attributes[ATTRIBUTES.namespace] === `${source}.users`,
    );
    expect(users?.attributes).toMatchObject({ [ATTRIBUTES.documents]: 30 });
    expect(users?.ended).toBe(true);

    await shield.verify({ backup: backup.id, mode: "deep" });
    const verifies = named(fake.spans, ENGINE_SPANS.verifyNamespace);
    expect(namespacesOf(verifies)).toEqual([`${source}.orders`, `${source}.users`]);
    expect(verifies.every((span) => span.attributes[ATTRIBUTES.problems] === 0)).toBe(true);

    await shield.restore({ backup: backup.id, rename: { [`${source}.*`]: `${target}.*` } });
    const restores = named(fake.spans, ENGINE_SPANS.restoreNamespace);
    // A converge restore loads documents, replays the window, then builds indexes:
    // two spans per collection, named by the target namespace.
    expect(new Set(namespacesOf(restores))).toEqual(
      new Set([`${target}.orders`, `${target}.users`]),
    );
    expect(
      restores.some(
        (span) =>
          span.attributes[ATTRIBUTES.namespace] === `${target}.users` &&
          span.attributes[ATTRIBUTES.documents] === 30,
      ),
    ).toBe(true);
    expect(named(fake.spans, ENGINE_SPANS.restoreReplay)).toHaveLength(
      backup.manifest.changes === undefined ? 0 : 1,
    );
    expect(fake.spans.every((span) => span.ended)).toBe(true);
  });

  it("leaves namespace names out by default", async () => {
    const fake = tracing();
    const shield = new MongoShield({ source: { uri: mongoUri() }, storage: memoryStorage() });
    const backup = await shield.backup({ include: [`${source}.users`] });
    await shield.verify({ backup: backup.id });

    const spans = [
      ...named(fake.spans, ENGINE_SPANS.backupNamespace),
      ...named(fake.spans, ENGINE_SPANS.verifyNamespace),
    ];
    expect(spans).toHaveLength(2);
    expect(spans.every((span) => !(ATTRIBUTES.namespace in span.attributes))).toBe(true);
  });

  it("marks the verify span of a damaged namespace as failed", async () => {
    const fake = tracing();
    const storage = memoryStorage();
    const shield = new MongoShield({
      source: { uri: mongoUri() },
      storage,
      telemetry: { includeNamespaces: true },
    });
    const backup = await shield.backup({ include: [`${source}.*`], consistency: "none" });
    const users = backup.manifest.namespaces.find((entry) => entry.ns === `${source}.users`);
    const file = users?.files[0];
    if (file === undefined) throw new Error("the backup has no users data file");
    await storage.put(resolveBackupKey(backup.id, file.key), Buffer.from("damaged"));

    const report = await shield.verify({ backup: backup.id });
    expect(report.ok).toBe(false);
    const verifies = named(fake.spans, ENGINE_SPANS.verifyNamespace);
    const failed = verifies.filter((span) => span.status.code === SpanStatusCode.ERROR);
    expect(namespacesOf(failed)).toEqual([`${source}.users`]);
    expect(failed[0]?.attributes).toMatchObject({
      [ATTRIBUTES.errorType]: "MS_INTEGRITY_FAILED",
      [ATTRIBUTES.problems]: 1,
    });
  });

  it("records no engine spans when telemetry is disabled", async () => {
    const fake = tracing();
    const shield = new MongoShield({
      source: { uri: mongoUri() },
      storage: memoryStorage(),
      telemetry: { enabled: false },
    });
    const backup = await shield.backup({ include: [`${source}.users`] });
    await shield.verify({ backup: backup.id });
    expect(fake.spans).toEqual([]);
  });
});
