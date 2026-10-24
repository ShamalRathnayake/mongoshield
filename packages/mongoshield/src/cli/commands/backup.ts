/**
 * `mongoshield backup`: back up a deployment to storage.
 *
 * Flags override the config file's `source`, `storage`, `compression`,
 * `encryption` and `backup` sections. Progress is shown while it runs; the
 * summary (id, sizes, ratio, duration) goes to stdout, so
 * `ID=$(mongoshield backup --quiet)` captures just the backup id.
 */

import { backupTuningFromConfig } from "../../config/backup-tuning.ts";
import type { MongoShieldConfig, MongoShieldConfigInput } from "../../config/schema.ts";
import { withShapeLabel } from "../../engine/backup-guard.ts";
import { MongoShieldError } from "../../errors.ts";
import type { Manifest } from "../../format/manifest.ts";
import type {
  BackupOptions,
  BackupResult,
  CheckpointedBackupResult,
  CompletedBackupResult,
  ReadPreferenceModeName,
} from "../../types.ts";
import { usageError } from "../args.ts";
import type { CommandContext, CommandSpec } from "../command.ts";
import { consistencySummary } from "../describe.ts";
import { formatBytes, formatCount, formatDuration, formatRatio, plural } from "../format.ts";
import { ProgressDisplay } from "../progress.ts";
import { createCliShield, displayUri, readPassphraseEnv, rememberUriPassword } from "../setup.ts";
import { renderDetails } from "../table.ts";
import { parseByteSize, parseDuration } from "../units.ts";
import {
  assertNotBoth,
  excludeOption,
  includeOption,
  listOrUndefined,
  parseKeyValues,
  passphraseEnvOption,
} from "./shared-options.ts";

const NAME = "backup";

export const backupCommand: CommandSpec = {
  name: NAME,
  summary: "Back up MongoDB to storage",
  description: [
    "Dumps every collection (or the ones selected with --include/--exclude), with",
    "indexes and options, compressed and optionally encrypted. The backup only",
    "counts as complete once its manifest is written, so an interrupted run never",
    "looks like a good backup.",
  ].join("\n"),
  options: {
    uri: {
      type: "string",
      valueName: "<mongodb-uri>",
      description: "Connection string (default: config source.uri, MONGOSHIELD_URI or MONGODB_URI)",
    },
    to: {
      type: "string",
      valueName: "<storage-url>",
      description: "Where to store the backup: ./dir, file:///abs, s3://bucket/prefix",
    },
    include: includeOption,
    exclude: excludeOption,
    compression: {
      type: "string",
      choices: ["zstd", "gzip", "none"],
      defaultText: "zstd",
      description: "Compression algorithm",
    },
    recipient: {
      type: "string",
      multiple: true,
      valueName: "<age1…>",
      description: "Encrypt for this age public key (from `mongoshield keygen`)",
    },
    "passphrase-env": passphraseEnvOption,
    consistency: {
      type: "string",
      choices: ["auto", "none", "snapshot", "converge"],
      defaultText: "auto",
      description: "Point-in-time consistency across collections",
    },
    label: {
      type: "string",
      multiple: true,
      valueName: "<key=value>",
      description: "Attach a label to the backup, e.g. env=prod",
    },
    parallelism: {
      type: "string",
      valueName: "<n>",
      defaultText: "4",
      description: "Collections (and parts) backed up at the same time (1–64)",
    },
    "part-size": {
      type: "string",
      valueName: "<size>",
      defaultText: "256MiB",
      description: "Split collections larger than this into parts, e.g. 256MiB or 1GiB",
    },
    "max-duration": {
      type: "string",
      valueName: "<duration>",
      description:
        "Stop after about this long and save a checkpoint, e.g. 14m (implies consistency none)",
    },
    resume: {
      type: "string",
      valueName: "<id|latest|auto>",
      description:
        "Continue a checkpointed backup (auto: the newest one with these options, else start anew)",
    },
    "read-preference": {
      type: "string",
      choices: ["primary", "primaryPreferred", "secondary", "secondaryPreferred", "nearest"],
      defaultText: "secondaryPreferred",
      description: "Which members to read from",
    },
    "max-docs-per-second": {
      type: "string",
      valueName: "<n>",
      description: "Read at most this many documents per second",
    },
    "max-bytes-per-second": {
      type: "string",
      valueName: "<size>",
      description: "Read at most this many bytes per second, e.g. 50MiB",
    },
    "retain-days": {
      type: "string",
      valueName: "<days>",
      description: "Make the backup write-once for this many days (S3 Object Lock, GCS, Azure)",
    },
    "users-and-roles": {
      type: "boolean",
      description:
        "Also back up users and custom roles (password hashes included: encrypt the backup)",
    },
  },
  examples: [
    {
      description: "Back up everything to a local directory",
      command: "mongoshield backup --uri mongodb://localhost:27017 --to ./backups",
    },
    {
      description: "Back up one database to S3, encrypted for a public key",
      command: "mongoshield backup --include 'app.*' --to s3://acme-backups/prod --recipient age1…",
    },
    {
      description: "Capture the new backup id in a script",
      command: "ID=$(mongoshield backup --quiet)",
    },
    {
      description: "Back up in 14-minute slices (e.g. on AWS Lambda), then continue",
      command:
        "mongoshield backup --max-duration 14m && mongoshield backup --resume latest --max-duration 14m",
    },
    {
      description: "Go easy on production: read from secondaries at most 50 MiB/s",
      command: "mongoshield backup --read-preference secondary --max-bytes-per-second 50MiB",
    },
  ],
  run: runBackupCommand,
};

async function runBackupCommand(context: CommandContext): Promise<number> {
  const { out } = context;
  const { shield, config, storageLabel } = await createCliShield(context, backupOverrides(context));
  try {
    const uri = config.source?.uri;
    if (!uri) throw missingUriError();

    out.info(`Backing up ${displayUri(uri)} → ${storageLabel}`);
    const progress = new ProgressDisplay(out, "Backing up");
    let result: BackupResult;
    try {
      result = await shield.backup(backupOptions(context, config.backup, progress));
    } finally {
      progress.stop();
    }

    if (result.status === "checkpointed") printCheckpointedResult(context, result);
    else printBackupResult(context, result, storageLabel);
    return 0;
  } finally {
    await shield.close();
  }
}

/** Turns the flags into a config layer (unset flags leave the config untouched). */
function backupOverrides(context: CommandContext): MongoShieldConfigInput {
  const { flags } = context;
  assertNotBoth(context, NAME, "recipient", "passphrase-env");

  const uri = flags.string("uri");
  if (uri) rememberUriPassword(context, uri);

  const recipients = listOrUndefined(context, "recipient");
  const passphraseVariable = flags.string("passphrase-env");
  const passphrase = passphraseVariable
    ? readPassphraseEnv(context, passphraseVariable)
    : undefined;

  return {
    source: uri ? { uri } : undefined,
    storage: flags.string("to"),
    compression: compressionFlag(flags.string("compression")),
    encryption: recipients || passphrase ? { recipients, passphrase } : undefined,
    backup: {
      include: listOrUndefined(context, "include"),
      exclude: listOrUndefined(context, "exclude"),
      consistency: consistencyFlag(flags.string("consistency")),
      parallelism: flags.integer("parallelism", { min: 1, max: 64 }),
      labels: parseKeyValues(context, NAME, "label"),
      partSizeBytes: sizeFlag(context, "part-size"),
      maxDurationMs: durationFlag(context, "max-duration"),
      readPreference: readPreferenceFlag(flags.string("read-preference")),
      maxDocumentsPerSecond: flags.integer("max-docs-per-second", { min: 1 }),
      maxBytesPerSecond: sizeFlag(context, "max-bytes-per-second"),
      retainDays: flags.integer("retain-days", { min: 1, max: 36500 }),
      // Only an explicit flag overrides the config; its absence leaves it as configured.
      usersAndRoles: flags.boolean("users-and-roles") ? true : undefined,
    },
  };
}

/** The per-run options, from the merged `backup` config section and `--resume`. */
function backupOptions(
  context: CommandContext,
  section: MongoShieldConfig["backup"],
  progress: ProgressDisplay,
): BackupOptions {
  const resume = context.flags.string("resume");
  return {
    signal: context.signal,
    onProgress: progress.onProgress,
    ...(section?.include ? { include: section.include } : {}),
    ...(section?.exclude ? { exclude: section.exclude } : {}),
    ...(section?.consistency ? { consistency: section.consistency } : {}),
    ...(section?.parallelism ? { parallelism: section.parallelism } : {}),
    // The shape label (as the scheduler writes it) lets `mongoshield prune` and the
    // guard tell this selection's backups from other jobs' in the same storage.
    labels: withShapeLabel(section?.labels, section ?? {}),
    ...backupTuningFromConfig(section),
    ...(resume === undefined ? {} : { resume }),
  };
}

/** Prints the summary (or just the id with --quiet, or the result with --json). */
function printBackupResult(
  context: CommandContext,
  result: CompletedBackupResult,
  storage: string,
): void {
  const { out } = context;
  if (out.settings.json) {
    out.json(result);
    return;
  }
  if (out.settings.quiet) {
    out.result(result.id);
    return;
  }

  const manifest = result.manifest;
  out.success("Backup complete.");
  out.result(
    renderDetails(
      [
        ["Backup id", out.style("bold", result.id)],
        ["Storage", storage],
        ["Namespaces", namespaceSummary(manifest)],
        ["Documents", formatCount(manifest.totals.documents)],
        ["Data", sizeSummary(manifest)],
        ["Compression", manifest.compression],
        ["Encryption", encryptionLine(manifest)],
        ["Consistency", consistencySummary(manifest)],
        ["Duration", formatDuration(result.durationMs)],
      ],
      (label) => out.style("dim", label),
    ),
  );
  if (manifest.consistency.warning) out.warn(manifest.consistency.warning);
  out.info(out.style("dim", `Next: mongoshield verify ${result.id}`));
}

/**
 * A run that used up `--max-duration`: says how far it got and exactly how to
 * continue. `--quiet` prints the id, `--json` the result (its `status` tells).
 */
function printCheckpointedResult(context: CommandContext, result: CheckpointedBackupResult): void {
  const { out } = context;
  if (out.settings.json) {
    out.json(result);
    return;
  }
  if (out.settings.quiet) {
    out.result(result.id);
    return;
  }
  const { checkpoint } = result;
  out.warn(
    `Backup ${result.id} checkpointed: ${formatCount(checkpoint.partsDone)} of ${plural(checkpoint.partsTotal, "part")} done, not complete yet.`,
  );
  out.result(
    renderDetails(
      [
        ["Backup id", out.style("bold", result.id)],
        ["Parts", `${formatCount(checkpoint.partsDone)} / ${formatCount(checkpoint.partsTotal)}`],
        ["Documents", formatCount(checkpoint.documents)],
        ["Data so far", formatBytes(checkpoint.bytesRaw)],
        ["Duration", formatDuration(result.durationMs)],
        ["Checkpoint", checkpoint.key],
      ],
      (label) => out.style("dim", label),
    ),
  );
  out.info(
    `checkpointed: resume with \`mongoshield backup --resume ${result.id}\` (same options; add --max-duration to keep slicing).`,
  );
}

/** Parses a size flag such as `256MiB`; a usage error when malformed. */
function sizeFlag(context: CommandContext, flag: string): number | undefined {
  const raw = context.flags.string(flag);
  if (raw === undefined) return undefined;
  const bytes = parseByteSize(raw);
  if (bytes === undefined) {
    throw usageError(`--${flag} expects a size such as 256MiB or 50MB (got "${raw}").`, NAME);
  }
  return bytes;
}

/** Parses a duration flag such as `14m`; a usage error when malformed. */
function durationFlag(context: CommandContext, flag: string): number | undefined {
  const raw = context.flags.string(flag);
  if (raw === undefined) return undefined;
  const milliseconds = parseDuration(raw);
  if (milliseconds === undefined) {
    throw usageError(
      `--${flag} expects a duration such as 14m, 90s or 1h30m (got "${raw}").`,
      NAME,
    );
  }
  return milliseconds;
}

/** `12 (in 3 databases)`. */
function namespaceSummary(manifest: Manifest): string {
  const databases = new Set(manifest.namespaces.map((entry) => entry.db)).size;
  return `${formatCount(manifest.totals.namespaces)} (in ${plural(databases, "database")})`;
}

/** `1.2 GiB raw → 300.0 MiB stored (4.1×)`. */
function sizeSummary(manifest: Manifest): string {
  const { bytesRaw, bytesStored } = manifest.totals;
  return `${formatBytes(bytesRaw)} raw → ${formatBytes(bytesStored)} stored (${formatRatio(bytesRaw, bytesStored)})`;
}

function encryptionLine(manifest: Manifest): string {
  const encryption = manifest.encryption;
  if (!encryption) return "none";
  if (encryption.recipients.includes("scrypt")) return "age (passphrase)";
  return `age (${plural(encryption.recipients.length, "recipient")})`;
}

function missingUriError(): MongoShieldError {
  return new MongoShieldError("MS_CONFIG_INVALID", "No MongoDB connection string is configured.", {
    hint: "Pass --uri, set MONGODB_URI (or MONGOSHIELD_URI), or set source.uri in mongoshield.config.ts.",
  });
}

/** The parser already checked the value against `choices`; this narrows the type. */
function compressionFlag(value: string | undefined): "zstd" | "gzip" | "none" | undefined {
  return value === "zstd" || value === "gzip" || value === "none" ? value : undefined;
}

/** The parser already checked the value against `choices`; this narrows the type. */
function readPreferenceFlag(value: string | undefined): ReadPreferenceModeName | undefined {
  switch (value) {
    case "primary":
    case "primaryPreferred":
    case "secondary":
    case "secondaryPreferred":
    case "nearest":
      return value;
    default:
      return undefined;
  }
}

function consistencyFlag(
  value: string | undefined,
): "auto" | "none" | "snapshot" | "converge" | undefined {
  return value === "auto" || value === "none" || value === "snapshot" || value === "converge"
    ? value
    : undefined;
}
