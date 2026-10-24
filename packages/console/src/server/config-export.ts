/**
 * Renders the console's plans as a `mongoshield.config.ts` for the CLI.
 *
 * Nothing the console does is impossible from the CLI; this export is the
 * bridge. Secrets are never written into the file: every URI, passphrase and
 * webhook URL becomes a `process.env.…` reference, and a comment lists the
 * variables to set.
 *
 * Injection safety: every value from the state (names, URLs, patterns) is
 * written with `JSON.stringify`, which produces a valid, fully escaped
 * TypeScript string literal, and names in comments are written the same way.
 * Identifiers are built from `[A-Za-z0-9]` only. So no stored value can ever
 * close a string or comment and inject code into a file someone will run.
 */

import { localPathOf, storageSchemeOf } from "../jobs/storage.ts";
import type { ConnectionRecord, ConsoleState, PlanRecord, StorageRecord } from "../state/types.ts";

/** The exported file. */
export interface ExportedConfig {
  readonly filename: string;
  readonly content: string;
}

/** Renders every plan as a named config export (the first one is also the default export). */
export function renderConfig(state: ConsoleState, dataDir: string, now: Date): ExportedConfig {
  const variables: string[] = [];
  const blocks: string[] = [];
  const identifiers = new Set<string>();

  for (const plan of state.plans) {
    const connection = state.connections.find((candidate) => candidate.id === plan.connectionId);
    const storage = state.storage.find((candidate) => candidate.id === plan.storageId);
    if (connection === undefined || storage === undefined) continue;
    const identifier = uniqueIdentifier(plan.name, identifiers);
    blocks.push(renderPlan(plan, identifier, connection, storage, dataDir, variables));
  }

  const lines = [
    `// mongoshield.config.ts, exported from the MongoShield console on ${now.toISOString()}.`,
    "//",
    "// Secrets are not included. Set these environment variables before running the CLI:",
    ...unique(variables).map((line) => `//   ${line}`),
    "//",
    "// One config per backup plan. The default export is the first plan; export another",
    "// one as default (or keep one per file) to run it with `mongoshield run`.",
    "",
    'import { defineConfig } from "mongoshield";',
    "",
    ...blocks,
  ];
  const first = [...identifiers][0];
  lines.push(
    first === undefined
      ? 'export default defineConfig({ storage: "./backups" });'
      : `export default ${first};`,
  );
  return { filename: "mongoshield.config.ts", content: `${lines.join("\n")}\n` };
}

/** One plan as `export const <identifier> = defineConfig({ … });`. */
function renderPlan(
  plan: PlanRecord,
  identifier: string,
  connection: ConnectionRecord,
  storage: StorageRecord,
  dataDir: string,
  variables: string[],
): string {
  const uriVariable = `MONGODB_URI_${envSuffix(connection.name)}`;
  variables.push(`${uriVariable}  connection string of ${JSON.stringify(connection.name)}`);
  for (const name of storage.credentialNames ?? []) {
    variables.push(`${name}  credential of storage ${JSON.stringify(storage.name)}`);
  }

  const out: string[] = [];
  out.push(`/** Plan ${JSON.stringify(plan.name)}. */`);
  out.push(`export const ${identifier} = defineConfig({`);
  out.push(`  source: { uri: process.env.${uriVariable} },`);
  out.push(`  storage: ${JSON.stringify(storageLocation(storage, dataDir))},`);
  out.push(`  compression: ${JSON.stringify(plan.compression)},`);

  if (plan.encryption.kind === "recipients") {
    out.push(`  encryption: { recipients: ${JSON.stringify(plan.encryption.recipients)} },`);
  } else if (plan.encryption.kind === "passphrase") {
    const variable = `MONGOSHIELD_PASSPHRASE_${envSuffix(plan.name)}`;
    variables.push(`${variable}  backup passphrase of plan ${JSON.stringify(plan.name)}`);
    out.push(`  encryption: { passphrase: process.env.${variable} },`);
  }

  const backup: string[] = [];
  if (plan.include.length > 0) backup.push(`include: ${JSON.stringify(plan.include)}`);
  if (plan.exclude.length > 0) backup.push(`exclude: ${JSON.stringify(plan.exclude)}`);
  backup.push(`consistency: ${JSON.stringify(plan.consistency)}`);
  if (plan.incremental !== undefined) {
    backup.push(
      `incremental: { fullEveryDays: ${JSON.stringify(plan.incremental.fullEveryDays)} }`,
    );
  }
  out.push(`  backup: { ${backup.join(", ")} },`);

  if (plan.retention !== undefined) out.push(`  retention: ${JSON.stringify(plan.retention)},`);
  if (plan.schedule !== undefined) {
    out.push(
      `  schedule: { cron: ${JSON.stringify(plan.schedule.cron)}, timezone: ${JSON.stringify(plan.schedule.timezone)}, verify: ${JSON.stringify(plan.verify)} },`,
    );
  }
  if (plan.notify.length > 0) {
    out.push("  notify: [");
    plan.notify.forEach((target, index) => {
      const variable = `MONGOSHIELD_NOTIFY_${envSuffix(plan.name)}_${index + 1}`;
      variables.push(`${variable}  ${target.type} URL of plan ${JSON.stringify(plan.name)}`);
      out.push(
        `    { type: ${JSON.stringify(target.type)}, url: process.env.${variable}, on: ["success", "failure"] },`,
      );
    });
    out.push("  ],");
  }
  out.push("});", "");
  return out.join("\n");
}

/** Where the CLI should find the backups: local paths become absolute. */
function storageLocation(storage: StorageRecord, dataDir: string): string {
  return storageSchemeOf(storage.url) === "file" ? localPathOf(storage.url, dataDir) : storage.url;
}

/** `Prod EU (main)` → `PROD_EU_MAIN`. */
function envSuffix(name: string): string {
  const suffix = name
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return suffix === "" ? "UNNAMED" : suffix;
}

/**
 * `nightly prod` → `planNightlyProd`, unique within the file. The `plan` prefix
 * means an identifier can never start with a digit or be a reserved word
 * (`delete`, `default`, …).
 */
function uniqueIdentifier(name: string, taken: Set<string>): string {
  const words = name.split(/[^A-Za-z0-9]+/).filter((word) => word.length > 0);
  const base = `plan${words
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join("")}`;
  let identifier = base;
  for (let counter = 2; taken.has(identifier); counter++) identifier = `${base}${counter}`;
  taken.add(identifier);
  return identifier;
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}
