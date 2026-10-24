import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadMaskFile, loadSubsetFile } from "./load-file.ts";

let directory: string;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "mongoshield-load-file-"));
});

afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe("loadMaskFile", () => {
  it("loads a TypeScript mask file with custom functions, relative to the working directory", async () => {
    await writeFile(
      join(directory, "mask.ts"),
      [
        "const shout = (value: unknown): unknown => String(value).toUpperCase();",
        "export default {",
        "  secret: 'from-the-file-0123456789',",
        "  rules: { 'app.users': { email: { fake: 'email' }, name: shout } },",
        "};",
      ].join("\n"),
    );
    const mask = await loadMaskFile("mask.ts", directory);
    expect(mask.secret).toBe("from-the-file-0123456789");
    const nameRule = mask.rules["app.users"]?.name;
    expect(typeof nameRule === "function" && nameRule("ada", undefined as never)).toBe("ADA");
  });

  it("explains a missing file, a broken file and a file without rules", async () => {
    await expect(loadMaskFile("missing.ts", directory)).rejects.toThrow(/does not exist/);
    await writeFile(join(directory, "broken.ts"), "export default {");
    await expect(loadMaskFile("broken.ts", directory)).rejects.toThrow(
      /Could not load the mask file/,
    );
    await writeFile(join(directory, "empty.ts"), "export default { secret: 'x' };");
    await expect(loadMaskFile("empty.ts", directory)).rejects.toThrow(/no `rules` object/);
  });
});

describe("loadSubsetFile", () => {
  it("loads filters with dates and follow rules", async () => {
    await writeFile(
      join(directory, "subset.ts"),
      [
        "export default {",
        "  filters: { 'app.orders': { createdAt: { $gte: new Date('2026-01-01') } } },",
        "  follow: [{ from: 'app.orders.userId', to: 'app.users._id' }],",
        "};",
      ].join("\n"),
    );
    const subset = await loadSubsetFile(join(directory, "subset.ts"), "/");
    expect(subset.filters?.["app.orders"]?.createdAt.$gte).toBeInstanceOf(Date);
    expect(subset.follow).toHaveLength(1);
  });

  it("rejects a file with neither filters nor follow rules", async () => {
    await writeFile(join(directory, "nothing.ts"), "export default { batchSize: 5 };");
    await expect(loadSubsetFile("nothing.ts", directory)).rejects.toThrow(
      /neither `filters` nor `follow`/,
    );
  });
});
