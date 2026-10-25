// Shared helpers for the backup engine's integration tests: building a context,
// reading stored files back (decrypt → decompress → split into documents) and
// reading the source collection's raw documents for byte-for-byte comparison.

import { createHash } from "node:crypto";
import type { Transform } from "node:stream";
import { Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { Document, MongoClient } from "mongodb";
import { createDecompressor } from "../../src/compression/index.ts";
import {
  createDecryptStream,
  type DecryptStreamOptions,
  parseIdentityFile,
} from "../../src/crypto/index.ts";
import type { BackupContext } from "../../src/engine/context.ts";
import { createBsonSplitter } from "../../src/format/bson-stream.ts";
import { resolveBackupKey } from "../../src/format/layout.ts";
import type { Compression, Manifest, NamespaceEntry } from "../../src/format/manifest.ts";
import { type CollectionMetadata, parseCollectionMetadata } from "../../src/format/metadata.ts";
import { silentLogger } from "../../src/logger.ts";
import type { StorageAdapter } from "../../src/storage/types.ts";
import type { EncryptionOptions } from "../../src/types.ts";
import { readStreamToBuffer } from "../../src/util/streams.ts";

/** A backup context with sensible test defaults. */
export function backupContext(
  client: MongoClient,
  storage: StorageAdapter,
  overrides: { compression?: Compression; encryption?: EncryptionOptions } = {},
): BackupContext {
  return {
    client,
    storage,
    logger: silentLogger,
    compression: overrides.compression ?? "zstd",
    encryption: overrides.encryption,
  };
}

/** Reads a whole stored object (tests only; objects here are small enough). */
export async function readObject(storage: StorageAdapter, key: string): Promise<Buffer> {
  return readStreamToBuffer(await storage.get(key), { maxBytes: 512 * 1024 * 1024 });
}

export function sha256(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

/** Looks up a namespace entry, failing the test if it is missing. */
export function entryFor(manifest: Manifest, ns: string): NamespaceEntry {
  const entry = manifest.namespaces.find((candidate) => candidate.ns === ns);
  if (entry === undefined) throw new Error(`manifest has no entry for ${ns}`);
  return entry;
}

/**
 * The decrypting stream for a backup's files, or nothing if it is not encrypted.
 * For passphrase backups the key envelope is opened first, independently of the
 * engine's read pipeline, so these tests check the format itself.
 */
async function decryptTransforms(
  storage: StorageAdapter,
  manifest: Manifest,
  decryption: DecryptStreamOptions | undefined,
): Promise<Transform[]> {
  if (manifest.encryption === null) return [];
  if (decryption === undefined) throw new Error("backup is encrypted but no decryption given");
  const keyFile = manifest.encryption.keyFile;
  if (keyFile === undefined || decryption.passphrase === undefined) {
    return [createDecryptStream(decryption)];
  }
  const keyFileText = await decryptKeyFile(storage, manifest, decryption.passphrase);
  return [createDecryptStream({ identities: parseIdentityFile(keyFileText) })];
}

/** Decrypts a passphrase backup's `backup-key.age` and returns the key-file text. */
export async function decryptKeyFile(
  storage: StorageAdapter,
  manifest: Manifest,
  passphrase: string,
): Promise<string> {
  const keyFile = manifest.encryption?.keyFile;
  if (keyFile === undefined) throw new Error("not a passphrase backup");
  const chunks: Buffer[] = [];
  await pipeline([
    await storage.get(resolveBackupKey(manifest.id, keyFile.key)),
    createDecryptStream({ passphrase }),
    collectInto(chunks),
  ]);
  return Buffer.concat(chunks).toString("utf8");
}

/** Decrypts, decompresses and splits a data file into raw BSON documents. */
export async function decodeDataFile(
  storage: StorageAdapter,
  manifest: Manifest,
  ns: string,
  decryption?: DecryptStreamOptions,
): Promise<Buffer[]> {
  const documents: Buffer[] = [];
  for (const file of entryFor(manifest, ns).files) {
    const source = await storage.get(resolveBackupKey(manifest.id, file.key));
    await pipeline([
      source,
      ...(await decryptTransforms(storage, manifest, decryption)),
      createDecompressor(manifest.compression),
      createBsonSplitter(),
      collectInto(documents),
    ]);
  }
  return documents;
}

/** Decrypts and parses a namespace's metadata file. */
export async function decodeMetadata(
  storage: StorageAdapter,
  manifest: Manifest,
  ns: string,
  decryption?: DecryptStreamOptions,
): Promise<CollectionMetadata> {
  const key = resolveBackupKey(manifest.id, entryFor(manifest, ns).metadata.key);
  const chunks: Buffer[] = [];
  await pipeline([
    await storage.get(key),
    ...(await decryptTransforms(storage, manifest, decryption)),
    collectInto(chunks),
  ]);
  return parseCollectionMetadata(Buffer.concat(chunks).toString("utf8"), key);
}

/** The source collection's documents as the raw BSON bytes the server sends. */
export async function sourceDocuments(
  client: MongoClient,
  ns: string,
  query: Document = {},
): Promise<Buffer[]> {
  const dot = ns.indexOf(".");
  const cursor = client
    .db(ns.slice(0, dot))
    .collection(ns.slice(dot + 1))
    .find(query, { raw: true });
  const documents: Buffer[] = [];
  for await (const document of cursor as AsyncIterable<unknown>) {
    if (!(document instanceof Uint8Array)) throw new Error("expected raw BSON");
    documents.push(Buffer.from(document));
  }
  return documents;
}

/** Checks every stored file's size and SHA-256 against the manifest. */
export async function expectFilesMatchManifest(
  storage: StorageAdapter,
  manifest: Manifest,
): Promise<void> {
  for (const entry of manifest.namespaces) {
    for (const file of [entry.metadata, ...entry.files]) {
      const bytes = await readObject(storage, resolveBackupKey(manifest.id, file.key));
      if (bytes.length !== file.size || sha256(bytes) !== file.sha256) {
        throw new Error(`${file.key} does not match its manifest entry`);
      }
    }
  }
}

function collectInto(target: Buffer[]): Writable {
  return new Writable({
    objectMode: true,
    write(chunk: Buffer, _encoding, callback) {
      target.push(Buffer.from(chunk));
      callback();
    },
  });
}
