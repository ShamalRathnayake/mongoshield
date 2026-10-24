/**
 * The things being compared. A variant is one tool with one set of options; it knows
 * how to build its backup command and its restore command.
 *
 * Every variant backs up the whole benchmark database to a local directory and
 * restores it into an empty database under another name (RESTORE_DATABASE), with
 * each tool's default parallelism (4 collections at a time for all of them) and
 * index builds included. Nothing is tuned for either side.
 */

import { join } from "node:path";
import { BENCH_DATABASE, RESTORE_DATABASE } from "./dataset.ts";
import type { Command } from "./measure.ts";

/** Paths and secrets every variant may need, prepared once by the harness. */
export interface VariantContext {
  readonly uri: string;
  /** The built CLI (dist/cli.mjs), run with the current Node. */
  readonly mongoshieldCli: string;
  /** Directory with mongodump and mongorestore, or undefined when they are not installed. */
  readonly toolsBin: string | undefined;
  /** age key pair for the encrypted variant (from `mongoshield keygen`). */
  readonly ageRecipient: string;
  readonly ageIdentityFile: string;
  /** `--consistency` for mongoshield backups (default auto). */
  readonly consistency: string;
  /** A directory with no mongoshield config file, used as the working directory. */
  readonly workDirectory: string;
}

/** One tool + options, as compared in the results table. */
export interface Variant {
  /** Stable id used in the results file, e.g. "mongoshield-zstd". */
  readonly id: string;
  /** Human-readable label for the table. */
  readonly label: string;
  readonly tool: "mongoshield" | "mongodump";
  /** The command that writes a backup into `outputDirectory` (empty, already created). */
  readonly backup: (context: VariantContext, outputDirectory: string) => Command;
  /** The command that restores the backup in `outputDirectory` into RESTORE_DATABASE. */
  readonly restore: (context: VariantContext, outputDirectory: string) => Command;
}

/** Options every mongoshield command gets: no prompts, no progress bars, no colors. */
const MONGOSHIELD_QUIET = ["--quiet", "--yes", "--no-color"];

/** Builds a mongoshield CLI command (`node dist/cli.mjs …`). */
function mongoshield(context: VariantContext, args: readonly string[]): Command {
  return {
    program: process.execPath,
    args: [context.mongoshieldCli, ...args, ...MONGOSHIELD_QUIET],
    cwd: context.workDirectory,
    // Make sure no MONGOSHIELD_* settings from the caller's shell leak into the run.
    env: { NO_COLOR: "1" },
  };
}

/**
 * A mongoshield backup with the given extra options. `consistency` overrides the
 * harness-wide --consistency (default auto, which is "converge" on a replica set).
 */
function mongoshieldBackup(extra: readonly string[], consistency?: string) {
  return (context: VariantContext, outputDirectory: string): Command =>
    mongoshield(context, [
      "backup",
      "--uri",
      context.uri,
      "--to",
      outputDirectory,
      "--include",
      `${BENCH_DATABASE}.*`,
      "--consistency",
      consistency ?? context.consistency,
      ...extra,
    ]);
}

/** A mongoshield restore of the latest backup, renamed into RESTORE_DATABASE. */
function mongoshieldRestore(extra: readonly string[]) {
  return (context: VariantContext, outputDirectory: string): Command =>
    mongoshield(context, [
      "restore",
      "latest",
      "--from",
      outputDirectory,
      "--to-uri",
      context.uri,
      "--rename",
      `${BENCH_DATABASE}.*=${RESTORE_DATABASE}.*`,
      ...extra,
    ]);
}

/** The path of mongodump or mongorestore; throws when the tools are not installed. */
function toolPath(context: VariantContext, name: "mongodump" | "mongorestore"): string {
  if (context.toolsBin === undefined) throw new Error(`${name} is not installed`);
  const executable = process.platform === "win32" ? `${name}.exe` : name;
  return join(context.toolsBin, executable);
}

/** A mongodump into a directory (its default layout: one .bson + .metadata.json each). */
function mongodumpBackup(extra: readonly string[]) {
  return (context: VariantContext, outputDirectory: string): Command => ({
    program: toolPath(context, "mongodump"),
    args: [
      `--uri=${context.uri}`,
      `--db=${BENCH_DATABASE}`,
      `--out=${outputDirectory}`,
      "--quiet",
      ...extra,
    ],
    cwd: context.workDirectory,
  });
}

/** A mongorestore of that directory, renamed into RESTORE_DATABASE. */
function mongorestoreRestore(extra: readonly string[]) {
  return (context: VariantContext, outputDirectory: string): Command => ({
    program: toolPath(context, "mongorestore"),
    args: [
      `--uri=${context.uri}`,
      `--nsInclude=${BENCH_DATABASE}.*`,
      `--nsFrom=${BENCH_DATABASE}.*`,
      `--nsTo=${RESTORE_DATABASE}.*`,
      `--dir=${outputDirectory}`,
      "--quiet",
      ...extra,
    ],
    cwd: context.workDirectory,
  });
}

/** Every variant, in the order of the results table. */
export const VARIANTS: readonly Variant[] = [
  {
    id: "mongoshield-zstd",
    label: "mongoshield (zstd)",
    tool: "mongoshield",
    backup: mongoshieldBackup(["--compression", "zstd"]),
    restore: mongoshieldRestore([]),
  },
  {
    // Same as above without cross-collection consistency: the like-for-like
    // comparison with mongodump, which (without --oplog) does not provide any either.
    id: "mongoshield-zstd-none",
    label: "mongoshield (zstd, consistency none)",
    tool: "mongoshield",
    backup: mongoshieldBackup(["--compression", "zstd"], "none"),
    restore: mongoshieldRestore([]),
  },
  {
    id: "mongoshield-zstd-age",
    label: "mongoshield (zstd + age)",
    tool: "mongoshield",
    backup: (context, outputDirectory) =>
      mongoshieldBackup(["--compression", "zstd", "--recipient", context.ageRecipient])(
        context,
        outputDirectory,
      ),
    restore: (context, outputDirectory) =>
      mongoshieldRestore(["--identity-file", context.ageIdentityFile])(context, outputDirectory),
  },
  {
    id: "mongoshield-gzip",
    label: "mongoshield (gzip)",
    tool: "mongoshield",
    backup: mongoshieldBackup(["--compression", "gzip"]),
    restore: mongoshieldRestore([]),
  },
  {
    id: "mongodump",
    label: "mongodump (plain)",
    tool: "mongodump",
    backup: mongodumpBackup([]),
    restore: mongorestoreRestore([]),
  },
  {
    id: "mongodump-gzip",
    label: "mongodump (--gzip)",
    tool: "mongodump",
    backup: mongodumpBackup(["--gzip"]),
    restore: mongorestoreRestore(["--gzip"]),
  },
];
