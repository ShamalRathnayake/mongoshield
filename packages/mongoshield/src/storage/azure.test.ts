/**
 * Unit tests for the Azure Blob adapter against an in-memory fake of the parts
 * of `ContainerClient` it uses. They pin down request options, pagination,
 * batching, error mapping, atomicity and cancellation. The behavioural contract
 * against a real Blob API runs in `test/integration/storage-azure.test.ts`
 * (Azurite in Docker).
 */

import { Readable } from "node:stream";
import type { ContainerClient } from "@azure/storage-blob";
import { beforeEach, describe, expect, it } from "vitest";
import { isMongoShieldError } from "../errors.ts";
import { type AzureStorageOptions, azureStorage } from "./azure.ts";

/** An error shaped like the SDK's `RestError`. */
function restError(statusCode: number, code: string, message = `${code} from fake`): Error {
  return Object.assign(new Error(message), { name: "RestError", statusCode, code });
}

interface StoredBlob {
  readonly data: Buffer;
  readonly etag: string;
  readonly lastModified: Date;
}

interface UploadOptions {
  readonly blobHTTPHeaders?: { blobContentType?: string };
  readonly conditions?: { ifNoneMatch?: string };
  readonly abortSignal?: AbortSignal;
  readonly immutabilityPolicy?: { expiriesOn?: Date; policyMode?: string };
}

type FakeMethod = "upload" | "download" | "properties" | "list" | "batch" | "delete";

/** A tiny in-memory container with just enough behaviour for the adapter. */
class FakeContainer {
  readonly accountName = "acct";
  readonly containerName = "backups";
  readonly blobs = new Map<string, StoredBlob>();
  readonly calls: { method: string; name?: string; args: unknown[] }[] = [];
  pageSize = 5000;
  failures = new Map<FakeMethod, Error>();
  /** What the container-level `getProperties()` answers, or the error it throws. */
  containerProperties: { isImmutableStorageWithVersioningEnabled?: boolean } | Error = {
    isImmutableStorageWithVersioningEnabled: true,
  };
  private version = 0;

  private fail(method: FakeMethod): void {
    const error = this.failures.get(method);
    if (error) {
      this.failures.delete(method);
      throw error;
    }
  }

  client(): ContainerClient {
    return this as unknown as ContainerClient;
  }

  store(name: string, data: Buffer): StoredBlob {
    const blob = {
      data,
      etag: `"0x${++this.version}"`,
      lastModified: new Date("2026-11-14T03:00:04Z"),
    };
    this.blobs.set(name, blob);
    return blob;
  }

  /** Put Blob / Put Block List: the blob appears only on commit, honouring If-None-Match. */
  private commit(name: string, data: Buffer, options: UploadOptions) {
    this.fail("upload");
    if (options.conditions?.ifNoneMatch === "*" && this.blobs.has(name)) {
      throw restError(409, "BlobAlreadyExists", "The specified blob already exists.");
    }
    const blob = this.store(name, data);
    return { etag: blob.etag, lastModified: blob.lastModified };
  }

  /** Get Container Properties (the adapter reads the immutability flag from it). */
  async getProperties() {
    this.calls.push({ method: "containerProperties", args: [] });
    if (this.containerProperties instanceof Error) throw this.containerProperties;
    return this.containerProperties;
  }

  getBlockBlobClient(name: string) {
    return {
      uploadData: async (data: Buffer, options: UploadOptions) => {
        this.calls.push({ method: "uploadData", name, args: [data, options] });
        return this.commit(name, Buffer.from(data), options);
      },
      uploadStream: async (
        stream: Readable,
        bufferSize: number,
        maxConcurrency: number,
        options: UploadOptions,
      ) => {
        this.calls.push({
          method: "uploadStream",
          name,
          args: [bufferSize, maxConcurrency, options],
        });
        const staged: Buffer[] = [];
        for await (const piece of stream) staged.push(Buffer.from(piece));
        return this.commit(name, Buffer.concat(staged), options);
      },
    };
  }

  getBlobClient(name: string) {
    return {
      name,
      download: async (offset: number, count: number | undefined, options: unknown) => {
        this.calls.push({ method: "download", name, args: [offset, count, options] });
        this.fail("download");
        const blob = this.blobs.get(name);
        if (!blob) throw restError(404, "BlobNotFound");
        if (offset > 0 && offset >= blob.data.length) throw restError(416, "InvalidRange");
        const end = count === undefined ? blob.data.length : offset + count;
        return { readableStreamBody: Readable.from([blob.data.subarray(offset, end)]) };
      },
      getProperties: async (options: unknown) => {
        this.calls.push({ method: "getProperties", name, args: [options] });
        this.fail("properties");
        const blob = this.blobs.get(name);
        // HEAD responses have no body: the code only arrives via details.errorCode.
        if (!blob)
          throw Object.assign(new Error(""), {
            statusCode: 404,
            details: { errorCode: "BlobNotFound" },
          });
        return {
          contentLength: blob.data.length,
          lastModified: blob.lastModified,
          etag: blob.etag,
        };
      },
      deleteIfExists: async (options: unknown) => {
        this.calls.push({ method: "deleteIfExists", name, args: [options] });
        this.fail("delete");
        return { succeeded: this.blobs.delete(name) };
      },
    };
  }

  private pages<T>(items: readonly T[]) {
    const pageSize = this.pageSize;
    return {
      byPage: (settings: { maxPageSize: number }) => {
        this.calls.push({ method: "byPage", args: [settings] });
        const fail = () => this.fail("list");
        return (async function* () {
          fail();
          for (let start = 0; start < Math.max(items.length, 1); start += pageSize) {
            yield items.slice(start, start + pageSize);
          }
        })();
      },
    };
  }

  private namesUnder(prefix: string): string[] {
    return [...this.blobs.keys()].filter((name) => name.startsWith(prefix)).sort();
  }

  private blobItem(name: string) {
    const blob = this.blobs.get(name);
    return {
      name,
      properties: {
        contentLength: blob?.data.length,
        lastModified: blob?.lastModified,
        etag: blob?.etag,
      },
    };
  }

  listBlobsFlat(options: { prefix: string }) {
    this.calls.push({ method: "listBlobsFlat", args: [options] });
    const items = this.namesUnder(options.prefix).map((name) => this.blobItem(name));
    const pages = this.pages(items);
    return {
      byPage: (settings: { maxPageSize: number }) =>
        mapPages(pages.byPage(settings), (page) => ({ segment: { blobItems: page } })),
    };
  }

  listBlobsByHierarchy(delimiter: string, options: { prefix: string }) {
    this.calls.push({ method: "listBlobsByHierarchy", args: [delimiter, options] });
    const prefixes = new Set<string>();
    for (const name of this.namesUnder(options.prefix)) {
      const rest = name.slice(options.prefix.length);
      const index = rest.indexOf(delimiter);
      if (index >= 0) prefixes.add(options.prefix + rest.slice(0, index + 1));
    }
    const pages = this.pages([...prefixes].map((name) => ({ name })));
    return {
      byPage: (settings: { maxPageSize: number }) =>
        mapPages(pages.byPage(settings), (page) => ({
          segment: { blobItems: [], blobPrefixes: page },
        })),
    };
  }

  getBlobBatchClient() {
    return {
      deleteBlobs: async (clients: { name: string }[], options: unknown) => {
        this.calls.push({
          method: "deleteBlobs",
          args: [clients.map((client) => client.name), options],
        });
        this.fail("batch");
        return {
          subResponses: clients.map((client) => {
            const existed = this.blobs.delete(client.name);
            return existed
              ? { status: 202, statusMessage: "Accepted" }
              : { status: 404, statusMessage: "Not Found", errorCode: "BlobNotFound" };
          }),
        };
      },
    };
  }

  callsTo(method: string) {
    return this.calls.filter((call) => call.method === method);
  }
}

async function* mapPages<T, U>(pages: AsyncIterable<T>, map: (page: T) => U) {
  for await (const page of pages) yield map(page);
}

async function readAll(stream: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const piece of stream) chunks.push(Buffer.from(piece));
  return Buffer.concat(chunks).toString();
}

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const items: T[] = [];
  for await (const item of iterable) items.push(item);
  return items;
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error("expected the promise to reject");
    },
    (error: unknown) => error,
  );
}

describe("azureStorage", () => {
  let container: FakeContainer;

  beforeEach(() => {
    container = new FakeContainer();
  });

  function storage(options: Partial<AzureStorageOptions> = {}) {
    return azureStorage({ containerClient: container.client(), prefix: "base", ...options });
  }

  describe("configuration", () => {
    it("derives the location from a container client, connection string or account URL", () => {
      expect(storage({ prefix: "/prod/mongo/" }).location).toBe("az://acct/backups/prod/mongo/");
      expect(
        azureStorage({
          connectionString:
            "DefaultEndpointsProtocol=https;AccountName=myacct;AccountKey=c2VjcmV0;EndpointSuffix=core.windows.net",
          container: "dumps",
        }).location,
      ).toBe("az://myacct/dumps/");
      expect(
        azureStorage({ connectionString: "UseDevelopmentStorage=true", container: "dumps" })
          .location,
      ).toBe("az://devstoreaccount1/dumps/");
      expect(
        azureStorage({
          accountUrl: "https://acct2.blob.core.windows.net?sv=1&sig=secret",
          container: "c01",
        }).location,
      ).toBe("az://acct2/c01/");
      expect(
        azureStorage({ accountUrl: "http://127.0.0.1:10000/devstoreaccount1", container: "c01" })
          .location,
      ).toBe("az://devstoreaccount1/c01/");
      expect(storage().kind).toBe("azure");
    });

    it("declares conditional writes, range reads and object lock", () => {
      expect(storage().capabilities).toEqual({
        conditionalWrites: true,
        rangeReads: true,
        objectLock: true,
      });
    });

    it.each<[string, AzureStorageOptions]>([
      ["no way of connecting", { container: "backups" }],
      [
        "two ways of connecting",
        {
          container: "backups",
          connectionString: "UseDevelopmentStorage=true",
          accountUrl: "https://a.blob.core.windows.net",
        },
      ],
      [
        "an invalid container name",
        { connectionString: "UseDevelopmentStorage=true", container: "Bad_Name" },
      ],
      ["a missing container name", { connectionString: "UseDevelopmentStorage=true" }],
      ["an invalid account URL", { accountUrl: "not a url", container: "backups" }],
      [
        "a prefix with ..",
        { connectionString: "UseDevelopmentStorage=true", container: "backups", prefix: "a/../b" },
      ],
      [
        "a zero block size",
        { connectionString: "UseDevelopmentStorage=true", container: "backups", blockSize: 0 },
      ],
    ])("rejects %s with MS_CONFIG_INVALID", (_label, options) => {
      expect(() => azureStorage(options)).toThrow(
        expect.objectContaining({ code: "MS_CONFIG_INVALID" }),
      );
    });

    it("never echoes a connection string without an account name", () => {
      const error = (() => {
        try {
          azureStorage({
            connectionString: "SharedAccessSignature=sv=1&sig=topsecret",
            container: "backups",
          });
        } catch (caught) {
          return caught;
        }
        return undefined;
      })();
      expect(isMongoShieldError(error, "MS_CONFIG_INVALID")).toBe(true);
      expect(String(error)).not.toContain("topsecret");
    });
  });

  describe("put", () => {
    it("uploads a Buffer with one Put Blob, a content type and no conditions", async () => {
      const info = await storage().put("dir/a.json", Buffer.from("{}"), {
        contentType: "application/json",
      });
      expect(info).toMatchObject({ key: "dir/a.json", size: 2, etag: "0x1" });
      const [call] = container.callsTo("uploadData");
      expect(call?.name).toBe("base/dir/a.json");
      expect(call?.args[1]).toEqual({
        blobHTTPHeaders: { blobContentType: "application/json" },
        conditions: {},
      });
    });

    it("streams a Readable as blocks with the configured block size and concurrency", async () => {
      const info = await storage({ blockSize: 1024 * 1024, uploadConcurrency: 2 }).put(
        "s.bin",
        Readable.from([Buffer.from("ab"), Buffer.from("cde")]),
      );
      expect(info.size).toBe(5);
      const [call] = container.callsTo("uploadStream");
      expect(call?.args.slice(0, 2)).toEqual([1024 * 1024, 2]);
      expect(call?.args[2]).toMatchObject({
        blobHTTPHeaders: { blobContentType: "application/octet-stream" },
      });
    });

    it("grows the block size when sizeHint would need more than 50,000 blocks", async () => {
      const sizeHint = 1024 * 1024 * 1024 * 1024; // 1 TiB
      await storage().put("big", Readable.from(["x"]), { sizeHint });
      expect(container.callsTo("uploadStream")[0]?.args[0]).toBe(Math.ceil(sizeHint / 50_000));
    });

    it("sends If-None-Match: * and maps 409 BlobAlreadyExists and 412", async () => {
      const adapter = storage();
      await adapter.put("lock", Buffer.from("1"), { ifNoneMatch: "*" });
      expect(container.callsTo("uploadData")[0]?.args[1]).toMatchObject({
        conditions: { ifNoneMatch: "*" },
      });
      const conflict = await rejection(
        adapter.put("lock", Readable.from(["2"]), { ifNoneMatch: "*" }),
      );
      expect(isMongoShieldError(conflict, "MS_STORAGE_PRECONDITION_FAILED")).toBe(true);

      container.failures.set("upload", restError(412, "ConditionNotMet"));
      const unmet = await rejection(adapter.put("other", Buffer.from("x"), { ifNoneMatch: "*" }));
      expect(isMongoShieldError(unmet, "MS_STORAGE_PRECONDITION_FAILED")).toBe(true);
      expect(container.blobs.get("base/lock")?.data.toString()).toBe("1");
    });

    it("does not treat other 409 conflicts as precondition failures", async () => {
      container.failures.set("upload", restError(409, "LeaseIdMissing"));
      const error = await rejection(storage().put("a", Buffer.from("x")));
      expect(isMongoShieldError(error, "MS_STORAGE_IO")).toBe(true);
    });

    it("never commits when the body stream fails midway", async () => {
      async function* failing() {
        yield Buffer.from("partial");
        throw new Error("source died");
      }
      const error = await rejection(storage().put("broken", Readable.from(failing())));
      expect(isMongoShieldError(error, "MS_STORAGE_IO")).toBe(true);
      expect(container.blobs.size).toBe(0);
    });

    it("rejects with MS_ABORTED and commits nothing when aborted mid-stream", async () => {
      const controller = new AbortController();
      async function* slow() {
        yield Buffer.from("a");
        controller.abort();
        await new Promise((resolve) => setTimeout(resolve, 5));
        yield Buffer.from("b");
      }
      const error = await rejection(
        storage().put("a", Readable.from(slow()), { signal: controller.signal }),
      );
      expect(isMongoShieldError(error, "MS_ABORTED")).toBe(true);
      expect(container.blobs.size).toBe(0);
    });
  });

  describe("get", () => {
    it("downloads the whole prefixed blob with retries for broken streams", async () => {
      container.store("base/a.txt", Buffer.from("hello"));
      expect(await readAll(await storage().get("a.txt"))).toBe("hello");
      expect(container.callsTo("download")[0]?.args).toEqual([
        0,
        undefined,
        { maxRetryRequests: 5 },
      ]);
    });

    it("turns inclusive ranges into offset and count", async () => {
      container.store("base/a.txt", Buffer.from("0123456789"));
      const adapter = storage();
      expect(await readAll(await adapter.get("a.txt", { range: { start: 2, end: 5 } }))).toBe(
        "2345",
      );
      expect(await readAll(await adapter.get("a.txt", { range: { start: 7 } }))).toBe("789");
      expect(container.callsTo("download").map((call) => call.args.slice(0, 2))).toEqual([
        [2, 4],
        [7, undefined],
      ]);
    });

    it("returns an empty stream for a range past the end (416)", async () => {
      container.store("base/a.txt", Buffer.from("abc"));
      expect(await readAll(await storage().get("a.txt", { range: { start: 10 } }))).toBe("");
    });

    it("maps BlobNotFound to MS_STORAGE_NOT_FOUND", async () => {
      const error = await rejection(storage().get("missing"));
      expect(isMongoShieldError(error, "MS_STORAGE_NOT_FOUND")).toBe(true);
      expect(String(error)).toContain("az://acct/backups/base/missing");
    });

    it("maps ContainerNotFound to MS_STORAGE_NOT_FOUND with a hint naming the container", async () => {
      container.failures.set("download", restError(404, "ContainerNotFound"));
      const error = await rejection(storage().get("a"));
      expect(isMongoShieldError(error, "MS_STORAGE_NOT_FOUND")).toBe(true);
      expect(isMongoShieldError(error) && error.hint).toContain('"backups"');
    });

    it("maps 403 to MS_STORAGE_FORBIDDEN with a role hint and redacts SAS signatures", async () => {
      container.failures.set(
        "download",
        restError(
          403,
          "AuthorizationFailure",
          "Denied for https://a/b?sv=1&sig=SECRETSIG\nRequestId:1",
        ),
      );
      const error = await rejection(storage().get("a"));
      expect(isMongoShieldError(error, "MS_STORAGE_FORBIDDEN")).toBe(true);
      expect(isMongoShieldError(error) && error.hint).toContain("Storage Blob Data Contributor");
      expect(isMongoShieldError(error) && error.message).not.toContain("SECRETSIG");
      expect(isMongoShieldError(error) && error.message).not.toContain("RequestId");
    });

    it("maps an SDK AbortError to MS_ABORTED", async () => {
      container.failures.set(
        "download",
        Object.assign(new Error("aborted"), { name: "AbortError" }),
      );
      const error = await rejection(storage().get("a"));
      expect(isMongoShieldError(error, "MS_ABORTED")).toBe(true);
    });
  });

  describe("head", () => {
    it("returns size, last-modified and an unquoted etag", async () => {
      container.store("base/a", Buffer.alloc(42));
      expect(await storage().head("a")).toEqual({
        key: "a",
        size: 42,
        lastModified: new Date("2026-11-14T03:00:04Z"),
        etag: "0x1",
      });
    });

    it("returns undefined for a missing blob", async () => {
      expect(await storage().head("missing")).toBeUndefined();
    });

    it("still reports a missing container (known only from the error header) as an error", async () => {
      container.failures.set(
        "properties",
        Object.assign(new Error(""), {
          statusCode: 404,
          details: { errorCode: "ContainerNotFound" },
        }),
      );
      const error = await rejection(storage().head("a"));
      expect(isMongoShieldError(error, "MS_STORAGE_NOT_FOUND")).toBe(true);
    });
  });

  describe("list", () => {
    it("pages through listBlobsFlat, strips the prefix and skips folder markers", async () => {
      container.pageSize = 2;
      for (const name of ["base/a", "base/b/c", "base/d", "base/folder/", "other/x"]) {
        container.store(name, Buffer.from(name));
      }
      const infos = await collect(storage().list(""));
      expect(infos.map((info) => info.key)).toEqual(["a", "b/c", "d"]);
      expect(infos[0]).toMatchObject({ size: 6, etag: "0x1" });
      expect(container.callsTo("listBlobsFlat")[0]?.args[0]).toEqual({ prefix: "base/" });
      expect(container.callsTo("byPage")[0]?.args[0]).toEqual({ maxPageSize: 5000 });
    });

    it("maps listing errors", async () => {
      container.failures.set("list", restError(403, "AuthorizationPermissionMismatch"));
      const error = await rejection(collect(storage().list("")));
      expect(isMongoShieldError(error, "MS_STORAGE_FORBIDDEN")).toBe(true);
    });
  });

  describe("listPrefixes", () => {
    it("uses listBlobsByHierarchy with the / delimiter and strips the prefix", async () => {
      container.pageSize = 1;
      for (const name of ["base/b1/x", "base/b2/y/z", "base/top.json", "base/b3/w"]) {
        container.store(name, Buffer.from("1"));
      }
      expect(await collect(storage().listPrefixes(""))).toEqual(["b1/", "b2/", "b3/"]);
      expect(container.callsTo("listBlobsByHierarchy")[0]?.args).toEqual([
        "/",
        { prefix: "base/" },
      ]);
    });
  });

  describe("delete", () => {
    it("deletes in Blob Batch requests of at most 256 and ignores missing blobs", async () => {
      const keys = Array.from({ length: 300 }, (_, index) => `k${index}`);
      for (const key of keys) container.store(`base/${key}`, Buffer.from("1"));
      await storage().delete([...keys, "missing"]);
      expect(container.blobs.size).toBe(0);
      const batches = container.callsTo("deleteBlobs").map((call) => call.args[0] as string[]);
      expect(batches.map((names) => names.length)).toEqual([256, 45]);
      expect(batches[0]?.[0]).toBe("base/k0");
    });

    it("throws per-blob failures reported inside a batch", async () => {
      container.store("base/a", Buffer.from("1"));
      const adapter = storage();
      const batchClient = container.getBlobBatchClient();
      container.getBlobBatchClient = () => ({
        deleteBlobs: async (clients, options) => {
          const response = await batchClient.deleteBlobs(clients, options);
          return {
            subResponses: response.subResponses.map(() => ({
              status: 403,
              statusMessage: "This request is not authorized",
              errorCode: "AuthorizationFailure",
            })),
          };
        },
      });
      const error = await rejection(adapter.delete(["a"]));
      expect(isMongoShieldError(error, "MS_STORAGE_FORBIDDEN")).toBe(true);
      expect(String(error)).toContain("az://acct/backups/base/a");
    });

    it("falls back to individual deletes when Blob Batch is unavailable, and remembers it", async () => {
      for (const key of ["a", "b", "c"]) container.store(`base/${key}`, Buffer.from("1"));
      container.failures.set("batch", restError(400, "InvalidUri"));
      const adapter = storage();
      await adapter.delete(["a", "b"]);
      await adapter.delete(["c", "missing"]);
      expect(container.blobs.size).toBe(0);
      expect(container.callsTo("deleteBlobs")).toHaveLength(1);
      expect(container.callsTo("deleteIfExists").map((call) => call.name)).toEqual([
        "base/a",
        "base/b",
        "base/c",
        "base/missing",
      ]);
    });

    it("does not fall back when the batch is rejected for lack of permission", async () => {
      container.store("base/a", Buffer.from("1"));
      container.failures.set("batch", restError(403, "AuthorizationFailure"));
      const error = await rejection(storage().delete(["a"]));
      expect(isMongoShieldError(error, "MS_STORAGE_FORBIDDEN")).toBe(true);
      expect(container.callsTo("deleteIfExists")).toHaveLength(0);
    });

    it("sends nothing for an empty key list and validates keys first", async () => {
      await storage().delete([]);
      await expect(storage().delete(["a", "../b"])).rejects.toThrow(/Invalid storage key/);
      expect(container.calls).toHaveLength(0);
    });
  });

  describe("immutability policies (immutable backups)", () => {
    const retainUntil = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

    function uploadOptions(method: "uploadData" | "uploadStream"): UploadOptions | undefined {
      const args = container.callsTo(method)[0]?.args;
      return (method === "uploadData" ? args?.[1] : args?.[2]) as UploadOptions | undefined;
    }

    it("sends a Locked immutability policy on Put Blob by default", async () => {
      await storage().put("b/manifest.json", Buffer.from("{}"), { retainUntil });
      expect(uploadOptions("uploadData")?.immutabilityPolicy).toEqual({
        expiriesOn: retainUntil,
        policyMode: "Locked",
      });
    });

    it("sends an Unlocked policy on the block list commit in governance mode", async () => {
      await storage({ retention: { mode: "governance" } }).put(
        "s",
        Readable.from([Buffer.from("x")]),
        { retainUntil },
      );
      expect(uploadOptions("uploadStream")?.immutabilityPolicy).toEqual({
        expiriesOn: retainUntil,
        policyMode: "Unlocked",
      });
    });

    it("sends no policy and reads no container properties for ordinary puts", async () => {
      await storage().put("a", Buffer.from("x"));
      expect(uploadOptions("uploadData")?.immutabilityPolicy).toBeUndefined();
      expect(container.callsTo("containerProperties")).toHaveLength(0);
    });

    it("checks the container once per adapter", async () => {
      const adapter = storage();
      await adapter.put("a", Buffer.from("a"), { retainUntil });
      await adapter.put("b", Buffer.from("b"), { retainUntil });
      expect(container.callsTo("containerProperties")).toHaveLength(1);
    });

    it("fails with MS_CONFIG_INVALID before uploading without version-level immutability", async () => {
      container.containerProperties = {};
      const failure = await rejection(storage().put("a", Buffer.from("x"), { retainUntil }));
      expect(isMongoShieldError(failure, "MS_CONFIG_INVALID"), String(failure)).toBe(true);
      expect(isMongoShieldError(failure) && failure.hint).toContain("version-level immutability");
      expect(container.callsTo("uploadData")).toHaveLength(0);
    });

    it("skips the check without permission and maps Azure's refusal to MS_CONFIG_INVALID", async () => {
      container.containerProperties = restError(403, "AuthorizationPermissionMismatch");
      container.failures.set(
        "upload",
        restError(
          409,
          "ImmutableStorageWithVersioningNotEnabled",
          "Version-level immutability is not enabled on the container.",
        ),
      );
      const failure = await rejection(storage().put("a", Buffer.from("x"), { retainUntil }));
      expect(isMongoShieldError(failure, "MS_CONFIG_INVALID"), String(failure)).toBe(true);
    });

    it("maps BlobImmutableDueToPolicy on delete to an objectLocked MS_STORAGE_FORBIDDEN", async () => {
      container.failures.set("batch", restError(400, "InvalidUri"));
      container.failures.set(
        "delete",
        restError(
          409,
          "BlobImmutableDueToPolicy",
          "This operation is not permitted as the blob is immutable due to a policy.",
        ),
      );
      const failure = await rejection(storage().delete(["a"]));
      expect(isMongoShieldError(failure, "MS_STORAGE_FORBIDDEN"), String(failure)).toBe(true);
      expect(isMongoShieldError(failure) && failure.details?.objectLocked).toBe(true);
    });

    it("maps BlobImmutableDueToPolicy inside a Blob Batch the same way", async () => {
      container.store("base/a", Buffer.from("1"));
      const batchClient = container.getBlobBatchClient();
      container.getBlobBatchClient = () => ({
        deleteBlobs: async (clients, options) => {
          await batchClient.deleteBlobs(clients, options);
          return {
            subResponses: clients.map(() => ({
              status: 409,
              statusMessage: "The blob is immutable due to a policy.",
              errorCode: "BlobImmutableDueToPolicy",
            })),
          };
        },
      });
      const failure = await rejection(storage().delete(["a"]));
      expect(isMongoShieldError(failure) && failure.details?.objectLocked).toBe(true);
    });

    it("maps an overwrite of a locked blob to MS_STORAGE_FORBIDDEN, not a precondition failure", async () => {
      container.failures.set("upload", restError(409, "BlobImmutableDueToPolicy"));
      const failure = await rejection(storage().put("a", Buffer.from("x")));
      expect(isMongoShieldError(failure, "MS_STORAGE_FORBIDDEN")).toBe(true);
    });
  });

  it("can be closed more than once", async () => {
    const adapter = storage();
    await adapter.close?.();
    await adapter.close?.();
  });
});
