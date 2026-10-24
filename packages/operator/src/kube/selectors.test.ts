/** Tests for label selectors. */

import { describe, expect, it } from "vitest";
import { matchesSelector, selectorFrom } from "./selectors.ts";

describe("label selectors", () => {
  it("builds a stable selector from a map", () => {
    expect(selectorFrom({ b: "2", a: "1" })).toBe("a=1,b=2");
  });

  it("matches equality and existence clauses, all of which must hold", () => {
    const labels = { app: "mongoshield", tier: "backup" };
    expect(matchesSelector(labels, "app=mongoshield")).toBe(true);
    expect(matchesSelector(labels, "app=mongoshield,tier=backup")).toBe(true);
    expect(matchesSelector(labels, "app=mongoshield,tier=web")).toBe(false);
    expect(matchesSelector(labels, "tier")).toBe(true);
    expect(matchesSelector(labels, "missing")).toBe(false);
    expect(matchesSelector(undefined, "app=x")).toBe(false);
    expect(matchesSelector(undefined, undefined)).toBe(true);
    expect(matchesSelector(labels, " app=mongoshield , ")).toBe(true);
  });
});
