/**
 * Reading what the upgrade compatibility analysis (upgrade-compat.ts) looks at out
 * of a stored backup:
 *
 *   metadata      every collection's, view's and time series' metadata file
 *                 (options, indexes, validator, pipeline): one small read each
 *   users, roles  the `admin.system.users` / `admin.system.roles` documents of
 *                 backups taken with users and roles (a few kilobytes)
 *   system.js     stored JavaScript functions, which backups keep as ordinary data
 *
 * Nothing else is read: documents of ordinary collections are never parsed here
 * (the live rehearsal is what looks at data). A metadata file that cannot be read
 * (damaged, tampered) is passed on as "unreadable" instead of failing the analysis;
 * the drill reports it as a finding about the backup as well.
 */

import { BSON, type Document } from "mongodb";
import { throwIfAborted } from "../errors.ts";
import { LOSSLESS_DESERIALIZE_OPTIONS } from "../format/bson-stream.ts";
import {
  collectionEntries,
  isAuthzEntry,
  type Manifest,
  type NamespaceEntry,
} from "../format/manifest.ts";
import { compileNamespaceFilter } from "../mongo/index.ts";
import type { NamespacePattern } from "../types.ts";
import { isBackupDefect, messageOf } from "./drill-checks.ts";
import { openDocumentStream, readMetadataFile, type StoredBackupSource } from "./read-pipeline.ts";
import type { BackedUpCollection, CompatibilityInput, StoredJavaScript } from "./upgrade-compat.ts";

/**
 * Most documents read from one `system.js` collection or one users/roles entry.
 * They are small, but a runaway collection must not fill memory during an analysis.
 */
export const MAX_DEFINITION_DOCUMENTS = 10_000;

/** Options of `loadCompatibilityInput`. */
export interface LoadCompatibilityOptions {
  /** Only analyse these namespaces (as in restore and drills). */
  readonly include?: readonly NamespacePattern[];
  readonly exclude?: readonly NamespacePattern[];
  readonly signal?: AbortSignal;
}

/** Reads a backup's definitions for `analyzeUpgradeCompatibility`. */
export async function loadCompatibilityInput(
  source: StoredBackupSource,
  manifest: Manifest,
  targetVersion: string,
  options: LoadCompatibilityOptions = {},
): Promise<CompatibilityInput> {
  const included = compileNamespaceFilter({ include: options.include, exclude: options.exclude });
  const collections: BackedUpCollection[] = [];
  const storedJavaScript: StoredJavaScript[] = [];
  const unreadable: { ns: string; reason: string }[] = [];

  for (const entry of collectionEntries(manifest.namespaces)) {
    if (!included(entry.ns)) continue;
    throwIfAborted(options.signal);
    try {
      const metadata = await readMetadataFile(source, entry.metadata, { signal: options.signal });
      collections.push({ ns: entry.ns, type: entry.type, metadata });
      if (entry.collection === "system.js") {
        storedJavaScript.push({
          ns: entry.ns,
          documents: await readDocuments(source, entry, options.signal),
        });
      }
    } catch (error) {
      if (!isBackupDefect(error)) throw error;
      unreadable.push({ ns: entry.ns, reason: messageOf(error) });
    }
  }

  // Users and roles are not namespaces a user includes or excludes: always analysed.
  const users: Document[] = [];
  const roles: Document[] = [];
  for (const entry of manifest.namespaces) {
    if (!isAuthzEntry(entry)) continue;
    try {
      (entry.type === "users" ? users : roles).push(
        ...(await readDocuments(source, entry, options.signal)),
      );
    } catch (error) {
      if (!isBackupDefect(error)) throw error;
      unreadable.push({ ns: entry.ns, reason: messageOf(error) });
    }
  }

  return {
    sourceVersion: manifest.source.serverVersion,
    targetVersion,
    collections,
    users,
    roles,
    storedJavaScript,
    unreadable,
  };
}

/** Parses up to MAX_DEFINITION_DOCUMENTS documents of an entry's data files. */
async function readDocuments(
  source: StoredBackupSource,
  entry: NamespaceEntry,
  signal: AbortSignal | undefined,
): Promise<Document[]> {
  const documents: Document[] = [];
  for (const file of entry.files) {
    for await (const bytes of openDocumentStream(source, file, { signal })) {
      if (documents.length >= MAX_DEFINITION_DOCUMENTS) return documents;
      // Lossless: stored functions keep their Code type, credentials their exact values.
      documents.push(BSON.deserialize(bytes as Buffer, LOSSLESS_DESERIALIZE_OPTIONS));
    }
  }
  return documents;
}
