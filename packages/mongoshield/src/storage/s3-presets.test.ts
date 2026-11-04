/**
 * Tests for the Backblaze B2 and Cloudflare R2 presets: the S3 client each one builds
 * (endpoint, region, path style, checksum settings, conditional writes), from the
 * factories and from `b2://` / `r2://` URLs, and the refusals for bad input.
 */

import {
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  type S3ClientConfig,
} from "@aws-sdk/client-s3";
import { mockClient } from "aws-sdk-client-mock";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isMongoShieldError } from "../errors.ts";
import { resolveStorage } from "./resolve.ts";
import { b2S3Options, b2Storage, r2S3Options, r2Storage } from "./s3-presets.ts";
import type { StorageAdapter } from "./types.ts";

/** The resolved settings of the S3 client an adapter created for its first request. */
interface ClientSettings {
  readonly endpoint: string;
  readonly region: string;
  readonly forcePathStyle: boolean | undefined;
  readonly requestChecksumCalculation: string;
  readonly responseChecksumValidation: string;
}

describe("the B2 and R2 presets", () => {
  // mockClient on the class mocks every instance, including ones built inside the adapter.
  let classMock: ReturnType<typeof mockClient>;

  beforeEach(() => {
    classMock = mockClient(S3Client);
    classMock.on(HeadObjectCommand).resolves({ ContentLength: 1 });
  });

  afterEach(() => {
    classMock.restore();
  });

  /** Sends one request through `storage` and reads back the client's configuration. */
  async function settingsOf(storage: StorageAdapter): Promise<ClientSettings> {
    await storage.head("probe");
    const created = classMock.send.getCall(0).thisValue;
    await storage.close?.();
    if (!(created instanceof S3Client)) throw new Error("no client was created");
    const config = created.config as S3Client["config"] & Pick<S3ClientConfig, "forcePathStyle">;
    const endpoint = await config.endpoint?.();
    return {
      endpoint: `${endpoint?.protocol}//${endpoint?.hostname}${endpoint?.path ?? ""}`,
      region: await config.region(),
      forcePathStyle: config.forcePathStyle,
      requestChecksumCalculation: await config.requestChecksumCalculation(),
      responseChecksumValidation: await config.responseChecksumValidation(),
    };
  }

  const credentials = { accessKeyId: "keyID", secretAccessKey: "applicationKey" };

  it("points B2 at s3.<region>.backblazeb2.com, path-style, with WHEN_REQUIRED checksums", async () => {
    const settings = await settingsOf(
      b2Storage({ bucket: "acme", prefix: "prod", region: "us-west-004", credentials }),
    );
    expect(settings).toEqual({
      endpoint: "https://s3.us-west-004.backblazeb2.com/",
      region: "us-west-004",
      forcePathStyle: true,
      requestChecksumCalculation: "WHEN_REQUIRED",
      responseChecksumValidation: "WHEN_REQUIRED",
    });
  });

  it("points R2 at <account>.r2.cloudflarestorage.com with region auto", async () => {
    const accountId = "0123456789abcdef0123456789ABCDEF";
    const settings = await settingsOf(r2Storage({ accountId, bucket: "acme", credentials }));
    expect(settings).toEqual({
      endpoint: "https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com/",
      region: "auto",
      forcePathStyle: false,
      requestChecksumCalculation: "WHEN_REQUIRED",
      responseChecksumValidation: "WHEN_REQUIRED",
    });
  });

  it("uses the jurisdiction's own R2 endpoint", () => {
    const options = r2S3Options({
      accountId: "0123456789abcdef0123456789abcdef",
      bucket: "acme",
      jurisdiction: "eu",
    });
    expect(options.endpoint).toBe(
      "https://0123456789abcdef0123456789abcdef.eu.r2.cloudflarestorage.com",
    );
    expect(options).not.toHaveProperty("accountId");
    expect(options).not.toHaveProperty("jurisdiction");
  });

  it("lets explicit checksum settings win over the preset's", () => {
    const options = b2S3Options({
      bucket: "acme",
      region: "eu-central-003",
      requestChecksumCalculation: "WHEN_SUPPORTED",
    });
    expect(options.requestChecksumCalculation).toBe("WHEN_SUPPORTED");
    expect(options.responseChecksumValidation).toBe("WHEN_REQUIRED");
  });

  it("trusts R2's conditional writes but probes B2's once", async () => {
    // R2: no probe; the conditional put goes straight out with If-None-Match.
    classMock.on(PutObjectCommand).resolves({ ETag: '"e"' });
    const r2 = r2Storage({ accountId: "0".repeat(32), bucket: "acme", credentials });
    await r2.put("locks/run.lock", Buffer.from("x"), { ifNoneMatch: "*" });
    const r2Keys = classMock.commandCalls(PutObjectCommand).map((call) => call.args[0].input.Key);
    expect(r2Keys).toEqual(["locks/run.lock"]);

    // B2: the first conditional put writes a probe object first.
    classMock.resetHistory();
    const b2 = b2Storage({ bucket: "acme", region: "us-west-004", credentials });
    await b2.put("locks/run.lock", Buffer.from("x"), { ifNoneMatch: "*" }).catch(() => undefined);
    const b2Keys = classMock.commandCalls(PutObjectCommand).map((call) => call.args[0].input.Key);
    expect(b2Keys[0]).toMatch(/^locks\/\.conditional-write-probe-/);
  });

  it.each([
    [() => b2Storage({ bucket: "acme", region: "us-west-2" }), "Backblaze B2 region"],
    [() => b2Storage({ bucket: "acme", region: "" }), "Backblaze B2 region"],
    [() => r2Storage({ accountId: "not-an-account", bucket: "acme" }), "account id"],
    [
      () => r2Storage({ accountId: "0".repeat(32), bucket: "acme", jurisdiction: "us" as "eu" }),
      "jurisdiction",
    ],
  ])("refuses bad input with MS_CONFIG_INVALID (%#)", (create, text) => {
    let caught: unknown;
    try {
      create();
    } catch (error) {
      caught = error;
    }
    expect(isMongoShieldError(caught, "MS_CONFIG_INVALID")).toBe(true);
    expect(String(caught)).toContain(text);
  });
});

describe("resolveStorage for b2:// and r2://", () => {
  let classMock: ReturnType<typeof mockClient>;

  beforeEach(() => {
    classMock = mockClient(S3Client);
    classMock.on(HeadObjectCommand).resolves({ ContentLength: 1 });
  });

  afterEach(() => {
    classMock.restore();
  });

  async function endpointOf(url: string): Promise<string> {
    const storage = await resolveStorage(url);
    await storage.head("probe");
    const created = classMock.send.getCall(0).thisValue;
    if (!(created instanceof S3Client)) throw new Error("no client was created");
    const endpoint = await created.config.endpoint?.();
    return `${endpoint?.hostname}`;
  }

  it("parses bucket, prefix and region from b2:// URLs", async () => {
    const storage = await resolveStorage("b2://acme-backups/prod/mongo?region=us-west-004");
    expect(storage.kind).toBe("s3");
    expect(storage.location).toBe("s3://acme-backups/prod/mongo/");
    expect(await endpointOf("b2://acme-backups?region=US-WEST-004")).toBe(
      "s3.us-west-004.backblazeb2.com",
    );
  });

  it("parses account, bucket, prefix and jurisdiction from r2:// URLs", async () => {
    const account = "0123456789abcdef0123456789abcdef";
    const storage = await resolveStorage(`r2://${account}/acme-backups/prod/mongo`);
    expect(storage.location).toBe("s3://acme-backups/prod/mongo/");
    expect(await endpointOf(`r2://${account}/acme?jurisdiction=EU`)).toBe(
      `${account}.eu.r2.cloudflarestorage.com`,
    );
  });

  it("accepts the S3 adapter's own parameters", async () => {
    const storage = await resolveStorage(
      "b2://acme?region=us-west-004&partSizeMiB=8&queueSize=2&conditionalWrites=false&retention=governance",
    );
    expect(storage.capabilities.conditionalWrites).toBe(false);
    const r2 = await resolveStorage(
      `r2://${"a".repeat(32)}/acme?requestChecksumCalculation=when_supported&exactLastModified=true`,
    );
    expect(r2.kind).toBe("s3");
  });

  it.each([
    ["b2://acme", "needs a bucket and a region"],
    ["b2://?region=us-west-004", "needs a bucket and a region"],
    ["b2://acme?region=us-west-2", "Backblaze B2 region"],
    ["b2://acme?region=us-west-004&endpoint=https%3A%2F%2Fexample.com", 'parameter "endpoint"'],
    ["b2://acme?region=us-west-004&forcePathStyle=false", 'parameter "forcePathStyle"'],
    ["b2://keyID:secret@acme?region=us-west-004", "must not contain credentials"],
    [`r2://${"a".repeat(32)}`, "needs an account id and a bucket"],
    ["r2://acme-backups/prod", "account id"],
    [`r2://${"a".repeat(32)}/acme?region=auto`, 'parameter "region"'],
    [`r2://${"a".repeat(32)}/acme?jurisdiction=us`, "Invalid R2 jurisdiction"],
    [`r2://key:secret@${"a".repeat(32)}/acme`, "must not contain credentials"],
  ])("rejects %s with MS_CONFIG_INVALID", async (url, text) => {
    const error = await resolveStorage(url).catch((reason: unknown) => reason);
    expect(isMongoShieldError(error, "MS_CONFIG_INVALID")).toBe(true);
    expect(String(error)).toContain(text);
    expect(String(error)).not.toContain("secret");
  });

  it("names the application key mapping in the B2 credential hint", async () => {
    const error = await resolveStorage("b2://id:key@acme?region=us-west-004").catch(
      (reason: unknown) => reason,
    );
    expect(isMongoShieldError(error) && error.hint).toContain("application key's keyID");
  });
});
