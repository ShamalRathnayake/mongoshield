/**
 * Scheduled runs against the shared test replica set: `mongoshield run` end to
 * end (with a config file, notifications and a heartbeat), runners racing for
 * the same storage, the guard with the real backup engine, and the MongoDB lock.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { readDrills } from "../../src/catalog/annotations.ts";
import { listBackups } from "../../src/catalog/catalog.ts";
import { parseCommandLine } from "../../src/cli/args.ts";
import type { CommandContext, CommandSpec } from "../../src/cli/command.ts";
import { runCommand } from "../../src/cli/commands/run.ts";
import { scheduleCommand } from "../../src/cli/commands/schedule.ts";
import { type CliIo, Output } from "../../src/cli/io.ts";
import { reportError } from "../../src/cli/report-error.ts";
import type { MongoShieldConfig } from "../../src/config/schema.ts";
import { createLockOwner } from "../../src/schedule/lock.ts";
import {
  MONGO_LOCK_COLLECTION,
  MONGO_LOCK_DATABASE,
  mongoLock,
} from "../../src/schedule/lock-mongo.ts";
import type { RunReport } from "../../src/schedule/report.ts";
import { runScheduledJob, type ScheduledShield } from "../../src/schedule/runner.ts";
import { MongoShield } from "../../src/shield.ts";
import { fileStorage } from "../../src/storage/file.ts";
import { mongoUri, uniqueDb, useMongoClient } from "../helpers/mongo.ts";

const client = useMongoClient();

let workDir: string;
let server: Server;
let hookUrl: string;
let received: { path: string; body: string }[] = [];

beforeAll(async () => {
  workDir = await mkdtemp(join(tmpdir(), "mongoshield-schedule-"));
  server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk: Buffer) => {
      body += chunk.toString();
    });
    request.on("end", () => {
      received.push({ path: request.url ?? "", body });
      response.end("ok");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  hookUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await rm(workDir, { recursive: true, force: true });
});

beforeEach(() => {
  received = [];
});

/** Seeds `count` users into a fresh database and returns its name. */
async function seededDb(count = 100): Promise<string> {
  const dbName = uniqueDb("sched");
  await client()
    .db(dbName)
    .collection("users")
    .insertMany(Array.from({ length: count }, (_, index) => ({ n: index })));
  return dbName;
}

/** A shield over file storage in `dir`. */
function shieldFor(dir: string): MongoShield {
  return new MongoShield({
    source: { uri: mongoUri() },
    storage: fileStorage({ path: dir }),
    compression: "gzip",
  });
}

/** Runs one CLI command spec the way `runCli` would, without the command registry. */
async function runSpec(command: CommandSpec, args: readonly string[], signal?: AbortSignal) {
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
  const parsed = parseCommandLine(args, command.name, command.options, 0);
  const out = new Output(io, {
    json: parsed.global.json,
    quiet: false,
    verbose: false,
    color: false,
  });
  const context: CommandContext = {
    io,
    out,
    global: parsed.global,
    flags: parsed.flags,
    positionals: parsed.positionals,
    signal: signal ?? new AbortController().signal,
    addSecret: () => {},
  };
  let code: number;
  try {
    code = await command.run(context);
  } catch (error) {
    code = reportError(error, out, []);
  }
  return { code, stdout, stderr };
}

describe("mongoshield run", () => {
  it("backs up, verifies, prunes, notifies and pings the heartbeat", async () => {
    const dbName = await seededDb();
    const storage = await mkdtemp(join(workDir, "storage-"));
    const configFile = join(workDir, `${dbName}.config.mjs`);
    await writeFile(
      configFile,
      `export default ${JSON.stringify({
        source: { uri: mongoUri() },
        storage,
        compression: "gzip",
        backup: { include: [`${dbName}.*`] },
        retention: { last: 1 },
        schedule: { cron: "15 3 * * *", verify: "deep" },
        guard: { maxDocumentDropPercent: 50 },
        notify: [{ type: "webhook", url: `${hookUrl}/hook`, on: ["success", "failure"] }],
        heartbeat: `${hookUrl}/heartbeat`,
      })};\n`,
    );

    const first = await runSpec(runCommand, ["--config", configFile, "--json"]);
    expect(first.code, first.stderr).toBe(0);
    const report = JSON.parse(first.stdout) as RunReport;
    expect(report).toMatchObject({
      status: "success",
      backup: { documents: 100 },
      verify: { mode: "deep", ok: true },
      guard: { ok: true },
    });
    expect(received.map((request) => request.path).sort()).toEqual(["/heartbeat", "/hook"]);
    const webhook = JSON.parse(received.find((request) => request.path === "/hook")?.body ?? "{}");
    expect(webhook).toMatchObject({ event: "backup.success", report: { runId: report.runId } });

    // A second run prunes the first backup (retention: last 1).
    const second = await runSpec(runCommand, ["--config", configFile, "--json"]);
    expect(second.code, second.stderr).toBe(0);
    expect(JSON.parse(second.stdout)).toMatchObject({
      status: "success",
      prune: { deletedBackups: 1 },
    });
    expect(await listBackups(fileStorage({ path: storage }))).toHaveLength(1);

    // Most of the data disappears: the guard refuses the backup, the run fails
    // with the guard's exit code, and the failure is reported.
    await client()
      .db(dbName)
      .collection("users")
      .deleteMany({ n: { $gte: 10 } });
    received = [];
    const third = await runSpec(runCommand, ["--config", configFile, "--json"]);
    expect(third.code).toBe(34);
    expect(JSON.parse(third.stdout)).toMatchObject({
      status: "failure",
      error: { step: "backup", code: "MS_GUARD_FAILED" },
      guard: { ok: false, findings: [{ ns: `${dbName}.users` }] },
    });
    expect(received.map((request) => request.path).sort()).toEqual(["/heartbeat/fail", "/hook"]);
    const remaining = await listBackups(fileStorage({ path: storage }));
    expect(remaining.map((backup) => backup.manifest?.totals.documents)).toEqual([100]);
  });
});

describe("mongoshield schedule", () => {
  it("prints the next run times and exits cleanly when stopped", async () => {
    const storage = await mkdtemp(join(workDir, "schedule-"));
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 200);
    const run = await runSpec(
      scheduleCommand,
      ["--uri", mongoUri(), "--to", storage, "--cron", "15 3 * * *", "--timezone", "Europe/Berlin"],
      controller.signal,
    );
    expect(run.code, run.stderr).toBe(0);
    expect(run.stderr).toContain("Schedule: 15 3 * * * (Europe/Berlin). Next runs:");
    expect(run.stderr).toContain("Scheduler stopped.");
  });

  it("explains that a schedule is needed", async () => {
    const run = await runSpec(scheduleCommand, ["--uri", mongoUri(), "--to", workDir]);
    expect(run.code).toBe(2);
    expect(run.stderr).toContain("No schedule is configured");
  });
});

/**
 * A real shield whose drills may target the deployment the backup came from: the
 * tests have only one replica set, and the same-deployment guard (tested in
 * drill.test.ts) would otherwise refuse every scheduled drill.
 */
function drillingShield(shield: MongoShield): ScheduledShield {
  return {
    storage: shield.storage,
    backup: (options) => shield.backup(options),
    verify: (options) => shield.verify(options),
    prune: (policy, options) => shield.prune(policy, options),
    drill: (options) => shield.drill({ ...options, allowSameDeployment: true }),
  };
}

describe("scheduled drills (schedule.verify: drill)", () => {
  it("restores the new backup into the scratch deployment, runs the assertions and reports the RTO", async () => {
    const dbName = await seededDb(30);
    const storage = await mkdtemp(join(workDir, "drill-"));
    const prefix = `sd${Date.now().toString(36)}_`;
    await writeFile(
      join(workDir, `${dbName}.checks.mjs`),
      `export default { ${JSON.stringify(dbName)}: async (db) => {
        const users = await db.collection("users").countDocuments();
        if (users !== 30) throw new Error("saw " + users + " users");
      } };\n`,
    );
    const config: MongoShieldConfig = {
      storage,
      backup: { include: [`${dbName}.*`] },
      schedule: { cron: "15 3 * * *", verify: "drill" },
      drill: { targetUri: mongoUri(), sample: 5, prefix, assertions: `${dbName}.checks.mjs` },
      notify: [{ type: "webhook", url: `${hookUrl}/hook`, on: ["success"] }],
    };

    const shield = shieldFor(storage);
    try {
      const report = await runScheduledJob(drillingShield(shield), config, { cwd: workDir });
      expect(report.error).toBeUndefined();
      expect(report.status).toBe("success");
      expect(report.verify).toMatchObject({ mode: "drill", ok: true, problems: [] });
      expect(report.verify?.rtoMs).toEqual(expect.any(Number));

      // The drill was recorded next to the backup, and its databases are gone.
      const drills = await readDrills(shield.storage, report.backup?.id ?? "");
      expect(drills).toHaveLength(1);
      expect(drills[0]).toMatchObject({ ok: true, restoreDurationMs: report.verify?.rtoMs });
      const { databases } = await client().db().admin().listDatabases({ nameOnly: true });
      expect(databases.filter((database) => database.name.startsWith(prefix))).toEqual([]);

      // Webhook bodies carry the RTO too.
      const webhook = JSON.parse(
        received.find((request) => request.path === "/hook")?.body ?? "{}",
      );
      expect(webhook.report.verify).toMatchObject({ mode: "drill", rtoMs: report.verify?.rtoMs });
    } finally {
      await shield.close();
    }
  });

  it("fails the run with MS_INTEGRITY_FAILED when an assertion fails", async () => {
    const dbName = await seededDb(5);
    const storage = await mkdtemp(join(workDir, "drill-fail-"));
    await writeFile(
      join(workDir, `${dbName}.fail.mjs`),
      'export default async () => { throw new Error("nobody home"); };\n',
    );
    const shield = shieldFor(storage);
    try {
      const report = await runScheduledJob(
        drillingShield(shield),
        {
          storage,
          backup: { include: [`${dbName}.*`] },
          schedule: { cron: "15 3 * * *", verify: "drill" },
          drill: { targetUri: mongoUri(), assertions: join(workDir, `${dbName}.fail.mjs`) },
        },
        {},
      );
      expect(report.status).toBe("failure");
      expect(report.error).toMatchObject({ step: "verify", code: "MS_INTEGRITY_FAILED" });
      expect(report.verify?.ok).toBe(false);
      expect(report.verify?.problems.map((problem) => problem.problem)).toContain("nobody home");
    } finally {
      await shield.close();
    }
  });
});

describe("runners racing for the same storage", () => {
  it("produces exactly one backup", async () => {
    const dbName = await seededDb(20);
    const storage = await mkdtemp(join(workDir, "race-"));
    const config: MongoShieldConfig = {
      storage,
      backup: { include: [`${dbName}.*`] },
      schedule: { cron: "* * * * *", verify: "fast" },
    };

    const shields = [shieldFor(storage), shieldFor(storage), shieldFor(storage)];
    const reports = await Promise.all(shields.map((shield) => runScheduledJob(shield, config)));
    await Promise.all(shields.map((shield) => shield.close()));

    expect(reports.map((report) => report.status).sort()).toEqual([
      "skipped",
      "skipped",
      "success",
    ]);
    expect(await listBackups(fileStorage({ path: storage }))).toHaveLength(1);
  });
});

describe("the MongoDB lock", () => {
  const locks = () => client().db(MONGO_LOCK_DATABASE).collection(MONGO_LOCK_COLLECTION);

  // Leave no `mongoshield` database behind for tests that back up everything.
  afterAll(async () => {
    await client().db(MONGO_LOCK_DATABASE).dropDatabase();
  });

  it("lets exactly one of several concurrent runners acquire it", async () => {
    const name = `t-${uniqueDb()}`;
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        mongoLock({
          client: client(),
          owner: createLockOwner(),
          leaseMs: 60_000,
          name,
        }).tryAcquire(),
      ),
    );
    expect(results.filter((result) => result.acquired)).toHaveLength(1);
    const winner = results.find((result) => result.acquired);
    const loser = results.find((result) => !result.acquired);
    if (winner?.acquired && loser && !loser.acquired) {
      expect(loser.holder?.owner).toBe(winner.lease.info.owner);
      await winner.lease.release();
    }
    expect(await locks().countDocuments({ _id: name as never })).toBe(0);
  });

  it("is taken over after the lease expires, and the old holder learns it lost", async () => {
    const name = `t-${uniqueDb()}`;
    const first = await mongoLock({
      client: client(),
      owner: createLockOwner(),
      leaseMs: 200,
      name,
    }).tryAcquire();
    expect(first.acquired).toBe(true);
    const busy = await mongoLock({
      client: client(),
      owner: createLockOwner(),
      leaseMs: 200,
      name,
    }).tryAcquire();
    expect(busy.acquired).toBe(false);

    await new Promise((resolve) => setTimeout(resolve, 300));
    const second = await mongoLock({
      client: client(),
      owner: createLockOwner(),
      leaseMs: 60_000,
      name,
    }).tryAcquire();
    expect(second.acquired).toBe(true);
    if (first.acquired) expect(await first.lease.renew()).toBe("lost");
    if (second.acquired) {
      expect(await second.lease.renew()).toBe("renewed");
      await second.lease.release();
    }
  });

  it("serializes scheduled runs that use it", async () => {
    const dbName = await seededDb(10);
    const storage = await mkdtemp(join(workDir, "mongo-lock-"));
    const config: MongoShieldConfig = {
      source: { uri: mongoUri() },
      storage,
      backup: { include: [`${dbName}.*`] },
      schedule: { cron: "* * * * *", lock: "mongo", verify: "none" },
    };
    const shields = [shieldFor(storage), shieldFor(storage)];
    const reports = await Promise.all(shields.map((shield) => runScheduledJob(shield, config)));
    await Promise.all(shields.map((shield) => shield.close()));
    expect(reports.map((report) => report.status).sort()).toEqual(["skipped", "success"]);
    expect(await locks().countDocuments({ _id: "backup" as never })).toBe(0);
  });
});
