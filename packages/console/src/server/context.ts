/**
 * The types every route shares: the services a console is built from, the
 * signed-in principal, and the Hono environment that carries it.
 */

import type { Logger } from "mongoshield";
import type { JobRunner } from "../jobs/runner.ts";
import type { PlanSchedules } from "../jobs/schedules.ts";
import type { StorageRegistry } from "../jobs/storage.ts";
import type { TaskDeps } from "../jobs/tasks.ts";
import type { ContainerEnvironment } from "../shared/api.ts";
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
  /**
   * The console's public URL, e.g. `https://backups.example.com`. Enables HSTS when
   * https, is always an allowed Host (hosts.ts), and its path (if any) is the sub-path
   * the console is served under, e.g. `https://example.com/mongoshield`.
   */
  readonly publicUrl?: string;
  /**
   * More host names the console answers to (MONGOSHIELD_ALLOWED_HOSTS): names,
   * `*.example.com`, or `*` to turn the Host check off. See hosts.ts.
   */
  readonly allowedHosts?: readonly string[];
  /**
   * Socket addresses (IPs or CIDR ranges) of trusted reverse proxies
   * (MONGOSHIELD_TRUSTED_PROXIES). Only their `X-Forwarded-For`, `-Host` and `-Proto`
   * headers are believed. Unset: those headers are ignored.
   */
  readonly trustedProxies?: readonly string[];
  /**
   * MONGOSHIELD_ALLOW_UNSAFE_TARGETS: let admins point webhooks and storage endpoints at
   * cloud metadata and link-local addresses, use the console's own cloud identity with
   * storage endpoints outside the cloud's domain, and use connection strings that
   * authenticate with the console's workload identity (see network-targets.ts). Off by
   * default: an admin account is not automatically trusted with the console's identity.
   */
  readonly allowUnsafeTargets?: boolean;
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
  /**
   * Where the console runs (Docker, Podman, Kubernetes, …); detected when absent
   * (container-environment.ts). Tests set it.
   */
  readonly container?: ContainerEnvironment;
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
  /**
   * Every secret the console knows (stored ones, plus the OIDC client secret, proxy
   * secret, metrics token and webhook secret), for scrubbing error messages and job
   * logs. Computed on each call, so it follows changes to the state.
   */
  readonly knownSecrets: () => string[];
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

/**
 * Where a request came from, as far as the console can tell (security.ts,
 * `resolveClient`): from the socket, or from the forwarding headers of a trusted proxy.
 */
export interface RequestClient {
  /** The client's IP address, or "unknown" (in-process test requests have no socket). */
  readonly address: string;
  /** The host the client asked for (`Host`, or a trusted proxy's `X-Forwarded-Host`). */
  readonly host: string | undefined;
  /** True when the request arrived through a trusted proxy. */
  readonly viaTrustedProxy: boolean;
}

/** The Hono environment: request-scoped variables set by the middleware. */
export interface AppEnv {
  Variables: {
    principal: Principal | undefined;
    client: RequestClient | undefined;
  };
}
