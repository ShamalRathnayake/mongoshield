// Unit tests for the journal's server-side database filter (capture.ts): the default
// `$in` / `$nin` form, and the regex-only form Atlas Free and Flex clusters require.

import { describe, expect, it } from "vitest";
import { createJournalScope } from "./capture.ts";

describe("createJournalScope's server filter", () => {
  it("uses $in for literal databases and $nin for everything else by default", () => {
    expect(createJournalScope({ include: ["app.*"] }).serverFilter).toEqual({
      $or: [{ "ns.db": { $in: ["app"] } }, { "to.db": { $in: ["app"] } }],
    });
    expect(createJournalScope({}).serverFilter).toEqual({
      "ns.db": { $nin: ["admin", "config", "local"] },
    });
  });

  it("uses regular expressions only on Atlas Free and Flex (no operators in ns.db)", () => {
    const literal = createJournalScope({ include: ["app.*"], regexDatabaseFilter: true });
    expect(JSON.stringify(literal.serverFilter)).not.toContain("$in");
    const [byNs] = (literal.serverFilter.$or ?? []) as { "ns.db": RegExp }[];
    expect(byNs?.["ns.db"]).toBeInstanceOf(RegExp);
    expect(byNs?.["ns.db"].test("app")).toBe(true);
    expect(byNs?.["ns.db"].test("apps")).toBe(false);

    const everything = createJournalScope({ regexDatabaseFilter: true }).serverFilter;
    const pattern = everything["ns.db"] as RegExp;
    expect(pattern).toBeInstanceOf(RegExp);
    expect(pattern.test("app")).toBe(true);
    expect(pattern.test("admin")).toBe(false);
    expect(pattern.test("local")).toBe(false);
  });
});
