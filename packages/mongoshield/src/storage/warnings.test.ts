import { describe, expect, it } from "vitest";
import { memoryStorage } from "./memory.ts";
import { storageWarnings } from "./warnings.ts";

describe("storageWarnings", () => {
  it("returns nothing for an adapter without a warnings method", () => {
    expect(storageWarnings(memoryStorage())).toEqual([]);
  });

  it("returns the strings an adapter reports, calling it as a method", () => {
    const base = memoryStorage();
    const adapter = {
      ...base,
      prefix: "OneDrive: ",
      warnings(this: { prefix: string }) {
        return [`${this.prefix}sign-in is 80 days old`, 42];
      },
    };
    expect(storageWarnings(adapter)).toEqual(["OneDrive: sign-in is 80 days old"]);
  });

  it("ignores a warnings method that does not return an array", () => {
    const adapter = { ...memoryStorage(), warnings: () => "nope" };
    expect(storageWarnings(adapter)).toEqual([]);
  });
});
