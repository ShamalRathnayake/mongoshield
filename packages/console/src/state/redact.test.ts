/**
 * Tests for redacted previews and error-text scrubbing.
 */

import { describe, expect, it } from "vitest";
import {
  previewConnectionUri,
  redactSecretUriOptions,
  redactStorageUrl,
  redactUrlToOrigin,
  scrubText,
} from "./redact.ts";

describe("connection string previews", () => {
  it("hides proxyPassword and the other secret options, whatever their case", () => {
    expect(
      redactSecretUriOptions(
        "mongodb://app:***@db/?proxyHost=p&proxyUsername=u&ProxyPassword=s3cret&tls=true",
      ),
    ).toBe("mongodb://app:***@db/?proxyHost=p&proxyUsername=u&ProxyPassword=***&tls=true");
    expect(redactSecretUriOptions("mongodb://db/app")).toBe("mongodb://db/app");
    const preview = previewConnectionUri("mongodb://app:pw@db/?proxyPassword=s3cret");
    expect(preview).not.toContain("s3cret");
    expect(preview).not.toContain(":pw@");
  });
});

describe("redactStorageUrl", () => {
  it("hides the query string of an endpoint parameter (a SAS token) and nothing else", () => {
    const endpoint = encodeURIComponent("https://acct.blob.core.windows.net/?sv=1&sig=abc");
    const shown = redactStorageUrl(`az://acct/c/p?endpoint=${endpoint}`);
    expect(shown).not.toContain("sig");
    expect(decodeURIComponent(shown)).toContain("endpoint=https://acct.blob.core.windows.net/?***");
    expect(redactStorageUrl("s3://bucket/prefix?region=eu-west-1")).toBe(
      "s3://bucket/prefix?region=eu-west-1",
    );
    expect(redactStorageUrl("backups")).toBe("backups");
  });
});

describe("redactUrlToOrigin", () => {
  it("keeps only the origin of a URL", () => {
    expect(redactUrlToOrigin("https://hooks.slack.com/services/T0/B0/xyz")).toBe(
      "https://hooks.slack.com/***",
    );
  });

  it("hides a value that is not a URL entirely", () => {
    expect(redactUrlToOrigin("not a url with a token")).toBe("***");
  });
});

describe("scrubText", () => {
  it("removes passwords from MongoDB URIs anywhere in a message", () => {
    expect(
      scrubText('failed: connect to "mongodb+srv://app:hunter2@db.example.net/x" timed out'),
    ).toBe('failed: connect to "mongodb+srv://app:***@db.example.net/x" timed out');
    expect(scrubText("mongodb://onlyuser@db/")).toBe("mongodb://onlyuser:***@db/");
  });

  it("replaces every known secret with ***", () => {
    expect(scrubText("passphrase was correct-horse-battery", ["correct-horse-battery"])).toBe(
      "passphrase was ***",
    );
  });
});
