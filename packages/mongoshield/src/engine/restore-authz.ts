/**
 * Restoring users and custom roles (`restore({ usersAndRoles: "create" | "replace" })`)
 * from a backup taken with `includeUsersAndRoles` (see backup-authz.ts).
 *
 *   pre-flight   read + decrypt the "roles" and "users" entries (readUsersAndRoles)
 *   select       keep those of databases the include/exclude patterns select, and
 *                move them to the database the rename rules give (selectUsersAndRoles)
 *   roles        first, because users refer to them:
 *                  createRole for missing roles, WITHOUT inherited roles (a role may
 *                  inherit from another backed-up role not created yet), then
 *                  updateRole to add the inherited roles once all exist;
 *                  `replace` also updates existing roles with updateRole.
 *   users        the way mongorestore does it (mongorestore/metadata.go,
 *                RestoreUsersOrRoles): insert the backed-up user documents into a
 *                temporary collection in `admin`, then run the internal command
 *                  { _mergeAuthzCollections: 1, tempUsersCollection: "admin.<tmp>",
 *                    drop: false, db: "" }
 *                which copies them into `admin.system.users` WITH their password
 *                hashes and skips users that already exist. `replace` drops the
 *                existing ones first. The temporary collection has a unique name
 *                per run, so concurrent restores never mix their users, and is
 *                always dropped (see mergeUsers).
 *
 * `createUser` cannot take a password hash, only a password. So when the target
 * refuses the merge (Atlas, or a user without the `restore` role), users are created
 * with `createUser` and a random password nobody knows instead, and the report lists
 * them under `passwordResetRequired`. In `replace` mode, existing users are then
 * updated with `updateUser` (roles, custom data) and keep their current password.
 *
 * Users and roles that are not in the backup are never dropped or changed.
 *
 * Field order: backed-up users are parsed with their stored field order recorded and
 * written (to the temporary collection, or as `customData` of `createUser` /
 * `updateUser`) in that order (src/format/field-order.ts), so custom data with
 * integer-like field names comes back exactly as it was.
 */

import { randomBytes } from "node:crypto";
import {
  type Db,
  type Document,
  type MongoClient,
  MongoServerError,
  UUID,
  type WriteConcernSettings,
} from "mongodb";
import { isMongoShieldError, MongoShieldError, throwIfAborted } from "../errors.ts";
import {
  deserializeInStoredOrder,
  inStoredOrderAnywhere,
  valueInStoredOrder,
} from "../format/field-order.ts";
import { type AuthzEntry, isAuthzEntry, type Manifest } from "../format/manifest.ts";
import type { Logger } from "../logger.ts";
import {
  ATLAS_USERS_HINT,
  isAtlasRefusal,
  type NamespaceFilter,
  splitNamespace,
} from "../mongo/index.ts";
import type { UsersAndRolesMode, UsersAndRolesReport } from "../types.ts";
import { openDocumentStream, type StoredBackupSource } from "./read-pipeline.ts";
import { commandWriteConcern } from "./restore-collections.ts";
import type { NamespaceMapper } from "./restore-rename.ts";

/** Users and roles as stored in a backup (`system.users` / `system.roles` document shape). */
export interface AuthzDocuments {
  readonly users: readonly Document[];
  readonly roles: readonly Document[];
}

/** Settings shared by the restore steps. */
export interface AuthzRestoreSettings {
  readonly mode: Exclude<UsersAndRolesMode, "skip">;
  readonly logger: Logger;
  readonly writeConcern?: WriteConcernSettings | undefined;
  readonly signal?: AbortSignal | undefined;
}

/**
 * Server error codes meaning "you may not merge users here", which switch user
 * restores to `createUser`: 13 Unauthorized, 59 CommandNotFound, 115
 * CommandNotSupported, 8000 AtlasError (Atlas refuses writes to `admin` and internal
 * commands).
 */
const MERGE_REFUSED_CODES: ReadonlySet<number> = new Set([13, 59, 115, 8000]);

/** Server error code for "not authorized". */
const UNAUTHORIZED_CODE = 13;

/** Random bytes of the throwaway password given to users whose hash cannot be restored. */
const RANDOM_PASSWORD_BYTES = 32;

// ---------------------------------------------------------------------------
// Reading and selecting
// ---------------------------------------------------------------------------

/**
 * Reads the users and roles of a backup, or `undefined` when it has none (it was
 * taken without `includeUsersAndRoles`). Runs in pre-flight, so a damaged or
 * undecryptable file stops the restore before anything is written.
 */
export async function readUsersAndRoles(
  source: StoredBackupSource,
  manifest: Manifest,
  signal: AbortSignal | undefined,
): Promise<AuthzDocuments | undefined> {
  const entries = manifest.namespaces.filter(isAuthzEntry);
  if (entries.length === 0) return undefined;
  const users: Document[] = [];
  const roles: Document[] = [];
  for (const entry of entries) {
    const documents = await readEntryDocuments(source, entry, signal);
    (entry.type === "users" ? users : roles).push(...documents);
  }
  return { users, roles };
}

/** All documents of one users/roles entry (small: one per user or role). */
async function readEntryDocuments(
  source: StoredBackupSource,
  entry: AuthzEntry,
  signal: AbortSignal | undefined,
): Promise<Document[]> {
  const documents: Document[] = [];
  for (const file of entry.files) {
    for await (const raw of openDocumentStream(source, file, { signal })) {
      if (!(raw instanceof Uint8Array)) continue;
      documents.push(deserializeInStoredOrder(raw));
    }
  }
  return documents;
}

/**
 * Keeps the users and roles of databases the restore selects and moves them to
 * their target database. Pure; unit-tested.
 *
 * - A user or role of database D is kept when `filter` accepts `D.system.users`
 *   (users) or `D.system.roles` (roles): `app.*` and `*` select them, `app.orders`
 *   does not, `app.system.users` does.
 * - D's target is where the rename rules send D's namespaces (`app.*` → `app2.*`).
 *   Role references and privilege resources move along: `readWrite@app` becomes
 *   `readWrite@app2`, a privilege on `app.orders` follows that collection's rename.
 * - A user moved to another database gets a new `userId`: it is a different user,
 *   and the original may well still exist next to it.
 */
export function selectUsersAndRoles(
  backup: AuthzDocuments,
  rules: { readonly filter: NamespaceFilter; readonly rename: NamespaceMapper },
): { users: Document[]; roles: Document[] } {
  const targetDatabase = (database: string): string =>
    splitNamespace(rules.rename(`${database}.system.users`)).database;

  const roles: Document[] = [];
  for (const role of backup.roles) {
    const database = stringField(role, "db");
    const name = stringField(role, "role");
    if (database === undefined || name === undefined) continue;
    if (!rules.filter(`${database}.system.roles`)) continue;
    const target = targetDatabase(database);
    roles.push({
      ...role,
      _id: `${target}.${name}`,
      db: target,
      privileges: documentsIn(role.privileges).map((privilege) =>
        movePrivilege(privilege, rules.rename, targetDatabase),
      ),
      roles: documentsIn(role.roles).map((reference) =>
        moveRoleReference(reference, targetDatabase),
      ),
    });
  }

  const users: Document[] = [];
  for (const user of backup.users) {
    const database = stringField(user, "db");
    const name = stringField(user, "user");
    if (database === undefined || name === undefined) continue;
    if (!rules.filter(`${database}.system.users`)) continue;
    const target = targetDatabase(database);
    users.push({
      ...user,
      _id: `${target}.${name}`,
      db: target,
      ...(target === database || user.userId === undefined ? {} : { userId: new UUID() }),
      roles: documentsIn(user.roles).map((reference) =>
        moveRoleReference(reference, targetDatabase),
      ),
    });
  }
  return { users, roles };
}

/** `{ role, db }` with the database renamed. */
function moveRoleReference(reference: Document, targetDatabase: (db: string) => string): Document {
  const database = stringField(reference, "db");
  return database === undefined ? reference : { ...reference, db: targetDatabase(database) };
}

/**
 * A privilege with its resource renamed. `db: ""` / `collection: ""` mean "any", and
 * `{ cluster: true }` / `{ anyResource: true }` have no namespace: those stay as they are.
 */
function movePrivilege(
  privilege: Document,
  rename: NamespaceMapper,
  targetDatabase: (db: string) => string,
): Document {
  const resource: unknown = privilege.resource;
  if (!isDocument(resource)) return privilege;
  const database = stringField(resource, "db");
  const collection = stringField(resource, "collection");
  if (database === undefined || database === "") return privilege;
  if (collection === undefined || collection === "") {
    return { ...privilege, resource: { ...resource, db: targetDatabase(database) } };
  }
  const target = splitNamespace(rename(`${database}.${collection}`));
  return {
    ...privilege,
    resource: { ...resource, db: target.database, collection: target.collection },
  };
}

/** The users and roles a restore will write, chosen in pre-flight. */
export interface PlannedUsersAndRoles {
  readonly mode: Exclude<UsersAndRolesMode, "skip">;
  readonly users: readonly Document[];
  readonly roles: readonly Document[];
}

/**
 * Pre-flight for users and roles: `undefined` when none will be restored, because
 * the mode is `skip` (the default) or the backup has none; each case is logged so
 * the user knows. Otherwise reads, selects and renames them (see above).
 */
export async function planUsersAndRoles(input: {
  readonly mode: UsersAndRolesMode | undefined;
  readonly manifest: Manifest;
  readonly source: StoredBackupSource;
  readonly filter: NamespaceFilter;
  readonly rename: NamespaceMapper;
  readonly logger: Logger;
  readonly signal: AbortSignal | undefined;
}): Promise<PlannedUsersAndRoles | undefined> {
  const mode = input.mode ?? "skip";
  const entries = input.manifest.namespaces.filter(isAuthzEntry);
  if (mode === "skip") {
    if (entries.length > 0) {
      input.logger.info(
        "The backup holds users and roles; they are not restored (use usersAndRoles create or replace)",
        { backupId: input.manifest.id },
      );
    }
    return undefined;
  }
  if (entries.length === 0) {
    input.logger.warn(
      "The backup holds no users and roles (it was taken without includeUsersAndRoles); none are restored",
      { backupId: input.manifest.id },
    );
    return undefined;
  }
  const backup = await readUsersAndRoles(input.source, input.manifest, input.signal);
  if (backup === undefined) return undefined;
  const selected = selectUsersAndRoles(backup, { filter: input.filter, rename: input.rename });
  input.logger.info("Users and roles to restore", {
    mode,
    users: selected.users.length,
    roles: selected.roles.length,
  });
  return { mode, ...selected };
}

// ---------------------------------------------------------------------------
// Restoring
// ---------------------------------------------------------------------------

/**
 * Restores roles, then users (see the file header).
 *
 * @throws MongoShieldError `MS_PERMISSION_DENIED` when the target user may not manage
 *   roles or users, `MS_RESTORE_FAILED` when the server refuses a role or user.
 */
export async function restoreUsersAndRoles(
  client: MongoClient,
  selected: { readonly users: readonly Document[]; readonly roles: readonly Document[] },
  settings: AuthzRestoreSettings,
): Promise<UsersAndRolesReport> {
  const roles = await restoreRoles(client, selected.roles, settings);
  const users = await restoreUsers(client, selected.users, settings);
  const report: UsersAndRolesReport = { mode: settings.mode, ...roles, ...users };
  settings.logger.info("Restored users and roles", {
    rolesCreated: report.rolesCreated.length,
    rolesReplaced: report.rolesReplaced.length,
    rolesKept: report.rolesKept.length,
    usersCreated: report.usersCreated.length,
    usersReplaced: report.usersReplaced.length,
    usersKept: report.usersKept.length,
    method: report.method,
  });
  if (report.passwordResetRequired.length > 0) {
    settings.logger.warn(
      "The target refused restoring password hashes; these users got a random password and need a password reset",
      { users: report.passwordResetRequired },
    );
  }
  return report;
}

/** The role half of the report. */
type RoleOutcome = Pick<UsersAndRolesReport, "rolesCreated" | "rolesReplaced" | "rolesKept">;

/** Creates missing roles, and updates existing ones in `replace` mode. */
export async function restoreRoles(
  client: MongoClient,
  roles: readonly Document[],
  settings: AuthzRestoreSettings,
): Promise<RoleOutcome> {
  const existing = await existingNames(client, roles, "roles", settings.signal);
  const outcome = {
    rolesCreated: [] as string[],
    rolesReplaced: [] as string[],
    rolesKept: [] as string[],
  };
  const writeConcern = commandWriteConcern(settings.writeConcern);

  // Phase 1: every missing role, without its inherited roles.
  const created: Document[] = [];
  for (const role of roles) {
    throwIfAborted(settings.signal);
    const id = String(role._id);
    if (existing.has(id)) {
      (settings.mode === "replace" ? outcome.rolesReplaced : outcome.rolesKept).push(id);
      continue;
    }
    await runAuthzCommand(client, role.db, `Creating role ${id}`, {
      createRole: role.role,
      privileges: documentsIn(role.privileges),
      roles: [],
      ...authenticationRestrictionsOf(role),
      ...writeConcern,
    });
    created.push(role);
    outcome.rolesCreated.push(id);
  }

  // Phase 2: inherited roles of the new ones (now that all exist), and the full
  // definition of the replaced ones.
  for (const role of created) {
    const inherited = documentsIn(role.roles);
    if (inherited.length === 0) continue;
    await runAuthzCommand(client, role.db, `Granting roles to role ${String(role._id)}`, {
      updateRole: role.role,
      roles: inherited,
      ...writeConcern,
    });
  }
  if (settings.mode === "replace") {
    for (const role of roles) {
      if (!existing.has(String(role._id))) continue;
      await runAuthzCommand(client, role.db, `Updating role ${String(role._id)}`, {
        updateRole: role.role,
        privileges: documentsIn(role.privileges),
        roles: documentsIn(role.roles),
        authenticationRestrictions: documentsIn(role.authenticationRestrictions),
        ...writeConcern,
      });
    }
  }
  return outcome;
}

/** The user half of the report. */
type UserOutcome = Pick<
  UsersAndRolesReport,
  "usersCreated" | "usersReplaced" | "usersKept" | "method" | "passwordResetRequired"
>;

/**
 * Restores users with their password hashes through `_mergeAuthzCollections`, or
 * with `createUser` when the target refuses that (see the file header).
 */
export async function restoreUsers(
  client: MongoClient,
  users: readonly Document[],
  settings: AuthzRestoreSettings,
): Promise<UserOutcome> {
  const existing = await existingNames(client, users, "users", settings.signal);
  const isExisting = (user: Document): boolean => existing.has(String(user._id));
  const present = users.filter(isExisting);
  const missing = users.filter((user) => !isExisting(user));
  const toWrite = settings.mode === "replace" ? users : missing;

  if (toWrite.length > 0) {
    const merged = await mergeUsers(
      client,
      toWrite,
      settings.mode === "replace" ? present : [],
      settings,
    );
    if (!merged) return createUsersWithoutCredentials(client, users, settings);
  }
  return {
    usersCreated: missing.map((user) => String(user._id)),
    usersReplaced: settings.mode === "replace" ? present.map((user) => String(user._id)) : [],
    usersKept: settings.mode === "replace" ? [] : present.map((user) => String(user._id)),
    method: "merge",
    passwordResetRequired: [],
  };
}

/**
 * mongorestore's way: temporary collection + `_mergeAuthzCollections`. Returns false
 * (having changed nothing that matters) when the target refuses it.
 *
 * Which temporary collection: one with a unique name per run
 * (`admin.mongoshield_tmp_users_<time>_<random>`), so restores running at the same time
 * on one server (MongoShield or mongorestore) never see each other's users. The merge
 * must be able to READ that collection, though, and the built-in `restore` role grants
 * `find` in `admin` only on mongorestore's own `tempusers` and `temproles`. So when the
 * merge is refused as unauthorized, the restore claims `admin.tempusers` instead:
 * `createCollection` is atomic, so it gets the collection to itself or, when another
 * restore holds it, fails and the users are created with `createUser`.
 *
 * In `replace` mode the existing users (`dropFirst`) are dropped right before the
 * (first) merge, since the merge keeps existing users. The temporary collection is
 * written first: that is the step refused most often, and then nothing has been
 * dropped. Temporary collections are always dropped afterwards, and ones left behind
 * by a crashed restore more than a day ago are dropped on the way.
 */
async function mergeUsers(
  client: MongoClient,
  users: readonly Document[],
  dropFirst: readonly Document[],
  settings: AuthzRestoreSettings,
): Promise<boolean> {
  const admin = client.db("admin");
  await dropStaleTemporaryCollections(admin, settings.logger);
  const pendingDrops = [...dropFirst];
  const unique = await mergeThrough(client, uniqueTemporaryName(), users, pendingDrops, settings);
  if (unique.outcome === "merged") return true;
  if (unique.outcome === "refused" || !isUnauthorized(unique.error)) {
    return refuseMerge(settings, unique.error);
  }
  if (!(await claimCollection(admin, MONGORESTORE_TEMP_USERS))) {
    return refuseMerge(settings, unique.error);
  }
  const claimed = await mergeThrough(
    client,
    MONGORESTORE_TEMP_USERS,
    users,
    pendingDrops,
    settings,
  );
  return claimed.outcome === "merged" ? true : refuseMerge(settings, claimed.error);
}

/** How one merge attempt ended. */
type MergeAttempt =
  | { readonly outcome: "merged" }
  /** The target refuses merges altogether (Atlas, no such command, …). */
  | { readonly outcome: "refused"; readonly error: unknown }
  /** Refused for this temporary collection: unauthorized; another one may work. */
  | { readonly outcome: "retry"; readonly error: unknown };

/**
 * One merge through the temporary collection `temporary` (dropped afterwards in any
 * case). The users of `pendingDrops` are dropped once the collection is written, and
 * removed from the list, so a second attempt does not drop them again.
 */
async function mergeThrough(
  client: MongoClient,
  temporary: string,
  users: readonly Document[],
  pendingDrops: Document[],
  settings: AuthzRestoreSettings,
): Promise<MergeAttempt> {
  const admin = client.db("admin");
  const writeConcern = commandWriteConcern(settings.writeConcern);
  try {
    try {
      // In stored order: the root is a copy made by `selectUsersAndRoles`, so nested
      // values (custom data) are searched for a recorded order. `forceServerObjectId`
      // keeps the driver from touching the documents (it would add an `_id` to one
      // lacking it, and cannot read the `_id` of a Map).
      await admin.collection(temporary).insertMany(
        users.map((user) => inStoredOrderAnywhere(user)),
        { ordered: true, forceServerObjectId: true },
      );
    } catch (error) {
      if (isMergeRefused(error)) return refusal(error);
      throw authzError(error, "Preparing the users");
    }
    for (let user = pendingDrops.shift(); user !== undefined; user = pendingDrops.shift()) {
      await runAuthzCommand(client, user.db, `Dropping user ${String(user._id)} to replace it`, {
        dropUser: user.user,
        ...writeConcern,
      });
    }
    try {
      await admin.command({
        _mergeAuthzCollections: 1,
        tempUsersCollection: `admin.${temporary}`,
        // false: users that already exist are kept (the server skips duplicates).
        drop: false,
        // "": every database (the temporary collection only holds selected users).
        db: "",
        ...writeConcern,
      });
    } catch (error) {
      if (isMergeRefused(error)) return refusal(error);
      throw authzError(error, "Restoring the users");
    }
    return { outcome: "merged" };
  } finally {
    await dropTemporaryCollection(admin, temporary, settings.logger);
  }
}

/** An unauthorized merge may work through another collection; other refusals never do. */
function refusal(error: unknown): MergeAttempt {
  return isUnauthorized(error) ? { outcome: "retry", error } : { outcome: "refused", error };
}

/** mongorestore's temporary users collection in `admin` (see mergeUsers). */
const MONGORESTORE_TEMP_USERS = "tempusers";

/** Prefix of MongoShield's own temporary users collections in `admin`. */
const TEMPORARY_USERS_PREFIX = "mongoshield_tmp_users_";

/** Temporary collections older than this are left over from a crash and dropped. */
const STALE_TEMPORARY_MS = 24 * 60 * 60 * 1000;

/** NamespaceExists: the collection `claimCollection` wanted is already there. */
const NAMESPACE_EXISTS_CODE = 48;

/**
 * `mongoshield_tmp_users_<creation time in ms, base 36>_<random hex>`: unique, and
 * telling its age, so stale ones can be recognised (see dropStaleTemporaryCollections).
 */
function uniqueTemporaryName(now = Date.now()): string {
  return `${TEMPORARY_USERS_PREFIX}${now.toString(36)}_${randomBytes(6).toString("hex")}`;
}

/** The creation time of a temporary collection's name, or undefined for other names. */
export function temporaryCollectionTime(name: string): number | undefined {
  const match = /^mongoshield_tmp_users_([0-9a-z]+)_[0-9a-f]+$/.exec(name);
  if (match?.[1] === undefined) return undefined;
  const time = Number.parseInt(match[1], 36);
  return Number.isSafeInteger(time) ? time : undefined;
}

/**
 * Drops MongoShield temporary users collections older than a day: a restore that
 * crashed before its `finally` left them, and they hold password hashes. Best effort:
 * a user who may not list or drop them simply leaves them.
 */
async function dropStaleTemporaryCollections(admin: Db, logger: Logger): Promise<void> {
  let names: string[];
  try {
    const infos = await admin
      .listCollections(
        { name: { $regex: `^${TEMPORARY_USERS_PREFIX}` } },
        { nameOnly: true, authorizedCollections: true },
      )
      .toArray();
    names = infos.map((info) => String(info.name));
  } catch (error) {
    logger.debug("Listing old temporary users collections failed", { error: String(error) });
    return;
  }
  const now = Date.now();
  for (const name of names) {
    const time = temporaryCollectionTime(name);
    if (time === undefined || now - time < STALE_TEMPORARY_MS) continue;
    logger.info("Dropping a temporary users collection left by an earlier restore", {
      collection: `admin.${name}`,
    });
    await dropTemporaryCollection(admin, name, logger);
  }
}

/** Creates `admin.<name>`; false when it exists already (someone else is using it). */
async function claimCollection(admin: Db, name: string): Promise<boolean> {
  try {
    await admin.createCollection(name);
    return true;
  } catch (error) {
    if (error instanceof MongoServerError && error.code === NAMESPACE_EXISTS_CODE) return false;
    if (isMergeRefused(error)) return false;
    throw authzError(error, "Preparing the users");
  }
}

/** Drops a temporary collection; failing to is logged, not fatal. */
async function dropTemporaryCollection(admin: Db, name: string, logger: Logger): Promise<void> {
  await admin
    .collection(name)
    .drop()
    .catch((error: unknown) => {
      logger.debug("Dropping the temporary users collection failed", {
        collection: `admin.${name}`,
        error: String(error),
      });
    });
}

function isUnauthorized(error: unknown): boolean {
  return error instanceof MongoServerError && error.code === UNAUTHORIZED_CODE;
}

/** Logs why users are restored with createUser instead, and returns false. */
function refuseMerge(settings: AuthzRestoreSettings, error: unknown): false {
  settings.logger.warn(
    "The target does not allow restoring users with their password hashes; creating them with createUser instead",
    { reason: error instanceof Error ? error.message : String(error) },
  );
  return false;
}

/**
 * The fallback: `createUser` for missing users, with a random password nobody knows
 * (the hash in the backup cannot be passed to `createUser`); `updateUser` (roles,
 * custom data, restrictions; the password stays) for existing ones in `replace` mode.
 * Users authenticated externally (`$external`: x.509, LDAP, Kerberos) need no password.
 *
 * Exported for tests: the local test server always allows the merge.
 */
export async function createUsersWithoutCredentials(
  client: MongoClient,
  users: readonly Document[],
  settings: AuthzRestoreSettings,
): Promise<UserOutcome> {
  // Listed again: a refused merge in `replace` mode may already have dropped some.
  const existing = await existingNames(client, users, "users", settings.signal);
  const outcome = {
    usersCreated: [] as string[],
    usersReplaced: [] as string[],
    usersKept: [] as string[],
    passwordResetRequired: [] as string[],
  };
  const writeConcern = commandWriteConcern(settings.writeConcern);
  for (const user of users) {
    throwIfAborted(settings.signal);
    const id = String(user._id);
    const details = {
      roles: documentsIn(user.roles),
      ...(isDocument(user.customData) ? { customData: valueInStoredOrder(user.customData) } : {}),
      ...authenticationRestrictionsOf(user),
    };
    if (existing.has(id)) {
      if (settings.mode === "create") {
        outcome.usersKept.push(id);
        continue;
      }
      await runAuthzCommand(client, user.db, `Updating user ${id}`, {
        updateUser: user.user,
        ...details,
        ...writeConcern,
      });
      outcome.usersReplaced.push(id);
      continue;
    }
    const needsPassword = usesPassword(user);
    const mechanisms = scramMechanisms(user);
    await runAuthzCommand(client, user.db, `Creating user ${id}`, {
      createUser: user.user,
      ...details,
      ...(needsPassword ? { pwd: randomBytes(RANDOM_PASSWORD_BYTES).toString("base64url") } : {}),
      ...(needsPassword && mechanisms.length > 0 ? { mechanisms } : {}),
      ...writeConcern,
    });
    outcome.usersCreated.push(id);
    if (needsPassword) outcome.passwordResetRequired.push(id);
  }
  return { ...outcome, method: "createUser" };
}

/** False for users authenticated outside MongoDB (x.509, LDAP, Kerberos, AWS IAM, OIDC). */
function usesPassword(user: Document): boolean {
  if (user.db === "$external") return false;
  return !(isDocument(user.credentials) && user.credentials.external === true);
}

/** The SCRAM mechanisms the user had, so the new password gets the same ones. */
function scramMechanisms(user: Document): string[] {
  if (!isDocument(user.credentials)) return [];
  return Object.keys(user.credentials).filter((mechanism) => mechanism.startsWith("SCRAM-"));
}

/** `authenticationRestrictions` when the user or role has any. */
function authenticationRestrictionsOf(document: Document): Document {
  const restrictions = documentsIn(document.authenticationRestrictions);
  return restrictions.length === 0 ? {} : { authenticationRestrictions: restrictions };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** `db.name` of the users (or roles) that already exist in the target databases. */
async function existingNames(
  client: MongoClient,
  documents: readonly Document[],
  kind: "users" | "roles",
  signal: AbortSignal | undefined,
): Promise<Set<string>> {
  const databases = new Set<string>();
  for (const document of documents) {
    const database = stringField(document, "db");
    if (database !== undefined) databases.add(database);
  }
  const names = new Set<string>();
  for (const database of databases) {
    throwIfAborted(signal);
    const command = kind === "users" ? { usersInfo: 1 } : { rolesInfo: 1, showBuiltinRoles: false };
    const reply = await client
      .db(database)
      .command(command)
      .catch((error: unknown) => {
        throw authzError(error, `Listing the ${kind} of ${database}`);
      });
    for (const found of documentsIn(reply[kind])) names.add(String(found._id));
  }
  return names;
}

/** Runs one user-management command in `database`, translating failures. */
async function runAuthzCommand(
  client: MongoClient,
  database: unknown,
  step: string,
  command: Document,
): Promise<void> {
  try {
    await client.db(String(database)).command(command);
  } catch (error) {
    throw authzError(error, step);
  }
}

function isMergeRefused(error: unknown): boolean {
  return (
    error instanceof MongoServerError &&
    typeof error.code === "number" &&
    MERGE_REFUSED_CODES.has(error.code)
  );
}

/** A typed error naming the step; the collections are already restored by then. */
function authzError(error: unknown, step: string): MongoShieldError {
  if (isMongoShieldError(error)) return error;
  const reason = error instanceof Error ? error.message : String(error);
  // Atlas behind a host name MongoShield did not recognise (restore.ts refuses users and
  // roles up front on recognised Atlas targets): its proxy refuses user management.
  if (isAtlasRefusal(error)) {
    return new MongoShieldError(
      "MS_UNSUPPORTED_TOPOLOGY",
      `${step} was refused by Atlas: ${reason}`,
      {
        cause: error,
        hint: `The collections were restored. ${ATLAS_USERS_HINT}`,
      },
    );
  }
  if (error instanceof MongoServerError && error.code === UNAUTHORIZED_CODE) {
    return new MongoShieldError("MS_PERMISSION_DENIED", `${step} was refused: ${reason}`, {
      cause: error,
      hint: 'Restoring users and roles needs user-administration privileges: grant the built-in `restore` role (db: "admin"), or restore with usersAndRoles "skip".',
    });
  }
  return new MongoShieldError("MS_RESTORE_FAILED", `${step} failed: ${reason}`, {
    cause: error,
    hint: "The collections were restored. Fix the cause and restore again with --users-and-roles (existing users and roles are kept in create mode).",
  });
}

function stringField(document: Document, field: string): string | undefined {
  const value: unknown = document[field];
  return typeof value === "string" ? value : undefined;
}

function documentsIn(value: unknown): Document[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is Document => isDocument(item));
}

function isDocument(value: unknown): value is Document {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
