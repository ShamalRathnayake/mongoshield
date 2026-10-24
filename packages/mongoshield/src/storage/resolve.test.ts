/**
 * Tests for `resolveStorage`: which adapter each URL form produces, and that
 * bad URLs fail with MS_CONFIG_INVALID and a helpful hint.
 */

import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isMongoShieldError } from "../errors.ts";
import { resolveStorage } from "./resolve.ts";

async function configError(url: string) {
  const error = await resolveStorage(url).catch((reason: unknown) => reason);
  expect(isMongoShieldError(error, "MS_CONFIG_INVALID")).toBe(true);
  return isMongoShieldError(error) ? error : undefined;
}

describe("resolveStorage", () => {
  it("resolves file:// URLs to the file adapter", async () => {
    const directory = join(tmpdir(), "ms-resolve");
    const storage = await resolveStorage(pathToFileURL(directory).href);
    expect(storage.kind).toBe("file");
    expect(storage.location).toBe(`${pathToFileURL(directory).href}/`);
  });

  it.each(["./backups", "backups/nested", "/var/tmp/backups"])(
    "treats the bare path %s as a directory",
    async (path) => {
      const storage = await resolveStorage(path);
      expect(storage.kind).toBe("file");
      expect(storage.location).toBe(`${pathToFileURL(resolve(path)).href}/`);
    },
  );

  it("parses bucket, prefix and options from s3:// URLs", async () => {
    const storage = await resolveStorage(
      "s3://my-bucket/prod/mongo?region=eu-west-1&endpoint=http://localhost:9000&forcePathStyle=true",
    );
    expect(storage.kind).toBe("s3");
    expect(storage.location).toBe("s3://my-bucket/prod/mongo/");
  });

  it("accepts an s3:// URL without a prefix", async () => {
    expect((await resolveStorage("s3://bucket")).location).toBe("s3://bucket/");
  });

  it("returns the same memory store for the same name", async () => {
    const first = await resolveStorage("memory://shared");
    await first.put("a", Buffer.from("x"));
    const second = await resolveStorage("memory://shared");
    expect(second).toBe(first);
    expect(await second.head("a")).toBeDefined();
    expect((await resolveStorage("memory://other")).location).toBe("memory://other/");
  });

  it("rejects unknown schemes and lists the supported ones", async () => {
    const error = await configError("ftp://host/prefix");
    expect(error?.hint).toContain("file://, s3://, gs://, az://, sftp://, memory://");
  });

  it("rejects credentials in s3:// URLs", async () => {
    const error = await configError("s3://key:secret@bucket/prefix");
    expect(error?.message).not.toContain("secret");
    expect(error?.hint).toContain("AWS_ACCESS_KEY_ID");
  });

  it.each([
    "s3://bucket?regoin=eu-west-1",
    "s3://bucket?forcePathStyle=maybe",
    "s3://bucket?endpoint=not a url",
    "s3://bucket/a//b",
    "file://remote-host/share",
    "",
  ])("rejects %j with MS_CONFIG_INVALID", async (url) => {
    await configError(url);
  });
});

describe("resolveStorage retention parameter", () => {
  it.each([
    "s3://bucket/p?retention=governance",
    "s3://bucket/p?retention=compliance",
    "gs://bucket/p?retention=governance",
    "az://acct/container/p?retention=governance",
  ])("accepts %s", async (url) => {
    expect((await resolveStorage(url)).capabilities.objectLock).toBe(true);
  });

  it.each([
    "s3://bucket?retention=legal",
    "gs://bucket?retention=",
    "az://acct/container?retention=COMPLIANCE",
  ])("rejects %s with a hint listing the modes", async (url) => {
    const error = await configError(url);
    expect(error?.hint).toContain("retention=governance");
  });
});

describe("resolveStorage for gs://", () => {
  it("parses bucket, prefix and projectId", async () => {
    const storage = await resolveStorage("gs://my-bucket/prod/mongo?projectId=my-project");
    expect(storage.kind).toBe("gcs");
    expect(storage.location).toBe("gs://my-bucket/prod/mongo/");
    expect((await resolveStorage("gs://bucket")).location).toBe("gs://bucket/");
  });

  it.each(["gs://user:secret@bucket/p", "gs://bucket?project=x", "gs:///prefix"])(
    "rejects %j with MS_CONFIG_INVALID",
    async (url) => {
      const error = await configError(url);
      expect(error?.message).not.toContain("secret");
    },
  );
});

describe("resolveStorage for az://", () => {
  beforeEach(() => {
    vi.stubEnv("AZURE_STORAGE_CONNECTION_STRING", "");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("parses account, container and prefix, using DefaultAzureCredential by default", async () => {
    const storage = await resolveStorage("az://myaccount/backups/prod/mongo");
    expect(storage.kind).toBe("azure");
    expect(storage.location).toBe("az://myaccount/backups/prod/mongo/");
  });

  it("uses AZURE_STORAGE_CONNECTION_STRING when it is for the same account", async () => {
    vi.stubEnv(
      "AZURE_STORAGE_CONNECTION_STRING",
      "DefaultEndpointsProtocol=https;AccountName=myaccount;AccountKey=c2VjcmV0",
    );
    expect((await resolveStorage("az://myaccount/backups")).location).toBe(
      "az://myaccount/backups/",
    );
  });

  it("refuses a connection string for a different account", async () => {
    vi.stubEnv(
      "AZURE_STORAGE_CONNECTION_STRING",
      "DefaultEndpointsProtocol=https;AccountName=other;AccountKey=c2VjcmV0",
    );
    const error = await configError("az://myaccount/backups");
    expect(error?.message).not.toContain("c2VjcmV0");
  });

  it.each([
    "az://myaccount",
    "az://myaccount/",
    "az://key:secret@myaccount/backups",
    "az://myaccount/backups?sig=abc",
    "az://myaccount/backups?endpoint=not a url",
    "az://myaccount/Bad_Container",
  ])("rejects %j with MS_CONFIG_INVALID", async (url) => {
    const error = await configError(url);
    expect(error?.message).not.toContain("secret");
  });
});

describe("resolveStorage for sftp://", () => {
  const fingerprint = `SHA256:${"A".repeat(20)}+/${"B".repeat(21)}`;

  beforeEach(() => {
    vi.stubEnv("MONGOSHIELD_SFTP_KEY_FILE", "/run/secrets/id_ed25519");
    vi.stubEnv("MONGOSHIELD_SFTP_KEY_PASSPHRASE", "");
    vi.stubEnv("MONGOSHIELD_SFTP_HOST_FINGERPRINT", "");
    vi.stubEnv("SSH_AUTH_SOCK", "");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("parses user, host, port, path and the host fingerprint", async () => {
    const storage = await resolveStorage(
      `sftp://backup@example.com:2222/srv/backups?fingerprint=${encodeURIComponent(fingerprint)}`,
    );
    expect(storage.kind).toBe("sftp");
    expect(storage.location).toBe("sftp://backup@example.com:2222/srv/backups/");
  });

  it("accepts an unencoded + in the fingerprint and /~/ for paths in the login directory", async () => {
    const storage = await resolveStorage(
      `sftp://backup@example.com/~/backups?fingerprint=${fingerprint}`,
    );
    expect(storage.location).toBe("sftp://backup@example.com/~/backups/");
  });

  it("takes fingerprints from MONGOSHIELD_SFTP_HOST_FINGERPRINT", async () => {
    vi.stubEnv("MONGOSHIELD_SFTP_HOST_FINGERPRINT", `${fingerprint}, SHA256:${"C".repeat(43)}`);
    expect((await resolveStorage("sftp://backup@[::1]/data")).location).toBe(
      "sftp://backup@[::1]/data/",
    );
  });

  it("refuses unknown hosts unless allowUnknownHostKey=true", async () => {
    const error = await configError("sftp://backup@example.com/data");
    expect(error?.hint).toContain("ssh-keyscan");
    const storage = await resolveStorage("sftp://backup@example.com/data?allowUnknownHostKey=true");
    expect(storage.kind).toBe("sftp");
  });

  it("uses the SSH agent when no key file is configured", async () => {
    vi.stubEnv("MONGOSHIELD_SFTP_KEY_FILE", "");
    vi.stubEnv("SSH_AUTH_SOCK", "/tmp/agent.sock");
    const storage = await resolveStorage(
      `sftp://backup@example.com/data?fingerprint=${fingerprint}`,
    );
    expect(storage.kind).toBe("sftp");
  });

  it("needs a key file or an agent", async () => {
    vi.stubEnv("MONGOSHIELD_SFTP_KEY_FILE", "");
    const error = await configError(`sftp://backup@example.com/data?fingerprint=${fingerprint}`);
    expect(error?.hint).toContain("MONGOSHIELD_SFTP_KEY_FILE");
  });

  it("rejects passwords in the URL without echoing them", async () => {
    const error = await configError(
      `sftp://backup:hunter2@example.com/data?fingerprint=${fingerprint}`,
    );
    expect(error?.message).not.toContain("hunter2");
    expect(error?.hint).toContain("key authentication");
  });

  it.each([
    "sftp://example.com/data",
    "sftp://backup@example.com",
    "sftp://backup@example.com/~",
    "sftp://backup@example.com/data?fingerprint=MD5:aa",
    "sftp://backup@example.com/data?password=x",
    "sftp://backup@example.com/data?allowUnknownHostKey=maybe",
  ])("rejects %j with MS_CONFIG_INVALID", async (url) => {
    await configError(url);
  });
});
