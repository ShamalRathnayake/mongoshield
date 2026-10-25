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
