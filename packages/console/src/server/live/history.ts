/**
 * The live edit journal index in console.json: adding entries, updating their status,
 * and turning them into API views for the Edit history page.
 *
 * The index says what happened (who, when, which namespace and `_id`, hashes, counts,
 * status); the documents themselves are only in the sealed journal objects (journal.ts).
 * It keeps the newest {@link MAX_LIVE_EDIT_HISTORY} entries.
 */

import type { LiveEditEntryView } from "../../shared/api.ts";
import type { StateStore } from "../../state/store.ts";
import { type LiveEditRecord, MAX_LIVE_EDIT_HISTORY } from "../../state/types.ts";
import { notFound } from "../errors.ts";

/** Adds an entry at the front of the index (newest first). */
export async function addEntry(store: StateStore, entry: LiveEditRecord): Promise<void> {
  await store.update((state) => {
    state.liveEdits = [entry, ...(state.liveEdits ?? [])].slice(0, MAX_LIVE_EDIT_HISTORY);
  });
}

/** The fields of an entry that change after it was added. */
export type EntryPatch = Partial<
  Pick<
    LiveEditRecord,
    "status" | "documents" | "applied" | "conflicts" | "undoneBy" | "error" | "afterHash" | "parts"
  >
>;

/** Updates an entry in place and returns it (or `undefined` if it dropped out of the index). */
export async function updateEntry(
  store: StateStore,
  id: string,
  patch: EntryPatch,
): Promise<LiveEditRecord | undefined> {
  return store.update((state) => {
    let updated: LiveEditRecord | undefined;
    state.liveEdits = (state.liveEdits ?? []).map((entry) => {
      if (entry.id !== id) return entry;
      updated = { ...entry, ...patch };
      return updated;
    });
    return updated;
  });
}

/** An entry by id, or 404. */
export function entryById(store: StateStore, id: string): LiveEditRecord {
  const entry = (store.current.liveEdits ?? []).find((candidate) => candidate.id === id);
  if (entry === undefined) throw notFound("The edit history entry");
  return entry;
}

/**
 * Whether undo can be attempted: not undone yet, and something was (or may have been)
 * written. `pending` entries qualify because the console may have stopped after the
 * write but before recording it; undo is conditional, so trying is always safe.
 */
export function isUndoable(entry: LiveEditRecord): boolean {
  if (entry.undoneBy !== undefined) return false;
  return entry.status === "pending" || entry.applied > 0;
}

/** An entry as the API shows it. */
export function entryView(store: StateStore, entry: LiveEditRecord): LiveEditEntryView {
  const connection = store.current.connections.find(
    (candidate) => candidate.id === entry.connectionId,
  );
  return {
    id: entry.id,
    connectionId: entry.connectionId,
    ...(connection === undefined ? {} : { connectionName: connection.name }),
    ns: entry.ns,
    op: entry.op,
    by: entry.by,
    at: entry.at,
    status: entry.status,
    documents: entry.documents,
    applied: entry.applied,
    conflicts: entry.conflicts,
    ...(entry.documentId === undefined ? {} : { documentId: entry.documentId }),
    ...(entry.beforeHash === undefined ? {} : { beforeHash: entry.beforeHash }),
    ...(entry.afterHash === undefined ? {} : { afterHash: entry.afterHash }),
    ...(entry.undoOf === undefined ? {} : { undoOf: entry.undoOf }),
    ...(entry.undoneBy === undefined ? {} : { undoneBy: entry.undoneBy }),
    ...(entry.jobId === undefined ? {} : { jobId: entry.jobId }),
    journal:
      entry.journal.kind === "storage"
        ? { kind: "storage", storageId: entry.journal.storageId }
        : { kind: "console" },
    undoable: isUndoable(entry),
    ...(entry.error === undefined ? {} : { error: entry.error }),
  };
}
