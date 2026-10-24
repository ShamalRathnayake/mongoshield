import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Int32, Long } from "mongodb";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { silentLogger } from "../logger.ts";
import {
  CheckpointFile,
  canonicalFilters,
  copyFingerprint,
  fingerprintDifferences,
  newCopyCheckpoint,
  partBound,
  readCopyCheckpoint,
  storedBound,
  subsetForResume,
} from "./copy-checkpoint.ts";
import { resumeStateOf } from "./copy-plan.ts";

let directory: string;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "mongoshield-copy-checkpoint-"));
});

afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});

const SECRET = "a checkpoint test secret, long enough";

describe("copyFingerprint", () => {
  it("ignores pattern order but notices every option that shapes the copy", () => {
    const base = copyFingerprint({
      include: ["b.*", "a.*"],
      mask: { secret: SECRET, rules: { "a.users": { email: "hash", name: (value) => value } } },
      subset: { follow: [{ from: "a.orders.userId", to: "a.users._id" }] },
    });
    expect(base.include).toEqual(["a.*", "b.*"]);
    expect(JSON.stringify(base)).not.toContain(SECRET);
    expect(fingerprintDifferences(base, copyFingerprint({ include: ["a.*", "b.*"] }))).toEqual([
      "the mask rules or secret",
      "the subset's follow rules",
    ]);
    const changed = copyFingerprint({
      include: ["a.*"],
      exclude: ["a.tmp"],
      rename: { "a.*": "c.*" },
      mode: "drop",
      skipIndexes: true,
      mask: { rules: {} },
    });
    expect(fingerprintDifferences(base, changed)).toEqual([
      "--include",
      "--exclude",
      "--rename",
      "--mode",
      "the mask rules or secret",
      "the subset's follow rules",
      "--skip-indexes",
    ]);
  });

  it("tells mask secrets apart without storing them", () => {
    const rules = { "a.users": { email: "hash" as const } };
    const one = copyFingerprint({ mask: { secret: SECRET, rules } });
    const two = copyFingerprint({ mask: { secret: `${SECRET}!`, rules } });
    expect(one.mask).not.toBe(two.mask);
    expect(copyFingerprint({ mask: { secret: "", rules } }).mask).toBe(
      copyFingerprint({ mask: { rules } }).mask,
    );
  });
});

describe("subset filters across resumes", () => {
  it("reuses the first run's filters, with their exact BSON types, and says so when they differ", () => {
    const first = {
      filters: { "a.users": { age: { $gte: new Int32(18) }, id: Long.fromNumber(5) } },
    };
    const checkpoint = newCopyCheckpoint(copyFingerprint({}), canonicalFilters(first));
    const warnings: string[] = [];
    const logger = { ...silentLogger, warn: (message: string) => warnings.push(message) };

    const same = subsetForResume(first, checkpoint, logger);
    expect(same?.filters?.["a.users"]).toEqual(first.filters["a.users"]);
    expect(warnings).toEqual([]);

    const later = subsetForResume({ filters: { "a.users": { age: 30 } } }, checkpoint, logger);
    expect(later?.filters?.["a.users"]?.age.$gte).toBeInstanceOf(Int32);
    expect(warnings).toHaveLength(1);
  });

  it("keeps no subset when there was none", () => {
    const checkpoint = newCopyCheckpoint(copyFingerprint({}), canonicalFilters(undefined));
    expect(subsetForResume(undefined, checkpoint, silentLogger)).toBeUndefined();
    // A stored filter that is not a document is ignored.
    checkpoint.filters["a.users"] = 5;
    expect(subsetForResume(undefined, checkpoint, silentLogger)).toBeUndefined();
  });
});

describe("part bounds", () => {
  it("survive the checkpoint in their exact BSON types", () => {
    const stored = storedBound({ value: Long.fromString("9007199254740993") });
    const restored = partBound(JSON.parse(JSON.stringify(stored)));
    expect(restored?.value).toEqual(Long.fromString("9007199254740993"));
    expect(storedBound(undefined)).toBeNull();
    expect(partBound(null)).toBeUndefined();
  });
});

describe("readCopyCheckpoint", () => {
  it("returns nothing for a missing file and refuses files that are not checkpoints", async () => {
    expect(await readCopyCheckpoint(join(directory, "missing.json"))).toBeUndefined();
    const notJson = join(directory, "not-json.json");
    await writeFile(notJson, "{");
    await expect(readCopyCheckpoint(notJson)).rejects.toThrow(/is not a copy checkpoint/);
    const otherShape = join(directory, "other.json");
    await writeFile(otherShape, JSON.stringify({ format: "something-else" }));
    await expect(readCopyCheckpoint(otherShape)).rejects.toThrow(/is not a copy checkpoint/);
    await expect(readCopyCheckpoint(directory)).rejects.toThrow(/Cannot read the copy checkpoint/);
  });
});

describe("CheckpointFile", () => {
  it("writes the state owner-only, coalesces saves, and deletes the file at the end", async () => {
    const path = join(directory, "nested", "state.json");
    const file = new CheckpointFile(path, newCopyCheckpoint(copyFingerprint({}), {}), silentLogger);
    const state = file.namespace("a.users", () => ({
      from: "a.users",
      to: "b.users",
      type: "collection",
      action: "create",
      sourceUuid: null,
      targetUuid: null,
      prepared: false,
      ordered: false,
      parts: [],
      rootsDone: false,
      finished: false,
    }));
    expect(file.namespace("a.users", () => state)).toBe(state);
    state.prepared = true;
    for (let count = 0; count < 20; count += 1) file.save();
    await file.flush();
    const written = await readCopyCheckpoint(path);
    expect(written?.namespaces[0]?.prepared).toBe(true);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    await file.remove();
    await expect(readFile(path)).rejects.toThrow();
  });

  it("reports a checkpoint that cannot be written", async () => {
    const blocker = join(directory, "a-file");
    await writeFile(blocker, "");
    const file = new CheckpointFile(
      join(blocker, "state.json"),
      newCopyCheckpoint(copyFingerprint({}), {}),
      silentLogger,
    );
    await expect(file.flush()).rejects.toThrow(/Cannot write the copy checkpoint/);
  });

  it("logs instead of failing when the file cannot be deleted", async () => {
    const warnings: string[] = [];
    const logger = { ...silentLogger, warn: (message: string) => warnings.push(message) };
    const path = join(directory, "undeletable");
    await mkdir(join(path, "inside"), { recursive: true });
    // `rm` without `recursive` refuses a non-empty directory.
    const file = new CheckpointFile(path, newCopyCheckpoint(copyFingerprint({}), {}), logger);
    await file.remove();
    expect(warnings.join("")).toContain("Could not delete the copy checkpoint");
  });
});

describe("resumeStateOf", () => {
  const state = {
    from: "a.x",
    to: "b.x",
    type: "timeseries" as const,
    action: "create" as const,
    sourceUuid: null,
    targetUuid: null,
    prepared: true,
    ordered: false,
    parts: [],
    rootsDone: true,
    finished: false,
  };

  it("restarts unordered namespaces that cannot continue, and continues the rest", () => {
    expect(resumeStateOf(undefined, "all", false)).toBe("not-started");
    expect(resumeStateOf({ ...state, prepared: false }, "all", false)).toBe("not-started");
    expect(resumeStateOf({ ...state, finished: true }, "all", false)).toBe("done");
    expect(resumeStateOf({ ...state, rootsDone: false }, "all", true)).toBe("restart");
    expect(resumeStateOf(state, "referenced", false)).toBe("restart");
    expect(resumeStateOf(state, "filtered+referenced", true)).toBe("partial");
    expect(resumeStateOf(state, "all", false)).toBe("partial");
    expect(resumeStateOf({ ...state, ordered: true, rootsDone: false }, "all", false)).toBe(
      "partial",
    );
  });
});
