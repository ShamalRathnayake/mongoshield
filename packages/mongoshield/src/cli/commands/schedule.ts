/**
 * `mongoshield schedule`: run backups on the configured cron schedule, forever.
 *
 * A long-running process (a container, a systemd service, a sidecar). It
 * prints the next run times, then runs `mongoshield run`'s job at every cron
 * slot. On SIGTERM or Ctrl-C it stops scheduling, gives a running backup
 * `--grace-seconds` to finish, then aborts it (the lock is released and the
 * failure reported) and exits 0. A second Ctrl-C exits immediately.
 *
 * With --json, every finished run prints one JSON report.
 */

import { MongoShieldError } from "../../errors.ts";
import { summarizeReport } from "../../schedule/report.ts";
import { runScheduledJob } from "../../schedule/runner.ts";
import { BackupScheduler, DEFAULT_GRACE_MS } from "../../schedule/scheduler.ts";
import type { CommandContext, CommandSpec } from "../command.ts";
import { formatLocalDate } from "../format.ts";
import type { Output } from "../io.ts";
import { createCliLogger } from "../setup.ts";
import {
  abortOnTerminate,
  prepareScheduledRun,
  printRunReport,
  scheduledRunOptions,
} from "./run.ts";

/** How many upcoming run times are printed at start-up. */
const UPCOMING_SHOWN = 3;

export const scheduleCommand: CommandSpec = {
  name: "schedule",
  summary: "Run backups on the configured cron schedule (long-running)",
  description: [
    "Runs the scheduled job (lock, backup, verify, prune, notify) at every slot of",
    "schedule.cron, until stopped with SIGTERM or Ctrl-C. Several replicas may run it:",
    "the lock makes sure only one backs up per slot.",
  ].join("\n"),
  options: {
    ...scheduledRunOptions,
    cron: {
      type: "string",
      valueName: "<expression>",
      description: 'Override schedule.cron, e.g. "15 3 * * *"',
    },
    timezone: {
      type: "string",
      valueName: "<iana-zone>",
      description: "Override schedule.timezone (default: UTC)",
    },
    "grace-seconds": {
      type: "string",
      valueName: "<n>",
      defaultText: String(DEFAULT_GRACE_MS / 1000),
      description: "On shutdown, how long a running backup may take to finish before it is aborted",
    },
  },
  examples: [
    { description: "Use the schedule from mongoshield.config.ts", command: "mongoshield schedule" },
    {
      description: "Every night at 03:15 Berlin time",
      command: 'mongoshield schedule --cron "15 3 * * *" --timezone Europe/Berlin',
    },
  ],
  run: runScheduleCommand,
};

async function runScheduleCommand(context: CommandContext): Promise<number> {
  const { out, flags } = context;
  const cron = flags.string("cron");
  const timezone = flags.string("timezone");
  const prepared = await prepareScheduledRun(context, {
    storage: undefined,
    ...(cron || timezone ? { schedule: { cron, timezone } } : {}),
  });
  const { shield, config, storageLabel } = prepared.cli;
  const graceMs =
    (flags.integer("grace-seconds", { min: 0, max: 86_400 }) ?? DEFAULT_GRACE_MS / 1000) * 1000;

  const terminated = abortOnTerminate();
  try {
    const schedule = config.schedule;
    if (schedule === undefined) {
      throw new MongoShieldError("MS_CONFIG_INVALID", "No schedule is configured.", {
        hint: 'Add `schedule: { cron: "15 3 * * *" }` to mongoshield.config.ts, or pass --cron.',
      });
    }

    const scheduler = new BackupScheduler({
      cron: schedule.cron,
      timezone: schedule.timezone,
      jitterSeconds: schedule.jitterSeconds,
      logger: createCliLogger(out),
      job: async (signal) => {
        out.info(`Starting scheduled backup → ${storageLabel}`);
        const report = await runScheduledJob(shield, config, { ...prepared.options, signal });
        printRunReport(context, report);
        if (!out.settings.json && report.status === "failure") out.warn(summarizeReport(report));
        printNextRun(out, scheduler.nextRun());
      },
    });

    printUpcoming(out, scheduler.upcoming(UPCOMING_SHOWN), schedule.cron, schedule.timezone);
    scheduler.start();

    // Ctrl-C (from the CLI entry point) and SIGTERM both stop gracefully.
    const stop = (): void => {
      out.info(`Stopping (a running backup gets up to ${graceMs / 1000} s to finish)…`);
      void scheduler.stop({ graceMs });
    };
    for (const signal of [context.signal, terminated.signal]) {
      if (signal.aborted) stop();
      else signal.addEventListener("abort", stop, { once: true });
    }

    await scheduler.stopped;
    out.info("Scheduler stopped.");
    return 0;
  } finally {
    terminated.dispose();
    await shield.close();
  }
}

/** `Schedule: 15 3 * * * (UTC). Next runs: …`, on stderr. */
function printUpcoming(
  out: Output,
  upcoming: readonly Date[],
  cron: string,
  timezone: string | undefined,
): void {
  out.info(`Schedule: ${cron} (${timezone ?? "UTC"}). Next runs:`);
  for (const date of upcoming) out.info(`  ${formatLocalDate(date)} (${date.toISOString()})`);
}

function printNextRun(out: Output, next: Date | undefined): void {
  if (next)
    out.info(out.style("dim", `Next run: ${formatLocalDate(next)} (${next.toISOString()})`));
}
