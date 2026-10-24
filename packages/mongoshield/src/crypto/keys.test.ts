/**
 * Tests for age key handling: generation, validation, conversion and the
 * guarantee that secret identities never appear in error messages.
 */

import { describe, expect, it } from "vitest";
import { isMongoShieldError } from "../errors.ts";
import {
  assertValidIdentity,
  assertValidRecipient,
  describeRecipient,
  generateIdentity,
  identityToRecipient,
  PASSPHRASE_RECIPIENT_LABEL,
  parseIdentityFile,
} from "./keys.ts";

/** Runs `action` and returns the thrown MongoShieldError (fails the test otherwise). */
function catchError(action: () => unknown): Error {
  try {
    action();
  } catch (error) {
    if (error instanceof Error) return error;
  }
  throw new Error("expected an error");
}

// The example key pair from the age spec ("The X25519 recipient type").
const SPEC_IDENTITY = "AGE-SECRET-KEY-1GFPYYSJZGFPYYSJZGFPYYSJZGFPYYSJZGFPYYSJZGFPYYSJZGFPQ4EGAEX";
const SPEC_RECIPIENT = "age1zvkyg2lqzraa2lnjvqej32nkuu0ues2s82hzrye869xeexvn73equnujwj";

describe("identityToRecipient", () => {
  it("derives the spec's example recipient from the spec's example identity", () => {
    expect(identityToRecipient(SPEC_IDENTITY)).toBe(SPEC_RECIPIENT);
  });

  it("accepts a lowercase identity and surrounding whitespace", () => {
    expect(identityToRecipient(`  ${SPEC_IDENTITY.toLowerCase()}\n`)).toBe(SPEC_RECIPIENT);
  });
});

describe("generateIdentity", () => {
  it("returns a matching, valid identity and recipient", () => {
    const { identity, recipient } = generateIdentity();
    expect(identity).toMatch(/^AGE-SECRET-KEY-1[0-9A-Z]{58}$/);
    expect(recipient).toMatch(/^age1[0-9a-z]{58}$/);
    expect(identityToRecipient(identity)).toBe(recipient);
  });

  it("generates a different key every time", () => {
    expect(generateIdentity().identity).not.toBe(generateIdentity().identity);
  });
});

describe("assertValidRecipient", () => {
  it("accepts a valid recipient", () => {
    expect(() => assertValidRecipient(SPEC_RECIPIENT)).not.toThrow();
  });

  it.each([
    ["", "empty"],
    ["age1zvkyg2lqzraa2lnjvqej32nkuu0ues2s82hzrye869xeexvn73equnujwk", "bad checksum"],
    ["age1qyqszqgpqyqszqgpqyqszqgpqyqszqgp", "wrong length"],
    ["ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAA", "SSH key"],
  ])("rejects %j (%s) with MS_CONFIG_INVALID and a hint", (value) => {
    const error = catchError(() => assertValidRecipient(value));
    expect(isMongoShieldError(error, "MS_CONFIG_INVALID")).toBe(true);
    expect(isMongoShieldError(error) && error.hint).toBeTruthy();
  });

  it("rejects a secret identity without repeating it in the message", () => {
    const error = catchError(() => assertValidRecipient(SPEC_IDENTITY));
    expect(isMongoShieldError(error, "MS_CONFIG_INVALID")).toBe(true);
    expect(error.message).toContain("secret");
    expect(JSON.stringify({ ...error, message: error.message })).not.toContain("GFPYYSJZ");
  });
});

describe("assertValidIdentity", () => {
  it("accepts a valid identity", () => {
    expect(() => assertValidIdentity(SPEC_IDENTITY)).not.toThrow();
  });

  it("never echoes an invalid identity in the error", () => {
    const almost = `${SPEC_IDENTITY.slice(0, -1)}Y`;
    const error = catchError(() => assertValidIdentity(almost));
    expect(isMongoShieldError(error, "MS_CONFIG_INVALID")).toBe(true);
    const serialized = `${error.message} ${isMongoShieldError(error) ? error.hint : ""}`;
    expect(serialized).not.toContain("GFPYYSJZ");
  });

  it("rejects a recipient passed as an identity with a helpful message", () => {
    const error = catchError(() => assertValidIdentity(SPEC_RECIPIENT));
    expect(error.message).toContain("public age recipient");
  });

  it("rejects post-quantum identities as unsupported", () => {
    const error = catchError(() =>
      assertValidIdentity(
        "AGE-SECRET-KEY-PQ-1XX76JRALNLXDMEW0CRK45QMCCH4X06SE84UN3VPM33W6HWDX0H3SK3ZQFR",
      ),
    );
    expect(error.message).toContain("Unsupported");
  });
});

describe("describeRecipient", () => {
  it("returns the normalized recipient", () => {
    expect(describeRecipient(SPEC_RECIPIENT.toUpperCase())).toBe(SPEC_RECIPIENT);
  });

  it("returns the scrypt label for passphrase encryption", () => {
    expect(describeRecipient(PASSPHRASE_RECIPIENT_LABEL)).toBe("scrypt");
  });

  it("refuses to describe a secret identity", () => {
    expect(() => describeRecipient(SPEC_IDENTITY)).toThrow(/secret/);
  });
});

describe("parseIdentityFile", () => {
  it("reads identities from an age-keygen key file, skipping comments and blank lines", () => {
    const { identity } = generateIdentity();
    const file = `# created: 2026-01-01T00:00:00Z\r\n# public key: age1…\n\n${SPEC_IDENTITY}\n${identity}\n`;
    expect(parseIdentityFile(file)).toEqual([SPEC_IDENTITY, identity]);
  });

  it("reports the bad line number but not its content", () => {
    const error = catchError(() => parseIdentityFile(`# comment\nAGE-SECRET-KEY-1NOPE\n`));
    expect(error.message).toContain("Line 2");
    expect(error.message).not.toContain("NOPE");
  });

  it("rejects a file with no identities", () => {
    expect(() => parseIdentityFile("# nothing here\n")).toThrow(/no age identities/);
  });
});
