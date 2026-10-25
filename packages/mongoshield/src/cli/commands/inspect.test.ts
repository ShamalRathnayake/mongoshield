// `mongoshield inspect` against an in-memory store: every line of the summary
// (warnings, encryption, labels, verification, hold, write-once lock) and the drill history.

import { describe, expect, it } from "vitest";
import { writeTestBackup } from "../../../test/helpers/backup-fixtures.ts";
import { runTestCli } from "../../../test/helpers/cli.ts";
import {
  namedMemoryStore,
  rewriteManifest,
  writeDrillRecord,
} from "../../../test/helpers/cli-backups.ts";
import { generateIdentity } from "../../crypto/index.ts";

const HOUR = 3_600_000;

describe("mongoshield inspect", () => {
  it("shows a plain backup: no labels, never verified, never drilled, no hold, not locked", async () => {
    const { url, storage } = await namedMemoryStore();
    const manifest = await writeTestBackup(storage, {
      namespaces: [
        { ns: "app.users", documents: [{ _id: 1 }, { _id: 2 }] },
        { ns: "app.orders", documents: [{ _id: 1 }] },
      ],
    });
    const run = await runTestCli(["inspect", "--from", url]);
    expect(run.code, run.stderr).toBe(0);
    expect(run.stdout).toContain(`Backup id    ${manifest.id}`);
    expect(run.stdout).toContain("Encryption   no");
    expect(run.stdout).toMatch(/Labels\s+–/);
    expect(run.stdout).toContain("never (run: mongoshield verify)");
    expect(run.stdout).toContain("never (run: mongoshield drill)");
    expect(run.stdout).toMatch(/Hold\s+–/);
    expect(run.stdout).toContain("no (files can be deleted by prune or by hand)");
    expect(run.stdout).toMatch(/NAMESPACE\s+TYPE\s+DOCUMENTS/);
    expect(run.stdout).toMatch(/app\.users\s+collection\s+2/);
    expect(run.stdout).not.toContain("DRILLED");
  });

  it("shows warnings, recipients, labels, verification, the hold, the lock and every drill", async () => {
    const { url, storage } = await namedMemoryStore();
    const { recipient } = generateIdentity();
    const written = await writeTestBackup(storage, {
      namespaces: [{ ns: "app.users", documents: [{ _id: 1 }] }],
      recipients: [recipient],
    });
    await rewriteManifest(storage, written, {
      consistency: { mode: "none", warning: "Writes during the backup may be missing." },
      labels: { env: "prod", team: "core" },
      immutableUntil: new Date(Date.now() + 48 * HOUR).toISOString(),
    });
    await writeDrillRecord(storage, {
      backupId: written.id,
      drilledAt: new Date(Date.now() - 2 * HOUR).toISOString(),
      ok: false,
      restored: false,
      restoreDurationMs: 0,
      durationMs: 10,
      namespaces: 1,
      documentsRestored: 0,
      problemCount: 2,
    });
    await writeDrillRecord(storage, {
      backupId: written.id,
      drilledAt: new Date(Date.now() - HOUR).toISOString(),
      ok: true,
      restored: true,
      restoreDurationMs: 1234,
      durationMs: 2000,
      namespaces: 1,
      documentsRestored: 1,
      problemCount: 0,
    });
    // A real verification record and hold, through the CLI.
    expect((await runTestCli(["verify", written.id, "--from", url])).code).toBe(0);
    await runTestCli(["hold", written.id, "--reason", "audit", "--by", "bob", "--from", url]);

    const run = await runTestCli(["inspect", written.id, "--from", url]);
    expect(run.code, run.stderr).toBe(0);
    const out = run.stdout;
    expect(out).toContain("Writes during the backup may be missing.");
    expect(out).toContain(recipient);
    expect(out).toContain("env=prod, team=core");
    expect(out).toMatch(/Verified\s+.*\(\d+ files, 0 documents, 0 problems\)/);
    expect(out).toMatch(/Hold\s+held since .* by bob: audit/);
    expect(out).toMatch(/Immutable\s+locked until /);

    // The drill history, newest first: passed (with its RTO), then failed (no RTO).
    const drillLines = out.slice(out.indexOf("DRILLED")).split("\n");
    expect(drillLines[0]).toMatch(/DRILLED\s+RESULT\s+RTO\s+DOCUMENTS\s+PROBLEMS/);
    expect(drillLines[1]).toMatch(/1h ago\s+passed\s+1s\s+1\s+0/);
    expect(drillLines[2]).toMatch(/2h ago\s+failed\s+–\s+0\s+2/);
  });

  it("says when a write-once lock has expired, and holds without --by", async () => {
    const { url, storage } = await namedMemoryStore();
    const written = await writeTestBackup(storage, {
      namespaces: [{ ns: "app.users", documents: [{ _id: 1 }] }],
    });
    await rewriteManifest(storage, written, {
      immutableUntil: new Date(Date.now() - HOUR).toISOString(),
    });
    await storage.put(
      `annotations/${written.id}/hold.json`,
      Buffer.from(
        JSON.stringify({ backupId: written.id, heldAt: new Date().toISOString(), reason: "x" }),
      ),
      {},
    );
    const run = await runTestCli(["inspect", "latest", "--from", url]);
    expect(run.code, run.stderr).toBe(0);
    expect(run.stdout).toMatch(/Immutable\s+lock expired until /);
    expect(run.stdout).toMatch(/Hold\s+held since .*\(just now\): x$/m);
  });

  it("prints the entry and all drills as one JSON document", async () => {
    const { url, storage } = await namedMemoryStore();
    const written = await writeTestBackup(storage, {
      namespaces: [{ ns: "app.users", documents: [{ _id: 1 }] }],
    });
    await writeDrillRecord(storage, {
      backupId: written.id,
      drilledAt: new Date().toISOString(),
      ok: true,
      restored: true,
      restoreDurationMs: 5,
      durationMs: 5,
      namespaces: 1,
      documentsRestored: 1,
      problemCount: 0,
    });
    const run = await runTestCli(["inspect", "--from", url, "--json"]);
    expect(run.code).toBe(0);
    const entry = run.json<{ id: string; manifest: { id: string }; drills: unknown[] }>();
    expect(entry.id).toBe(written.id);
    expect(entry.manifest.id).toBe(written.id);
    expect(entry.drills).toHaveLength(1);
  });

  it("fails clearly when there is no backup, and for an unknown id (exit code 30)", async () => {
    const { url } = await namedMemoryStore();
    const none = await runTestCli(["inspect", "--from", url]);
    expect(none.code).not.toBe(0);
    expect(none.stderr).toContain("hint");

    const malformed = await runTestCli(["inspect", "not-an-id", "--from", url]);
    expect(malformed.code, malformed.stderr).toBe(30);
    expect(malformed.stderr).toContain(
      'MS_BACKUP_NOT_FOUND  No backup with id "not-an-id" exists.',
    );
  });

  it("marks upgrade rehearsals with the version they proved", async () => {
    const { url, storage } = await namedMemoryStore();
    const written = await writeTestBackup(storage, {
      namespaces: [{ ns: "app.users", documents: [{ _id: 1 }] }],
    });
    const drill = {
      backupId: written.id,
      ok: true,
      restored: true,
      restoreDurationMs: 2000,
      durationMs: 3000,
      namespaces: 1,
      documentsRestored: 1,
      problemCount: 0,
    };
    await writeDrillRecord(storage, {
      ...drill,
      drilledAt: new Date(Date.now() - 2 * HOUR).toISOString(),
    });
    await writeDrillRecord(storage, {
      ...drill,
      drilledAt: new Date(Date.now() - HOUR).toISOString(),
      targetVersion: "8.0.13",
      sourceVersion: "7.0.32",
      compatibility: { problems: 0, warnings: 1 },
    });

    const run = await runTestCli(["inspect", written.id, "--from", url]);
    expect(run.code, run.stderr).toBe(0);
    expect(run.stdout).toMatch(
      /Last drill\s+upgrade rehearsal on MongoDB 8\.0\.13 ✓ \(RTO 2s\) 1h ago/,
    );
    const drillLines = run.stdout.slice(run.stdout.indexOf("DRILLED")).split("\n");
    expect(drillLines[0]).toMatch(/DRILLED\s+RESULT\s+MONGODB\s+RTO\s+DOCUMENTS\s+PROBLEMS/);
    expect(drillLines[1]).toMatch(/1h ago\s+passed\s+→ 8\.0\.13\s+2s/);
    expect(drillLines[2]).toMatch(/2h ago\s+passed\s+–\s+2s/);

    const json = await runTestCli(["inspect", written.id, "--from", url, "--json"]);
    const parsed = JSON.parse(json.stdout) as { drills: { targetVersion?: string }[] };
    expect(parsed.drills.map((record) => record.targetVersion)).toEqual(["8.0.13", undefined]);
  });
});
