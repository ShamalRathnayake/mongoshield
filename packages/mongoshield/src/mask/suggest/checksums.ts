/**
 * The check-digit algorithms of payment card numbers and IBANs.
 *
 * Checksums are what keep the detectors honest: a random 16-digit number passes Luhn
 * only one time in ten, and a random 22-character string is practically never a valid
 * IBAN, so a column where nearly every value passes is that kind of number.
 */

/**
 * The Luhn checksum (ISO/IEC 7812) used by card numbers and Canadian SINs: from the
 * right, double every second digit (subtracting 9 when that exceeds 9); the total must
 * be a multiple of 10. `79927398713` is the textbook valid example.
 */
export function luhnValid(digits: string): boolean {
  if (!/^\d+$/.test(digits)) return false;
  let sum = 0;
  let double = false;
  for (let index = digits.length - 1; index >= 0; index--) {
    let digit = Number(digits[index]);
    if (double) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    double = !double;
  }
  return sum % 10 === 0;
}

/**
 * IBAN lengths per country (ISO 13616 registry). A country code not listed here is
 * not accepted, so arbitrary "XX12…" strings do not pass.
 */
// biome-ignore format: the table reads better in rows than one country per line.
export const IBAN_LENGTHS: Readonly<Record<string, number>> = {
  AD: 24, AE: 23, AL: 28, AT: 20, AZ: 28, BA: 20, BE: 16, BG: 22, BH: 22, BR: 29,
  CH: 21, CR: 22, CY: 28, CZ: 24, DE: 22, DK: 18, DO: 28, EE: 20, EG: 29, ES: 24,
  FI: 18, FO: 18, FR: 27, GB: 22, GE: 22, GI: 23, GL: 18, GR: 27, GT: 28, HR: 21,
  HU: 28, IE: 22, IL: 23, IQ: 23, IS: 26, IT: 27, JO: 30, KW: 30, KZ: 20, LB: 28,
  LC: 32, LI: 21, LT: 20, LU: 20, LV: 21, MC: 27, MD: 24, ME: 22, MK: 19, MR: 27,
  MT: 31, MU: 30, NL: 18, NO: 15, PK: 24, PL: 28, PS: 29, PT: 25, QA: 29, RO: 24,
  RS: 22, SA: 24, SC: 31, SE: 24, SI: 19, SK: 24, SM: 27, TN: 24, TR: 26, UA: 29,
  VA: 22, VG: 24, XK: 20,
};

/**
 * The IBAN check (ISO 13616 / ISO 7064 mod 97-10): move the first four characters to
 * the end, replace letters by numbers (A = 10 … Z = 35), and the result modulo 97
 * must be 1. Spaces are allowed (`GB82 WEST 1234 5698 7654 32`), case is ignored.
 */
export function ibanValid(value: string): boolean {
  const iban = value.replace(/ /g, "").toUpperCase();
  if (!/^[A-Z]{2}[0-9]{2}[A-Z0-9]+$/.test(iban)) return false;
  if (IBAN_LENGTHS[iban.slice(0, 2)] !== iban.length) return false;
  const rearranged = `${iban.slice(4)}${iban.slice(0, 4)}`;
  // Process digit by digit so the number never exceeds what a double holds exactly.
  let remainder = 0;
  for (const character of rearranged) {
    const code = character.charCodeAt(0);
    // Letters become two digits (A = 10), digits stay themselves.
    const digits = code >= 65 ? String(code - 55) : character;
    for (const digit of digits) remainder = (remainder * 10 + Number(digit)) % 97;
  }
  return remainder === 1;
}
