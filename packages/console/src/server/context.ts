/**
 * The types every route shares: the services a console is built from, the
 * signed-in principal, and the Hono environment that carries it.
 */

import type { Logger } from "mongoshield";
import type { JobRunner } from "../jobs/runner.ts";
import type { PlanSchedules } from "../jobs/schedules.ts";
import type { StorageRegistry } from "../jobs/storage.ts";
import type { TaskDeps } from "../jobs/tasks.ts";
import type { AuditLog } from "../state/audit.ts";
import type { StateStore } from "../state/store.ts";
import type { UserRecord } from "../state/types.ts";
import type { LiveClients } from "./live/clients.ts";
import type { LiveJournal } from "./live/journal.ts";
import type { OidcClient } from "./oidc/client.ts";
import type { OidcSettings } from "./oidc/settings.ts";
import type { LoginRateLimiter } from "./rate-limit.ts";

/** Settings read from the environment (see config.ts) that change how requests are handled. */
export interface ConsoleSettings {
  /**
   * Shared secret a trusted reverse proxy sends in `X-MongoShield-Proxy-Secret`
   * together with `X-Forwarded-User`. Unset: proxy headers are ignored entirely.
   */
  readonly proxySecret?: string;
  /** Bearer token for `GET /metrics`. Unset: the endpoint is disabled (404). */
  readonly metricsToken?: string;
  /**
   * Mark cookies `Secure` (and use the `__Host-` prefix). On by default; only
   * turn off for plain-HTTP evaluation on a private network.
   */
  readonly cookieSecure: boolean;
  /** The console's public URL, e.g. `https://backups.example.com`. Enables HSTS when https. */
  readonly publicUrl?: string;
  /** Running behind TLS (from `publicUrl`): send HSTS. */
  readonly https: boolean;
  /** Grace period for running jobs at shutdown. */
  readonly shutdownGraceMs: number;
  /** OIDC single sign-on (MONGOSHIELD_OIDC_*). Unset: the OIDC endpoints answer 404. */
  readonly oidc?: OidcSettings;
}

/** Everything a console is made of. Created by `openConsole()` (services.ts). */
export interface ConsoleServices {
  readonly dataDir: string;
  readonly store: StateStore;
  readonly audit: AuditLog;
  readonly runner: JobRunner;
  readonly schedules: PlanSchedules;
  readonly storage: StorageRegistry;
  readonly tasks: TaskDeps;
  readonly settings: ConsoleSettings;
  readonly loginLimiter: LoginRateLimiter;
  readonly logger: Logger;
  /** The OIDC relying party, when `settings.oidc` is set. */
  readonly oidc: OidcClient | undefined;
  /** log2(N) for new password hashes (17 in production). */
  readonly passwordCost: number;
  /** The clock; tests move it. */
  readonly now: () => Date;
  /** The live data browser: pooled MongoDB clients and the live edit journal. */
  readonly live: { readonly clients: LiveClients; readonly journal: LiveJournal };
  /**
   * First-run setup without the token: allowed until this moment while no admin exists
   * (MONGOSHIELD_SETUP_WINDOW_MINUTES after start). Absent: setup always needs the token.
   */
  readonly setupWindowEndsAt?: Date;
}

/** Who is making a request, once authenticated. */
export interface Principal {
  readonly user: UserRecord;
  /** How they authenticated. */
  readonly via: "session" | "proxy";
  /** The stored hash of the session id (cookie sessions only), for logout. */
  readonly sessionHash?: string;
  /** The CSRF token bound to this login; state-changing requests must echo it. */
  readonly csrfToken: string;
}

/** The Hono environment: request-scoped variables set by the auth middleware. */
export interface AppEnv {
  Variables: {
    principal: Principal | undefined;
  };
}
