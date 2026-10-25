// `mongoshield import` and `mongoshield export`, driven like the real CLI does it
// (parseCommandLine → CommandContext → run → reportError), with in-memory streams
// and file storage in a temporary directory. The commands are run from their specs
// directly, so these tests do not depend on how the command registry lists them.

import { createReadStream } from "node:fs";
import { cp, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { BSON, Timestamp } from "mongodb";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseCommandLine } from "../../src/cli/args.ts";
import type { CommandContext, CommandSpec } from "../../src/cli/command.ts";
import { exportCommand } from "../../src/cli/commands/export.ts";
import { importCommand } from "../../src/cli/commands/import.ts";
import { type CliIo, Output } from "../../src/cli/io.ts";
import { reportError } from "../../src/cli/report-error.ts";
import type { ArchiveEvent } from "../../src/interop/archive-format.ts";
import { createArchiveReader } from "../../src/interop/archive-reader.ts";

const FIXTURES = fileURLToPath(new URL("../fixtures/mongodump/", import.meta.url));

let workDir: string;

beforeAll(async () => {
  workDir = await mkdtemp(join(tmpdir(), "mongoshield-interop-cli-"));
});

afterAll(async () => {
  await rm(workDir, { recursive: true, force: true });
});

/** What one command run printed and returned. */
interface CommandRun {
  readonly code: number;
  readonly stdout: Buffer;
  readonly stderr: string;
}

/** Collects everything written to it. */
function sink(): { stream: Writable; bytes: () => Buffer } {
  const chunks: Buffer[] = [];
  const stream = new Writable({
    write(chunk: Buffer | string, _encoding, done) {
      chunks.push(Buffer.from(chunk));
      done();
    },
  });
  return { stream, bytes: () => Buffer.concat(chunks) };
}

/** Runs one command the way `runCli` does, without a terminal and with an empty environment. */
async function runCommand(
  command: CommandSpec,
  args: readonly string[],
  stdin?: Readable,
): Promise<CommandRun> {
  const stdout = sink();
  const stderr = sink();
  const io: CliIo = {
    stdout: stdout.stream,
    stderr: stderr.stream,
    env: {},
    cwd: workDir,
    isTTY: false,
    ...(stdin ? { stdin } : {}),
  };
  let out = new Output(io, { json: false, quiet: false, verbose: false, color: false });
  const secrets: string[] = [];
  let code: number;
  try {
    const parsed = parseCommandLine(
      args,
      command.name,
      command.options,
      command.positionals?.length ?? 0,
    );
    out = new Output(io, {
      json: parsed.global.json,
      quiet: parsed.global.quiet,
      verbose: parsed.global.verbose,
      color: false,
    });
    const context: CommandContext = {
      io,
      out,
      global: parsed.global,
      flags: parsed.flags,
      positionals: parsed.positionals,
      signal: new AbortController().signal,
      addSecret: (secret) => secrets.push(secret),
    };
    code = await command.run(context);
  } catch (error) {
    code = reportError(error, out, secrets);
  }
  return { code, stdout: stdout.bytes(), stderr: stderr.bytes().toString("utf8") };
}

async function archiveEvents(bytes: Buffer): Promise<ArchiveEvent[]> {
  const events: ArchiveEvent[] = [];
  await pipeline(
    [bytes],
    createArchiveReader(),
    new Writable({
      objectMode: true,
      write(event: ArchiveEvent, _encoding, done) {
        events.push(event);
        done();
      },
    }),
  );
  return events;
}

describe("mongoshield import", () => {
  it("imports a dump directory and prints the new backup id with --quiet", async () => {
    const run = await runCommand(importCommand, [
      join(FIXTURES, "dump"),
      "--to",
      "./backups",
      "--quiet",
    ]);
    expect(run.code).toBe(0);
    expect(run.stdout.toString().trim()).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z_[0-9a-f]{6}$/,
    );
    // The time-series collection is imported (its buckets unpacked): nothing is left out.
    expect(run.stderr).not.toContain("Not imported");
  });

  it("warns about what it does not import, and shows the consistency", async () => {
    const dump = join(workDir, "dump-with-profile");
    await cp(join(FIXTURES, "dump"), dump, { recursive: true });
    await cp(join(FIXTURES, "dump", "app", "users.bson"), join(dump, "app", "system.profile.bson"));
    const run = await runCommand(importCommand, [dump, "--to", "./profile-backups"]);
    expect(run.code).toBe(0);
    expect(run.stderr).toContain("Not imported: app.system.profile: system collections");
    expect(run.stdout.toString()).toMatch(/Consistency\s+none/);
  });

  it("replays the oplog of a mongodump --oplog directory, or leaves it out with --ignore-oplog", async () => {
    const dump = join(workDir, "dump-with-oplog");
    await cp(join(FIXTURES, "dump"), dump, { recursive: true });
    const entry = BSON.serialize({
      ts: new Timestamp({ t: 1_792_521_200, i: 1 }),
      op: "i",
      ns: "app.users",
      o: { _id: "late", name: "c" },
    });
    await writeFile(join(dump, "oplog.bson"), entry);
    const replayed = await runCommand(importCommand, [dump, "--to", "./oplog-backups"]);
    expect(replayed.code).toBe(0);
    expect(replayed.stdout.toString()).toContain("converge (oplog: 1 change replayed on restore)");
    const ignored = await runCommand(importCommand, [
      dump,
      "--to",
      "./oplog-backups",
      "--ignore-oplog",
    ]);
    expect(ignored.code).toBe(0);
    expect(ignored.stderr).toContain("ignoreOplog");
    expect(ignored.stdout.toString()).toMatch(/Consistency\s+none/);
  });

  it("detects an archive file by itself and prints the result as JSON", async () => {
    const run = await runCommand(importCommand, [
      join(FIXTURES, "app.archive.gz"),
      "--to",
      "./archive-backups",
      "--label",
      "env=test",
      "--json",
    ]);
    expect(run.code).toBe(0);
    const result = JSON.parse(run.stdout.toString()) as {
      manifest: { labels: Record<string, string> };
    };
    expect(result.manifest.labels).toEqual({ "imported-from": "mongodump@100.16.0", env: "test" });
  });

  it('reads an archive from stdin with "-" and --archive', async () => {
    const run = await runCommand(
      importCommand,
      ["-", "--archive", "--to", "./stdin-backups", "--quiet"],
      createReadStream(join(FIXTURES, "app.archive")),
    );
    expect(run.code).toBe(0);
  });

  it("fails with a usage error for a missing path", async () => {
    const run = await runCommand(importCommand, [join(workDir, "nope"), "--to", "./backups"]);
    expect(run.code).toBe(2);
    expect(run.stderr).toContain("Cannot read");
  });
});

describe("mongoshield export", () => {
  let backupId: string;

  beforeAll(async () => {
    const run = await runCommand(importCommand, [
      join(FIXTURES, "dump"),
      "--to",
      "./export-source",
      "--quiet",
    ]);
    backupId = run.stdout.toString().trim();
  });

  it("writes a dump directory and says how to restore it", async () => {
    const run = await runCommand(exportCommand, [
      backupId,
      "--from",
      "./export-source",
      "--output",
      "./dump-out",
    ]);
    expect(run.code).toBe(0);
    expect(await readdir(join(workDir, "dump-out", "app"))).toContain("users.bson");
    expect(run.stderr).toContain("mongorestore --uri <target> --dir");
  });

  it("streams an archive to stdout with --output -, keeping stdout clean", async () => {
    const run = await runCommand(exportCommand, [
      "latest",
      "--from",
      "./export-source",
      "--format",
      "archive",
      "--output",
      "-",
    ]);
    expect(run.code).toBe(0);
    const events = await archiveEvents(run.stdout);
    expect(events.filter((event) => event.kind === "namespaceEnd")).toHaveLength(6);
  });

  it("refuses to stream a directory to stdout", async () => {
    const run = await runCommand(exportCommand, ["--from", "./export-source", "--output", "-"]);
    expect(run.code).toBe(2);
    expect(run.stderr).toContain("--format archive");
  });

  it("requires --output", async () => {
    const run = await runCommand(exportCommand, ["--from", "./export-source"]);
    expect(run.code).toBe(2);
  });
});
