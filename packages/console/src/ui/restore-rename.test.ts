/**
 * Unit tests for "Restore as": database name checks, the rules generated for each
 * choice, hand-written rules, and the preview mapping (with the library's precedence).
 */

import { describe, expect, it } from "vitest";
import {
  DEFAULT_RESTORE_AS,
  databaseNameProblem,
  NEW_DATABASE,
  parseRenameRules,
  renameOf,
  renameRuleProblem,
  renameRulesFor,
  renameRulesToText,
  targetNamespace,
} from "./restore-rename.ts";

describe("databaseNameProblem", () => {
  it("accepts ordinary names", () => {
    expect(databaseNameProblem("shop_restored")).toBeUndefined();
    expect(databaseNameProblem("a-b_c1")).toBeUndefined();
  });

  it("refuses empty names, forbidden characters and names over 63 bytes", () => {
    expect(databaseNameProblem("")).toBe("Enter a database name.");
    for (const bad of ["a.b", "a b", "a/b", "a$b", "a*b", 'a"b', "a:b", "a?b"]) {
      expect(databaseNameProblem(bad)).toMatch(/cannot contain/);
    }
    expect(databaseNameProblem("x".repeat(63))).toBeUndefined();
    expect(databaseNameProblem("x".repeat(64))).toMatch(/63 bytes/);
    // Bytes, not characters: 32 two-byte characters are 64 bytes.
    expect(databaseNameProblem("é".repeat(32))).toMatch(/63 bytes/);
  });
});

describe("renameRulesFor", () => {
  const options = { suffix: "_restored", targetDatabase: "" };

  it("sends no rules for original names", () => {
    expect(renameRulesFor("original", ["shop", "crm"], options)).toEqual({});
  });

  it("suffixes every chosen database for a copy", () => {
    expect(renameRulesFor("copy", ["shop", "crm"], options)).toEqual({
      "shop.*": "shop_restored.*",
      "crm.*": "crm_restored.*",
    });
  });

  it("explains an empty or invalid suffix", () => {
    expect(renameRulesFor("copy", ["shop"], { ...options, suffix: "" })).toBe(
      "Enter a suffix, e.g. _restored.",
    );
    expect(renameRulesFor("copy", ["shop"], { ...options, suffix: ".old" })).toMatch(
      /^"shop.old" is not a valid database name\. Database names cannot contain/,
    );
  });

  it("moves one database into another", () => {
    expect(
      renameRulesFor("database", ["shop"], { ...options, targetDatabase: "recovery" }),
    ).toEqual({ "shop.*": "recovery.*" });
  });

  it("explains what the database choice needs", () => {
    expect(renameRulesFor("database", [], options)).toEqual({});
    expect(renameRulesFor("database", ["shop", "crm"], options)).toMatch(
      /needs collections from one database, but these come from 2 \(shop, crm\)/,
    );
    expect(renameRulesFor("database", ["shop"], options)).toBe(
      "Choose the database to restore into.",
    );
    expect(renameRulesFor("database", ["shop"], { ...options, targetDatabase: "a b" })).toMatch(
      /cannot contain/,
    );
    expect(renameRulesFor("database", ["shop"], { ...options, targetDatabase: "shop" })).toMatch(
      /is the original database/,
    );
  });
});

describe("renameOf", () => {
  it("uses the typed rules for custom", () => {
    expect(renameOf({ ...DEFAULT_RESTORE_AS, kind: "custom", customText: "a.x=b.y" }, [])).toEqual({
      "a.x": "b.y",
    });
  });

  it("trims the suffix and uses the new database name for NEW_DATABASE", () => {
    expect(renameOf({ ...DEFAULT_RESTORE_AS, kind: "copy", suffix: " _old " }, ["shop"])).toEqual({
      "shop.*": "shop_old.*",
    });
    expect(
      renameOf(
        { ...DEFAULT_RESTORE_AS, kind: "database", database: NEW_DATABASE, newDatabase: " fresh " },
        ["shop"],
      ),
    ).toEqual({ "shop.*": "fresh.*" });
    expect(
      renameOf({ ...DEFAULT_RESTORE_AS, kind: "database", database: "existing" }, ["shop"]),
    ).toEqual({ "shop.*": "existing.*" });
  });
});

describe("parseRenameRules", () => {
  it("reads from=to lines and skips blank ones", () => {
    expect(parseRenameRules("shop.*=shop_restored.*\n\n  analytics.x = a2.x  ")).toEqual({
      "shop.*": "shop_restored.*",
      "analytics.x": "a2.x",
    });
  });

  it("names the first bad line", () => {
    expect(parseRenameRules("shop.*")).toBe('"shop.*" is not from=to, e.g. shop.*=shop_restored.*');
    expect(parseRenameRules("shop=other.x")).toMatch(/^"shop=other.x": add a "."/);
    // The library's finer rules are checked here too, before the server's dry run.
    expect(parseRenameRules("shop.*=archive.users")).toMatch(
      /^"shop.\*=archive.users": a whole-database rule needs a whole-database target/,
    );
  });

  it("refuses custom settings without any rule", () => {
    expect(renameOf({ ...DEFAULT_RESTORE_AS, kind: "custom", customText: " \n " }, [])).toBe(
      "Type at least one from=to rule, or choose “Original names”.",
    );
  });
});

describe("renameRuleProblem", () => {
  it("accepts whole databases to whole databases and exact collections", () => {
    expect(renameRuleProblem("shop.*", "shop_restored.*")).toBeUndefined();
    expect(renameRuleProblem("shop.users", "archive.people")).toBeUndefined();
    expect(renameRuleProblem("shop.users", "shop.system.js")).toBeUndefined();
  });

  it("explains what the library would refuse", () => {
    expect(renameRuleProblem("shop.*", "shop.users")).toMatch(/whole-database target/);
    expect(renameRuleProblem("sh*p.*", "x.*")).toMatch(/^database names cannot contain/);
    expect(renameRuleProblem("shop.us*", "x.users")).toMatch(/only whole databases/);
    expect(renameRuleProblem("shop.users", "x.u*")).toMatch(/only whole databases/);
    expect(renameRuleProblem("shop.users", "a|b.users")).toMatch(/^database names cannot/);
    expect(renameRuleProblem("shop.users", "x.")).toMatch(/name the collection on both sides/);
    expect(renameRuleProblem("shop.users", "x.a$b")).toBe('collection names cannot contain "$"');
    expect(renameRuleProblem("shop.users", "x.system.users")).toMatch(/are reserved/);
    expect(renameRuleProblem("shop.users", `x.${"c".repeat(260)}`)).toMatch(/longer than 255/);
  });
});

describe("renameRulesToText", () => {
  it("writes one from=to per line and round-trips through the parser", () => {
    const rules = { "shop.*": "shop_restored.*", "crm.a": "crm.b" };
    const text = renameRulesToText(rules);
    expect(text).toBe("shop.*=shop_restored.*\ncrm.a=crm.b");
    expect(parseRenameRules(text)).toEqual(rules);
  });
});

describe("targetNamespace", () => {
  const rules = { "shop.*": "shop_restored.*", "shop.users": "shop.people" };

  it("prefers an exact rule over the whole-database rule", () => {
    expect(targetNamespace("shop.users", rules)).toBe("shop.people");
    expect(targetNamespace("shop.orders.2026", rules)).toBe("shop_restored.orders.2026");
  });

  it("keeps namespaces no rule matches", () => {
    expect(targetNamespace("crm.leads", rules)).toBe("crm.leads");
    expect(targetNamespace("crm.leads", {})).toBe("crm.leads");
  });
});
