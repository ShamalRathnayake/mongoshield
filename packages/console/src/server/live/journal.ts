/**
 * The live edit journal: the documents as they were before (and after) every live
 * edit, so any edit can be undone.
 *
 * Where it lives. Each connection names a journal storage location in its live edit
 * settings, usually the location its backups go to. Without one, the journal is kept in
 * the console's data directory (`<data>/live-journal/`, a local file adapter). It is
 * never kept inside console.json: that file is rewritten whole on every change and must
 * stay small, while pre-images can be up to 16 MiB each and a bulk edit journals
 * thousands of them.
 *
 * Layout (keys relative to the storage location, outside `backups/`, so catalogs,
 * retention and pruning never see them):
 *
 *   live-edits/<connection id>/<entry id>/part-000000.sealed     records 0..99
 *   live-edits/<connection id>/<entry id>/part-000001.sealed     records 100..199
 *
 * Encryption. Every part is sealed with the console's AES-256-GCM key (the key that
 * protects stored secrets, derived from MONGOSHIELD_SECRET), with the connection, entry
 * and part bound in as additional data, so a part cannot be swapped into another entry
 * or position. The journal is customer data, so it is sealed whatever the storage or the
 * plans writing there do; only this console (with its secret) can read it back, which is
 * all undo needs. The index (what happened, by whom, hashes) is in console.json.
 *
 * Plaintext of a part (JSON):
 *
 *   { "format": "mongoshield-live-journal/1", "connection": "<id>", "entry": "<id>",
 *     "ns": "app.users", "part": 0,
 *     "records": [ { "id": "<_id canonical EJSON>", "before": "<doc canonical EJSON>",
 *                    "after": "<doc canonical EJSON>" } ] }
 *
 * `before` is absent for inserts, `after` for deletes (and for bulk records whose write
 * was skipped or has not happened yet).
 */

import { join } from "node:path";
import { text } from "node:stream/consumers";
import { resolveStorage, type StorageAdapter } from "mongoshield";
import type { StorageRegistry } from "../../jobs/storage.ts";
import type { StateStore } from "../../state/store.ts";
import type { LiveEditRecord } from "../../state/types.ts";

/** Records per journal object. */
export const RECORDS_PER_PART = 100;

/** Format marker inside every part, checked when reading. */
const PART_FORMAT = "mongoshield-live-journal/1";

/** Directory (inside the data directory) of the journal of connections without journal storage. */
export const LOCAL_JOURNAL_DIR = "live-journal";

/** One journaled document: canonical Extended JSON of its `_id`, before and after. */
export interface JournalRecord {
  readonly id: string;
  readonly before?: string;
  readonly after?: string;
}

/** Where an entry's parts are (the `journal` field of a `LiveEditRecord`). */
export type JournalLocation = LiveEditRecord["journal"];

/** What the journal needs from the console. */
export interface LiveJournalOptions {
  readonly store: StateStore;
  readonly storage: StorageRegistry;
  readonly dataDir: string;
}

/** Writes and reads journal parts; see the file header. */
export class LiveJournal {
  readonly #options: LiveJournalOptions;
  /** The local adapter for `<data>/live-journal`, created on first use. */
  #local: Promise<StorageAdapter> | undefined;

  constructor(options: LiveJournalOptions) {
    this.#options = options;
  }

  /**
   * The journal location for a connection's settings. A configured storage location
   * that no longer exists falls back to the data directory rather than refusing to
   * journal (the record says where each entry went).
   */
  locationFor(journalStorageId: string | undefined): JournalLocation {
    if (journalStorageId === undefined) return { kind: "console" };
    const exists = this.#options.store.current.storage.some(
      (record) => record.id === journalStorageId,
    );
    return exists ? { kind: "storage", storageId: journalStorageId } : { kind: "console" };
  }

  /** Writes (or rewrites) one part of an entry. Resolves once the storage has it. */
  async writePart(
    entry: Pick<LiveEditRecord, "id" | "connectionId" | "ns" | "journal">,
    part: number,
    records: readonly JournalRecord[],
  ): Promise<void> {
    const plaintext = JSON.stringify({
      format: PART_FORMAT,
      connection: entry.connectionId,
      entry: entry.id,
      ns: entry.ns,
      part,
      records,
    });
    const sealed = this.#options.store.encrypt(plaintext, partContext(entry, part));
    const adapter = await this.#adapterFor(entry.journal);
    await adapter.put(partKey(entry, part), Buffer.from(sealed, "utf8"));
  }

  /** Reads one part back (opens the seal and checks it belongs to this entry). */
  async readPart(
    entry: Pick<LiveEditRecord, "id" | "connectionId" | "journal">,
    part: number,
  ): Promise<JournalRecord[]> {
    const adapter = await this.#adapterFor(entry.journal);
    const sealed = await text(await adapter.get(partKey(entry, part)));
    const plaintext = this.#options.store.decrypt(sealed.trim(), partContext(entry, part));
    const parsed: unknown = JSON.parse(plaintext);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Reflect.get(parsed, "format") !== PART_FORMAT ||
      Reflect.get(parsed, "entry") !== entry.id ||
      Reflect.get(parsed, "part") !== part
    ) {
      throw new Error(`Journal part ${part} of entry ${entry.id} is not what was written.`);
    }
    const records: unknown = Reflect.get(parsed, "records");
    if (!Array.isArray(records)) throw new Error(`Journal part ${part} has no records.`);
    return records.map(toJournalRecord);
  }

  /** Every record of an entry, part by part (parts are small: 100 records each). */
  async *records(
    entry: Pick<LiveEditRecord, "id" | "connectionId" | "journal" | "parts">,
  ): AsyncGenerator<{ readonly part: number; readonly records: JournalRecord[] }> {
    for (let part = 0; part < entry.parts; part += 1) {
      yield { part, records: await this.readPart(entry, part) };
    }
  }

  /** The adapter of a location. */
  async #adapterFor(location: JournalLocation): Promise<StorageAdapter> {
    if (location.kind === "console") {
      this.#local ??= resolveStorage(join(this.#options.dataDir, LOCAL_JOURNAL_DIR));
      return this.#local;
    }
    const record = this.#options.store.current.storage.find(
      (candidate) => candidate.id === location.storageId,
    );
    if (record === undefined) {
      throw new Error("The storage location that holds this journal entry was deleted.");
    }
    return this.#options.storage.adapterFor(record);
  }

  /** Closes the local adapter (shutdown). Storage locations are closed by the registry. */
  async close(): Promise<void> {
    const local = this.#local;
    this.#local = undefined;
    if (local !== undefined) await (await local).close?.();
  }
}

/** `live-edits/<connection>/<entry>/part-000000.sealed`. */
export function partKey(entry: Pick<LiveEditRecord, "id" | "connectionId">, part: number): string {
  return `live-edits/${entry.connectionId}/${entry.id}/part-${String(part).padStart(6, "0")}.sealed`;
}

/** AES-GCM additional data of a part: binds the ciphertext to its connection, entry and position. */
function partContext(entry: Pick<LiveEditRecord, "id" | "connectionId">, part: number): string {
  return `live-journal:${entry.connectionId}:${entry.id}:${part}`;
}

/** Checks one parsed record (the file is ours and authenticated, but be strict anyway). */
function toJournalRecord(value: unknown): JournalRecord {
  if (typeof value !== "object" || value === null) throw new Error("Bad journal record.");
  const id: unknown = Reflect.get(value, "id");
  const before: unknown = Reflect.get(value, "before");
  const after: unknown = Reflect.get(value, "after");
  if (typeof id !== "string") throw new Error("Bad journal record id.");
  return {
    id,
    ...(typeof before === "string" ? { before } : {}),
    ...(typeof after === "string" ? { after } : {}),
  };
}

/** Splits records into parts of {@link RECORDS_PER_PART}. */
export function partsOf<T>(items: readonly T[]): T[][] {
  const parts: T[][] = [];
  for (let start = 0; start < items.length; start += RECORDS_PER_PART) {
    parts.push(items.slice(start, start + RECORDS_PER_PART));
  }
  return parts;
}
