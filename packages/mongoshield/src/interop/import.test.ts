// importMongodump against real mongodump output (test/fixtures/mongodump), into
// memory storage: what the new backup contains, what is skipped, and that failed
// imports leave nothing behind.

import { createReadStream } from "node:fs";
import { cp, readFile, stat, truncate, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { BSON } from "mongodb";
import { describe, expect, it } from "vitest";
import { generateIdentity } from "../crypto/index.ts";
import { verifyBackup } from "../engine/verify.ts";
import { isMongoShieldError } from "../errors.ts";
import { silentLogger } from "../logger.ts";
import { memoryStorage } from "../storage/memory.ts";
import type { ProgressEvent } from "../types.ts";
import { collectionFileStem } from "./dump-names.ts";
import { importMongodump } from "./import.ts";
import {
  fixturePath,
  rejection,
  splitBson,
  storedDocuments,
  useTempDirectories,
} from "./test-fixtures.ts";

const tempDirectory = useTempDirectories();

/** Namespaces of the fixture database (all of them: time series are unpacked). */
const IMPORTABLE = [
  "app.capped",
  "app.empty",
  "app.ts",
  "app.users",
  "app.v1",
  "app.we/ird name+x~é",
];

async function fixtureDocuments(file: string): Promise<Buffer[]> {
  return splitBson(await readFile(fixturePath(`dump/app/${file}`)));
}

describe("importMongodump from a dump directory", () => {
  it("creates a complete, verifiable backup with every collection and view", async () => {
    const storage = memoryStorage();
    const result = await importMongodump({ directory: fixturePath("dump") }, storage);

    expect(result.manifest.namespaces.map((entry) => entry.ns)).toEqual(IMPORTABLE);
    expect(result.manifest.source).toEqual({ topology: "unknown", serverVersion: "7.0.32" });
    expect(result.manifest.consistency).toEqual({ mode: "none" });
    expect(result.manifest.labels).toEqual({ "imported-from": "mongodump@100.16.0" });
    expect(result.manifest.namespaces.find((entry) => entry.ns === "app.v1")?.files).toEqual([]);

    const report = await verifyBackup(
      { storage, logger: silentLogger },
      { backup: result.id, mode: "deep" },
    );
    expect(report.problems).toEqual([]);
  });

  it("copies documents byte for byte", async () => {
    const storage = memoryStorage();
    const { manifest } = await importMongodump({ directory: fixturePath("dump") }, storage);
    expect(await storedDocuments(storage, manifest, "app.users")).toEqual(
      await fixtureDocuments("users.bson"),
    );
    expect(await storedDocuments(storage, manifest, "app.we/ird name+x~é")).toEqual(
      await fixtureDocuments("we%2Fird+name%2Bx~%C3%A9.bson"),
    );
    expect(manifest.namespaces.find((entry) => entry.ns === "app.users")?.documents).toBe(2);
  });

  it("unpacks a time-series collection's buckets into the measurements find returns", async () => {
    const storage = memoryStorage();
    const result = await importMongodump({ directory: fixturePath("dump") }, storage);
    expect(result.skipped).toEqual([]);
    const entry = result.manifest.namespaces.find((candidate) => candidate.ns === "app.ts");
    expect(entry?.type).toBe("timeseries");
    const measurements = await storedDocuments(storage, result.manifest, "app.ts");
    // Two version 1 buckets of one measurement each: time first, then meta, then the rest.
    expect(measurements.map((measurement) => Object.keys(BSON.deserialize(measurement)))).toEqual([
      ["t", "m", "v", "_id"],
      ["t", "m", "v", "_id"],
    ]);
    expect(measurements.map((measurement) => BSON.deserialize(measurement).v)).toEqual([2, 3]);
  });

  it("reads gzipped dumps (mongodump --gzip) the same way", async () => {
    const plain = memoryStorage();
    const gzip = memoryStorage();
    const fromPlain = await importMongodump({ directory: fixturePath("dump") }, plain);
    const fromGzip = await importMongodump({ directory: fixturePath("dump-gzip") }, gzip);
    expect(fromGzip.manifest.namespaces.map((entry) => entry.ns)).toEqual(IMPORTABLE);
    expect(await storedDocuments(gzip, fromGzip.manifest, "app.users")).toEqual(
      await storedDocuments(plain, fromPlain.manifest, "app.users"),
    );
  });

  it("accepts a single database's directory, named after the directory or the database option", async () => {
    const named = await importMongodump({ directory: fixturePath("dump/app") }, memoryStorage());
    expect(named.manifest.namespaces[0]?.db).toBe("app");
    const renamed = await importMongodump(
      { directory: fixturePath("dump/app"), database: "shop" },
      memoryStorage(),
    );
    expect(renamed.manifest.namespaces.map((entry) => entry.db)).toContain("shop");
  });

  it("dates the backup by the dump's newest file, unless dumpedAt is given", async () => {
    const usersFile = await stat(fixturePath("dump/app/users.bson"));
    const result = await importMongodump({ directory: fixturePath("dump") }, memoryStorage());
    expect(Date.parse(result.manifest.completedAt)).toBeGreaterThanOrEqual(
      Math.floor(usersFile.mtimeMs / 1000) * 1000,
    );

    const dumpedAt = new Date("2025-01-02T03:04:05Z");
    const dated = await importMongodump({ directory: fixturePath("dump") }, memoryStorage(), {
      dumpedAt,
    });
    expect(dated.id.startsWith("2025-01-02T03-04-05Z_")).toBe(true);
    expect(dated.manifest.completedAt).toBe(dumpedAt.toISOString());
  });

  it("imports only the namespaces selected by include/exclude, and adds the user's labels", async () => {
    const result = await importMongodump({ directory: fixturePath("dump") }, memoryStorage(), {
      include: ["app.*"],
      exclude: ["app.v1", "app.capped"],
      labels: { env: "prod" },
    });
    expect(result.manifest.namespaces.map((entry) => entry.ns)).toEqual([
      "app.empty",
      "app.ts",
      "app.users",
      "app.we/ird name+x~é",
    ]);
    expect(result.manifest.labels.env).toBe("prod");
  });

  it("reports progress per namespace and honours parallelism", async () => {
    const events: ProgressEvent[] = [];
    const result = await importMongodump({ directory: fixturePath("dump") }, memoryStorage(), {
      parallelism: 1,
      onProgress: (event) => events.push(event),
    });
    const done = events.filter((event) => event.type === "namespace:done").map((event) => event.ns);
    expect(done.sort()).toEqual(result.manifest.namespaces.map((entry) => entry.ns).sort());
    const error = await rejection(
      importMongodump({ directory: fixturePath("dump") }, memoryStorage(), { parallelism: 0 }),
    );
    expect(isMongoShieldError(error, "MS_CONFIG_INVALID")).toBe(true);
  });

  it("refuses an import that selects nothing, without writing anything", async () => {
    const storage = memoryStorage();
    const error = await rejection(
      importMongodump({ directory: fixturePath("dump") }, storage, { include: ["other.*"] }),
    );
    expect(isMongoShieldError(error, "MS_CONFIG_INVALID")).toBe(true);
    expect(storage.keys()).toEqual([]);
  });

  it("refuses a directory that holds no dump", async () => {
    const empty = await tempDirectory();
    const error = await rejection(importMongodump({ directory: empty }, memoryStorage()));
    expect(isMongoShieldError(error, "MS_CONFIG_INVALID")).toBe(true);
  });

  it("encrypts the backup when asked, like a native backup", async () => {
    const storage = memoryStorage();
    const key = generateIdentity();
    const result = await importMongodump({ directory: fixturePath("dump") }, storage, {
      encryption: { recipients: [key.recipient] },
      compression: "gzip",
    });
    expect(result.manifest.encryption?.recipients).toEqual([key.recipient]);
    expect(result.manifest.compression).toBe("gzip");
    expect(
      storage.keys().every((name) => name.endsWith(".age") || name.endsWith("manifest.json")),
    ).toBe(true);
    expect(
      await storedDocuments(storage, result.manifest, "app.users", { identities: [key.identity] }),
    ).toEqual(await fixtureDocuments("users.bson"));
  });

  it("fails on a truncated .bson file and removes everything it wrote", async () => {
    const copy = await tempDirectory();
    await cp(fixturePath("dump"), copy, { recursive: true });
    await truncate(join(copy, "app", "users.bson"), 60);
    const storage = memoryStorage();
    const error = await rejection(importMongodump({ directory: copy }, storage));
    expect(isMongoShieldError(error, "MS_INTEGRITY_FAILED")).toBe(true);
    expect(storage.keys()).toEqual([]);
  });

  it("recovers the names of collections whose file names mongodump shortened", async () => {
    const directory = await tempDirectory();
    const longName = "é".repeat(100);
    const stem = collectionFileStem(longName);
    await cp(fixturePath("dump/app/users.bson"), join(directory, `${stem}.bson`));
    await writeFile(
      join(directory, `${stem}.metadata.json`),
      JSON.stringify({ indexes: [], collectionName: longName, type: "collection" }),
    );
    const result = await importMongodump({ directory, database: "app" }, memoryStorage());
    expect(result.manifest.namespaces.map((entry) => entry.collection)).toEqual([longName]);

    await writeFile(join(directory, `${stem}.metadata.json`), "{}");
    const error = await rejection(importMongodump({ directory, database: "app" }, memoryStorage()));
    expect(isMongoShieldError(error, "MS_INTEGRITY_FAILED")).toBe(true);
  });

  it("imports .bson files without metadata as plain collections", async () => {
    const directory = await tempDirectory();
    await cp(fixturePath("dump/app/users.bson"), join(directory, "people.bson"));
    const result = await importMongodump({ directory, database: "crm" }, memoryStorage());
    expect(
      result.manifest.namespaces.map((entry) => [entry.ns, entry.type, entry.documents]),
    ).toEqual([["crm.people", "collection", 2]]);
  });
});

describe("importMongodump from an archive", () => {
  const ARCHIVE_NAMESPACES = [...IMPORTABLE, `app.${"é".repeat(100)}`].sort();

  it("imports every namespace of a plain archive, byte for byte", async () => {
    const storage = memoryStorage();
    const result = await importMongodump({ archive: fixturePath("app.archive") }, storage);
    expect(result.manifest.namespaces.map((entry) => entry.ns)).toEqual(ARCHIVE_NAMESPACES);
    expect(result.manifest.labels["imported-from"]).toBe("mongodump@100.16.0");
    const users = await storedDocuments(storage, result.manifest, "app.users");
    expect(users.map((document) => BSON.deserialize(document).name)).toEqual(["a", "b"]);
    const report = await verifyBackup(
      { storage, logger: silentLogger },
      { backup: result.id, mode: "deep" },
    );
    expect(report.ok).toBe(true);
  });

  it("detects gzip by itself, and also takes a stream such as stdin", async () => {
    const fromFile = await importMongodump(
      { archive: fixturePath("app.archive.gz") },
      memoryStorage(),
    );
    expect(fromFile.manifest.namespaces.map((entry) => entry.ns)).toEqual(ARCHIVE_NAMESPACES);
    const fromStream = await importMongodump(
      { archive: createReadStream(fixturePath("app.archive.gz")), gzip: true },
      memoryStorage(),
    );
    expect(fromStream.manifest.totals.documents).toBe(fromFile.manifest.totals.documents);
  });

  it("stores the same documents as an import of the equivalent directory", async () => {
    const archiveStorage = memoryStorage();
    const directoryStorage = memoryStorage();
    const fromArchive = await importMongodump(
      { archive: fixturePath("app.archive") },
      archiveStorage,
    );
    const fromDirectory = await importMongodump(
      { directory: fixturePath("dump") },
      directoryStorage,
    );
    for (const ns of IMPORTABLE) {
      const archiveDocuments = await storedDocuments(archiveStorage, fromArchive.manifest, ns);
      const directoryDocuments = await storedDocuments(
        directoryStorage,
        fromDirectory.manifest,
        ns,
      );
      expect(archiveDocuments.length, ns).toBe(directoryDocuments.length);
    }
  });

  it("fails on a damaged archive and removes everything it wrote", async () => {
    const copy = join(await tempDirectory(), "damaged.archive");
    const bytes = await readFile(fixturePath("app.archive"));
    await writeFile(copy, bytes.subarray(0, bytes.length - 100));
    const storage = memoryStorage();
    const error = await rejection(importMongodump({ archive: copy }, storage));
    expect(isMongoShieldError(error, "MS_INTEGRITY_FAILED")).toBe(true);
    expect(storage.keys()).toEqual([]);
  });

  it("stops when aborted and removes everything it wrote", async () => {
    const storage = memoryStorage();
    const controller = new AbortController();
    controller.abort();
    const error = await rejection(
      importMongodump({ archive: fixturePath("app.archive") }, storage, {
        signal: controller.signal,
      }),
    );
    expect(isMongoShieldError(error, "MS_ABORTED")).toBe(true);
    expect(storage.keys()).toEqual([]);
  });

  it("explains a missing archive file", async () => {
    const error = await rejection(
      importMongodump({ archive: "/no/such/file.archive" }, memoryStorage()),
    );
    expect(isMongoShieldError(error, "MS_CONFIG_INVALID")).toBe(true);
  });
});
