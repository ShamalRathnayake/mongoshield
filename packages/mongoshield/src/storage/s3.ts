/**
 * Amazon S3 (and S3-compatible) storage adapter (entry point `mongoshield/storage/s3`).
 *
 *   import { s3Storage } from "mongoshield/storage/s3";
 *   const storage = s3Storage({ bucket: "my-backups", prefix: "prod/", region: "eu-west-1" });
 *
 * The AWS SDK is an optional peer dependency, loaded lazily on first use:
 *
 *   npm install @aws-sdk/client-s3 @aws-sdk/lib-storage
 *
 * S3-compatible services work through `endpoint` (+ usually `forcePathStyle`):
 *
 *   // MinIO / Ceph / SeaweedFS (path-style URLs, any region name is accepted)
 *   s3Storage({ bucket: "b", endpoint: "http://localhost:9000", forcePathStyle: true });
 *   // Cloudflare R2 (region must be "auto")
 *   s3Storage({ bucket: "b", endpoint: "https://<account>.r2.cloudflarestorage.com", region: "auto" });
 *   // Backblaze B2
 *   s3Storage({ bucket: "b", endpoint: "https://s3.us-west-004.backblazeb2.com", region: "us-west-004" });
 *
 * Checksums and S3-compatible services: since early 2025 the AWS SDK sends a
 * CRC32 checksum with every upload by default (`requestChecksumCalculation:
 * "WHEN_SUPPORTED"`). For multipart uploads this means CreateMultipartUpload
 * declares CRC32, and CompleteMultipartUpload must list the checksum of every
 * part, which lib-storage takes from the UploadPart responses. Real S3 returns
 * them. Services that do not (Adobe S3Mock 5.x, and some versions of other
 * S3-compatible stores) reject the completion, so every object larger than one
 * part fails with "The complete request must include the checksum for each
 * part", while small objects work. Others reject the checksum headers outright.
 * For those services set `requestChecksumCalculation: "WHEN_REQUIRED"` (or
 * `?requestChecksumCalculation=WHEN_REQUIRED` on an `s3://` URL, or configure
 * your own `client` that way). Backups stay verified end to end either way:
 * every file's SHA-256 is in the manifest and checked on restore and verify.
 *
 * How the contract is met:
 * - Atomic writes: S3 objects only become visible when a PutObject or
 *   CompleteMultipartUpload succeeds, so a failed or aborted upload never
 *   leaves a partial object. (Uploaded parts of an aborted multipart upload are
 *   cleaned up with AbortMultipartUpload; also add a bucket lifecycle rule
 *   "AbortIncompleteMultipartUpload" as a safety net for crashed processes.)
 * - Conditional writes use `If-None-Match: *` (supported by S3 since 2024, and
 *   by MinIO and R2). A 412 response becomes MS_STORAGE_PRECONDITION_FAILED.
 * - Keys are stored under `prefix`, which is added on write and stripped on read.
 * - `lastModified` from `head()` and `list()` is always the server's value (S3
 *   keeps whole seconds; for multipart objects it is when the upload started).
 *   Upload responses carry no Last-Modified, so `put()` reports the local
 *   clock, unless `exactLastModified` asks for one HEAD request per put to read
 *   the server's value.
 * - Immutable backups use S3 Object Lock: a put with `retainUntil` sends
 *   `ObjectLockMode` (COMPLIANCE or GOVERNANCE, from the `retention` option) and
 *   `ObjectLockRetainUntilDate`. Quirks handled here:
 *   - The bucket must have Object Lock enabled. The first retained put checks with
 *     GetObjectLockConfiguration and fails with MS_CONFIG_INVALID if it is off.
 *   - S3 rejects Object Lock puts without an integrity header ("Content-MD5 OR
 *     x-amz-checksum-* HTTP header is required"). The SDK only adds checksums by
 *     default when the client uses `requestChecksumCalculation: "WHEN_SUPPORTED"`,
 *     so retained puts always ask for a CRC32 checksum explicitly; lib-storage
 *     then sends it on PutObject and on every UploadPart.
 *   - Object Lock buckets are versioned. Deleting without a version id (what
 *     `delete` does) succeeds but only adds a delete marker: the locked version
 *     stays, and is billed, until its retention ends and a lifecycle rule
 *     expires it. Prune therefore never deletes before `immutableUntil`.
 */

import { Readable } from "node:stream";
import type * as ClientS3 from "@aws-sdk/client-s3";
import type {
  S3Client,
  S3ClientConfig,
  ServerSideEncryption,
  StorageClass,
} from "@aws-sdk/client-s3";
import type * as LibStorage from "@aws-sdk/lib-storage";
import { abortError, MongoShieldError, throwIfAborted } from "../errors.ts";
import {
  chunk,
  countBytes,
  destroyOnAbort,
  messageOf,
  missingPackageError,
  normalizePrefix,
  propertyOf,
  storageKeyOf,
  storagePrefixOf,
  unquote,
} from "./adapter-utils.ts";
import { assertValidKey, assertValidPrefix } from "./keys.ts";
import {
  assertValidRetainUntil,
  IMMUTABLE_GUIDE,
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

/** Options for {@link s3Storage}. */
export interface S3StorageOptions {
  /** Bucket name (no `s3://`, no slashes). */
  readonly bucket: string;
  /**
   * Key prefix inside the bucket, e.g. `"prod/mongo"`. A trailing `/` is added
   * if missing, so objects land at `prod/mongo/<key>`. Defaults to the bucket root.
   */
  readonly prefix?: string;
  /**
   * AWS region. Defaults to the SDK's usual lookup (`AWS_REGION`, config files),
   * or to `"us-east-1"` when a custom `endpoint` is set (most S3-compatible
   * services ignore the region; R2 wants `"auto"`).
   */
  readonly region?: string;
  /** Custom endpoint URL for S3-compatible services, e.g. `http://localhost:9000`. */
  readonly endpoint?: string;
  /** Use path-style URLs (`https://host/bucket/key`). Needed by MinIO and most self-hosted stores. */
  readonly forcePathStyle?: boolean;
  /** Static credentials or a credential provider. Defaults to the SDK's default provider chain. */
  readonly credentials?: S3ClientConfig["credentials"];
  /**
   * An existing `S3Client` to use instead of creating one. When given, `region`,
   * `endpoint`, `forcePathStyle` and `credentials` are ignored, and `close()`
   * leaves the client open (you own it).
   */
  readonly client?: S3Client;
  /**
   * Multipart part size in bytes (minimum 5 MiB, default 16 MiB). S3 allows at
   * most 10,000 parts, so without a `sizeHint` the largest object is
   * `partSize × 10,000` (160 GiB at the default). Memory use per upload is
   * about `partSize × queueSize`.
   */
  readonly partSize?: number;
  /** How many parts of one object are uploaded in parallel (default 4). */
  readonly queueSize?: number;
  /** Storage class for new objects, e.g. `"STANDARD_IA"` or `"GLACIER_IR"`. */
  readonly storageClass?: StorageClass;
  /** Server-side encryption for new objects, e.g. `"AES256"` or `"aws:kms"`. */
  readonly serverSideEncryption?: ServerSideEncryption;
  /** KMS key id or ARN, used with `serverSideEncryption: "aws:kms"`. */
  readonly sseKmsKeyId?: string;
  /**
   * When the SDK computes request checksums, for a client created by the adapter:
   * the SDK default `"WHEN_SUPPORTED"` (every upload carries a CRC32), or
   * `"WHEN_REQUIRED"` for S3-compatible services that reject those checksums or
   * fail multipart uploads with them (see the header comment). Ignored with `client`.
   */
  readonly requestChecksumCalculation?: "WHEN_SUPPORTED" | "WHEN_REQUIRED";
  /**
   * Make `put()` report the server's Last-Modified time instead of the local
   * clock, at the cost of one HEAD request per put (for the exact version just
   * written). Useful when callers compare put results with `list()`/`head()`
   * output or when the local clock is not trusted. If that HEAD fails, the put
   * still succeeds and reports the local clock. Default `false`.
   */
  readonly exactLastModified?: boolean;
  /**
   * Object Lock mode for puts with `retainUntil` (immutable backups). Defaults to
   * `{ mode: "compliance" }`: not even the root account can delete the objects
   * early. `"governance"` lets principals with `s3:BypassGovernanceRetention`
   * lift the lock. The bucket must have Object Lock enabled.
   * See docs/guides/immutable-backups.md.
   */
  readonly retention?: RetentionOptions;
}

/** 16 MiB: large enough to keep request counts low, small enough to bound memory. */
const DEFAULT_PART_SIZE = 16 * 1024 * 1024;
/** S3's minimum size for every part except the last. */
const MIN_PART_SIZE = 5 * 1024 * 1024;
/** S3's maximum number of parts in one multipart upload. */
const MAX_PARTS = 10_000;
const DEFAULT_QUEUE_SIZE = 4;
/** DeleteObjects accepts at most 1000 keys per request. */
const DELETE_BATCH_SIZE = 1000;
/** Region used with a custom endpoint when none is configured. */
const DEFAULT_ENDPOINT_REGION = "us-east-1";

const INSTALL_HINT = "npm install @aws-sdk/client-s3 @aws-sdk/lib-storage";

const CAPABILITIES: StorageCapabilities = {
  conditionalWrites: true,
  rangeReads: true,
  // Object Lock. Whether the bucket has it enabled is checked at the first retained put.
  objectLock: true,
};

/** Our retention modes in S3's vocabulary. */
const OBJECT_LOCK_MODES = { compliance: "COMPLIANCE", governance: "GOVERNANCE" } as const;

/** The lazily imported SDK modules. */
interface AwsSdk {
  readonly s3: typeof ClientS3;
  readonly storage: typeof LibStorage;
}

/** Everything an operation needs; created once per adapter on first use. */
interface S3Context {
  readonly sdk: AwsSdk;
  readonly client: S3Client;
}

/** What an adapter call was doing, used in error messages ("Could not read …"). */
type Operation = "read" | "write" | "stat" | "list" | "delete";

/** Creates a storage adapter backed by an S3 (or S3-compatible) bucket. */
export function s3Storage(options: S3StorageOptions): StorageAdapter {
  const bucket = validBucket(options.bucket);
  const basePrefix = normalizePrefix(options.prefix, "S3");
  const partSize = validPartSize(options.partSize);
  const queueSize = validQueueSize(options.queueSize);
  const location = `s3://${bucket}/${basePrefix}`;
  const ownsClient = options.client === undefined;
  const retentionMode: RetentionMode = resolveRetentionMode(options.retention, "S3");

  // The client is created lazily and shared by every call: it holds only
  // connection pools and configuration, never per-run state.
  let contextPromise: Promise<S3Context> | undefined;

  function context(): Promise<S3Context> {
    if (!contextPromise) {
      contextPromise = createContext(options);
      // Do not cache a failure (for example a missing SDK); the next call retries.
      contextPromise.catch(() => {
        contextPromise = undefined;
      });
    }
    return contextPromise;
  }

  /** The full object key in the bucket for a storage key. */
  function objectKey(key: string): string {
    return basePrefix + key;
  }

  function fail(
    error: unknown,
    operation: Operation,
    key: string,
    signal?: AbortSignal,
  ): MongoShieldError {
    return s3Error(error, { operation, target: `${location}${key}`, bucket, basePrefix, signal });
  }

  /**
   * Checks once per adapter that the bucket has Object Lock enabled, so a
   * misconfigured bucket fails with a clear MS_CONFIG_INVALID before the first
   * byte is uploaded, instead of with a cryptic 400 after it.
   */
  const ensureObjectLockEnabled = onceSuccessful(async () => {
    const { sdk, client } = await context();
    let enabled: string | undefined;
    try {
      const response = await client.send(
        new sdk.s3.GetObjectLockConfigurationCommand({ Bucket: bucket }),
      );
      enabled = response.ObjectLockConfiguration?.ObjectLockEnabled;
    } catch (error) {
      const name = errorName(error);
      // Reading the configuration needs s3:GetBucketObjectLockConfiguration, which
      // a least-privilege backup role may lack. Then skip the check: the put
      // itself is rejected with a clear error if Object Lock is off (see s3Error).
      if (FORBIDDEN_NAMES.has(name ?? "") || httpStatus(error) === 403) return;
      // S3 answers 404 ObjectLockConfigurationNotFoundError when Object Lock was
      // never enabled; S3-compatible stores without the feature answer 501.
      if (name !== "ObjectLockConfigurationNotFoundError" && !isNotImplemented(error)) {
        throw fail(error, "write", "", undefined);
      }
    }
    if (enabled !== "Enabled") throw objectLockDisabledError(bucket, location);
  });

  /** Upload part size: the configured one, grown if `sizeHint` would need more than 10,000 parts. */
  function partSizeFor(sizeHint: number | undefined): number {
    if (sizeHint === undefined || sizeHint <= 0) return partSize;
    return Math.max(partSize, Math.ceil(sizeHint / MAX_PARTS));
  }

  async function put(
    key: string,
    body: Readable | Uint8Array,
    putOptions: PutOptions = {},
  ): Promise<ObjectInfo> {
    assertValidKey(key);
    const { signal, retainUntil } = putOptions;
    throwIfAborted(signal);
    if (retainUntil !== undefined) assertValidRetainUntil(retainUntil, `${location}${key}`);

    let upload: LibStorage.Upload | undefined;
    // The Upload gets its own controller: lib-storage assigns `signal.onabort`,
    // which would clobber a handler on the caller's signal.
    const uploadController = new AbortController();
    const onAbort = () => uploadController.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    const counter = { bytes: 0 };

    try {
      const { sdk, client } = await context();
      if (retainUntil !== undefined) await ensureObjectLockEnabled();
      throwIfAborted(signal);
      // lib-storage sends small bodies as one PutObject and large ones as a
      // multipart upload, streaming parts with bounded memory either way.
      upload = new sdk.storage.Upload({
        client,
        partSize: partSizeFor(putOptions.sizeHint),
        queueSize,
        leavePartsOnError: false,
        abortController: uploadController,
        params: {
          Bucket: bucket,
          Key: objectKey(key),
          Body: body instanceof Readable ? countBytes(body, counter) : body,
          ContentType: putOptions.contentType,
          // Sent on PutObject and CompleteMultipartUpload, so it covers both paths.
          IfNoneMatch: putOptions.ifNoneMatch,
          StorageClass: options.storageClass,
          ServerSideEncryption: options.serverSideEncryption,
          SSEKMSKeyId: options.sseKmsKeyId,
          ...(retainUntil === undefined ? {} : objectLockParams(retentionMode, retainUntil)),
        },
      });
      const result = await upload.done();
      const size = body instanceof Readable ? counter.bytes : body.byteLength;
      const etag = unquote(result.ETag);
      // Neither PutObject nor CompleteMultipartUpload responses carry a
      // Last-Modified, so the local clock is used unless the caller asked for
      // the server's value (one HEAD request).
      const lastModified = options.exactLastModified
        ? await serverLastModified(key, result, signal)
        : new Date();
      return { key, size, lastModified, ...(etag ? { etag } : {}) };
    } catch (error) {
      if (body instanceof Readable) body.destroy();
      await abortDanglingUpload(upload, key);
      throw fail(error, "write", key, signal);
    } finally {
      signal?.removeEventListener("abort", onAbort);
    }
  }

  /**
   * Reads the Last-Modified time of the object a put just wrote. The HEAD names
   * that exact object, by version id in versioned buckets and otherwise with
   * If-Match on its ETag, so a concurrent overwrite is never mistaken for ours.
   * Falls back to the local clock if the HEAD fails: the object is written, and
   * failing the put now would invite a retry that rewrites it.
   */
  async function serverLastModified(
    key: string,
    result: { readonly ETag?: string | undefined; readonly VersionId?: string | undefined },
    signal: AbortSignal | undefined,
  ): Promise<Date> {
    try {
      const { sdk, client } = await context();
      const response = await client.send(
        new sdk.s3.HeadObjectCommand({
          Bucket: bucket,
          Key: objectKey(key),
          ...(result.VersionId ? { VersionId: result.VersionId } : {}),
          ...(!result.VersionId && result.ETag ? { IfMatch: result.ETag } : {}),
        }),
        sendOptions(signal),
      );
      return response.LastModified ?? new Date();
    } catch (error) {
      if (signal?.aborted) throw error;
      return new Date();
    }
  }

  /**
   * lib-storage aborts multipart uploads when a part fails, but not when the
   * final CompleteMultipartUpload is rejected (for example by If-None-Match).
   * Abort it here so no parts are left behind. Best effort.
   */
  async function abortDanglingUpload(
    upload: LibStorage.Upload | undefined,
    key: string,
  ): Promise<void> {
    const uploadId = upload?.uploadId;
    if (!uploadId) return;
    try {
      const { sdk, client } = await context();
      await client.send(
        new sdk.s3.AbortMultipartUploadCommand({
          Bucket: bucket,
          Key: objectKey(key),
          UploadId: uploadId,
        }),
      );
    } catch {
      // Already aborted or completed; the lifecycle rule is the final safety net.
    }
  }

  async function get(key: string, getOptions: GetOptions = {}): Promise<Readable> {
    assertValidKey(key);
    const { signal, range } = getOptions;
    throwIfAborted(signal);
    try {
      const { sdk, client } = await context();
      const response = await client.send(
        new sdk.s3.GetObjectCommand({
          Bucket: bucket,
          Key: objectKey(key),
          Range: range ? httpRange(range) : undefined,
        }),
        sendOptions(signal),
      );
      const body = response.Body;
      if (!(body instanceof Readable)) {
        throw new MongoShieldError("MS_STORAGE_IO", `S3 returned no readable body for ${key}.`);
      }
      destroyOnAbort(body, signal);
      return body;
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
      const { sdk, client } = await context();
      const response = await client.send(
        new sdk.s3.HeadObjectCommand({ Bucket: bucket, Key: objectKey(key) }),
        sendOptions(signal),
      );
      return objectInfo(key, response.ContentLength, response.LastModified, response.ETag);
    } catch (error) {
      // HEAD responses have no body, so a missing key shows up as a bare 404 "NotFound".
      if (isNotFound(error) && errorName(error) !== "NoSuchBucket") return undefined;
      throw fail(error, "stat", key, signal);
    }
  }

  async function* list(prefix: string, listOptions: SignalOptions = {}) {
    assertValidPrefix(prefix);
    const { signal } = listOptions;
    throwIfAborted(signal);
    const { sdk, client } = await context().catch((error: unknown) => {
      throw fail(error, "list", prefix, signal);
    });

    // ListObjectsV2 returns at most 1000 keys per page, already in UTF-8 byte
    // order; follow NextContinuationToken until the listing is no longer truncated.
    let continuationToken: string | undefined;
    do {
      throwIfAborted(signal);
      let page: ClientS3.ListObjectsV2CommandOutput;
      try {
        page = await client.send(
          new sdk.s3.ListObjectsV2Command({
            Bucket: bucket,
            Prefix: objectKey(prefix),
            ContinuationToken: continuationToken,
          }),
          sendOptions(signal),
        );
      } catch (error) {
        throw fail(error, "list", prefix, signal);
      }
      for (const item of page.Contents ?? []) {
        const key = storageKeyOf(basePrefix, item.Key);
        if (key !== undefined) yield objectInfo(key, item.Size, item.LastModified, item.ETag);
      }
      continuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (continuationToken);
  }

  async function* listPrefixes(prefix: string, listOptions: SignalOptions = {}) {
    assertValidPrefix(prefix);
    const { signal } = listOptions;
    throwIfAborted(signal);
    const { sdk, client } = await context().catch((error: unknown) => {
      throw fail(error, "list", prefix, signal);
    });

    // With Delimiter "/", S3 rolls every key below the next "/" up into one
    // CommonPrefixes entry (e.g. "base/backups/2026-…/"). Pages are ordered,
    // and a common prefix never repeats across pages.
    let continuationToken: string | undefined;
    do {
      throwIfAborted(signal);
      let page: ClientS3.ListObjectsV2CommandOutput;
      try {
        page = await client.send(
          new sdk.s3.ListObjectsV2Command({
            Bucket: bucket,
            Prefix: objectKey(prefix),
            Delimiter: "/",
            ContinuationToken: continuationToken,
          }),
          sendOptions(signal),
        );
      } catch (error) {
        throw fail(error, "list", prefix, signal);
      }
      for (const common of page.CommonPrefixes ?? []) {
        // Console folder markers and names outside our prefix are skipped.
        const prefixKey = storagePrefixOf(basePrefix, common.Prefix);
        if (prefixKey !== undefined) yield prefixKey;
      }
      continuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (continuationToken);
  }

  async function deleteObjects(keys: readonly string[], deleteOptions: SignalOptions = {}) {
    const { signal } = deleteOptions;
    throwIfAborted(signal);
    // Validate everything first so an invalid key cannot leave a half-done delete.
    for (const key of keys) assertValidKey(key);
    if (keys.length === 0) return;
    const { sdk, client } = await context().catch((error: unknown) => {
      throw fail(error, "delete", keys[0] ?? "", signal);
    });

    for (const batch of chunk(keys, DELETE_BATCH_SIZE)) {
      throwIfAborted(signal);
      let response: ClientS3.DeleteObjectsCommandOutput;
      try {
        response = await client.send(
          new sdk.s3.DeleteObjectsCommand({
            Bucket: bucket,
            // Quiet mode: the response only lists failures, not every deleted key.
            Delete: { Objects: batch.map((key) => ({ Key: objectKey(key) })), Quiet: true },
          }),
          sendOptions(signal),
        );
      } catch (error) {
        throw fail(error, "delete", batch[0] ?? "", signal);
      }
      throwIfDeleteFailed(response.Errors ?? []);
    }
  }

  /**
   * DeleteObjects answers 200 even when some keys failed; the failures are
   * listed per key in `Errors`. Deleting a missing key is not a failure in S3,
   * but some compatible stores report NoSuchKey, which we ignore.
   */
  function throwIfDeleteFailed(errors: readonly ClientS3._Error[]): void {
    const failures = errors.filter((entry) => entry.Code !== "NoSuchKey");
    const first = failures[0];
    if (!first) return;
    const key = storageKeyOf(basePrefix, first.Key) ?? first.Key ?? "";
    const others = failures.length > 1 ? ` (and ${failures.length - 1} more)` : "";
    const cause = Object.assign(new Error(first.Message ?? "delete failed"), {
      name: first.Code ?? "DeleteFailed",
    });
    throw fail(cause, "delete", `${key}${others}`);
  }

  return {
    kind: "s3",
    location,
    capabilities: CAPABILITIES,
    put,
    get,
    head,
    list,
    listPrefixes,
    delete: deleteObjects,
    async close() {
      const pending = contextPromise;
      contextPromise = undefined;
      if (!pending || !ownsClient) return;
      const created = await pending.catch(() => undefined);
      created?.client.destroy();
    },
  };
}

/**
 * PutObject / CreateMultipartUpload parameters for a retained object. lib-storage
 * copies them onto every request of a multipart upload, which is what we want for
 * the checksum (each UploadPart must carry one) and harmless for the lock fields
 * (UploadPart ignores them; S3 applies the lock from CreateMultipartUpload).
 */
function objectLockParams(
  mode: RetentionMode,
  retainUntil: Date,
): Pick<
  ClientS3.PutObjectCommandInput,
  "ObjectLockMode" | "ObjectLockRetainUntilDate" | "ChecksumAlgorithm"
> {
  return {
    ObjectLockMode: OBJECT_LOCK_MODES[mode],
    ObjectLockRetainUntilDate: retainUntil,
    // Object Lock puts must carry Content-MD5 or an x-amz-checksum-* header.
    ChecksumAlgorithm: "CRC32",
  };
}

/** The error for a bucket without Object Lock, with instructions to enable it. */
function objectLockDisabledError(
  bucket: string,
  location: string,
  cause?: unknown,
): MongoShieldError {
  return new MongoShieldError(
    "MS_CONFIG_INVALID",
    `Cannot write immutable objects to ${location}: Object Lock is not enabled on bucket "${bucket}".`,
    {
      ...(cause === undefined ? {} : { cause }),
      hint:
        `Enable versioning and then Object Lock on the bucket (console: Properties → Object Lock, or ` +
        `aws s3api put-object-lock-configuration --bucket ${bucket} ` +
        `--object-lock-configuration ObjectLockEnabled=Enabled), or drop retainDays. ` +
        `S3-compatible stores without Object Lock cannot hold immutable backups. See ${IMMUTABLE_GUIDE}.`,
    },
  );
}

/** Imports the SDK and builds (or adopts) the client. */
async function createContext(options: S3StorageOptions): Promise<S3Context> {
  const sdk = await loadAwsSdk();
  if (options.client) return { sdk, client: options.client };
  const region = options.region ?? (options.endpoint ? DEFAULT_ENDPOINT_REGION : undefined);
  const client = new sdk.s3.S3Client({
    ...(region === undefined ? {} : { region }),
    ...(options.endpoint === undefined ? {} : { endpoint: options.endpoint }),
    ...(options.forcePathStyle === undefined ? {} : { forcePathStyle: options.forcePathStyle }),
    ...(options.credentials === undefined ? {} : { credentials: options.credentials }),
    ...(options.requestChecksumCalculation === undefined
      ? {}
      : { requestChecksumCalculation: options.requestChecksumCalculation }),
  });
  return { sdk, client };
}

/**
 * Loads the optional AWS SDK packages. They are peer dependencies so that users
 * who only back up to disk never install them; a missing package becomes a
 * clear configuration error with the install command as the hint.
 */
async function loadAwsSdk(): Promise<AwsSdk> {
  try {
    const [s3, storage] = await Promise.all([
      import("@aws-sdk/client-s3"),
      import("@aws-sdk/lib-storage"),
    ]);
    return { s3, storage };
  } catch (error) {
    throw missingPackageError(error, "S3 storage", INSTALL_HINT);
  }
}

function validBucket(bucket: string): string {
  if (typeof bucket !== "string" || bucket.length === 0 || bucket.includes("/")) {
    throw new MongoShieldError("MS_CONFIG_INVALID", `Invalid S3 bucket name "${String(bucket)}".`, {
      hint: 'Pass just the bucket name, e.g. { bucket: "my-backups", prefix: "prod/" }.',
    });
  }
  return bucket;
}

function validPartSize(partSize: number | undefined): number {
  if (partSize === undefined) return DEFAULT_PART_SIZE;
  if (!Number.isSafeInteger(partSize) || partSize < MIN_PART_SIZE) {
    throw new MongoShieldError(
      "MS_CONFIG_INVALID",
      `S3 partSize must be an integer of at least ${MIN_PART_SIZE} bytes (5 MiB), got ${partSize}.`,
    );
  }
  return partSize;
}

function validQueueSize(queueSize: number | undefined): number {
  if (queueSize === undefined) return DEFAULT_QUEUE_SIZE;
  if (!Number.isSafeInteger(queueSize) || queueSize < 1) {
    throw new MongoShieldError(
      "MS_CONFIG_INVALID",
      `S3 queueSize must be a positive integer, got ${queueSize}.`,
    );
  }
  return queueSize;
}

/** An HTTP Range header for an inclusive range: `bytes=2-5`, or `bytes=7-` to the end. */
function httpRange(range: { readonly start: number; readonly end?: number }): string {
  return `bytes=${range.start}-${range.end ?? ""}`;
}

/** Per-request options for `client.send`; the SDK cancels the HTTP request on abort. */
function sendOptions(signal: AbortSignal | undefined): { abortSignal?: AbortSignal } {
  return signal ? { abortSignal: signal } : {};
}

function objectInfo(
  key: string,
  size: number | undefined,
  lastModified: Date | undefined,
  rawEtag: string | undefined,
): ObjectInfo {
  const etag = unquote(rawEtag);
  return {
    key,
    size: size ?? 0,
    lastModified: lastModified ?? new Date(0),
    ...(etag ? { etag } : {}),
  };
}

/** The SDK's error name (`NoSuchKey`, `AccessDenied`, …). */
function errorName(error: unknown): string | undefined {
  const name = propertyOf(error, "name");
  return typeof name === "string" ? name : undefined;
}

/** The HTTP status code the SDK attaches as `$metadata.httpStatusCode`. */
function httpStatus(error: unknown): number | undefined {
  const status = propertyOf(propertyOf(error, "$metadata"), "httpStatusCode");
  return typeof status === "number" ? status : undefined;
}

/** 501 NotImplemented: an S3-compatible store that lacks the feature (e.g. Object Lock). */
function isNotImplemented(error: unknown): boolean {
  return errorName(error) === "NotImplemented" || httpStatus(error) === 501;
}

/**
 * True for S3's rejection of an Object Lock put on a bucket without Object Lock
 * ("InvalidRequest: Bucket is missing Object Lock Configuration"). Reached when
 * the up-front check was skipped for lack of permission.
 */
function isObjectLockNotConfigured(error: unknown): boolean {
  const name = errorName(error);
  const reason = messageOf(error);
  return (
    (name === "InvalidRequest" || name === "InvalidArgument" || httpStatus(error) === 400) &&
    /missing object lock configuration/i.test(reason)
  );
}

/**
 * True for a CompleteMultipartUpload refused because the per-part checksums are
 * missing: the service declared CRC32 at CreateMultipartUpload but did not
 * return the parts' checksums for lib-storage to send back (see the header).
 */
function isMissingPartChecksums(error: unknown): boolean {
  const reason = messageOf(error);
  return /checksum for each part|checksum.*missing for part/i.test(reason);
}

function isNotFound(error: unknown): boolean {
  const name = errorName(error);
  return (
    name === "NoSuchKey" ||
    name === "NotFound" ||
    name === "NoSuchBucket" ||
    httpStatus(error) === 404
  );
}

const FORBIDDEN_NAMES = new Set([
  "AccessDenied",
  "Forbidden",
  "AllAccessDisabled",
  "InvalidAccessKeyId",
  "SignatureDoesNotMatch",
  "CredentialsProviderError",
]);

/** Context for {@link s3Error}. */
interface S3ErrorContext {
  readonly operation: Operation;
  readonly target: string;
  readonly bucket: string;
  readonly basePrefix: string;
  readonly signal?: AbortSignal | undefined;
}

/**
 * Maps an SDK error to a `MongoShieldError`. The SDK reports S3 error codes as
 * the exception `name` and the HTTP status in `$metadata`; we check both
 * because S3-compatible services are not always consistent about either.
 */
function s3Error(error: unknown, context: S3ErrorContext): MongoShieldError {
  const { operation, target, bucket, basePrefix, signal } = context;
  if (signal?.aborted) return abortError(signal);
  if (error instanceof MongoShieldError) return error;

  const name = errorName(error) ?? "Error";
  const status = httpStatus(error);
  const reason = messageOf(error);
  const message = `Could not ${operation} ${target}: ${name}${reason ? `: ${reason}` : ""}`;
  const requestId = propertyOf(propertyOf(error, "$metadata"), "requestId");
  const details = {
    ...(status === undefined ? {} : { httpStatusCode: status }),
    ...(typeof requestId === "string" ? { requestId } : {}),
  };
  const base = { cause: error, details };

  if (name === "AbortError") return new MongoShieldError("MS_ABORTED", message, base);
  if (operation === "write" && isObjectLockNotConfigured(error)) {
    return objectLockDisabledError(bucket, target, error);
  }
  if (name === "NoSuchBucket") {
    return new MongoShieldError("MS_STORAGE_NOT_FOUND", message, {
      ...base,
      hint: `Create the bucket "${bucket}", or check the bucket name, region and endpoint.`,
    });
  }
  if (isNotFound(error)) return new MongoShieldError("MS_STORAGE_NOT_FOUND", message, base);
  if (FORBIDDEN_NAMES.has(name) || status === 403) {
    return new MongoShieldError("MS_STORAGE_FORBIDDEN", message, {
      ...base,
      hint:
        `Check the credentials, and that the IAM policy allows s3:GetObject, s3:PutObject and ` +
        `s3:DeleteObject on arn:aws:s3:::${bucket}/${basePrefix}* and s3:ListBucket on ` +
        `arn:aws:s3:::${bucket} (plus kms:GenerateDataKey and kms:Decrypt when using SSE-KMS, ` +
        `and s3:PutObjectRetention for immutable backups).`,
    });
  }
  // 412: If-None-Match failed because the key exists. 409 ConditionalRequestConflict:
  // a concurrent conditional write to the same key won the race.
  if (name === "PreconditionFailed" || name === "ConditionalRequestConflict" || status === 412) {
    return new MongoShieldError("MS_STORAGE_PRECONDITION_FAILED", message, base);
  }
  if (operation === "write" && isMissingPartChecksums(error)) {
    return new MongoShieldError("MS_STORAGE_IO", message, {
      ...base,
      hint:
        'This S3-compatible service does not support the SDK\'s default upload checksums for multipart uploads. Set requestChecksumCalculation: "WHEN_REQUIRED" ' +
        "(s3:// URLs: ?requestChecksumCalculation=WHEN_REQUIRED), or pass a client configured that way.",
    });
  }
  return new MongoShieldError("MS_STORAGE_IO", message, base);
}
