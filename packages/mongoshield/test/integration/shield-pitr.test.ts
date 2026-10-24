/**
 * Point-in-time recovery through the public API: `shield.restore({ backup: "latest",
 * at })` and `mongoshield restore --at`, against the shared test replica set.
 *
 * The story: a converge base backup via `shield.backup`, the change journal running,
 * a workload, a recorded cluster time T, then a "disaster" (deleteMany). Restoring to
 * T must give, byte for byte, the source as a snapshot read at T saw it. Also: a dry
 * run names the base backup, `at` with an explicit backup id is refused, and pruning
 * removes old journal segments but never the newest one.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { setTimeout as sleep } from "node:timers/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { CliIo } from "../../src/cli/io.ts";
import { runCli } from "../../src/cli/run.ts";
import { readClusterTime } from "../../src/engine/converge-time.ts";
import type { ClusterTime } from "../../src/format/manifest.ts";
import { loadJournalCoverage } from "../../src/journal/index.ts";
import { MongoShield } from "../../src/shield.ts";
import { fileStorage } from "../../src/storage/file.ts";
import { mongoUri, uniqueDb, useMongoClient } from "../helpers/mongo.ts";
import { collectionNames, firstDifference, rawDocuments } from "./converge-test-utils.ts";
import { startTestJournal, waitForJournalToCatchUp } from "./journal-test-utils.ts";

const client = useMongoClient();
const source = uniqueDb("spitr_src");
const viaApi = uniqueDb("spitr_api");
const viaCli = uniqueDb("spitr_cli");

let workDir: string;
let storageDir: string;
let shield: MongoShield;
/** The id of the base backup taken while the journal ran. */
let baseId: string;
/** The last good moment, just before the disaster. */
let beforeDisaster: ClusterTime;
/** The source as a snapshot read at `beforeDisaster` saw it, by collection. */
const expected = new Map<string, Buffer[]>();

interface User {
  _id: number;
  name: string;
  visits?: number;
  tags?: string[];
}

beforeAll(async () => {
  workDir = await mkdtemp(join(tmpdir(), "mongoshield-shield-pitr-"));
  storageDir = join(workDir, "backups");
  const storage = fileStorage({ path: storageDir });
  shield = new MongoShield({ source: { uri: mongoUri() }, storage });

  const users = client().db(source).collection<User>("users");
  const orders = client().db(source).collection<{ _id: number; qty: number }>("orders");
  await users.insertMany(
    Array.from({ length: 40 }, (_, n) => ({ _id: n, name: `user ${n}`, visits: n, tags: ["a"] })),
  );
  await users.createIndex({ name: 1 }, { unique: true });
  await orders.insertMany(Array.from({ length: 20 }, (_, n) => ({ _id: n, qty: n })));

  const journal = await startTestJournal(client(), storage, source);
  try {
    // Something journaled before the base backup, so pruning has old segments to remove.
    await users.updateOne({ _id: 0 }, { $set: { name: "first" } });
    await sleep(1100);
    const base = await shield.backup({ include: [`${source}.*`], consistency: "converge" });
    baseId = base.id;

    // The workload after the base backup, across a few 1 s journal segments.
    await users.insertOne({ _id: 100, name: "new" });
    await users.updateOne({ _id: 1 }, { $inc: { visits: 5 }, $push: { tags: "b" } });
    await sleep(1100);
    await users.deleteOne({ _id: 2 });
    await orders.updateMany({ qty: { $lt: 5 } }, { $set: { qty: 0 } });
    await client()
      .db(source)
      .collection<{ _id: number; kind: string }>("events")
      .insertOne({ _id: 1, kind: "created after the base backup" });
    await sleep(1100);
    await users.replaceOne({ _id: 3 }, { name: "replaced" });

    beforeDisaster = await readClusterTime(client());
    // The disaster, and writes after it that a restore to T must not contain.
    await users.deleteMany({});
    await orders.insertOne({ _id: 999, qty: -1 });
    await waitForJournalToCatchUp(client(), storage);
  } finally {
    await journal.stop();
  }

  for (const name of await collectionNames(client(), source)) {
    expected.set(name, await rawDocuments(client(), source, name, beforeDisaster));
  }
});

afterAll(async () => {
  await shield?.close();
  for (const database of [source, viaApi, viaCli]) await client().db(database).dropDatabase();
  if (workDir !== undefined) await rm(workDir, { recursive: true, force: true });
});

/** Checks that `database` holds exactly what the source held at `beforeDisaster`. */
async function expectSnapshotAtT(database: string): Promise<void> {
  expect(await collectionNames(client(), database)).toEqual([...expected.keys()]);
  for (const [name, documents] of expected) {
    const actual = await rawDocuments(client(), database, name);
    expect(firstDifference(documents, actual), `${database}.${name}`).toBeUndefined();
  }
}

/** Runs the CLI like a script: no terminal, empty environment, collected output. */
async function cli(args: readonly string[]) {
  let stdout = "";
  let stderr = "";
  const sink = (append: (text: string) => void) =>
    new Writable({
      write(chunk: Buffer | string, _encoding, done) {
        append(chunk.toString());
        done();
      },
    });
  const io: CliIo = {
    stdout: sink((text) => {
      stdout += text;
    }),
    stderr: sink((text) => {
      stderr += text;
    }),
    env: {},
    cwd: workDir,
    isTTY: false,
  };
  const code = await runCli(args, io);
  return { code, stdout, stderr };
}

/** `--at` as an exact cluster time, the `t:i` form `journal status` prints. */
function atFlag(time: ClusterTime): string {
  return `${time.t}:${time.i}`;
}

describe("shield.restore with at", () => {
  it("restores the base backup plus the journal up to T, exactly", async () => {
    expect([...expected.keys()]).toEqual(["events", "orders", "users"]);
    const result = await shield.restore({
      backup: "latest",
      at: beforeDisaster,
      target: { uri: mongoUri() },
      rename: { [`${source}.*`]: `${viaApi}.*` },
    });

    expect(result.pointInTime).toMatchObject({ baseBackupId: baseId, restoredTo: beforeDisaster });
    expect(result.pointInTime?.events).toBeGreaterThan(0);
    await expectSnapshotAtT(viaApi);
    // The base restore's indexes survive the replay.
    const indexes = await client().db(viaApi).collection("users").indexes();
    expect(indexes.some((index) => index.unique === true)).toBe(true);
  });

  it("names the base backup and writes nothing in a dry run", async () => {
    const target = uniqueDb("spitr_dry");
    const result = await shield.restore({
      backup: "latest",
      at: beforeDisaster,
      dryRun: true,
      rename: { [`${source}.*`]: `${target}.*` },
    });
    expect(result.dryRun).toBe(true);
    expect(result.pointInTime).toMatchObject({ baseBackupId: baseId, events: 0 });
    expect(await collectionNames(client(), target)).toEqual([]);
  });

  it("refuses an explicit backup id together with at", async () => {
    await expect(
      shield.restore({
        backup: baseId,
        at: beforeDisaster,
        rename: { [`${source}.*`]: `${uniqueDb("spitr_bad")}.*` },
      }),
    ).rejects.toMatchObject({ code: "MS_CONFIG_INVALID" });
  });
});

describe("mongoshield restore --at", () => {
  it("prints the base backup in a dry run and writes nothing", async () => {
    const target = uniqueDb("spitr_cli_dry");
    const run = await cli([
      "restore",
      "--from",
      storageDir,
      "--to-uri",
      mongoUri(),
      "--at",
      atFlag(beforeDisaster),
      "--rename",
      `${source}.*=${target}.*`,
      "--dry-run",
    ]);
    expect(run.code, run.stderr).toBe(0);
    expect(`${run.stdout}${run.stderr}`).toContain(`base backup ${baseId}`);
    expect(await collectionNames(client(), target)).toEqual([]);
  });

  it("restores to T, exactly", async () => {
    const run = await cli([
      "restore",
      "--from",
      storageDir,
      "--to-uri",
      mongoUri(),
      "--at",
      atFlag(beforeDisaster),
      "--rename",
      `${source}.*=${viaCli}.*`,
    ]);
    expect(run.code, run.stderr).toBe(0);
    await expectSnapshotAtT(viaCli);
  });

  it("refuses a backup id next to --at", async () => {
    const run = await cli([
      "restore",
      baseId,
      "--from",
      storageDir,
      "--to-uri",
      mongoUri(),
      "--at",
      atFlag(beforeDisaster),
    ]);
    expect(run.code).toBe(2);
    expect(run.stderr).toContain("--at picks its base backup itself");
  });
});

describe("shield.prune with a journal", () => {
  it("removes journal segments older than the oldest kept base backup, but never the newest", async () => {
    const before = await loadJournalCoverage(shield.storage);
    expect(before.segments.length).toBeGreaterThan(1);
    const newest = before.segments.at(-1);

    // A second base backup after the journal stopped: once the first backup is pruned,
    // every journaled segment ends before the oldest base and could be removed.
    await shield.backup({ include: [`${source}.*`], consistency: "converge" });
    const result = await shield.prune({ last: 1 });
    expect(result.deletedBackups).toBe(1);

    const after = await loadJournalCoverage(shield.storage);
    expect(after.segments.map((segment) => segment.key)).toEqual([newest?.key]);
  });
});
