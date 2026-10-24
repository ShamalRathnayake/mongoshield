// From findings to rules: the operation chosen per kind and value type, and coverage
// by the current mask config (same path, implicit array traversal, ancestors replaced
// wholesale, keep rules, exact namespaces beating patterns). The suggested rules must
// always be valid mask rules: `parseMaskRules` accepts every one of them.

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { parseMaskRules } from "../config.ts";
import type { PiiFinding } from "./classify.ts";
import { PII_KINDS, type PiiKind } from "./kinds.ts";
import { currentRules, ruleForFinding, selects, suggestRules } from "./rules.ts";

/** A finding with sensible defaults. */
function finding(overrides: Partial<PiiFinding> & { kind: PiiKind }): PiiFinding {
  return {
    path: "field",
    confidence: 0.9,
    share: 1,
    matched: 10,
    sampled: 10,
    example: "xxx",
    reason: "because",
    valueType: "string",
    ...overrides,
  };
}

describe("ruleForFinding", () => {
  it.each([
    [{ kind: "email" }, { fake: "email" }],
    [{ kind: "phone" }, { fake: "phone" }],
    [{ kind: "phone", valueType: "number" }, "hash"],
    [{ kind: "person-name" }, { fake: "name" }],
    [{ kind: "person-name", valueType: "mixed" }, "redact"],
    [{ kind: "address" }, { fake: "address" }],
    [{ kind: "ip-address" }, { fake: "ip" }],
    [{ kind: "postal-code" }, "redact"],
    [{ kind: "postal-code", valueType: "number" }, "hash"],
    [{ kind: "credit-card" }, "redact"],
    [{ kind: "credit-card", valueType: "number" }, "null"],
    [{ kind: "iban" }, "redact"],
    [{ kind: "national-id" }, "hash"],
    [
      { kind: "date-of-birth", valueType: "date" },
      { fake: "date-shift", days: 365 },
    ],
    [{ kind: "date-of-birth" }, "redact"],
    [{ kind: "date-of-birth", valueType: "mixed" }, "null"],
    [{ kind: "secret", detail: "password" }, "drop"],
    [{ kind: "secret", detail: "password-hash" }, "drop"],
    [{ kind: "secret", detail: "jwt" }, "hash"],
    [
      { kind: "geolocation", detail: "latitude", valueType: "number" },
      { hash: { range: [-90, 90] } },
    ],
    [
      { kind: "geolocation", detail: "longitude", valueType: "number" },
      { hash: { range: [-180, 180] } },
    ],
    [{ kind: "geolocation", detail: "geojson", valueType: "geo" }, "null"],
    [{ kind: "free-text" }, "redact"],
    [{ kind: "email", valueType: "number" }, "hash"],
  ] as const)("suggests for %o: %o", (overrides, rule) => {
    expect(ruleForFinding(finding(overrides))).toEqual(rule);
  });

  it("only ever suggests valid mask rules", () => {
    const kinds = fc.constantFrom(...PII_KINDS);
    const types = fc.constantFrom("string", "number", "date", "geo", "other", "mixed" as const);
    const details = fc.constantFrom(undefined, "password", "latitude", "longitude", "jwt");
    fc.assert(
      fc.property(kinds, types, details, (kind, valueType, detail) => {
        const rule = ruleForFinding(finding({ kind, valueType, ...(detail ? { detail } : {}) }));
        expect(() => parseMaskRules({ rules: { "app.users": { field: rule } } })).not.toThrow();
      }),
    );
  });
});

describe("selects", () => {
  const split = (path: string) => path.split(".");

  it.each([
    ["email", "email", "field"],
    ["addresses.zip", "addresses.*.zip", "field"], // implicit traversal
    ["addresses.*.zip", "addresses.*.zip", "field"],
    ["*.zip", "billing.zip", "field"], // * = every key
    ["tags.*", "tags", "field"], // elements of the array
    ["addresses", "addresses.*.zip", "ancestor"],
    ["profile", "profile.email", "ancestor"],
    ["addresses.0.zip", "addresses.*.zip", "none"], // one element only
    ["profile.email", "profile", "none"], // deeper than the field
    ["email", "phone", "none"],
    ["profile.phone", "profile.email", "none"],
  ] as const)("rule %s selects %s: %s", (rule, field, expected) => {
    expect(selects(split(rule), split(field))).toBe(expected);
  });

  it("always selects a field with the field's own path", () => {
    const segment = fc.oneof(fc.constant("*"), fc.stringMatching(/^[a-z]{1,6}$/));
    fc.assert(
      fc.property(fc.array(segment, { minLength: 1, maxLength: 6 }), (segments) => {
        expect(selects(segments, segments)).toBe("field");
      }),
    );
  });
});

describe("suggestRules", () => {
  const findings = [
    finding({ path: "email", kind: "email" }),
    finding({ path: "addresses.*.zip", kind: "postal-code" }),
    finding({ path: "profile.phone", kind: "phone" }),
    finding({ path: "notes", kind: "free-text" }),
    finding({ path: "ssn", kind: "national-id" }),
  ];

  it("marks everything new without a mask config", () => {
    const suggestions = suggestRules("app.users", findings, currentRules(undefined));
    expect(suggestions.map((suggestion) => suggestion.status)).toEqual([
      "new",
      "new",
      "new",
      "new",
      "new",
    ]);
    expect(suggestions[0]?.rule).toEqual({ fake: "email" });
    expect(suggestions[0]).not.toHaveProperty("coveredBy");
  });

  it("marks covered and kept fields, following the masker's rule selection", () => {
    const rules = currentRules({
      rules: {
        "*.*": { email: { fake: "email" }, notes: "redact" },
        "app.users": { "addresses.zip": "redact", profile: "drop", notes: "keep" },
        "app.*": { ssn: "hash" },
        "app.admins": { ssn: "keep" },
      },
    });
    const suggestions = suggestRules("app.users", findings, rules);
    expect(suggestions.map((suggestion) => [suggestion.path, suggestion.status])).toEqual([
      ["email", "covered"],
      ["addresses.*.zip", "covered"],
      ["profile.phone", "covered"], // its parent is dropped
      ["notes", "kept"], // the exact namespace's keep beats the *.* redact
      ["ssn", "covered"], // app.admins' keep applies to app.admins only
    ]);
    expect(suggestions[0]?.coveredBy).toEqual({
      pattern: "*.*",
      path: "email",
      operation: "fake:email",
    });
    expect(suggestions[3]?.coveredBy).toEqual({
      pattern: "app.users",
      path: "notes",
      operation: "keep",
    });
  });

  it("does not count hash or fake on a containing document as coverage", () => {
    const rules = currentRules({
      rules: { "app.users": { profile: "hash", addresses: { fake: "address" } } },
    });
    const suggestions = suggestRules("app.users", findings, rules);
    expect(suggestions.find((suggestion) => suggestion.path === "profile.phone")?.status).toBe(
      "new",
    );
    expect(suggestions.find((suggestion) => suggestion.path === "addresses.*.zip")?.status).toBe(
      "new",
    );
  });

  it("prefers a masking rule over a keep rule on another path that also selects the field", () => {
    const rules = currentRules({ rules: { "app.users": { "*.phone": "keep", profile: "null" } } });
    const suggestions = suggestRules("app.users", findings, rules);
    expect(suggestions.find((suggestion) => suggestion.path === "profile.phone")).toMatchObject({
      status: "covered",
      coveredBy: { path: "profile", operation: "null" },
    });
  });

  it("rejects an invalid mask config before anything else", () => {
    expect(() => currentRules({ rules: { "app.users": { email: "scramble" as never } } })).toThrow(
      /unknown operation/,
    );
  });
});
