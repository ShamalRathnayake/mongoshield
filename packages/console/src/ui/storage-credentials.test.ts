/**
 * Unit tests for storage credentials as named fields: the sign-in choices per scheme,
 * the KEY=value pairs each choice produces, and the checks on what was typed.
 */

import { describe, expect, it } from "vitest";
import {
  azureConnectionString,
  buildCredentials,
  type CredentialMethod,
  type CredentialValues,
  credentialMethodsFor,
  defaultCredentialMethod,
  EMPTY_CREDENTIALS,
  parseCredentials,
} from "./storage-credentials.ts";
import type { StorageScheme } from "./storage-url.ts";

/** Builds credentials with some values typed. */
function build(
  method: CredentialMethod | undefined,
  values: Partial<CredentialValues>,
  context: { scheme?: StorageScheme; account?: string; endpoint?: string } = {},
) {
  return buildCredentials(
    method,
    { ...EMPTY_CREDENTIALS, ...values },
    {
      scheme: context.scheme ?? "s3",
      account: context.account ?? "",
      endpoint: context.endpoint ?? "",
    },
  );
}

describe("parseCredentials", () => {
  it("reads KEY=value lines and skips blank lines and comments", () => {
    expect(
      parseCredentials("# a comment\n\nAWS_ACCESS_KEY_ID = abc \nAWS_SECRET_ACCESS_KEY=x=y"),
    ).toEqual({
      AWS_ACCESS_KEY_ID: "abc",
      AWS_SECRET_ACCESS_KEY: "x=y",
    });
  });

  it("names the first line that is not KEY=value", () => {
    expect(parseCredentials("A=1\nnot a pair")).toBe("Line 2 is not KEY=value.");
    expect(parseCredentials("=value")).toBe("Line 1 is not KEY=value.");
  });
});

describe("credentialMethodsFor", () => {
  /** Just the values of the choices. */
  const values = (scheme: StorageScheme, stored?: string) =>
    credentialMethodsFor(scheme, stored).map((option) => option.value);

  it("offers the provider's secret, the environment and KEY=value lines", () => {
    expect(values("s3")).toEqual(["keys", "environment", "lines"]);
    expect(values("gs")).toEqual(["serviceAccount", "environment", "lines"]);
    expect(values("az")).toEqual(["accountKey", "connectionString", "environment", "lines"]);
    expect(values("sftp")).toEqual(["sshKey", "environment", "lines"]);
    expect(values("unknown")).toEqual(["environment", "lines"]);
  });

  it("offers keeping stored credentials first, with what is stored", () => {
    const [keep] = credentialMethodsFor("s3", "AWS_ACCESS_KEY_ID=***");
    expect(keep).toMatchObject({
      value: "keep",
      description: expect.stringContaining("AWS_ACCESS_KEY_ID=***"),
    });
    expect(defaultCredentialMethod("s3", "x")).toBe("keep");
    expect(defaultCredentialMethod("gs", undefined)).toBe("serviceAccount");
  });

  it("offers nothing for local folders and memory stores", () => {
    expect(values("file", "x")).toEqual([]);
    expect(values("memory")).toEqual([]);
    expect(defaultCredentialMethod("file", undefined)).toBeUndefined();
  });

  it("names the accepted keys for KEY=value lines", () => {
    const lines = credentialMethodsFor("sftp", undefined).find(
      (option) => option.value === "lines",
    );
    expect(lines?.description).toContain("SFTP_PRIVATE_KEY, SFTP_PASSPHRASE");
    const unknown = credentialMethodsFor("unknown", undefined).find((o) => o.value === "lines");
    expect(unknown?.description).toBe("Paste environment-style pairs, one per line.");
  });
});

describe("buildCredentials", () => {
  it("sends nothing to keep, and an empty map for the environment or no credentials", () => {
    expect(build("keep", {})).toEqual({ ok: true, credentials: undefined });
    expect(build("environment", { accessKeyId: "ignored" })).toEqual({ ok: true, credentials: {} });
    expect(build(undefined, {})).toEqual({ ok: true, credentials: {} });
  });

  it("builds AWS access keys, with the session token only when typed", () => {
    expect(build("keys", { accessKeyId: " AKIA1 ", secretAccessKey: "s3cret" })).toEqual({
      ok: true,
      credentials: { AWS_ACCESS_KEY_ID: "AKIA1", AWS_SECRET_ACCESS_KEY: "s3cret" },
    });
    expect(
      build("keys", { accessKeyId: "A", secretAccessKey: "S", sessionToken: "T" }),
    ).toMatchObject({ credentials: { AWS_SESSION_TOKEN: "T" } });
    expect(build("keys", {})).toEqual({
      ok: false,
      errors: {
        accessKeyId: "Enter the access key ID.",
        secretAccessKey: "Enter the secret access key.",
      },
    });
  });

  it("checks that a service account key is a JSON object", () => {
    const json = '{"type":"service_account","project_id":"p"}';
    expect(build("serviceAccount", { serviceAccountJson: ` ${json}\n` })).toEqual({
      ok: true,
      credentials: { GOOGLE_CREDENTIALS_JSON: json },
    });
    expect(build("serviceAccount", {})).toMatchObject({
      errors: { serviceAccountJson: expect.stringMatching(/Paste the service account key/) },
    });
    for (const bad of ["{oops", "[1]", '"text"']) {
      expect(build("serviceAccount", { serviceAccountJson: bad })).toMatchObject({
        errors: { serviceAccountJson: expect.stringMatching(/not a JSON key file/) },
      });
    }
  });

  it("turns an Azure account key into a connection string for the location's account", () => {
    expect(build("accountKey", { accountKey: "K==" }, { scheme: "az", account: "acct" })).toEqual({
      ok: true,
      credentials: {
        AZURE_STORAGE_CONNECTION_STRING:
          "DefaultEndpointsProtocol=https;AccountName=acct;AccountKey=K==;EndpointSuffix=core.windows.net",
      },
    });
    expect(build("accountKey", {}, { scheme: "az", account: "acct" })).toMatchObject({
      errors: { accountKey: expect.stringMatching(/access keys/) },
    });
    expect(build("accountKey", { accountKey: "K" }, { scheme: "az" })).toMatchObject({
      errors: { accountKey: "Enter the storage account above first." },
    });
  });

  it("uses a custom Azure endpoint as the blob endpoint", () => {
    expect(azureConnectionString("dev", "K", "http://127.0.0.1:10000/dev")).toBe(
      "DefaultEndpointsProtocol=http;AccountName=dev;AccountKey=K;BlobEndpoint=http://127.0.0.1:10000/dev",
    );
    expect(azureConnectionString("dev", "K", "https://dev.blob.core.usgovcloudapi.net")).toMatch(
      /^DefaultEndpointsProtocol=https;/,
    );
  });

  it("checks an Azure connection string and its account", () => {
    const own = "DefaultEndpointsProtocol=https;AccountName=acct;AccountKey=K";
    expect(
      build("connectionString", { connectionString: own }, { scheme: "az", account: "acct" }),
    ).toEqual({
      ok: true,
      credentials: { AZURE_STORAGE_CONNECTION_STRING: own },
    });
    // A SAS-only string names no account; nothing to compare.
    expect(
      build(
        "connectionString",
        { connectionString: "BlobEndpoint=https://x;SharedAccessSignature=sv=1" },
        { scheme: "az", account: "acct" },
      ),
    ).toMatchObject({ ok: true });
    expect(build("connectionString", {}, { scheme: "az" })).toMatchObject({
      errors: { connectionString: "Paste the connection string." },
    });
    expect(
      build("connectionString", { connectionString: "hello" }, { scheme: "az" }),
    ).toMatchObject({
      errors: { connectionString: expect.stringMatching(/does not look like/) },
    });
    expect(
      build("connectionString", { connectionString: own }, { scheme: "az", account: "other" }),
    ).toMatchObject({
      errors: {
        connectionString: "This connection string is for the account “acct”, not “other”.",
      },
    });
  });

  it("checks an SSH private key and adds the passphrase when typed", () => {
    const key = "-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----";
    expect(build("sshKey", { privateKey: `${key}\n\n` }, { scheme: "sftp" })).toEqual({
      ok: true,
      credentials: { SFTP_PRIVATE_KEY: `${key}\n` },
    });
    expect(
      build("sshKey", { privateKey: key, keyPassphrase: " pass " }, { scheme: "sftp" }),
    ).toMatchObject({ credentials: { SFTP_PASSPHRASE: " pass " } });
    expect(build("sshKey", {}, { scheme: "sftp" })).toMatchObject({
      errors: { privateKey: expect.stringMatching(/Paste the private key/) },
    });
    expect(
      build("sshKey", { privateKey: "ssh-ed25519 AAAA… me@host" }, { scheme: "sftp" }),
    ).toMatchObject({
      errors: { privateKey: expect.stringMatching(/BEGIN … PRIVATE KEY/) },
    });
  });

  it("parses KEY=value lines and refuses names the scheme does not take", () => {
    expect(build("lines", { lines: "AWS_ACCESS_KEY_ID=A" })).toEqual({
      ok: true,
      credentials: { AWS_ACCESS_KEY_ID: "A" },
    });
    // Nothing typed, or a key without a value, is refused rather than clearing anything.
    expect(build("lines", { lines: "" })).toMatchObject({
      ok: false,
      errors: { lines: expect.stringMatching(/^Enter at least one KEY=value line/) },
    });
    expect(build("lines", { lines: "AWS_ACCESS_KEY_ID=" })).toMatchObject({
      errors: { lines: "“AWS_ACCESS_KEY_ID” has no value after the “=”." },
    });
    expect(
      build(
        "lines",
        { lines: Array.from({ length: 11 }, (_unused, at) => `K${at}=v`).join("\n") },
        { scheme: "unknown" },
      ),
    ).toMatchObject({ errors: { lines: "Use at most 10 credentials." } });
    expect(build("lines", { lines: "oops" })).toEqual({
      ok: false,
      errors: { lines: "Line 1 is not KEY=value." },
    });
    expect(build("lines", { lines: "GOOGLE_CREDENTIALS_JSON={}" })).toMatchObject({
      errors: { lines: expect.stringMatching(/“GOOGLE_CREDENTIALS_JSON” is not a credential/) },
    });
    // Unknown schemes are left to the server.
    expect(build("lines", { lines: "ANY=1" }, { scheme: "unknown" })).toMatchObject({ ok: true });
  });
});
