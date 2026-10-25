/**
 * Unit tests for storage URLs as form fields: building every type, parsing back (with
 * the round-trip guarantee and the URL-mode fallbacks), provider presets and validation.
 */

import { describe, expect, it } from "vitest";
import {
  buildStorageUrl,
  emptyStorageFields,
  fingerprintsOf,
  parseStorageUrl,
  type StorageFields,
  s3CompatibleTarget,
  storageFieldErrors,
  storageSchemeOf,
} from "./storage-url.ts";

/** Fields of `kind` with some values filled in. */
function fieldsOf(kind: StorageFields["kind"], values: Partial<StorageFields>): StorageFields {
  return { ...emptyStorageFields(kind), ...values };
}

/** A valid fingerprint (43 base64 characters). */
const FINGERPRINT = "SHA256:k3S1xS1v8bM0gYp4m7bJ1rQ6yQ0b0v8vXr5Y2rVwA6c";

describe("buildStorageUrl", () => {
  it("builds local folders as they are, trimmed", () => {
    expect(buildStorageUrl(fieldsOf("local", { folder: " backups/prod " }))).toBe("backups/prod");
  });

  it("builds S3 URLs with an optional region", () => {
    expect(buildStorageUrl(fieldsOf("s3", { bucket: "acme", prefix: "/prod/" }))).toBe(
      "s3://acme/prod/",
    );
    expect(buildStorageUrl(fieldsOf("s3", { bucket: "acme", region: "eu-west-1" }))).toBe(
      "s3://acme/?region=eu-west-1",
    );
    // Parameters the fields do not cover come last, verbatim.
    expect(
      buildStorageUrl(
        fieldsOf("s3", { bucket: "acme", region: "eu-west-1", extraQuery: "retention=governance" }),
      ),
    ).toBe("s3://acme/?region=eu-west-1&retention=governance");
  });

  it("builds S3-compatible URLs from the provider presets", () => {
    const r2 = fieldsOf("s3-compatible", { bucket: "b", provider: "r2", providerValue: "abc123" });
    expect(buildStorageUrl(r2)).toBe(
      "s3://b/?region=auto&endpoint=https://abc123.r2.cloudflarestorage.com",
    );
    const b2 = fieldsOf("s3-compatible", {
      bucket: "b",
      provider: "b2",
      providerValue: "us-west-004",
    });
    expect(buildStorageUrl(b2)).toBe(
      "s3://b/?region=us-west-004&endpoint=https://s3.us-west-004.backblazeb2.com",
    );
    const wasabi = fieldsOf("s3-compatible", {
      bucket: "b",
      provider: "wasabi",
      providerValue: "eu-central-1",
    });
    expect(buildStorageUrl(wasabi)).toBe(
      "s3://b/?region=eu-central-1&endpoint=https://s3.eu-central-1.wasabisys.com",
    );
    const spaces = fieldsOf("s3-compatible", {
      bucket: "b",
      provider: "spaces",
      providerValue: "nyc3",
    });
    expect(buildStorageUrl(spaces)).toBe(
      "s3://b/?region=us-east-1&endpoint=https://nyc3.digitaloceanspaces.com",
    );
  });

  it("builds MinIO and other endpoints, path-style when needed", () => {
    const minio = fieldsOf("s3-compatible", {
      bucket: "b",
      provider: "minio",
      endpoint: "http://localhost:9000",
      // MinIO ignores the region field.
      region: "ignored",
    });
    expect(buildStorageUrl(minio)).toBe(
      "s3://b/?endpoint=http://localhost:9000&forcePathStyle=true",
    );
    expect(s3CompatibleTarget(minio).region).toBe("");
    const other = fieldsOf("s3-compatible", {
      bucket: "b",
      prefix: "x",
      provider: "other",
      endpoint: "https://s3.example.com",
      region: "zone-1",
    });
    expect(buildStorageUrl(other)).toBe("s3://b/x?region=zone-1&endpoint=https://s3.example.com");
    expect(buildStorageUrl({ ...other, forcePathStyle: true })).toBe(
      "s3://b/x?region=zone-1&endpoint=https://s3.example.com&forcePathStyle=true",
    );
  });

  it("builds GCS and Azure URLs", () => {
    expect(buildStorageUrl(fieldsOf("gcs", { bucket: "g", prefix: "a b/", projectId: "p" }))).toBe(
      "gs://g/a%20b/?projectId=p",
    );
    expect(buildStorageUrl(fieldsOf("azure", { account: "acct", container: "c" }))).toBe(
      "az://acct/c",
    );
    expect(
      buildStorageUrl(
        fieldsOf("azure", {
          account: "acct",
          container: "c",
          prefix: "prod/",
          endpoint: "http://127.0.0.1:10000/acct",
        }),
      ),
    ).toBe("az://acct/c/prod/?endpoint=http://127.0.0.1:10000/acct");
  });

  it("builds SFTP URLs with ports, relative folders, IPv6 hosts and fingerprints", () => {
    expect(
      buildStorageUrl(fieldsOf("sftp", { user: "backup", host: "h", path: "/srv/backups" })),
    ).toBe("sftp://backup@h/srv/backups");
    expect(
      buildStorageUrl(fieldsOf("sftp", { user: "b", host: "h", port: "2222", path: "~/x" })),
    ).toBe("sftp://b@h:2222/~/x");
    expect(buildStorageUrl(fieldsOf("sftp", { user: "b", host: "::1", path: "x" }))).toBe(
      "sftp://b@[::1]/~/x",
    );
    expect(
      buildStorageUrl(
        fieldsOf("sftp", {
          user: "b",
          host: "h",
          path: "/x",
          fingerprint: `${FINGERPRINT}, SHA256:other`,
          allowUnknownHostKey: true,
        }),
      ),
    ).toBe(
      "sftp://b@h/x?fingerprint=SHA256:k3S1xS1v8bM0gYp4m7bJ1rQ6yQ0b0v8vXr5Y2rVwA6c&fingerprint=SHA256:other&allowUnknownHostKey=true",
    );
  });
});

describe("parseStorageUrl", () => {
  /** URLs that must come back as the same URL through the fields. */
  const roundTrips = [
    "/data/backups",
    "backups/prod",
    "s3://acme-backups/prod/",
    "s3://acme/?region=eu-west-1",
    "s3://acme/?region=eu-west-1&retention=governance",
    "s3://b/?region=auto&endpoint=https://abc123.r2.cloudflarestorage.com",
    "s3://b/?region=us-west-004&endpoint=https://s3.us-west-004.backblazeb2.com",
    "s3://b/?endpoint=http://localhost:9000&forcePathStyle=true",
    "s3://b/x?region=zone-1&endpoint=https://s3.example.com&forcePathStyle=true",
    "gs://g/a%20b/?projectId=p",
    "az://acct/c/prod/?endpoint=http://127.0.0.1:10000/acct",
    "sftp://b@h:2222/~/x",
    "sftp://b@[::1]/srv",
    `sftp://b@h/x?fingerprint=${FINGERPRINT}&allowUnknownHostKey=true`,
  ];

  it.each(roundTrips)("round-trips %s", (url) => {
    const fields = parseStorageUrl(url);
    expect(fields).toBeDefined();
    expect(buildStorageUrl(fields as StorageFields)).toBe(url);
  });

  it("reads the fields of each type", () => {
    expect(parseStorageUrl("s3://acme-backups/prod/")).toMatchObject({
      kind: "s3",
      bucket: "acme-backups",
      prefix: "prod/",
      region: "",
    });
    expect(
      parseStorageUrl("s3://b/?region=auto&endpoint=https://abc123.r2.cloudflarestorage.com"),
    ).toMatchObject({ kind: "s3-compatible", provider: "r2", providerValue: "abc123" });
    expect(
      parseStorageUrl("s3://b/?endpoint=http://localhost:9000&forcePathStyle=true"),
    ).toMatchObject({
      kind: "s3-compatible",
      provider: "minio",
      endpoint: "http://localhost:9000",
    });
    // A preset endpoint with another region is not the preset.
    expect(
      parseStorageUrl("s3://b/?region=eu&endpoint=https://abc.r2.cloudflarestorage.com"),
    ).toMatchObject({ provider: "other", region: "eu" });
    expect(parseStorageUrl("az://acct/c/prod/")).toMatchObject({
      kind: "azure",
      account: "acct",
      container: "c",
      prefix: "prod/",
    });
    expect(parseStorageUrl("sftp://b%40corp@h/~/x")).toMatchObject({
      kind: "sftp",
      user: "b@corp",
      path: "~/x",
    });
    // URLSearchParams reads "+" as a space; fingerprints keep their "+".
    expect(parseStorageUrl("sftp://b@h/x?fingerprint=SHA256:a+b")?.fingerprint).toBe("SHA256:a+b");
  });

  it("treats a missing or extra trailing slash as the same URL", () => {
    expect(parseStorageUrl("s3://acme")).toMatchObject({ bucket: "acme", prefix: "" });
    expect(parseStorageUrl("az://acct/c/")).toMatchObject({ container: "c", prefix: "" });
  });

  it("leaves URLs the fields cannot show exactly to the URL mode", () => {
    for (const url of [
      "",
      "file:///data/x",
      "memory://demo",
      "ftp://x",
      "s3://user:secret@bucket/",
      "s3://user@bucket/",
      "sftp://b:pw@h/x",
      // Known parameters in another order than the fields write them.
      "s3://b/?endpoint=http://m:9000&region=x",
      "s3://b/?forcePathStyle=1&endpoint=http://m:9000",
      // A malformed escape.
      "s3://b/%E0%A4%A",
      "sftp://h/x",
    ]) {
      expect(parseStorageUrl(url), url).toBeUndefined();
    }
  });
});

describe("storageSchemeOf", () => {
  it("recognises the schemes and bare paths", () => {
    expect(storageSchemeOf("/data/x")).toBe("file");
    expect(storageSchemeOf("S3://b")).toBe("s3");
    expect(storageSchemeOf("gs://b")).toBe("gs");
    expect(storageSchemeOf("az://a/c")).toBe("az");
    expect(storageSchemeOf("sftp://u@h/x")).toBe("sftp");
    expect(storageSchemeOf("memory://x")).toBe("memory");
    expect(storageSchemeOf("ftp://x")).toBe("unknown");
  });
});

describe("fingerprintsOf", () => {
  it("splits at commas and spaces", () => {
    expect(fingerprintsOf(" a, b  c,,")).toEqual(["a", "b", "c"]);
    expect(fingerprintsOf("")).toEqual([]);
  });
});

describe("storageFieldErrors", () => {
  it("accepts complete fields of every type", () => {
    const valid: StorageFields[] = [
      fieldsOf("local", { folder: "backups" }),
      fieldsOf("s3", { bucket: "acme-backups", region: "eu-west-1" }),
      fieldsOf("s3-compatible", { bucket: "B_1", provider: "r2", providerValue: "abc123" }),
      fieldsOf("s3-compatible", { bucket: "b", provider: "minio", endpoint: "http://m:9000" }),
      fieldsOf("gcs", { bucket: "my_bucket" }),
      fieldsOf("azure", { account: "acct1", container: "c-1" }),
      fieldsOf("sftp", { user: "u", host: "h", port: "22", path: "/x", fingerprint: FINGERPRINT }),
    ];
    for (const fields of valid) expect(storageFieldErrors(fields), fields.kind).toEqual({});
  });

  it("explains local folders", () => {
    expect(storageFieldErrors(fieldsOf("local", {})).folder).toMatch(/Enter a folder/);
    expect(storageFieldErrors(fieldsOf("local", { folder: "a/../b" })).folder).toMatch(/“..”/);
    expect(storageFieldErrors(fieldsOf("local", { folder: "s3://b" })).folder).toMatch(/is a URL/);
  });

  it("explains buckets and regions", () => {
    expect(storageFieldErrors(fieldsOf("s3", {})).bucket).toBe("Enter the bucket name.");
    expect(storageFieldErrors(fieldsOf("s3", { bucket: "Acme" })).bucket).toMatch(/lowercase/);
    expect(
      storageFieldErrors(fieldsOf("s3", { bucket: "acme", region: "EU West" })).region,
    ).toMatch(/eu-west-1/);
    expect(storageFieldErrors(fieldsOf("gcs", { bucket: "a/b" })).bucket).toMatch(/prefix/);
  });

  it("explains S3-compatible providers", () => {
    const r2 = fieldsOf("s3-compatible", { bucket: "b", provider: "r2" });
    expect(storageFieldErrors(r2).providerValue).toBe("Enter the Cloudflare account ID.");
    expect(storageFieldErrors({ ...r2, providerValue: "XYZ" }).providerValue).toMatch(
      /hexadecimal/,
    );
    const other = fieldsOf("s3-compatible", { bucket: "b", provider: "other", endpoint: "minio" });
    expect(storageFieldErrors(other).endpoint).toMatch(/endpoint URL/);
  });

  it("explains Azure names and endpoints", () => {
    expect(storageFieldErrors(fieldsOf("azure", {}))).toMatchObject({
      account: "Enter the storage account name.",
      container: "Enter the container name.",
    });
    expect(
      storageFieldErrors(
        fieldsOf("azure", { account: "Acct", container: "a--b", endpoint: "nope" }),
      ),
    ).toMatchObject({
      account: expect.stringMatching(/3–24/),
      container: expect.stringMatching(/single hyphens/),
      endpoint: expect.stringMatching(/Azurite|devstoreaccount1/),
    });
  });

  it("explains SFTP fields", () => {
    expect(storageFieldErrors(fieldsOf("sftp", { path: "~" }))).toMatchObject({
      user: "Enter the user to log in as.",
      host: expect.stringMatching(/host name/),
      path: expect.stringMatching(/Enter the folder/),
    });
    expect(
      storageFieldErrors(
        fieldsOf("sftp", {
          user: "u",
          host: "u@h",
          port: "70000",
          path: "/x",
          fingerprint: "nope",
        }),
      ),
    ).toMatchObject({
      host: expect.stringMatching(/only the host name/),
      port: expect.stringMatching(/1 to 65535/),
      fingerprint: expect.stringMatching(/“nope” is not a SHA256 fingerprint/),
    });
  });
});
