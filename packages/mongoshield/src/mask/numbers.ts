/**
 * Exact numeric values for masking: what number a Double or a Decimal128 REALLY is.
 *
 * Masking keys every output on the input's identity (`values.ts`), and numbers are
 * identified by their numeric value whatever their BSON type, because MongoDB compares
 * them that way (`Int32(5)`, `Long(5)`, `Double(5)` and `Decimal128("5.0")` all match
 * each other). That only works when the identity is EXACT:
 *
 * - `String(2 ** 62)` is `"4611686018427388000"`, the shortest text that reads back as
 *   the same double, not the double's value (4611686018427387904). Used as an identity,
 *   it made `Double(2^62)` differ from `Long(2^62)` (equal values) and equal to
 *   `Long(4611686018427388000)` (a different value).
 * - `Decimal128("0.1")` is exactly one tenth, `Double(0.1)` is not
 *   (0.1000000000000000055511151231257827…), so the two must not share an identity,
 *   while `Decimal128("0.5")` and `Double(0.5)` are exactly equal and must.
 *
 * So every finite number is turned into an `ExactDecimal`, sign × coefficient × 10^exponent
 * in lowest terms, and compared or printed from that.
 */

import type { Decimal128 } from "mongodb";

/**
 * A finite number as `(-1)^negative × coefficient × 10^exponent`, normalized: the
 * coefficient has no trailing zeros (they move into the exponent), and zero is
 * `{ negative: false, coefficient: 0n, exponent: 0 }` (so -0 and 0.00 are zero too).
 */
export interface ExactDecimal {
  readonly negative: boolean;
  readonly coefficient: bigint;
  readonly exponent: number;
}

/** `Decimal128.toString()`: digits, an optional fraction and an optional exponent. */
const DECIMAL_TEXT = /^(-)?(\d+)(?:\.(\d+))?(?:E([+-]?\d+))?$/i;

/** Bits of an IEEE 754 double: 52 fraction bits, 11 exponent bits, bias 1075 for integers. */
const FRACTION_BITS = 52n;
const EXPONENT_MASK = 0x7ffn;
const FRACTION_MASK = (1n << FRACTION_BITS) - 1n;
/** Subnormal doubles are `fraction × 2^-1074`; normal ones `(2^52 + fraction) × 2^(e - 1075)`. */
const SUBNORMAL_EXPONENT = -1074;
const EXPONENT_BIAS = 1075;

/** The exact value of a Decimal128, or `undefined` for NaN and ±Infinity. */
export function exactDecimalOf(value: Decimal128): ExactDecimal | undefined {
  const match = DECIMAL_TEXT.exec(value.toString());
  if (match === null) return undefined;
  const [, sign, whole = "", fraction = "", exponent = "0"] = match;
  return normalize(sign === "-", BigInt(`${whole}${fraction}`), Number(exponent) - fraction.length);
}

/** The exact value of a finite double (every double is a finite binary fraction). */
export function exactDecimalOfDouble(value: number): ExactDecimal {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, value);
  const bits = view.getBigUint64(0);
  const negative = bits >> 63n === 1n;
  const biased = (bits >> FRACTION_BITS) & EXPONENT_MASK;
  const fraction = bits & FRACTION_MASK;
  const mantissa = biased === 0n ? fraction : fraction | (1n << FRACTION_BITS);
  const power = biased === 0n ? SUBNORMAL_EXPONENT : Number(biased) - EXPONENT_BIAS;
  if (power >= 0) return normalize(negative, mantissa << BigInt(power), 0);
  // m × 2^-k = m × 5^k × 10^-k: the decimal expansion of a binary fraction is finite.
  return normalize(negative, mantissa * 5n ** BigInt(-power), power);
}

/** The value as a bigint when it is a whole number, else `undefined`. */
export function integerOf(decimal: ExactDecimal): bigint | undefined {
  if (decimal.exponent < 0) return undefined;
  const magnitude = decimal.coefficient * 10n ** BigInt(decimal.exponent);
  return decimal.negative ? -magnitude : magnitude;
}

/** True when both describe the same number. */
export function sameDecimal(left: ExactDecimal, right: ExactDecimal): boolean {
  return (
    left.negative === right.negative &&
    left.coefficient === right.coefficient &&
    left.exponent === right.exponent
  );
}

/**
 * The identity text of a JavaScript number (from an Int32, a Double or a plain number):
 * whole numbers as their exact digits (`BigInt` is exact for every integral double),
 * fractions as JavaScript's shortest round-trip form, which names exactly one double.
 * `-0` is `"0"`; NaN and ±Infinity are their names.
 */
export function numberIdentity(value: number): string {
  if (!Number.isFinite(value)) return String(value);
  if (Number.isInteger(value)) return BigInt(value).toString();
  return String(value);
}

/**
 * The identity of a Decimal128 as a type tag and text, matching `numberIdentity` for
 * every value a double (or an integer type) can hold exactly:
 *
 *   whole numbers                → `n`, their exact digits (as for Int32/Long/Double)
 *   fractions a double holds     → `n`, that double's text (as for the Double)
 *   any other fraction           → `m`, `coefficient E exponent` in lowest terms
 *
 * The `m` tag keeps `Decimal128("0.1")` apart from `Double(0.1)`, which differ.
 */
export function decimalIdentity(value: Decimal128): {
  readonly tag: "n" | "m";
  readonly text: string;
} {
  const exact = exactDecimalOf(value);
  if (exact === undefined) return { tag: "n", text: nonFiniteName(value.toString()) };
  const integer = integerOf(exact);
  if (integer !== undefined) return { tag: "n", text: integer.toString() };
  const asDouble = Number(decimalText(exact));
  if (Number.isFinite(asDouble) && sameDecimal(exactDecimalOfDouble(asDouble), exact)) {
    return { tag: "n", text: String(asDouble) };
  }
  return { tag: "m", text: decimalText(exact) };
}

/** `-12E-3` style text of an exact decimal (what `Decimal128.fromString` reads). */
export function decimalText(decimal: ExactDecimal): string {
  return `${decimal.negative ? "-" : ""}${decimal.coefficient}E${decimal.exponent}`;
}

/** Strips trailing zeros of the coefficient into the exponent; zero has one form. */
function normalize(negative: boolean, coefficient: bigint, exponent: number): ExactDecimal {
  if (coefficient === 0n) return { negative: false, coefficient: 0n, exponent: 0 };
  let digits = coefficient;
  let power = exponent;
  while (digits % 10n === 0n) {
    digits /= 10n;
    power += 1;
  }
  return { negative, coefficient: digits, exponent: power };
}

/** Decimal128 prints NaN as "NaN" and infinities as "Infinity" / "-Infinity", like doubles. */
function nonFiniteName(text: string): string {
  if (/^-inf/i.test(text)) return "-Infinity";
  return /inf/i.test(text) ? "Infinity" : "NaN";
}
