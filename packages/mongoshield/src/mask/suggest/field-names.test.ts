// Field-name hints: naming conventions, context (`name` in `users` vs `products`),
// precedence (`emailAddress` is an email, `ipAddress` an IP) and names that must not
// look personal (`username`, `zipFile`, `longDescription`).

import { describe, expect, it } from "vitest";
import { type FieldNameContext, hintForField, nameTokens } from "./field-names.ts";

/** The hint for a key, optionally with parents and a collection. */
function hint(key: string, context: Partial<FieldNameContext> = {}) {
  return hintForField({ key, parents: [], collection: "things", ...context });
}

describe("nameTokens", () => {
  it("splits every naming convention into lowercase tokens", () => {
    expect(nameTokens("dateOfBirth")).toEqual(["date", "of", "birth"]);
    expect(nameTokens("date_of_birth")).toEqual(["date", "of", "birth"]);
    expect(nameTokens("userIPAddress")).toEqual(["user", "ip", "address"]);
    expect(nameTokens("ZIPCode")).toEqual(["zip", "code"]);
    expect(nameTokens("addressLine1")).toEqual(["address", "line", "1"]);
    expect(nameTokens("SSN")).toEqual(["ssn"]);
    expect(nameTokens("---")).toEqual([]);
  });
});

describe("hintForField", () => {
  it.each([
    ["password", "secret", "password"],
    ["hashedPassword", "secret", "password"],
    ["apiKey", "secret", "token"],
    ["refresh_token", "secret", "token"],
    ["clientSecret", "secret", "token"],
    ["sessionId", "secret", "token"],
    ["email", "email", undefined],
    ["emailAddress", "email", undefined],
    ["mobilePhone", "phone", undefined],
    ["tel", "phone", undefined],
    ["dob", "date-of-birth", undefined],
    ["birthDate", "date-of-birth", undefined],
    ["ssn", "national-id", undefined],
    ["nationalInsuranceNumber", "national-id", undefined],
    ["passportNo", "national-id", undefined],
    ["cardNumber", "credit-card", undefined],
    ["pan", "credit-card", undefined],
    ["iban", "iban", undefined],
    ["lastLoginIp", "ip-address", undefined],
    ["ipAddress", "ip-address", undefined],
    ["remoteAddr", "ip-address", undefined],
    ["pickupLat", "geolocation", "latitude"],
    ["longitude", "geolocation", "longitude"],
    ["long", "geolocation", "longitude"],
    ["location", "geolocation", "location"],
    ["zip", "postal-code", undefined],
    ["postalCode", "postal-code", undefined],
    ["postCode", "postal-code", undefined],
    ["streetAddress", "address", undefined],
    ["firstName", "person-name", undefined],
    ["surname", "person-name", undefined],
  ] as const)("reads %s as %s", (key, kind, detail) => {
    const result = hint(key);
    expect(result?.kind).toBe(kind);
    expect(result?.detail).toBe(detail);
  });

  it("gives strong and weak hints", () => {
    expect(hint("firstName")?.strength).toBe("strong");
    expect(hint("customerName")?.strength).toBe("weak");
    expect(hint("tin")).toEqual({ kind: "national-id", strength: "weak" });
    expect(hint("accountNumber")).toEqual({ kind: "iban", strength: "weak" });
  });

  it("reads a bare `name` by its context", () => {
    expect(hint("name", { collection: "users" })?.kind).toBe("person-name");
    expect(hint("name", { collection: "customer_profiles" })?.kind).toBe("person-name");
    expect(hint("name", { parents: ["owner"] })?.kind).toBe("person-name");
    expect(hint("name", { collection: "products" })).toBeUndefined();
    expect(hint("name", { parents: ["category"], collection: "users" })).toBeUndefined();
    expect(hint("first", { parents: ["name"] })?.kind).toBe("person-name");
    expect(hint("first", { parents: ["rank"] })).toBeUndefined();
  });

  it("reads address parts inside address-like parents only", () => {
    expect(hint("line1", { parents: ["shippingAddress"] })?.kind).toBe("address");
    expect(hint("apartment", { parents: ["home"] })?.kind).toBe("address");
    expect(hint("line1", { parents: ["invoice"] })).toBeUndefined();
    expect(hint("city", { parents: ["address"] })).toBeUndefined();
  });

  it.each([
    "username",
    "zipFile",
    "longDescription",
    "macAddress",
    "walletAddress",
    "status",
    "productName",
    "createdAt",
    "count",
    "points",
  ])("finds nothing personal in %s", (key) => {
    expect(hint(key)).toBeUndefined();
  });
});
