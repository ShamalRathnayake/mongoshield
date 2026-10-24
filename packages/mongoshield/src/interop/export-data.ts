/**
 * Reading a stored backup back as plain mongodump data, for both export formats:
 * which namespaces to export, their metadata as mongodump JSON, and their documents
 * with every split part decrypted, decompressed and joined in order.
 *
 *   part 000 → integrity check → decrypt → decompress → split ┐
 *   part 001 → …                                              ├→ one stream of raw BSON documents
 *   part 002 → …                                              ┘
 *
 * All of the reading (checksums, decryption, passphrase key envelopes) is the read
 * pipeline restore and verify use (`src/engine/read-pipeline.ts`).
 */

import { BSON, Int32 } from "mongodb";
import {
  openDocumentStream,
  readMetadataFile,
  type StoredBackupSource,
} from "../engine/read-pipeline.ts";
import { MongoShieldError, throwIfAborted } from "../errors.ts";
import {
  type AuthzEntry,
  isAuthzEntry,
  type Manifest,
  type NamespaceEntry,
} from "../format/manifest.ts";
import { type CollectionMetadata, serializeCollectionMetadata } from "../format/metadata.ts";
import type { NamespaceFilter } from "../mongo/index.ts";
import { TIMESERIES_BUCKET_PREFIX } from "./archive-format.ts";
import type { SkippedNamespace } from "./import-target.ts";

/** One namespace to export, with its metadata ready to write. */
export interface ExportNamespace {
  readonly entry: NamespaceEntry;
  readonly metadata: CollectionMetadata;
  /** The metadata as mongodump's `<collection>.metadata.json` (canonical Extended JSON). */
  readonly metadataJson: string;
}

/** What was written for one namespace. */
export interface ExportedNamespace {
  readonly ns: string;
  readonly type: NamespaceEntry["type"];
  readonly documents: number;
  /** BSON bytes of the documents (before any gzip). */
  readonly bytes: number;
}

/** The namespaces of a backup to export, and the ones left out with the reason. */
export interface ExportSelection {
  /** Collections, views and time-series collections. */
  readonly entries: readonly NamespaceEntry[];
  /** The users and roles entries; their documents are filtered one by one. */
  readonly authz: readonly AuthzEntry[];
  readonly skipped: readonly SkippedNamespace[];
}

/**
 * Applies include/exclude to the collections. Users and roles entries are always
 * selected here; `loadUsersAndRoles` keeps the users and roles of the selected
 * databases, the rule restore uses.
 */
export function selectExportNamespaces(
  manifest: Manifest,
  filter: NamespaceFilter,
): ExportSelection {
  const entries: NamespaceEntry[] = [];
  const authz: AuthzEntry[] = [];
  for (const entry of manifest.namespaces) {
    if (isAuthzEntry(entry)) authz.push(entry);
    else if (filter(entry.ns)) entries.push(entry);
  }
  return { entries, authz, skipped: [] };
}

/**
 * Fails when patterns were given but select nothing at all (a typo, most likely),
 * rather than writing an empty dump.
 */
export function assertSomethingSelected(
  manifest: Manifest,
  selected: { readonly namespaces: number; readonly usersAndRoles: number },
  hasPatterns: boolean,
): void {
  if (!hasPatterns || selected.namespaces + selected.usersAndRoles > 0) return;
  throw new MongoShieldError(
    "MS_CONFIG_INVALID",
    "No namespace of the backup matches the filters.",
    {
      hint: `The backup holds: ${manifest.namespaces
        .slice(0, 20)
        .map((entry) => entry.ns)
        .join(", ")}.`,
    },
  );
}

/** Users and custom roles to export, as raw BSON documents (`admin.system.users` shape). */
export interface ExportedAuthz {
  readonly users: readonly Buffer[];
  readonly roles: readonly Buffer[];
}

/**
 * Reads the users and roles entries and keeps the documents of the databases the
 * patterns select: a user (role) of database D when `D.system.users`
 * (`D.system.roles`) is selected, like `restore({ usersAndRoles })` does.
 */
export async function loadUsersAndRoles(
  source: StoredBackupSource,
  entries: readonly AuthzEntry[],
  filter: NamespaceFilter,
  signal: AbortSignal,
): Promise<ExportedAuthz> {
  const users: Buffer[] = [];
  const roles: Buffer[] = [];
  for (const entry of entries) {
    let count = 0;
    for await (const document of documentsOf(source, entry, signal)) {
      count += 1;
      const database: unknown = BSON.deserialize(document).db;
      if (typeof database !== "string") continue;
      if (!filter(`${database}.system.${entry.type}`)) continue;
      (entry.type === "users" ? users : roles).push(document);
    }
    assertDocumentCount(entry, count);
  }
  return { users, roles };
}

/** Database of a raw user or role document (validated by `loadUsersAndRoles`). */
export function authzDatabase(document: Buffer): string {
  const database: unknown = BSON.deserialize(document).db;
  return typeof database === "string" ? database : "";
}

/**
 * The auth schema version document mongorestore reads before restoring users
 * (`authSchema` 5: SCRAM-SHA-1 and SCRAM-SHA-256 credentials, MongoDB 4.0+). mongodump
 * writes `admin.system.version`; without it, mongorestore assumes a 2.4-era dump and
 * refuses to restore users into a current server.
 */
export const AUTH_SCHEMA_DOCUMENT: Buffer = Buffer.from(
  BSON.serialize({ _id: "authSchema", currentVersion: new Int32(5) }),
);

/**
 * The collection a namespace's documents go to in mongodump output: its own name,
 * or `system.buckets.<name>` for a time-series collection, whose buckets the export
 * computes from the measurements (timeseries-buckets.ts).
 */
export function dumpDataCollection(entry: NamespaceEntry): string {
  return entry.type === "timeseries"
    ? `${TIMESERIES_BUCKET_PREFIX}${entry.collection}`
    : entry.collection;
}

/** Reads (and checks) a namespace's metadata file and renders it as mongodump JSON. */
export async function loadExportNamespace(
  source: StoredBackupSource,
  entry: NamespaceEntry,
  signal: AbortSignal,
): Promise<ExportNamespace> {
  const metadata = await readMetadataFile(source, entry.metadata, { signal });
  // The manifest's names are authoritative (metadata only repeats the collection name).
  const corrected: CollectionMetadata = { ...metadata, collectionName: entry.collection };
  return { entry, metadata: corrected, metadataJson: serializeCollectionMetadata(corrected) };
}

/**
 * Every document of a namespace, part after part, as raw BSON Buffers. Each part's
 * size and checksum are verified as it is read (see `openDocumentStream`).
 */
export async function* documentsOf(
  source: StoredBackupSource,
  entry: NamespaceEntry,
  signal: AbortSignal,
): AsyncGenerator<Buffer> {
  for (const file of entry.files) {
    throwIfAborted(signal);
    for await (const document of openDocumentStream(source, file, { signal })) {
      yield document as Buffer;
    }
  }
}

/**
 * Fails when fewer or more documents were read than the manifest recorded, so an
 * export never silently differs from the backup.
 */
export function assertDocumentCount(entry: NamespaceEntry, documents: number): void {
  if (documents === entry.documents) return;
  throw new MongoShieldError(
    "MS_INTEGRITY_FAILED",
    `${entry.ns} has ${documents} documents in its data files, but the manifest records ${entry.documents}.`,
    { hint: "The backup is damaged. Run `mongoshield verify --deep` on it." },
  );
}

/**
 * The server version for mongodump's prelude, which mongorestore parses as
 * `major.minor.patch` (mongo-tools `common/db/version.go`, `StrToVersion`). Returns
 * undefined when the backup's version is not in that form.
 */
export function dumpServerVersion(manifest: Manifest): string | undefined {
  const version = manifest.source.serverVersion;
  return /^\d+\.\d+\.\d+([-+].*)?$/.test(version) ? version : undefined;
}
