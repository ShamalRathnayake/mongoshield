/**
 * The text of the `mongoshield.config.ts` that `mongoshield init` writes.
 *
 * Kept apart from the wizard so the template reads top to bottom like the
 * file it produces. Values are inserted with `JSON.stringify`, which always
 * yields a valid (escaped) TypeScript string literal.
 */

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
}

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
    `  // The database to back up (and the default restore target).`,
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
    "  // What `mongoshield prune` keeps. Preview with `mongoshield prune --dry-run`.",
    "  retention: { last: 3, daily: 7, weekly: 4, monthly: 12 },",
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
