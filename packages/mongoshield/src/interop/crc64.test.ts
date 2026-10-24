import { createHash } from "node:crypto";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { Crc64, crc64 } from "./crc64.ts";

/** A slow but obviously correct BigInt version of Go's crc64.Update, to compare against. */
function referenceCrc64(bytes: Uint8Array): bigint {
  const polynomial = 0xc96c5795d7870f42n;
  const mask = (1n << 64n) - 1n;
  let crc = mask; // ^0
  for (const byte of bytes) {
    crc ^= BigInt(byte);
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc & 1n) === 1n ? (crc >> 1n) ^ polynomial : crc >> 1n;
    }
  }
  return crc ^ mask;
}

describe("crc64", () => {
  it("matches the published CRC-64/XZ check value (Go's crc64.ECMA) for 123456789", () => {
    expect(crc64(Buffer.from("123456789"))).toBe(0x995dc9bbdf1939fan);
  });

  it("is 0 for no input, like Go's crc64.Checksum(nil, ECMA)", () => {
    expect(crc64(new Uint8Array())).toBe(0n);
  });

  it("matches a bit-by-bit reference implementation for any input", () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 300 }), (bytes) => {
        expect(crc64(bytes)).toBe(referenceCrc64(bytes));
      }),
    );
  });

  it("gives the same value however the input is split across update calls", () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 300 }), fc.nat({ max: 300 }), (bytes, cut) => {
        const checksum = new Crc64();
        checksum.update(bytes.subarray(0, cut));
        checksum.update(bytes.subarray(cut));
        expect(checksum.value()).toBe(crc64(bytes));
      }),
    );
  });

  it("handles a megabyte quickly enough for large collections", () => {
    const bytes = createHash("sha512").update("seed").digest();
    const large = Buffer.concat(Array.from({ length: 16_384 }, () => bytes));
    const started = performance.now();
    crc64(large);
    expect(performance.now() - started).toBeLessThan(1000);
  });
});
