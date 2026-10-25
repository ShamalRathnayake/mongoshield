import { describe, expect, it } from "vitest";
import {
  constantTimeEqual,
  decryptSecret,
  deriveKeys,
  encryptSecret,
  hashToken,
  hmac,
  randomToken,
} from "./crypto.ts";

const salt = Buffer.alloc(32, 7);
const keys = deriveKeys("a-secret-that-is-long-enough-0123456789", salt);

describe("deriveKeys", () => {
  it("derives different keys for secrets and CSRF, and per salt", () => {
    expect(keys.secrets.equals(keys.csrf)).toBe(false);
    const other = deriveKeys("a-secret-that-is-long-enough-0123456789", Buffer.alloc(32, 8));
    expect(other.secrets.equals(keys.secrets)).toBe(false);
    expect(keys.secrets).toHaveLength(32);
  });
});

describe("encryptSecret / decryptSecret", () => {
  it("round-trips and never contains the plaintext", () => {
    const sealed = encryptSecret(keys.secrets, "mongodb://u:hunter2@host", "connection:1:uri");
    expect(sealed).toMatch(/^v1\./);
    expect(sealed).not.toContain("hunter2");
    expect(decryptSecret(keys.secrets, sealed, "connection:1:uri")).toBe(
      "mongodb://u:hunter2@host",
    );
  });

  it("uses a fresh IV every time", () => {
    expect(encryptSecret(keys.secrets, "x", "c")).not.toBe(encryptSecret(keys.secrets, "x", "c"));
  });

  it("refuses a ciphertext moved to another context, tampered with, or opened with another key", () => {
    const sealed = encryptSecret(keys.secrets, "secret", "connection:1:uri");
    expect(() => decryptSecret(keys.secrets, sealed, "connection:2:uri")).toThrow();
    const parts = sealed.split(".");
    const tampered = [...parts.slice(0, 3), Buffer.from("other").toString("base64url")].join(".");
    expect(() => decryptSecret(keys.secrets, tampered, "connection:1:uri")).toThrow();
    expect(() => decryptSecret(keys.csrf, sealed, "connection:1:uri")).toThrow();
    expect(() => decryptSecret(keys.secrets, "garbage", "connection:1:uri")).toThrow();
  });
});

describe("tokens", () => {
  it("makes 256-bit base64url tokens and stable hashes", () => {
    expect(randomToken()).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(hashToken("abc")).toBe(hashToken("abc"));
    expect(hashToken("abc")).toMatch(/^[0-9a-f]{64}$/);
    expect(hmac(keys.csrf, "a")).not.toBe(hmac(keys.csrf, "b"));
  });

  it("compares strings of any length safely", () => {
    expect(constantTimeEqual("same", "same")).toBe(true);
    expect(constantTimeEqual("same", "different length")).toBe(false);
    expect(constantTimeEqual("", "")).toBe(true);
  });
});
