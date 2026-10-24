/**
 * The text of the `mongoshield.config.ts` that `mongoshield init` writes.
 *
 * Kept apart from the wizard so the template reads top to bottom like the
 * file it produces. Values are inserted with `JSON.stringify`, which always
 * yields a valid (escaped) TypeScript string literal.
 *
 * With a preset (`--preset atlas-free`), the file names it and also spells out the
 * values that matter most on that kind of deployment (read pace, retention), so the
 * user sees them and can change them without looking up what the preset does.
 */

import { CONFIG_PRESETS, type ConfigPresetName } from "../../config/presets.ts";

/** What the template needs to know. */
export interface InitAnswers {
  /** Storage URL or directory, e.g. `./backups` or `s3://bucket/prefix`. */
  readonly storage: string;
  /** Name of the environment variable holding the connection string. */
  readonly uriEnv: string;
  /** Public age recipient to encrypt for; omit for unencrypted backups. */
  readonly recipient?: string;
  /** Where the matching secret key was written (shown in a comment only). */
  readonly keyFile?: string;
  /** A config preset to start from (src/config/presets.ts). */
  readonly preset?: ConfigPresetName;
}

/** The default retention, when no preset brings its own. */
const DEFAULT_RETENTION = "{ last: 3, daily: 7, weekly: 4, monthly: 12 }";

/** Renders the config file. */
export function generateConfigText(answers: InitAnswers): string {
  return [
    "// MongoShield configuration, created by `mongoshield init`.",
    "// No secrets belong in this file: the connection string comes from an",
    "// environment variable, and the encryption key below is a public key.",
    "// Flags and MONGOSHIELD_* environment variables override these values.",
    'import { defineConfig } from "mongoshield";',
    "",
    "export default defineConfig({",
    ...presetSection(answers.preset),
    `  // The database to back up (and the default restore target).`,
    ...sourceComment(answers.preset),
    `  source: { uri: process.env.${answers.uriEnv} },`,
    "",
    "  // Where backups are stored: a directory, or s3://bucket/prefix",
    "  // (S3 credentials come from the usual AWS environment/profile, never from here).",
    `  storage: ${JSON.stringify(answers.storage)},`,
    "",
    '  compression: "zstd",',
    "",
    ...encryptionSection(answers),
    "",
    ...backupSection(answers.preset),
    "  // What `mongoshield prune` keeps. Preview with `mongoshield prune --dry-run`.",
    `  retention: ${retentionText(answers.preset)},`,
    "});",
    "",
  ].join("\n");
}

/** The `encryption` block, or a commented-out example when encryption is off. */
function encryptionSection(answers: InitAnswers): string[] {
  if (!answers.recipient) {
    return [
      "  // Encrypt backups: run `mongoshield keygen --output backup.key` and add",
      "  // the printed public key here.",
      '  // encryption: { recipients: ["age1…"] },',
    ];
  }
  const restoreHint = answers.keyFile
    ? `  // Restoring needs the secret key: mongoshield restore --identity-file ${answers.keyFile}`
    : "  // Restoring needs the matching secret key: mongoshield restore --identity-file <key file>";
  return [
    "  // Backups are encrypted for this public key (safe to commit).",
    restoreHint,
    "  // Keep the secret key offline, never on the machines that run backups.",
    `  encryption: { recipients: [${JSON.stringify(answers.recipient)}] },`,
  ];
}

/** The `preset` line and what it means, or nothing without a preset. */
function presetSection(preset: ConfigPresetName | undefined): string[] {
  if (preset === undefined) return [];
  return [
    "  // Defaults for MongoDB Atlas Free / Flex clusters (docs/guides/atlas-free-tier.md).",
    "  // Everything set in this file wins over them. MongoShield also recognises these",
    "  // tiers when it connects and avoids the commands they refuse.",
    `  preset: ${JSON.stringify(preset)},`,
    "",
  ];
}

/** Where to find the Atlas connection string, for Atlas presets. */
function sourceComment(preset: ConfigPresetName | undefined): string[] {
  if (preset === undefined) return [];
  return [
    '  // Atlas: Connect → Drivers, for a database user with the role "Only read any',
    '  // database". Adding `compressors=zlib` to it compresses reads on the wire,',
    "  // which saves Free-tier data transfer (10 GB out per 7 days):",
    "  //   mongodb+srv://backup:<password>@cluster0.abcde.mongodb.net/?compressors=zlib",
  ];
}

/** The read pace of a preset, written out so it is easy to find and change. */
function backupSection(preset: ConfigPresetName | undefined): string[] {
  if (preset === undefined) return [];
  const { parallelism, maxBytesPerSecond } = CONFIG_PRESETS[preset].backup;
  const mebibytes = maxBytesPerSecond / (1024 * 1024);
  return [
    `  // Go easy on a shared cluster: ${parallelism} collections at a time, at most ${mebibytes} MiB/s.`,
    `  backup: { parallelism: ${parallelism}, maxBytesPerSecond: ${mebibytes} * 1024 * 1024 },`,
    "",
  ];
}

/** The retention policy as TypeScript text: the preset's, or the default one. */
function retentionText(preset: ConfigPresetName | undefined): string {
  if (preset === undefined) return DEFAULT_RETENTION;
  const fields = Object.entries(CONFIG_PRESETS[preset].retention).map(
    ([key, value]) => `${key}: ${String(value)}`,
  );
  return `{ ${fields.join(", ")} }`;
}
