// Unit tests for loading drill assertions files (drill-assertions-file.ts): both
// accepted shapes of the default export, and the files that are refused.

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isMongoShieldError } from "../errors.ts";
import { loadDrillAssertionsFile } from "./drill-assertions-file.ts";

let directory: string;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "mongoshield-assertions-"));
});

afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});

/** Writes an assertions file and returns its name (relative to `directory`). */
async function file(name: string, source: string): Promise<string> {
  await writeFile(join(directory, name), source, "utf8");
  return name;
}

async function refusal(path: string): Promise<string> {
  const error = await loadDrillAssertionsFile(path, directory).catch((caught: unknown) => caught);
  if (!isMongoShieldError(error, "MS_CONFIG_INVALID"))
    throw new Error(`expected a refusal: ${String(error)}`);
  return error.message;
}

describe("loadDrillAssertionsFile", () => {
  it("loads one function, or an object of functions per database, from a relative path", async () => {
    const one = await loadDrillAssertionsFile(
      await file("one.ts", "export default async (db: unknown) => {};"),
      directory,
    );
    expect(typeof one).toBe("function");
    const perDatabase = await loadDrillAssertionsFile(
      join(
        directory,
        await file("many.ts", "export default { app: async () => {}, billing: () => {} };"),
      ),
      "/elsewhere",
    );
    expect(Object.keys(perDatabase)).toEqual(["app", "billing"]);
  });

  it("refuses missing files, values that are not functions, and other exports", async () => {
    expect(await refusal("missing.ts")).toContain("Could not load the assertions file");
    expect(await refusal(await file("bad-entry.ts", "export default { app: 5 };"))).toContain(
      '"app" is not a function',
    );
    expect(await refusal(await file("number.ts", "export default 42;"))).toContain(
      "neither a function nor an object",
    );
  });
});
