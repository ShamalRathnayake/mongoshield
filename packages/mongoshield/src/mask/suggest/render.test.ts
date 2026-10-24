// Writing suggestions: the paste-able snippet, a new mask module that loads and
// validates, and merging into JSON mask files without ever changing an existing rule.

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type MaskConfig, parseMaskRules } from "../config.ts";
import {
  countRules,
  mergeIntoJsonMask,
  type NamespaceSuggestions,
  newRules,
  renderMaskModule,
  renderRulesSnippet,
  toLiteral,
} from "./render.ts";
import type { MaskSuggestion } from "./rules.ts";

/** A suggestion with sensible defaults. */
function suggestion(overrides: Partial<MaskSuggestion>): MaskSuggestion {
  return {
    path: "email",
    kind: "email",
    confidence: 0.98,
    share: 1,
    matched: 1000,
    sampled: 1000,
    example: "xxx@xxx.xxx",
    reason: "because",
    valueType: "string",
    rule: { fake: "email" },
    status: "new",
    ...overrides,
  };
}

const GROUPS: NamespaceSuggestions[] = [
  {
    ns: "app.users",
    suggestions: [
      suggestion({}),
      suggestion({
        path: "addresses.*.zip",
        kind: "postal-code",
        rule: "redact",
        share: 0.987,
        confidence: 0.86,
      }),
      suggestion({ path: "phone", kind: "phone", rule: { fake: "phone" }, status: "covered" }),
      suggestion({ path: "lat", kind: "geolocation", rule: { hash: { range: [-90, 90] } } }),
    ],
  },
  { ns: "app.orders", suggestions: [suggestion({ path: "notes", status: "kept" })] },
  { ns: "app.empty", suggestions: [] },
];

let directory: string;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "mongoshield-mask-render-"));
});

afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe("newRules", () => {
  it("keeps only new suggestions, keyed by exact namespace", () => {
    const rules = newRules(GROUPS);
    expect(rules).toEqual({
      "app.users": {
        email: { fake: "email" },
        "addresses.*.zip": "redact",
        lat: { hash: { range: [-90, 90] } },
      },
    });
    expect(countRules(rules)).toBe(3);
  });
});

describe("renderRulesSnippet", () => {
  it("writes TypeScript entries with a comment per rule", () => {
    expect(renderRulesSnippet(GROUPS, 2)).toBe(
      [
        '  "app.users": {',
        '    email: { fake: "email" }, // email · 100% of 1,000 values · confidence 0.98',
        '    "addresses.*.zip": "redact", // postal code · 98% of 1,000 values · confidence 0.86',
        "    lat: { hash: { range: [-90, 90] } }, // geolocation · 100% of 1,000 values · confidence 0.98",
        "  },",
      ].join("\n"),
    );
  });

  it("is empty when nothing is new", () => {
    expect(
      renderRulesSnippet([{ ns: "app.users", suggestions: [suggestion({ status: "covered" })] }]),
    ).toBe("");
  });

  it("writes literals like a person would", () => {
    expect(toLiteral({ fake: "date-shift", days: 365 })).toBe('{ fake: "date-shift", days: 365 }');
    expect(toLiteral({ "odd key": [1, "two"] })).toBe('{ "odd key": [1, "two"] }');
    expect(toLiteral("hash")).toBe('"hash"');
  });
});

describe("renderMaskModule", () => {
  it("writes a mask module that loads and validates", async () => {
    const file = join(directory, "mask.ts");
    // The module imports `mongoshield`; point it at the source for the test.
    const source = renderMaskModule(GROUPS).replace(
      'from "mongoshield"',
      `from ${JSON.stringify(join(import.meta.dirname, "../../index.ts"))}`,
    );
    await writeFile(file, source);
    const jiti = createJiti(import.meta.url, { moduleCache: false });
    const loaded = await jiti.import<MaskConfig>(file, { default: true });
    expect(loaded.rules).toEqual(newRules(GROUPS));
    expect(() => parseMaskRules(loaded)).not.toThrow();
    expect(source).toContain("secret: process.env.MONGOSHIELD_MASK_SECRET");
    expect(source).toContain("Review every rule before copying");
  });
});

describe("mergeIntoJsonMask", () => {
  const rules = newRules(GROUPS);

  it("creates a mask file from nothing (or an empty file)", () => {
    for (const existing of [undefined, "", "  \n"]) {
      const result = mergeIntoJsonMask(existing, rules);
      expect(JSON.parse(result.text)).toEqual({ rules });
      expect(result).toMatchObject({ added: 3, skipped: 0 });
      expect(result.text.endsWith("}\n")).toBe(true);
    }
  });

  it("adds new rules and never changes existing ones or other keys", () => {
    const existing = JSON.stringify({
      onUnsupported: "null",
      rules: {
        "app.users": { email: "hash", age: { hash: { range: [18, 90] } } },
        "app.logs": { ip: "null" },
      },
      secret: "kept-as-it-is-0123456789",
    });
    const result = mergeIntoJsonMask(existing, rules);
    const merged = JSON.parse(result.text) as Record<string, unknown>;
    expect(Object.keys(merged)).toEqual(["onUnsupported", "rules", "secret"]);
    expect(merged.rules).toEqual({
      "app.users": {
        email: "hash", // unchanged: the user's rule wins
        age: { hash: { range: [18, 90] } },
        "addresses.*.zip": "redact",
        lat: { hash: { range: [-90, 90] } },
      },
      "app.logs": { ip: "null" },
    });
    expect(result).toMatchObject({ added: 2, skipped: 1 });
  });

  it.each([
    ["not JSON", "{ rules: ", /JSON/],
    ["an array", "[]", /not a JSON object/],
    ["rules that are not an object", '{ "rules": [] }', /`rules` is not an object/],
    [
      "a namespace that is not an object",
      '{ "rules": { "app.users": "hash" } }',
      /rules for "app.users"/,
    ],
  ])("refuses %s", (_label, existing, message) => {
    expect(() => mergeIntoJsonMask(existing, rules)).toThrow(message);
  });
});
