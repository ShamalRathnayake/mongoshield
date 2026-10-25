/**
 * Building the manifest of a finished backup run. The manifest is the commit
 * marker (written last by `runBackup`), so it must describe exactly what was
 * stored; every field is documented in docs/specs/FORMAT.md.
 */

import type {
  ChainInfo,
  ClusterTime,
  Compression,
  ConsistencyMode,
  Selection,
} from "../format/manifest.ts";
import {
  FULL_BACKUP_FORMAT_VERSION,
  INCREMENTAL_BACKUP_FORMAT_VERSION,
  type Manifest,
  type NamespaceEntry,
} from "../format/manifest.ts";
import type { DeploymentInfo } from "../mongo/index.ts";
import { version } from "../version.ts";
import type { FileEncryption } from "./backup-key.ts";
import type { CapturedWindow } from "./converge-capture.ts";

/** Everything a manifest is built from. */
export interface ManifestInput {
  readonly id: string;
  readonly startedAt: Date;
  readonly completedAt: Date;
  readonly deployment: DeploymentInfo;
  readonly consistency: {
    readonly mode: ConsistencyMode;
    /** The snapshot's cluster time, for `snapshot` mode. */
    readonly clusterTime: ClusterTime | undefined;
    /** The captured change window, for `converge` mode. */
    readonly window?: CapturedWindow | undefined;
    /** Why the mode is weaker than requested (`auto` falling back to `none`). */
    readonly warning?: string | undefined;
  };
  readonly compression: Compression;
  readonly encryption: FileEncryption | undefined;
  readonly labels: Readonly<Record<string, string>> | undefined;
  /** Entries in manifest order (sorted by namespace). */
  readonly namespaces: readonly NamespaceEntry[];
  /** End of write-once retention (`retainDays`), recorded as `immutableUntil`. */
  readonly immutableUntil?: Date | undefined;
  /** The include/exclude selection, recorded so incrementals can continue the backup. */
  readonly selection?: Selection | undefined;
  /**
   * Incremental backups only (backup-incremental.ts): their place in the chain. Makes
   * the manifest `kind: "incremental"`, format version 2. The window's `from` must
   * then be the parent's end time.
   */
  readonly chain?: ChainInfo | undefined;
}

/**
 * The selection a backup records (see `SelectionSchema`): patterns sorted, so two
 * backups of the same selection given in a different order compare equal.
 */
export function selectionOf(options: {
  readonly include?: readonly string[] | undefined;
  readonly exclude?: readonly string[] | undefined;
  readonly query?: Readonly<Record<string, unknown>> | undefined;
}): Selection {
  return {
    include: [...(options.include ?? [])].sort(),
    exclude: [...(options.exclude ?? [])].sort(),
    query: Object.keys(options.query ?? {}).sort(),
  };
}

/** Assembles the manifest. It is validated against the schema when written. */
export function buildManifest(input: ManifestInput): Manifest {
  const incremental = input.chain !== undefined;
  return {
    // Full backups stay at version 1, readable by every 2.x release; incrementals need
    // a reader that knows chains (see MANIFEST_FORMAT_VERSION).
    formatVersion: incremental ? INCREMENTAL_BACKUP_FORMAT_VERSION : FULL_BACKUP_FORMAT_VERSION,
    ...(incremental ? { kind: "incremental" as const, chain: input.chain } : {}),
    id: input.id,
    // Which program wrote the backup, so readers can work around known bugs of old writers.
    tool: `mongoshield@${version}`,
    status: "complete",
    startedAt: input.startedAt.toISOString(),
    completedAt: input.completedAt.toISOString(),
    source: {
      topology: input.deployment.topology,
      serverVersion: input.deployment.serverVersion,
      // A hash of the replica set name / hosts, never a URI: safe to store.
      clusterId: input.deployment.clusterId,
    },
    consistency: buildConsistency(input.consistency),
    compression: input.compression,
    encryption: buildEncryption(input.encryption),
    labels: { ...input.labels },
    ...(input.selection === undefined ? {} : { selection: input.selection }),
    namespaces: [...input.namespaces],
    ...(input.consistency.window === undefined ? {} : { changes: input.consistency.window.file }),
    ...(input.immutableUntil === undefined
      ? {}
      : { immutableUntil: input.immutableUntil.toISOString() }),
    totals: computeTotals(input.namespaces, input.consistency.window?.file.size ?? 0),
  };
}

/**
 * `null` for unencrypted backups. Passphrase backups also point at their key
 * envelope (`keyFile`), which readers must unlock first.
 */
function buildEncryption(encryption: FileEncryption | undefined): Manifest["encryption"] {
  if (encryption === undefined) return null;
  return {
    scheme: "age-v1",
    recipients: [...encryption.manifestRecipients],
    ...(encryption.keyFile === undefined ? {} : { keyFile: encryption.keyFile }),
  };
}

/**
 * `from`/`to` bound the cluster times the data reflects. A snapshot reflects a single
 * instant, so both are the snapshot's time. A converge backup is restored as of `to`
 * (T1) by replaying the changes from `from` (T0). Plain reads have no such bound.
 */
function buildConsistency(consistency: ManifestInput["consistency"]): Manifest["consistency"] {
  const { mode, clusterTime, window } = consistency;
  const warnings = [
    ...(consistency.warning === undefined ? [] : [consistency.warning]),
    ...(window?.warnings ?? []),
  ];
  const warning = warnings.length === 0 ? {} : { warning: warnings.join(" ") };
  if (mode === "snapshot" && clusterTime !== undefined) {
    return { mode, from: clusterTime, to: clusterTime, ...warning };
  }
  if (mode === "converge" && window !== undefined) {
    return { mode, from: window.from, to: window.to, ...warning };
  }
  return { mode, ...warning };
}

/**
 * Sums over all namespaces. `bytesStored` counts every data part and metadata file
 * plus a converge backup's changes file (`changesBytes`), but neither the manifest
 * nor a key envelope (see FORMAT.md).
 */
function computeTotals(
  namespaces: readonly NamespaceEntry[],
  changesBytes: number,
): Manifest["totals"] {
  let documents = 0;
  let bytesRaw = 0;
  let bytesStored = changesBytes;
  for (const entry of namespaces) {
    documents += entry.documents;
    bytesRaw += entry.bytesRaw;
    bytesStored += entry.metadata.size;
    for (const file of entry.files) bytesStored += file.size;
  }
  return { namespaces: namespaces.length, documents, bytesRaw, bytesStored };
}
