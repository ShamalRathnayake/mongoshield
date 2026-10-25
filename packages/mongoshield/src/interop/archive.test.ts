// The archive reader and writer, checked against real mongodump output.
//
// test/fixtures/mongodump/app.archive and app.archive.gz were written by
// `mongodump --db app --archive[=…] [--gzip]` (mongodump 100.16.0, MongoDB 7.0.32)
// from a database with a regular collection with a unique index (`users`), an empty
// one, a capped one, a view (`v1`), a time-series collection (`ts`), a collection
// with an awkward name (`we/ird name+x~é`) and one with a 100-character name.

import { readFileSync } from "node:fs";
import { Readable, type Transform, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { gunzipSync } from "node:zlib";
import fc from "fast-check";
import { BSON } from "mongodb";
import { describe, expect, it } from "vitest";
import { isMongoShieldError } from "../errors.ts";
import type { ArchiveEvent, ArchivePreludeEvent, ArchiveWriterInput } from "./archive-format.ts";
import { createArchiveReader } from "./archive-reader.ts";
import { createArchiveWriter } from "./archive-writer.ts";

const FIXTURES = new URL("../../test/fixtures/mongodump/", import.meta.url);
const realArchive = readFileSync(new URL("app.archive", FIXTURES));
const realGzipArchive = readFileSync(new URL("app.archive.gz", FIXTURES));

/** Feeds `bytes` to the reader in chunks of `chunkSize` and collects the events. */
async function readEvents(bytes: Buffer, chunkSize = 65_536): Promise<ArchiveEvent[]> {
  const chunks: Buffer[] = [];
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    chunks.push(bytes.subarray(offset, offset + chunkSize));
  }
  return collect<ArchiveEvent>(Readable.from(chunks), createArchiveReader());
}

/** Writes events through the writer and returns the archive bytes. */
async function writeArchive(events: readonly ArchiveWriterInput[]): Promise<Buffer> {
  const chunks = await collect<Buffer>(
    Readable.from(events, { objectMode: true }),
    createArchiveWriter(),
  );
  return Buffer.concat(chunks);
}

async function collect<T>(source: Readable, transform: Transform): Promise<T[]> {
  const output: T[] = [];
  await pipeline(
    source,
    transform,
    new Writable({
      objectMode: true,
      write(item: T, _encoding, callback) {
        output.push(item);
        callback();
      },
    }),
  );
  return output;
}

/** The error a promise rejects with. */
async function failure(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected a failure");
}

function preludeOf(events: readonly ArchiveEvent[]): ArchivePreludeEvent {
  const first = events[0];
  if (first?.kind !== "prelude") throw new Error("no prelude");
  return first;
}

function documentsOf(events: readonly ArchiveEvent[], collection: string): Buffer[] {
  return events.flatMap((event) =>
    event.kind === "document" && event.collection === collection ? [event.document] : [],
  );
}

describe("createArchiveReader on real mongodump output", () => {
  it("reads the archive header and every namespace of the prelude", async () => {
    const prelude = preludeOf(await readEvents(realArchive));
    expect(prelude.header).toEqual({
      concurrentCollections: 4,
      formatVersion: "0.1",
      serverVersion: "7.0.32",
      toolVersion: "100.16.0",
    });
    const byName = new Map(prelude.collections.map((entry) => [entry.collection, entry]));
    expect(byName.get("users")?.type).toBe("collection");
    expect(byName.get("v1")?.type).toBe("view");
    expect(byName.get("ts")?.type).toBe("timeseries");
    expect(byName.get("we/ird name+x~é")?.db).toBe("app");
    expect(byName.get("users")?.metadata).toContain('"name":"name_1","unique":true');
  });

  it("yields every document as raw BSON, and time-series data under system.buckets", async () => {
    const events = await readEvents(realArchive);
    const users = documentsOf(events, "users").map((bytes) => BSON.deserialize(bytes));
    expect(users.map((user) => user.name)).toEqual(["a", "b"]);
    expect(documentsOf(events, "system.buckets.ts")).toHaveLength(2);
    expect(documentsOf(events, "empty")).toHaveLength(0);
  });

  it("ends every namespace once, with its document count and checksum", async () => {
    const events = await readEvents(realArchive);
    const ends = events.filter((event) => event.kind === "namespaceEnd");
    expect(ends.map((end) => end.collection).sort()).toEqual(
      [
        "capped",
        "empty",
        "system.buckets.ts",
        "users",
        "v1",
        "we/ird name+x~é",
        "é".repeat(100),
      ].sort(),
    );
    const users = ends.find((end) => end.collection === "users");
    expect(users?.documents).toBe(2);
    expect(users?.crc).not.toBe(0n);
    expect(ends.find((end) => end.collection === "v1")?.crc).toBe(0n);
  });

  it("gives the same events however the bytes are chunked", async () => {
    const whole = await readEvents(realArchive);
    expect(await readEvents(realArchive, 1)).toEqual(whole);
    expect(await readEvents(realArchive, 7)).toEqual(whole);
  });

  it("reads the gzipped archive once it is gunzipped", async () => {
    // A separate mongodump run, so blocks may be interleaved differently: compare
    // what each namespace holds rather than the event order.
    const plain = await readEvents(realArchive);
    const gzipped = await readEvents(gunzipSync(realGzipArchive));
    const names = (events: ArchiveEvent[]) =>
      preludeOf(events)
        .collections.map((entry) => entry.collection)
        .sort();
    expect(names(gzipped)).toEqual(names(plain));
    for (const collection of ["users", "system.buckets.ts", "we/ird name+x~é"]) {
      expect(documentsOf(gzipped, collection)).toHaveLength(documentsOf(plain, collection).length);
    }
  });

  it("is reproduced byte for byte by piping its events into the writer", async () => {
    const events = await readEvents(realArchive);
    expect((await writeArchive(events)).equals(realArchive)).toBe(true);
  });
});

describe("createArchiveReader on damaged input", () => {
  it("refuses input that is not an archive, and suggests gzip for gzipped input", async () => {
    const plain = await failure(readEvents(Buffer.from("not an archive at all")));
    expect(isMongoShieldError(plain, "MS_FORMAT_UNSUPPORTED")).toBe(true);
    const gzipped = await failure(readEvents(realGzipArchive));
    expect(isMongoShieldError(gzipped, "MS_FORMAT_UNSUPPORTED")).toBe(true);
    expect((gzipped as Error & { hint?: string }).hint).toContain("--gzip");
    expect(
      isMongoShieldError(await failure(readEvents(Buffer.alloc(0))), "MS_FORMAT_UNSUPPORTED"),
    ).toBe(true);
  });

  it("detects truncation at every possible length", async () => {
    for (let length = 4; length < realArchive.length; length += 1) {
      const error = await failure(readEvents(realArchive.subarray(0, length)));
      expect(isMongoShieldError(error, "MS_INTEGRITY_FAILED"), `cut at ${length}`).toBe(true);
    }
  });

  it("detects a changed byte inside a document through the namespace checksum", async () => {
    const damaged = Buffer.from(realArchive);
    const userB = damaged.indexOf(Buffer.from("name\0\x02\0\0\0b\0", "latin1"));
    expect(userB).toBeGreaterThan(0);
    damaged[userB + 9] = "c".charCodeAt(0); // "b" → "c": still valid BSON
    const error = await failure(readEvents(damaged));
    expect(isMongoShieldError(error, "MS_INTEGRITY_FAILED")).toBe(true);
    expect(String(error)).toContain("checksum of app.users");
  });

  it("rejects a block without a namespace header", async () => {
    const events = await readEvents(realArchive);
    const bytes = await writeArchive(events);
    const withExtraTerminator = Buffer.concat([bytes, Buffer.from([0xff, 0xff, 0xff, 0xff])]);
    expect(
      isMongoShieldError(await failure(readEvents(withExtraTerminator)), "MS_INTEGRITY_FAILED"),
    ).toBe(true);
  });

  it("rejects a namespace that reappears after its end", async () => {
    const prelude: ArchivePreludeEvent = {
      kind: "prelude",
      header: {
        concurrentCollections: 1,
        formatVersion: "0.1",
        serverVersion: "7.0.0",
        toolVersion: "t",
      },
      collections: [{ db: "a", collection: "b", metadata: "", size: 0, type: "collection" }],
    };
    const document = Buffer.from(BSON.serialize({ x: 1 }));
    const once = await writeArchive([
      prelude,
      { kind: "document", db: "a", collection: "b", document },
      { kind: "namespaceEnd", db: "a", collection: "b" },
    ]);
    // Append a second block for a.b: the same bytes as its first block.
    const firstBlock = once.subarray(once.indexOf(Buffer.from([0xff, 0xff, 0xff, 0xff])) + 4);
    const reopened = Buffer.concat([
      once,
      firstBlock.subarray(0, firstBlock.indexOf(Buffer.from([0xff, 0xff, 0xff, 0xff])) + 4),
    ]);
    const error = await failure(readEvents(reopened));
    expect(isMongoShieldError(error, "MS_INTEGRITY_FAILED")).toBe(true);
    expect(String(error)).toContain("appears again");
  });

  it("rejects an archive that ends before an announced namespace was seen", async () => {
    const bytes = await writeArchive([
      {
        kind: "prelude",
        header: {
          concurrentCollections: 1,
          formatVersion: "0.1",
          serverVersion: "7.0.0",
          toolVersion: "t",
        },
        collections: [],
      },
    ]);
    // Hand-craft a prelude that announces a namespace the archive never contains.
    const events = await readEvents(bytes);
    expect(events).toHaveLength(1);
    const announcing = Buffer.from(
      realArchive.subarray(0, realArchive.indexOf(Buffer.from([0xff, 0xff, 0xff, 0xff])) + 4),
    );
    const error = await failure(readEvents(announcing));
    expect(String(error)).toContain("before all announced namespaces were seen");
  });
});

describe("createArchiveWriter", () => {
  const header = {
    concurrentCollections: 1,
    formatVersion: "0.1",
    serverVersion: "7.0.0",
    toolVersion: "test",
  };

  it("round-trips any interleaving of namespaces and documents through the reader", async () => {
    const namespaceArbitrary = fc.constantFrom("a.one", "a.two", "b.three");
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.tuple(namespaceArbitrary, fc.dictionary(fc.string(), fc.integer())), {
          maxLength: 30,
        }),
        async (writes) => {
          const names = ["a.one", "a.two", "b.three"];
          const input: ArchiveWriterInput[] = [
            {
              kind: "prelude",
              header,
              collections: names.map((ns) => {
                const [db = "", collection = ""] = ns.split(".");
                return { db, collection, metadata: "{}", size: 0, type: "collection" };
              }),
            },
          ];
          for (const [ns, document] of writes) {
            const [db = "", collection = ""] = ns.split(".");
            input.push({
              kind: "document",
              db,
              collection,
              document: Buffer.from(BSON.serialize(document)),
            });
          }
          for (const ns of names) {
            const [db = "", collection = ""] = ns.split(".");
            input.push({ kind: "namespaceEnd", db, collection });
          }

          const events = await readEvents(await writeArchive(input));
          for (const ns of names) {
            const [, collection = ""] = ns.split(".");
            const written = writes
              .filter(([name]) => name === ns)
              .map(([, document]) => Buffer.from(BSON.serialize(document)));
            expect(documentsOf(events, collection)).toEqual(written);
          }
        },
      ),
      { numRuns: 50 },
    );
  });

  it("writes an empty opening block for namespaces without documents, as mongodump does", async () => {
    const events = await readEvents(
      await writeArchive([
        {
          kind: "prelude",
          header,
          collections: [{ db: "a", collection: "v", metadata: "", size: 0, type: "view" }],
        },
        { kind: "namespaceEnd", db: "a", collection: "v" },
      ]),
    );
    expect(events.map((event) => event.kind)).toEqual([
      "prelude",
      "namespaceStart",
      "namespaceEnd",
    ]);
  });

  it("refuses input that would make mongorestore reject the archive", async () => {
    const prelude: ArchiveWriterInput = {
      kind: "prelude",
      header,
      collections: [{ db: "a", collection: "b", metadata: "", size: 0, type: "collection" }],
    };
    const document = Buffer.from(BSON.serialize({ x: 1 }));
    const cases: ArchiveWriterInput[][] = [
      [{ kind: "document", db: "a", collection: "b", document }],
      [prelude],
      [
        prelude,
        { kind: "namespaceEnd", db: "a", collection: "b" },
        { kind: "document", db: "a", collection: "b", document },
      ],
      [prelude, { kind: "document", db: "a", collection: "b", document: Buffer.from([1, 2, 3]) }],
    ];
    for (const input of cases) {
      expect(isMongoShieldError(await failure(writeArchive(input)), "MS_INTERNAL")).toBe(true);
    }
  });
});
