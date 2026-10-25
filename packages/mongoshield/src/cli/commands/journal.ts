/**
 * `mongoshield journal start|status`: the change journal for point-in-time recovery
 * (docs/specs/JOURNAL.md, docs/guides/point-in-time-recovery.md).
 *
 *   journal start    the writer, a long-running process (a container, a systemd
 *                    service, a Kubernetes Deployment with ONE replica). It records every
 *                    change into segments next to the backups. Segment length, size and
 *                    the gap policy come from the config's `journal` section, which the
 *                    flags override (`journalSettings`). On SIGTERM or Ctrl-C it
 *                    closes and commits the current segment, releases its lease and
 *                    exits 0. A second Ctrl-C exits immediately (nothing committed is
 *                    lost; the next writer resumes after the last commit).
 *   journal status   the recovery point, the RPO, the covered ranges and any gaps.
 *                    `--max-rpo 10m` exits 1 when the journal is further behind, for
 *                    cron-style monitoring.
 */

import type { MongoShieldConfig } from "../../config/schema.ts";
import { formatClusterTime } from "../../engine/converge-time.ts";
import { MongoShieldError } from "../../errors.ts";
import {
  DEFAULT_SEGMENT_BYTES,
  DEFAULT_SEGMENT_SECONDS,
  type JournalStatus,
  journalStatus,
  startJournal,
} from "../../journal/index.ts";
import { describeTime } from "../../journal/plan.ts";
import { dateOfClusterTime } from "../../journal/time.ts";
import { openConnection } from "../../mongo/index.ts";
import { WEBHOOK_SECRET_ENV } from "../../notify/webhook.ts";
import type { EncryptionOptions } from "../../types.ts";
import type { CommandContext, CommandSpec } from "../command.ts";
import { formatBytes, formatCount, formatDateWithRelative, formatDuration } from "../format.ts";
import { createCliLogger, createCliShield, displayUri, rememberUriPassword } from "../setup.ts";
import { renderDetails, renderTable } from "../table.ts";
import { parseByteSize, parseDuration } from "../units.ts";
import { abortOnTerminate } from "./run.ts";
import {
  excludeOption,
  includeOption,
  listOrUndefined,
  storageFromOption,
} from "./shared-options.ts";

const NAME = "journal";

/** `mongoshield journal start|status` (see the file header). */
export const journalCommand: CommandSpec = {
  name: NAME,
  summary: "Record every change for point-in-time recovery (start | status)",
  description: [
    "journal start runs the change journal writer until stopped: every change is",
    "recorded into encrypted, chained segments next to the backups, so a restore can",
    "stop at any second after a base backup (mongoshield restore --at). Run exactly one",
    "writer per storage location; a lease makes sure of it.",
    "",
    "journal status shows the recovery point, how far behind it is (RPO), the covered",
    "time ranges and any gaps.",
  ].join("\n"),
  positionals: [{ name: "action", description: "start or status" }],
  options: {
    uri: {
      type: "string",
      valueName: "<mongodb-uri>",
      description: "Connection string (default: config source.uri, MONGOSHIELD_URI or MONGODB_URI)",
    },
    to: {
      type: "string",
      valueName: "<storage-url>",
      description: "Where the backups and the journal live (default: config storage)",
    },
    from: storageFromOption,
    include: includeOption,
    exclude: excludeOption,
    recipient: {
      type: "string",
      multiple: true,
      valueName: "<age1…>",
      description: "Encrypt segments to this public key (default: config encryption)",
    },
    "segment-seconds": {
      type: "string",
      valueName: "<n>",
      defaultText: "config journal.segmentSeconds, else 300",
      description: "Close a segment after this many seconds (the normal worst-case RPO)",
    },
    "segment-size": {
      type: "string",
      valueName: "<size>",
      defaultText: "config journal.segmentBytes, else 64MiB",
      description: "…or once it holds this much change data",
    },
    "on-gap": {
      type: "string",
      choices: ["backup", "fail"],
      defaultText: "config journal.onGap, else backup",
      description: "When change history is lost: take a new base backup, or stop",
    },
    heartbeat: {
      type: "string",
      valueName: "<url>",
      description: "Ping this URL after every segment (healthchecks.io style)",
    },
    "wait-for-lease": {
      type: "boolean",
      description: "Wait for a running writer to stop instead of failing (rolling updates)",
    },
    "max-rpo": {
      type: "string",
      valueName: "<duration>",
      description: "status: exit 1 when the recovery point is older than this, e.g. 10m",
    },
  },
  examples: [
    {
      description: "Run the writer next to the configured backups",
      command: "mongoshield journal start",
    },
    {
      description: "One-minute segments, encrypted to a public key",
      command: "mongoshield journal start --segment-seconds 60 --recipient age1…",
    },
    {
      description: "Check the journal, alerting when it is more than 10 minutes behind",
      command: "mongoshield journal status --max-rpo 10m",
    },
  ],
  run: runJournalCommand,
};

async function runJournalCommand(context: CommandContext): Promise<number> {
  const action = context.positionals[0];
  if (action === "start") return runStart(context);
  if (action === "status") return runStatus(context);
  throw new MongoShieldError(
    "MS_CONFIG_INVALID",
    action === undefined
      ? "Which journal action? Use start or status."
      : `Unknown journal action "${action}".`,
    { hint: "Run `mongoshield journal start` (the writer) or `mongoshield journal status`." },
  );
}

/** `journal start`: runs the writer until SIGTERM or Ctrl-C. */
async function runStart(context: CommandContext): Promise<number> {
  const { out, flags } = context;
  const uri = flags.string("uri");
  if (uri) rememberUriPassword(context, uri);
  const recipients = listOrUndefined(context, "recipient");
  const cli = await createCliShield(context, {
    source: uri ? { uri } : undefined,
    storage: flags.string("to"),
    encryption: recipients ? { recipients } : undefined,
  });
  const { shield, config, storageLabel } = cli;
  const logger = createCliLogger(out);
  const terminated = abortOnTerminate();
  try {
    const sourceUri = config.source?.uri;
    if (!sourceUri) {
      throw new MongoShieldError("MS_CONFIG_INVALID", "No MongoDB connection string was given.", {
        hint: "Pass --uri, set MONGOSHIELD_URI, or add source.uri to mongoshield.config.ts.",
      });
    }
    const include = listOrUndefined(context, "include") ?? config.backup?.include;
    const exclude = listOrUndefined(context, "exclude") ?? config.backup?.exclude;
    const { segmentSeconds, segmentBytes, onGap } = journalSettings(context, config.journal);
    const webhookSecret = context.io.env[WEBHOOK_SECRET_ENV];
    if (webhookSecret) context.addSecret(webhookSecret);
    const heartbeat = flags.string("heartbeat");

    const connection = await openConnection({ uri: sourceUri }, { logger });
    try {
      out.info(`Journaling ${displayUri(sourceUri)} → ${storageLabel}`);
      out.info(
        `Segments close after ${formatDuration(segmentSeconds * 1000)} or ${formatBytes(segmentBytes)}; on a gap in the change history: ${onGap === "fail" ? "stop" : "take a new base backup"}.`,
      );
      const journal = await startJournal({
        client: connection.client,
        storage: shield.storage,
        compression: shield.compression,
        encryption: encryptionOf(config.encryption),
        include,
        exclude,
        segmentSeconds,
        segmentBytes,
        onGap,
        takeBaseBackup: (signal) =>
          shield.backup({
            consistency: "converge",
            signal,
            ...(include ? { include } : {}),
            ...(exclude ? { exclude } : {}),
          }),
        notify: {
          logger,
          ...(config.notify ? { targets: config.notify } : {}),
          ...(heartbeat ? { heartbeat } : {}),
          ...(webhookSecret ? { webhookSecret } : {}),
        },
        logger,
        waitForLease: flags.boolean("wait-for-lease"),
        onSegment: (segment) =>
          out.debug(
            `segment committed: up to ${formatClusterTime(segment.to)}, ${formatCount(segment.events)} events, ${formatBytes(segment.size)}`,
          ),
      });
      out.info("Journal writer running. Stop it with SIGTERM or Ctrl-C.");

      // Ctrl-C (from the CLI entry point) and SIGTERM both stop gracefully.
      const stop = (): void => {
        out.info("Stopping: committing the current segment…");
        journal.stop().catch(() => {
          // Reported below through `done`.
        });
      };
      for (const signal of [context.signal, terminated.signal]) {
        if (signal.aborted) stop();
        else signal.addEventListener("abort", stop, { once: true });
      }

      await journal.done;
      const status = journal.status();
      const point = status.recoveryPoint;
      out.info(
        point === undefined
          ? "Journal writer stopped."
          : `Journal writer stopped. Recovery point: ${dateOfClusterTime(point).toISOString()} (${formatClusterTime(point)}), ${formatCount(status.segmentsWritten)} segments written.`,
      );
      return 0;
    } finally {
      await connection.close();
    }
  } finally {
    terminated.dispose();
    await shield.close();
  }
}

/** `journal status`: details, covered ranges and gaps (or JSON). */
async function runStatus(context: CommandContext): Promise<number> {
  const { out, flags } = context;
  const maxRpoMs = maxRpoFlag(flags.string("max-rpo"));
  const cli = await createCliShield(context, {
    storage: flags.string("from") ?? flags.string("to"),
  });
  try {
    const status = await journalStatus(cli.shield.storage, { signal: context.signal });
    if (out.settings.json) out.json(status);
    else printStatus(context, status, cli.storageLabel);

    if (maxRpoMs !== undefined && (status.rpoMs === undefined || status.rpoMs > maxRpoMs)) {
      out.warn(
        status.rpoMs === undefined
          ? "The journal has no committed segment yet."
          : `The journal is ${formatDuration(status.rpoMs)} behind (more than ${formatDuration(maxRpoMs)}).`,
      );
      return 1;
    }
    return 0;
  } finally {
    await cli.shield.close();
  }
}

function printStatus(context: CommandContext, status: JournalStatus, storageLabel: string): void {
  const { out } = context;
  const now = new Date();
  if (status.recoveryPoint === undefined || status.recoveryPointDate === undefined) {
    out.info(`No journal in ${storageLabel} yet. Start the writer with: mongoshield journal start`);
    return;
  }
  const dim = (text: string) => out.style("dim", text);
  out.result(
    renderDetails(
      [
        [
          "Recovery point",
          `${formatDateWithRelative(status.recoveryPointDate, now)} (${formatClusterTime(status.recoveryPoint)})`,
        ],
        ["RPO", status.rpoMs === undefined ? "–" : formatDuration(status.rpoMs)],
        ["Segments", `${formatCount(status.segments)} (${formatBytes(status.bytes)})`],
        [
          "Last commit",
          status.lastCommit === undefined
            ? "–"
            : `${formatDateWithRelative(status.lastCommit.at, now)} by ${status.lastCommit.host}`,
        ],
        [
          "Gaps",
          status.gaps.length === 0
            ? out.style("green", "none")
            : out.style("red", String(status.gaps.length)),
        ],
      ],
      dim,
    ),
  );

  out.result("");
  out.result(
    renderTable(
      [{ header: "COVERED FROM" }, { header: "TO" }, { header: "SEGMENTS", align: "right" }],
      status.coveredRanges.map((range) => [
        describeTime(range.from),
        describeTime(range.to),
        formatCount(range.segments),
      ]),
      dim,
    ),
  );

  if (status.gaps.length > 0) {
    out.result("");
    out.result(
      renderTable(
        [{ header: "GAP FROM" }, { header: "TO" }, { header: "DETECTED" }, { header: "ACTION" }],
        status.gaps.map((gap) => [
          describeTime(gap.from),
          describeTime(gap.to),
          formatDateWithRelative(new Date(gap.detectedAt), now),
          gap.action,
        ]),
        dim,
      ),
    );
  }
}

/** The writer's segment and gap settings. */
export interface JournalCliSettings {
  readonly segmentSeconds: number;
  readonly segmentBytes: number;
  readonly onGap: "backup" | "fail";
}

/**
 * Segment length, segment size and the gap policy: each flag wins over the config
 * file's `journal` section, which wins over the library defaults.
 *
 * @throws MongoShieldError `MS_CONFIG_INVALID` for malformed flags.
 */
export function journalSettings(
  context: Pick<CommandContext, "flags">,
  config: MongoShieldConfig["journal"],
): JournalCliSettings {
  const { flags } = context;
  const onGapFlag = flags.string("on-gap");
  return {
    segmentSeconds:
      flags.integer("segment-seconds", { min: 1, max: 86_400 }) ??
      config?.segmentSeconds ??
      DEFAULT_SEGMENT_SECONDS,
    segmentBytes:
      segmentSizeFlag(flags.string("segment-size")) ??
      config?.segmentBytes ??
      DEFAULT_SEGMENT_BYTES,
    onGap: onGapFlag === "fail" || onGapFlag === "backup" ? onGapFlag : (config?.onGap ?? "backup"),
  };
}

/**
 * The configured encryption as the journal takes it (recipients and KMS keys; a
 * passphrase is passed on so the journal can refuse it with its own explanation).
 */
function encryptionOf(encryption: MongoShieldConfig["encryption"]): EncryptionOptions | undefined {
  if (encryption === undefined) return undefined;
  return {
    ...(encryption.recipients ? { recipients: encryption.recipients } : {}),
    ...(encryption.passphrase ? { passphrase: encryption.passphrase } : {}),
    ...(encryption.kms ? { kms: encryption.kms } : {}),
  };
}

function segmentSizeFlag(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const bytes = parseByteSize(value);
  if (bytes === undefined || bytes < 1024) {
    throw new MongoShieldError(
      "MS_CONFIG_INVALID",
      `--segment-size must be a size such as 64MiB (got "${value}").`,
      {
        hint: "Use a number with a unit: KiB, MiB, GiB (or KB, MB, GB); at least 1KiB.",
      },
    );
  }
  return bytes;
}

function maxRpoFlag(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const ms = parseDuration(value);
  if (ms === undefined) {
    throw new MongoShieldError(
      "MS_CONFIG_INVALID",
      `--max-rpo must be a duration such as 10m (got "${value}").`,
      {
        hint: "Use a number with a unit: ms, s, m or h, e.g. 90s or 10m.",
      },
    );
  }
  return ms;
}
