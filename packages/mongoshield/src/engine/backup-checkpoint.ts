/**
 * Checkpoints of resumable backups (`maxDurationMs` / `resume`).
 *
 *   _state/checkpoints/<backup id>.json
 *
 * A checkpoint records everything a later process needs to finish the backup:
 * the plan (namespaces, metadata files, part boundaries), every finished part's
 * stored file and counts, how the files are encrypted, and a fingerprint of the
 * options that shaped the backup. It lives outside `backups/<id>/`, so the backup
 * directory stays mongodump-shaped; it is rewritten after every finished part and
 * deleted once the manifest is committed.
 *
 * Nothing secret is stored: patterns, recipient strings, KMS key names, the public
 * recipient of a passphrase or KMS backup's key envelope, and a hash of the
 * `query` filters (they may contain customer data).
 *
 * See docs/specs/PARTS-AND-RESUME.md, section 2.
 */

import { createHash } from "node:crypto";
import { BSON, type Document } from "mongodb";
import { z } from "zod";
import { isMongoShieldError, MongoShieldError } from "../errors.ts";
import {
  CHECKPOINTS_PREFIX,
  checkpointKey,
  isBackupId,
  resolveBackupKey,
} from "../format/layout.ts";
import { type Compression, StoredFileSchema } from "../format/manifest.ts";
import type { StorageAdapter } from "../storage/types.ts";
import type { BackupOptions } from "../types.ts";
import { readStreamToBuffer } from "../util/streams.ts";
import type { EncryptionPlan } from "./backup-options.ts";

/** Version of the checkpoint shape; a reader refuses versions it does not know. */
export const CHECKPOINT_FORMAT_VERSION = 1;

// Where checkpoints live is part of the storage layout.
export { CHECKPOINTS_PREFIX, checkpointKey } from "../format/layout.ts";

/** Checkpoints are a few KiB per thousand parts; anything far larger is not one. */
const MAX_CHECKPOINT_BYTES = 64 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Shape
// ---------------------------------------------------------------------------

/** The options that must not change between the invocations of one backup. */
export const FingerprintSchema = z.object({
  include: z.array(z.string()),
  exclude: z.array(z.string()),
  /** SHA-256 of the `query` filters as canonical Extended JSON, or null without any. */
  query: z.string().nullable(),
  compression: z.enum(["zstd", "gzip", "none"]),
  encryption: z.object({
    kind: z.enum(["none", "recipients", "passphrase", "kms"]),
    /** Normalized `age1…` recipients (recipient and KMS backups), sorted. */
    recipients: z.array(z.string()),
    /** `provider:key` of every KMS key, sorted. */
    kms: z.array(z.string()),
  }),
  /** `retainDays`, or null without retention: every file must be locked the same way. */
  retainDays: z.number().nullable(),
});

/** A finished part: its stored file and what it holds. */
const FinishedPartSchema = z.object({
  size: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  documents: z.number().int().nonnegative(),
  bytesRaw: z.number().int().nonnegative(),
});

const CheckpointPartSchema = z.object({
  /** Key relative to the backup directory. */
  key: z.string().min(1),
  /** Present once the part is stored. */
  done: FinishedPartSchema.optional(),
});

const CheckpointNamespaceSchema = z.object({
  ns: z.string().min(3),
  db: z.string().min(1),
  collection: z.string().min(1),
  type: z.enum(["collection", "view", "timeseries"]),
  estimatedDocuments: z.number().nonnegative(),
  /** For cursor batch sizes; absent when unknown. */
  averageDocumentBytes: z.number().positive().optional(),
  metadata: StoredFileSchema,
  /**
   * Interior `_id` boundaries as canonical Extended JSON; present only for split
   * collections (parts = boundaries + 1).
   */
  boundaries: z.array(z.unknown()).optional(),
  /** Empty for views. */
  parts: z.array(CheckpointPartSchema),
});

/** The whole checkpoint document (see the file header). */
export const CheckpointSchema = z.object({
  formatVersion: z.literal(CHECKPOINT_FORMAT_VERSION),
  id: z.string().refine(isBackupId, "not a backup id"),
  /** Writer, e.g. `mongoshield@2.0.0`. */
  tool: z.string().min(1),
  /** Start of the FIRST invocation; becomes the manifest's `startedAt`. */
  startedAt: z.iso.datetime({ offset: true }),
  updatedAt: z.iso.datetime({ offset: true }),
  /** How many invocations have worked on this backup so far. */
  invocations: z.number().int().positive(),
  fingerprint: FingerprintSchema,
  labels: z.record(z.string(), z.string()),
  source: z.object({
    topology: z.enum(["standalone", "replicaSet", "sharded", "unknown"]),
    serverVersion: z.string(),
    clusterId: z.string().optional(),
  }),
  encryption: z
    .object({
      /** What the manifest will list (recipients, `scrypt`, `kms:…` labels). */
      manifestRecipients: z.array(z.string()).min(1),
      /** Every data file is encrypted to these public recipients. */
      recipients: z.array(z.string()).min(1),
      keyFile: StoredFileSchema.optional(),
    })
    .nullable(),
  namespaces: z.array(CheckpointNamespaceSchema),
});

/** The options that must not change between invocations (see `backupFingerprint`). */
export type BackupFingerprint = z.infer<typeof FingerprintSchema>;
/** A parsed checkpoint. */
export type Checkpoint = z.infer<typeof CheckpointSchema>;
/** One namespace's plan and progress, as stored in a checkpoint. */
export type CheckpointNamespace = z.infer<typeof CheckpointNamespaceSchema>;
/** A stored part: its file's size and SHA-256, and the documents and bytes it holds. */
export type FinishedPart = z.infer<typeof FinishedPartSchema>;

// ---------------------------------------------------------------------------
// Fingerprint
// ---------------------------------------------------------------------------

/**
 * The fingerprint of the options that shape a backup. Pattern order does not
 * matter, so lists are sorted and deduplicated.
 */
export function backupFingerprint(
  options: Pick<BackupOptions, "include" | "exclude" | "query" | "retainDays">,
  compression: Compression,
  encryption: EncryptionPlan | undefined,
): BackupFingerprint {
  return {
    include: sortedUnique(options.include ?? []),
    exclude: sortedUnique(options.exclude ?? []),
    query: hashQuery(options.query),
    compression,
    encryption: {
      kind: encryption?.kind ?? "none",
      recipients:
        encryption?.kind === "passphrase" ? [] : sortedUnique(encryption?.recipients ?? []),
      kms:
        encryption?.kind === "kms"
          ? sortedUnique(encryption.kms.map((ref) => `${ref.provider}:${ref.key}`))
          : [],
    },
    retainDays: options.retainDays ?? null,
  };
}

/** The names of the fingerprint fields that differ, e.g. `["include", "encryption"]`. */
export function fingerprintDifferences(
  expected: BackupFingerprint,
  actual: BackupFingerprint,
): string[] {
  const fields = [
    "include",
    "exclude",
    "query",
    "compression",
    "encryption",
    "retainDays",
  ] as const;
  return fields.filter(
    (field) => JSON.stringify(expected[field]) !== JSON.stringify(actual[field]),
  );
}

/** SHA-256 of the query filters (sorted by namespace) as canonical Extended JSON. */
function hashQuery(query: BackupOptions["query"]): string | null {
  const namespaces = Object.keys(query ?? {}).sort();
  if (query === undefined || namespaces.length === 0) return null;
  const sorted: Document = {};
  for (const ns of namespaces) sorted[ns] = query[ns];
  const text = BSON.EJSON.stringify(sorted, { relaxed: false });
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

/**
 * Writes (or replaces) a backup's checkpoint.
 *
 * @throws MS_STORAGE_* from the adapter.
 */
export async function writeCheckpoint(
  storage: StorageAdapter,
  checkpoint: Checkpoint,
  signal: AbortSignal,
): Promise<void> {
  const body = Buffer.from(`${JSON.stringify(checkpoint, null, 2)}\n`, "utf8");
  await storage.put(checkpointKey(checkpoint.id), body, {
    contentType: "application/json",
    sizeHint: body.length,
    signal,
  });
}

/**
 * Reads a backup's checkpoint, or `undefined` when there is none.
 *
 * @throws MS_MANIFEST_INVALID when the checkpoint exists but is not valid.
 */
export async function readCheckpoint(
  storage: StorageAdapter,
  backupId: string,
  signal: AbortSignal | undefined,
): Promise<Checkpoint | undefined> {
  const key = checkpointKey(backupId);
  let text: string;
  try {
    const stream = await storage.get(key, signal === undefined ? {} : { signal });
    text = (await readStreamToBuffer(stream, { maxBytes: MAX_CHECKPOINT_BYTES })).toString("utf8");
  } catch (error) {
    if (isMongoShieldError(error, "MS_STORAGE_NOT_FOUND")) return undefined;
    throw error;
  }

  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (cause) {
    throw invalidCheckpoint(key, "it is not valid JSON", cause);
  }
  const parsed = CheckpointSchema.safeParse(json);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue === undefined ? "" : ` (${issue.path.join(".")}: ${issue.message})`;
    throw invalidCheckpoint(key, `it does not match the checkpoint format${where}`, parsed.error);
  }
  if (parsed.data.id !== backupId) {
    throw invalidCheckpoint(key, `it describes backup ${parsed.data.id}`, undefined);
  }
  return parsed.data;
}

function invalidCheckpoint(key: string, problem: string, cause: unknown): MongoShieldError {
  return new MongoShieldError(
    "MS_MANIFEST_INVALID",
    `The checkpoint ${key} is unusable: ${problem}.`,
    {
      cause,
      hint: "Start a new backup instead of resuming (delete the checkpoint, or let prune remove it).",
    },
  );
}

/** Deletes a backup's checkpoint (missing is fine). */
export async function deleteCheckpoint(
  storage: StorageAdapter,
  backupId: string,
  signal: AbortSignal,
): Promise<void> {
  await storage.delete([checkpointKey(backupId)], { signal });
}

/** Ids of every backup with a checkpoint, newest first (ids sort by start time). */
export async function listCheckpointIds(
  storage: StorageAdapter,
  signal: AbortSignal | undefined,
): Promise<string[]> {
  const ids: string[] = [];
  for await (const object of storage.list(
    CHECKPOINTS_PREFIX,
    signal === undefined ? {} : { signal },
  )) {
    const name = object.key.slice(CHECKPOINTS_PREFIX.length);
    if (!name.endsWith(".json")) continue;
    const id = name.slice(0, -".json".length);
    if (isBackupId(id)) ids.push(id);
  }
  return ids.sort().reverse();
}

// ---------------------------------------------------------------------------
// Checking what a checkpoint claims
// ---------------------------------------------------------------------------

/** One problem with the stored files a checkpoint relies on. */
export interface CheckpointFileProblem {
  /** Key relative to the backup directory. */
  readonly key: string;
  readonly problem: string;
}

/**
 * Checks with `head()` that every finished part and every metadata file still
 * exists with the recorded size, and that the key envelope (a few hundred bytes)
 * still has the recorded SHA-256. Returns the problems found (empty when fine).
 */
export async function checkCheckpointFiles(
  storage: StorageAdapter,
  checkpoint: Checkpoint,
  signal: AbortSignal | undefined,
): Promise<CheckpointFileProblem[]> {
  const problems: CheckpointFileProblem[] = [];
  const signalOption = signal === undefined ? {} : { signal };

  const expectSize = async (key: string, size: number): Promise<void> => {
    const info = await storage.head(resolveBackupKey(checkpoint.id, key), signalOption);
    if (info === undefined) problems.push({ key, problem: "the file is missing" });
    else if (info.size !== size) {
      problems.push({ key, problem: `its size is ${info.size} bytes, not the recorded ${size}` });
    }
  };

  for (const namespace of checkpoint.namespaces) {
    await expectSize(namespace.metadata.key, namespace.metadata.size);
    for (const part of namespace.parts) {
      if (part.done !== undefined) await expectSize(part.key, part.done.size);
    }
  }

  const keyFile = checkpoint.encryption?.keyFile;
  if (keyFile !== undefined) {
    try {
      const stream = await storage.get(resolveBackupKey(checkpoint.id, keyFile.key), signalOption);
      const bytes = await readStreamToBuffer(stream, { maxBytes: 1024 * 1024 });
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      if (sha256 !== keyFile.sha256) {
        problems.push({ key: keyFile.key, problem: "the key envelope was modified" });
      }
    } catch (error) {
      if (!isMongoShieldError(error, "MS_STORAGE_NOT_FOUND")) throw error;
      problems.push({ key: keyFile.key, problem: "the key envelope is missing" });
    }
  }
  return problems;
}
