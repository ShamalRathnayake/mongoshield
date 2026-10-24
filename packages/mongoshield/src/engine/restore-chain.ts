/**
 * The change windows a restore replays, as one ordered stream of events.
 *
 * A converge backup has one window: the changes made while it ran (`consistency.from`
 * to `.to`). Restoring an incremental backup adds one window per incremental of its
 * chain, each the changes after the previous member's end up to its own
 * (docs/specs/FORMAT.md, "Incremental backups"):
 *
 *   base full        window 0: (T0, T1]          its own converge window, if any
 *   incremental 1    window 1: (T1, T2]
 *   incremental 2    window 2: (T2, T3]          … cut at `at` for a point-in-time restore
 *
 * The windows are back to back, so read one after the other they are a single stream
 * in cluster-time order, and the converge replay (converge-replay.ts) applies it as it
 * would one window: the documents are loaded first, every event is replayed in order,
 * and the indexes are built last. Each window is read through its own backup's source,
 * because every backup of a chain is encrypted on its own (its own key envelope for
 * passphrase and KMS backups).
 *
 * The read-side features (find, history, diff, export, tenant restore) open an
 * incremental the same way (`openReadableBackup`): the base backup's documents with the
 * chain's windows overlaid (find-window.ts).
 */

import type { CatalogEntry } from "../catalog/catalog.ts";
import { resolveChain } from "../catalog/chain.ts";
import { MongoShieldError, throwIfAborted } from "../errors.ts";
import {
  type ChangesFile,
  type ClusterTime,
  type CollectionEntry,
  collectionEntries,
  type IncrementalManifest,
  isIncrementalManifest,
  type Manifest,
  type StoredFile,
} from "../format/manifest.ts";
import type { StorageAdapter } from "../storage/types.ts";
import type { DecryptionOptions } from "../types.ts";
import { readChangeEvents, type StoredChangeEvent } from "./converge-events.ts";
import { eventsUntil } from "./converge-targets.ts";
import { compareClusterTimes } from "./converge-time.ts";
import { openBackupSource, type StoredBackupSource } from "./read-pipeline.ts";
import { planningEntries } from "./restore-plan.ts";

/** Progress label of a replay that includes incremental backups. */
export const CHAIN_PROGRESS_LABEL = "(changes since the base backup)";

/** One window of changes: a backup's changes file, read through that backup's source. */
export interface ChangeWindowSource {
  /** The backup the file belongs to (for messages and verify-first). */
  readonly backupId: string;
  readonly source: StoredBackupSource;
  readonly file: ChangesFile;
  /** Events after this cluster time are not replayed (`consistency.to`, or `at`). */
  readonly until: ClusterTime | undefined;
}

/**
 * Opens the change windows of a chain's incrementals, oldest first. Each backup's keys
 * are checked (and a key envelope unlocked) now, before anything is written.
 *
 * @param until a point-in-time bound for the last window (`at`), if any
 * @throws MongoShieldError key errors from `openBackupSource`.
 */
export async function openIncrementalWindows(
  storage: StorageAdapter,
  incrementals: readonly IncrementalManifest[],
  options: {
    readonly decryption: DecryptionOptions | undefined;
    readonly until: ClusterTime | undefined;
    readonly signal: AbortSignal | undefined;
    /** Sources already opened, by backup id (a restore opens each backup once). */
    readonly sources?: ReadonlyMap<string, StoredBackupSource> | undefined;
  },
): Promise<ChangeWindowSource[]> {
  const windows: ChangeWindowSource[] = [];
  for (const incremental of incrementals) {
    throwIfAborted(options.signal);
    const source =
      options.sources?.get(incremental.id) ??
      (await openBackupSource(storage, incremental, options.decryption, {
        signal: options.signal,
      }));
    windows.push({
      backupId: incremental.id,
      source,
      file: incremental.changes,
      until: earlierOf(incremental.consistency.to, options.until),
    });
  }
  return windows;
}

/** An incremental backup opened for reading: which one, and the windows of its chain. */
export interface OpenedChain {
  /** The selected incremental backup. */
  readonly backupId: string;
  /** The incrementals' windows, oldest first (the base's own window is not included). */
  readonly windows: readonly ChangeWindowSource[];
  /**
   * The selected incremental, opened: it holds the chain's newest metadata and full
   * copies of its time series collections (FORMAT.md, "Incremental backups").
   */
  readonly state: { readonly manifest: IncrementalManifest; readonly source: StoredBackupSource };
}

/** Where one namespace of a readable backup is read from. */
export interface NamespaceReading {
  readonly manifest: Manifest;
  readonly entry: CollectionEntry;
  readonly source: StoredBackupSource;
  /** The chain's windows to overlay; absent for a time series copy (events skip them). */
  readonly chain?: OpenedChain | undefined;
}

/** A backup opened for reading documents, through its chain for an incremental. */
export interface ReadableBackup {
  /**
   * The backup holding the documents: the selected one, or its chain's base with the
   * namespaces as of the selected incremental (the base's collections, the
   * incremental's views and time series copies; see `planningEntries`).
   */
  readonly manifest: Manifest;
  readonly source: StoredBackupSource;
  /** Set when an incremental was selected. */
  readonly chain?: OpenedChain | undefined;
}

/**
 * Opens `selected` for reading its documents. A full backup is opened as it is; an
 * incremental as its chain's base with the incrementals' windows (see the file header).
 *
 * @throws MongoShieldError from `resolveChain` for a broken chain, key errors from
 *   `openBackupSource`.
 */
export async function openReadableBackup(
  storage: StorageAdapter,
  entries: readonly CatalogEntry[],
  selected: Manifest,
  options: {
    readonly decryption: DecryptionOptions | undefined;
    readonly signal: AbortSignal | undefined;
  },
): Promise<ReadableBackup> {
  if (!isIncrementalManifest(selected)) {
    const source = await openBackupSource(storage, selected, options.decryption, {
      signal: options.signal,
    });
    return { manifest: selected, source };
  }
  const chain = resolveChain(entries, selected);
  const source = await openBackupSource(storage, chain.base, options.decryption, {
    signal: options.signal,
  });
  const windows = await openIncrementalWindows(storage, chain.incrementals, {
    decryption: options.decryption,
    until: undefined,
    signal: options.signal,
  });
  const newest = windows.at(-1);
  if (newest === undefined) {
    throw new MongoShieldError("MS_INTERNAL", `Incremental ${selected.id} has no window.`);
  }
  return {
    manifest: { ...chain.base, namespaces: [...planningEntries(chain.base, selected).entries] },
    source,
    chain: { backupId: selected.id, windows, state: { manifest: selected, source: newest.source } },
  };
}

/**
 * The time series copy an incremental holds of `namespace` (change events do not carry
 * time series writes, so a chain's newest copy is the one to read), or undefined.
 */
export function timeSeriesCopy(
  chain: OpenedChain | undefined,
  namespace: string,
): CollectionEntry | undefined {
  return collectionEntries(chain?.state.manifest.namespaces ?? []).find(
    (entry) => entry.ns === namespace && entry.type === "timeseries" && entry.content === "full",
  );
}

/**
 * Where to read `entry` (an entry of a readable backup): the base with the chain's
 * windows overlaid, or for a time series the state member's copy as it is (change
 * events do not carry time series writes, so there is nothing to overlay).
 */
export function namespaceReading(
  readable: ReadableBackup,
  entry: CollectionEntry,
): NamespaceReading {
  const chain = readable.chain;
  if (chain === undefined) return { manifest: readable.manifest, entry, source: readable.source };
  const copy = entry.type === "timeseries" ? timeSeriesCopy(chain, entry.ns) : undefined;
  if (copy === undefined) {
    return { manifest: readable.manifest, entry, source: readable.source, chain };
  }
  const { changes: _changes, ...withoutWindow } = chain.state.manifest;
  return { manifest: withoutWindow, entry: copy, source: chain.state.source };
}

/**
 * The metadata file of a readable backup's entry and the source to read it with: for a
 * chain, the state member's (its views, time series and the newest metadata of its
 * collections); otherwise the entry's own.
 */
export function metadataReading(
  readable: ReadableBackup,
  entry: CollectionEntry,
): { readonly file: StoredFile; readonly source: StoredBackupSource } {
  const chain = readable.chain;
  if (chain === undefined) return { file: entry.metadata, source: readable.source };
  const own = collectionEntries(chain.state.manifest.namespaces).find(
    (candidate) => candidate.ns === entry.ns,
  );
  return own === undefined
    ? { file: entry.metadata, source: readable.source }
    : { file: own.metadata, source: chain.state.source };
}

/**
 * Every event of `windows`, window after window, each bounded by its `until`
 * (see the file header). Reading it twice reads the files twice: the restore scans
 * once before writing (integrity, planning) and once to replay.
 */
export async function* chainEvents(
  windows: readonly ChangeWindowSource[],
  signal: AbortSignal | undefined,
): AsyncGenerator<StoredChangeEvent> {
  for (const window of windows) {
    yield* eventsUntil(readChangeEvents(window.source, window.file, signal), window.until);
  }
}

/** The earlier of a window's end and an optional bound. */
function earlierOf(
  end: ClusterTime | undefined,
  bound: ClusterTime | undefined,
): ClusterTime | undefined {
  if (end === undefined) return bound;
  if (bound === undefined) return end;
  return compareClusterTimes(bound, end) < 0 ? bound : end;
}
