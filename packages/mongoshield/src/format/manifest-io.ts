/**
 * Reading and writing manifests, with clear errors when a manifest is
 * malformed or was written by a newer, incompatible version of MongoShield.
 *
 * Field order: the manifest holds a few BSON values as canonical Extended JSON, the
 * `_id` bounds of split collections' parts (`files[].range`). An `_id` that is an
 * embedded document with integer-like keys (`{ "b": 1, "2": 1 }`) would be reordered
 * by plain `JSON.stringify` / `JSON.parse` (JavaScript lists integer-like keys first),
 * which is a different `_id` and a different place in the `_id` order. Manifests are
 * therefore written and read with the order-keeping JSON of src/format/ordered-json.ts;
 * for everything else the output is byte-identical to `JSON.stringify`.
 */

import { z } from "zod";
import { isMongoShieldError, MongoShieldError } from "../errors.ts";
import type { StorageAdapter } from "../storage/types.ts";
import { readStreamToBuffer } from "../util/streams.ts";
import { manifestKey } from "./layout.ts";
import { MANIFEST_FORMAT_VERSION, type Manifest, ManifestSchema } from "./manifest.ts";
import { parseJsonInStoredOrder, stringifyJsonInStoredOrder } from "./ordered-json.ts";

/** Manifests are small; anything bigger than this is certainly not a manifest. */
const MAX_MANIFEST_BYTES = 64 * 1024 * 1024;

/** Serializes a manifest as pretty-printed JSON with a trailing newline. */
export function serializeManifest(manifest: Manifest): string {
  // Validate before writing so we never commit a manifest we could not read back.
  // A failure here is a bug in MongoShield, not something the user did.
  const result = ManifestSchema.safeParse(manifest);
  if (!result.success) {
    throw new MongoShieldError(
      "MS_INTERNAL",
      `Refusing to write an invalid manifest:\n${z.prettifyError(result.error)}`,
      { hint: "This is a bug in MongoShield; please report it." },
    );
  }
  // zod passes the `range` values through as they are (z.custom), so the field order
  // recorded on them (backup-parts.ts `toPartRange`) reaches the writer.
  return `${stringifyJsonInStoredOrder(result.data, 2)}\n`;
}

/**
 * Parses and validates manifest JSON.
 *
 * @param text the manifest file contents
 * @param where a human-readable location used in error messages
 */
export function parseManifest(text: string, where = "manifest.json"): Manifest {
  let raw: unknown;
  try {
    // Keeps the stored order of `range` bounds (see the file header).
    raw = parseJsonInStoredOrder(text);
  } catch (error) {
    throw new MongoShieldError("MS_MANIFEST_INVALID", `${where} is not valid JSON.`, {
      cause: error,
    });
  }

  // Check the format version first, so a manifest from a newer release gets a
  // helpful "please upgrade" error instead of a list of schema mismatches.
  const formatVersion =
    typeof raw === "object" && raw !== null ? Reflect.get(raw, "formatVersion") : undefined;
  if (typeof formatVersion === "number" && formatVersion > MANIFEST_FORMAT_VERSION) {
    throw new MongoShieldError(
      "MS_FORMAT_UNSUPPORTED",
      `${where} uses format version ${formatVersion}, but this release reads up to version ${MANIFEST_FORMAT_VERSION}.`,
      { hint: "Upgrade mongoshield to restore this backup." },
    );
  }

  const result = ManifestSchema.safeParse(raw);
  if (!result.success) {
    throw new MongoShieldError(
      "MS_MANIFEST_INVALID",
      `${where} does not match the manifest schema:\n${z.prettifyError(result.error)}`,
    );
  }
  return result.data;
}

/**
 * Reads the manifest of a backup. Returns `undefined` if the backup has no
 * manifest (it is incomplete or does not exist).
 */
export async function readManifest(
  storage: StorageAdapter,
  backupId: string,
  options: { readonly signal?: AbortSignal } = {},
): Promise<Manifest | undefined> {
  const key = manifestKey(backupId);
  try {
    const stream = await storage.get(key, options);
    const bytes = await readStreamToBuffer(stream, { maxBytes: MAX_MANIFEST_BYTES });
    const where = `${storage.location}${key}`;
    const manifest = parseManifest(bytes.toString("utf8"), where);

    // A manifest copied into the wrong directory would make us read the wrong
    // backup's files, so the id inside must match the directory it lives in.
    if (manifest.id !== backupId) {
      throw new MongoShieldError(
        "MS_MANIFEST_INVALID",
        `${where} belongs to backup ${manifest.id}, not ${backupId}.`,
      );
    }
    return manifest;
  } catch (error) {
    if (isMongoShieldError(error, "MS_STORAGE_NOT_FOUND")) return undefined;
    throw error;
  }
}

/**
 * Writes a manifest, which commits the backup. Uses a conditional write when the
 * storage supports it, so an existing manifest can never be overwritten.
 *
 * `retainUntil` locks the manifest like the backup's data files (immutable
 * backups); pass the same date that is recorded as `manifest.immutableUntil`.
 */
export async function writeManifest(
  storage: StorageAdapter,
  manifest: Manifest,
  options: { readonly signal?: AbortSignal; readonly retainUntil?: Date } = {},
): Promise<void> {
  const body = Buffer.from(serializeManifest(manifest), "utf8");
  await storage.put(manifestKey(manifest.id), body, {
    contentType: "application/json",
    sizeHint: body.length,
    ...(storage.capabilities.conditionalWrites ? { ifNoneMatch: "*" as const } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.retainUntil ? { retainUntil: options.retainUntil } : {}),
  });
}
