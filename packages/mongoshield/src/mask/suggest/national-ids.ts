/**
 * National identifiers that can be checked: by a strict format, a checksum, or both.
 *
 *   id          format                       check                      by value alone?
 *   us-ssn      123-45-6789                  area/group/serial ranges   yes (dashed form)
 *   uk-nino     AB 12 34 56 C                letter rules               yes
 *   es-dni      12345678Z                    mod-23 letter              yes
 *   es-nie      X1234567L                    mod-23 letter              yes
 *   br-cpf      529.982.247-25               two mod-11 digits          yes (formatted)
 *   lk-nic      853400937V (old format)      day of year 001–366/501–866 yes
 *   in-aadhaar  2345 6789 0124               Verhoeff                   yes (grouped form)
 *   ca-sin      046 454 286                  Luhn                       no: field name needed
 *   nl-bsn      111222333                    "11-proef"                 no: field name needed
 *
 * "By value alone" means the shape is distinctive enough that a column full of such
 * values is very likely that identifier even when the field is called `ref`. Plain
 * digit strings (a 9-digit SSN, an 11-digit CPF, a 12-digit Aadhaar or new-format
 * Sri Lankan NIC) look like any other number, so they only count when the field NAME
 * says national id (`hinted`).
 */

import { luhnValid } from "./checksums.ts";

/** The identifiers this file recognises (see the table above). */
export type NationalIdType =
  | "us-ssn"
  | "uk-nino"
  | "es-dni"
  | "es-nie"
  | "br-cpf"
  | "lk-nic"
  | "in-aadhaar"
  | "ca-sin"
  | "nl-bsn";

/** Human labels, for reasons in reports. */
export const NATIONAL_ID_LABELS: Readonly<Record<NationalIdType, string>> = {
  "us-ssn": "US Social Security number",
  "uk-nino": "UK National Insurance number",
  "es-dni": "Spanish DNI",
  "es-nie": "Spanish NIE",
  "br-cpf": "Brazilian CPF",
  "lk-nic": "Sri Lankan NIC",
  "in-aadhaar": "Indian Aadhaar number",
  "ca-sin": "Canadian SIN",
  "nl-bsn": "Dutch BSN",
};

/**
 * The national identifier `value` is, or `undefined`.
 *
 * @param hinted the field name says "national id" (`ssn`, `nationalId`, `bsn`, …):
 *   plain digit strings are then checked too (see the file header).
 */
export function nationalIdType(value: string, hinted: boolean): NationalIdType | undefined {
  const text = value.trim();
  if (text.length < 8 || text.length > 20) return undefined;
  if (isUsSsn(text, hinted)) return "us-ssn";
  if (isUkNino(text)) return "uk-nino";
  if (isSpanishDni(text)) return "es-dni";
  if (isSpanishNie(text)) return "es-nie";
  if (isBrazilianCpf(text, hinted)) return "br-cpf";
  if (isSriLankanNic(text, hinted)) return "lk-nic";
  if (isAadhaar(text, hinted)) return "in-aadhaar";
  if (!hinted) return undefined;
  if (isCanadianSin(text)) return "ca-sin";
  if (isDutchBsn(text)) return "nl-bsn";
  return undefined;
}

// ---------------------------------------------------------------------------
// United States, United Kingdom
// ---------------------------------------------------------------------------

/**
 * A US Social Security number: area 001–899 except 666, group 01–99, serial 0001–9999
 * (numbers outside these ranges are never issued).
 */
export function isUsSsn(text: string, hinted: boolean): boolean {
  const match =
    /^(\d{3})-(\d{2})-(\d{4})$/.exec(text) ??
    (hinted ? /^(\d{3})(\d{2})(\d{4})$/.exec(text) : null);
  if (match === null) return false;
  const [, area = "", group = "", serial = ""] = match;
  const areaNumber = Number(area);
  return (
    areaNumber > 0 && areaNumber < 900 && areaNumber !== 666 && group !== "00" && serial !== "0000"
  );
}

/** Two-letter prefixes HMRC never issues as National Insurance numbers. */
const NINO_INVALID_PREFIXES = new Set(["BG", "GB", "KN", "NK", "NT", "TN", "ZZ"]);

/**
 * A UK National Insurance number: two letters, six digits, a suffix A–D; spaces are
 * allowed (`AB 12 34 56 C`). The first letter is never D, F, I, Q, U or V, the second
 * never D, F, I, O, Q, U or V, and a few prefixes are never used.
 */
export function isUkNino(text: string): boolean {
  const compact = text.replace(/ /g, "").toUpperCase();
  if (!/^[A-CEGHJ-PR-TW-Z][A-CEGHJ-NPR-TW-Z][0-9]{6}[A-D]$/.test(compact)) return false;
  return !NINO_INVALID_PREFIXES.has(compact.slice(0, 2));
}

// ---------------------------------------------------------------------------
// Spain
// ---------------------------------------------------------------------------

/** The DNI/NIE control letters, indexed by the number modulo 23. */
const DNI_LETTERS = "TRWAGMYFPDXBNJZSQVHLCKE";

/** A Spanish DNI: eight digits and the control letter (`12345678Z`). */
export function isSpanishDni(text: string): boolean {
  const match = /^(\d{8})-?([A-Z])$/i.exec(text);
  if (match === null) return false;
  const [, digits = "", letter = ""] = match;
  return DNI_LETTERS[Number(digits) % 23] === letter.toUpperCase();
}

/** A Spanish NIE (foreigners): X, Y or Z (= 0, 1, 2), seven digits, the control letter. */
export function isSpanishNie(text: string): boolean {
  const match = /^([XYZ])-?(\d{7})-?([A-Z])$/i.exec(text);
  if (match === null) return false;
  const [, prefix = "", digits = "", letter = ""] = match;
  const number = Number(`${"XYZ".indexOf(prefix.toUpperCase())}${digits}`);
  return DNI_LETTERS[number % 23] === letter.toUpperCase();
}

// ---------------------------------------------------------------------------
// Brazil, Sri Lanka, India
// ---------------------------------------------------------------------------

/**
 * A Brazilian CPF: nine digits and two check digits, each a weighted sum modulo 11.
 * Formatted `529.982.247-25`, or 11 plain digits when hinted. Repeated digits
 * (`111.111.111-11`) pass the arithmetic but are not valid.
 */
export function isBrazilianCpf(text: string, hinted: boolean): boolean {
  const formatted = /^\d{3}\.\d{3}\.\d{3}-\d{2}$/.test(text);
  if (!formatted && !(hinted && /^\d{11}$/.test(text))) return false;
  const digits = [...text.replace(/\D/g, "")].map(Number);
  if (digits.every((digit) => digit === digits[0])) return false;
  return cpfCheckDigit(digits, 9) === digits[9] && cpfCheckDigit(digits, 10) === digits[10];
}

/** The CPF check digit after the first `count` digits (weights count+1 … 2). */
function cpfCheckDigit(digits: readonly number[], count: number): number {
  let sum = 0;
  for (let index = 0; index < count; index++) sum += (digits[index] ?? 0) * (count + 1 - index);
  return ((sum * 10) % 11) % 10;
}

/**
 * A Sri Lankan National Identity Card number. Old format: two digits of the birth
 * year, the day of the year (001–366, plus 500 for women), four serial digits and V or
 * X (`853400937V`). New format (hinted only): the four-digit year, the day, five digits
 * (`198534000937`).
 */
export function isSriLankanNic(text: string, hinted: boolean): boolean {
  const old = /^\d{2}(\d{3})\d{4}[VX]$/i.exec(text);
  if (old !== null) return isNicDay(old[1] ?? "");
  const current = hinted ? /^(?:19|20)\d{2}(\d{3})\d{5}$/.exec(text) : null;
  return current !== null && isNicDay(current[1] ?? "");
}

/** Day of the year, with 500 added for women: 001–366 or 501–866. */
function isNicDay(day: string): boolean {
  const value = Number(day);
  return (value >= 1 && value <= 366) || (value >= 501 && value <= 866);
}

/**
 * An Indian Aadhaar number: 12 digits, the first 2–9, the last a Verhoeff check digit.
 * Grouped `2345 6789 0124` by value alone; 12 plain digits when hinted.
 */
export function isAadhaar(text: string, hinted: boolean): boolean {
  const grouped = /^[2-9]\d{3} \d{4} \d{4}$/.test(text);
  if (!grouped && !(hinted && /^[2-9]\d{11}$/.test(text))) return false;
  return verhoeffValid(text.replace(/ /g, ""));
}

/** Verhoeff's dihedral group D5 multiplication table. */
const VERHOEFF_MULTIPLY: readonly (readonly number[])[] = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 2, 3, 4, 0, 6, 7, 8, 9, 5],
  [2, 3, 4, 0, 1, 7, 8, 9, 5, 6],
  [3, 4, 0, 1, 2, 8, 9, 5, 6, 7],
  [4, 0, 1, 2, 3, 9, 5, 6, 7, 8],
  [5, 9, 8, 7, 6, 0, 4, 3, 2, 1],
  [6, 5, 9, 8, 7, 1, 0, 4, 3, 2],
  [7, 6, 5, 9, 8, 2, 1, 0, 4, 3],
  [8, 7, 6, 5, 9, 3, 2, 1, 0, 4],
  [9, 8, 7, 6, 5, 4, 3, 2, 1, 0],
];

/** Verhoeff's position-dependent permutations (row = position modulo 8). */
const VERHOEFF_PERMUTE: readonly (readonly number[])[] = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 5, 7, 6, 2, 8, 3, 0, 9, 4],
  [5, 8, 0, 3, 7, 9, 6, 1, 4, 2],
  [8, 9, 1, 6, 0, 4, 3, 5, 2, 7],
  [9, 4, 5, 3, 1, 2, 6, 8, 7, 0],
  [4, 2, 8, 6, 5, 7, 3, 9, 0, 1],
  [2, 7, 9, 3, 8, 0, 6, 4, 1, 5],
  [7, 0, 4, 6, 9, 1, 3, 2, 5, 8],
];

/**
 * True when a digit string ends in a valid Verhoeff check digit (the algorithm catches
 * every single-digit error and every swap of adjacent digits, which Luhn does not).
 */
export function verhoeffValid(digits: string): boolean {
  if (!/^\d+$/.test(digits)) return false;
  let check = 0;
  // Positions count from the right, starting at 0 for the check digit itself.
  [...digits].reverse().forEach((digit, position) => {
    const permuted = VERHOEFF_PERMUTE[position % 8]?.[Number(digit)] ?? 0;
    check = VERHOEFF_MULTIPLY[check]?.[permuted] ?? 0;
  });
  return check === 0;
}

// ---------------------------------------------------------------------------
// Hinted only: Canada, the Netherlands
// ---------------------------------------------------------------------------

/** A Canadian Social Insurance Number: nine digits (`046 454 286`) passing Luhn. */
export function isCanadianSin(text: string): boolean {
  if (!/^\d{3}[ -]?\d{3}[ -]?\d{3}$/.test(text)) return false;
  const digits = text.replace(/\D/g, "");
  return digits !== "000000000" && luhnValid(digits);
}

/**
 * A Dutch citizen service number (BSN): nine digits passing the "11-proef":
 * 9·d1 + 8·d2 + … + 2·d8 − d9 is a multiple of 11.
 */
export function isDutchBsn(text: string): boolean {
  if (!/^\d{9}$/.test(text) || text === "000000000") return false;
  const digits = [...text].map(Number);
  let sum = 0;
  for (let index = 0; index < 8; index++) sum += (digits[index] ?? 0) * (9 - index);
  sum -= digits[8] ?? 0;
  return sum % 11 === 0;
}
