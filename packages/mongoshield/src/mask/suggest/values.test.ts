// The value detectors: what each one accepts, and the look-alikes it must reject
// (dates as phones, counters as cards, UUIDs as tokens, …). Property tests check the
// checksums against independently generated valid and corrupted numbers.

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { ibanValid, luhnValid } from "./checksums.ts";
import {
  findContactInText,
  ipVersion,
  isCardNumber,
  isCoordinatePair,
  isDateLike,
  isEmail,
  isGeoJsonGeometry,
  isHexDigest,
  isIban,
  isNameLike,
  isObjectIdHex,
  isOpaqueIdentifier,
  isStreetAddress,
  isTokenLike,
  isUuid,
  phoneFormat,
  postalFormat,
  secretFormat,
  shannonEntropy,
} from "./values.ts";

/** Appends the Luhn check digit to a digit string. */
function withLuhnDigit(payload: string): string {
  for (let digit = 0; digit <= 9; digit++) {
    if (luhnValid(`${payload}${digit}`)) return `${payload}${digit}`;
  }
  throw new Error("unreachable: one of ten digits always completes a Luhn number");
}

describe("isEmail", () => {
  it.each([
    "ada@example.com",
    "ada.costa+news@mail.corp.co.uk",
    "o'brien@example.ie",
    "  padded@example.com  ",
  ])("accepts %s", (value) => {
    expect(isEmail(value)).toBe(true);
  });

  it.each([
    "ada@localhost",
    "ada@@example.com",
    "@example.com",
    "ada example@example.com",
    "ada@example.c",
    "not an email",
    `${"a".repeat(250)}@example.com`,
  ])("rejects %s", (value) => {
    expect(isEmail(value)).toBe(false);
  });
});

describe("phoneFormat", () => {
  it.each([
    ["+44 20 7946 0958", "e164"],
    ["+14155550123", "e164"],
    ["+1 (415) 555-0123", "e164"],
    ["(020) 7946 0958", "national"],
    ["555-123-4567", "national"],
    ["07700 900123", "national"],
    ["0771234567", "digits"],
  ] as const)("reads %s as %s", (value, format) => {
    expect(phoneFormat(value)).toBe(format);
  });

  it.each([
    ["an ISO date", "2026-10-24"],
    ["a day-month-year date", "24.10.2026"],
    ["an IPv4 address", "192.168.100.200"],
    ["a number with thousands separators", "1 234 567"],
    ["a dotted thousands number", "12.345.678"],
    ["too few digits", "55-0123"],
    ["too many digits", "+1234567890123456"],
    ["a country code starting with 0", "+0 20 7946 0958"],
    ["letters", "call 555 1234"],
    ["a very long value", "1 2 3 4 5 6 7 8 9 0 1 2 3"],
  ])("rejects %s", (_label, value) => {
    expect(phoneFormat(value)).toBeUndefined();
  });
});

describe("luhnValid and isCardNumber", () => {
  it("accepts the textbook Luhn example and rejects it with one digit changed", () => {
    expect(luhnValid("79927398713")).toBe(true);
    expect(luhnValid("79927398714")).toBe(false);
    expect(luhnValid("7992-7398713")).toBe(false);
  });

  it.each([
    "4111111111111111",
    "4111 1111 1111 1111",
    "5500-0000-0000-0004",
    "378282246310005",
    "6011111111111117",
  ])("accepts the test card %s", (value) => {
    expect(isCardNumber(value)).toBe(true);
  });

  it.each([
    ["a Luhn failure", "4111111111111112"],
    ["too short", "411111111111"],
    ["an unused first digit", withLuhnDigit("912345678901234")],
    ["a repeated digit", "0000000000000000"],
    ["mixed separators in odd places", "4111  1111 1111 1111"],
    ["letters", "4111 1111 1111 111a"],
  ])("rejects %s", (_label, value) => {
    expect(isCardNumber(value)).toBe(false);
  });

  it("accepts every 16-digit Visa-like number with its check digit, and none with a wrong one", () => {
    fc.assert(
      fc.property(
        fc.stringMatching(/^4[0-9]{14}$/),
        fc.integer({ min: 1, max: 9 }),
        (payload, offset) => {
          const valid = withLuhnDigit(payload);
          const last = Number(valid.at(-1));
          const wrong = `${payload}${(last + offset) % 10}`;
          expect(isCardNumber(valid)).toBe(true);
          expect(isCardNumber(wrong)).toBe(false);
        },
      ),
    );
  });
});

describe("ibanValid / isIban", () => {
  it.each([
    "GB82WEST12345698765432",
    "GB82 WEST 1234 5698 7654 32",
    "DE89370400440532013000",
    "gb82west12345698765432",
  ])("accepts %s", (value) => {
    expect(isIban(value)).toBe(true);
  });

  it.each([
    ["a wrong check", "GB83WEST12345698765432"],
    ["a wrong length for the country", "GB82WEST1234569876543"],
    ["an unknown country", "XX82WEST12345698765432"],
    ["punctuation", "GB82-WEST-1234-5698-7654-32"],
  ])("rejects %s", (_label, value) => {
    expect(ibanValid(value)).toBe(false);
  });

  it("rejects every single-character change of a valid IBAN", () => {
    const valid = "DE89370400440532013000";
    fc.assert(
      fc.property(
        fc.integer({ min: 4, max: valid.length - 1 }),
        fc.integer({ min: 1, max: 9 }),
        (index, offset) => {
          const digit = (Number(valid[index]) + offset) % 10;
          const changed = `${valid.slice(0, index)}${digit}${valid.slice(index + 1)}`;
          expect(ibanValid(changed)).toBe(false);
        },
      ),
    );
  });
});

describe("ipVersion", () => {
  it("tells IPv4 from IPv6 and rejects look-alikes", () => {
    expect(ipVersion("192.168.1.10")).toBe(4);
    expect(ipVersion("2001:db8::1")).toBe(6);
    expect(ipVersion("::1")).toBe(6);
    expect(ipVersion("256.1.1.1")).toBeUndefined();
    expect(ipVersion("1.2.3")).toBeUndefined();
    expect(ipVersion("00:1A:2B:3C:4D:5E")).toBeUndefined(); // a MAC address
    expect(ipVersion("12:30:45")).toBeUndefined(); // a time
  });
});

describe("secretFormat", () => {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ sub: "42" })).toString("base64url");

  it("recognises JWTs by their decoded header", () => {
    expect(secretFormat(`${header}.${payload}.c2lnbmF0dXJl`)).toBe("jwt");
    const noAlg = Buffer.from(JSON.stringify({ typ: "JWT" })).toString("base64url");
    expect(secretFormat(`${noAlg}.${payload}.c2ln`)).toBeUndefined();
    expect(secretFormat(`eyJub3Rqc29u.${payload}.c2ln`)).toBeUndefined();
  });

  it.each([
    `sk_live_${"a1B2".repeat(6)}`,
    `ghp_${"A".repeat(36)}`,
    "AKIAIOSFODNN7EXAMPLE",
    `AIza${"x".repeat(35)}`,
    `xoxb-${"1234567890"}-abc`,
    `sk-ant-${"a".repeat(30)}`,
    `npm_${"a".repeat(36)}`,
  ])("recognises the API key %s", (value) => {
    expect(secretFormat(value)).toBe("api-key");
  });

  it.each([
    `$2b$12$${"a".repeat(53)}`,
    "$argon2id$v=19$m=65536,t=3,p=4$c2FsdA$aGFzaA",
    "pbkdf2_sha256$600000$salt$hash",
    `$6$rounds$${"a".repeat(86)}`,
  ])("recognises the password hash %s", (value) => {
    expect(secretFormat(value)).toBe("password-hash");
  });

  it("ignores ordinary strings", () => {
    expect(secretFormat("hello world")).toBeUndefined();
    expect(secretFormat("sk_live_short")).toBeUndefined();
  });
});

describe("isTokenLike and the opaque identifiers", () => {
  it("accepts random tokens", () => {
    expect(isTokenLike("V1StGXR8Z5jdHi6BmyT3q9wK")).toBe(true);
    expect(isTokenLike("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855")).toBe(
      true,
    );
  });

  it("rejects words, short strings, spaces, ObjectIds and UUIDs", () => {
    expect(isTokenLike("aaaaaaaaaaaaaaaaaaaa1")).toBe(false); // no entropy
    expect(isTokenLike("short1")).toBe(false);
    expect(isTokenLike("has spaces in it 123456")).toBe(false);
    expect(isTokenLike("onlyletterswithoutdigitsxyz")).toBe(false);
    expect(isTokenLike("507f1f77bcf86cd799439011")).toBe(false);
    expect(isTokenLike("f47ac10b-58cc-4372-a567-0e02b2c3d479")).toBe(false);
  });

  it("recognises UUIDs, ObjectId hex and digests", () => {
    expect(isUuid("F47AC10B-58CC-4372-A567-0E02B2C3D479")).toBe(true);
    expect(isObjectIdHex("507f1f77bcf86cd799439011")).toBe(true);
    expect(isHexDigest("d41d8cd98f00b204e9800998ecf8427e")).toBe(true); // MD5
    expect(isHexDigest("d41d8cd98f00b204e9800998ecf8427")).toBe(false); // 31 chars
    expect(isOpaqueIdentifier("not-an-id")).toBe(false);
  });

  it("measures entropy in bits per character", () => {
    expect(shannonEntropy("")).toBe(0);
    expect(shannonEntropy("aaaa")).toBe(0);
    expect(shannonEntropy("abcd")).toBe(2);
  });
});

describe("postalFormat", () => {
  it.each([
    ["94105-1804", "distinctive"],
    ["SW1A 1AA", "distinctive"],
    ["K1A 0B1", "distinctive"],
    ["94105", "plain"],
    ["1012 AB", "plain"],
    ["123-4567", "plain"],
    ["SW1A1AA", "plain"],
  ] as const)("reads %s as %s", (value, format) => {
    expect(postalFormat(value)).toBe(format);
  });

  it("rejects values that are no postal code", () => {
    expect(postalFormat("12")).toBeUndefined();
    expect(postalFormat("hello")).toBeUndefined();
    expect(postalFormat("12345678901")).toBeUndefined();
  });
});

describe("isStreetAddress", () => {
  it.each([
    "221B Baker Street",
    "1600 Pennsylvania Ave NW, Washington",
    "Flat 3, 12 Rue de la Paix Road",
    "Hauptstraße 5",
    "Calle Mayor 3, Madrid",
  ])("accepts %s", (value) => {
    expect(isStreetAddress(value)).toBe(true);
  });

  it.each(["Baker Street", "12 apples", "Order 1234 shipped", `12 Main Street ${"x".repeat(200)}`])(
    "rejects %s",
    (value) => {
      expect(isStreetAddress(value)).toBe(false);
    },
  );
});

describe("isNameLike and isDateLike", () => {
  it("accepts names in any script, with apostrophes and hyphens", () => {
    for (const name of ["Ada Costa", "Seán O'Brien-Murphy", "J. R. R. Tolkien", "李小龍", "Zoë"]) {
      expect(isNameLike(name)).toBe(true);
    }
  });

  it("rejects digits, emails and long sentences", () => {
    expect(isNameLike("jdoe42")).toBe(false);
    expect(isNameLike("ada@example.com")).toBe(false);
    expect(isNameLike("one two three four five six")).toBe(false);
    expect(isNameLike("")).toBe(false);
  });

  it("accepts dates in common formats with plausible years", () => {
    for (const date of [
      "1990-05-01",
      "1990-05-01T00:00:00Z",
      "01/05/1990",
      "1.5.1990",
      "1990.05.01",
    ]) {
      expect(isDateLike(date)).toBe(true);
    }
    expect(isDateLike("1800-01-01")).toBe(false);
    expect(isDateLike("May 1st")).toBe(false);
  });
});

describe("findContactInText", () => {
  it("finds emails and phone numbers inside prose", () => {
    expect(findContactInText("Please reach me at ada@example.com tomorrow")).toBe(
      "ada@example.com",
    );
    expect(findContactInText("Call me on +44 7700 900123 after 5pm")).toBe("+44 7700 900123");
  });

  it("ignores short values, single words, dates and short digit runs", () => {
    expect(findContactInText("ada@example.com")).toBeUndefined();
    expect(findContactInText("x".repeat(30))).toBeUndefined();
    expect(findContactInText("Shipped between 2024-01-05 and 2024-01-09")).toBeUndefined();
    expect(findContactInText("Order 12 345 arrived damaged, refund it")).toBeUndefined();
  });
});

describe("geolocation", () => {
  it("recognises GeoJSON geometries and [lng, lat] pairs", () => {
    expect(isGeoJsonGeometry({ type: "Point", coordinates: [-0.12, 51.5] })).toBe(true);
    expect(isGeoJsonGeometry({ type: "Polygon", coordinates: [[[0, 0]]] })).toBe(true);
    expect(isGeoJsonGeometry({ type: "Feature", coordinates: [] })).toBe(false);
    expect(isGeoJsonGeometry({ type: "Point" })).toBe(false);
    expect(isCoordinatePair([-0.12, 51.5])).toBe(true);
    expect(isCoordinatePair([200, 51.5])).toBe(false);
    expect(isCoordinatePair([-0.12, 95])).toBe(false);
    expect(isCoordinatePair([-0.12, undefined])).toBe(false);
    expect(isCoordinatePair([1, 2, 3])).toBe(false);
  });
});
