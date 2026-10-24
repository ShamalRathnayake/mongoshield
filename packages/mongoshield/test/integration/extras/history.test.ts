// Document history (src/extras/history.ts) on a real replica set: a journal records
// every change while three snapshot backups are taken between edits of one document.
// The history must show the document as each backup holds it, every journaled change
// to it (and none to other documents), newest first; and the CLI prints the diffs.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { runBackup } from "../../../src/engine/backup.ts";
import { documentHistory, type HistoryVersion } from "../../../src/extras/history.ts";
import { silentLogger } from "../../../src/logger.ts";
import { fileStorage } from "../../../src/storage/file.ts";
import type { StorageAdapter } from "../../../src/storage/types.ts";
import { uniqueDb, useMongoClient } from "../../helpers/mongo.ts";
import { backupContext } from "../backup-test-utils.ts";
import { startTestJournal, waitForJournalToCatchUp } from "../journal-test-utils.ts";
import { runTestCli } from "./cli-utils.ts";

vi.mock("../../../src/cli/commands/index.ts", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../../src/cli/commands/index.ts")>();
  const { historyCommand } = await import("../../../src/cli/commands/history.ts");
  const commands = [
    ...original.COMMANDS.filter((command) => command.name !== "history"),
    historyCommand,
  ];
  return {
    COMMANDS: commands,
    findCommand: (name: string) => commands.find((command) => command.name === name),
  };
});

const client = useMongoClient();

interface User {
  _id: number;
  name: string;
  city?: string;
}

let workDir: string;
let storageDir: string;
let storage: StorageAdapter;
let database: string;

/** What the tests compare: the kind of each version and the name it shows. */
function summary(versions: readonly HistoryVersion[]): string[] {
  return versions.map((version) => {
    if (version.kind === "backup") {
      return `backup:${version.state}:${String(version.document?.name ?? "-")}`;
    }
    const name =
      version.document?.name ?? version.updatedFields?.name ?? version.updatedFields?.city;
    return `${version.operationType}:${String(name ?? "-")}`;
  });
}

beforeAll(async () => {
  workDir = await mkdtemp(join(tmpdir(), "mongoshield-history-"));
  storageDir = join(workDir, "backups");
  storage = fileStorage({ path: storageDir });
  database = uniqueDb("history");
  const users = client().db(database).collection<User>("users");
  await users.insertMany([
    { _id: 7, name: "v1" },
    { _id: 8, name: "bystander" },
  ]);

  const journal = await startTestJournal(client(), storage, database);
  try {
    const backup = () =>
      runBackup(backupContext(client(), storage), {
        include: [`${database}.*`],
        consistency: "snapshot",
      });
    await backup();
    await users.updateOne({ _id: 7 }, { $set: { name: "v2" } });
    await users.updateOne({ _id: 8 }, { $set: { name: "bystander 2" } });
    await backup();
    await users.updateOne({ _id: 7 }, { $set: { city: "Oslo" } });
    await users.deleteOne({ _id: 7 });
    await users.insertOne({ _id: 7, name: "v4" });
    await backup();
    await users.updateOne({ _id: 7 }, { $set: { name: "v5" } });
    await waitForJournalToCatchUp(client(), storage);
  } finally {
    await journal.stop();
  }
}, 120_000);

afterAll(async () => {
  await client().db(database).dropDatabase();
  await rm(workDir, { recursive: true, force: true });
});

describe("documentHistory", () => {
  it("merges every backup's version and every journaled change, newest first", async () => {
    const history = await documentHistory(
      { storage, logger: silentLogger },
      { namespace: `${database}.users`, id: 7 },
    );
    expect(history.backupsSearched).toBe(3);
    expect(history.journal.status).toBe("read");
    expect(summary(history.versions)).toEqual([
      "update:v5",
      "backup:present:v4",
      "insert:v4",
      "delete:-",
      "update:Oslo",
      "backup:present:v2",
      "update:v2",
      "backup:present:v1",
    ]);
  });

  it("limits the backups searched and can leave the journal out", async () => {
    const history = await documentHistory(
      { storage, logger: silentLogger },
      { namespace: `${database}.users`, id: 7, backups: 2, journal: false },
    );
    expect(history.journal.status).toBe("disabled");
    expect(summary(history.versions)).toEqual(["backup:present:v4", "backup:present:v2"]);
  });

  it("reports a document no backup holds as absent", async () => {
    const history = await documentHistory(
      { storage, logger: silentLogger },
      { namespace: `${database}.users`, id: 999 },
    );
    expect(summary(history.versions)).toEqual([
      "backup:absent:-",
      "backup:absent:-",
      "backup:absent:-",
    ]);
  });
});

describe("mongoshield history", () => {
  it("prints each version with what changed since the one before", async () => {
    const run = await runTestCli(
      ["history", `${database}.users`, "7", "--from", storageDir],
      workDir,
    );
    expect(run.code).toBe(0);
    expect(run.stdout).toContain('~ name: "v1" → "v2"');
    expect(run.stdout).toContain("(first known version)");
    expect(run.stdout).toContain('~ name: "v5"');
    expect(run.stderr).toContain("Searched 3 backups");
  });

  it("explains an _id that is not Extended JSON", async () => {
    const run = await runTestCli(
      ["history", `${database}.users`, "ada", "--from", storageDir],
      workDir,
    );
    expect(run.code).toBe(2);
    expect(run.stderr).toContain("Extended JSON");
  });
});
