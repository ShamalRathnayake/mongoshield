/**
 * Test-only helpers for the catalog tests: build backup ids and manifests, and
 * put complete, incomplete and invalid backups into a storage adapter.
 * Not exported from the package.
 */

import {
  CHECKPOINT_FORMAT_VERSION,
  type Checkpoint,
  writeCheckpoint,
} from "../engine/backup-checkpoint.ts";
import { backupIdToDate, manifestKey, resolveBackupKey } from "../format/layout.ts";
import {
  type IncrementalManifest,
  isIncrementalManifest,
  type Manifest,
} from "../format/manifest.ts";
import { writeManifest } from "../format/manifest-io.ts";
import type { StorageAdapter } from "../storage/types.ts";

/** Backup id for an ISO time, e.g. `idAt("2026-10-20T03:00:00Z")` → `2026-10-20T03-00-00Z_000000`. */
export function idAt(isoTime: string, suffix = "000000"): string {
  const seconds = new Date(isoTime).toISOString().slice(0, 19).replaceAll(":", "-");
  return `${seconds}Z_${suffix}`;
}

/** A minimal valid manifest. `completedAt` defaults to one minute after the start. */
export function makeManifest(id: string, overrides: Partial<Manifest> = {}): Manifest {
  const startedAt = backupIdToDate(id);
  return {
    formatVersion: 1,
    id,
    tool: "mongoshield@test",
    status: "complete",
    startedAt: startedAt.toISOString(),
    completedAt: new Date(startedAt.getTime() + 60_000).toISOString(),
    source: { topology: "standalone", serverVersion: "8.0.0" },
    consistency: { mode: "none" },
    compression: "none",
    encryption: null,
    labels: {},
    namespaces: [],
    totals: { namespaces: 0, documents: 0, bytesRaw: 0, bytesStored: 0 },
    ...overrides,
  };
}

/** The deployment id the chain fixtures share. */
export const CHAIN_CLUSTER_ID = "c0ffee";

/**
 * A full backup a chain can start from: consistency converge, ending at cluster time
 * `{ t: endSeconds, i: 1 }`, with the recorded selection of `app.*`.
 */
export function makeChainBase(
  id: string,
  endSeconds: number,
  overrides: Partial<Manifest> = {},
): Manifest {
  return makeManifest(id, {
    source: { topology: "replicaSet", serverVersion: "8.0.0", clusterId: CHAIN_CLUSTER_ID },
    consistency: {
      mode: "converge",
      from: { t: endSeconds - 5, i: 1 },
      to: { t: endSeconds, i: 1 },
    },
    selection: { include: ["app.*"], exclude: [], query: [] },
    ...overrides,
  });
}

/**
 * An incremental backup continuing `parent`: its window starts at the parent's end and
 * ends at `{ t: endSeconds, i: 1 }`.
 */
export function makeIncremental(
  id: string,
  parent: Manifest,
  endSeconds: number,
  overrides: Partial<Manifest> = {},
): IncrementalManifest {
  const from = parent.consistency.to ?? { t: 0, i: 0 };
  const chain = isIncrementalManifest(parent)
    ? { base: parent.chain.base, parent: parent.id, length: parent.chain.length + 1 }
    : { base: parent.id, parent: parent.id, length: 1 };
  const manifest = makeManifest(id, {
    formatVersion: 2,
    kind: "incremental",
    chain,
    source: { topology: "replicaSet", serverVersion: "8.0.0", clusterId: CHAIN_CLUSTER_ID },
    consistency: { mode: "converge", from, to: { t: endSeconds, i: 1 } },
    selection: { include: ["app.*"], exclude: [], query: [] },
    changes: { key: "_changes/window.bson", size: 0, sha256: "0".repeat(64), events: 0 },
    ...overrides,
  });
  if (!isIncrementalManifest(manifest)) throw new Error("fixture is not an incremental");
  return manifest;
}

/** Writes a data file and then a valid manifest, like a successful backup run. */
export async function putCompleteBackup(
  storage: StorageAdapter,
  id: string,
  overrides: Partial<Manifest> = {},
): Promise<void> {
  await storage.put(resolveBackupKey(id, "app/users.bson"), Buffer.from("data"));
  await writeManifest(storage, makeManifest(id, overrides));
}

/** Writes a data file without a manifest, like a crashed or still-running backup. */
export async function putIncompleteBackup(storage: StorageAdapter, id: string): Promise<void> {
  await storage.put(resolveBackupKey(id, "app/users.bson"), Buffer.from("partial"));
}

/** Writes a data file and an unparseable manifest. */
export async function putInvalidBackup(
  storage: StorageAdapter,
  id: string,
  manifestText = "{ not json",
): Promise<void> {
  await storage.put(resolveBackupKey(id, "app/users.bson"), Buffer.from("data"));
  await storage.put(manifestKey(id), Buffer.from(manifestText));
}

/**
 * Writes the checkpoint of a resumable run (no parts finished), recording where the
 * run comes from as a real checkpoint does: its labels and source `clusterId`.
 * Pair it with `putIncompleteBackup` for a checkpointed run between two invocations.
 */
export async function putCheckpoint(
  storage: StorageAdapter,
  id: string,
  origin: { readonly clusterId?: string; readonly labels?: Record<string, string> } = {},
): Promise<void> {
  const startedAt = backupIdToDate(id).toISOString();
  const checkpoint: Checkpoint = {
    formatVersion: CHECKPOINT_FORMAT_VERSION,
    id,
    tool: "mongoshield@test",
    startedAt,
    updatedAt: startedAt,
    invocations: 1,
    fingerprint: {
      include: [],
      exclude: [],
      query: null,
      compression: "none",
      encryption: { kind: "none", recipients: [], kms: [] },
      retainDays: null,
    },
    labels: { ...origin.labels },
    source: {
      topology: "replicaSet",
      serverVersion: "8.0.0",
      ...(origin.clusterId === undefined ? {} : { clusterId: origin.clusterId }),
    },
    encryption: null,
    namespaces: [],
  };
  await writeCheckpoint(storage, checkpoint, new AbortController().signal);
}
