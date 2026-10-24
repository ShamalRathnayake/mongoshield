/**
 * Importing a `mongoshield.config.ts` (as JSON) into the console: the inverse of
 * config-export.ts.
 *
 *   parseImportRequest   checks the request body: the document, the plan name, the
 *                        secrets given as separate fields, and dry run or not
 *   planImport           validates every config and works out what to create or
 *                        change in a given state; pure and synchronous, so the route
 *                        runs it once for the dry run and again INSIDE the state
 *                        update that applies it (nothing can change in between)
 *
 * Validation uses the library's own `ConfigSchema` (exported by `mongoshield`), so
 * the console accepts exactly the keys, types and enums the CLI does and cannot
 * drift from it. The console also has to do more than the schema does:
 *
 * - **No secrets in the document.** A connection string with a password (or a
 *   secret query option), `encryption.passphrase`, notification URLs and
 *   `decryption` are refused: the document is pasted text that ends up in browser
 *   history, clipboards and tickets. Secrets come in `secrets`, per plan.
 * - **Nothing silently weaker.** Settings the console cannot manage but that
 *   protect backups (`encryption.kms`, `backup.retainDays`, `schedule.verify:
 *   "drill"`) are refused instead of dropped, because the imported plan would back
 *   up with less protection than the file says. Other unmanaged settings (tuning,
 *   locks, retries, replication, guard, heartbeat) become warnings.
 *
 * Mapping onto console records:
 *   connection  matched by its redacted URI (host and user, no password); new ones
 *               are created and marked production (the safe default for restores)
 *   storage     matched by URL; new ones are created (credentials from `secrets`)
 *   plan        matched by name: created, or updated field by field
 * Existing connections and storage are never changed by an import (their secrets
 * included); the import only adds what is missing and updates plans.
 */

import {
  ConfigSchema,
  isMongoShieldError,
  type MongoShieldConfig,
  redactMongoUri,
} from "mongoshield";
import { checkSchedule } from "../jobs/schedules.ts";
import { checkStorageInput } from "../jobs/storage.ts";
import type { ConfigImportChange, ConfigImportResult, ConfigImportSecrets } from "../shared/api.ts";
import { randomId } from "../state/crypto.ts";
import { redactUrlToOrigin } from "../state/redact.ts";
import {
  sealConnectionUri,
  sealNotifyUrl,
  sealPlanPassphrase,
  sealStorageCredentials,
} from "../state/secrets.ts";
import type { StateStore } from "../state/store.ts";
import type {
  ConnectionRecord,
  ConsoleState,
  MutableState,
  NotifyRecord,
  PlanEncryptionRecord,
  PlanRecord,
  StorageRecord,
} from "../state/types.ts";
import { invalid } from "./errors.ts";
import {
  asObject,
  type Fields,
  optionalString,
  optionalStringArray,
  optionalStringMap,
  requiredBoolean,
} from "./validate.ts";

/** Most plans one import may contain. */
const MAX_PLANS = 50;
/** Name of the plan when the document is a single config and no name is given. */
export const DEFAULT_PLAN_NAME = "Imported plan";
/** Same limits as the routes that create these records by hand. */
const MAX_NAME_LENGTH = 100;
const MAX_URI_LENGTH = 4096;
const MAX_STORAGE_URL_LENGTH = 1024;
const MAX_CREDENTIAL_LENGTH = 16 * 1024;
const MAX_NOTIFY = 10;
const MAX_RECIPIENTS = 20;
const MAX_RETENTION = 1000;
const MIN_PASSPHRASE_LENGTH = 12;

/**
 * Connection string options that carry secrets. The same list the library's
 * `redactMongoUri` scrubs (src/redact.ts in `mongoshield`); kept here because the
 * library does not export it.
 */
const SECRET_URI_OPTIONS = new Set([
  "password",
  "authmechanismproperties",
  "tlscertificatekeyfilepassword",
  "aws_session_token",
  "secret",
  "token",
]);

/** A checked import request. */
export interface ImportRequest {
  /** Raw configs by plan name (validated by {@link planImport}). */
  readonly configs: ReadonlyMap<string, Fields>;
  readonly secrets: ReadonlyMap<string, ConfigImportSecrets>;
  readonly dryRun: boolean;
}

/** What {@link planImport} decided: the answer for the client, and how to apply it. */
export interface ImportPlan {
  readonly result: ConfigImportResult;
  /** Applies the plan to a state draft (inside `StateStore.update`). */
  applyTo(draft: MutableState): void;
  /** Created and changed records, for the audit log. */
  readonly createdConnections: readonly ConnectionRecord[];
  readonly createdStorage: readonly StorageRecord[];
  readonly createdPlans: readonly PlanRecord[];
  readonly updatedPlans: readonly PlanRecord[];
}

/** What planning needs besides the state. */
export interface ImportContext {
  /** Seals secrets (the record ids are part of each ciphertext's context). */
  readonly store: StateStore;
  readonly dataDir: string;
  readonly now: Date;
}

// ---------------------------------------------------------------------------
// The request
// ---------------------------------------------------------------------------

/** Checks a `POST /api/config/import` body. */
export function parseImportRequest(body: Fields): ImportRequest {
  const dryRun = requiredBoolean(body, "dryRun");
  const document = asObject(body.document, '"document"');
  const planName = optionalString(body, "planName", MAX_NAME_LENGTH)?.trim() || DEFAULT_PLAN_NAME;
  checkName(planName, '"planName"');

  const configs = new Map<string, Fields>();
  if (Object.hasOwn(document, "storage")) {
    configs.set(planName, document);
  } else {
    const entries = Object.entries(document);
    if (entries.length === 0) {
      throw invalid(
        '"document" is empty.',
        'Paste a config (with "storage"), or configs keyed by plan name.',
      );
    }
    if (entries.length > MAX_PLANS) throw invalid(`An import holds at most ${MAX_PLANS} plans.`);
    for (const [name, value] of entries) {
      checkName(name, `The plan name ${JSON.stringify(name.slice(0, 40))}`);
      const config = asObject(value, `"document.${name}"`);
      if (!Object.hasOwn(config, "storage")) {
        throw invalid(
          `"document.${name}" is not a config: it has no "storage".`,
          "A document is either one config, or an object of configs by plan name.",
        );
      }
      configs.set(name.trim(), config);
    }
  }

  const secrets = parseSecrets(body.secrets, configs);
  return { configs, secrets, dryRun };
}

/** The `secrets` field: per plan name, only known fields, only for plans in the document. */
function parseSecrets(
  value: unknown,
  configs: ReadonlyMap<string, Fields>,
): ReadonlyMap<string, ConfigImportSecrets> {
  const secrets = new Map<string, ConfigImportSecrets>();
  if (value === undefined || value === null) return secrets;
  for (const [name, entry] of Object.entries(asObject(value, '"secrets"'))) {
    if (!configs.has(name)) {
      throw invalid(
        `"secrets" names the plan ${JSON.stringify(name.slice(0, 40))}, which the document does not contain.`,
      );
    }
    const fields = asObject(entry, `"secrets.${name}"`);
    // Unknown fields are refused here (not ignored as elsewhere): a misspelt
    // "passphrase" must not silently import a plan without its secret.
    rejectUnknownKeys(
      fields,
      ["uri", "passphrase", "notifyUrls", "storageCredentials"],
      `secrets.${name}`,
    );
    const uri = optionalString(fields, "uri", MAX_URI_LENGTH);
    const passphrase = optionalString(fields, "passphrase", 1024);
    const notifyUrls = optionalStringArray(fields, "notifyUrls", {
      maxItems: MAX_NOTIFY,
      maxLength: 2048,
    });
    const storageCredentials = optionalStringMap(fields, "storageCredentials", {
      maxEntries: 10,
      maxLength: MAX_CREDENTIAL_LENGTH,
    });
    secrets.set(name, {
      ...(uri === undefined ? {} : { uri: uri.trim() }),
      ...(passphrase === undefined ? {} : { passphrase }),
      ...(notifyUrls === undefined ? {} : { notifyUrls }),
      ...(storageCredentials === undefined ? {} : { storageCredentials }),
    });
  }
  return secrets;
}

// ---------------------------------------------------------------------------
// One config → what the console stores
// ---------------------------------------------------------------------------

/** A config, validated and reduced to what a console plan holds. Secrets not yet resolved. */
interface ImportedConfig {
  readonly name: string;
  /** From `source.uri` (credential-free) or `secrets.uri`; absent: keep the plan's connection. */
  readonly uri: string | undefined;
  readonly storageUrl: string;
  readonly compression: PlanRecord["compression"];
  /** `passphrase`: from secrets, or the plan's stored one. */
  readonly encryption:
    | { readonly kind: "none" }
    | { readonly kind: "recipients"; readonly recipients: readonly string[] }
    | { readonly kind: "passphrase" };
  readonly include: readonly string[];
  readonly exclude: readonly string[];
  readonly consistency: PlanRecord["consistency"];
  readonly schedule: PlanRecord["schedule"];
  readonly retention: PlanRecord["retention"];
  readonly verify: PlanRecord["verify"];
  readonly notifyTypes: readonly NotifyRecord["type"][];
}

/** Top-level config keys the console maps onto a plan; every other known key is a warning. */
const MANAGED_KEYS: readonly string[] = [
  "source",
  "storage",
  "compression",
  "encryption",
  "backup",
  "retention",
  "schedule",
  "notify",
];
/** Keys of `backup`, `retention` and `schedule` that a console plan holds. */
const MANAGED_BACKUP_KEYS: readonly string[] = ["include", "exclude", "consistency"];
const RETENTION_BUCKETS = ["last", "daily", "weekly", "monthly", "yearly"] as const;
const MANAGED_SCHEDULE_KEYS: readonly string[] = ["cron", "timezone", "verify"];

/**
 * Stand-ins for the secrets a document must leave out. The library's schema
 * requires them (`encryption` needs a passphrase, recipients or KMS; a notify
 * target needs a URL), so the copy that is validated carries these instead. The
 * real values come from `secrets` (or the stored plan) and are checked when they
 * are resolved; the stand-ins never reach a record.
 */
const PASSPHRASE_STAND_IN = "secret-given-separately";
const NOTIFY_URL_STAND_IN = "https://secret-given-separately.invalid/";

/**
 * Validates one config (see the file header for the rules), in three steps:
 *
 *   1. console rules on the raw document: no secrets, nothing silently weaker
 *   2. the library's `ConfigSchema`: keys, types, enums, limits (one source of truth)
 *   3. console rules on the typed result: record limits, age recipients, cron,
 *      and warnings for settings the console does not manage
 *
 * Step 1 runs first so that, for example, `verify: "drill"` is refused with the
 * console's reason instead of the schema's "needs a drill section".
 */
function readConfig(
  name: string,
  document: Fields,
  secrets: ConfigImportSecrets,
  warnings: string[],
): ImportedConfig {
  const where = (path: string): string => `Plan ${JSON.stringify(name)}: ${path}`;
  refuseSecretsAndWeakerProtection(where, document);
  const config = validateWithLibrarySchema(where, withSecretStandIns(document));
  warnAboutUnmanagedSettings(where, config, warnings);

  const encryption = readEncryption(where, config.encryption, secrets.passphrase);
  const notifyTypes = (config.notify ?? []).map((target) => target.type);
  if (notifyTypes.length > MAX_NOTIFY) {
    throw invalid(`${where("notify")} must be a list of at most ${MAX_NOTIFY} targets.`);
  }
  if ((secrets.notifyUrls?.length ?? 0) > notifyTypes.length) {
    throw invalid(
      `${where("secrets.notifyUrls")} has more URLs than the config has notify targets.`,
    );
  }
  const schedule = readSchedule(where, config.schedule);
  return {
    name,
    uri: readUri(where, config.source?.uri, secrets.uri),
    storageUrl: readStorageUrl(where, config.storage),
    compression: config.compression ?? "zstd",
    encryption,
    include: checkPatterns(where("backup.include"), config.backup?.include ?? []),
    exclude: checkPatterns(where("backup.exclude"), config.backup?.exclude ?? []),
    consistency: config.backup?.consistency ?? "auto",
    schedule: schedule.schedule,
    verify: schedule.verify,
    retention: readRetention(where, config.retention),
    notifyTypes,
  };
}

/** Step 1: secrets and protections the console cannot keep are refused by name. */
function refuseSecretsAndWeakerProtection(where: (path: string) => string, document: Fields): void {
  if (Object.hasOwn(document, "decryption")) {
    throw invalid(
      `${where("decryption")} holds secrets and cannot be imported.`,
      "The console reads encrypted backups with the passphrase it stores, or keys given at restore time.",
    );
  }
  const documentUri = property(document.source, "uri");
  if (typeof documentUri === "string" && hasInlineCredentials(documentUri)) {
    throw invalid(
      `${where("source.uri")} contains a password or another secret.`,
      "Leave it out of the document (or remove the password) and pass the full connection string in secrets.<plan>.uri.",
    );
  }
  if (property(document.encryption, "passphrase") !== undefined) {
    throw invalid(
      `${where("encryption.passphrase")} must not be in the document.`,
      'Use "encryption": {} and pass the passphrase in secrets.<plan>.passphrase.',
    );
  }
  if (property(document.encryption, "kms") !== undefined) {
    // Dropping KMS would import a plan that encrypts differently than the file says.
    throw invalid(
      `${where("encryption.kms")}: the console cannot manage KMS-wrapped encryption yet.`,
      "Run this config from the CLI, or use age recipients in the console.",
    );
  }
  if (property(document.backup, "retainDays") !== undefined) {
    // Ignoring it would quietly turn write-once backups into deletable ones.
    throw invalid(
      `${where("backup.retainDays")}: the console cannot make backups write-once yet.`,
      "Run this config from the CLI, or remove retainDays to import it without object lock.",
    );
  }
  if (property(document.schedule, "verify") === "drill") {
    throw invalid(
      `${where('schedule.verify "drill"')}: the console verifies plans with "fast" or "deep".`,
      "Use a drill from the backup's page, or run this config from the CLI.",
    );
  }
  if (Array.isArray(document.notify)) {
    document.notify.forEach((target: unknown, index) => {
      if (property(target, "url") !== undefined) {
        // Webhook URLs usually embed a token (Slack, Discord): they are secrets.
        throw invalid(
          `${where(`notify[${index}].url`)} must not be in the document.`,
          `Pass it in secrets.<plan>.notifyUrls[${index}].`,
        );
      }
    });
  }
}

/**
 * A copy of the document with stand-ins where secrets were left out (see
 * {@link PASSPHRASE_STAND_IN}). Only `encryption: {}` (passphrase encryption)
 * and notify targets get one; anything malformed is left for the schema to name.
 */
function withSecretStandIns(document: Fields): Fields {
  const copy: Record<string, unknown> = { ...document };
  const encryption = document.encryption;
  if (isPlainObject(encryption) && encryption.recipients === undefined) {
    copy.encryption = { ...encryption, passphrase: PASSPHRASE_STAND_IN };
  }
  if (Array.isArray(document.notify)) {
    copy.notify = document.notify.map((target: unknown) =>
      isPlainObject(target) ? { ...target, url: NOTIFY_URL_STAND_IN } : target,
    );
  }
  return copy;
}

/** Step 2: the library's own schema, with its problems as one readable 400. */
function validateWithLibrarySchema(
  where: (path: string) => string,
  document: Fields,
): MongoShieldConfig {
  const result = ConfigSchema.safeParse(document);
  if (result.success) return result.data;
  // A handful is enough to fix a pasted document; zod's messages name the
  // expected types and options, never the values given (no secrets echoed).
  const problems = result.error.issues
    .slice(0, 5)
    .map((issue) => {
      const path = formatPath(issue.path);
      return path === "" ? issue.message : `${path}: ${issue.message}`;
    })
    .join("; ");
  throw invalid(
    `${where("")}the config is invalid: ${problems}.`,
    "Fix these settings in the document and import again.",
  );
}

/** `["notify", 0, "type"]` → `notify[0].type`. */
function formatPath(path: readonly PropertyKey[]): string {
  let text = "";
  for (const segment of path) {
    if (typeof segment === "number") text += `[${segment}]`;
    else text += text === "" ? String(segment) : `.${String(segment)}`;
  }
  return text;
}

/**
 * Step 3a: settings the library knows but the console does not manage are
 * ignored with a warning (tuning, locks, retries, replication, guard, journal…).
 * Derived from the validated config, so settings added to the library later are
 * reported too instead of being refused as unknown.
 */
function warnAboutUnmanagedSettings(
  where: (path: string) => string,
  config: MongoShieldConfig,
  warnings: string[],
): void {
  const ignored = (path: string): void => {
    warnings.push(`${where(path)} is not managed by the console and was ignored.`);
  };
  for (const key of Object.keys(config)) {
    if (!MANAGED_KEYS.includes(key)) ignored(key);
  }
  for (const key of Object.keys(config.backup ?? {})) {
    if (!MANAGED_BACKUP_KEYS.includes(key)) ignored(`backup.${key}`);
  }
  for (const key of Object.keys(config.retention ?? {})) {
    if (!RETENTION_BUCKETS.some((bucket) => bucket === key)) ignored(`retention.${key}`);
  }
  for (const key of Object.keys(config.schedule ?? {})) {
    if (!MANAGED_SCHEDULE_KEYS.includes(key)) ignored(`schedule.${key}`);
  }
  config.notify?.forEach((target, index) => {
    if (target.on !== undefined) {
      warnings.push(
        `${where(`notify[${index}].on`)} was ignored: the console notifies on success and failure.`,
      );
    }
  });
}

/** `source.uri` (credential-free, checked in step 1), or the explicitly given secret URI. */
function readUri(
  where: (path: string) => string,
  documentUri: string | undefined,
  secretUri: string | undefined,
): string | undefined {
  const uri = secretUri ?? documentUri;
  if (uri === undefined) return undefined;
  if (uri.length > MAX_URI_LENGTH) {
    throw invalid(`${where("source.uri")} must be at most ${MAX_URI_LENGTH} characters.`);
  }
  if (!/^mongodb(\+srv)?:\/\//i.test(uri)) {
    throw invalid(`${where("source.uri")} must start with mongodb:// or mongodb+srv://.`);
  }
  return uri;
}

/**
 * True when a connection string carries a secret: a password in the user info
 * (`user:pass@`, even an empty one) or a secret option in the query string.
 */
export function hasInlineCredentials(uri: string): boolean {
  const userInfo = /^mongodb(?:\+srv)?:\/\/([^@/]+)@/i.exec(uri)?.[1];
  if (userInfo?.includes(":") === true) return true;
  const queryStart = uri.indexOf("?");
  if (queryStart === -1) return false;
  for (const key of new URLSearchParams(uri.slice(queryStart + 1)).keys()) {
    if (SECRET_URI_OPTIONS.has(key.toLowerCase())) return true;
  }
  return false;
}

/** The storage URL. The schema also allows adapter objects, which JSON cannot carry. */
function readStorageUrl(
  where: (path: string) => string,
  storage: MongoShieldConfig["storage"],
): string {
  if (typeof storage !== "string" || storage.length > MAX_STORAGE_URL_LENGTH) {
    throw invalid(
      `${where("storage")} must be a storage URL (at most ${MAX_STORAGE_URL_LENGTH} characters) such as s3://bucket/prefix.`,
    );
  }
  return storage;
}

function readEncryption(
  where: (path: string) => string,
  encryption: MongoShieldConfig["encryption"],
  secretPassphrase: string | undefined,
): ImportedConfig["encryption"] {
  if (encryption === undefined) {
    if (secretPassphrase !== undefined) {
      throw invalid(
        `${where("secrets.passphrase")} is given but the config has no encryption section.`,
        'Add "encryption": {} to use passphrase encryption.',
      );
    }
    return { kind: "none" };
  }
  if (encryption.recipients === undefined) {
    // `encryption: {}`: what the export's unset `process.env` passphrase reference becomes.
    return { kind: "passphrase" };
  }
  if (secretPassphrase !== undefined) {
    throw invalid(`${where("encryption")}: a passphrase cannot be combined with recipients.`);
  }
  const recipients = encryption.recipients;
  if (
    recipients.length > MAX_RECIPIENTS ||
    !recipients.every((recipient) => recipient.startsWith("age1") && recipient.length <= 200)
  ) {
    throw invalid(
      `${where("encryption.recipients")} must list at most ${MAX_RECIPIENTS} age public keys (age1…).`,
    );
  }
  return { kind: "recipients", recipients };
}

/** Namespace patterns: the same limits as the plan routes (the schema has none). */
function checkPatterns(path: string, patterns: readonly string[]): readonly string[] {
  if (patterns.length > 100 || patterns.some((pattern) => pattern.length > 200)) {
    throw invalid(`${path} must be a list of at most 100 patterns of at most 200 characters.`);
  }
  return patterns;
}

/** The retention buckets a plan holds, each at most {@link MAX_RETENTION}. */
function readRetention(
  where: (path: string) => string,
  retention: MongoShieldConfig["retention"],
): PlanRecord["retention"] {
  if (retention === undefined) return undefined;
  const kept: Record<string, number> = {};
  for (const bucket of RETENTION_BUCKETS) {
    const count = retention[bucket];
    if (count === undefined) continue;
    if (count > MAX_RETENTION) {
      throw invalid(
        `${where(`retention.${bucket}`)} must be a whole number between 1 and ${MAX_RETENTION}.`,
      );
    }
    kept[bucket] = count;
  }
  return Object.keys(kept).length === 0 ? undefined : kept;
}

function readSchedule(
  where: (path: string) => string,
  schedule: MongoShieldConfig["schedule"],
): { readonly schedule: PlanRecord["schedule"]; readonly verify: PlanRecord["verify"] } {
  if (schedule === undefined) return { schedule: undefined, verify: "fast" };
  const timezone = schedule.timezone ?? "UTC";
  if (schedule.cron.length > 100 || timezone.length > 64) {
    throw invalid(`${where("schedule")}: the cron expression or time zone is too long.`);
  }
  checkSchedule(schedule.cron, timezone);
  const verify = schedule.verify ?? "fast";
  if (verify === "drill") {
    // Refused in step 1 already; narrowing the type here keeps the record honest.
    throw invalid(
      `${where('schedule.verify "drill"')}: the console verifies plans with "fast" or "deep".`,
    );
  }
  return { schedule: { cron: schedule.cron, timezone }, verify };
}

// ---------------------------------------------------------------------------
// Planning against the console's state
// ---------------------------------------------------------------------------

/**
 * Works out the import against `state`. Pure apart from sealing secrets (which
 * only encrypts), so the route can call it inside `StateStore.update`.
 *
 * @throws ConsoleError 400 naming the plan and field for anything not importable.
 */
export function planImport(
  state: ConsoleState,
  request: ImportRequest,
  context: ImportContext,
): ImportPlan {
  const warnings: string[] = [];
  const changes: ConfigImportChange[] = [];
  const createdConnections: ConnectionRecord[] = [];
  const createdStorage: StorageRecord[] = [];
  const createdPlans: PlanRecord[] = [];
  const updatedPlans: PlanRecord[] = [];
  const at = context.now.toISOString();

  /** Every connection, existing or created by this import. */
  const connections = (): ConnectionRecord[] => [...state.connections, ...createdConnections];
  const locations = (): StorageRecord[] => [...state.storage, ...createdStorage];

  for (const [name, raw] of request.configs) {
    const secrets = request.secrets.get(name) ?? {};
    const config = readConfig(name, raw, secrets, warnings);
    const existing = state.plans.find((plan) => plan.name === name);
    const planId = existing?.id ?? randomId();

    const connection = resolveConnection(config, existing, connections(), context, at);
    if (connection.created) {
      createdConnections.push(connection.record);
      changes.push({
        kind: "connection",
        name: connection.record.name,
        action: "create",
        fields: [
          { field: "uri", to: connection.record.uriPreview },
          { field: "production", to: "true" },
        ],
      });
    } else if (secrets.uri !== undefined) {
      warnings.push(
        `Plan ${JSON.stringify(name)} uses the existing connection ${JSON.stringify(connection.record.name)}; its stored connection string was kept.`,
      );
    }

    const storage = resolveStorage(config, secrets, locations(), context, at, name);
    if (storage.created) {
      createdStorage.push(storage.record);
      changes.push({
        kind: "storage",
        name: storage.record.name,
        action: "create",
        fields: [
          { field: "url", to: storage.record.url },
          ...((storage.record.credentialNames ?? []).length > 0
            ? [{ field: "credentials", to: (storage.record.credentialNames ?? []).join(", ") }]
            : []),
        ],
      });
    } else if (secrets.storageCredentials !== undefined) {
      warnings.push(
        `Plan ${JSON.stringify(name)} uses the existing storage ${JSON.stringify(storage.record.name)}; its stored credentials were kept.`,
      );
    }

    const record: PlanRecord = {
      id: planId,
      name,
      connectionId: connection.record.id,
      storageId: storage.record.id,
      include: config.include,
      exclude: config.exclude,
      compression: config.compression,
      encryption: resolveEncryption(config, secrets, existing, planId, context.store),
      consistency: config.consistency,
      verify: config.verify,
      notify: resolveNotify(config, secrets, existing, planId, context.store),
      createdAt: existing?.createdAt ?? at,
      ...(config.schedule === undefined ? {} : { schedule: config.schedule }),
      ...(config.retention === undefined ? {} : { retention: config.retention }),
    };

    if (existing === undefined) {
      createdPlans.push(record);
      changes.push({
        kind: "plan",
        name,
        action: "create",
        fields: describePlan(record, connections(), locations()),
      });
    } else {
      const fields = diffPlans(existing, record, secrets, connections(), locations());
      if (fields.length > 0) updatedPlans.push(record);
      changes.push({
        kind: "plan",
        name,
        action: fields.length > 0 ? "update" : "unchanged",
        fields,
      });
    }
  }

  return {
    result: { dryRun: request.dryRun, changes, warnings },
    createdConnections,
    createdStorage,
    createdPlans,
    updatedPlans,
    applyTo(draft) {
      draft.connections = [...draft.connections, ...createdConnections];
      draft.storage = [...draft.storage, ...createdStorage];
      const updates = new Map(updatedPlans.map((plan) => [plan.id, plan]));
      draft.plans = [...draft.plans.map((plan) => updates.get(plan.id) ?? plan), ...createdPlans];
    },
  };
}

/** The plan's connection: an existing one with the same redacted URI, a new one, or the plan's own. */
function resolveConnection(
  config: ImportedConfig,
  existing: PlanRecord | undefined,
  connections: readonly ConnectionRecord[],
  context: ImportContext,
  at: string,
): { readonly record: ConnectionRecord; readonly created: boolean } {
  if (config.uri === undefined) {
    const kept = connections.find((connection) => connection.id === existing?.connectionId);
    if (kept === undefined) {
      throw invalid(
        `Plan ${JSON.stringify(config.name)} needs a connection string.`,
        "Set source.uri (without the password) or pass the full one in secrets.<plan>.uri.",
      );
    }
    return { record: kept, created: false };
  }
  const preview = redactMongoUri(config.uri);
  const match = connections.find((connection) => connection.uriPreview === preview);
  if (match !== undefined) return { record: match, created: false };
  const id = randomId();
  return {
    created: true,
    record: {
      id,
      name: uniqueName(
        hostsOf(preview),
        connections.map((connection) => connection.name),
      ),
      uri: sealConnectionUri(context.store, id, config.uri),
      uriPreview: preview,
      // Production is the safe default: operators cannot restore into it until an
      // admin who knows the deployment says otherwise.
      production: true,
      createdAt: at,
    },
  };
}

/** `mongodb+srv://app:***@cluster0.example.net/db?x` → `cluster0.example.net`. */
function hostsOf(preview: string): string {
  const withoutScheme = preview.replace(/^mongodb(\+srv)?:\/\//i, "");
  const withoutUser = withoutScheme.slice(withoutScheme.indexOf("@") + 1);
  const hosts = withoutUser.split(/[/?]/)[0] ?? "";
  return hosts === "" ? "Imported connection" : hosts.slice(0, MAX_NAME_LENGTH - 5);
}

/** The plan's storage: an existing location with the same URL, or a new one. */
function resolveStorage(
  config: ImportedConfig,
  secrets: ConfigImportSecrets,
  locations: readonly StorageRecord[],
  context: ImportContext,
  at: string,
  planName: string,
): { readonly record: StorageRecord; readonly created: boolean } {
  const match = locations.find((location) => location.url === config.storageUrl);
  if (match !== undefined) return { record: match, created: false };
  const credentials = secrets.storageCredentials ?? {};
  try {
    checkStorageInput(config.storageUrl, Object.keys(credentials), context.dataDir);
  } catch (error) {
    if (!isMongoShieldError(error)) throw error;
    throw invalid(`Plan ${JSON.stringify(planName)}: storage: ${error.message}`, error.hint);
  }
  const id = randomId();
  const names = Object.keys(credentials).sort();
  return {
    created: true,
    record: {
      id,
      name: uniqueName(
        config.storageUrl.slice(0, MAX_NAME_LENGTH - 5),
        locations.map((location) => location.name),
      ),
      url: config.storageUrl,
      createdAt: at,
      updatedAt: at,
      ...(names.length === 0
        ? {}
        : {
            credentials: sealStorageCredentials(context.store, id, credentials),
            credentialNames: names,
          }),
    },
  };
}

function resolveEncryption(
  config: ImportedConfig,
  secrets: ConfigImportSecrets,
  existing: PlanRecord | undefined,
  planId: string,
  store: StateStore,
): PlanEncryptionRecord {
  if (config.encryption.kind !== "passphrase") return config.encryption;
  if (secrets.passphrase !== undefined) {
    if (secrets.passphrase.length < MIN_PASSPHRASE_LENGTH) {
      throw invalid(
        `Plan ${JSON.stringify(config.name)}: the backup passphrase must be at least ${MIN_PASSPHRASE_LENGTH} characters long.`,
      );
    }
    return {
      kind: "passphrase",
      passphrase: sealPlanPassphrase(store, planId, secrets.passphrase),
    };
  }
  if (existing?.encryption.kind === "passphrase") return existing.encryption;
  throw invalid(
    `Plan ${JSON.stringify(config.name)} uses passphrase encryption but no passphrase was given.`,
    "Pass it in secrets.<plan>.passphrase.",
  );
}

function resolveNotify(
  config: ImportedConfig,
  secrets: ConfigImportSecrets,
  existing: PlanRecord | undefined,
  planId: string,
  store: StateStore,
): NotifyRecord[] {
  return config.notifyTypes.map((type, index): NotifyRecord => {
    const url = secrets.notifyUrls?.[index];
    if (url !== undefined) {
      if (!/^https?:\/\//i.test(url)) {
        throw invalid(
          `Plan ${JSON.stringify(config.name)}: notifyUrls[${index}] must be an http(s) URL.`,
        );
      }
      return { type, url: sealNotifyUrl(store, planId, url), urlPreview: redactUrlToOrigin(url) };
    }
    const kept = existing?.notify[index];
    if (kept === undefined) {
      throw invalid(
        `Plan ${JSON.stringify(config.name)}: notify[${index}] needs a URL.`,
        `Pass it in secrets.<plan>.notifyUrls[${index}].`,
      );
    }
    return { ...kept, type };
  });
}

// ---------------------------------------------------------------------------
// Describing changes (never secrets)
// ---------------------------------------------------------------------------

type FieldChange = ConfigImportChange["fields"][number];

/** The settings of a new plan, as `to` values. */
function describePlan(
  plan: PlanRecord,
  connections: readonly ConnectionRecord[],
  locations: readonly StorageRecord[],
): FieldChange[] {
  return Object.entries(planSummary(plan, connections, locations)).map(([field, to]) => ({
    field,
    to,
  }));
}

/** Changed settings of an updated plan, plus replaced secrets (named, never shown). */
function diffPlans(
  before: PlanRecord,
  after: PlanRecord,
  secrets: ConfigImportSecrets,
  connections: readonly ConnectionRecord[],
  locations: readonly StorageRecord[],
): FieldChange[] {
  const old = planSummary(before, connections, locations);
  const next = planSummary(after, connections, locations);
  const fields: FieldChange[] = [];
  for (const [field, to] of Object.entries(next)) {
    const from = old[field];
    if (from !== to) fields.push({ field, ...(from === undefined ? {} : { from }), to });
  }
  if (secrets.passphrase !== undefined)
    fields.push({ field: "encryption.passphrase", from: "set", to: "replaced" });
  secrets.notifyUrls?.forEach((_url, index) => {
    fields.push({
      field: `notify[${index}].url`,
      from: before.notify[index] === undefined ? "none" : "set",
      to: "replaced",
    });
  });
  return fields;
}

/** A plan's settings as short strings, for comparing and showing. */
function planSummary(
  plan: PlanRecord,
  connections: readonly ConnectionRecord[],
  locations: readonly StorageRecord[],
): Record<string, string> {
  const encryption =
    plan.encryption.kind === "recipients"
      ? `recipients: ${plan.encryption.recipients.join(", ")}`
      : plan.encryption.kind;
  return {
    connection:
      connections.find((connection) => connection.id === plan.connectionId)?.name ??
      plan.connectionId,
    storage: locations.find((location) => location.id === plan.storageId)?.name ?? plan.storageId,
    include: plan.include.length === 0 ? "everything" : plan.include.join(", "),
    exclude: plan.exclude.length === 0 ? "nothing" : plan.exclude.join(", "),
    compression: plan.compression,
    encryption,
    consistency: plan.consistency,
    schedule:
      plan.schedule === undefined ? "manual" : `${plan.schedule.cron} (${plan.schedule.timezone})`,
    verify: plan.verify,
    retention: plan.retention === undefined ? "keep everything" : JSON.stringify(plan.retention),
    notify: plan.notify.length === 0 ? "none" : plan.notify.map((target) => target.type).join(", "),
  };
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** Names: non-empty, bounded, no control characters (same rule as the routes). */
function checkName(name: string, what: string): void {
  if (name.trim() === "" || name.length > MAX_NAME_LENGTH || hasControlCharacters(name)) {
    throw invalid(`${what} must be 1-${MAX_NAME_LENGTH} characters without control characters.`);
  }
}

/** `value[key]` when `value` is a plain object, else `undefined` (for raw, unvalidated JSON). */
function property(value: unknown, key: string): unknown {
  return isPlainObject(value) ? value[key] : undefined;
}

function isPlainObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function rejectUnknownKeys(fields: Fields, allowed: readonly string[], path: string): void {
  for (const key of Object.keys(fields)) {
    if (!allowed.includes(key)) {
      throw invalid(
        `${path} has an unknown setting ${JSON.stringify(key.slice(0, 40))}.`,
        `Known: ${allowed.join(", ")}.`,
      );
    }
  }
}

/** C0 control characters or DEL: refused in names, like the routes do (validate.ts). */
function hasControlCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/** `name`, or `name (2)`, `name (3)`, … when taken. */
function uniqueName(base: string, taken: readonly string[]): string {
  let name = base;
  for (let counter = 2; taken.includes(name); counter++) name = `${base} (${counter})`;
  return name;
}
