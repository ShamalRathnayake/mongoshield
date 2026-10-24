/**
 * Test helpers that WRITE valid MongoShield backups from in-test documents, using the
 * format, compression and crypto modules directly. Restore and verify tests use them
 * so they do not depend on the backup engine, and can build backups the engine never
 * would (tampered files, odd BSON, several parts, mismatching manifests).
 *
 *   const manifest = await writeTestBackup(storage, {
 *     namespaces: [{ ns: "app.users", documents: [{ _id: 1, name: "Ada" }] }],
 *     compression: "zstd",
 *   });
 *
 * `backupDatabaseForTest()` snapshots real collections (options and indexes from
 * `discoverNamespaces`, raw documents from `find`) into such a backup.
 */

import { createHash } from "node:crypto";
import { Readable, type Transform, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { BSON, type Document, type MongoClient } from "mongodb";
import { createCompressor } from "../../src/compression/index.ts";
import { createEncryptStream } from "../../src/crypto/index.ts";
import {
  dataFileKey,
  metadataFileKey,
  newBackupId,
  resolveBackupKey,
} from "../../src/format/layout.ts";
import type {
  Compression,
  Manifest,
  NamespaceEntry,
  StoredFile,
} from "../../src/format/manifest.ts";
import { writeManifest } from "../../src/format/manifest-io.ts";
import {
  type SearchIndexDefinition,
  serializeCollectionMetadata,
} from "../../src/format/metadata.ts";
import { discoverNamespaces } from "../../src/mongo/index.ts";
import type { StorageAdapter } from "../../src/storage/types.ts";

/** One namespace of a test backup. */
export interface FixtureNamespace {
  /** `db.collection`. */
  readonly ns: string;
  /** Defaults to `"collection"`. */
  readonly type?: "collection" | "view" | "timeseries";
  /** Documents, serialized with BSON.serialize (wrapper types are kept). */
  readonly documents?: readonly Document[];
  /** Documents as raw BSON, written byte for byte (takes precedence over `documents`). */
  readonly rawDocuments?: readonly Uint8Array[];
  /** `listCollections` options. Defaults to `{}`. */
  readonly options?: Document;
  /** `listIndexes` output. Defaults to the `_id_` index for collections, `[]` otherwise. */
  readonly indexes?: readonly Document[];
  /** Split the data into parts of this many documents. Omit for a single part. */
  readonly documentsPerPart?: number;
  /** Atlas Search index definitions written to the metadata file. */
  readonly searchIndexes?: readonly SearchIndexDefinition[];
}

/** Options for `writeTestBackup`. */
export interface WriteTestBackupOptions {
  readonly namespaces: readonly FixtureNamespace[];
  /** Defaults to `"zstd"`. */
  readonly compression?: Compression;
  /** Encrypt to these age recipients. */
  readonly recipients?: readonly string[];
  /** Encrypt with this passphrase. */
  readonly passphrase?: string;
  /** scrypt work factor for passphrase backups. Defaults to 2 so tests stay fast. */
  readonly scryptWorkFactor?: number;
  /** Start time encoded in the backup id. Defaults to now. */
  readonly startedAt?: Date;
}

/** The `_id_` index every regular collection has. */
const ID_INDEX: Document = { v: 2, key: { _id: 1 }, name: "_id_" };

/** Low scrypt cost for tests (the default, 18, takes about a second per file). */
const TEST_SCRYPT_WORK_FACTOR = 2;

/**
 * Writes a complete, valid backup (data files, metadata files, manifest last)
 * and returns its manifest.
 */
export async function writeTestBackup(
  storage: StorageAdapter,
  options: WriteTestBackupOptions,
): Promise<Manifest> {
  const startedAt = options.startedAt ?? new Date();
  const id = newBackupId(startedAt);
  const compression = options.compression ?? "zstd";
  const encrypted = options.recipients !== undefined || options.passphrase !== undefined;
  const writer: FileWriter = { storage, id, compression, encrypted, options };

  const entries: NamespaceEntry[] = [];
  for (const namespace of options.namespaces) {
    entries.push(await writeNamespace(writer, namespace));
  }

  const manifest: Manifest = {
    formatVersion: 1,
    id,
    tool: "mongoshield-test-fixtures",
    status: "complete",
    startedAt: startedAt.toISOString(),
    completedAt: new Date(startedAt.getTime() + 1000).toISOString(),
    source: { topology: "replicaSet", serverVersion: "7.0.0" },
    consistency: { mode: "none" },
    compression,
    encryption: encrypted
      ? {
          scheme: "age-v1",
          recipients:
            options.passphrase !== undefined ? ["scrypt"] : [...(options.recipients ?? [])],
        }
      : null,
    labels: {},
    namespaces: entries,
    totals: {
      namespaces: entries.length,
      documents: entries.reduce((sum, entry) => sum + entry.documents, 0),
      bytesRaw: entries.reduce((sum, entry) => sum + entry.bytesRaw, 0),
      bytesStored: entries.reduce(
        (sum, entry) =>
          sum + entry.metadata.size + entry.files.reduce((total, file) => total + file.size, 0),
        0,
      ),
    },
  };
  await writeManifest(storage, manifest);
  return manifest;
}

/** Options for `backupDatabaseForTest`. */
export interface BackupDatabaseOptions extends Omit<WriteTestBackupOptions, "namespaces"> {
  /** Namespace patterns, e.g. `["app.*"]`. */
  readonly include: readonly string[];
}

/**
 * Snapshots real namespaces into a test backup: options and indexes exactly as
 * `discoverNamespaces` reports them, documents as the raw BSON the server returns.
 */
export async function backupDatabaseForTest(
  client: MongoClient,
  storage: StorageAdapter,
  options: BackupDatabaseOptions,
): Promise<Manifest> {
  const specs = await discoverNamespaces(client, { include: options.include });
  const namespaces: FixtureNamespace[] = [];
  for (const spec of specs) {
    const rawDocuments: Uint8Array[] = [];
    if (spec.type !== "view") {
      const cursor = client.db(spec.db).collection(spec.name).find({}, { raw: true });
      for await (const raw of cursor) rawDocuments.push(raw as unknown as Uint8Array);
    }
    namespaces.push({
      ns: spec.ns,
      type: spec.type,
      options: spec.options,
      indexes: [...spec.indexes],
      rawDocuments,
    });
  }
  return writeTestBackup(storage, { ...options, namespaces });
}

/** Overwrites one stored file of a backup (to simulate tampering or truncation). */
export async function replaceStoredFile(
  storage: StorageAdapter,
  manifest: Manifest,
  relativeKey: string,
  change: (bytes: Buffer) => Buffer,
): Promise<void> {
  const key = resolveBackupKey(manifest.id, relativeKey);
  const chunks: Buffer[] = [];
  for await (const chunk of await storage.get(key)) chunks.push(chunk as Buffer);
  await storage.put(key, change(Buffer.concat(chunks)));
}

/** Returns a copy of `bytes` with one bit flipped at `offset` (negative counts from the end). */
export function flipByte(bytes: Buffer, offset: number): Buffer {
  const copy = Buffer.from(bytes);
  const position = offset < 0 ? copy.length + offset : offset;
  copy[position] = (copy[position] ?? 0) ^ 0x01;
  return copy;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

interface FileWriter {
  readonly storage: StorageAdapter;
  readonly id: string;
  readonly compression: Compression;
  readonly encrypted: boolean;
  readonly options: WriteTestBackupOptions;
}

async function writeNamespace(
  writer: FileWriter,
  namespace: FixtureNamespace,
): Promise<NamespaceEntry> {
  const dot = namespace.ns.indexOf(".");
  const db = namespace.ns.slice(0, dot);
  const collection = namespace.ns.slice(dot + 1);
  const type = namespace.type ?? "collection";
  const raw = rawDocumentsOf(namespace);

  const files: StoredFile[] = [];
  if (type !== "view") {
    const parts = splitIntoParts(raw, namespace.documentsPerPart);
    for (const [index, part] of parts.entries()) {
      const key = dataFileKey({
        db,
        collection,
        compression: writer.compression,
        encrypted: writer.encrypted,
        ...(parts.length > 1 ? { part: index } : {}),
      });
      const body = await transform(Buffer.concat(part), [
        createCompressor(writer.compression),
        ...encryptionStages(writer),
      ]);
      files.push(await store(writer, key, body));
    }
  }

  const metadataText = serializeCollectionMetadata({
    collectionName: collection,
    type,
    options: namespace.options ?? {},
    indexes: [...(namespace.indexes ?? (type === "collection" ? [ID_INDEX] : []))],
    ...(namespace.searchIndexes === undefined
      ? {}
      : { searchIndexes: [...namespace.searchIndexes] }),
  });
  const metadataBody = await transform(Buffer.from(metadataText, "utf8"), encryptionStages(writer));
  const metadata = await store(
    writer,
    metadataFileKey({ db, collection, encrypted: writer.encrypted }),
    metadataBody,
  );

  return {
    ns: namespace.ns,
    db,
    collection,
    type,
    documents: type === "view" ? 0 : raw.length,
    bytesRaw: raw.reduce((sum, document) => sum + document.length, 0),
    files,
    metadata,
  };
}

function rawDocumentsOf(namespace: FixtureNamespace): Buffer[] {
  if (namespace.rawDocuments !== undefined) {
    return namespace.rawDocuments.map((document) => Buffer.from(document));
  }
  return (namespace.documents ?? []).map((document) =>
    Buffer.from(BSON.serialize(document, { checkKeys: false })),
  );
}

/** Always at least one part, so even empty collections have a data file. */
function splitIntoParts(documents: Buffer[], perPart: number | undefined): Buffer[][] {
  if (perPart === undefined || documents.length <= perPart) return [documents];
  const parts: Buffer[][] = [];
  for (let start = 0; start < documents.length; start += perPart) {
    parts.push(documents.slice(start, start + perPart));
  }
  return parts;
}

function encryptionStages(writer: FileWriter): Transform[] {
  if (!writer.encrypted) return [];
  const { passphrase, recipients } = writer.options;
  return [
    createEncryptStream(
      passphrase !== undefined
        ? {
            passphrase,
            scryptWorkFactor: writer.options.scryptWorkFactor ?? TEST_SCRYPT_WORK_FACTOR,
          }
        : { recipients: recipients ?? [] },
    ),
  ];
}

/** Runs `input` through the stages and collects the output. */
async function transform(input: Buffer, stages: readonly Transform[]): Promise<Buffer> {
  const chunks: Buffer[] = [];
  const sink = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      chunks.push(chunk);
      callback();
    },
  });
  await pipeline([Readable.from([input]), ...stages, sink]);
  return Buffer.concat(chunks);
}

async function store(writer: FileWriter, key: string, body: Buffer): Promise<StoredFile> {
  await writer.storage.put(resolveBackupKey(writer.id, key), body);
  return { key, size: body.length, sha256: createHash("sha256").update(body).digest("hex") };
}
