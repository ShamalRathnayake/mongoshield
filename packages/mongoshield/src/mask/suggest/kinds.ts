/**
 * The kinds of personal or secret data the masking suggester recognises, and how sure
 * each kind of evidence makes it.
 *
 * Shared by the detectors (`values.ts`, `field-names.ts`), the profiler that runs them
 * over sampled documents (`profile.ts`), the classifier that turns a profile into a
 * finding (`classify.ts`) and the rule suggester (`rules.ts`).
 */

/**
 * What a field holds, as far as masking is concerned.
 *
 *   email          an email address
 *   phone          a phone number (E.164 like +44 20 7946 0958, or national formats)
 *   person-name    a person's name (driven by the field name; values only confirm it)
 *   address        a street address
 *   postal-code    a ZIP or postal code
 *   credit-card    a payment card number (checked with the Luhn checksum)
 *   iban           an international bank account number (checked with its mod-97 checksum)
 *   ip-address     an IPv4 or IPv6 address
 *   national-id    a national identifier: US SSN, UK NI number, and others with checksums
 *   date-of-birth  a birth date (driven by the field name)
 *   secret         a password, password hash, token, API key or JWT
 *   geolocation    coordinates: a GeoJSON geometry, a [lng, lat] pair, or a latitude/longitude
 *   free-text      text (notes, messages) that contains emails or phone numbers
 */
export type PiiKind =
  | "email"
  | "phone"
  | "person-name"
  | "address"
  | "postal-code"
  | "credit-card"
  | "iban"
  | "ip-address"
  | "national-id"
  | "date-of-birth"
  | "secret"
  | "geolocation"
  | "free-text";

/** Every kind, in the order the docs and help text list them. */
export const PII_KINDS: readonly PiiKind[] = [
  "email",
  "phone",
  "person-name",
  "address",
  "postal-code",
  "credit-card",
  "iban",
  "ip-address",
  "national-id",
  "date-of-birth",
  "secret",
  "geolocation",
  "free-text",
];

/** Human labels for tables and reasons ("postal code", "IP address", …). */
export const KIND_LABELS: Readonly<Record<PiiKind, string>> = {
  email: "email",
  phone: "phone",
  "person-name": "person name",
  address: "address",
  "postal-code": "postal code",
  "credit-card": "card number",
  iban: "IBAN",
  "ip-address": "IP address",
  "national-id": "national ID",
  "date-of-birth": "date of birth",
  secret: "secret",
  geolocation: "geolocation",
  "free-text": "text with PII",
};
