/**
 * The routes behind the welcome flow ("paste a URI, browse, back up now"):
 *
 *   POST /api/connections/check   admin   test a pasted connection string before saving it
 *   POST /api/network/public-ip   admin   the console's public IP, for an Atlas IP access list
 *   POST /api/quick-backup        admin   "Back up now": the connection's quick plan, run now
 *
 * "Back up now" is a normal backup plan with every choice made for the user:
 *
 *   storage       the "Local backups" location created on first start (services.ts), or
 *                 else the first local location; S3 and friends are chosen in the plan
 *   what          everything except MongoDB's own databases, or the chosen namespaces
 *   encryption    a key the console generates and keeps (plans.ts, "managed"): encrypted
 *                 without typing a passphrase; the recovery key is offered for download
 *   consistency   "auto": the library picks snapshot or converge for the deployment, and
 *                 adapts to Atlas Free/Flex tiers by itself (src/mongo/atlas.ts)
 *   verify        "fast" after every run
 *
 * The plan (one per connection, `origin: "quick"`) shows up under Backup plans like any
 * other, so everything it does can be seen and changed there, including the one-click
 * nightly schedule the welcome flow offers (a plain PUT /api/plans/:id).
 */

import { isIP } from "node:net";
import type { Hono } from "hono";
import { redactMongoUri } from "mongoshield";
import { backupJob, connectionById } from "../../jobs/tasks.ts";
import type {
  ConnectionCheckResult,
  PlanView,
  PublicIpResult,
  QuickBackupResult,
} from "../../shared/api.ts";
import { analyzeConnectionString, throughContainerHost } from "../../shared/connection-string.ts";
import { randomId } from "../../state/crypto.ts";
import type { PlanRecord, StorageRecord } from "../../state/types.ts";
import { recordAudit } from "../audit.ts";
import { requireRole } from "../auth.ts";
import { inspectConnection, normalizeConnectionUri, rememberCheck } from "../connection-check.ts";
import type { AppEnv, ConsoleServices } from "../context.ts";
import { ConsoleError } from "../errors.ts";
import { readJson } from "../security.ts";
import { asObject, optionalStringArray, requiredString } from "../validate.ts";
import { planView } from "../views.ts";
import { deploymentOf } from "./connections.ts";
import { managedKeyFor } from "./plans.ts";

/** Longest accepted connection string (as for saved connections). */
const MAX_URI_LENGTH = 4096;

/**
 * Where the public IP is looked up: Amazon's checkip service answers with the caller's
 * address as plain text and nothing else, over HTTPS, without an account or tracking
 * parameters. Only contacted when an admin clicks "Show my IP address".
 */
export const PUBLIC_IP_SERVICE = "https://checkip.amazonaws.com/";

/** Give up on the IP lookup after this long. */
const PUBLIC_IP_TIMEOUT_MS = 5_000;

/** Options for {@link onboardingRoutes}; tests replace the network. */
export interface OnboardingRouteOptions {
  /** Fetches the public IP service (defaults to the global `fetch`). */
  readonly fetchPublicIp?: (url: string, signal: AbortSignal) => Promise<Response>;
  /** Whether the console runs in a container (defaults to detecting it). */
  readonly inContainer?: boolean;
  /** The address to try for a refused localhost in a container (see `inspectConnection`). */
  readonly containerAddress?: (uri: string) => string | undefined;
}

/** Registers the onboarding routes. */
export function onboardingRoutes(
  app: Hono<AppEnv>,
  services: ConsoleServices,
  options: OnboardingRouteOptions = {},
): void {
  const { store } = services;

  app.post("/api/connections/check", async (c) => {
    const principal = requireRole(c, "admin");
    const body = asObject(await readJson(c));
    const uri = normalizeConnectionUri(requiredString(body, "uri", MAX_URI_LENGTH));
    const info = analyzeConnectionString(uri);
    const result = await inspectConnection(uri, {
      ...(options.inContainer === undefined ? {} : { inContainer: options.inContainer }),
      ...(options.containerAddress === undefined
        ? {}
        : { containerAddress: options.containerAddress }),
    });
    // Saving the connection right after this keeps what the check found out, under the
    // address that worked (the page saves that one when the console had to use the host).
    const reached =
      result.reachedThrough === undefined
        ? uri
        : ((options.containerAddress ?? throughContainerHost)(uri) ?? uri);
    if (result.ok) rememberCheck(services, reached, deploymentOf(result, services.now()));
    const answer: ConnectionCheckResult = {
      ...result,
      suggestedName: uniqueName(
        info.suggestedName,
        store.current.connections.map((connection) => connection.name),
      ),
      production: info.production,
    };
    await recordAudit(services, {
      actor: principal,
      action: "connection.check",
      // The redacted URI (password removed) says what was tried.
      target: redactMongoUri(uri),
      outcome: result.ok ? "success" : "failure",
      ...(result.problem === undefined ? {} : { details: { problem: result.problem.kind } }),
    });
    return c.json(answer);
  });

  app.post("/api/network/public-ip", async (c) => {
    const principal = requireRole(c, "admin");
    const result = await lookUpPublicIp(
      options.fetchPublicIp ?? ((url, signal) => fetch(url, { signal })),
    );
    await recordAudit(services, {
      actor: principal,
      action: "network.public_ip",
      target: PUBLIC_IP_SERVICE,
      outcome: result.ip === undefined ? "failure" : "success",
    });
    return c.json(result);
  });

  app.post("/api/quick-backup", async (c) => {
    const principal = requireRole(c, "admin");
    const body = asObject(await readJson(c));
    const connection = connectionById(store, requiredString(body, "connectionId", 64));
    const include = optionalStringArray(body, "include", { maxItems: 500, maxLength: 300 }) ?? [];
    const storage = quickBackupStorage(services);

    const existing = store.current.plans.find(
      (plan) => plan.origin === "quick" && plan.connectionId === connection.id,
    );
    const plan =
      existing === undefined
        ? newQuickPlan(services, connection.id, connection.name, storage, include)
        : { ...existing, include };
    await store.update((state) => {
      const others = state.plans.filter((candidate) => candidate.id !== plan.id);
      state.plans = [...others, plan];
    });
    services.schedules.sync();
    if (existing === undefined) {
      await recordAudit(services, {
        actor: principal,
        action: "plan.create",
        target: plan.name,
        outcome: "success",
        details: { id: plan.id, origin: "quick", storage: storage.id },
      });
    } else if (!sameList(existing.include, include)) {
      await recordAudit(services, {
        actor: principal,
        action: "plan.update",
        target: plan.name,
        outcome: "success",
        details: { id: plan.id, origin: "quick", include: include.length },
      });
    }

    const job = await services.runner.start(
      backupJob(services.tasks, plan, principal.user.username),
    );
    await recordAudit(services, {
      actor: principal,
      action: "plan.run",
      target: plan.name,
      outcome: "success",
      details: { plan: plan.id, job: job.id, origin: "quick" },
    });
    const nextRunAt = services.schedules.nextRunOf(plan.id);
    const view: PlanView = planView(plan, {
      lastRun: job,
      ...(nextRunAt === undefined ? {} : { nextRunAt }),
    });
    const result: QuickBackupResult = { plan: view, job, created: existing === undefined };
    return c.json(result);
  });
}

/**
 * The storage location for "Back up now": the first-run default if it still exists,
 * else the first local location. Cloud locations are never picked silently: where
 * backups leave the machine is the admin's choice (in the plan).
 */
function quickBackupStorage(services: ConsoleServices): StorageRecord {
  const { storage, defaults } = services.store.current;
  const preferred = storage.find((location) => location.id === defaults?.storageId);
  const local = storage.find(
    (location) => !location.url.includes("://") || location.url.startsWith("file://"),
  );
  const chosen = preferred ?? local;
  if (chosen === undefined) {
    throw new ConsoleError(
      409,
      "CONSOLE_NO_STORAGE",
      "There is no local storage location for one-click backups.",
      'Add a storage location under Storage (a folder such as "backups", or S3), then create a backup plan for it.',
    );
  }
  return chosen;
}

/** A new quick plan: every setting chosen for the user (see the file header). */
function newQuickPlan(
  services: ConsoleServices,
  connectionId: string,
  connectionName: string,
  storage: StorageRecord,
  include: readonly string[],
): PlanRecord {
  const id = randomId();
  return {
    id,
    name: uniqueName(
      `Back up ${connectionName}`,
      services.store.current.plans.map((plan) => plan.name),
    ),
    connectionId,
    storageId: storage.id,
    include,
    exclude: [],
    compression: "zstd",
    encryption: managedKeyFor(services, id, undefined),
    consistency: "auto",
    verify: "fast",
    notify: [],
    createdAt: services.now().toISOString(),
    origin: "quick",
  };
}

/**
 * Asks the public IP service for the console's address. Its answer is checked to be an
 * IP address and nothing else before it is shown (it comes from outside).
 */
export async function lookUpPublicIp(
  fetchService: (url: string, signal: AbortSignal) => Promise<Response>,
): Promise<PublicIpResult> {
  try {
    const response = await fetchService(
      PUBLIC_IP_SERVICE,
      AbortSignal.timeout(PUBLIC_IP_TIMEOUT_MS),
    );
    if (!response.ok) return { error: `The lookup service answered with HTTP ${response.status}.` };
    // A valid answer is at most an IPv6 address (45 characters) plus a newline.
    const text = (await response.text()).slice(0, 100).trim();
    if (isIP(text) === 0) return { error: "The lookup service did not answer with an IP address." };
    return { ip: text };
  } catch {
    return {
      error:
        "The console could not reach the lookup service (no internet access from the console?). Find the address with your hosting provider or `curl https://checkip.amazonaws.com` on the console's machine.",
    };
  }
}

/** `name`, or `name 2`, `name 3`, … when it is taken (names are unique per kind). */
function uniqueName(name: string, taken: readonly string[]): string {
  const base = name.slice(0, 90);
  if (!taken.includes(base)) return base;
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${base} ${suffix}`;
    if (!taken.includes(candidate)) return candidate;
  }
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}
