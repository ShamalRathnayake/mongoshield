/**
 * Tests for the wildcard matcher behind namespace patterns: it must agree with the
 * obvious regular expression on every input, and stay fast on patterns that make a
 * backtracking regex explode.
 */

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { compileNamespaceFilter, compileWildcard } from "./namespace-filter.ts";

/** The reference: `*` → `.*`, everything else literal (fine for short inputs only). */
function referenceRegExp(wildcard: string): RegExp {
  const escaped = wildcard
    .split("*")
    .map((part) => part.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${escaped}$`, "s");
}

/** Short strings over a tiny alphabet, so stars and literals collide often. */
const wildcards = fc.string({ unit: fc.constantFrom("a", "b", ".", "*"), maxLength: 8 });
const names = fc.string({ unit: fc.constantFrom("a", "b", "."), maxLength: 10 });

describe("compileWildcard", () => {
  it("agrees with the equivalent regular expression on every input", () => {
    fc.assert(
      fc.property(wildcards, names, (wildcard, name) => {
        expect(compileWildcard(wildcard).test(name)).toBe(referenceRegExp(wildcard).test(name));
      }),
      { numRuns: 5000 },
    );
  });

  it("treats repeated stars like one star", () => {
    fc.assert(
      fc.property(wildcards, names, (wildcard, name) => {
        const collapsed = wildcard.replace(/\*+/g, "*");
        expect(compileWildcard(wildcard).test(name)).toBe(compileWildcard(collapsed).test(name));
      }),
    );
  });

  it("matches names without a star exactly", () => {
    expect(compileWildcard("users").test("users")).toBe(true);
    expect(compileWildcard("users").test("users2")).toBe(false);
  });

  it("does not let the prefix and the suffix overlap", () => {
    // "aba" would match "ab*ba" if the shared "b" counted twice.
    expect(compileWildcard("ab*ba").test("aba")).toBe(false);
    expect(compileWildcard("ab*ba").test("abba")).toBe(true);
  });

  it("answers at once for patterns that make a backtracking regex explode", () => {
    const started = performance.now();
    const filter = compileNamespaceFilter({ include: [`app.${"*".repeat(200)}!`] });
    expect(filter(`app.${"a".repeat(5000)}`)).toBe(false);
    const evil = compileWildcard(`${"a*".repeat(100)}!`);
    expect(evil.test("a".repeat(5000))).toBe(false);
    // A regex takes seconds for 12 stars; this must stay far below that.
    expect(performance.now() - started).toBeLessThan(500);
  });
});
