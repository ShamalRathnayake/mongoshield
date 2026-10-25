/**
 * Google Cloud Storage adapter (entry point `mongoshield/storage/gcs`).
 *
 *   import { gcsStorage } from "mongoshield/storage/gcs";
 *   const storage = gcsStorage({ bucket: "my-backups", prefix: "prod/" });
 *
 * The Google Cloud SDK is an optional peer dependency, loaded lazily on first use:
 *
 *   npm install @google-cloud/storage
 *
 * Credentials come from Application Default Credentials unless given:
 * `GOOGLE_APPLICATION_CREDENTIALS`, `gcloud auth application-default login`, or
 * the metadata server on GCE/GKE/Cloud Run. Pass `keyFilename`/`credentials`, or
 * an existing `storage` client, for anything else. The SDK also honours
 * `STORAGE_EMULATOR_HOST` (e.g. for fake-gcs-server).
 *
 * How the contract is met:
 * - Atomic writes: streams use a resumable upload and buffers a single-request
 *   upload. Either way GCS only creates the object when the upload is
 *   finalized, so a failed or aborted upload never leaves a partial object.
 *   (An abandoned resumable session simply expires after a week; it is never
 *   visible as an object and is not billed as one.)
 * - Integrity: uploads are checked against the CRC32C (or MD5) GCS computes on
 *   its side, and full downloads are checked against the `x-goog-hash` header.
 *   Note the SDK's behaviour on an upload mismatch: it deletes the object it
 *   just wrote, then fails. That surfaces here as MS_INTEGRITY_FAILED.
 * - Conditional writes use the precondition `ifGenerationMatch: 0` ("only if no
 *   live object exists"), checked atomically by GCS at finalization. A 412
 *   response becomes MS_STORAGE_PRECONDITION_FAILED.
 * - Listing uses `objects.list` pages (1000 names each, already in
 *   lexicographic order); `listPrefixes` uses the `/` delimiter.
 * - GCS has no multi-object delete, so `delete` sends individual requests with
 *   bounded concurrency.
 * - Cancellation: metadata and list requests cannot be interrupted by the SDK,
 *   so the signal is checked before and after each one; uploads and downloads
 *   are destroyed immediately when the signal fires.
 * - Immutable backups use per-object retention: a put with `retainUntil` sets the
 *   object's `retention: { mode, retainUntilTime }` in the upload metadata, so the
 *   object is locked from the moment it exists. `mode` is `Locked` (compliance:
 *   cannot be shortened or removed by anyone) or `Unlocked` (governance: can be
 *   lifted by someone with `storage.objects.overrideUnlockedRetention`). Quirks:
 *   - Object retention must be enabled on the bucket, and that can only be done
 *     when the bucket is created (`gcloud storage buckets create --enable-per-object-retention`).
 *     The first retained put checks the bucket's `objectRetention` and fails with
 *     MS_CONFIG_INVALID if it is off. Reading bucket metadata needs
 *     `storage.buckets.get`, which roles/storage.objectAdmin lacks; without it the
 *     check is skipped and GCS's own 400 is mapped to the same error.
 *   - Deleting or overwriting a retained object fails with 403, mapped to
 *     MS_STORAGE_FORBIDDEN with a retention hint (not the usual IAM hint).
 *   - A bucket-wide retention policy (the older "Bucket Lock" feature) also blocks
 *     deletes, but applies to every object equally; per-object retention lets
 *     each backup carry its own `retainDays`.
 */

import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type * as GcsSdk from "@google-cloud/storage";
import type {
  Bucket,
  CreateWriteStreamOptions,
  File,
  FileMetadata,
  Storage,
  StorageOptions,
} from "@google-cloud/storage";
import { abortError, MongoShieldError, throwIfAborted } from "../errors.ts";
import {
  assertValidRange,
  countBytes,
  destroyOnAbort,
  forEachWithConcurrency,
  messageOf,
  missingPackageError,
  normalizePrefix,
  numberProperty,
  propertyOf,
  storageKeyOf,
  storagePrefixOf,
  stringProperty,
  unquote,
} from "./adapter-utils.ts";
import { assertValidKey, assertValidPrefix } from "./keys.ts";
import {
  assertValidRetainUntil,
  IMMUTABLE_GUIDE,
  objectLockedError,
  onceSuccessful,
  resolveRetentionMode,
} from "./retention.ts";
import type {
  GetOptions,
  ObjectInfo,
  PutOptions,
  RetentionMode,
  RetentionOptions,
  SignalOptions,
  StorageAdapter,
  StorageCapabilities,
} from "./types.ts";

/** Options for {@link gcsStorage}. */
export interface GcsStorageOptions {
  /** Bucket name (no `gs://`, no slashes). */
  readonly bucket: string;
  /**
   * Object name prefix inside the bucket, e.g. `"prod/mongo"`. A trailing `/`
   * is added if missing, so objects land at `prod/mongo/<key>`. Defaults to the
   * bucket root.
   */
  readonly prefix?: string;
  /**
   * An existing `Storage` client to use instead of creating one. When given,
   * `projectId`, `keyFilename`, `credentials` and `apiEndpoint` are ignored.
   */
  readonly storage?: Storage;
  /** Google Cloud project id. Usually inferred from the credentials. */
  readonly projectId?: string;
  /** Path to a service-account JSON key file. Defaults to Application Default Credentials. */
  readonly keyFilename?: string;
  /** Service-account credentials as an object (`client_email`, `private_key`). */
  readonly credentials?: StorageOptions["credentials"];
  /** Custom API endpoint, e.g. `http://localhost:4443` for fake-gcs-server. */
  readonly apiEndpoint?: string;
  /**
   * Resumable upload chunk size in bytes (a multiple of 256 KiB; default 16 MiB).
   * Each chunk is buffered in memory so it can be retried on a transient error;
   * `0` streams the whole object in one request with no buffering (and no
   * retry of a failed chunk).
   */
  readonly chunkSize?: number;
  /**
   * Hash used to verify uploads and full downloads: `"crc32c"` (default),
   * `"md5"` (not available for composite objects), or `false` to skip the check.
   */
  readonly validation?: "crc32c" | "md5" | false;
  /** How many objects `delete()` removes in parallel (default 16). */
  readonly deleteConcurrency?: number;
  /**
   * Retention mode for puts with `retainUntil` (immutable backups). Defaults to
   * `{ mode: "compliance" }` (GCS `Locked`); `"governance"` uses `Unlocked`. The
   * bucket must have object retention enabled. See docs/guides/immutable-backups.md.
   */
  readonly retention?: RetentionOptions;
}

/** 16 MiB: few requests per object, bounded memory per upload. */
const DEFAULT_CHUNK_SIZE = 16 * 1024 * 1024;
/** GCS requires resumable chunks to be multiples of 256 KiB. */
const CHUNK_GRANULARITY = 256 * 1024;
/** `objects.list` returns at most 1000 items per page. */
const LIST_PAGE_SIZE = 1000;
const DEFAULT_DELETE_CONCURRENCY = 16;
/**
 * Explicit content type for objects without one. Without it the SDK guesses a
 * type from the file extension (`.json` → `application/json`), which is
 * harmless but makes uploads depend on a MIME lookup table.
 */
const DEFAULT_CONTENT_TYPE = "application/octet-stream";

const INSTALL_HINT = "npm install @google-cloud/storage";

const CAPABILITIES: StorageCapabilities = {
  conditionalWrites: true,
  rangeReads: true,
  // Per-object retention. Whether the bucket allows it is checked at the first retained put.
  objectLock: true,
};

/** Our retention modes in GCS's vocabulary. */
const GCS_RETENTION_MODES = { compliance: "Locked", governance: "Unlocked" } as const;

/** What an adapter call was doing, used in error messages ("Could not read …"). */
type Operation = "read" | "write" | "stat" | "list" | "delete";

/** One page of an `objects.list` call: the files plus the raw response (for `prefixes`). */
interface ListPage {
  readonly files: readonly File[];
  readonly prefixes: readonly string[];
  readonly nextPageToken: string | undefined;
}

/** Creates a storage adapter backed by a Google Cloud Storage bucket. */
export function gcsStorage(options: GcsStorageOptions): StorageAdapter {
  const bucketName = validBucket(options.bucket);
  const basePrefix = normalizePrefix(options.prefix, "GCS");
  const chunkSize = validChunkSize(options.chunkSize);
  const deleteConcurrency = validConcurrency(options.deleteConcurrency);
  const validation = options.validation ?? "crc32c";
  const location = `gs://${bucketName}/${basePrefix}`;
  const retentionMode: RetentionMode = resolveRetentionMode(options.retention, "GCS");

  // The client is created lazily and shared by every call: it holds only
  // configuration and an auth client, never per-run state. File objects, which
  // do cache metadata, are created fresh for every call.
  let bucketPromise: Promise<Bucket> | undefined;

  function bucket(): Promise<Bucket> {
    if (!bucketPromise) {
      bucketPromise = createBucket(options, bucketName);
      // Do not cache a failure (for example a missing SDK); the next call retries.
      bucketPromise.catch(() => {
        bucketPromise = undefined;
      });
    }
    return bucketPromise;
  }

  async function fileFor(key: string): Promise<File> {
    return (await bucket()).file(basePrefix + key);
  }

  function fail(
    error: unknown,
    operation: Operation,
    key: string,
    signal?: AbortSignal,
  ): MongoShieldError {
    return gcsError(error, { operation, target: `${location}${key}`, bucketName, signal });
  }

  /**
   * Checks once per adapter that the bucket has object retention enabled, so a
   * misconfigured bucket fails clearly before the first upload starts.
   */
  const ensureObjectRetentionEnabled = onceSuccessful(async () => {
    let mode: string | undefined;
    try {
      const [metadata] = await (await bucket()).getMetadata();
      mode = metadata.objectRetention?.mode;
    } catch (error) {
      // No storage.buckets.get permission: skip the check (see the header comment).
      const status = httpStatus(error);
      if (status === 401 || status === 403) return;
      throw fail(error, "write", "");
    }
    if (mode !== "Enabled") throw objectRetentionDisabledError(bucketName, location);
  });

  async function put(
    key: string,
    body: Readable | Uint8Array,
    putOptions: PutOptions = {},
  ): Promise<ObjectInfo> {
    assertValidKey(key);
    const { signal, retainUntil } = putOptions;
    throwIfAborted(signal);
    if (retainUntil !== undefined) assertValidRetainUntil(retainUntil, `${location}${key}`);
    const counter = { bytes: 0 };
    try {
      const file = await fileFor(key);
      if (retainUntil !== undefined) await ensureObjectRetentionEnabled();
      throwIfAborted(signal);
      const isStream = body instanceof Readable;
      const writeOptions: CreateWriteStreamOptions = {
        contentType: putOptions.contentType ?? DEFAULT_CONTENT_TYPE,
        // Buffers go up in one request; streams use a resumable session so the
        // object appears only when the session is finalized.
        resumable: isStream,
        ...(isStream && chunkSize > 0 ? { chunkSize } : {}),
        validation,
        gzip: false,
        // ifGenerationMatch 0 = "create only": GCS rejects with 412 if any live
        // generation of the object exists, atomically at finalization.
        ...(putOptions.ifNoneMatch === "*" ? { preconditionOpts: { ifGenerationMatch: 0 } } : {}),
        // Retention is part of the object resource sent when the upload starts
        // (not custom metadata), so the object never exists unlocked.
        ...(retainUntil === undefined
          ? {}
          : {
              metadata: {
                retention: {
                  mode: GCS_RETENTION_MODES[retentionMode],
                  retainUntilTime: retainUntil.toISOString(),
                },
              },
            }),
      };
      const upload = file.createWriteStream(writeOptions);
      await pipeline(
        isStream ? countBytes(body, counter) : Readable.from([Buffer.from(body)]),
        upload,
        signal ? { signal } : {},
      );
      const size = isStream ? counter.bytes : body.byteLength;
      return objectInfo(key, file.metadata, size);
    } catch (error) {
      if (body instanceof Readable) body.destroy();
      throw fail(error, "write", key, signal);
    }
  }

  async function get(key: string, getOptions: GetOptions = {}): Promise<Readable> {
    assertValidKey(key);
    const { signal, range } = getOptions;
    throwIfAborted(signal);
    if (range) assertValidRange(range, key);
    try {
      const file = await fileFor(key);
      throwIfAborted(signal);
      // The SDK refuses hash validation on ranged reads (a partial body cannot
      // be checked against the whole object's hash), so only full reads ask for it.
      const stream = file.createReadStream(
        range
          ? { start: range.start, ...(range.end === undefined ? {} : { end: range.end }) }
          : { validation },
      );
      destroyOnAbort(stream, signal);
      // The request only starts when someone reads; wait for the first data so
      // a missing object is reported here, not later as a stream error.
      await waitUntilReadable(stream);
      return stream;
    } catch (error) {
      // 416: the range starts past the end (or the object is empty). Other
      // adapters return an empty stream there, so we do too.
      if (range && httpStatus(error) === 416) return Readable.from([]);
      throw fail(error, "read", key, signal);
    }
  }

  async function head(key: string, headOptions: SignalOptions = {}) {
    assertValidKey(key);
    const { signal } = headOptions;
    throwIfAborted(signal);
    try {
      const file = await fileFor(key);
      const [metadata] = await file.getMetadata();
      throwIfAborted(signal);
      return objectInfo(key, metadata);
    } catch (error) {
      // A missing object is a normal answer; a missing bucket is still an error.
      if (httpStatus(error) === 404 && !isMissingBucket(error) && !signal?.aborted) {
        return undefined;
      }
      throw fail(error, "stat", key, signal);
    }
  }

  /**
   * Fetches one `objects.list` page. With `autoPaginate: false` the SDK returns
   * `[files, nextQuery, rawResponse]`; delimiter "directories" are only in the
   * raw response's `prefixes`.
   */
  async function listPage(
    prefix: string,
    delimiter: string | undefined,
    pageToken: string | undefined,
    signal: AbortSignal | undefined,
  ): Promise<ListPage> {
    throwIfAborted(signal);
    try {
      const [files, , response] = await (await bucket()).getFiles({
        prefix: basePrefix + prefix,
        autoPaginate: false,
        maxResults: LIST_PAGE_SIZE,
        ...(delimiter === undefined ? {} : { delimiter }),
        ...(pageToken === undefined ? {} : { pageToken }),
      });
      throwIfAborted(signal);
      const prefixes = propertyOf(response, "prefixes");
      return {
        files,
        prefixes: Array.isArray(prefixes)
          ? prefixes.filter((item): item is string => typeof item === "string")
          : [],
        nextPageToken: stringProperty(response, "nextPageToken") || undefined,
      };
    } catch (error) {
      throw fail(error, "list", prefix, signal);
    }
  }

  async function* list(prefix: string, listOptions: SignalOptions = {}) {
    assertValidPrefix(prefix);
    const { signal } = listOptions;
    let pageToken: string | undefined;
    do {
      const page = await listPage(prefix, undefined, pageToken, signal);
      for (const file of page.files) {
        const key = storageKeyOf(basePrefix, file.name);
        if (key !== undefined) yield objectInfo(key, file.metadata);
      }
      pageToken = page.nextPageToken;
    } while (pageToken);
  }

  async function* listPrefixes(prefix: string, listOptions: SignalOptions = {}) {
    assertValidPrefix(prefix);
    const { signal } = listOptions;
    // With delimiter "/", GCS rolls every name below the next "/" up into one
    // `prefixes` entry. Entries are ordered and never repeat across pages.
    let pageToken: string | undefined;
    do {
      const page = await listPage(prefix, "/", pageToken, signal);
      for (const fullPrefix of page.prefixes) {
        const storagePrefix = storagePrefixOf(basePrefix, fullPrefix);
        if (storagePrefix !== undefined) yield storagePrefix;
      }
      pageToken = page.nextPageToken;
    } while (pageToken);
  }

  async function deleteObjects(keys: readonly string[], deleteOptions: SignalOptions = {}) {
    const { signal } = deleteOptions;
    throwIfAborted(signal);
    // Validate everything first so an invalid key cannot leave a half-done delete.
    for (const key of keys) assertValidKey(key);
    if (keys.length === 0) return;
    const target = await bucket().catch((error: unknown) => {
      throw fail(error, "delete", keys[0] ?? "", signal);
    });
    await forEachWithConcurrency(keys, deleteConcurrency, async (key) => {
      throwIfAborted(signal);
      try {
        // ignoreNotFound: deleting a missing key is not an error in the contract.
        await target.file(basePrefix + key).delete({ ignoreNotFound: true });
      } catch (error) {
        throw fail(error, "delete", key, signal);
      }
    });
  }

  return {
    kind: "gcs",
    location,
    capabilities: CAPABILITIES,
    put,
    get,
    head,
    list,
    listPrefixes,
    delete: deleteObjects,
    async close() {
      // The SDK keeps no open connections that need closing (HTTP keep-alive
      // sockets are unref'd); forget the client so a later call starts fresh.
      bucketPromise = undefined;
    },
  };
}

/** Imports the SDK and builds (or adopts) the client, then returns the bucket handle. */
async function createBucket(options: GcsStorageOptions, bucketName: string): Promise<Bucket> {
  if (options.storage) return options.storage.bucket(bucketName);
  const sdk = await loadGcsSdk();
  const storage = new sdk.Storage({
    ...(options.projectId === undefined ? {} : { projectId: options.projectId }),
    ...(options.keyFilename === undefined ? {} : { keyFilename: options.keyFilename }),
    ...(options.credentials === undefined ? {} : { credentials: options.credentials }),
    ...(options.apiEndpoint === undefined ? {} : { apiEndpoint: options.apiEndpoint }),
  });
  return storage.bucket(bucketName);
}

/** The error for a bucket without object retention, with instructions. */
function objectRetentionDisabledError(
  bucketName: string,
  target: string,
  cause?: unknown,
): MongoShieldError {
  return new MongoShieldError(
    "MS_CONFIG_INVALID",
    `Cannot write immutable objects to ${target}: object retention is not enabled on bucket "${bucketName}".`,
    {
      ...(cause === undefined ? {} : { cause }),
      hint:
        "Object retention can only be enabled when a bucket is created: create a new bucket with " +
        "`gcloud storage buckets create gs://<name> --enable-per-object-retention` and back up " +
        `there, or drop retainDays. See ${IMMUTABLE_GUIDE}.`,
    },
  );
}

/**
 * Loads the optional SDK. It is a peer dependency so that users who only back
 * up elsewhere never install it.
 */
async function loadGcsSdk(): Promise<typeof GcsSdk> {
  try {
    return await import("@google-cloud/storage");
  } catch (error) {
    throw missingPackageError(error, "Google Cloud Storage", INSTALL_HINT);
  }
}

/**
 * Resolves once the stream has data buffered (or has ended), and rejects if it
 * fails first. Listening for "readable" makes the SDK start the HTTP request;
 * removing the listener afterwards hands the stream back untouched, so the
 * caller can still pipe it or iterate it from the first byte.
 */
function waitUntilReadable(stream: Readable): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      stream.off("readable", onReadable);
      stream.off("error", onError);
    };
    const onReadable = () => {
      cleanup();
      resolve();
    };
    const onError = (error: unknown) => {
      cleanup();
      reject(error);
    };
    stream.on("readable", onReadable);
    stream.on("error", onError);
  });
}

/**
 * Builds an `ObjectInfo` from GCS object metadata. GCS reports sizes as int64
 * strings and times as RFC 3339 strings. `fallbackSize` covers responses that
 * omit the size (it is always present on real GCS).
 */
function objectInfo(key: string, metadata: FileMetadata, fallbackSize = 0): ObjectInfo {
  const size = metadata.size === undefined ? fallbackSize : Number(metadata.size);
  const updated = metadata.updated ? new Date(metadata.updated) : new Date();
  const etag = unquote(metadata.etag);
  return {
    key,
    size: Number.isFinite(size) ? size : fallbackSize,
    lastModified: Number.isNaN(updated.getTime()) ? new Date() : updated,
    ...(etag ? { etag } : {}),
  };
}

function validBucket(bucket: string): string {
  if (typeof bucket !== "string" || bucket.length === 0 || bucket.includes("/")) {
    throw new MongoShieldError(
      "MS_CONFIG_INVALID",
      `Invalid GCS bucket name "${String(bucket)}".`,
      {
        hint: 'Pass just the bucket name, e.g. { bucket: "my-backups", prefix: "prod/" }.',
      },
    );
  }
  return bucket;
}

function validChunkSize(chunkSize: number | undefined): number {
  if (chunkSize === undefined) return DEFAULT_CHUNK_SIZE;
  if (!Number.isSafeInteger(chunkSize) || chunkSize < 0 || chunkSize % CHUNK_GRANULARITY !== 0) {
    throw new MongoShieldError(
      "MS_CONFIG_INVALID",
      `GCS chunkSize must be 0 or a multiple of 256 KiB (262144 bytes), got ${chunkSize}.`,
    );
  }
  return chunkSize;
}

function validConcurrency(concurrency: number | undefined): number {
  if (concurrency === undefined) return DEFAULT_DELETE_CONCURRENCY;
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) {
    throw new MongoShieldError(
      "MS_CONFIG_INVALID",
      `GCS deleteConcurrency must be a positive integer, got ${concurrency}.`,
    );
  }
  return concurrency;
}

/**
 * The HTTP status of a GCS error. `ApiError` carries it as a numeric `code`;
 * transport errors from gaxios carry `response.status` (and a string `code`
 * such as `ECONNRESET`, which is not a status).
 */
function httpStatus(error: unknown): number | undefined {
  return numberProperty(error, "code") ?? numberProperty(propertyOf(error, "response"), "status");
}

/** GCS answers 404 for both a missing object and a missing bucket; only the message differs. */
function isMissingBucket(error: unknown): boolean {
  return httpStatus(error) === 404 && /bucket does not exist/i.test(messageOf(error));
}

/** Context for {@link gcsError}. */
interface GcsErrorContext {
  readonly operation: Operation;
  readonly target: string;
  readonly bucketName: string;
  readonly signal?: AbortSignal | undefined;
}

/**
 * Maps an SDK error to a `MongoShieldError`: 404 → NOT_FOUND, 401/403 →
 * FORBIDDEN, 412 → PRECONDITION_FAILED, hash mismatches → INTEGRITY_FAILED,
 * anything else → IO.
 */
function gcsError(error: unknown, context: GcsErrorContext): MongoShieldError {
  const { operation, target, bucketName, signal } = context;
  if (signal?.aborted) return abortError(signal);
  if (error instanceof MongoShieldError) return error;

  const status = httpStatus(error);
  const message = `Could not ${operation} ${target}: ${messageOf(error)}`;
  const base = {
    cause: error,
    ...(status === undefined ? {} : { details: { httpStatus: status } }),
  };
  const code = stringProperty(error, "code");

  if (propertyOf(error, "name") === "AbortError") {
    return new MongoShieldError("MS_ABORTED", message, base);
  }
  if (isMissingBucket(error)) {
    return new MongoShieldError("MS_STORAGE_NOT_FOUND", message, {
      ...base,
      hint: `Create the bucket "${bucketName}", or check the bucket name and project.`,
    });
  }
  if (status === 404) return new MongoShieldError("MS_STORAGE_NOT_FOUND", message, base);
  // Reached when the bucket check was skipped: GCS refuses a retention setting
  // on a bucket without object retention with a 400 that mentions retention.
  if (operation === "write" && status === 400 && /retention/i.test(messageOf(error))) {
    return objectRetentionDisabledError(bucketName, target, error);
  }
  // Deleting or overwriting a retained object: 403 "… is subject to … retention …".
  if (status === 403 && /retention|retained|hold/i.test(messageOf(error))) {
    return objectLockedError(message, base);
  }
  if (status === 401 || status === 403) {
    return new MongoShieldError("MS_STORAGE_FORBIDDEN", message, {
      ...base,
      hint:
        "Check the credentials (GOOGLE_APPLICATION_CREDENTIALS or keyFilename), and that the " +
        `service account has roles/storage.objectAdmin (or objectCreator + objectViewer) on gs://${bucketName}.`,
    });
  }
  if (status === 412) {
    return new MongoShieldError("MS_STORAGE_PRECONDITION_FAILED", message, base);
  }
  if (
    code === "FILE_NO_UPLOAD" ||
    code === "FILE_NO_UPLOAD_DELETE" ||
    code === "CONTENT_DOWNLOAD_MISMATCH"
  ) {
    return new MongoShieldError("MS_INTEGRITY_FAILED", message, {
      ...base,
      hint: "The data was corrupted in transit. Retry the operation.",
    });
  }
  return new MongoShieldError("MS_STORAGE_IO", message, base);
}
