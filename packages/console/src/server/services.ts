/**
 * Opening and closing a console: state, audit log, storage adapters, job runner
 * and schedules, wired together. Used by main.ts and by the tests, which open
 * a console on a temporary data directory and call the app in-process.
 */

import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { type Logger, silentLogger } from "mongoshield";
import { JobRunner } from "../jobs/runner.ts";
import { PlanSchedules } from "../jobs/schedules.ts";
import { StorageRegistry } from "../jobs/storage.ts";
import { backupJob, type TaskDeps } from "../jobs/tasks.ts";
import { AuditLog } from "../state/audit.ts";
import { randomId } from "../state/crypto.ts";
import { DEFAULT_PASSWORD_COST, hashPassword } from "../state/passwords.ts";
import { openStorageCredentials } from "../state/secrets.ts";
import { issueSetupToken } from "../state/sessions.ts";
import { StateStore } from "../state/store.ts";
import type { StorageRecord, UserRecord } from "../state/types.ts";
import type { InitialAdmin } from "./config.ts";
import type { ConsoleServices, ConsoleSettings } from "./context.ts";
import { LiveClients } from "./live/clients.ts";
import { LiveJournal } from "./live/journal.ts";
import { OidcClient, type OidcClientOptions } from "./oidc/client.ts";
import { LoginRateLimiter } from "./rate-limit.ts";

/** Options for {@link openConsole}. */
export interface OpenConsoleOptions {
  readonly dataDir: string;
  /** MONGOSHIELD_SECRET. */
  readonly secret: string;
  readonly settings?: Partial<ConsoleSettings>;
  readonly logger?: Logger;
  /** log2(N) for scrypt; production uses 17, tests a cheaper 14. */
  readonly passwordCost?: number;
  readonly now?: () => Date;
  /** Audit log rotation size; tests make it small. */
  readonly auditMaxBytes?: number;
  /** Progress throttle of jobs; tests shorten it. */
  readonly progressIntervalMs?: number;
  /** Webhook signing secret (MONGOSHIELD_WEBHOOK_SECRET). */
  readonly webhookSecret?: string;
  /** Cache and timeout overrides for the OIDC provider client; tests shorten them. */
  readonly oidcProvider?: OidcClientOptions["provider"];
  /**
   * How long after opening the first admin may be created without the setup token
   * (MONGOSHIELD_SETUP_WINDOW_MINUTES). 0 or absent: the token is always required,
   * which is what tests and embedders get unless they ask for a window.
   */
  readonly setupWindowMs?: number;
  /** Create this admin now if no user exists yet (MONGOSHIELD_ADMIN_*). */
  readonly initialAdmin?: InitialAdmin;
  /**
   * Create the "Local backups" storage location (`<data>/backups`) on a fresh data
   * directory. Off unless asked for; main.ts turns it on (MONGOSHIELD_DEFAULT_STORAGE).
   */
  readonly defaultStorage?: boolean;
  /**
   * When the data directory's lock was refreshed moments ago but its holder has
   * stopped (a container replaced with `docker rm -f`, a crash), wait for it to go
   * stale instead of failing at once. main.ts turns it on; tests leave it off.
   */
  readonly waitForPreviousLock?: boolean;
}

/** An opened console and what it did at startup, for main.ts to log. */
export interface OpenedConsole {
  readonly services: ConsoleServices;
  /** Present when no admin exists yet: print it as the setup link. */
  readonly setupToken?: string;
  /** Present while setup is possible without the token (see `setupWindowMs`). */
  readonly setupWindowEndsAt?: Date;
  /** The admin created from the environment at this start, if any. */
  readonly provisionedAdmin?: string;
  /** True when MONGOSHIELD_ADMIN_* was given but ignored because users already exist. */
  readonly provisionedAdminIgnored?: boolean;
  /** The default storage location created at this start (first start only). */
  readonly createdStorage?: { readonly name: string; readonly path: string };
}

/** Name of the storage location created on a fresh data directory. */
export const DEFAULT_STORAGE_NAME = "Local backups";
/**
 * Its URL: a directory inside the data directory (local storage must stay inside it,
 * see src/jobs/storage.ts). Relative, so the location keeps working when the data
 * directory moves (another mount point, or `npx` instead of Docker).
 */
export const DEFAULT_STORAGE_URL = "backups";

/** Default settings: secure cookies, no proxy auth, no metrics, 60 s shutdown grace. */
const DEFAULT_SETTINGS: ConsoleSettings = {
  cookieSecure: true,
  https: false,
  shutdownGraceMs: 60_000,
};

/** Opens a console on a data directory. Close it with {@link closeConsole}. */
export async function openConsole(options: OpenConsoleOptions): Promise<OpenedConsole> {
  const now = options.now ?? (() => new Date());
  const logger = options.logger ?? silentLogger;
  const store = await StateStore.open({
    dataDir: options.dataDir,
    secret: options.secret,
    ...(options.waitForPreviousLock === true
      ? { waitForPreviousLock: { onWait: (message: string) => logger.info(message) } }
      : {}),
  });
  const audit = new AuditLog({
    dataDir: options.dataDir,
    ...(options.auditMaxBytes === undefined ? {} : { maxBytes: options.auditMaxBytes }),
  });
  const storage = new StorageRegistry({
    dataDir: options.dataDir,
    credentialsOf: (record) => openStorageCredentials(store, record),
  });
  const tasks: TaskDeps = {
    store,
    storage,
    logger,
    ...(options.webhookSecret === undefined ? {} : { webhookSecret: options.webhookSecret }),
  };
  const runner = new JobRunner({
    store,
    now,
    ...(options.progressIntervalMs === undefined
      ? {}
      : { progressIntervalMs: options.progressIntervalMs }),
    onFinished: (job) => {
      // Scheduled jobs have no request to audit them, so the runner does.
      if (job.startedBy !== "schedule") return;
      void audit
        .append({
          at: now().toISOString(),
          actor: "schedule",
          action: `${job.kind}.finish`,
          target: job.planId ?? job.id,
          outcome: job.status === "succeeded" ? "success" : "failure",
          details: { job: job.id, status: job.status },
        })
        .catch((error: unknown) =>
          logger.error("Cannot write the audit log", { error: String(error) }),
        );
    },
  });
  await runner.recoverInterrupted();
  const schedules = new PlanSchedules({
    store,
    runner,
    logger,
    backupJob: (plan) => backupJob(tasks, plan, "schedule"),
  });

  const settings: ConsoleSettings = { ...DEFAULT_SETTINGS, ...options.settings };
  const oidc =
    settings.oidc === undefined
      ? undefined
      : new OidcClient({
          settings: settings.oidc,
          now: () => now().getTime(),
          ...(options.oidcProvider === undefined ? {} : { provider: options.oidcProvider }),
        });

  // The window opens at startup and only while nobody can sign in yet.
  const setupWindowEndsAt =
    (options.setupWindowMs ?? 0) > 0 && store.current.users.length === 0
      ? new Date(now().getTime() + (options.setupWindowMs ?? 0))
      : undefined;

  const services: ConsoleServices = {
    dataDir: options.dataDir,
    store,
    audit,
    runner,
    schedules,
    storage,
    tasks,
    settings,
    loginLimiter: new LoginRateLimiter(() => now().getTime()),
    logger,
    oidc,
    passwordCost: options.passwordCost ?? DEFAULT_PASSWORD_COST,
    now,
    live: {
      clients: new LiveClients(store),
      journal: new LiveJournal({ store, storage, dataDir: options.dataDir }),
    },
    ...(setupWindowEndsAt === undefined ? {} : { setupWindowEndsAt }),
  };

  const createdStorage =
    options.defaultStorage === true ? await applyFirstRunDefaults(services) : undefined;
  const startup = {
    ...(createdStorage === undefined
      ? {}
      : {
          createdStorage: {
            name: createdStorage.name,
            path: join(options.dataDir, createdStorage.url),
          },
        }),
  };

  // Headless installs name their admin in the environment. Only ever on an empty
  // user list: the environment never resets a password or adds a second admin later.
  if (options.initialAdmin !== undefined) {
    if (store.current.users.length > 0) {
      return { services, ...startup, provisionedAdminIgnored: true };
    }
    const created = await provisionAdmin(services, options.initialAdmin);
    if (created) return { services, ...startup, provisionedAdmin: options.initialAdmin.username };
  }

  // No admin yet: issue a fresh setup token (only its hash is stored, so an
  // earlier one cannot be shown again).
  if (store.current.users.length === 0) {
    const setupToken = await issueSetupToken(store, now());
    return {
      services,
      ...startup,
      setupToken,
      ...(setupWindowEndsAt === undefined ? {} : { setupWindowEndsAt }),
    };
  }
  return { services, ...startup };
}

/**
 * Creates the admin named in the environment, in the same check-and-set update as the
 * setup route (so it cannot race a setup request), and audits it. Returns false when
 * a user appeared meanwhile.
 */
async function provisionAdmin(services: ConsoleServices, admin: InitialAdmin): Promise<boolean> {
  const record: UserRecord = {
    id: randomId(),
    username: admin.username,
    role: "admin",
    passwordHash: await hashPassword(admin.password, services.passwordCost),
    createdAt: services.now().toISOString(),
  };
  const created = await services.store.update((state) => {
    if (state.users.length > 0) return false;
    state.users = [record];
    // The setup token has nothing left to set up.
    delete state.setupToken;
    return true;
  });
  if (created) {
    await services.audit.append({
      at: services.now().toISOString(),
      actor: "environment",
      action: "setup.complete",
      target: admin.username,
      outcome: "success",
      details: { method: "environment" },
    });
  }
  return created;
}

/**
 * On a fresh data directory, creates the "Local backups" storage location so the
 * first backup needs no storage step. Applied at most once per data directory (the
 * `defaults` marker), and never to a console that already has anything in it: an
 * existing deployment starts exactly as before. Returns the created location.
 */
async function applyFirstRunDefaults(
  services: ConsoleServices,
): Promise<StorageRecord | undefined> {
  const { store } = services;
  const state = store.current;
  if (state.defaults !== undefined) return undefined;
  const untouched =
    state.users.length === 0 &&
    state.connections.length === 0 &&
    state.storage.length === 0 &&
    state.plans.length === 0;
  if (!untouched) return undefined;

  // The adapter creates directories as it writes; creating it now (0700, like the data
  // directory) means the location also passes its storage test before the first backup.
  await mkdir(join(services.dataDir, DEFAULT_STORAGE_URL), { recursive: true, mode: 0o700 });
  const at = services.now().toISOString();
  const record: StorageRecord = {
    id: randomId(),
    name: DEFAULT_STORAGE_NAME,
    url: DEFAULT_STORAGE_URL,
    createdAt: at,
    updatedAt: at,
  };
  const created = await store.update((draft) => {
    if (draft.defaults !== undefined || draft.storage.length > 0) return false;
    draft.storage = [record];
    draft.defaults = { appliedAt: at, storageId: record.id };
    return true;
  });
  if (!created) return undefined;
  await services.audit.append({
    at,
    actor: "system",
    action: "storage.create",
    target: record.name,
    outcome: "success",
    details: { id: record.id, url: record.url, reason: "first-run default" },
  });
  return record;
}

/**
 * Shuts a console down: stops schedules, lets running jobs finish within the
 * grace period (then aborts them), closes storage adapters and releases the
 * data directory.
 */
export async function closeConsole(services: ConsoleServices, graceMs?: number): Promise<void> {
  const grace = graceMs ?? services.settings.shutdownGraceMs;
  await services.schedules.stop(grace);
  await services.runner.shutdown(grace);
  await services.live.clients.closeAll();
  await services.live.journal.close();
  await services.storage.closeAll();
  await services.store.close();
}
