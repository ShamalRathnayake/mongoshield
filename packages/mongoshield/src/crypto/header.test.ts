/**
 * Header and base64 tests: stanza wrapping at 64 columns, strict parsing,
 * the header MAC and age-file detection.
 */

import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { isMongoShieldError } from "../errors.ts";
import { decodeBase64, encodeBase64 } from "./base64.ts";
import {
  encodeHeader,
  findHeaderEnd,
  isAgeEncrypted,
  parseHeader,
  type Stanza,
  verifyHeaderMac,
} from "./header.ts";

const fileKey = Buffer.alloc(16, 1);

function stanza(bodyLength: number, args: string[] = ["test", "arg"]): Stanza {
  return { args, body: randomBytes(bodyLength) };
}

function headerText(stanzas: Stanza[]): string {
  return encodeHeader(stanzas, fileKey).toString("latin1");
}

describe("base64", () => {
  it("encodes without padding", () => {
    expect(encodeBase64(Buffer.from("a"))).toBe("YQ");
  });

  it.each([
    ["YQ==", "padding"],
    ["YR", "non-zero trailing bits (non-canonical)"],
    ["Y", "a single leftover character"],
    ["Y-", "URL-safe alphabet"],
    ["Y Q", "whitespace"],
  ])("rejects %j (%s)", (text) => {
    expect(decodeBase64(text)).toBeUndefined();
  });

  it("decodes canonical input", () => {
    expect(decodeBase64("YQ")).toEqual(Buffer.from("a"));
    expect(decodeBase64("")).toEqual(Buffer.alloc(0));
  });
});

describe("encodeHeader", () => {
  it("writes the version line, stanzas and a MAC line", () => {
    const text = headerText([stanza(32, ["X25519", "abc"])]);
    expect(text).toMatch(
      /^age-encryption\.org\/v1\n-> X25519 abc\n[A-Za-z0-9+/]{43}\n--- [A-Za-z0-9+/]{43}\n$/,
    );
  });

  it("adds an empty final line when the body encodes to exactly 64 columns", () => {
    // 48 bytes -> 64 base64 characters, which must be followed by an empty line.
    const lines = headerText([stanza(48)]).split("\n");
    expect(lines[2]).toHaveLength(64);
    expect(lines[3]).toBe("");
    expect(lines[4]).toMatch(/^--- /);
  });

  it("writes an empty body as a single empty line", () => {
    expect(headerText([stanza(0)]).split("\n")[2]).toBe("");
  });

  it("wraps long bodies at 64 columns", () => {
    const lines = headerText([stanza(100)]).split("\n");
    // 100 bytes -> 134 base64 characters -> 64 + 64 + 6.
    expect(lines.slice(2, 5).map((line) => line.length)).toEqual([64, 64, 6]);
  });
});

describe("parseHeader", () => {
  it("round-trips stanzas of every body length around the 64-column boundary", () => {
    for (let length = 0; length < 120; length++) {
      const original = [stanza(length), stanza(32, ["X25519", "x"])];
      const parsed = parseHeader(encodeHeader(original, fileKey));
      expect(parsed.stanzas).toEqual(original);
      expect(verifyHeaderMac(parsed, fileKey)).toBe(true);
    }
  });

  it("covers the header up to and including '---' with the MAC", () => {
    const header = encodeHeader([stanza(32)], fileKey);
    const parsed = parseHeader(header);
    expect(parsed.macInput.toString("latin1").endsWith("\n---")).toBe(true);
    expect(verifyHeaderMac(parsed, Buffer.alloc(16, 2))).toBe(false);
  });

  it.each([
    ["CRLF line endings", (text: string) => text.replaceAll("\n", "\r\n")],
    ["an unsupported version", (text: string) => text.replace("/v1", "/v2")],
    ["a double space between arguments", (text: string) => text.replace("test arg", "test  arg")],
    ["a missing MAC space", (text: string) => text.replace("--- ", "---")],
    ["no stanzas", (text: string) => text.replace(/-> .*\n.*\n/, "")],
    ["a non-ASCII argument", (text: string) => text.replace("arg", "ärg")],
  ])("rejects a header with %s", (_name, mutate) => {
    const text = mutate(headerText([stanza(32)]));
    const bytes = Buffer.from(text, "latin1");
    let failure: unknown;
    try {
      parseHeader(bytes);
    } catch (error) {
      failure = error;
    }
    expect(isMongoShieldError(failure, "MS_DECRYPTION_FAILED")).toBe(true);
  });
});

describe("findHeaderEnd", () => {
  it("returns undefined until the MAC line is complete", () => {
    const header = encodeHeader([stanza(32)], fileKey);
    expect(findHeaderEnd(header.subarray(0, header.length - 1))).toBeUndefined();
    expect(findHeaderEnd(Buffer.concat([header, Buffer.from("payload")]))).toBe(header.length);
  });
});

describe("isAgeEncrypted", () => {
  it("recognizes the age v1 version line", () => {
    expect(isAgeEncrypted(encodeHeader([stanza(32)], fileKey))).toBe(true);
  });

  it("rejects other data and too-short input", () => {
    expect(isAgeEncrypted(Buffer.from("age-encryption.org/v2\n-> X"))).toBe(false);
    expect(isAgeEncrypted(Buffer.from("age-encryption.org/v1"))).toBe(false);
    expect(isAgeEncrypted(new Uint8Array([0x28, 0xb5, 0x2f, 0xfd]))).toBe(false);
  });

  it("works on a Uint8Array view into a larger buffer", () => {
    const backing = Buffer.concat([Buffer.from("xx"), Buffer.from("age-encryption.org/v1\n")]);
    expect(isAgeEncrypted(new Uint8Array(backing.buffer, backing.byteOffset + 2, 22))).toBe(true);
  });
});
