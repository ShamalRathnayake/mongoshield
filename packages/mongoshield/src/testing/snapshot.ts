/**
 * Database snapshots for integration tests: capture the state of some databases
 * once, then put it back before every test.
 *
 *   snapshot   discover namespaces → backup engine (no compression, no encryption,
 *              consistency "none") into in-memory storage → fingerprint each namespace
 *   restore    drop namespaces created since the snapshot → compare fingerprints →
 *              keep unchanged namespaces, reload the documents of collections whose
 *              data changed, recreate the rest with the restore engine ("drop" mode)
 *              (see reset.ts for the fingerprints and the decision)
 *
 * It reuses the real backup and restore engines, so a reset recreates validators,
 * collations, capped and time series collections, views and indexes exactly; the
 * settings are only tuned for speed. Snapshots live in memory by default and are
 * thrown away with `dispose()`.
 *
 * This is for test databases: `restore()` drops collections. It refuses to snapshot
 * MongoDB's own databases (admin, config, local).
 */

import type { MongoClient } from "mongodb";
import { runBackup } from "../engine/backup.ts";
import { sourceFromManifest } from "../engine/read-pipeline.ts";
import { runRestore } from "../engine/restore.ts";
import { MongoShieldError } from "../errors.ts";
import { resolveBackupKey } from "../format/layout.ts";
import type { Manifest } from "../format/manifest.ts";
import { readManifest } from "../format/manifest-io.ts";
import { type Logger, silentLogger } from "../logger.ts";
import {
  compileNamespaceFilter,
  discoverNamespaces,
  type NamespaceFilter,
} from "../mongo/index.ts";
import { memoryStorage } from "../storage/memory.ts";
import type { StorageAdapter } from "../storage/types.ts";
import type { NamespacePattern } from "../types.ts";
import { fingerprintNamespaces, planReset, reloadDocuments } from "./reset.ts";

/** Options for `createDatabaseSnapshot`. Give `databases`, `include`, or both. */
export interface DatabaseSnapshotOptions {
  /** Whole databases to snapshot, e.g. `["app_test"]`. */
  readonly databases?: readonly string[];
  /** Namespace patterns to snapshot, e.g. `["app_test.*", "shared.settings"]`. */
  readonly include?: readonly NamespacePattern[];
  /** Namespaces to leave alone (neither captured nor dropped on restore). */
  readonly exclude?: readonly NamespacePattern[];
  /** Where the snapshot is kept. Defaults to a private in-memory store. */
  readonly storage?: StorageAdapter;
  /** Collections restored at the same time. Defaults to 8. */
  readonly parallelism?: number;
  readonly logger?: Logger;
}

/** A captured database state. */
export interface DatabaseSnapshot {
  /** Namespaces captured (collections, time series and views), sorted. */
  readonly namespaces: readonly string[];
  /**
   * Puts the snapshotted namespaces back exactly as captured, and drops namespaces
   * matching the snapshot's databases/patterns that were created after it.
   */
  restore(): Promise<void>;
  /** Deletes the snapshot's data. The snapshot cannot be restored afterwards. */
  dispose(): Promise<void>;
}

/** MongoDB's own databases: never snapshotted or dropped. */
const INTERNAL_DATABASES = new Set(["admin", "config", "local"]);

/**
 * Restoring many small collections is latency-bound (create, insert, index builds
 * are separate round trips), so more collections at once than a production restore.
 */
const DEFAULT_PARALLELISM = 8;

/**
 * Captures the current state of the selected databases/namespaces.
 *
 * @throws MongoShieldError `MS_CONFIG_INVALID` when neither `databases` nor `include`
 *   is given, or they name an internal database; errors of the backup engine.
 */
export async function createDatabaseSnapshot(
  client: MongoClient,
  options: DatabaseSnapshotOptions,
): Promise<DatabaseSnapshot> {
  const include = includePatterns(options);
  const exclude = options.exclude ?? [];
  const filter = compileNamespaceFilter({ include, exclude });
  const storage = options.storage ?? memoryStorage({ name: "mongoshield-snapshot" });
  const logger = options.logger ?? silentLogger;

  const specs = await discoverNamespaces(client, { include, exclude, logger });
  const namespaces = specs.map((spec) => spec.ns);
  const parallelism = options.parallelism ?? DEFAULT_PARALLELISM;
  // An empty selection is a valid snapshot ("no collections"): restoring it only drops.
  let manifest: Manifest | undefined;
  if (namespaces.length > 0) {
    const result = await runBackup(
      { client, storage, logger, compression: "none", encryption: undefined },
      { include, exclude, consistency: "none", parallelism },
    );
    manifest = await readManifest(storage, result.id);
    if (manifest === undefined) {
      throw new MongoShieldError(
        "MS_INTERNAL",
        `The snapshot backup ${result.id} has no manifest.`,
      );
    }
  }
  // What the namespaces look like now; restore() compares against it (see reset.ts).
  let reference = await fingerprintNamespaces(client, namespaces);

  let disposed = false;
  return {
    namespaces,
    async restore() {
      if (disposed) {
        throw new MongoShieldError("MS_CONFIG_INVALID", "This snapshot was disposed.", {
          hint: "Take a new snapshot with createDatabaseSnapshot().",
        });
      }
      await dropNamespacesCreatedSince(client, filter, new Set(namespaces));
      if (manifest === undefined) return;

      const current = await fingerprintNamespaces(client, namespaces);
      const plan = planReset(namespaces, reference, current);
      const reload = manifest.namespaces.filter((entry) => plan.get(entry.ns) === "reload");
      const recreate = namespaces.filter((ns) => plan.get(ns) === "recreate");
      if (reload.length > 0) {
        const source = sourceFromManifest(storage, manifest, undefined);
        await reloadDocuments({ client, source, entries: reload, parallelism });
      }
      if (recreate.length > 0) {
        await runRestore(
          { client, storage, logger },
          // Namespace names used as patterns: each matches exactly itself.
          { backup: manifest.id, include: recreate, mode: "drop", parallelism },
        );
      }
      // The restored namespaces are the snapshot again: their fingerprints become the
      // reference, so the next reset can skip them unless a test changes them.
      const touched = [...reload.map((entry) => entry.ns), ...recreate];
      if (touched.length > 0) {
        const refreshed = await fingerprintNamespaces(client, touched);
        reference = new Map([...reference, ...refreshed]);
      }
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      if (manifest !== undefined) await deleteBackup(storage, manifest.id);
    },
  };
}

/** `databases` become `<db>.*` patterns; at least one database or pattern is required. */
function includePatterns(options: DatabaseSnapshotOptions): NamespacePattern[] {
  const patterns = [
    ...(options.databases ?? []).map((database) => `${database}.*`),
    ...(options.include ?? []),
  ];
  if (patterns.length === 0) {
    throw new MongoShieldError("MS_CONFIG_INVALID", "Which databases should be snapshotted?", {
      hint: 'Pass `databases: ["app_test"]` or `include: ["app_test.*"]`.',
    });
  }
  for (const database of options.databases ?? []) {
    if (INTERNAL_DATABASES.has(database)) {
      throw new MongoShieldError(
        "MS_CONFIG_INVALID",
        `The ${database} database belongs to MongoDB itself and cannot be snapshotted.`,
        { hint: "Snapshot your application's test databases instead." },
      );
    }
  }
  return patterns;
}

/**
 * Drops every namespace that matches the snapshot's patterns but was not captured:
 * collections and views a test created. Views go first, because a view may read
 * from a collection that is dropped too.
 */
async function dropNamespacesCreatedSince(
  client: MongoClient,
  filter: NamespaceFilter,
  captured: ReadonlySet<string>,
): Promise<void> {
  const databases = await client.db("admin").admin().listDatabases({ nameOnly: true });
  for (const { name: database } of databases.databases) {
    if (INTERNAL_DATABASES.has(database)) continue;
    const infos = await client
      .db(database)
      .listCollections({}, { nameOnly: true, authorizedCollections: true })
      .toArray();
    const extra = infos
      .filter((info) => !info.name.startsWith("system."))
      .filter((info) => {
        const ns = `${database}.${info.name}`;
        return filter(ns) && !captured.has(ns);
      })
      .sort((left, right) => Number(right.type === "view") - Number(left.type === "view"));
    for (const info of extra) await client.db(database).dropCollection(info.name);
  }
}

/** Removes every stored object of the snapshot's backup. */
async function deleteBackup(storage: StorageAdapter, backupId: string): Promise<void> {
  const prefix = resolveBackupKey(backupId, "");
  const keys: string[] = [];
  for await (const object of storage.list(prefix)) keys.push(object.key);
  if (keys.length > 0) await storage.delete(keys);
}
