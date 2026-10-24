// National identifiers: each format's valid examples, its look-alikes, and which ones
// need the field name (`hinted`) because plain digits look like any number.

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  isAadhaar,
  isBrazilianCpf,
  isCanadianSin,
  isDutchBsn,
  isSpanishDni,
  isSpanishNie,
  isSriLankanNic,
  isUkNino,
  isUsSsn,
  nationalIdType,
  verhoeffValid,
} from "./national-ids.ts";

/** Completes a digit string with its Verhoeff check digit (found by trying all ten). */
function withVerhoeffDigit(payload: string): string {
  for (let digit = 0; digit <= 9; digit++) {
    if (verhoeffValid(`${payload}${digit}`)) return `${payload}${digit}`;
  }
  throw new Error("unreachable: exactly one digit completes a Verhoeff number");
}

describe("nationalIdType", () => {
  it.each([
    ["123-45-6789", "us-ssn"],
    ["AB 12 34 56 C", "uk-nino"],
    ["AB123456C", "uk-nino"],
    ["12345678Z", "es-dni"],
    ["X1234567L", "es-nie"],
    ["529.982.247-25", "br-cpf"],
    ["853400937V", "lk-nic"],
    [withVerhoeffDigit("23456789012").replace(/^(\d{4})(\d{4})(\d{4})$/, "$1 $2 $3"), "in-aadhaar"],
  ] as const)("recognises %s by its value alone as %s", (value, type) => {
    expect(nationalIdType(value, false)).toBe(type);
  });

  it.each([
    ["123456789", "us-ssn"],
    ["52998224725", "br-cpf"],
    ["198534000937", "lk-nic"],
    [withVerhoeffDigit("23456789012"), "in-aadhaar"],
    ["046 454 286", "ca-sin"],
    // 9xx is never an SSN area, so this one is not read as an SSN first.
    ["900000004", "nl-bsn"],
  ] as const)("recognises the plain %s only when the field name hints at an id", (value, type) => {
    expect(nationalIdType(value, true)).toBe(type);
    expect(nationalIdType(value, false)).toBeUndefined();
  });

  it("rejects values too short or too long to be an id", () => {
    expect(nationalIdType("1234567", true)).toBeUndefined();
    expect(nationalIdType("1".repeat(21), true)).toBeUndefined();
    expect(nationalIdType("hello world", true)).toBeUndefined();
  });
});

describe("the individual formats", () => {
  it("rejects SSNs from never-issued ranges", () => {
    expect(isUsSsn("000-12-3456", false)).toBe(false);
    expect(isUsSsn("666-12-3456", false)).toBe(false);
    expect(isUsSsn("900-12-3456", false)).toBe(false);
    expect(isUsSsn("123-00-4567", false)).toBe(false);
    expect(isUsSsn("123-45-0000", false)).toBe(false);
  });

  it("rejects NI numbers with excluded letters or prefixes", () => {
    expect(isUkNino("DA123456C")).toBe(false); // D is never a first letter
    expect(isUkNino("AO123456C")).toBe(false); // O is never a second letter
    expect(isUkNino("GB123456C")).toBe(false); // never-used prefix
    expect(isUkNino("AB123456E")).toBe(false); // suffix is A–D
  });

  it("checks the DNI/NIE control letter", () => {
    expect(isSpanishDni("12345678A")).toBe(false);
    expect(isSpanishDni("12345678-z")).toBe(true);
    expect(isSpanishNie("X1234567A")).toBe(false);
    expect(isSpanishNie("Y-1234567-X")).toBe(true);
  });

  it("checks both CPF digits and rejects repeated digits", () => {
    expect(isBrazilianCpf("529.982.247-24", false)).toBe(false);
    expect(isBrazilianCpf("111.111.111-11", false)).toBe(false);
    expect(isBrazilianCpf("52998224725", false)).toBe(false);
  });

  it("checks the NIC day of year", () => {
    expect(isSriLankanNic("853670937V", false)).toBe(false); // day 367
    expect(isSriLankanNic("858660937x", false)).toBe(true); // day 866 (a woman born on day 366)
    expect(isSriLankanNic("198500000937", true)).toBe(false); // day 000
  });

  it("checks the Aadhaar Verhoeff digit and first digit", () => {
    expect(verhoeffValid("2363")).toBe(true); // Verhoeff's own example: 236 → 3
    expect(verhoeffValid("2364")).toBe(false);
    expect(verhoeffValid("23a3")).toBe(false);
    expect(isAadhaar(withVerhoeffDigit("12345678901"), true)).toBe(false); // starts with 1
  });

  it("checks the SIN with Luhn and the BSN with the 11-proef", () => {
    expect(isCanadianSin("046 454 287")).toBe(false);
    expect(isCanadianSin("000 000 000")).toBe(false);
    expect(isDutchBsn("111222333")).toBe(true);
    expect(isDutchBsn("111222334")).toBe(false);
    expect(isDutchBsn("000000000")).toBe(false);
  });

  it("catches every single-digit error in a Verhoeff number", () => {
    fc.assert(
      fc.property(
        fc.stringMatching(/^[2-9][0-9]{10}$/),
        fc.nat(11),
        fc.integer({ min: 1, max: 9 }),
        (payload, index, offset) => {
          const valid = withVerhoeffDigit(payload);
          const digit = (Number(valid[index]) + offset) % 10;
          const corrupted = `${valid.slice(0, index)}${digit}${valid.slice(index + 1)}`;
          expect(verhoeffValid(valid)).toBe(true);
          expect(verhoeffValid(corrupted)).toBe(false);
        },
      ),
    );
  });
});
