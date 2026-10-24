// Edge cases of the archive codec that real mongodump output does not show: malformed
// headers and prelude entries, document framing, writer misuse, and names that need
// escaping or shortening in directories but never in archives.

import { Readable, type Transform, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { BSON, Int32, Long } from "mongodb";
import { describe, expect, it } from "vitest";
import { isMongoShieldError } from "../errors.ts";
import {
  type ArchiveEvent,
  type ArchiveWriterInput,
  decodeArchiveCollection,
  decodeArchiveHeader,
  decodeNamespaceHeader,
  encodeNamespaceHeader,
  MAGIC_BYTES,
  TERMINATOR_BYTES,
} from "./archive-format.ts";
import { createArchiveReader } from "./archive-reader.ts";
import { createArchiveWriter } from "./archive-writer.ts";
import { crc64 } from "./crc64.ts";
import { rejection } from "./test-fixtures.ts";

const header = {
  concurrentCollections: 1,
  formatVersion: "0.1",
  serverVersion: "8.0.13",
  toolVersion: "test",
};

function bson(document: Record<string, unknown>): Buffer {
  return Buffer.from(BSON.serialize(document));
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

function read(bytes: Buffer, options = {}): Promise<ArchiveEvent[]> {
  return collect<ArchiveEvent>(Readable.from([bytes]), createArchiveReader(options));
}

async function write(events: readonly ArchiveWriterInput[]): Promise<Buffer> {
  const chunks = await collect<Buffer>(
    Readable.from(events, { objectMode: true }),
    createArchiveWriter(),
  );
  return Buffer.concat(chunks);
}

/** magic · header · entries · terminator, then the given block bytes. */
function archive(entries: readonly Buffer[], ...blocks: Buffer[]): Buffer {
  const archiveHeader = bson({
    concurrent_collections: new Int32(1),
    version: "0.1",
    server_version: "8.0.13",
    tool_version: "t",
  });
  return Buffer.concat([MAGIC_BYTES, archiveHeader, ...entries, TERMINATOR_BYTES, ...blocks]);
}

function entry(collection: string): Buffer {
  return bson({ db: "a", collection, metadata: "", size: new Int32(0), type: "collection" });
}

function expectCorrupt(run: () => unknown): void {
  let error: unknown;
  try {
    run();
  } catch (caught) {
    error = caught;
  }
  expect(isMongoShieldError(error, "MS_INTEGRITY_FAILED")).toBe(true);
}

describe("archive header and prelude entries", () => {
  it("takes missing fields as empty and accepts int64 integers", () => {
    expect(decodeArchiveHeader(bson({}))).toEqual({
      concurrentCollections: 0,
      formatVersion: "",
      serverVersion: "",
      toolVersion: "",
    });
    expect(
      decodeArchiveHeader(bson({ concurrent_collections: Long.fromNumber(4) }))
        .concurrentCollections,
    ).toBe(4);
    expect(decodeArchiveCollection(bson({ db: "a" }))).toEqual({
      db: "a",
      collection: "",
      metadata: "",
      size: 0,
      type: "",
    });
  });

  it("refuses fields of the wrong type and documents that are not BSON", () => {
    expectCorrupt(() => decodeArchiveHeader(bson({ version: 1 })));
    expectCorrupt(() => decodeArchiveHeader(bson({ concurrent_collections: "four" })));
    expectCorrupt(() => decodeArchiveCollection(bson({ size: 1.5 })));
    expectCorrupt(() => decodeArchiveCollection(Buffer.from([5, 0, 0, 0, 1])));
  });

  it("reads namespace headers without EOF and CRC as opening headers", () => {
    expect(decodeNamespaceHeader(bson({ db: "a", collection: "b" }))).toEqual({
      db: "a",
      collection: "b",
      eof: false,
      crc: 0n,
    });
    const crc = 0xffff_ffff_ffff_fffen;
    expect(
      decodeNamespaceHeader(encodeNamespaceHeader({ db: "a", collection: "b", eof: true, crc }))
        .crc,
    ).toBe(crc);
  });

  it("refuses namespace headers without a collection, or with a malformed EOF or CRC", () => {
    expectCorrupt(() => decodeNamespaceHeader(bson({ db: "a" })));
    expectCorrupt(() => decodeNamespaceHeader(bson({ db: "a", collection: "b", EOF: 1 })));
    expectCorrupt(() =>
      decodeNamespaceHeader(bson({ db: "a", collection: "b", CRC: new Int32(1) })),
    );
  });
});

describe("createArchiveReader framing", () => {
  it("refuses a document that does not end with 0x00", async () => {
    const block = bson({ db: "a", collection: "b", EOF: false, CRC: Long.fromNumber(0) });
    block[block.length - 1] = 1;
    const error = await rejection(read(archive([entry("b")], block)));
    expect(isMongoShieldError(error, "MS_INTEGRITY_FAILED")).toBe(true);
  });

  it("refuses lengths below 5 bytes and above the document size limit", async () => {
    const tiny = archive([], Buffer.from([4, 0, 0, 0]));
    expect(isMongoShieldError(await rejection(read(tiny)), "MS_INTEGRITY_FAILED")).toBe(true);
    const big = bson({ db: "a", collection: "b", pad: "x".repeat(100) });
    const error = await rejection(read(archive([entry("b")], big), { maxDocumentBytes: 64 }));
    expect(String(error)).toContain("neither a valid document length");
  });

  it("refuses a prelude that ends before its archive header", async () => {
    const bytes = Buffer.concat([MAGIC_BYTES, TERMINATOR_BYTES]);
    expect(String(await rejection(read(bytes)))).toContain("no archive header");
  });

  it("refuses documents in a namespace's end-of-file block", async () => {
    const document = bson({ x: 1 });
    const bytes = archive(
      [entry("b")],
      encodeNamespaceHeader({ db: "a", collection: "b", eof: false, crc: 0n }),
      TERMINATOR_BYTES,
      encodeNamespaceHeader({ db: "a", collection: "b", eof: true, crc: 0n }),
      document,
      TERMINATOR_BYTES,
    );
    expect(String(await rejection(read(bytes)))).toContain("follows an end-of-namespace header");
  });

  it("refuses a checksum mismatch, naming the namespace", async () => {
    const document = bson({ x: 1 });
    const bytes = archive(
      [entry("b")],
      encodeNamespaceHeader({ db: "a", collection: "b", eof: false, crc: 0n }),
      document,
      TERMINATOR_BYTES,
      encodeNamespaceHeader({ db: "a", collection: "b", eof: true, crc: crc64(document) ^ 1n }),
      TERMINATOR_BYTES,
    );
    const error = await rejection(read(bytes));
    expect(isMongoShieldError(error, "MS_INTEGRITY_FAILED")).toBe(true);
    expect(String(error)).toContain("checksum of a.b");
  });

  it("refuses an archive that ends with a namespace still open, or inside its prelude", async () => {
    const open = archive(
      [entry("b")],
      encodeNamespaceHeader({ db: "a", collection: "b", eof: false, crc: 0n }),
      TERMINATOR_BYTES,
    );
    expect(String(await rejection(read(open)))).toContain("unfinished");
    const prelude = Buffer.concat([MAGIC_BYTES, bson({ version: "0.1" })]);
    expect(String(await rejection(read(prelude)))).toContain("prelude");
    expect(
      isMongoShieldError(await rejection(read(Buffer.alloc(0))), "MS_FORMAT_UNSUPPORTED"),
    ).toBe(true);
  });

  it("reads empty namespaces, views and names that a directory would escape, unchanged", async () => {
    const names = ["empty", "a view", "we/ird name+x~é", "é".repeat(150)];
    const bytes = await write([
      {
        kind: "prelude",
        header,
        collections: names.map((collection, index) => ({
          db: "a",
          collection,
          metadata: "",
          size: 0,
          type: index === 1 ? "view" : "collection",
        })),
      },
      ...names.map((collection) => ({ kind: "namespaceEnd" as const, db: "a", collection })),
    ]);
    const events = await read(bytes);
    const ends = events.flatMap((event) =>
      event.kind === "namespaceEnd" ? [[event.collection, event.documents]] : [],
    );
    expect(ends).toEqual(names.map((name) => [name, 0]));
  });
});

describe("createArchiveWriter misuse", () => {
  const prelude: ArchiveWriterInput = {
    kind: "prelude",
    header,
    collections: [{ db: "a", collection: "b", metadata: "", size: 0, type: "collection" }],
  };

  it("refuses an archive without a prelude, a second prelude, and a namespace ended twice", async () => {
    for (const events of [
      [] as ArchiveWriterInput[],
      [prelude, prelude],
      [
        prelude,
        { kind: "namespaceEnd", db: "a", collection: "b" },
        { kind: "namespaceEnd", db: "a", collection: "b" },
      ],
    ] as ArchiveWriterInput[][]) {
      expect(isMongoShieldError(await rejection(write(events)), "MS_INTERNAL")).toBe(true);
    }
  });

  it("refuses to finish while a namespace that was not announced is open", async () => {
    const document = bson({ x: 1 });
    const events: ArchiveWriterInput[] = [
      prelude,
      { kind: "namespaceEnd", db: "a", collection: "b" },
      { kind: "document", db: "a", collection: "extra", document },
    ];
    const error = await rejection(write(events));
    expect(String(error)).toContain("a.extra");
  });
});
