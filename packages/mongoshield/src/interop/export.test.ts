// exportBackup: from a MongoShield backup (made by importing the real mongodump
// fixtures) back to mongodump output, compared with what mongodump itself wrote.

import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { gunzipSync } from "node:zlib";
import { BSON } from "mongodb";
import { describe, expect, it } from "vitest";
import { generateIdentity } from "../crypto/index.ts";
import { isMongoShieldError } from "../errors.ts";
import { resolveBackupKey } from "../format/layout.ts";
import type { Manifest } from "../format/manifest.ts";
import { parseCollectionMetadata } from "../format/metadata.ts";
import { memoryStorage } from "../storage/memory.ts";
import type { ArchiveEvent } from "./archive-format.ts";
import { createArchiveReader } from "./archive-reader.ts";
import { exportBackup } from "./export.ts";
import { selectExportNamespaces } from "./export-data.ts";
import { importMongodump } from "./import.ts";
import {
  fixturePath,
  rejection,
  splitBson,
  storedDocuments,
  useTempDirectories,
} from "./test-fixtures.ts";
import { timeSeriesSettings, unpackBucket } from "./timeseries-buckets.ts";

const tempDirectory = useTempDirectories();

/** A backup made from the real mongodump directory fixture. */
async function importedBackup(options: Parameters<typeof importMongodump>[2] = {}) {
  const storage = memoryStorage();
  const result = await importMongodump({ directory: fixturePath("dump") }, storage, options);
  return { storage, id: result.id, manifest: result.manifest };
}

async function readArchiveEvents(bytes: Buffer): Promise<ArchiveEvent[]> {
  const events: ArchiveEvent[] = [];
  await pipeline(
    Readable.from([bytes]),
    createArchiveReader(),
    new Writable({
      objectMode: true,
      write(event: ArchiveEvent, _encoding, callback) {
        events.push(event);
        callback();
      },
    }),
  );
  return events;
}

describe("exportBackup to a directory", () => {
  it("writes the files mongodump wrote, with identical data files", async () => {
    const { storage, id } = await importedBackup();
    const output = join(await tempDirectory(), "dump");
    const summary = await exportBackup(storage, id, { format: "directory", output });

    expect((await readdir(join(output, "app"))).sort()).toEqual(
      [
        "capped.bson",
        "capped.metadata.json",
        "empty.bson",
        "empty.metadata.json",
        "system.buckets.ts.bson",
        "ts.metadata.json",
        "users.bson",
        "users.metadata.json",
        "v1.metadata.json",
        "we%2Fird+name%2Bx~%C3%A9.bson",
        "we%2Fird+name%2Bx~%C3%A9.metadata.json",
      ].sort(),
    );
    for (const file of ["users.bson", "we%2Fird+name%2Bx~%C3%A9.bson", "empty.bson"]) {
      const exported = await readFile(join(output, "app", file));
      expect(exported.equals(await readFile(fixturePath(`dump/app/${file}`))), file).toBe(true);
    }
    expect(JSON.parse(await readFile(join(output, "prelude.json"), "utf8")).ServerVersion).toBe(
      "7.0.32",
    );
    expect(summary.documents).toBe(5);
    expect(summary.namespaces.map((item) => item.ns)).toContain("app.v1");
  });

  it("writes time-series measurements as buckets that unpack to the same measurements", async () => {
    const { storage, id, manifest } = await importedBackup();
    const output = join(await tempDirectory(), "dump");
    await exportBackup(storage, id, { format: "directory", output });
    const buckets = splitBson(await readFile(join(output, "app", "system.buckets.ts.bson")));
    // Different meta values never share a bucket.
    expect(buckets).toHaveLength(2);
    const metadata = parseCollectionMetadata(
      await readFile(join(output, "app", "ts.metadata.json"), "utf8"),
    );
    const settings = timeSeriesSettings(metadata, "app.ts");
    const unpacked = buckets.flatMap((bucket) => unpackBucket(bucket, settings, "app.ts"));
    expect(unpacked).toEqual(await storedDocuments(storage, manifest, "app.ts"));
    expect(BSON.deserialize(buckets[0] ?? Buffer.alloc(0)).control).toMatchObject({ version: 1 });
  });

  it("writes metadata that means the same as mongodump's", async () => {
    const { storage, id } = await importedBackup();
    const output = join(await tempDirectory(), "dump");
    await exportBackup(storage, id, { format: "directory", output });
    for (const file of ["users.metadata.json", "capped.metadata.json", "v1.metadata.json"]) {
      const exported = parseCollectionMetadata(await readFile(join(output, "app", file), "utf8"));
      const original = parseCollectionMetadata(
        await readFile(fixturePath(`dump/app/${file}`), "utf8"),
      );
      expect(exported, file).toEqual(original);
    }
  });

  it("gzips every file with gzip: true, like mongodump --gzip", async () => {
    const { storage, id } = await importedBackup();
    const output = join(await tempDirectory(), "dump");
    await exportBackup(storage, id, { format: "directory", output, gzip: true });
    const files = await readdir(join(output, "app"));
    expect(files.every((file) => file.endsWith(".gz"))).toBe(true);
    const users = gunzipSync(await readFile(join(output, "app", "users.bson.gz")));
    expect(users.equals(await readFile(fixturePath("dump/app/users.bson")))).toBe(true);
    expect(await readdir(output)).toContain("prelude.json.gz");
  });

  it("refuses a non-empty output directory", async () => {
    const { storage, id } = await importedBackup();
    const output = await tempDirectory();
    await writeFile(join(output, "keep.txt"), "mine");
    const error = await rejection(exportBackup(storage, id, { format: "directory", output }));
    expect(isMongoShieldError(error, "MS_CONFIG_INVALID")).toBe(true);
    expect(await readdir(output)).toEqual(["keep.txt"]);
  });

  it("exports only the selected namespaces", async () => {
    const { storage, id } = await importedBackup();
    const output = join(await tempDirectory(), "dump");
    const summary = await exportBackup(storage, id, {
      format: "directory",
      output,
      include: ["app.users"],
    });
    expect(summary.namespaces.map((item) => item.ns)).toEqual(["app.users"]);
    const error = await rejection(
      exportBackup(storage, id, {
        format: "directory",
        output: `${output}-2`,
        include: ["nope.*"],
      }),
    );
    expect(isMongoShieldError(error, "MS_CONFIG_INVALID")).toBe(true);
  });

  it("leaves out excluded namespaces and accepts any parallelism", async () => {
    const { storage, id } = await importedBackup();
    const output = join(await tempDirectory(), "dump");
    const summary = await exportBackup(storage, id, {
      format: "directory",
      output,
      exclude: ["app.users", "app.v1"],
      parallelism: 1,
    });
    expect(summary.namespaces.map((item) => item.ns)).toEqual([
      "app.capped",
      "app.empty",
      "app.ts",
      "app.we/ird name+x~é",
    ]);
  });

  it("fails on a damaged backup file and removes what it wrote", async () => {
    const { storage, id, manifest } = await importedBackup();
    const users = manifest.namespaces.find((entry) => entry.ns === "app.users")?.files[0];
    if (users === undefined) throw new Error("no users file");
    await storage.put(resolveBackupKey(id, users.key), Buffer.from("not the original bytes"));
    const output = join(await tempDirectory(), "dump");
    const error = await rejection(exportBackup(storage, id, { format: "directory", output }));
    expect(isMongoShieldError(error, "MS_INTEGRITY_FAILED")).toBe(true);
    const leftovers = await readdir(output, { recursive: true });
    expect(leftovers.filter((name) => name.endsWith(".bson") || name.endsWith(".json"))).toEqual(
      [],
    );
  });
});

describe("exportBackup to an archive", () => {
  it("writes an archive whose namespaces and documents match the backup", async () => {
    const { storage, id } = await importedBackup();
    const output = join(await tempDirectory(), "app.archive");
    const summary = await exportBackup(storage, id, { format: "archive", output });
    const events = await readArchiveEvents(await readFile(output));

    const prelude = events[0];
    if (prelude?.kind !== "prelude") throw new Error("no prelude");
    expect(prelude.header.serverVersion).toBe("7.0.32");
    expect(prelude.header.concurrentCollections).toBe(1);
    expect(prelude.collections.map((entry) => `${entry.db}.${entry.collection}`)).toEqual(
      summary.namespaces.map((item) => item.ns),
    );
    const users = events.flatMap((event) =>
      event.kind === "document" && event.collection === "users" ? [event.document] : [],
    );
    expect(users).toEqual(splitBson(await readFile(fixturePath("dump/app/users.bson"))));
  });

  it("gzips the whole archive with gzip: true and can write to a stream", async () => {
    const { storage, id } = await importedBackup();
    const chunks: Buffer[] = [];
    const sink = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        chunks.push(chunk);
        callback();
      },
    });
    const summary = await exportBackup(storage, id, {
      format: "archive",
      output: sink,
      gzip: true,
    });
    expect(summary.output).toBe("stream");
    const bytes = Buffer.concat(chunks);
    expect([bytes[0], bytes[1]]).toEqual([0x1f, 0x8b]);
    const events = await readArchiveEvents(gunzipSync(bytes));
    expect(events.filter((event) => event.kind === "namespaceEnd")).toHaveLength(6);
  });

  it("round-trips through importMongodump", async () => {
    const { storage, id, manifest } = await importedBackup();
    const output = join(await tempDirectory(), "app.archive");
    await exportBackup(storage, id, { format: "archive", output });
    const again = await importMongodump({ archive: output }, memoryStorage());
    const summary = (value: Manifest) =>
      value.namespaces.map((entry) => [entry.ns, entry.type, entry.documents, entry.bytesRaw]);
    expect(summary(again.manifest)).toEqual(summary(manifest));
  });

  it("refuses to overwrite an existing file", async () => {
    const { storage, id } = await importedBackup();
    const output = join(await tempDirectory(), "exists.archive");
    await writeFile(output, "mine");
    const error = await rejection(exportBackup(storage, id, { format: "archive", output }));
    expect(isMongoShieldError(error, "MS_CONFIG_INVALID")).toBe(true);
    expect(await readFile(output, "utf8")).toBe("mine");
  });

  it("needs the key of an encrypted backup, and decrypts with it", async () => {
    const key = generateIdentity();
    const { storage, id } = await importedBackup({ encryption: { recipients: [key.recipient] } });
    const directory = await tempDirectory();
    const missing = await rejection(
      exportBackup(storage, id, { format: "archive", output: join(directory, "a.archive") }),
    );
    expect(isMongoShieldError(missing, "MS_NO_IDENTITY")).toBe(true);
    const summary = await exportBackup(storage, id, {
      format: "archive",
      output: join(directory, "b.archive"),
      decryption: { identities: [key.identity] },
    });
    expect(summary.documents).toBe(5);
  });
});

describe("selectExportNamespaces", () => {
  it("selects users and roles entries apart from the collections, whatever the patterns", async () => {
    const { manifest } = await importedBackup();
    const users = manifest.namespaces.find((entry) => entry.ns === "app.users");
    if (users === undefined) throw new Error("no users");
    const withAuthz: Manifest = {
      ...manifest,
      namespaces: [
        ...manifest.namespaces,
        {
          ...users,
          ns: "admin.system.users",
          db: "admin",
          collection: "system.users",
          type: "users",
        },
      ],
    };
    const selection = selectExportNamespaces(withAuthz, (ns) => ns === "app.users");
    expect(selection.entries.map((entry) => entry.ns)).toEqual(["app.users"]);
    expect(selection.authz.map((entry) => entry.ns)).toEqual(["admin.system.users"]);
    expect(selection.skipped).toEqual([]);
  });
});
