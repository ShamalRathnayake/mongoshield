/**
 * Tests for the regex cost check: catastrophic patterns are refused before they can
 * block the event loop, while everyday search patterns pass untouched.
 */

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { isMongoShieldError } from "../errors.ts";
import { compileFilter } from "./filter.ts";
import { MAX_REGEX_PATTERN_LENGTH, regexCostProblem } from "./filter-regex.ts";

describe("regexCostProblem", () => {
  it.each([
    "^(.+)+X$",
    "(a+)+",
    "(a*)*b",
    "(.*a){20}",
    "(\\w+\\s?)*$",
    "((ab)+c)+",
    "(a{2,})+",
    "([a-z]+)*@",
    "(\\w+)*",
    // The last character could also be matched by the repeat before it.
    "(\\w+x)+",
    "(.+\\.)+",
    "([a-z.]+\\.)+$",
    // The delimiter is optional, or repeats, or is a class: not a single required literal.
    "([a-z]+\\.?)+",
    "([a-z]+[.,])+",
    // Several alternatives, or nested groups, are never treated as delimited.
    "([a-z]+\\.|b)+",
    "((?:[a-z])+\\.)+",
    // A backreference matches unknown characters.
    "(a)(\\1+\\.)+",
  ])("refuses the nested quantifier %s", (pattern) => {
    expect(regexCostProblem(pattern)).toMatch(/repeats a group that itself repeats/);
  });

  it.each([
    "^ada@",
    "\\.(jpe?g|png)$",
    "(foo|bar)+",
    "^[A-Z]{2}\\d{4,}$",
    "(a+)?b",
    "(ab){3}",
    "[(+*)]+",
    "\\(a+\\)+",
    "^(?:\\d{3}-)?\\d{4}$",
    "(a+){1}",
    "(ab|ac)+",
    "(?:https?|ftp)://",
  ])("accepts the ordinary pattern %s", (pattern) => {
    expect(regexCostProblem(pattern)).toBeUndefined();
  });

  it.each([
    "^([a-z0-9]+\\.)+[a-z]+$",
    "^(\\w+-)+\\d+$",
    "(?:x+y)+",
    "^([^.]+\\.)+$",
    "^(?:[A-Z][a-z]*_)+[A-Z]+$",
    "^(\\d+,)*\\d+$",
    "^(?:[a-z\\d-]+\\/)+[a-z]+$",
  ])(
    "accepts the repeated group %s, which ends with a character its repeats cannot match",
    (pattern) => {
      expect(regexCostProblem(pattern)).toBeUndefined();
    },
  );

  it.each(["(a|aa)+", "(a|[ab])*", "(?:x|xy|y)+$", "(\\d|\\w)+$", "(a|A)+"])(
    "refuses the repeated alternation %s, whose alternatives can match the same text",
    (pattern) => {
      expect(regexCostProblem(pattern)).toMatch(/alternatives can match the same text/);
    },
  );

  it("never throws, whatever the pattern", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 64 }), (pattern) => {
        const problem = regexCostProblem(pattern);
        expect(problem === undefined || typeof problem === "string").toBe(true);
      }),
    );
    // Unbalanced and truncated syntax.
    for (const pattern of [
      "(",
      ")",
      "((a",
      "a)+",
      "[",
      "[^",
      "\\",
      "(?",
      "(?<n",
      "a{2,",
      "(?<=x",
    ]) {
      expect(() => regexCostProblem(pattern)).not.toThrow();
    }
  });

  it("lets through only delimited groups that really run in linear time", () => {
    // Any word of letters and digits, repeated with a delimiter it cannot contain,
    // then a string that fails at its very end: the worst case for backtracking.
    const delimiters = fc.constantFrom("\\.", "-", ",", "_", "\\/", "@", ":");
    fc.assert(
      fc.property(delimiters, fc.integer({ min: 2000, max: 5000 }), (delimiter, count) => {
        const pattern = `^([a-z0-9]+${delimiter})+[a-z]+$`;
        expect(regexCostProblem(pattern)).toBeUndefined();
        const plain = delimiter.replace("\\", "");
        const text = `${`ab${plain}`.repeat(count)}!`;
        const started = performance.now();
        expect(new RegExp(pattern).test(text)).toBe(false);
        // An exponential pattern would not finish at all; 250 ms is generous for CI.
        expect(performance.now() - started).toBeLessThan(250);
      }),
      { numRuns: 20 },
    );
  });

  it("refuses patterns longer than the cap", () => {
    expect(regexCostProblem("a".repeat(MAX_REGEX_PATTERN_LENGTH))).toBeUndefined();
    expect(regexCostProblem("a".repeat(MAX_REGEX_PATTERN_LENGTH + 1))).toMatch(/characters long/);
  });
});

describe("compileFilter with expensive regexes", () => {
  it("fails with MS_CONFIG_INVALID instead of running a catastrophic $regex", () => {
    let caught: unknown;
    try {
      compileFilter({ name: { $regex: "^(.+)+X$" } });
    } catch (error) {
      caught = error;
    }
    expect(isMongoShieldError(caught, "MS_CONFIG_INVALID")).toBe(true);
  });

  it("checks regex literals and $in regexes too", () => {
    expect(() => compileFilter({ name: /^(a+)+$/ })).toThrow(/repeats a group/);
    expect(() => compileFilter({ name: { $in: [/^(a|b)$/, /(x*)*y/] } })).toThrow(
      /repeats a group/,
    );
  });

  it("still matches with ordinary patterns", () => {
    const matches = compileFilter({ email: { $regex: "^ada@", $options: "i" } });
    expect(matches({ email: "Ada@example.com" })).toBe(true);
    expect(matches({ email: "bob@example.com" })).toBe(false);
  });
});
