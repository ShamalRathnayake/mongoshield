/**
 * CRC-64/ECMA exactly as Go's `hash/crc64` computes it with `crc64.MakeTable(crc64.ECMA)`.
 *
 * mongodump's archive format stores one such checksum per namespace, over the
 * concatenated bytes of every document of that namespace, in the namespace's EOF
 * header (mongo-tools `common/archive/multiplexer.go`, `MuxIn.Open` / `formatEOF`).
 * mongorestore recomputes it and refuses the archive on a mismatch
 * (`common/archive/demultiplexer.go`, `HeaderBSON`). Both the reader and the
 * writer in this directory therefore need a bit-exact implementation.
 *
 * Go's algorithm (`hash/crc64/crc64.go`), reflected ("LSB first"):
 *
 *   table[i] = i, shifted right 8 times, XOR-ing the polynomial whenever a 1 falls off
 *   update(crc, bytes):  crc = ^crc; for each byte b: crc = table[byte(crc) ^ b] ^ (crc >> 8); return ^crc
 *
 * with the reflected ECMA-182 polynomial 0xC96C5795D7870F42.
 *
 * JavaScript has no fast 64-bit integers (BigInt arithmetic per byte would be
 * very slow), so the 64-bit register is kept as two unsigned 32-bit halves and the
 * table as two `Uint32Array`s. Only the final value is turned into a `bigint`.
 */

/** High and low 32 bits of the reflected ECMA-182 polynomial 0xC96C5795D7870F42 (Go's `crc64.ECMA`). */
const POLYNOMIAL_HIGH = 0xc96c5795;
const POLYNOMIAL_LOW = 0xd7870f42;

/** The 256-entry lookup table, split into high and low halves. */
const TABLE_HIGH = new Uint32Array(256);
const TABLE_LOW = new Uint32Array(256);

/** Builds the table once, at module load (256 × 8 steps; microseconds). */
function buildTable(): void {
  for (let index = 0; index < 256; index += 1) {
    let high = 0;
    let low = index;
    for (let bit = 0; bit < 8; bit += 1) {
      const lowestBitSet = (low & 1) === 1;
      // 64-bit shift right by one, across the two halves.
      low = ((low >>> 1) | ((high & 1) << 31)) >>> 0;
      high = high >>> 1;
      if (lowestBitSet) {
        low = (low ^ POLYNOMIAL_LOW) >>> 0;
        high = (high ^ POLYNOMIAL_HIGH) >>> 0;
      }
    }
    TABLE_HIGH[index] = high;
    TABLE_LOW[index] = low;
  }
}
buildTable();

/**
 * An incremental CRC-64/ECMA, equivalent to Go's `crc64.New(crc64.MakeTable(crc64.ECMA))`:
 * feeding the same bytes in any number of `update` calls gives the same `value()`.
 */
export class Crc64 {
  // The register holds the *inverted* CRC (Go inverts on the way in and out of
  // every update call, which cancels out between calls). It starts at ^0.
  #high = 0xffffffff;
  #low = 0xffffffff;

  /** Adds bytes to the checksum. */
  update(bytes: Uint8Array): void {
    let high = this.#high;
    let low = this.#low;
    for (let position = 0; position < bytes.length; position += 1) {
      const index = (low ^ (bytes[position] ?? 0)) & 0xff;
      // crc = table[index] ^ (crc >> 8), with the 64-bit shift done on two halves.
      const shiftedLow = ((low >>> 8) | ((high & 0xff) << 24)) >>> 0;
      const shiftedHigh = high >>> 8;
      low = (shiftedLow ^ (TABLE_LOW[index] ?? 0)) >>> 0;
      high = (shiftedHigh ^ (TABLE_HIGH[index] ?? 0)) >>> 0;
    }
    this.#high = high;
    this.#low = low;
  }

  /** The checksum of everything added so far, as an unsigned 64-bit integer. */
  value(): bigint {
    const high = BigInt((~this.#high >>> 0) >>> 0);
    const low = BigInt((~this.#low >>> 0) >>> 0);
    return (high << 32n) | low;
  }
}

/** One-shot helper: the CRC-64/ECMA of `bytes`. */
export function crc64(bytes: Uint8Array): bigint {
  const checksum = new Crc64();
  checksum.update(bytes);
  return checksum.value();
}
