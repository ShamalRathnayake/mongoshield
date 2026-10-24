/**
 * Opening and closing a console: state, audit log, storage adapters, job runner
 * and schedules, wired together. Used by main.ts and by the tests, which open
 * a console on a temporary data directory and call the app in-process.
 */

import { type Logger, silentLogger } from "mongoshield";
import { JobRunner } from "../jobs/runner.ts";
import { PlanSchedules } from "../jobs/schedules.ts";
import { StorageRegistry } from "../jobs/storage.ts";
import { backupJob, type TaskDeps } from "../jobs/tasks.ts";
import { AuditLog } from "../state/audit.ts";
import { DEFAULT_PASSWORD_COST } from "../state/passwords.ts";
import { openStorageCredentials } from "../state/secrets.ts";
import { issueSetupToken } from "../state/sessions.ts";
import { StateStore } from "../state/store.ts";
import type { ConsoleServices, ConsoleSettings } from "./context.ts";
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
}

/** An opened console and, while setup is pending, its one-time setup token. */
export interface OpenedConsole {
  readonly services: ConsoleServices;
  /** Present when no admin exists yet: print it as the setup link. */
  readonly setupToken?: string;
}

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
  const store = await StateStore.open({ dataDir: options.dataDir, secret: options.secret });
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
  };

  // No admin yet: issue a fresh setup token (only its hash is stored, so an
  // earlier one cannot be shown again).
  if (store.current.users.length === 0) {
    const setupToken = await issueSetupToken(store, now());
    return { services, setupToken };
  }
  return { services };
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
  await services.storage.closeAll();
  await services.store.close();
}
