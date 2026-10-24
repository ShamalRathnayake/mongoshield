/**
 * Test-only helpers for the catalog tests: build backup ids and manifests, and
 * put complete, incomplete and invalid backups into a storage adapter.
 * Not exported from the package.
 */

import { backupIdToDate, manifestKey, resolveBackupKey } from "../format/layout.ts";
import type { Manifest } from "../format/manifest.ts";
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
