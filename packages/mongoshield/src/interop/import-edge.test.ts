// importMongodump on dumps that real-tool tests rarely produce: users and roles files,
// orphaned or long-named time-series buckets, oplogs (empty, gzipped, unreplayable),
// archives with unusual prelude entries, and options that must be refused.

import { cp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { gzipSync } from "node:zlib";
import { BSON, Code, Int32, Long, ObjectId, Timestamp } from "mongodb";
import { describe, expect, it } from "vitest";
import { isMongoShieldError } from "../errors.ts";
import { memoryStorage } from "../storage/memory.ts";
import type { StorageAdapter } from "../storage/types.ts";
import type { ArchiveWriterInput } from "./archive-format.ts";
import { createArchiveWriter } from "./archive-writer.ts";
import { collectionFileStem } from "./dump-names.ts";
import { importMongodump } from "./import.ts";
import { fixturePath, rejection, storedDocuments, useTempDirectories } from "./test-fixtures.ts";

const tempDirectory = useTempDirectories();

function bson(...documents: Record<string, unknown>[]): Buffer {
  return Buffer.concat(documents.map((document) => Buffer.from(BSON.serialize(document))));
}

/** A single-database dump directory `app` with the given files. */
async function dumpDirectory(
  files: Record<string, Buffer | string>,
  top: Record<string, Buffer> = {},
): Promise<string> {
  const root = await tempDirectory();
  await mkdir(join(root, "app"));
  for (const [name, contents] of Object.entries(files))
    await writeFile(join(root, "app", name), contents);
  for (const [name, contents] of Object.entries(top)) await writeFile(join(root, name), contents);
  return root;
}

/** Archive bytes from writer events (the writer is checked against mongodump in archive.test.ts). */
async function archiveBytes(events: readonly ArchiveWriterInput[]): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of Readable.from(events, { objectMode: true }).pipe(
    createArchiveWriter(),
  )) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

const HEADER = {
  concurrentCollections: 1,
  formatVersion: "0.1",
  serverVersion: "8.0.13",
  toolVersion: "100.16.0",
};

const user = (db: string, name: string) => ({
  _id: `${db}.${name}`,
  userId: new ObjectId(),
  user: name,
  db,
  credentials: {},
  roles: [],
});
const role = (db: string, name: string) => ({
  _id: `${db}.${name}`,
  role: name,
  db,
  privileges: [],
  roles: [],
});

const USERS_METADATA = JSON.stringify({ indexes: [], collectionName: "users", type: "collection" });

describe("users and roles", () => {
  it("collects users and roles from both mongodump forms, filtered by database, de-duplicated and sorted", async () => {
    const root = await tempDirectory();
    await cp(fixturePath("dump"), root, { recursive: true });
    await mkdir(join(root, "admin"));
    await writeFile(
      join(root, "admin", "system.users.bson"),
      bson(user("app", "zed"), user("other", "x"), user("app", "amy")),
    );
    await writeFile(join(root, "admin", "system.roles.bson"), bson(role("app", "r")));
    await writeFile(
      join(root, "admin", "system.version.bson"),
      bson({ _id: "authSchema", currentVersion: 5 }),
    );
    await writeFile(
      join(root, "app", "$admin.system.users.bson"),
      bson(user("app", "amy"), user("app", "bob")),
    );
    const storage = memoryStorage();
    const result = await importMongodump({ directory: root }, storage, { include: ["app.*"] });

    const names = (documents: Buffer[]) =>
      documents.map((document) => BSON.deserialize(document)._id);
    expect(names(await storedDocuments(storage, result.manifest, "admin.system.users"))).toEqual([
      "app.amy",
      "app.bob",
      "app.zed",
    ]);
    expect(names(await storedDocuments(storage, result.manifest, "admin.system.roles"))).toEqual([
      "app.r",
    ]);
    // Users and roles come after the collections, roles first.
    expect(result.manifest.namespaces.slice(-2).map((entry) => entry.type)).toEqual([
      "roles",
      "users",
    ]);
    // The auth schema version is not selected by app.*, so it is not even reported.
    expect(result.skipped).toEqual([]);
  });

  it("refuses a users file whose documents are not users", async () => {
    const root = await dumpDirectory({
      "users.bson": bson({ a: 1 }),
      "$admin.system.users.bson": bson({ _id: 5 }),
    });
    const storage = memoryStorage();
    expect(
      isMongoShieldError(
        await rejection(importMongodump({ directory: root }, storage)),
        "MS_INTEGRITY_FAILED",
      ),
    ).toBe(true);
    expect(storage.keys()).toEqual([]);
  });

  it("imports a dump that holds only users", async () => {
    const root = await dumpDirectory({ "$admin.system.roles.bson": bson(role("app", "r")) });
    const result = await importMongodump({ directory: root }, memoryStorage());
    expect(result.manifest.namespaces.map((entry) => entry.ns)).toEqual(["admin.system.roles"]);
  });
});

describe("time-series buckets", () => {
  it("reports bucket data whose collection metadata is missing", async () => {
    const root = await dumpDirectory({
      "users.bson": bson({ a: 1 }),
      "system.buckets.metrics.bson": bson({ _id: 1 }),
    });
    const result = await importMongodump({ directory: root }, memoryStorage());
    expect(result.skipped).toEqual([
      {
        ns: "app.system.buckets.metrics",
        reason: expect.stringContaining("without its collection's metadata"),
      },
    ]);
    // Leaving the collection out with a pattern leaves its buckets out silently.
    const excluded = await importMongodump({ directory: root }, memoryStorage(), {
      exclude: ["app.metrics"],
    });
    expect(excluded.skipped).toEqual([]);
  });

  it("pairs a long-named collection with its shortened bucket file", async () => {
    const name = "m".repeat(240);
    const time = new Date(Date.UTC(2026, 0, 1));
    const bucket = {
      _id: new ObjectId(),
      control: { version: 1, min: { t: time }, max: { t: time } },
      data: { t: { "0": time }, v: { "0": 1 } },
    };
    const metadata = JSON.stringify({
      options: { timeseries: { timeField: "t" } },
      indexes: [],
      collectionName: name,
      type: "timeseries",
    });
    const root = await dumpDirectory({
      [`${collectionFileStem(name)}.metadata.json`]: metadata,
      [`${collectionFileStem(`system.buckets.${name}`)}.bson`]: bson(bucket),
    });
    const storage = memoryStorage();
    const result = await importMongodump({ directory: root }, storage);
    expect(
      result.manifest.namespaces.map((entry) => [entry.collection, entry.type, entry.documents]),
    ).toEqual([[name, "timeseries", 1]]);
    expect(
      Object.keys(
        BSON.deserialize(
          (await storedDocuments(storage, result.manifest, `app.${name}`))[0] ?? Buffer.alloc(0),
        ),
      ),
    ).toEqual(["t", "v"]);
  });

  it("imports a time-series collection without a bucket file as empty", async () => {
    const metadata = JSON.stringify({
      options: { timeseries: { timeField: "t" } },
      indexes: [],
      type: "timeseries",
    });
    const result = await importMongodump(
      { directory: await dumpDirectory({ "metrics.metadata.json": metadata }) },
      memoryStorage(),
    );
    expect(
      result.manifest.namespaces.map((entry) => [entry.ns, entry.type, entry.documents]),
    ).toEqual([["app.metrics", "timeseries", 0]]);
  });
});

describe("the oplog of mongodump --oplog", () => {
  const ts = (i: number) => new Timestamp({ t: 1_792_521_200, i });
  const insert = { ts: ts(2), op: "i", ns: "app.users", o: { _id: "late", name: "c" } };

  async function dumpWithOplog(oplog: Buffer, name = "oplog.bson"): Promise<string> {
    const root = await tempDirectory();
    await cp(fixturePath("dump"), root, { recursive: true });
    await writeFile(join(root, name), oplog);
    return root;
  }

  it("becomes the changes of a converge backup, plain or gzipped", async () => {
    for (const [name, bytes] of [
      ["oplog.bson", bson({ ts: ts(1), op: "n", ns: "", o: {} }, insert)],
      ["oplog.bson.gz", gzipSync(bson({ ts: ts(1), op: "n", ns: "", o: {} }, insert))],
    ] as const) {
      const result = await importMongodump(
        { directory: await dumpWithOplog(bytes, name) },
        memoryStorage(),
      );
      expect(result.manifest.consistency).toEqual({
        mode: "converge",
        from: { t: ts(1).t, i: 1 },
        to: { t: ts(2).t, i: 2 },
      });
      expect(result.manifest.changes?.events).toBe(1);
      expect(result.manifest.changes?.key).toMatch(/^_changes\/window\.bson/);
    }
  });

  it("leaves no changes file for an empty oplog", async () => {
    const storage = memoryStorage();
    const result = await importMongodump(
      { directory: await dumpWithOplog(Buffer.alloc(0)) },
      storage,
    );
    expect(result.manifest.consistency.mode).toBe("none");
    expect(storage.keys().some((key) => key.includes("_changes"))).toBe(false);
  });

  it("fails on an oplog that cannot be replayed and removes everything it wrote", async () => {
    const rename = {
      ts: ts(3),
      op: "c",
      ns: "app.$cmd",
      o: { renameCollection: "app.a", to: "app.b" },
    };
    const storage = memoryStorage();
    const error = await rejection(
      importMongodump({ directory: await dumpWithOplog(bson(insert, rename)) }, storage),
    );
    expect(isMongoShieldError(error, "MS_FORMAT_UNSUPPORTED")).toBe(true);
    expect(storage.keys()).toEqual([]);
    const ignored = await importMongodump(
      { directory: await dumpWithOplog(bson(insert, rename)) },
      storage,
      { ignoreOplog: true },
    );
    expect(ignored.manifest.consistency.mode).toBe("none");
  });
});

describe("archives with unusual contents", () => {
  const document = (fields: Record<string, unknown>) => Buffer.from(BSON.serialize(fields));
  const time = new Date(Date.UTC(2026, 0, 1));

  async function importEvents(
    events: readonly ArchiveWriterInput[],
    options = {},
    storage: StorageAdapter = memoryStorage(),
  ) {
    return importMongodump(
      { archive: Readable.from([await archiveBytes(events)]) },
      storage,
      options,
    );
  }

  it("imports users, system.js, time series and an oplog, and skips what it does not import", async () => {
    const bucket = {
      _id: new ObjectId(),
      control: { version: 1, min: { t: time }, max: { t: time } },
      meta: 1,
      data: { t: { "0": time } },
    };
    const tsMetadata = JSON.stringify({
      options: { timeseries: { timeField: "t", metaField: "m" } },
      indexes: [],
      type: "timeseries",
    });
    const events: ArchiveWriterInput[] = [
      {
        kind: "prelude",
        header: HEADER,
        collections: [
          { db: "app", collection: "$admin.system.users", metadata: "", size: 0, type: "" },
          { db: "app", collection: "system.js", metadata: "", size: 0, type: "" },
          { db: "app", collection: "system.profile", metadata: "", size: 0, type: "" },
          { db: "app", collection: "system.buckets.lost", metadata: "", size: 0, type: "" },
          { db: "app", collection: "readonly", metadata: "", size: 0, type: "view" },
          { db: "app", collection: "metrics", metadata: tsMetadata, size: 0, type: "timeseries" },
          { db: "", collection: "oplog", metadata: "", size: 0, type: "" },
        ],
      },
      {
        kind: "document",
        db: "app",
        collection: "$admin.system.users",
        document: document(user("app", "amy")),
      },
      { kind: "namespaceEnd", db: "app", collection: "$admin.system.users" },
      {
        kind: "document",
        db: "app",
        collection: "system.js",
        document: document({ _id: "add", value: new Code("1") }),
      },
      { kind: "namespaceEnd", db: "app", collection: "system.js" },
      { kind: "namespaceEnd", db: "app", collection: "system.profile" },
      { kind: "namespaceEnd", db: "app", collection: "system.buckets.lost" },
      { kind: "namespaceEnd", db: "app", collection: "readonly" },
      {
        kind: "document",
        db: "app",
        collection: "system.buckets.metrics",
        document: document(bucket),
      },
      { kind: "namespaceEnd", db: "app", collection: "system.buckets.metrics" },
      {
        kind: "document",
        db: "",
        collection: "oplog",
        document: document({
          ts: new Timestamp({ t: 5, i: 1 }),
          op: "i",
          ns: "app.system.js",
          o: { _id: "x" },
        }),
      },
      { kind: "namespaceEnd", db: "", collection: "oplog" },
    ];
    const storage = memoryStorage();
    const result = await importEvents(events, {}, storage);
    expect(
      result.manifest.namespaces.map((entry) => [entry.ns, entry.type, entry.documents]),
    ).toEqual([
      ["app.metrics", "timeseries", 1],
      ["app.readonly", "view", 0],
      ["app.system.js", "collection", 1],
      ["admin.system.users", "users", 1],
    ]);
    expect(result.skipped.map((item) => item.ns)).toEqual([
      "app.system.profile",
      "app.system.buckets.lost",
    ]);
    expect(result.manifest.consistency.mode).toBe("converge");
    expect(
      Object.keys(
        BSON.deserialize(
          (await storedDocuments(storage, result.manifest, "app.metrics"))[0] ?? Buffer.alloc(0),
        ),
      ),
    ).toEqual(["t", "m"]);

    const ignored = await importEvents(events, { ignoreOplog: true });
    expect(ignored.skipped.map((item) => item.ns)).toContain("oplog");
    expect(ignored.manifest.consistency.mode).toBe("none");
  });

  it("refuses an archive that announces nothing", async () => {
    const error = await rejection(
      importEvents([{ kind: "prelude", header: HEADER, collections: [] }]),
    );
    expect(isMongoShieldError(error, "MS_CONFIG_INVALID")).toBe(true);
    expect(Reflect.get(Object(error), "hint")).toBe("The dump is empty.");
  });

  it("says what was skipped when nothing could be imported", async () => {
    const error = await rejection(
      importEvents([
        {
          kind: "prelude",
          header: HEADER,
          collections: [
            { db: "app", collection: "system.profile", metadata: "", size: 0, type: "" },
          ],
        },
        { kind: "namespaceEnd", db: "app", collection: "system.profile" },
      ]),
    );
    expect(String(Reflect.get(Object(error), "hint"))).toContain(
      "Everything was skipped: app.system.profile",
    );
  });

  it("reads streams of Uint8Array chunks and explicit gzip settings", async () => {
    const bytes = await archiveBytes([
      {
        kind: "prelude",
        header: HEADER,
        collections: [{ db: "app", collection: "c", metadata: "", size: 0, type: "collection" }],
      },
      {
        kind: "document",
        db: "app",
        collection: "c",
        document: document({ _id: 1, n: new Int32(1), big: Long.fromNumber(2) }),
      },
      { kind: "namespaceEnd", db: "app", collection: "c" },
    ]);
    const chunks = Readable.from([new Uint8Array(bytes)], { objectMode: true });
    expect(
      (await importMongodump({ archive: chunks }, memoryStorage())).manifest.totals.documents,
    ).toBe(1);
    const plain = await importMongodump(
      { archive: Readable.from([bytes]), gzip: false },
      memoryStorage(),
    );
    const gzipped = await importMongodump(
      { archive: Readable.from([gzipSync(bytes)]), gzip: true },
      memoryStorage(),
    );
    expect(gzipped.manifest.totals).toEqual(plain.manifest.totals);
    const empty = await rejection(importMongodump({ archive: Readable.from([]) }, memoryStorage()));
    expect(isMongoShieldError(empty, "MS_FORMAT_UNSUPPORTED")).toBe(true);
  });
});

describe("importMongodump options and paths", () => {
  it("refuses an invalid dumpedAt and an archive path that is a directory", async () => {
    const invalid = await rejection(
      importMongodump({ directory: fixturePath("dump") }, memoryStorage(), {
        dumpedAt: new Date("nope"),
      }),
    );
    expect(isMongoShieldError(invalid, "MS_CONFIG_INVALID")).toBe(true);
    const directory = await rejection(
      importMongodump({ archive: fixturePath("dump") }, memoryStorage()),
    );
    expect(isMongoShieldError(directory, "MS_CONFIG_INVALID")).toBe(true);
  });

  it("keeps the files of _changes.window apart from a changes file", async () => {
    const root = await tempDirectory();
    await mkdir(join(root, "_changes"));
    await writeFile(join(root, "_changes", "window.bson"), bson({ _id: 1 }));
    await writeFile(join(root, "_changes", "window.metadata.json"), USERS_METADATA);
    const result = await importMongodump({ directory: root }, memoryStorage());
    expect(result.manifest.namespaces[0]?.files[0]?.key).toMatch(
      /^_changes\/window~[0-9a-f]{8}\.bson/,
    );
  });
});
