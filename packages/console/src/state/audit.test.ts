/**
 * Tests for the audit log: append-only JSON lines, paging backwards, rotation
 * and reading files that contain torn or foreign lines.
 */

import { appendFile, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AuditEntry } from "../shared/api.ts";
import { AuditLog } from "./audit.ts";

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

async function log(maxBytes?: number): Promise<AuditLog> {
  const dataDir = await mkdtemp(join(tmpdir(), "ms-audit-"));
  directories.push(dataDir);
  return new AuditLog({ dataDir, ...(maxBytes === undefined ? {} : { maxBytes }) });
}

function entry(index: number): AuditEntry {
  return {
    at: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
    actor: "ada",
    action: "test.action",
    target: `t${index}`,
    outcome: "success",
  };
}

describe("AuditLog", () => {
  it("appends JSON lines (mode 0600) and reads them newest first", async () => {
    const audit = await log();
    for (let index = 0; index < 5; index++) await audit.append(entry(index));
    const lines = (await readFile(audit.pathOf(), "utf8")).trim().split("\n");
    expect(lines).toHaveLength(5);
    expect((await stat(audit.pathOf())).mode & 0o777).toBe(0o600);
    const read = await audit.read({ limit: 3 });
    expect(read.map((item) => item.target)).toEqual(["t4", "t3", "t2"]);
  });

  it("pages backwards with `before`", async () => {
    const audit = await log();
    for (let index = 0; index < 5; index++) await audit.append(entry(index));
    const page = await audit.read({ limit: 10, before: entry(2).at });
    expect(page.map((item) => item.target)).toEqual(["t1", "t0"]);
  });

  it("rotates past the size limit and still reads across files", async () => {
    const audit = await log(400);
    for (let index = 0; index < 12; index++) await audit.append(entry(index));
    expect((await stat(audit.pathOf())).size).toBeLessThanOrEqual(400);
    expect((await stat(audit.pathOf(1))).size).toBeGreaterThan(0);
    const all = await audit.read({ limit: 100 });
    expect(all[0]?.target).toBe("t11");
    expect(all.length).toBeGreaterThanOrEqual(8);
  });

  it("reads long logs across chunk boundaries with multi-byte characters", async () => {
    const audit = await log();
    for (let index = 0; index < 150; index++) {
      await audit.append({ ...entry(index), details: { note: `ünïcødé ${"x".repeat(1000)}` } });
    }
    const all = await audit.read({ limit: 1000 });
    expect(all).toHaveLength(150);
    expect(all.every((item) => item.details?.note?.toString().startsWith("ünïcødé"))).toBe(true);
  });

  it("skips torn and foreign lines when reading", async () => {
    const audit = await log();
    await audit.append(entry(0));
    await appendFile(
      audit.pathOf(),
      '{"at": "2026-01-01T00:00:00Z", "act\n[1, 2]\n{"no": "fields"}\n',
    );
    await audit.append(entry(1));
    const read = await audit.read({ limit: 10 });
    expect(read.map((item) => item.target)).toEqual(["t1", "t0"]);
  });

  it("reads an empty history when nothing was written yet", async () => {
    const audit = await log();
    expect(await audit.read({ limit: 10 })).toEqual([]);
  });

  it("keeps three rotated files and drops the oldest", async () => {
    const audit = await log(150);
    for (let index = 0; index < 20; index++) await audit.append(entry(index));
    await expect(stat(audit.pathOf(3))).resolves.toBeDefined();
    await expect(stat(audit.pathOf(4))).rejects.toMatchObject({ code: "ENOENT" });
    const all = await audit.read({ limit: 100 });
    expect(all[0]?.target).toBe("t19");
    // Entries older than the third rotation are gone.
    expect(all.some((item) => item.target === "t0")).toBe(false);
  });
});
