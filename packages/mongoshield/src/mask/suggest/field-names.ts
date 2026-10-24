/**
 * What a field's NAME says about its content: `email`, `dateOfBirth`, `billing.zip`,
 * `customer.name`, `apiKey`, `lastLoginIp`, `pickupLat`.
 *
 * Some kinds of personal data cannot be recognised from values alone: "Ada Costa" could
 * be a person, a product or a city, and 1990-05-01 could be any date. For those the
 * name is the main evidence and the values only confirm it (they must look like names,
 * dates, …). For kinds that values reveal on their own (emails, IBANs), a matching name
 * raises the confidence.
 *
 * Names are split into lowercase tokens first, so every naming convention matches:
 *
 *   dateOfBirth → date, of, birth      date_of_birth → date, of, birth
 *   userIPAddress → user, ip, address  ZIPCode → zip, code
 *
 * Context matters for the ambiguous ones: `name` is a person's name inside `customer`
 * or at the top of a `users` collection, but not inside `products`. `line1` is an
 * address line inside `shippingAddress`, and nothing in particular elsewhere.
 */

import type { PiiKind } from "./kinds.ts";

/** What a field name suggests. */
export interface NameHint {
  readonly kind: PiiKind;
  /**
   * `strong`: the name alone is nearly conclusive (`firstName`, `ssn`, `password`).
   * `weak`: a plausible reading that the values must back up (`name` in a `users`
   * collection, `accountNumber`).
   */
  readonly strength: "strong" | "weak";
  /**
   * The variant, for kinds that have several: `password` or `token` for secrets,
   * `latitude`, `longitude` or `location` for geolocation.
   */
  readonly detail?: string;
}

/** Where a field sits: its own key, its named ancestors and its collection. */
export interface FieldNameContext {
  /** The field's own key, e.g. `zip`. */
  readonly key: string;
  /** Named ancestors from the top down, e.g. `["customer", "address"]` (array levels left out). */
  readonly parents: readonly string[];
  /** The collection name, e.g. `users`. */
  readonly collection: string;
}

/**
 * Splits a name into lowercase tokens at camelCase humps, acronyms, digits and
 * separators: `billingAddressLine1` → `billing address line 1`, `SSN` → `ssn`.
 */
export function nameTokens(name: string): string[] {
  // An acronym (`IP` in `userIPAddress`), a capitalised or lowercase word, or digits.
  const parts = name.match(/[A-Z]+(?![a-z])|[A-Z]?[a-z]+|[0-9]+/g) ?? [];
  return parts.map((part) => part.toLowerCase());
}

/**
 * The hint a field's name gives, or `undefined` when it suggests nothing personal.
 * Checked in a fixed order, most specific first, so `emailAddress` is an email (not an
 * address) and `ipAddress` an IP address.
 */
export function hintForField(context: FieldNameContext): NameHint | undefined {
  const name = describeName(context.key);
  return (
    secretHint(name) ??
    emailHint(name) ??
    phoneHint(name) ??
    birthDateHint(name) ??
    nationalIdHint(name) ??
    cardHint(name) ??
    ibanHint(name) ??
    ipHint(name) ??
    geolocationHint(name) ??
    postalCodeHint(name) ??
    addressHint(name, context) ??
    personNameHint(name, context)
  );
}

/** A field name in the forms the checks below compare against. */
interface DescribedName {
  readonly tokens: readonly string[];
  /** The tokens joined without separators: `dateofbirth`. */
  readonly compact: string;
  /** The last token: `lat` in `pickupLat`. */
  readonly last: string;
}

function describeName(key: string): DescribedName {
  const tokens = nameTokens(key);
  return { tokens, compact: tokens.join(""), last: tokens.at(-1) ?? "" };
}

/** True when the name has any of the tokens. */
function hasToken(name: DescribedName, tokens: readonly string[]): boolean {
  return name.tokens.some((token) => tokens.includes(token));
}

/** True when the compact name contains any of the fragments. */
function compactIncludes(name: DescribedName, fragments: readonly string[]): boolean {
  return fragments.some((fragment) => name.compact.includes(fragment));
}

function strong(kind: PiiKind, detail?: string): NameHint {
  return detail === undefined ? { kind, strength: "strong" } : { kind, strength: "strong", detail };
}

function weak(kind: PiiKind, detail?: string): NameHint {
  return detail === undefined ? { kind, strength: "weak" } : { kind, strength: "weak", detail };
}

// ---------------------------------------------------------------------------
// Secrets
// ---------------------------------------------------------------------------

const PASSWORD_TOKENS = ["password", "passwd", "pwd", "passphrase", "passcode"];

const TOKEN_TOKENS = ["token", "secret", "credential", "credentials", "otp", "totp", "salt"];

/** Compound names of keys and session identifiers: `apiKey`, `client_secret`, `sessionId`. */
const TOKEN_FRAGMENTS = [
  "apikey",
  "accesskey",
  "secretkey",
  "privatekey",
  "signingkey",
  "authkey",
  "licensekey",
  "sessionid",
];

function secretHint(name: DescribedName): NameHint | undefined {
  if (hasToken(name, PASSWORD_TOKENS)) return strong("secret", "password");
  if (hasToken(name, TOKEN_TOKENS) || compactIncludes(name, TOKEN_FRAGMENTS)) {
    return strong("secret", "token");
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Contact details
// ---------------------------------------------------------------------------

function emailHint(name: DescribedName): NameHint | undefined {
  return hasToken(name, ["email", "mail"]) ? strong("email") : undefined;
}

const PHONE_TOKENS = [
  "phone",
  "telephone",
  "tel",
  "mobile",
  "cell",
  "cellphone",
  "fax",
  "msisdn",
  "whatsapp",
];

function phoneHint(name: DescribedName): NameHint | undefined {
  return hasToken(name, PHONE_TOKENS) || name.compact.includes("phone")
    ? strong("phone")
    : undefined;
}

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

/** `dob`, `birthday`, `yob` (year of birth), `bornOn`; any name with `birth` in it. */
const BIRTH_NAMES = ["dob", "bday", "yob", "born", "bornon", "birthday"];

function birthDateHint(name: DescribedName): NameHint | undefined {
  return hasToken(name, ["birth", "birthday"]) || BIRTH_NAMES.includes(name.compact)
    ? strong("date-of-birth")
    : undefined;
}

/** Abbreviations of national identifiers, matched as whole tokens. */
const NATIONAL_ID_TOKENS = [
  "ssn", //          US Social Security number
  "sin", //          Canadian Social Insurance Number
  "nino", //         UK National Insurance number
  "nin",
  "nic", //          Sri Lankan National Identity Card number
  "itin", //         US Individual Taxpayer Identification Number
  "aadhaar", //      India
  "aadhar",
  "bsn", //          Netherlands (burgerservicenummer)
  "cpf", //          Brazil
  "dni", //          Spain (DNI/NIE)
  "nie",
  "curp", //         Mexico
  "pesel", //        Poland
  "personnummer", // Sweden
  "passport",
];

/** Spelled-out names of national identifiers, matched inside the compact name. */
const NATIONAL_ID_FRAGMENTS = [
  "socialsecurity",
  "socialinsurance",
  "nationalinsurance",
  "nationalid",
  "nationalidentity",
  "taxid",
  "driverslicense",
  "driverlicense",
  "drivinglicence",
  "drivinglicense",
  "governmentid",
  "burgerservicenummer",
  "idnumber",
  "idcard",
];

function nationalIdHint(name: DescribedName): NameHint | undefined {
  if (hasToken(name, NATIONAL_ID_TOKENS) || compactIncludes(name, NATIONAL_ID_FRAGMENTS)) {
    return strong("national-id");
  }
  // `tin` and `licenseNumber` are often national ids, but not always.
  if (hasToken(name, ["tin"]) || compactIncludes(name, ["licensenumber"])) {
    return weak("national-id");
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Payment
// ---------------------------------------------------------------------------

const CARD_FRAGMENTS = [
  "creditcard",
  "debitcard",
  "paymentcard",
  "cardnumber",
  "cardno",
  "cardnum",
  "ccnumber",
  "ccnum",
  "ccno",
];

function cardHint(name: DescribedName): NameHint | undefined {
  // `pan` (primary account number) only as the whole name: "panel", "company" stay out.
  if (compactIncludes(name, CARD_FRAGMENTS) || name.compact === "pan") return strong("credit-card");
  return undefined;
}

function ibanHint(name: DescribedName): NameHint | undefined {
  if (hasToken(name, ["iban"])) return strong("iban");
  // Bank account numbers are often IBANs; internal "account numbers" are not.
  if (compactIncludes(name, ["bankaccount", "accountnumber"])) return weak("iban");
  return undefined;
}

// ---------------------------------------------------------------------------
// Network and location
// ---------------------------------------------------------------------------

const IP_TOKENS = ["ip", "ipv4", "ipv6", "ipaddr", "ipaddress"];

const IP_FRAGMENTS = ["remoteaddr", "forwardedfor"];

function ipHint(name: DescribedName): NameHint | undefined {
  return hasToken(name, IP_TOKENS) || compactIncludes(name, IP_FRAGMENTS)
    ? strong("ip-address")
    : undefined;
}

const LATITUDE_TOKENS = ["lat", "latitude"];
const LONGITUDE_TOKENS = ["lng", "lon", "longitude"];

/** Names of coordinate pairs and geometries (the values must have the shape to count). */
const LOCATION_TOKENS = [
  "location",
  "loc",
  "geo",
  "geolocation",
  "geopoint",
  "geometry",
  "coordinates",
  "coords",
  "coord",
  "position",
  "latlng",
  "latlon",
  "lnglat",
  "gps",
  "point",
];

function geolocationHint(name: DescribedName): NameHint | undefined {
  if (LATITUDE_TOKENS.includes(name.last)) return strong("geolocation", "latitude");
  // `long` only as the whole name: `longDescription` is not a longitude.
  if (LONGITUDE_TOKENS.includes(name.last) || name.compact === "long") {
    return strong("geolocation", "longitude");
  }
  if (hasToken(name, LOCATION_TOKENS)) return weak("geolocation", "location");
  return undefined;
}

const POSTAL_TOKENS = ["zip", "zipcode", "postcode", "postal", "pincode", "plz"];

function postalCodeHint(name: DescribedName): NameHint | undefined {
  // The last token decides: `zipCode` and `postal_code` yes, `zipFile` no.
  if (POSTAL_TOKENS.includes(name.last) || POSTAL_TOKENS.includes(name.compact)) {
    return strong("postal-code");
  }
  if (name.last === "code" && hasToken(name, ["zip", "post", "postal", "pin"])) {
    return strong("postal-code");
  }
  return undefined;
}

/** Things called "address" that are not where someone lives. */
const NOT_A_HOME_ADDRESS = ["mac", "wallet", "contract", "server", "host", "bitcoin", "eth", "web"];

/** Parts of an address that identify the building (city and country do not, much). */
const ADDRESS_PART_NAMES = [
  "line1",
  "line2",
  "line3",
  "housenumber",
  "houseno",
  "building",
  "apartment",
  "apt",
  "flat",
  "suite",
];

/** Ancestors that make an address part out of `line1`, `apartment`, …. */
const ADDRESS_PARENT_TOKENS = [
  "address",
  "addr",
  "shipping",
  "billing",
  "delivery",
  "residence",
  "home",
  "mailing",
];

function addressHint(name: DescribedName, context: FieldNameContext): NameHint | undefined {
  if (hasToken(name, NOT_A_HOME_ADDRESS)) return undefined;
  if (hasToken(name, ["address", "addr", "street", "residence"])) return strong("address");
  if (
    ADDRESS_PART_NAMES.includes(name.compact) &&
    hasAncestorToken(context, ADDRESS_PARENT_TOKENS)
  ) {
    return weak("address");
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// People's names
// ---------------------------------------------------------------------------

/** Names that are always a person's name. */
const PERSON_NAME_COMPACTS = [
  "firstname",
  "lastname",
  "fullname",
  "givenname",
  "givennames",
  "familyname",
  "surname",
  "middlename",
  "maidenname",
  "mothersmaidenname",
  "fname",
  "lname",
  "forename",
  "forenames",
  "legalname",
];

/** `<role>Name` reads as a person's name: `customerName`, `cardholderName`. */
const PERSON_ROLES = [
  "contact",
  "customer",
  "holder",
  "cardholder",
  "recipient",
  "billing",
  "shipping",
  "patient",
  "employee",
  "owner",
  "guardian",
  "spouse",
  "member",
  "client",
  "person",
  "sender",
  "receiver",
  "buyer",
  "emergency",
  "parent",
  "child",
  "student",
  "teacher",
  "doctor",
  "driver",
  "passenger",
  "guest",
  "applicant",
  "candidate",
  "beneficiary",
  "signatory",
  "signer",
  "profile",
  "author",
  "display",
];

/** Sub-fields of a `name` object: `name.first`, `name.last`. */
const NAME_PARTS = ["first", "last", "given", "family", "middle", "maiden"];

/**
 * Collections whose top-level `name` is a person's (singular forms; a trailing "s" is
 * removed from the collection name before comparing).
 */
const PERSON_COLLECTIONS = [
  "user",
  "customer",
  "people",
  "person",
  "contact",
  "member",
  "employee",
  "staff",
  "patient",
  "student",
  "profile",
  "client",
  "lead",
  "subscriber",
  "applicant",
  "candidate",
  "driver",
  "guest",
  "passenger",
  "author",
  "owner",
  "teacher",
  "doctor",
  "recipient",
  "account",
];

function personNameHint(name: DescribedName, context: FieldNameContext): NameHint | undefined {
  if (PERSON_NAME_COMPACTS.includes(name.compact)) return strong("person-name");
  // A user name is a handle ("jdoe42"), not a person's name.
  if (name.compact === "username") return undefined;
  if (hasToken(name, ["name"])) {
    if (hasToken(name, PERSON_ROLES)) return weak("person-name");
    if (name.compact === "name" && isPersonContext(context)) return weak("person-name");
    return undefined;
  }
  // `name.first`, `name.last`
  if (NAME_PARTS.includes(name.compact) && nearestParentHas(context, ["name"])) {
    return strong("person-name");
  }
  return undefined;
}

/** A bare `name` is a person's inside `customer`, `owner`, …, or at the top of `users`. */
function isPersonContext(context: FieldNameContext): boolean {
  if (context.parents.length > 0) return nearestParentHas(context, PERSON_ROLES);
  const collection = nameTokens(context.collection).map(singular);
  return collection.some((token) => PERSON_COLLECTIONS.includes(token));
}

/** `customers` → `customer`; leaves short words alone. */
function singular(token: string): string {
  return token.length > 3 && token.endsWith("s") ? token.slice(0, -1) : token;
}

function nearestParentHas(context: FieldNameContext, tokens: readonly string[]): boolean {
  const parent = context.parents.at(-1);
  if (parent === undefined) return false;
  return nameTokens(parent).some((token) => tokens.includes(token));
}

function hasAncestorToken(context: FieldNameContext, tokens: readonly string[]): boolean {
  return context.parents.some((parent) =>
    nameTokens(parent).some((token) => tokens.includes(token)),
  );
}
