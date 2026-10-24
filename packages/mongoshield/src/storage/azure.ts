/**
 * Azure Blob Storage adapter (entry point `mongoshield/storage/azure`).
 *
 *   import { azureStorage } from "mongoshield/storage/azure";
 *   // Microsoft Entra ID via DefaultAzureCredential (env vars, managed identity, `az login`):
 *   const storage = azureStorage({
 *     accountUrl: "https://myaccount.blob.core.windows.net",
 *     container: "backups",
 *     prefix: "prod/",
 *   });
 *   // or a connection string (includes the account key; keep it out of logs):
 *   azureStorage({ connectionString: process.env.AZURE_STORAGE_CONNECTION_STRING, container: "backups" });
 *
 * The Azure SDK is an optional peer dependency, loaded lazily on first use:
 *
 *   npm install @azure/storage-blob            # plus @azure/identity for DefaultAzureCredential
 *
 * Exactly one way of connecting must be given: `connectionString`, `accountUrl`
 * (optionally with a `credential`, or a SAS token in its query string), or an
 * existing `containerClient`.
 *
 * How the contract is met:
 * - Atomic writes: buffers go up in a single Put Blob request; streams are
 *   staged as uncommitted blocks and become visible only when Put Block List
 *   commits them. A failed or aborted upload never commits, and Azure discards
 *   uncommitted blocks after a week; they never show up in listings or reads.
 * - Conditional writes send `If-None-Match: *` on Put Blob / Put Block List.
 *   Azure answers 409 BlobAlreadyExists (or 412 ConditionNotMet), which become
 *   MS_STORAGE_PRECONDITION_FAILED.
 * - Integrity: Azure computes and stores an MD5 for single-shot uploads and
 *   checks every block's transfer; downloads retry broken connections from
 *   the last byte received (`maxRetryRequests`).
 * - Listing uses `listBlobsFlat` (5000 names per page, in lexicographic order);
 *   `listPrefixes` uses `listBlobsByHierarchy("/")`.
 * - Deletes use Blob Batch (up to 256 deletes per request). Where the batch API
 *   is unavailable (some emulators and SAS setups) the adapter falls back to
 *   individual deletes with bounded concurrency and remembers that choice.
 * - Immutable backups use blob immutability policies: a put with `retainUntil`
 *   sends `immutabilityPolicy: { expiriesOn, policyMode }` (`Locked` for
 *   compliance, `Unlocked` for governance) on Put Blob, or on the final Put Block
 *   List for streams, so the blob is locked from the moment it becomes visible.
 *   Quirks:
 *   - The container (or account) must have version-level immutability support
 *     enabled. The first retained put checks the container's
 *     `isImmutableStorageWithVersioningEnabled` and fails with MS_CONFIG_INVALID
 *     if it is off. If the identity may not read container properties, the check
 *     is skipped and Azure's own rejection is mapped to the same error.
 *   - `uploadData`/`uploadStream` forward their options to Put Blob / Put Block
 *     List, which accept `immutabilityPolicy`, but SDK 12.x does not declare the
 *     field on the parallel-upload option types. We pass it anyway (tests pin it).
 *   - Deleting or overwriting a locked blob fails with 409
 *     BlobImmutableDueToPolicy, mapped to MS_STORAGE_FORBIDDEN.
 */

import { Readable } from "node:stream";
import type * as AzureBlobSdk from "@azure/storage-blob";
import type {
  BlobBatchDeleteBlobsResponse,
  ContainerClient,
  newPipeline,
} from "@azure/storage-blob";
import { abortError, MongoShieldError, throwIfAborted } from "../errors.ts";
import {
  assertValidRange,
  chunk,
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

/**
 * Any credential the Azure SDK accepts: `StorageSharedKeyCredential`,
 * `AnonymousCredential` or a `TokenCredential` such as `DefaultAzureCredential`.
 * (Taken from `newPipeline`'s signature because `TokenCredential` lives in
 * `@azure/core-auth`, which is not a direct dependency.)
 */
export type AzureStorageCredential = NonNullable<Parameters<typeof newPipeline>[0]>;

/** Options for {@link azureStorage}. */
export interface AzureStorageOptions {
  /** Container name. Ignored when `containerClient` is given. */
  readonly container?: string;
  /**
   * Blob name prefix inside the container, e.g. `"prod/mongo"`. A trailing `/`
   * is added if missing, so blobs land at `prod/mongo/<key>`. Defaults to the
   * container root.
   */
  readonly prefix?: string;
  /**
   * A storage account connection string (`DefaultEndpointsProtocol=…;AccountName=…;AccountKey=…`
   * or `UseDevelopmentStorage=true` for Azurite). It contains a secret: load it
   * from the environment or a secret store, never from a config file in git.
   */
  readonly connectionString?: string;
  /**
   * The blob service URL, e.g. `https://myaccount.blob.core.windows.net`. May
   * carry a SAS token as its query string (then no `credential` is needed).
   */
  readonly accountUrl?: string;
  /**
   * Credential for `accountUrl`. Defaults to `DefaultAzureCredential` from
   * `@azure/identity` (environment variables, workload/managed identity, Azure
   * CLI login), unless `accountUrl` carries a SAS token.
   */
  readonly credential?: AzureStorageCredential;
  /** An existing `ContainerClient` to use instead of creating one. */
  readonly containerClient?: ContainerClient;
  /**
   * Block size for streamed uploads in bytes (default 8 MiB, at most 4000 MiB).
   * Azure allows 50,000 blocks per blob, so without a `sizeHint` the largest
   * object is `blockSize × 50,000` (≈390 GiB at the default). Memory use per
   * upload is about `blockSize × uploadConcurrency`.
   */
  readonly blockSize?: number;
  /** How many blocks of one stream are uploaded in parallel (default 4). */
  readonly uploadConcurrency?: number;
  /** How many individual deletes run in parallel when Blob Batch is unavailable (default 16). */
  readonly deleteConcurrency?: number;
  /**
   * Immutability policy mode for puts with `retainUntil` (immutable backups).
   * Defaults to `{ mode: "compliance" }` (Azure `Locked`); `"governance"` uses
   * `Unlocked`, which an account owner can still shorten or remove. The container
   * needs version-level immutability support. See docs/guides/immutable-backups.md.
   */
  readonly retention?: RetentionOptions;
}

const MiB = 1024 * 1024;
const DEFAULT_BLOCK_SIZE = 8 * MiB;
/** Azure's maximum block size for Put Block (service version 2019-12-12 and later). */
const MAX_BLOCK_SIZE = 4000 * MiB;
/** Azure's maximum number of committed blocks in one blob. */
const MAX_BLOCKS = 50_000;
const DEFAULT_UPLOAD_CONCURRENCY = 4;
const DEFAULT_DELETE_CONCURRENCY = 16;
/** Blob Batch accepts at most 256 sub-requests. */
const BATCH_SIZE = 256;
/** The largest page `List Blobs` returns. */
const LIST_PAGE_SIZE = 5000;
/** How often a broken download stream is resumed from its last byte. */
const DOWNLOAD_RETRIES = 5;
/** Azurite's well-known development account, used by `UseDevelopmentStorage=true`. */
const DEVELOPMENT_ACCOUNT = "devstoreaccount1";

const INSTALL_HINT = "npm install @azure/storage-blob";
const IDENTITY_INSTALL_HINT = "npm install @azure/identity";

const CAPABILITIES: StorageCapabilities = {
  conditionalWrites: true,
  rangeReads: true,
  // Blob immutability policies. The container setup is checked at the first retained put.
  objectLock: true,
};

/** Our retention modes in Azure's vocabulary. */
const AZURE_POLICY_MODES = { compliance: "Locked", governance: "Unlocked" } as const;

/** What an adapter call was doing, used in error messages ("Could not read …"). */
type Operation = "read" | "write" | "stat" | "list" | "delete";

/** Creates a storage adapter backed by an Azure Blob Storage container. */
export function azureStorage(options: AzureStorageOptions): StorageAdapter {
  const { account, container } = describeTarget(options);
  const basePrefix = normalizePrefix(options.prefix, "Azure");
  const blockSize = validSize(options.blockSize, DEFAULT_BLOCK_SIZE, "blockSize", MAX_BLOCK_SIZE);
  const uploadConcurrency = validCount(
    options.uploadConcurrency,
    DEFAULT_UPLOAD_CONCURRENCY,
    "uploadConcurrency",
  );
  const deleteConcurrency = validCount(
    options.deleteConcurrency,
    DEFAULT_DELETE_CONCURRENCY,
    "deleteConcurrency",
  );
  const location = `az://${account}/${container}/${basePrefix}`;
  const retentionMode: RetentionMode = resolveRetentionMode(options.retention, "Azure");

  // The client is created lazily and shared by every call: it holds only a
  // request pipeline and credentials, never per-run state.
  let clientPromise: Promise<ContainerClient> | undefined;
  // Set once a batch request fails for a reason other than auth or abort, so
  // later deletes go straight to individual requests (see the header comment).
  let batchUnavailable = false;

  function client(): Promise<ContainerClient> {
    if (!clientPromise) {
      clientPromise = createContainerClient(options);
      // Do not cache a failure (for example a missing SDK); the next call retries.
      clientPromise.catch(() => {
        clientPromise = undefined;
      });
    }
    return clientPromise;
  }

  function fail(
    error: unknown,
    operation: Operation,
    key: string,
    signal?: AbortSignal,
  ): MongoShieldError {
    return azureError(error, { operation, target: `${location}${key}`, container, signal });
  }

  /**
   * Checks once per adapter that the container supports version-level
   * immutability, so a misconfigured container fails clearly before the first upload.
   */
  const ensureImmutabilitySupported = onceSuccessful(async () => {
    let supported: boolean | undefined;
    try {
      const properties = await (await client()).getProperties();
      supported = properties.isImmutableStorageWithVersioningEnabled;
    } catch (error) {
      // No permission to read container properties: skip (see the header comment).
      if (isForbidden(error)) return;
      throw fail(error, "write", "");
    }
    if (supported !== true) throw immutabilityDisabledError(container, location);
  });

  /** Upload block size: the configured one, grown if `sizeHint` would need more than 50,000 blocks. */
  function blockSizeFor(sizeHint: number | undefined): number {
    if (sizeHint === undefined || sizeHint <= 0) return blockSize;
    return Math.min(MAX_BLOCK_SIZE, Math.max(blockSize, Math.ceil(sizeHint / MAX_BLOCKS)));
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
    const counter = { bytes: 0 };
    try {
      const blob = (await client()).getBlockBlobClient(basePrefix + key);
      if (retainUntil !== undefined) await ensureImmutabilitySupported();
      throwIfAborted(signal);
      const common = {
        blobHTTPHeaders: { blobContentType: putOptions.contentType ?? "application/octet-stream" },
        // Checked by Azure on Put Blob and on the final Put Block List commit.
        conditions: putOptions.ifNoneMatch === "*" ? { ifNoneMatch: "*" } : {},
        ...(signal ? { abortSignal: signal } : {}),
        // Forwarded to Put Blob / Put Block List (see the header comment).
        ...(retainUntil === undefined
          ? {}
          : {
              immutabilityPolicy: {
                expiriesOn: retainUntil,
                policyMode: AZURE_POLICY_MODES[retentionMode],
              },
            }),
      };
      if (!(body instanceof Readable)) {
        const response = await blob.uploadData(Buffer.from(body), common);
        return uploadedInfo(key, body.byteLength, response.lastModified, response.etag);
      }
      // uploadStream does not pass the abort signal to its block uploads, so
      // destroying the source is what stops it; the commit never happens.
      const source = countBytes(body, counter);
      destroyOnAbort(source, signal);
      const response = await blob.uploadStream(
        source,
        blockSizeFor(putOptions.sizeHint),
        uploadConcurrency,
        common,
      );
      return uploadedInfo(key, counter.bytes, response.lastModified, response.etag);
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
      const blob = (await client()).getBlobClient(basePrefix + key);
      const offset = range?.start ?? 0;
      const count = range?.end === undefined ? undefined : range.end - range.start + 1;
      const response = await blob.download(offset, count, {
        maxRetryRequests: DOWNLOAD_RETRIES,
        ...(signal ? { abortSignal: signal } : {}),
      });
      const stream = response.readableStreamBody;
      if (!(stream instanceof Readable)) {
        throw new MongoShieldError("MS_STORAGE_IO", `Azure returned no readable body for ${key}.`);
      }
      destroyOnAbort(stream, signal);
      return stream;
    } catch (error) {
      // 416 InvalidRange: the range starts past the end (or the blob is empty).
      // Other adapters return an empty stream there, so we do too.
      if (range && httpStatus(error) === 416) return Readable.from([]);
      throw fail(error, "read", key, signal);
    }
  }

  async function head(key: string, headOptions: SignalOptions = {}) {
    assertValidKey(key);
    const { signal } = headOptions;
    throwIfAborted(signal);
    try {
      const blob = (await client()).getBlobClient(basePrefix + key);
      const properties = await blob.getProperties(signal ? { abortSignal: signal } : {});
      const etag = unquote(properties.etag);
      return {
        key,
        size: properties.contentLength ?? 0,
        lastModified: properties.lastModified ?? new Date(0),
        ...(etag ? { etag } : {}),
      };
    } catch (error) {
      // A missing blob is a normal answer; a missing container is still an error.
      if (httpStatus(error) === 404 && errorCode(error) !== "ContainerNotFound") return undefined;
      throw fail(error, "stat", key, signal);
    }
  }

  async function* list(prefix: string, listOptions: SignalOptions = {}) {
    assertValidPrefix(prefix);
    const { signal } = listOptions;
    throwIfAborted(signal);
    const container = await client().catch((error: unknown) => {
      throw fail(error, "list", prefix, signal);
    });
    const pages = container
      .listBlobsFlat({ prefix: basePrefix + prefix, ...(signal ? { abortSignal: signal } : {}) })
      .byPage({ maxPageSize: LIST_PAGE_SIZE });
    // byPage follows the continuation token (NextMarker) by itself.
    try {
      for await (const page of pages) {
        throwIfAborted(signal);
        for (const item of page.segment.blobItems) {
          const key = storageKeyOf(basePrefix, item.name);
          if (key === undefined) continue;
          const etag = unquote(item.properties.etag);
          yield {
            key,
            size: item.properties.contentLength ?? 0,
            lastModified: item.properties.lastModified,
            ...(etag ? { etag } : {}),
          };
        }
      }
    } catch (error) {
      throw fail(error, "list", prefix, signal);
    }
  }

  async function* listPrefixes(prefix: string, listOptions: SignalOptions = {}) {
    assertValidPrefix(prefix);
    const { signal } = listOptions;
    throwIfAborted(signal);
    const container = await client().catch((error: unknown) => {
      throw fail(error, "list", prefix, signal);
    });
    // With delimiter "/", Azure rolls every name below the next "/" up into one
    // BlobPrefix entry. Entries are ordered and never repeat across pages.
    const pages = container
      .listBlobsByHierarchy("/", {
        prefix: basePrefix + prefix,
        ...(signal ? { abortSignal: signal } : {}),
      })
      .byPage({ maxPageSize: LIST_PAGE_SIZE });
    try {
      for await (const page of pages) {
        throwIfAborted(signal);
        for (const blobPrefix of page.segment.blobPrefixes ?? []) {
          const storagePrefix = storagePrefixOf(basePrefix, blobPrefix.name);
          if (storagePrefix !== undefined) yield storagePrefix;
        }
      }
    } catch (error) {
      throw fail(error, "list", prefix, signal);
    }
  }

  async function deleteObjects(keys: readonly string[], deleteOptions: SignalOptions = {}) {
    const { signal } = deleteOptions;
    throwIfAborted(signal);
    // Validate everything first so an invalid key cannot leave a half-done delete.
    for (const key of keys) assertValidKey(key);
    if (keys.length === 0) return;
    const container = await client().catch((error: unknown) => {
      throw fail(error, "delete", keys[0] ?? "", signal);
    });

    for (const batch of chunk(keys, BATCH_SIZE)) {
      throwIfAborted(signal);
      if (!batchUnavailable && (await deleteBatch(container, batch, signal))) continue;
      await deleteIndividually(container, batch, signal);
    }
  }

  /**
   * Deletes up to 256 blobs in one Blob Batch request. Returns `false` (and
   * remembers it) when the batch endpoint itself is unusable, so the caller
   * falls back to individual deletes. Per-blob failures other than "not found"
   * are thrown.
   */
  async function deleteBatch(
    container: ContainerClient,
    batch: readonly string[],
    signal: AbortSignal | undefined,
  ): Promise<boolean> {
    let response: BlobBatchDeleteBlobsResponse;
    try {
      response = await container.getBlobBatchClient().deleteBlobs(
        batch.map((key) => container.getBlobClient(basePrefix + key)),
        signal ? { abortSignal: signal } : {},
      );
    } catch (error) {
      if (signal?.aborted || isForbidden(error))
        throw fail(error, "delete", batch[0] ?? "", signal);
      batchUnavailable = true;
      return false;
    }
    // Sub-responses are in request order. 404 BlobNotFound is fine: missing
    // keys are ignored by the contract.
    for (const [index, sub] of response.subResponses.entries()) {
      if (sub.status < 300 || sub.status === 404) continue;
      const cause = Object.assign(new Error(sub.statusMessage || "delete failed"), {
        statusCode: sub.status,
        code: sub.errorCode,
      });
      throw fail(cause, "delete", batch[index] ?? "", signal);
    }
    return true;
  }

  async function deleteIndividually(
    container: ContainerClient,
    batch: readonly string[],
    signal: AbortSignal | undefined,
  ): Promise<void> {
    await forEachWithConcurrency(batch, deleteConcurrency, async (key) => {
      throwIfAborted(signal);
      try {
        await container
          .getBlobClient(basePrefix + key)
          .deleteIfExists(signal ? { abortSignal: signal } : {});
      } catch (error) {
        throw fail(error, "delete", key, signal);
      }
    });
  }

  return {
    kind: "azure",
    location,
    capabilities: CAPABILITIES,
    put,
    get,
    head,
    list,
    listPrefixes,
    delete: deleteObjects,
    async close() {
      // The SDK's HTTP client keeps no state that needs closing; forget the
      // client so a later call starts fresh.
      clientPromise = undefined;
    },
  };
}

/**
 * Works out the account and container names for `location` without loading
 * the SDK, and checks that exactly one way of connecting was given.
 */
function describeTarget(options: AzureStorageOptions): { account: string; container: string } {
  const ways = [options.connectionString, options.accountUrl, options.containerClient].filter(
    (value) => value !== undefined,
  );
  if (ways.length !== 1) {
    throw new MongoShieldError(
      "MS_CONFIG_INVALID",
      "azureStorage() needs exactly one of `connectionString`, `accountUrl` or `containerClient`.",
      {
        hint: 'For example azureStorage({ accountUrl: "https://<account>.blob.core.windows.net", container: "backups" }).',
      },
    );
  }
  if (options.containerClient) {
    return {
      account: options.containerClient.accountName,
      container: options.containerClient.containerName,
    };
  }
  const container = validContainer(options.container);
  if (options.connectionString !== undefined) {
    return { account: accountFromConnectionString(options.connectionString), container };
  }
  return { account: accountFromUrl(options.accountUrl ?? ""), container };
}

/** `AccountName=foo;…` → `foo`; `UseDevelopmentStorage=true` → Azurite's account. */
function accountFromConnectionString(connectionString: string): string {
  const fields = new Map<string, string>();
  for (const part of connectionString.split(";")) {
    const separator = part.indexOf("=");
    if (separator > 0)
      fields.set(part.slice(0, separator).trim().toLowerCase(), part.slice(separator + 1).trim());
  }
  const account = fields.get("accountname");
  if (account) return account;
  if (fields.get("usedevelopmentstorage")?.toLowerCase() === "true") return DEVELOPMENT_ACCOUNT;
  // Do not echo the string: it may contain an account key or SAS signature.
  throw new MongoShieldError(
    "MS_CONFIG_INVALID",
    "The Azure connection string has no AccountName.",
    {
      hint: "Copy the full connection string from the storage account's “Access keys” page.",
    },
  );
}

/**
 * The account name in a blob service URL: the first host label for Azure
 * (`https://acct.blob.core.windows.net`), or the first path segment for the
 * path-style URLs Azurite uses (`http://127.0.0.1:10000/devstoreaccount1`).
 */
function accountFromUrl(accountUrl: string): string {
  let url: URL;
  try {
    url = new URL(accountUrl);
  } catch (error) {
    throw new MongoShieldError("MS_CONFIG_INVALID", "Invalid Azure accountUrl.", {
      cause: error,
      hint: "Use https://<account>.blob.core.windows.net.",
    });
  }
  const firstSegment = url.pathname.split("/").find((segment) => segment.length > 0);
  if (firstSegment) return firstSegment;
  return url.hostname.split(".")[0] ?? url.hostname;
}

/** The error for a container without version-level immutability, with instructions. */
function immutabilityDisabledError(
  container: string,
  target: string,
  cause?: unknown,
): MongoShieldError {
  return new MongoShieldError(
    "MS_CONFIG_INVALID",
    `Cannot write immutable objects to ${target}: version-level immutability is not enabled on container "${container}".`,
    {
      ...(cause === undefined ? {} : { cause }),
      hint:
        "Enable blob versioning on the storage account, then version-level immutability support on " +
        "the container (portal: Container → Access policy → Enable version-level immutability, or " +
        `az storage container-rm migrate-vlw for an existing container), or drop retainDays. See ${IMMUTABLE_GUIDE}.`,
    },
  );
}

/**
 * True for Azure's rejection of an immutability policy on a container without
 * version-level immutability. Azure has used several codes for this over service
 * versions, so match on the theme rather than one exact code.
 */
function isImmutabilityNotConfigured(error: unknown): boolean {
  const status = httpStatus(error);
  const code = errorCode(error) ?? "";
  if (status !== 400 && status !== 409) return false;
  if (code === "BlobImmutableDueToPolicy") return false;
  return /immutab|versionlevelworm/i.test(`${code} ${messageOf(error)}`);
}

/** Imports the SDK and builds (or adopts) the container client. */
async function createContainerClient(options: AzureStorageOptions): Promise<ContainerClient> {
  if (options.containerClient) return options.containerClient;
  const sdk = await loadAzureSdk();
  const container = validContainer(options.container);
  if (options.connectionString !== undefined) {
    return new sdk.ContainerClient(options.connectionString, container);
  }
  const url = new URL(options.accountUrl ?? "");
  // Append the container to the path, keeping any SAS token in the query string.
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/${encodeURIComponent(container)}`;
  const hasSas = url.searchParams.has("sig");
  const credential = options.credential ?? (hasSas ? undefined : await defaultCredential());
  return new sdk.ContainerClient(url.toString(), credential);
}

/**
 * Loads the optional SDK. It is a peer dependency so that users who only back
 * up elsewhere never install it.
 */
async function loadAzureSdk(): Promise<typeof AzureBlobSdk> {
  try {
    return await import("@azure/storage-blob");
  } catch (error) {
    throw missingPackageError(error, "Azure Blob Storage", INSTALL_HINT);
  }
}

/** `new DefaultAzureCredential()` from the optional `@azure/identity` package. */
async function defaultCredential(): Promise<AzureStorageCredential> {
  try {
    const identity = await import("@azure/identity");
    return new identity.DefaultAzureCredential();
  } catch (error) {
    throw missingPackageError(
      error,
      "Azure Blob Storage with Microsoft Entra ID (DefaultAzureCredential)",
      IDENTITY_INSTALL_HINT,
    );
  }
}

function validContainer(container: string | undefined): string {
  // Azure container names: 3-63 characters, lowercase letters, digits and single hyphens.
  if (
    typeof container !== "string" ||
    !/^[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){2,62}$/.test(container)
  ) {
    throw new MongoShieldError(
      "MS_CONFIG_INVALID",
      `Invalid Azure container name "${String(container)}".`,
      { hint: "Container names are 3-63 lowercase letters, digits and hyphens." },
    );
  }
  return container;
}

function validSize(value: number | undefined, fallback: number, name: string, max: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1 || value > max) {
    throw new MongoShieldError(
      "MS_CONFIG_INVALID",
      `Azure ${name} must be an integer between 1 and ${max} bytes, got ${value}.`,
    );
  }
  return value;
}

function validCount(value: number | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new MongoShieldError(
      "MS_CONFIG_INVALID",
      `Azure ${name} must be a positive integer, got ${value}.`,
    );
  }
  return value;
}

function uploadedInfo(
  key: string,
  size: number,
  lastModified: Date | undefined,
  rawEtag: string | undefined,
): ObjectInfo {
  const etag = unquote(rawEtag);
  return { key, size, lastModified: lastModified ?? new Date(), ...(etag ? { etag } : {}) };
}

/** The HTTP status the SDK attaches to a `RestError`. */
function httpStatus(error: unknown): number | undefined {
  return numberProperty(error, "statusCode");
}

/**
 * Azure's error code (`BlobNotFound`, `ContainerNotFound`, `AuthorizationFailure`, …).
 * The SDK puts it on `code`; HEAD responses (no body) only carry it in the
 * `x-ms-error-code` header, which the SDK copies to `details.errorCode`.
 */
function errorCode(error: unknown): string | undefined {
  return stringProperty(error, "code") ?? stringProperty(propertyOf(error, "details"), "errorCode");
}

function isForbidden(error: unknown): boolean {
  const status = httpStatus(error);
  return status === 401 || status === 403;
}

/** SAS signatures can appear in request URLs echoed by some errors; never print them. */
function redactSas(text: string): string {
  return text.replace(/([?&]sig=)[^&\s]+/gi, "$1***");
}

/** Context for {@link azureError}. */
interface AzureErrorContext {
  readonly operation: Operation;
  readonly target: string;
  readonly container: string;
  readonly signal?: AbortSignal | undefined;
}

/**
 * Maps an SDK error to a `MongoShieldError`: 404 → NOT_FOUND (with a hint for
 * a missing container), 401/403 → FORBIDDEN, 412 and 409 BlobAlreadyExists →
 * PRECONDITION_FAILED, anything else → IO.
 */
function azureError(error: unknown, context: AzureErrorContext): MongoShieldError {
  const { operation, target, container, signal } = context;
  if (signal?.aborted) return abortError(signal);
  if (error instanceof MongoShieldError) return error;

  const status = httpStatus(error);
  const code = errorCode(error);
  // Azure messages carry a RequestId/Time trailer on extra lines; keep the first line.
  const reason = redactSas(messageOf(error).split("\n")[0] ?? "");
  const message = `Could not ${operation} ${target}: ${code ?? "Error"}${reason ? `: ${reason}` : ""}`;
  const details = {
    ...(status === undefined ? {} : { httpStatusCode: status }),
    ...(code === undefined ? {} : { errorCode: code }),
  };
  const base = { cause: error, details };

  if (propertyOf(error, "name") === "AbortError") {
    return new MongoShieldError("MS_ABORTED", message, base);
  }
  if (code === "ContainerNotFound") {
    return new MongoShieldError("MS_STORAGE_NOT_FOUND", message, {
      ...base,
      hint: `Create the container "${container}", or check the account and container names.`,
    });
  }
  if (status === 404) return new MongoShieldError("MS_STORAGE_NOT_FOUND", message, base);
  // Deleting or overwriting a blob whose immutability policy has not expired.
  if (code === "BlobImmutableDueToPolicy") {
    return objectLockedError(message, base);
  }
  // Reached when the container check was skipped for lack of permission.
  if (operation === "write" && isImmutabilityNotConfigured(error)) {
    return immutabilityDisabledError(container, target, error);
  }
  if (status === 401 || status === 403) {
    return new MongoShieldError("MS_STORAGE_FORBIDDEN", message, {
      ...base,
      hint:
        'Check the credentials, and that the identity has the "Storage Blob Data Contributor" ' +
        `role on container "${container}" (or that the SAS token allows read, write, delete and list).`,
    });
  }
  if (status === 412 || (status === 409 && code === "BlobAlreadyExists")) {
    return new MongoShieldError("MS_STORAGE_PRECONDITION_FAILED", message, base);
  }
  return new MongoShieldError("MS_STORAGE_IO", message, base);
}
