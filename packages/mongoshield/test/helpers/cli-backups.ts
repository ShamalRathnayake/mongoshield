/**
 * Backups in a named in-memory store, for CLI tests that need no database.
 *
 *   const { url, storage } = await namedMemoryStore();
 *   const manifest = await writeTestBackup(storage, { namespaces: [...] });
 *   const run = await runTestCli(["list", "--from", url]);
 *
 * `memory://<name>` resolves to the same process-wide store every time, so a test
 * can fill the store directly and then point the CLI at it with `--from`.
 */

import { randomBytes } from "node:crypto";
import type { DrillRecord } from "../../src/catalog/annotations.ts";
import { type BackupShapeInput, withShapeLabel } from "../../src/engine/backup-guard.ts";
import { backupDir, manifestKey, newBackupId } from "../../src/format/layout.ts";
import type { Manifest } from "../../src/format/manifest.ts";
import { serializeManifest } from "../../src/format/manifest-io.ts";
import { resolveStorage } from "../../src/storage/resolve.ts";
import type { StorageAdapter } from "../../src/storage/types.ts";

/** A fresh, uniquely named in-memory store and the URL that reaches it. */
export async function namedMemoryStore(): Promise<{ url: string; storage: StorageAdapter }> {
  const url = `memory://cli-${randomBytes(6).toString("hex")}`;
  return { url, storage: await resolveStorage(url) };
}

/**
 * The labels `mongoshield backup` (and the scheduler) give a backup of `selection`:
 * the `mongoshield.shape` label that `mongoshield prune` scopes by. Pass them to
 * `writeTestBackup` so a fixture belongs to the default prune scope.
 */
export function cliBackupLabels(selection: BackupShapeInput = {}): Record<string, string> {
  return withShapeLabel(undefined, selection);
}

/** Overwrites a backup's manifest with `changes` applied (manifests are normally write-once). */
export async function rewriteManifest(
  storage: StorageAdapter,
  manifest: Manifest,
  changes: Partial<Manifest>,
): Promise<Manifest> {
  const changed = { ...manifest, ...changes };
  const body = Buffer.from(serializeManifest(changed), "utf8");
  await storage.put(manifestKey(manifest.id), body, { contentType: "application/json" });
  return changed;
}

/** A backup directory with a data file but no manifest: a crashed or running backup. */
export async function writeIncompleteBackup(
  storage: StorageAdapter,
  startedAt: Date,
): Promise<string> {
  const id = newBackupId(startedAt);
  await storage.put(`${backupDir(id)}app/users.bson.zst`, Buffer.from("partial"), {});
  return id;
}

/** A backup directory whose manifest cannot be parsed. */
export async function writeInvalidBackup(
  storage: StorageAdapter,
  startedAt: Date,
): Promise<string> {
  const id = newBackupId(startedAt);
  await storage.put(manifestKey(id), Buffer.from("{ not json"), {});
  return id;
}

/** Stores a drill record, as `mongoshield drill` does after each drill. */
export async function writeDrillRecord(
  storage: StorageAdapter,
  record: Omit<DrillRecord, "tool">,
): Promise<void> {
  const stamp = record.drilledAt.replaceAll(":", "-").replace(".", "-");
  const body = Buffer.from(JSON.stringify({ ...record, tool: "mongoshield@test" }), "utf8");
  await storage.put(`annotations/${record.backupId}/drills/${stamp}.json`, body, {});
}
