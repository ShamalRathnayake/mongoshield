/**
 * `GET /metrics`: the Prometheus text format itself (every family has HELP and
 * TYPE before its samples, every sample line parses, label values are escaped),
 * the job and backup gauges, and the journal's recovery point, both from a real
 * journal writer against the test replica set and from stubbed journal readers
 * (failures, locations without a journal, caching).
 */

import { MongoClient } from "mongodb";
import { type JournalStatus, startJournal } from "mongoshield";
import { afterEach, describe, expect, it } from "vitest";
import type { JournalStatusReader } from "../../src/server/routes/health.ts";
import {
  mongoUri,
  removeDataDir,
  type StartOptions,
  seed,
  setupAdmin,
  startConsole,
  type TestConsole,
  uniqueDb,
  waitForJob,
} from "../helpers/console.ts";

const METRICS_TOKEN = "metrics-token-0123456789abcdef01234567";
const opened: TestConsole[] = [];

afterEach(async () => {
  for (const testConsole of opened.splice(0)) {
    await testConsole.close().catch(() => undefined);
    await removeDataDir(testConsole.dataDir);
  }
});

async function open(options: StartOptions = {}): Promise<TestConsole> {
  const testConsole = await startConsole({
    ...options,
    settings: { metricsToken: METRICS_TOKEN, ...options.settings },
  });
  opened.push(testConsole);
  return testConsole;
}

async function scrape(testConsole: TestConsole): Promise<string> {
  const response = await testConsole.client().request("GET", "/metrics", undefined, {
    headers: { authorization: `Bearer ${METRICS_TOKEN}` },
  });
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toBe("text/plain; version=0.0.4; charset=utf-8");
  return response.text;
}

/** A sample line: `name{label="value",...} number`. Label values may hold escaped quotes. */
const SAMPLE =
  /^([a-z_:][a-z0-9_:]*)(\{(?:[a-z_][a-z0-9_]*="(?:[^"\\\n]|\\["\\n])*",?)*\})? (-?\d+(?:\.\d+)?(?:e[+-]?\d+)?)$/;

/**
 * Checks the exposition format and returns the samples by family. Every family
 * must be announced by `# HELP` and `# TYPE … gauge` before any of its samples,
 * and appear once.
 */
function parseExposition(text: string): Map<string, string[]> {
  expect(text.endsWith("\n")).toBe(true);
  const families = new Map<string, string[]>();
  let current: string | undefined;
  for (const line of text.trimEnd().split("\n")) {
    const help = /^# HELP ([a-z_]+) \S.*$/.exec(line);
    if (help !== null) {
      const name = help[1] ?? "";
      expect(families.has(name), `${name} announced twice`).toBe(false);
      families.set(name, []);
      current = undefined;
      continue;
    }
    const type = /^# TYPE ([a-z_]+) gauge$/.exec(line);
    if (type !== null) {
      expect(families.has(type[1] ?? ""), `TYPE before HELP for ${type[1]}`).toBe(true);
      current = type[1];
      continue;
    }
    const sample = SAMPLE.exec(line);
    expect(sample, `not a sample line: ${line}`).not.toBeNull();
    expect(sample?.[1], `sample outside its family: ${line}`).toBe(current);
    families.get(current ?? "")?.push(line);
  }
  return families;
}

/** A journal status for stubs. */
function status(overrides: Partial<JournalStatus> = {}): JournalStatus {
  return {
    recoveryPoint: { t: 1_793_000_000, i: 1 },
    recoveryPointDate: new Date(1_793_000_000_000),
    rpoMs: 42_500,
    coveredRanges: [],
    gaps: [],
    segments: 3,
    bytes: 1234,
    lastCommit: undefined,
    uncommittedSegments: 0,
    ...overrides,
  };
}

describe("the exposition format", () => {
  it("announces every family, even without samples", async () => {
    const families = parseExposition(await scrape(await open()));
    expect([...families.keys()]).toEqual([
      "mongoshield_console_jobs",
      "mongoshield_console_jobs_running",
      "mongoshield_backup_last_success_timestamp_seconds",
      "mongoshield_backup_last_duration_seconds",
      "mongoshield_recovery_point_timestamp_seconds",
      "mongoshield_journal_rpo_seconds",
      "mongoshield_journal_gaps",
      "mongoshield_journal_status_ok",
    ]);
    expect(families.get("mongoshield_console_jobs_running")).toEqual([
      "mongoshield_console_jobs_running 0",
    ]);
  });

  it("reports jobs and the last backup of each plan, with escaped label values", async () => {
    const testConsole = await open();
    const admin = await setupAdmin(testConsole);
    const db = uniqueDb("metrics");
    await seed(db, "items", 3);
    const connection = await admin.request("POST", "/api/connections", {
      name: "src",
      uri: mongoUri(),
      production: false,
    });
    const storage = await admin.request("POST", "/api/storage", {
      name: "mem",
      url: `memory://${uniqueDb("metrics-store")}`,
    });
    // Quotes and backslashes are legal in names and must not break the label syntax.
    const name = 'nightly "eu" \\ main';
    const plan = await admin.request("POST", "/api/plans", {
      name,
      connectionId: connection.body.id,
      storageId: storage.body.id,
      include: [`${db}.*`],
      exclude: [],
      compression: "none",
      encryption: { kind: "none" },
      consistency: "auto",
      verify: "none",
      notify: [],
    });
    const run = await admin.request("POST", `/api/plans/${plan.body.id}/run`);
    const job = await waitForJob(testConsole, run.body.id);
    expect(job.status).toBe("succeeded");

    const families = parseExposition(await scrape(testConsole));
    expect(families.get("mongoshield_console_jobs")).toEqual([
      'mongoshield_console_jobs{kind="backup",status="succeeded"} 1',
    ]);
    const escaped = 'plan="nightly \\"eu\\" \\\\ main"';
    expect(families.get("mongoshield_backup_last_success_timestamp_seconds")).toEqual([
      `mongoshield_backup_last_success_timestamp_seconds{${escaped}} ${Date.parse(job.finishedAt ?? "") / 1000}`,
    ]);
    const [duration] = families.get("mongoshield_backup_last_duration_seconds") ?? [];
    expect(duration).toMatch(
      new RegExp(
        `^mongoshield_backup_last_duration_seconds\\{${escaped.replaceAll("\\", "\\\\")}\\} \\d+(\\.\\d+)?$`,
      ),
    );
  });
});

describe("the journal's recovery point", () => {
  it("reports the recovery point and RPO of a real journal", async () => {
    const testConsole = await open();
    const admin = await setupAdmin(testConsole);
    const db = uniqueDb("journal");
    await seed(db, "items", 2);
    await admin.request("POST", "/api/storage", {
      name: "journaled",
      url: `memory://${uniqueDb("jstore")}`,
    });
    await admin.request("POST", "/api/storage", {
      name: "plain",
      url: `memory://${uniqueDb("plain")}`,
    });
    const record = testConsole.services.store.current.storage[0];
    if (record === undefined) throw new Error("storage missing");
    const storage = await testConsole.services.storage.adapterFor(record);

    const client = new MongoClient(mongoUri());
    await client.connect();
    const journal = await startJournal({
      client,
      storage,
      include: [`${db}.*`],
      segmentSeconds: 1,
      retryDelayMs: 100,
      leaseMs: 10_000,
    });
    try {
      await client
        .db(db)
        .collection("items")
        .insertOne({ _id: 100 } as never);
      const deadline = Date.now() + 30_000;
      let text = "";
      while (Date.now() < deadline) {
        // Move the console's clock past the metrics cache between attempts.
        testConsole.clock.advance(31_000);
        text = await scrape(testConsole);
        if (text.includes("mongoshield_recovery_point_timestamp_seconds{")) break;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      const families = parseExposition(text);
      const [point] = families.get("mongoshield_recovery_point_timestamp_seconds") ?? [];
      expect(point).toMatch(
        /^mongoshield_recovery_point_timestamp_seconds\{storage="journaled"\} \d+$/,
      );
      const seconds = Number(point?.split(" ")[1]);
      expect(Math.abs(seconds - Date.now() / 1000)).toBeLessThan(120);
      expect(families.get("mongoshield_journal_rpo_seconds")?.[0]).toMatch(
        /^mongoshield_journal_rpo_seconds\{storage="journaled"\} \d/,
      );
      expect(families.get("mongoshield_journal_gaps")).toEqual([
        'mongoshield_journal_gaps{storage="journaled"} 0',
      ]);
      // The location without a journal is not reported at all.
      expect(families.get("mongoshield_journal_status_ok")).toEqual([
        'mongoshield_journal_status_ok{storage="journaled"} 1',
      ]);
    } finally {
      await journal.stop();
      await client.close();
    }
  });

  it("reports unreadable journals as status_ok 0, caches readings and refreshes them later", async () => {
    let calls = 0;
    const reader: JournalStatusReader = async (storage) => {
      calls++;
      const name = storage.location;
      if (name.includes("broken")) throw new Error("access denied");
      if (name.includes("empty"))
        return status({
          recoveryPoint: undefined,
          recoveryPointDate: undefined,
          rpoMs: undefined,
          segments: 0,
        });
      if (name.includes("gappy")) {
        return status({
          gaps: [{} as JournalStatus["gaps"][number], {} as JournalStatus["gaps"][number]],
          rpoMs: undefined,
          recoveryPointDate: undefined,
        });
      }
      return status();
    };
    const testConsole = await open({ app: { readJournalStatus: reader } });
    const admin = await setupAdmin(testConsole);
    for (const name of ["healthy", "broken", "empty", "gappy"]) {
      await admin.request("POST", "/api/storage", { name, url: `memory://${name}-${uniqueDb()}` });
    }

    const families = parseExposition(await scrape(testConsole));
    expect(families.get("mongoshield_recovery_point_timestamp_seconds")).toEqual([
      'mongoshield_recovery_point_timestamp_seconds{storage="healthy"} 1793000000',
    ]);
    expect(families.get("mongoshield_journal_rpo_seconds")).toEqual([
      'mongoshield_journal_rpo_seconds{storage="healthy"} 42.5',
    ]);
    expect(families.get("mongoshield_journal_gaps")).toEqual([
      'mongoshield_journal_gaps{storage="healthy"} 0',
      'mongoshield_journal_gaps{storage="gappy"} 2',
    ]);
    expect(families.get("mongoshield_journal_status_ok")).toEqual([
      'mongoshield_journal_status_ok{storage="healthy"} 1',
      'mongoshield_journal_status_ok{storage="broken"} 0',
      'mongoshield_journal_status_ok{storage="gappy"} 1',
    ]);
    expect(calls).toBe(4);

    await scrape(testConsole);
    expect(calls).toBe(4);
    testConsole.clock.advance(30_000);
    await scrape(testConsole);
    expect(calls).toBe(8);
  });
});
