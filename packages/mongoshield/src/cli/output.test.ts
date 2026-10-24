// What the CLI shows: the Output rules (stdout vs stderr, --quiet/--json, the live
// line), progress on a terminal and in logs, tables, number and date formats, error
// reports (exit codes, hints, docs links, no secrets), and confirmations.

import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { writeTestBackup } from "../../test/helpers/backup-fixtures.ts";
import { collector, KEYS, plain, runTestCli } from "../../test/helpers/cli.ts";
import { cliBackupLabels } from "../../test/helpers/cli-backups.ts";
import { MongoShieldError } from "../errors.ts";
import { resolveStorage } from "../storage/resolve.ts";
import type { ProgressEvent } from "../types.ts";
import {
  compactNumber,
  formatBytes,
  formatCount,
  formatDateWithRelative,
  formatDuration,
  formatLocalDate,
  formatRate,
  formatRatio,
  formatRelative,
  plural,
} from "./format.ts";
import { type CliIo, Output, type OutputSettings } from "./io.ts";
import { ProgressDisplay } from "./progress.ts";
import { reportError, scrubSecrets, toMongoShieldError } from "./report-error.ts";
import { renderDetails, renderRows, renderTable } from "./table.ts";

/** An Output over in-memory streams, plus what was written to each. */
function testOutput(
  settings: Partial<OutputSettings> = {},
  io: Partial<Pick<CliIo, "isTTY" | "env" | "columns" | "stdin">> = {},
) {
  const stdout = collector();
  const stderr = collector();
  const out = new Output(
    {
      stdout: stdout.stream,
      stderr: stderr.stream,
      env: io.env ?? {},
      cwd: "/",
      isTTY: io.isTTY ?? false,
      ...(io.stdin ? { stdin: io.stdin } : {}),
      ...(io.columns ? { columns: io.columns } : {}),
    },
    { json: false, quiet: false, verbose: false, color: false, ...settings },
  );
  return { out, stdout: stdout.text, stderr: stderr.text };
}

const CLEAR_LINE = "\r\u001b[2K";

afterEach(() => {
  vi.useRealTimers();
});

describe("Output", () => {
  it("sends results to stdout and everything else to stderr", () => {
    const { out, stdout, stderr } = testOutput({ verbose: true });
    out.result("the result");
    out.result();
    out.info("status");
    out.success("done");
    out.warn("careful");
    out.debug("details");
    out.stderr("raw\n");
    expect(stdout()).toBe("the result\n\n");
    expect(stderr()).toBe("status\n✔ done\n▲ careful\ndebug details\nraw\n");
  });

  it("--quiet keeps results, warnings and errors only", () => {
    const { out, stdout, stderr } = testOutput({ quiet: true });
    out.result("the result");
    out.info("status");
    out.success("done");
    out.debug("details");
    out.warn("careful");
    expect(stdout()).toBe("the result\n");
    expect(stderr()).toBe("▲ careful\n");
  });

  it("--json silences text results; the JSON document handles BigInt and Error values", () => {
    const { out, stdout } = testOutput({ json: true });
    out.result("not shown");
    out.json({ big: 12n, error: new Error("boom"), when: new Date("2026-01-02T03:04:05Z") });
    expect(JSON.parse(stdout())).toEqual({
      big: "12",
      error: { name: "Error", message: "boom" },
      when: "2026-01-02T03:04:05.000Z",
    });
  });

  it("keeps the live progress line at the bottom while other lines print above it", () => {
    const { out, stderr } = testOutput({}, { isTTY: true });
    out.endLive(); // nothing drawn yet: no-op
    expect(stderr()).toBe("");
    out.live("50%");
    out.info("a status line");
    out.live("60%");
    out.endLive();
    out.endLive();
    expect(stderr()).toBe(
      `${CLEAR_LINE}50%${CLEAR_LINE}a status line\n50%${CLEAR_LINE}60%${CLEAR_LINE}`,
    );
  });

  it("is interactive only on a terminal with stdin, outside CI", () => {
    const stdin = collector().stream as unknown as NonNullable<CliIo["stdin"]>;
    expect(testOutput({}, { isTTY: true, stdin }).out.interactive).toBe(true);
    expect(testOutput({}, { isTTY: true }).out.interactive).toBe(false);
    expect(testOutput({}, { isTTY: false, stdin }).out.interactive).toBe(false);
    for (const value of ["true", "1", "yes"]) {
      expect(testOutput({}, { isTTY: true, stdin, env: { CI: value } }).out.interactive).toBe(
        false,
      );
    }
    for (const value of ["", "0", "false"]) {
      expect(testOutput({}, { isTTY: true, stdin, env: { CI: value } }).out.interactive).toBe(true);
    }
  });

  it("draws live progress only on a terminal, and not with --quiet or --json", () => {
    expect(testOutput({}, { isTTY: true }).out.liveProgress).toBe(true);
    expect(testOutput({}, { isTTY: false }).out.liveProgress).toBe(false);
    expect(testOutput({ quiet: true }, { isTTY: true }).out.liveProgress).toBe(false);
    expect(testOutput({ json: true }, { isTTY: true }).out.liveProgress).toBe(false);
  });

  it("knows the terminal width, with a default when unknown", () => {
    expect(testOutput({}, { columns: 42 }).out.columns).toBe(42);
    expect(testOutput().out.columns).toBe(100);
  });

  it("styles text only when colors are on, with one style or several", () => {
    const colored = testOutput({ color: true }).out;
    expect(colored.style("red", "x")).toBe("\u001b[31mx\u001b[39m");
    expect(plain(colored.style(["bold", "red"], "x"))).toBe("x");
    expect(colored.style(["bold", "red"], "x")).not.toBe("x");
    expect(testOutput().out.style("red", "x")).toBe("x");
  });
});

describe("ProgressDisplay", () => {
  const overall = (
    documents: number,
    estimatedDocuments: number,
    etaMs?: number,
  ): ProgressEvent => ({
    type: "overall",
    documents,
    estimatedDocuments,
    bytes: documents * 100,
    elapsedMs: 2000,
    etaMs,
  });

  it("on a terminal: one redrawn line with percent, counts, size, rate, ETA and namespace", () => {
    vi.useFakeTimers({ now: 0 });
    const { out, stderr } = testOutput({}, { isTTY: true, columns: 200 });
    const progress = new ProgressDisplay(out, "Backing up");
    expect(stderr()).toBe(`${CLEAR_LINE}⠋ Backing up…`);

    progress.onProgress({ type: "namespace:start", ns: "app.users", estimatedDocuments: 1000 });
    vi.setSystemTime(1000);
    progress.onProgress(overall(500, 1000, 4000));
    const line = stderr().split(CLEAR_LINE).at(-1);
    expect(line).toBe(
      "⠹ Backing up · 50% · 500/1,000 docs · 48.8 KiB · 250 docs/s · ETA 4.0s · app.users",
    );

    // Redraws are throttled to about ten a second.
    const before = stderr();
    vi.setSystemTime(1050);
    progress.onProgress(overall(600, 1000));
    expect(stderr()).toBe(before);

    // Per-namespace events change nothing on their own.
    vi.setSystemTime(1200);
    progress.onProgress({ type: "namespace:progress", ns: "app.users", documents: 1, bytes: 1 });
    progress.onProgress({ type: "namespace:done", ns: "app.users", documents: 1 });

    progress.stop();
    expect(stderr().endsWith(CLEAR_LINE)).toBe(true);
  });

  it("caps the percentage at 99% and shows –% without an estimate", () => {
    vi.useFakeTimers({ now: 0 });
    const { out, stderr } = testOutput({}, { isTTY: true, columns: 200 });
    const progress = new ProgressDisplay(out, "Restoring");
    vi.setSystemTime(1000);
    progress.onProgress(overall(1500, 1000));
    expect(stderr().split(CLEAR_LINE).at(-1)).toContain(" · 99% · ");
    vi.setSystemTime(2000);
    progress.onProgress(overall(10, 0));
    expect(stderr().split(CLEAR_LINE).at(-1)).toContain(" · –% · ");
  });

  it("cuts a line wider than the terminal, dropping its colors", () => {
    vi.useFakeTimers({ now: 0 });
    const { out, stderr } = testOutput({ color: true }, { isTTY: true, columns: 30 });
    const progress = new ProgressDisplay(out, "Backing up");
    progress.onProgress({
      type: "namespace:start",
      ns: "a_very_long_database.collection",
      estimatedDocuments: 2,
    });
    vi.setSystemTime(1000);
    progress.onProgress(overall(1, 2));
    const line = stderr().split(CLEAR_LINE).at(-1) ?? "";
    expect(line).toHaveLength(29);
    expect(line.endsWith("…")).toBe(true);
    expect(line).not.toContain("\u001b[");
  });

  it("in logs: a plain line at most every ten seconds", () => {
    vi.useFakeTimers({ now: 0 });
    const { out, stderr } = testOutput({}, { isTTY: false });
    const progress = new ProgressDisplay(out, "Verifying");
    expect(stderr()).toBe("");
    vi.setSystemTime(5000);
    progress.onProgress(overall(10, 100));
    expect(stderr()).toBe("");
    vi.setSystemTime(10_000);
    progress.onProgress(overall(20, 100, 65_000));
    expect(stderr()).toBe("Verifying: 20% (20/100 documents, 2.0 KiB, 10 docs/s, ETA 1m 05s)\n");
    vi.setSystemTime(15_000);
    progress.onProgress(overall(30, 100));
    expect(stderr().split("\n")).toHaveLength(2);
    vi.setSystemTime(21_000);
    progress.onProgress({
      type: "overall",
      documents: 40,
      estimatedDocuments: 100,
      bytes: 4000,
      elapsedMs: 0,
      etaMs: undefined,
    });
    expect(stderr()).toContain("Verifying: 40% (40/100 documents, 3.9 KiB, 0 docs/s)\n");
    progress.stop();
    expect(stderr()).not.toContain(CLEAR_LINE);
  });

  it("shows nothing with --quiet or --json", () => {
    vi.useFakeTimers({ now: 0 });
    for (const settings of [{ quiet: true }, { json: true }]) {
      const { out, stdout, stderr } = testOutput(settings, { isTTY: true });
      const progress = new ProgressDisplay(out, "Backing up");
      vi.setSystemTime(60_000);
      progress.onProgress(overall(1, 2));
      progress.stop();
      expect(stderr() + stdout()).toBe("");
    }
  });
});

describe("tables", () => {
  it("aligns columns on visible width, right-aligns numbers and trims trailing spaces", () => {
    const table = renderTable(
      [{ header: "NAME" }, { header: "COUNT", align: "right" }, { header: "NOTE" }],
      [
        ["\u001b[1mapp.users\u001b[22m", "1,204", ""],
        ["app.ü", "3", "naïve"],
      ],
    );
    expect(plain(table).split("\n")).toEqual([
      "NAME       COUNT  NOTE",
      "app.users  1,204",
      "app.ü          3  naïve",
    ]);
  });

  it("renders only the header for no rows, and styles headers after padding", () => {
    const table = renderTable(
      [{ header: "ID" }, { header: "SIZE", align: "right" }],
      [],
      (text) => `<${text}>`,
    );
    expect(table).toBe("<ID>  <SIZE>");
  });

  it("tolerates rows shorter than the header", () => {
    expect(renderTable([{ header: "A" }, { header: "B" }], [["only"]])).toBe("A     B\nonly");
  });

  it("renders header-less rows, and nothing for no rows", () => {
    expect(
      renderRows([
        ["a", "first"],
        ["longer", "second"],
      ]),
    ).toBe("a       first\nlonger  second");
    expect(renderRows([])).toBe("");
  });

  it("aligns detail labels", () => {
    expect(
      renderDetails([
        ["ID", "x"],
        ["Created", "y"],
      ]),
    ).toBe("ID       x\nCreated  y");
    expect(renderDetails([["ID", "x"]], (label) => `[${label}]`)).toBe("[ID]  x");
  });
});

describe("formats", () => {
  it("sizes in binary units", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(1023)).toBe("1023 B");
    expect(formatBytes(1536)).toBe("1.5 KiB");
    expect(formatBytes(5 * 1024 ** 3)).toBe("5.0 GiB");
    expect(formatBytes(2 * 1024 ** 6)).toBe("2048.0 PiB");
  });

  it("counts and plurals", () => {
    expect(formatCount(1_234_567)).toBe("1,234,567");
    expect(plural(1, "backup")).toBe("1 backup");
    expect(plural(2, "backup")).toBe("2 backups");
    expect(plural(2, "index", "indexes")).toBe("2 indexes");
  });

  it("durations", () => {
    expect(formatDuration(-5)).toBe("0ms");
    expect(formatDuration(850)).toBe("850ms");
    expect(formatDuration(12_300)).toBe("12.3s");
    expect(formatDuration(245_000)).toBe("4m 05s");
    expect(formatDuration(3_720_000)).toBe("1h 02m");
  });

  it("dates, local and relative", () => {
    const date = new Date(2026, 9, 20, 14, 3);
    expect(formatLocalDate(date)).toBe("2026-10-20 14:03");
    const now = new Date(2026, 9, 20, 17, 3);
    expect(formatDateWithRelative(date, now)).toBe("2026-10-20 14:03 (3h ago)");
    const at = (ms: number) => formatRelative(new Date(now.getTime() - ms), now);
    expect(at(5000)).toBe("just now");
    expect(at(30_000)).toBe("30s ago");
    expect(at(5 * 60_000)).toBe("5m ago");
    expect(at(3 * 86_400_000)).toBe("3d ago");
    expect(at(90 * 86_400_000)).toBe("3mo ago");
    expect(at(800 * 86_400_000)).toBe("2y ago");
    expect(at(-2 * 3_600_000)).toBe("in 2h");
    // The default "now" is the current time.
    expect(formatRelative(new Date())).toBe("just now");
    expect(formatDateWithRelative(new Date())).toMatch(/\(just now\)$/);
  });

  it("ratios, rates and compact numbers", () => {
    expect(formatRatio(42, 10)).toBe("4.2×");
    expect(formatRatio(42, 0)).toBe("–");
    expect(formatRate(4100, 1000, "docs")).toBe("4.1k docs/s");
    expect(formatRate(5, 0, "docs")).toBe("– docs/s");
    expect(compactNumber(12)).toBe("12");
    expect(compactNumber(2_300_000)).toBe("2.3M");
  });
});

describe("error reports", () => {
  it("prints code, message, hint and docs link, and returns the exit code", () => {
    const { out, stdout, stderr } = testOutput();
    const error = new MongoShieldError("MS_BACKUP_NOT_FOUND", "No backup 2026-x.", {
      hint: "Run `mongoshield list`.",
    });
    expect(reportError(error, out, [])).toBe(30);
    expect(stdout()).toBe("");
    expect(stderr()).toBe(
      [
        "✖ MS_BACKUP_NOT_FOUND  No backup 2026-x.",
        "  hint  Run `mongoshield list`.",
        `  docs  ${error.docsUrl}`,
        "",
      ].join("\n"),
    );
  });

  it("omits the hint line when there is none (also in JSON)", () => {
    const human = testOutput();
    reportError(new MongoShieldError("MS_ABORTED"), human.out, []);
    expect(human.stderr()).not.toContain("hint");

    const json = testOutput({ json: true });
    expect(reportError(new MongoShieldError("MS_ABORTED"), json.out, [])).toBe(60);
    expect(JSON.parse(json.stdout()).error).not.toHaveProperty("hint");
  });

  it("turns unexpected errors into MS_INTERNAL (exit code 71) asking for a bug report", () => {
    for (const thrown of [new TypeError("x is undefined"), "a string", undefined]) {
      const { out, stderr } = testOutput();
      expect(reportError(thrown, out, [])).toBe(71);
      expect(stderr()).toContain("✖ MS_INTERNAL  An unexpected internal error occurred.");
      expect(stderr()).toContain("Please report it at https://github.com/");
    }
    expect(toMongoShieldError(new TypeError("x")).message).toContain(" x");
  });

  it("never prints secrets: known secrets, URI passwords and secret query parameters", () => {
    const { out, stdout, stderr } = testOutput({ verbose: true });
    const error = new MongoShieldError(
      "MS_CONNECTION_FAILED",
      "Could not reach mongodb://app:hunter2@db:27017/x: refused; passphrase is tr0ub4dor",
      {
        hint: "Check mongodb+srv://cluster/?authSource=admin&password=letmein or tr0ub4dor.",
        cause: new Error("socket said tr0ub4dor"),
      },
    );
    reportError(error, out, ["tr0ub4dor"]);
    const printed = stdout() + stderr();
    expect(printed).not.toContain("hunter2");
    expect(printed).not.toContain("letmein");
    expect(printed).not.toContain("tr0ub4dor");
    // The verbose stack trace includes the cause, scrubbed too.
    expect(printed).toContain("caused by: Error: socket said");
  });

  it("leaves URIs without secrets and already redacted ones untouched, keeping punctuation", () => {
    const text =
      "See mongodb://db:27017/app?w=majority, then mongodb://app:***@db/x. Also (mongodb://h).";
    expect(scrubSecrets(text, [])).toBe(text);
  });

  it("shows non-Error causes in the verbose stack", () => {
    const { out, stderr } = testOutput({ verbose: true });
    reportError(new Error("outer", { cause: "plain cause" }), out, []);
    expect(stderr()).toContain("caused by: plain cause");
  });

  it("stops following a cause chain that loops", () => {
    const { out, stderr } = testOutput({ verbose: true });
    const first = new Error("first");
    const second = new Error("second", { cause: first });
    first.cause = second;
    reportError(first, out, []);
    expect(stderr().split("caused by:").length).toBeLessThanOrEqual(9);
  });
});

describe("confirmations (through `mongoshield prune`)", () => {
  /** Storage with three backups, of which `prune --last 1` deletes two. */
  async function storageWithThreeBackups(): Promise<string> {
    const url = `memory://cli-confirm-${randomBytes(4).toString("hex")}`;
    const storage = await resolveStorage(url);
    for (const hoursAgo of [3, 2, 1]) {
      await writeTestBackup(storage, {
        namespaces: [{ ns: "app.users", documents: [{ _id: hoursAgo }] }],
        startedAt: new Date(Date.now() - hoursAgo * 3_600_000),
        // As `mongoshield backup` labels them, so they are in prune's default scope.
        labels: cliBackupLabels(),
      });
    }
    return url;
  }

  const backupCount = async (url: string) => {
    const run = await runTestCli(["list", "--from", url, "--json"]);
    return run.json<unknown[]>().length;
  };

  it("refuses without a terminal (exit code 3), deleting nothing", async () => {
    const url = await storageWithThreeBackups();
    const run = await runTestCli(["prune", "--last", "1", "--from", url]);
    expect(run.code).toBe(3);
    expect(run.stderr).toContain(
      "Refusing to delete 2 backups without confirmation in a non-interactive session.",
    );
    expect(run.stderr).toContain("re-run with --yes");
    expect(run.stderr).toMatch(/docs {2}\S+#ms_confirmation_required/);
    expect(await backupCount(url)).toBe(3);
  });

  it("refuses in CI even on a terminal", async () => {
    const url = await storageWithThreeBackups();
    const run = await runTestCli(["prune", "--last", "1", "--from", url], {
      isTTY: true,
      env: { CI: "1" },
      terminal: [],
    });
    expect(run.code).toBe(3);
  });

  it("asks on a terminal; the default answer (Enter) is No: exit code 60, nothing deleted", async () => {
    const url = await storageWithThreeBackups();
    const run = await runTestCli(["prune", "--last", "1", "--from", url], {
      terminal: [{ when: "Permanently delete 2 backups", keys: KEYS.enter }],
    });
    expect(run.code).toBe(60);
    expect(plain(run.stderr)).toContain("Cancelled. Nothing was changed.");
    expect(await backupCount(url)).toBe(3);
  });

  it("Ctrl-C at the question cancels too", async () => {
    const url = await storageWithThreeBackups();
    const run = await runTestCli(["prune", "--last", "1", "--from", url], {
      terminal: [{ when: "Permanently delete 2 backups", keys: KEYS.ctrlC }],
    });
    expect(run.code).toBe(60);
    expect(await backupCount(url)).toBe(3);
  });

  it("goes ahead when the user answers Yes", async () => {
    const url = await storageWithThreeBackups();
    const run = await runTestCli(["prune", "--last", "1", "--from", url], {
      terminal: [{ when: "Permanently delete 2 backups", keys: KEYS.left + KEYS.enter }],
    });
    expect(run.code, plain(run.stderr)).toBe(0);
    expect(await backupCount(url)).toBe(1);
    // The question went to stderr; stdout has only results.
    expect(run.stdout).not.toContain("Permanently delete");
  });

  it("--yes answers for the user", async () => {
    const url = await storageWithThreeBackups();
    const run = await runTestCli(["prune", "--last", "1", "--from", url, "--yes"]);
    expect(run.code, run.stderr).toBe(0);
    expect(await backupCount(url)).toBe(1);
  });
});
