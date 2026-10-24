import fc from "fast-check";
import { Decimal128 } from "mongodb";
import { describe, expect, it } from "vitest";
import {
  decimalIdentity,
  decimalText,
  exactDecimalOf,
  exactDecimalOfDouble,
  integerOf,
  numberIdentity,
} from "./numbers.ts";

describe("exactDecimalOfDouble", () => {
  it("gives the exact value of every double, which reads back as the same double", () => {
    fc.assert(
      fc.property(fc.double({ noNaN: true, noDefaultInfinity: true }), (value) => {
        const exact = exactDecimalOfDouble(value);
        expect(Number(decimalText(exact))).toBe(Object.is(value, -0) ? 0 : value);
      }),
    );
  });

  it("shows that 0.1 is not one tenth and 0.5 is one half", () => {
    expect(decimalText(exactDecimalOfDouble(0.5))).toBe("5E-1");
    expect(decimalText(exactDecimalOfDouble(0.1))).toBe(
      "1000000000000000055511151231257827021181583404541015625E-55",
    );
    expect(decimalText(exactDecimalOfDouble(Number.MIN_VALUE))).toMatch(/E-1074$/);
  });
});

describe("numberIdentity", () => {
  it("writes whole numbers with all their digits, even beyond 2^53", () => {
    expect(numberIdentity(2 ** 62)).toBe("4611686018427387904");
    expect(numberIdentity(-0)).toBe("0");
    expect(numberIdentity(1e21)).toBe("1000000000000000000000");
    expect(numberIdentity(1.5)).toBe("1.5");
    expect(numberIdentity(Number.NaN)).toBe("NaN");
  });
});

describe("decimalIdentity", () => {
  it("matches the identity of the double or integer holding the same value", () => {
    expect(decimalIdentity(Decimal128.fromString("5.00"))).toEqual({ tag: "n", text: "5" });
    expect(decimalIdentity(Decimal128.fromString("0.50"))).toEqual({ tag: "n", text: "0.5" });
    expect(decimalIdentity(Decimal128.fromString("-0"))).toEqual({ tag: "n", text: "0" });
    expect(decimalIdentity(Decimal128.fromString("4611686018427387904"))).toEqual({
      tag: "n",
      text: numberIdentity(2 ** 62),
    });
  });

  it("keeps values no double holds exactly apart from doubles", () => {
    expect(decimalIdentity(Decimal128.fromString("0.1"))).toEqual({ tag: "m", text: "1E-1" });
    expect(decimalIdentity(Decimal128.fromString("19.990"))).toEqual({ tag: "m", text: "1999E-2" });
  });

  it("names NaN and the infinities like doubles do", () => {
    expect(decimalIdentity(Decimal128.fromString("NaN")).text).toBe("NaN");
    expect(decimalIdentity(Decimal128.fromString("Infinity")).text).toBe("Infinity");
    expect(decimalIdentity(Decimal128.fromString("-Infinity")).text).toBe("-Infinity");
  });
});

describe("exactDecimalOf and integerOf", () => {
  it("normalizes trailing zeros and recognizes whole numbers", () => {
    const exact = exactDecimalOf(Decimal128.fromString("1.2300E+5"));
    expect(exact).toEqual({ negative: false, coefficient: 123n, exponent: 3 });
    expect(exact === undefined ? undefined : integerOf(exact)).toBe(123000n);
    const negative = exactDecimalOf(Decimal128.fromString("-0.25"));
    expect(negative === undefined ? 0n : integerOf(negative)).toBeUndefined();
    expect(exactDecimalOf(Decimal128.fromString("NaN"))).toBeUndefined();
  });
});
