/**
 * Unit tests for the S3 adapter against a mocked `S3Client` (aws-sdk-client-mock).
 * They pin down request shapes, pagination, batching and error mapping. The
 * behavioural contract against a real S3 API runs in
 * `test/integration/storage-s3.test.ts` (MinIO in Docker).
 */

import { Readable } from "node:stream";
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  type GetObjectCommandOutput,
  GetObjectLockConfigurationCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  NoSuchBucket,
  NoSuchKey,
  NotFound,
  PutObjectCommand,
  S3Client,
  S3ServiceException,
  UploadPartCommand,
} from "@aws-sdk/client-s3";
import { mockClient } from "aws-sdk-client-mock";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isMongoShieldError } from "../errors.ts";
import { type S3StorageOptions, s3Storage } from "./s3.ts";

const MiB = 1024 * 1024;

/** A real client (so lib-storage can resolve endpoints offline) whose `send` is mocked. */
function makeClient(): S3Client {
  return new S3Client({
    region: "us-east-1",
    credentials: { accessKeyId: "test", secretAccessKey: "test" },
  });
}

/** An S3 error as the SDK would throw it. */
function serviceError(name: string, httpStatusCode: number): S3ServiceException {
  return new S3ServiceException({
    name,
    $fault: "client",
    $metadata: { httpStatusCode, requestId: "req-1" },
    message: `${name} from mock`,
  });
}

/**
 * The SDK types GetObject's Body as an SDK stream mixin; in Node.js it is a
 * plain Readable underneath, which is all the adapter relies on.
 */
function streamingBody(text: string): NonNullable<GetObjectCommandOutput["Body"]> {
  return Readable.from([Buffer.from(text)]) as unknown as NonNullable<
    GetObjectCommandOutput["Body"]
  >;
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

describe("s3Storage", () => {
  let client: S3Client;
  let s3: ReturnType<typeof mockClient>;

  beforeEach(() => {
    client = makeClient();
    s3 = mockClient(client);
  });

  afterEach(() => {
    s3.restore();
  });

  function storage(options: Partial<S3StorageOptions> = {}) {
    return s3Storage({ bucket: "bkt", prefix: "base", client, ...options });
  }

  describe("configuration", () => {
    it("normalizes the prefix and shows it in the location", () => {
      expect(storage({ prefix: "/prod/mongo/" }).location).toBe("s3://bkt/prod/mongo/");
      expect(storage({ prefix: "" }).location).toBe("s3://bkt/");
      expect(s3Storage({ bucket: "bkt" }).location).toBe("s3://bkt/");
      expect(storage().kind).toBe("s3");
    });

    it("declares conditional writes, range reads and object lock", () => {
      expect(storage().capabilities).toEqual({
        conditionalWrites: true,
        rangeReads: true,
        objectLock: true,
      });
    });

    it.each<[string, Partial<S3StorageOptions>]>([
      ["an empty bucket", { bucket: "" }],
      ["a bucket with a slash", { bucket: "a/b" }],
      ["a prefix with ..", { prefix: "a/../b" }],
      ["a part size below 5 MiB", { partSize: 1024 }],
      ["a zero queue size", { queueSize: 0 }],
      ["an unknown retention mode", { retention: { mode: "legal" as "compliance" } }],
    ])("rejects %s with MS_CONFIG_INVALID", (_label, options) => {
      expect(() => storage(options)).toThrow(
        expect.objectContaining({ code: "MS_CONFIG_INVALID" }),
      );
    });
  });

  describe("put", () => {
    it("sends a small Buffer as one PutObject with all object options", async () => {
      s3.on(PutObjectCommand).resolves({ ETag: '"abc"' });
      const info = await storage({
        storageClass: "STANDARD_IA",
        serverSideEncryption: "aws:kms",
        sseKmsKeyId: "key-1",
      }).put("dir/a.json", Buffer.from("{}"), { contentType: "application/json" });

      expect(info).toMatchObject({ key: "dir/a.json", size: 2, etag: "abc" });
      const input = s3.commandCalls(PutObjectCommand)[0]?.args[0].input;
      expect(input).toMatchObject({
        Bucket: "bkt",
        Key: "base/dir/a.json",
        ContentType: "application/json",
        StorageClass: "STANDARD_IA",
        ServerSideEncryption: "aws:kms",
        SSEKMSKeyId: "key-1",
      });
      expect(input?.IfNoneMatch).toBeUndefined();
    });

    it("counts the bytes of a streamed body", async () => {
      s3.on(PutObjectCommand).resolves({ ETag: '"e"' });
      const info = await storage().put("s", Readable.from([Buffer.from("ab"), Buffer.from("cde")]));
      expect(info.size).toBe(5);
    });

    it("sends If-None-Match: * for conditional writes", async () => {
      s3.on(PutObjectCommand).resolves({ ETag: '"e"' });
      await storage().put("locks/x", Buffer.from("x"), { ifNoneMatch: "*" });
      expect(s3.commandCalls(PutObjectCommand)[0]?.args[0].input.IfNoneMatch).toBe("*");
    });

    it("maps 412 PreconditionFailed to MS_STORAGE_PRECONDITION_FAILED", async () => {
      s3.on(PutObjectCommand).rejects(serviceError("PreconditionFailed", 412));
      const error = await rejection(
        storage().put("locks/x", Buffer.from("x"), { ifNoneMatch: "*" }),
      );
      expect(isMongoShieldError(error, "MS_STORAGE_PRECONDITION_FAILED")).toBe(true);
      expect(String(error)).toContain("s3://bkt/base/locks/x");
    });

    it("maps a 409 ConditionalRequestConflict to MS_STORAGE_PRECONDITION_FAILED", async () => {
      s3.on(PutObjectCommand).rejects(serviceError("ConditionalRequestConflict", 409));
      const error = await rejection(
        storage().put("locks/x", Buffer.from("x"), { ifNoneMatch: "*" }),
      );
      expect(isMongoShieldError(error, "MS_STORAGE_PRECONDITION_FAILED")).toBe(true);
    });

    it("uploads large streams as multipart with the configured part size", async () => {
      s3.on(CreateMultipartUploadCommand).resolves({ UploadId: "upload-1" });
      s3.on(UploadPartCommand).resolves({ ETag: '"part"' });
      s3.on(CompleteMultipartUploadCommand).resolves({ ETag: '"whole-3"' });

      const body = Readable.from([Buffer.alloc(6 * MiB), Buffer.alloc(6 * MiB)]);
      const info = await storage({ partSize: 5 * MiB }).put("big.bin", body, {
        ifNoneMatch: "*",
      });

      expect(info).toMatchObject({ size: 12 * MiB, etag: "whole-3" });
      expect(s3.commandCalls(CreateMultipartUploadCommand)[0]?.args[0].input.Key).toBe(
        "base/big.bin",
      );
      const parts = s3.commandCalls(UploadPartCommand).map((call) => call.args[0].input.PartNumber);
      expect(parts.sort()).toEqual([1, 2, 3]);
      const complete = s3.commandCalls(CompleteMultipartUploadCommand)[0]?.args[0].input;
      expect(complete?.IfNoneMatch).toBe("*");
      expect(complete?.UploadId).toBe("upload-1");
    });

    it("grows the part size when sizeHint would need more than 10,000 parts", async () => {
      s3.on(CreateMultipartUploadCommand).resolves({ UploadId: "u" });
      s3.on(UploadPartCommand).resolves({ ETag: '"p"' });
      s3.on(CompleteMultipartUploadCommand).resolves({ ETag: '"c"' });
      // 10,000 × 6 MiB needs parts larger than the 5 MiB configured below, so the
      // first 6 MiB of data must still fit into part 1.
      const body = Readable.from([Buffer.alloc(6 * MiB), Buffer.alloc(1)]);
      await storage({ partSize: 5 * MiB }).put("hinted", body, { sizeHint: 10_000 * 6 * MiB });
      const sizes = s3
        .commandCalls(UploadPartCommand)
        .map((call) => Buffer.byteLength(call.args[0].input.Body as Buffer));
      expect(sizes.sort((a, b) => b - a)).toEqual([6 * MiB, 1]);
    });

    it("aborts the multipart upload when CompleteMultipartUpload is rejected", async () => {
      s3.on(CreateMultipartUploadCommand).resolves({ UploadId: "upload-2" });
      s3.on(UploadPartCommand).resolves({ ETag: '"part"' });
      s3.on(CompleteMultipartUploadCommand).rejects(serviceError("PreconditionFailed", 412));
      s3.on(AbortMultipartUploadCommand).resolves({});

      const body = Readable.from([Buffer.alloc(6 * MiB)]);
      const error = await rejection(
        storage({ partSize: 5 * MiB }).put("big.bin", body, { ifNoneMatch: "*" }),
      );
      expect(isMongoShieldError(error, "MS_STORAGE_PRECONDITION_FAILED")).toBe(true);
      expect(s3.commandCalls(AbortMultipartUploadCommand)[0]?.args[0].input).toMatchObject({
        Bucket: "bkt",
        Key: "base/big.bin",
        UploadId: "upload-2",
      });
    });

    it("rejects with MS_ABORTED without sending anything when already aborted", async () => {
      const error = await rejection(
        storage().put("x", Buffer.from("x"), { signal: AbortSignal.abort() }),
      );
      expect(isMongoShieldError(error, "MS_ABORTED")).toBe(true);
      expect(s3.calls()).toHaveLength(0);
    });

    it("rejects with MS_ABORTED when aborted while the body is still streaming", async () => {
      const controller = new AbortController();
      const body = new Readable({ read() {} }); // never ends on its own
      body.push(Buffer.from("start"));
      const pending = storage().put("x", body, { signal: controller.signal });
      setTimeout(() => controller.abort(), 10);
      const error = await rejection(pending);
      expect(isMongoShieldError(error, "MS_ABORTED")).toBe(true);
      expect(body.destroyed).toBe(true);
    });
  });

  describe("lastModified after put", () => {
    const serverTime = new Date("2026-10-24T05:56:17.000Z");

    it("uses the local clock and sends no HEAD by default", async () => {
      s3.on(PutObjectCommand).resolves({ ETag: '"e"' });
      const before = Date.now();
      const info = await storage().put("a", Buffer.from("x"));
      expect(info.lastModified.getTime()).toBeGreaterThanOrEqual(before);
      expect(s3.commandCalls(HeadObjectCommand)).toHaveLength(0);
    });

    it("reads the server's value for exactly the object written (If-Match on its ETag)", async () => {
      s3.on(PutObjectCommand).resolves({ ETag: '"e1"' });
      s3.on(HeadObjectCommand).resolves({ LastModified: serverTime, ContentLength: 1 });
      const info = await storage({ exactLastModified: true }).put("a", Buffer.from("x"));
      expect(info.lastModified).toEqual(serverTime);
      expect(s3.commandCalls(HeadObjectCommand)[0]?.args[0].input).toEqual({
        Bucket: "bkt",
        Key: "base/a",
        IfMatch: '"e1"',
      });
    });

    it("names the version instead in versioned buckets, also for multipart uploads", async () => {
      s3.on(CreateMultipartUploadCommand).resolves({ UploadId: "u" });
      s3.on(UploadPartCommand).resolves({ ETag: '"p"' });
      s3.on(CompleteMultipartUploadCommand).resolves({ ETag: '"c-2"', VersionId: "v7" });
      s3.on(HeadObjectCommand).resolves({ LastModified: serverTime });
      const body = Readable.from([Buffer.alloc(6 * MiB)]);
      const info = await storage({ exactLastModified: true, partSize: 5 * MiB }).put("big", body);
      expect(info.lastModified).toEqual(serverTime);
      expect(s3.commandCalls(HeadObjectCommand)[0]?.args[0].input).toEqual({
        Bucket: "bkt",
        Key: "base/big",
        VersionId: "v7",
      });
    });

    it("falls back to the local clock when the HEAD fails or has no date", async () => {
      s3.on(PutObjectCommand).resolves({});
      s3.on(HeadObjectCommand).rejectsOnce(serviceError("PreconditionFailed", 412)).resolves({});
      const adapter = storage({ exactLastModified: true });
      const before = Date.now();
      const first = await adapter.put("a", Buffer.from("x"));
      const second = await adapter.put("a", Buffer.from("x"));
      expect(first.lastModified.getTime()).toBeGreaterThanOrEqual(before);
      expect(second.lastModified.getTime()).toBeGreaterThanOrEqual(before);
      expect(s3.commandCalls(HeadObjectCommand)[1]?.args[0].input.IfMatch).toBeUndefined();
    });

    it("passes the signal to the HEAD and reports MS_ABORTED when it fires there", async () => {
      const controller = new AbortController();
      s3.on(PutObjectCommand).resolves({ ETag: '"e"' });
      s3.on(HeadObjectCommand).callsFake(async () => {
        controller.abort();
        throw Object.assign(new Error("aborted"), { name: "AbortError" });
      });
      const error = await rejection(
        storage({ exactLastModified: true }).put("a", Buffer.from("x"), {
          signal: controller.signal,
        }),
      );
      expect(isMongoShieldError(error, "MS_ABORTED")).toBe(true);
      // The SDK types `args` as just the command; the send options come second.
      expect(s3.commandCalls(HeadObjectCommand)[0]?.args).toEqual([
        expect.anything(),
        expect.objectContaining({ abortSignal: controller.signal }),
      ]);
    });

    it("always reports the server's times from head() and list()", async () => {
      s3.on(HeadObjectCommand).resolves({ LastModified: serverTime, ContentLength: 3 });
      s3.on(ListObjectsV2Command).resolves({
        Contents: [{ Key: "base/a", Size: 3, LastModified: serverTime }],
      });
      expect((await storage().head("a"))?.lastModified).toEqual(serverTime);
      expect((await collect(storage().list("")))[0]?.lastModified).toEqual(serverTime);
    });
  });

  describe("checksums on S3-compatible services", () => {
    it("explains how to fix a multipart completion refused for missing part checksums", async () => {
      s3.on(CreateMultipartUploadCommand).resolves({ UploadId: "u" });
      s3.on(UploadPartCommand).resolves({ ETag: '"p"' });
      s3.on(CompleteMultipartUploadCommand).rejects(
        Object.assign(serviceError("BadRequest", 400), {
          message:
            "The upload was created using a crc32 checksum. The complete request must include the checksum for each part. It was missing for part 1 in the request.",
        }),
      );
      s3.on(AbortMultipartUploadCommand).resolves({});
      const body = Readable.from([Buffer.alloc(6 * MiB)]);
      const error = await rejection(storage({ partSize: 5 * MiB }).put("big", body));
      expect(isMongoShieldError(error, "MS_STORAGE_IO")).toBe(true);
      expect(isMongoShieldError(error) && error.hint).toContain('"WHEN_REQUIRED"');
    });
  });

  describe("get", () => {
    it("requests the prefixed key and returns the body stream", async () => {
      s3.on(GetObjectCommand).resolves({ Body: streamingBody("hello") });
      const stream = await storage().get("dir/a.txt");
      expect(await readAll(stream)).toBe("hello");
      expect(s3.commandCalls(GetObjectCommand)[0]?.args[0].input).toEqual({
        Bucket: "bkt",
        Key: "base/dir/a.txt",
        Range: undefined,
      });
    });

    it.each([
      [{ start: 2, end: 5 }, "bytes=2-5"],
      [{ start: 7 }, "bytes=7-"],
      [{ start: 0, end: 0 }, "bytes=0-0"],
    ])("sends range %j as %s", async (range, header) => {
      s3.on(GetObjectCommand).resolves({ Body: streamingBody("x") });
      await storage().get("a", { range });
      expect(s3.commandCalls(GetObjectCommand)[0]?.args[0].input.Range).toBe(header);
    });

    it("returns an empty stream for a range past the end (416)", async () => {
      s3.on(GetObjectCommand).rejects(serviceError("InvalidRange", 416));
      expect(await readAll(await storage().get("a", { range: { start: 10 } }))).toBe("");
    });

    it("maps NoSuchKey to MS_STORAGE_NOT_FOUND", async () => {
      s3.on(GetObjectCommand).rejects(new NoSuchKey({ $metadata: {}, message: "gone" }));
      const error = await rejection(storage().get("missing"));
      expect(isMongoShieldError(error, "MS_STORAGE_NOT_FOUND")).toBe(true);
      expect(String(error)).toContain("s3://bkt/base/missing");
    });

    it("maps NoSuchBucket to MS_STORAGE_NOT_FOUND with a hint naming the bucket", async () => {
      s3.on(GetObjectCommand).rejects(new NoSuchBucket({ $metadata: {}, message: "no bucket" }));
      const error = await rejection(storage().get("a"));
      expect(isMongoShieldError(error, "MS_STORAGE_NOT_FOUND")).toBe(true);
      expect(isMongoShieldError(error) && error.hint).toContain('"bkt"');
    });

    it("maps AccessDenied to MS_STORAGE_FORBIDDEN with an IAM hint", async () => {
      s3.on(GetObjectCommand).rejects(serviceError("AccessDenied", 403));
      const error = await rejection(storage().get("a"));
      expect(isMongoShieldError(error, "MS_STORAGE_FORBIDDEN")).toBe(true);
      const hint = isMongoShieldError(error) ? error.hint : undefined;
      expect(hint).toContain("s3:GetObject");
      expect(hint).toContain("arn:aws:s3:::bkt/base/*");
      expect(isMongoShieldError(error) && error.details).toMatchObject({
        httpStatusCode: 403,
        requestId: "req-1",
      });
    });

    it("maps a bare 403 to MS_STORAGE_FORBIDDEN and other failures to MS_STORAGE_IO", async () => {
      s3.on(GetObjectCommand)
        .rejectsOnce(serviceError("UnknownError", 403))
        .rejectsOnce(serviceError("InternalError", 500));
      expect(isMongoShieldError(await rejection(storage().get("a")), "MS_STORAGE_FORBIDDEN")).toBe(
        true,
      );
      expect(isMongoShieldError(await rejection(storage().get("a")), "MS_STORAGE_IO")).toBe(true);
    });

    it("maps an SDK AbortError to MS_ABORTED", async () => {
      const controller = new AbortController();
      s3.on(GetObjectCommand).callsFake(() => {
        controller.abort();
        throw Object.assign(new Error("Request aborted"), { name: "AbortError" });
      });
      const error = await rejection(storage().get("a", { signal: controller.signal }));
      expect(isMongoShieldError(error, "MS_ABORTED")).toBe(true);
    });
  });

  describe("head", () => {
    it("returns size, last-modified and an unquoted etag", async () => {
      const lastModified = new Date("2026-01-02T03:04:05Z");
      s3.on(HeadObjectCommand).resolves({
        ContentLength: 12,
        LastModified: lastModified,
        ETag: '"e1"',
      });
      expect(await storage().head("a")).toEqual({ key: "a", size: 12, lastModified, etag: "e1" });
      expect(s3.commandCalls(HeadObjectCommand)[0]?.args[0].input.Key).toBe("base/a");
    });

    it("returns undefined for a 404", async () => {
      s3.on(HeadObjectCommand).rejects(
        new NotFound({ $metadata: { httpStatusCode: 404 }, message: "" }),
      );
      expect(await storage().head("missing")).toBeUndefined();
    });

    it("still reports a missing bucket as an error", async () => {
      s3.on(HeadObjectCommand).rejects(new NoSuchBucket({ $metadata: {}, message: "" }));
      expect(isMongoShieldError(await rejection(storage().head("a")), "MS_STORAGE_NOT_FOUND")).toBe(
        true,
      );
    });
  });

  describe("list", () => {
    it("follows continuation tokens and strips the prefix", async () => {
      const when = new Date("2026-01-01T00:00:00Z");
      s3.on(ListObjectsV2Command)
        .resolvesOnce({
          IsTruncated: true,
          NextContinuationToken: "page-2",
          Contents: [
            { Key: "base/a/1", Size: 1, LastModified: when, ETag: '"x"' },
            { Key: "base/a/2", Size: 2, LastModified: when },
          ],
        })
        .resolvesOnce({
          IsTruncated: false,
          Contents: [{ Key: "base/a/3", Size: 3, LastModified: when }],
        });

      const infos = await collect(storage().list("a/"));
      expect(infos.map((info) => [info.key, info.size])).toEqual([
        ["a/1", 1],
        ["a/2", 2],
        ["a/3", 3],
      ]);
      expect(infos[0]?.etag).toBe("x");

      const inputs = s3.commandCalls(ListObjectsV2Command).map((call) => call.args[0].input);
      expect(inputs).toEqual([
        { Bucket: "bkt", Prefix: "base/a/", ContinuationToken: undefined },
        { Bucket: "bkt", Prefix: "base/a/", ContinuationToken: "page-2" },
      ]);
    });

    it("skips console folder markers and other keys that are not valid storage keys", async () => {
      s3.on(ListObjectsV2Command).resolves({
        Contents: [
          { Key: "base/folder/", Size: 0 },
          { Key: "base/a//b", Size: 1 },
          { Key: "base/ok", Size: 1 },
        ],
      });
      expect((await collect(storage().list(""))).map((info) => info.key)).toEqual(["ok"]);
    });

    it("works without a base prefix", async () => {
      s3.on(ListObjectsV2Command).resolves({ Contents: [{ Key: "top", Size: 1 }] });
      expect((await collect(storage({ prefix: "" }).list(""))).map((info) => info.key)).toEqual([
        "top",
      ]);
      expect(s3.commandCalls(ListObjectsV2Command)[0]?.args[0].input.Prefix).toBe("");
    });

    it("maps listing errors", async () => {
      s3.on(ListObjectsV2Command).rejects(new NoSuchBucket({ $metadata: {}, message: "" }));
      const error = await rejection(collect(storage().list("")));
      expect(isMongoShieldError(error, "MS_STORAGE_NOT_FOUND")).toBe(true);
    });
  });

  describe("listPrefixes", () => {
    it("uses the / delimiter, paginates and strips the prefix", async () => {
      s3.on(ListObjectsV2Command)
        .resolvesOnce({
          IsTruncated: true,
          NextContinuationToken: "t2",
          CommonPrefixes: [{ Prefix: "base/backups/2026-01/" }],
        })
        .resolvesOnce({ CommonPrefixes: [{ Prefix: "base/backups/2026-02/" }] });

      expect(await collect(storage().listPrefixes("backups/"))).toEqual([
        "backups/2026-01/",
        "backups/2026-02/",
      ]);
      const inputs = s3.commandCalls(ListObjectsV2Command).map((call) => call.args[0].input);
      expect(inputs[0]).toMatchObject({ Prefix: "base/backups/", Delimiter: "/" });
      expect(inputs[1]).toMatchObject({ ContinuationToken: "t2", Delimiter: "/" });
    });
  });

  describe("delete", () => {
    it("deletes in batches of 1000 with quiet mode", async () => {
      s3.on(DeleteObjectsCommand).resolves({});
      const keys = Array.from({ length: 2500 }, (_, index) => `k/${index}`);
      await storage().delete(keys);

      const batches = s3
        .commandCalls(DeleteObjectsCommand)
        .map((call) => call.args[0].input.Delete);
      expect(batches.map((batch) => batch?.Objects?.length)).toEqual([1000, 1000, 500]);
      expect(batches[0]?.Quiet).toBe(true);
      expect(batches[0]?.Objects?.[0]).toEqual({ Key: "base/k/0" });
    });

    it("sends nothing for an empty key list", async () => {
      await storage().delete([]);
      expect(s3.calls()).toHaveLength(0);
    });

    it("validates every key before deleting anything", async () => {
      await expect(storage().delete(["ok", "../bad"])).rejects.toThrow(/Invalid storage key/);
      expect(s3.calls()).toHaveLength(0);
    });

    it("throws when S3 reports per-key failures", async () => {
      s3.on(DeleteObjectsCommand).resolves({
        Errors: [
          { Key: "base/a", Code: "AccessDenied", Message: "nope" },
          { Key: "base/b", Code: "InternalError", Message: "oops" },
        ],
      });
      const error = await rejection(storage().delete(["a", "b"]));
      expect(isMongoShieldError(error, "MS_STORAGE_FORBIDDEN")).toBe(true);
      expect(String(error)).toContain("s3://bkt/base/a (and 1 more)");
    });

    it("ignores NoSuchKey entries reported by S3-compatible stores", async () => {
      s3.on(DeleteObjectsCommand).resolves({ Errors: [{ Key: "base/a", Code: "NoSuchKey" }] });
      await storage().delete(["a"]);
    });
  });

  describe("close", () => {
    it("leaves a caller-supplied client open", async () => {
      s3.on(HeadObjectCommand).resolves({ ContentLength: 1 });
      const adapter = storage();
      await adapter.head("a");
      await adapter.close?.();
      await adapter.close?.();
      // The client still works after close().
      expect(await storage().head("a")).toBeDefined();
    });

    it("can close an adapter that never connected", async () => {
      await s3Storage({ bucket: "bkt", region: "us-east-1" }).close?.();
    });
  });

  describe("edge cases of responses and errors", () => {
    it("skips listed keys and common prefixes outside the base prefix or not valid as keys", async () => {
      s3.on(ListObjectsV2Command).resolves({
        Contents: [{ Key: "elsewhere/a", Size: 1 }, { Key: undefined }, { Key: "base/ok" }],
        CommonPrefixes: [{ Prefix: "base/a//" }, { Prefix: "elsewhere/" }, { Prefix: "base/b/" }],
      });
      const infos = await collect(storage().list(""));
      expect(infos).toEqual([{ key: "ok", size: 0, lastModified: new Date(0) }]);
      expect(await collect(storage().listPrefixes(""))).toEqual(["b/"]);
    });

    it("reports a GetObject response without a readable body as MS_STORAGE_IO", async () => {
      s3.on(GetObjectCommand).resolves({});
      const error = await rejection(storage().get("a"));
      expect(isMongoShieldError(error, "MS_STORAGE_IO")).toBe(true);
      expect(String(error)).toContain("no readable body");
    });

    it("describes per-key delete failures that lack a key, code or message", async () => {
      s3.on(DeleteObjectsCommand).resolves({
        Errors: [{ Code: undefined, Message: undefined, Key: "outside/x" }, {}],
      });
      const error = await rejection(storage().delete(["a", "b"]));
      expect(isMongoShieldError(error, "MS_STORAGE_IO")).toBe(true);
      expect(String(error)).toContain("outside/x (and 1 more)");
      expect(String(error)).toContain("DeleteFailed: delete failed");
    });

    it("maps a rejected DeleteObjects request", async () => {
      s3.on(DeleteObjectsCommand).rejects(serviceError("AccessDenied", 403));
      const error = await rejection(storage().delete(["a"]));
      expect(isMongoShieldError(error, "MS_STORAGE_FORBIDDEN")).toBe(true);
      expect(String(error)).toContain("s3://bkt/base/a");
    });

    it("maps values thrown without a name or an Error wrapper", async () => {
      // Not an Error, and a name that is not a string: nothing about it can be trusted.
      s3.on(HeadObjectCommand).rejects({ name: 42, message: "odd" } as unknown as Error);
      const odd = await rejection(storage().head("a"));
      expect(isMongoShieldError(odd, "MS_STORAGE_IO")).toBe(true);
      s3.on(GetObjectCommand).callsFake(() => Promise.reject("plain string"));
      const plain = await rejection(storage().get("a"));
      expect(isMongoShieldError(plain, "MS_STORAGE_IO")).toBe(true);
      expect(String(plain)).toContain("plain string");
    });

    it("maps an SDK AbortError to MS_ABORTED even without a signal", async () => {
      s3.on(HeadObjectCommand).rejects(Object.assign(new Error("aborted"), { name: "AbortError" }));
      const error = await rejection(storage().head("a"));
      expect(isMongoShieldError(error, "MS_ABORTED")).toBe(true);
    });

    it("reports a head without a size as size 0", async () => {
      s3.on(HeadObjectCommand).resolves({ LastModified: new Date(5) });
      expect(await storage().head("a")).toEqual({ key: "a", size: 0, lastModified: new Date(5) });
    });

    it("counts string chunks of a streamed body as UTF-8 bytes", async () => {
      s3.on(PutObjectCommand).resolves({ ETag: '"e"' });
      const info = await storage().put("s", Readable.from(["héllo"], { objectMode: true }));
      expect(info.size).toBe(6);
    });

    it("rejects a non-integer queue size", () => {
      expect(() => storage({ queueSize: 1.5 })).toThrow(
        expect.objectContaining({ code: "MS_CONFIG_INVALID" }),
      );
    });
  });

  describe("clients the adapter creates", () => {
    // mockClient on the class mocks every instance, including ones built inside the adapter.
    let classMock: ReturnType<typeof mockClient>;

    beforeEach(() => {
      classMock = mockClient(S3Client);
      classMock.on(HeadObjectCommand).resolves({ ContentLength: 1 });
    });

    afterEach(() => {
      classMock.restore();
    });

    /** The config of the S3Client that sent the first request. */
    async function createdConfig(options: Omit<S3StorageOptions, "bucket">) {
      const adapter = s3Storage({
        bucket: "bkt",
        credentials: { accessKeyId: "a", secretAccessKey: "b" },
        ...options,
      });
      await adapter.head("a");
      const created = classMock.send.getCall(0).thisValue;
      await adapter.close?.();
      if (!(created instanceof S3Client)) throw new Error("no client was created");
      return created.config;
    }

    it("uses us-east-1 with a custom endpoint and no region", async () => {
      const config = await createdConfig({
        endpoint: "http://localhost:9000",
        forcePathStyle: true,
      });
      expect(await config.region()).toBe("us-east-1");
      expect(config.forcePathStyle).toBe(true);
    });

    it("uses the configured region", async () => {
      const config = await createdConfig({ region: "eu-central-1" });
      expect(await config.region()).toBe("eu-central-1");
    });

    it("passes requestChecksumCalculation to the client", async () => {
      const config = await createdConfig({
        region: "eu-central-1",
        requestChecksumCalculation: "WHEN_REQUIRED",
      });
      expect(await config.requestChecksumCalculation()).toBe("WHEN_REQUIRED");
    });

    it("keeps the SDK default checksum mode otherwise", async () => {
      const config = await createdConfig({ region: "eu-central-1" });
      expect(await config.requestChecksumCalculation()).toBe("WHEN_SUPPORTED");
    });
  });

  describe("object lock (immutable backups)", () => {
    const retainUntil = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

    function lockEnabled(): void {
      s3.on(GetObjectLockConfigurationCommand).resolves({
        ObjectLockConfiguration: { ObjectLockEnabled: "Enabled" },
      });
    }

    it("sends COMPLIANCE mode, the retain-until date and a CRC32 checksum by default", async () => {
      lockEnabled();
      s3.on(PutObjectCommand).resolves({ ETag: '"e"' });
      await storage().put("b/manifest.json", Buffer.from("{}"), { retainUntil });
      const input = s3.commandCalls(PutObjectCommand)[0]?.args[0].input;
      expect(input).toMatchObject({
        Key: "base/b/manifest.json",
        ObjectLockMode: "COMPLIANCE",
        ObjectLockRetainUntilDate: retainUntil,
        // S3 refuses Object Lock puts without Content-MD5 or an x-amz-checksum-* header.
        ChecksumAlgorithm: "CRC32",
      });
      expect(s3.commandCalls(GetObjectLockConfigurationCommand)[0]?.args[0].input).toEqual({
        Bucket: "bkt",
      });
    });

    it("uses GOVERNANCE mode when configured", async () => {
      lockEnabled();
      s3.on(PutObjectCommand).resolves({ ETag: '"e"' });
      await storage({ retention: { mode: "governance" } }).put("a", Buffer.from("x"), {
        retainUntil,
      });
      expect(s3.commandCalls(PutObjectCommand)[0]?.args[0].input.ObjectLockMode).toBe("GOVERNANCE");
    });

    it("sends no Object Lock fields and checks nothing for ordinary puts", async () => {
      s3.on(PutObjectCommand).resolves({ ETag: '"e"' });
      await storage().put("a", Buffer.from("x"));
      const input = s3.commandCalls(PutObjectCommand)[0]?.args[0].input;
      expect(input?.ObjectLockMode).toBeUndefined();
      expect(input?.ObjectLockRetainUntilDate).toBeUndefined();
      expect(s3.commandCalls(GetObjectLockConfigurationCommand)).toHaveLength(0);
    });

    it("locks multipart uploads at CreateMultipartUpload and checksums every part", async () => {
      lockEnabled();
      s3.on(CreateMultipartUploadCommand).resolves({ UploadId: "u" });
      s3.on(UploadPartCommand).resolves({ ETag: '"p"' });
      s3.on(CompleteMultipartUploadCommand).resolves({ ETag: '"c"' });
      const body = Readable.from([Buffer.alloc(6 * MiB)]);
      await storage({ partSize: 5 * MiB }).put("big.bin", body, { retainUntil });
      expect(s3.commandCalls(CreateMultipartUploadCommand)[0]?.args[0].input).toMatchObject({
        ObjectLockMode: "COMPLIANCE",
        ObjectLockRetainUntilDate: retainUntil,
        ChecksumAlgorithm: "CRC32",
      });
      for (const call of s3.commandCalls(UploadPartCommand)) {
        expect(call.args[0].input.ChecksumAlgorithm).toBe("CRC32");
      }
    });

    it("checks the bucket configuration only once per adapter", async () => {
      lockEnabled();
      s3.on(PutObjectCommand).resolves({ ETag: '"e"' });
      const adapter = storage();
      await adapter.put("a", Buffer.from("a"), { retainUntil });
      await adapter.put("b", Buffer.from("b"), { retainUntil });
      expect(s3.commandCalls(GetObjectLockConfigurationCommand)).toHaveLength(1);
    });

    it.each([
      ["has never had Object Lock", serviceError("ObjectLockConfigurationNotFoundError", 404)],
      ["is an S3-compatible store without Object Lock", serviceError("NotImplemented", 501)],
    ])(
      "fails with MS_CONFIG_INVALID before uploading when the bucket %s",
      async (_label, error) => {
        s3.on(GetObjectLockConfigurationCommand).rejects(error);
        const failure = await rejection(storage().put("a", Buffer.from("x"), { retainUntil }));
        expect(isMongoShieldError(failure, "MS_CONFIG_INVALID"), String(failure)).toBe(true);
        expect(isMongoShieldError(failure) && failure.hint).toContain(
          "put-object-lock-configuration --bucket bkt",
        );
        expect(s3.commandCalls(PutObjectCommand)).toHaveLength(0);
      },
    );

    it("fails with MS_CONFIG_INVALID when Object Lock is configured but not enabled", async () => {
      s3.on(GetObjectLockConfigurationCommand).resolves({ ObjectLockConfiguration: {} });
      const failure = await rejection(storage().put("a", Buffer.from("x"), { retainUntil }));
      expect(isMongoShieldError(failure, "MS_CONFIG_INVALID")).toBe(true);
      expect(s3.commandCalls(PutObjectCommand)).toHaveLength(0);
    });

    it("skips the check without permission and maps S3's own refusal to MS_CONFIG_INVALID", async () => {
      s3.on(GetObjectLockConfigurationCommand).rejects(serviceError("AccessDenied", 403));
      s3.on(PutObjectCommand).rejects(
        new S3ServiceException({
          name: "InvalidRequest",
          $fault: "client",
          $metadata: { httpStatusCode: 400 },
          message: "Bucket is missing Object Lock Configuration",
        }),
      );
      const failure = await rejection(storage().put("a", Buffer.from("x"), { retainUntil }));
      expect(isMongoShieldError(failure, "MS_CONFIG_INVALID"), String(failure)).toBe(true);
      expect(s3.commandCalls(PutObjectCommand)).toHaveLength(1);
    });

    it("also skips the check on a bare 403 and on unnamed errors it cannot classify", async () => {
      s3.on(GetObjectLockConfigurationCommand).rejectsOnce(serviceError("Weird", 403));
      s3.on(PutObjectCommand).resolves({ ETag: '"e"' });
      await storage().put("a", Buffer.from("x"), { retainUntil });
      expect(s3.commandCalls(PutObjectCommand)).toHaveLength(1);

      s3.on(GetObjectLockConfigurationCommand).rejects(serviceError("InternalError", 500));
      const failure = await rejection(storage().put("b", Buffer.from("x"), { retainUntil }));
      expect(isMongoShieldError(failure, "MS_STORAGE_IO")).toBe(true);
    });

    it("rejects a retainUntil in the past without sending anything", async () => {
      const failure = await rejection(
        storage().put("a", Buffer.from("x"), { retainUntil: new Date(Date.now() - 1000) }),
      );
      expect(isMongoShieldError(failure, "MS_CONFIG_INVALID")).toBe(true);
      expect(s3.calls()).toHaveLength(0);
    });

    it("mentions s3:PutObjectRetention when a retained put is denied", async () => {
      lockEnabled();
      s3.on(PutObjectCommand).rejects(serviceError("AccessDenied", 403));
      const failure = await rejection(storage().put("a", Buffer.from("x"), { retainUntil }));
      expect(isMongoShieldError(failure, "MS_STORAGE_FORBIDDEN")).toBe(true);
      expect(isMongoShieldError(failure) && failure.hint).toContain("s3:PutObjectRetention");
    });
  });
});
