/**
 * Queryable Encryption (QE) collections in a backup.
 *
 * A QE collection is an ordinary collection whose `listCollections` options carry
 * `encryptedFields` (which fields are encrypted, with which keys, and the names of its
 * state collections). The encrypted values themselves are ordinary BSON (binary
 * subtype 6), and the server keeps the metadata encrypted queries need in two state
 * collections next to it, `enxcol_.<name>.esc` and `enxcol_.<name>.ecoc` (MongoDB 7.0+;
 * the 6.x preview also had `.ecc`). The data encryption keys live in the key vault
 * collection (often `encryption.__keyVault`), which the application chooses.
 *
 * MongoShield backs all of them up as ordinary collections, which is what a restore
 * needs: the raw `create` of the restore keeps `encryptedFields` (restore-collections.ts
 * does not use the driver helper, which would create fresh, EMPTY state collections),
 * and the state collections come back with the very contents that match the restored
 * data. (QE collections also have an implicit validator, `implicitFLESchema`, that
 * checks the encrypted fields; the restore writes with `bypassDocumentValidation` when
 * the user has that privilege, see restore.ts.) A restore that holds the collection
 * without its state collections recreates the encrypted data, but encrypted queries
 * and new encrypted writes on it do not work.
 * That only happens when a backup's selection leaves them out, so the backup warns
 * about it here, before anything is read.
 */

import type { Document } from "mongodb";
import type { CollectionSpec } from "../mongo/index.ts";

/**
 * A warning for every selected QE collection whose state collections are not all in
 * the selection, or `[]`. Pure, so every case is unit tested.
 */
export function queryableEncryptionWarnings(specs: readonly CollectionSpec[]): string[] {
  const selected = new Set(specs.map((spec) => spec.ns));
  const warnings: string[] = [];
  for (const spec of specs) {
    const missing = stateCollectionsOf(spec).filter((ns) => !selected.has(ns));
    if (missing.length === 0) continue;
    warnings.push(
      `${spec.ns} uses Queryable Encryption, but its state collections ${missing.join(", ")} are not in this backup: a restore recreates the collection with its encrypted data, but encrypted queries and new encrypted writes will not work on it. Include ${spec.db}.enxcol_.${spec.name}.* (and the key vault collection) in the backup.`,
    );
  }
  return warnings;
}

/**
 * The namespaces of a collection's QE state collections (`[]` for any other
 * collection): the names `encryptedFields` records, or the server's default names.
 */
export function stateCollectionsOf(spec: CollectionSpec): string[] {
  const encryptedFields = asDocument(spec.options.encryptedFields);
  if (encryptedFields === undefined) return [];
  const names = [
    stringOr(encryptedFields.escCollection, `enxcol_.${spec.name}.esc`),
    stringOr(encryptedFields.ecocCollection, `enxcol_.${spec.name}.ecoc`),
  ];
  // MongoDB 6.x (the QE preview) had a third state collection; 7.0 dropped it.
  if (typeof encryptedFields.eccCollection === "string") names.push(encryptedFields.eccCollection);
  return names.map((name) => `${spec.db}.${name}`);
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === "string" && value !== "" ? value : fallback;
}

function asDocument(value: unknown): Document | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value : undefined;
}
