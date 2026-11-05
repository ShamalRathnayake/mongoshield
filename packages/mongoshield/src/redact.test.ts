import { describe, expect, it } from "vitest";
import { redactMongoUri, redactSecrets } from "./redact.ts";

describe("redactMongoUri", () => {
  it("hides the password but keeps the user name", () => {
    expect(redactMongoUri("mongodb+srv://alice:s3cret@cluster0.example.net/app")).toBe(
      "mongodb+srv://alice:***@cluster0.example.net/app",
    );
  });

  it("hides sensitive query parameters", () => {
    const out = redactMongoUri(
      "mongodb://h:27017/?tlsCertificateKeyFilePassword=pw&replicaSet=rs0",
    );
    expect(out).toContain("tlsCertificateKeyFilePassword=***");
    expect(out).toContain("replicaSet=rs0");
  });

  it("hides the proxy password, the key passphrase and AWS session tokens", () => {
    const out = redactMongoUri(
      "mongodb://h:27017/?proxyHost=p&proxyUsername=bob&proxyPassword=proxy-secret" +
        "&sslPEMKeyPassword=pem-secret&authMechanism=MONGODB-AWS" +
        "&authMechanismProperties=AWS_SESSION_TOKEN:session-secret",
    );
    expect(out).not.toContain("proxy-secret");
    expect(out).not.toContain("pem-secret");
    expect(out).not.toContain("session-secret");
    expect(out).toContain("proxyPassword=***");
    // Options that are not secret stay readable.
    expect(out).toContain("proxyUsername=bob");
    expect(out).toContain("authMechanism=MONGODB-AWS");
  });

  it("matches secret option names regardless of their case", () => {
    expect(redactMongoUri("mongodb://h/?PROXYPASSWORD=proxy-secret")).not.toContain("proxy-secret");
  });

  it("leaves URIs without credentials alone", () => {
    expect(redactMongoUri("mongodb://localhost:27017")).toBe("mongodb://localhost:27017");
  });
});

describe("redactSecrets", () => {
  it("replaces every occurrence and ignores very short values", () => {
    expect(redactSecrets("key=abcd1234 again abcd1234", ["abcd1234", "x"])).toBe(
      "key=*** again ***",
    );
  });
});
