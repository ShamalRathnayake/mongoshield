/**
 * Shared helpers for the interop unit tests (not part of the library).
 *
 * The fixtures in test/fixtures/mongodump/ are real mongodump 100.16.0 output of a
 * MongoDB 7.0 database `app` (see archive.test.ts for what it contains). The
 * directory fixtures leave out the collection with a 100-character name, whose
 * 238-byte file names some filesystems cannot hold; dump-names.test.ts covers them.
 *
 * test/fixtures/mongodump/timeseries/mongodb-{7.0,8.0}/ hold time-series bucket
 * documents as mongodump dumps them from MongoDB 7.0.32 and 8.0.13, with the
 * measurements `find` returned for them (see timeseries-buckets.test.ts).
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach } from "vitest";
import { openBackupSource, openDocumentStream } from "../engine/read-pipeline.ts";
import type { Manifest } from "../format/manifest.ts";
import type { StorageAdapter } from "../storage/types.ts";
import type { DecryptionOptions } from "../types.ts";

const FIXTURES = fileURLToPath(new URL("../../test/fixtures/mongodump/", import.meta.url));

/** Absolute path of a file or directory in test/fixtures/mongodump/. */
export function fixturePath(name: string): string {
  // join, not new URL(name, …): names may contain %-escapes such as %2F.
  return join(FIXTURES, name);
}

/** Splits concatenated BSON (a `.bson` file) into documents. */
export function splitBson(bytes: Buffer): Buffer[] {
  const documents: Buffer[] = [];
  let offset = 0;
  while (offset < bytes.length) {
    const length = bytes.readInt32LE(offset);
    documents.push(bytes.subarray(offset, offset + length));
    offset += length;
  }
  return documents;
}

/** Every stored document of a namespace of a backup, through the real read pipeline. */
export async function storedDocuments(
  storage: StorageAdapter,
  manifest: Manifest,
  ns: string,
  decryption?: DecryptionOptions,
): Promise<Buffer[]> {
  const entry = manifest.namespaces.find((candidate) => candidate.ns === ns);
  if (entry === undefined) throw new Error(`${ns} is not in the backup`);
  const source = await openBackupSource(storage, manifest, decryption);
  const documents: Buffer[] = [];
  for (const file of entry.files) {
    for await (const document of openDocumentStream(source, file)) {
      documents.push(document as Buffer);
    }
  }
  return documents;
}

/** Creates temporary directories that are removed after each test. */
export function useTempDirectories(): () => Promise<string> {
  const created: string[] = [];
  afterEach(async () => {
    for (const path of created.splice(0)) await rm(path, { recursive: true, force: true });
  });
  return async () => {
    const path = await mkdtemp(join(tmpdir(), "mongoshield-interop-"));
    created.push(path);
    return path;
  };
}

/** The error a promise rejects with (fails the test when it resolves). */
export async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected the operation to fail");
}
