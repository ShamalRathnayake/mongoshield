/**
 * The mock console server: an in-memory implementation of every route in `ApiRoutes`,
 * exposed as a `fetch` function and an EventSource factory for the real `ApiClient`.
 *
 * It is used in two places:
 * - **Mock mode** (`?mock=1` in the URL): main.tsx loads this module lazily, so the UI
 *   can be developed and demoed without a server. Sign in as admin / admin.
 * - **Tests**: page tests create a backend per test, so every test starts from the
 *   same fixtures and can inspect `backend.data` afterwards.
 *
 * It mirrors the real server's rules that matter to the UI: sessions and CSRF tokens,
 * role checks, secret redaction (URIs and passwords are never returned), the restore
 * confirmation for production targets, the dry-run-then-confirm flows of pruning and
 * config import, and jobs that progress over time and stream events. It is
 * deliberately simple everywhere else (retention, for example, only knows `last` and
 * `daily`).
 */

import type {
  ApiError,
  BackupDetail,
  BackupSummary,
  ConfigImportChange,
  ConfigImportRequest,
  ConfigImportResult,
  ConnectionView,
  DocumentPage,
  JobEvent,
  JobKind,
  JobSummary,
  PlanInput,
  PlanView,
  PrunePlanView,
  RestorePlanView,
  RestoreRequest,
  Role,
  SessionInfo,
  StorageView,
  UserView,
} from "../../shared/api.ts";
import type {
  EventSourceFactory,
  FetchLike,
  HttpRequestInit,
  HttpResponseLike,
  RequestOf,
  ResponseOf,
  RouteKey,
} from "../api.ts";
import { roleIncludes } from "../context.tsx";
import { applyRename, isSelected } from "../namespaces.ts";
import { matchPath } from "../router.ts";
import { createFixtures, generateDocument, type MockBackup, type MockData } from "./fixtures.ts";

// ---------------------------------------------------------------------------
// Handler plumbing
// ---------------------------------------------------------------------------

/** Thrown by handlers to answer with an error status and an `ApiError` body. */
class MockHttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly hint: string | undefined;
  constructor(status: number, code: string, message: string, hint?: string) {
    super(message);
    this.status = status;
    this.code = code;
    this.hint = hint;
  }
}

/** What a handler receives. */
interface HandlerInput<Route extends RouteKey> {
  readonly params: Readonly<Record<string, string>>;
  readonly query: URLSearchParams;
  readonly body: RequestOf<Route>;
  /** The signed-in user (undefined on public routes when nobody is signed in). */
  readonly user: UserView | undefined;
}

type Handler<Route extends RouteKey> = (input: HandlerInput<Route>) => ResponseOf<Route>;

/** One handler per route: the mapped type makes a missing route a compile error. */
type Handlers = { [Route in RouteKey]: Handler<Route> };

/** Minimum role per route; `public` routes work without a session. */
const ROUTE_ROLES: { readonly [Route in RouteKey]: Role | "public" } = {
  "GET /api/session": "public",
  "POST /api/session": "public",
  "DELETE /api/session": "public",
  "POST /api/setup": "public",
  "GET /api/users": "admin",
  "POST /api/users": "admin",
  "PUT /api/users/:id": "admin",
  "DELETE /api/users/:id": "admin",
  "GET /api/connections": "viewer",
  "POST /api/connections": "admin",
  "PUT /api/connections/:id": "admin",
  "DELETE /api/connections/:id": "admin",
  "POST /api/connections/:id/test": "operator",
  "GET /api/connections/:id/namespaces": "viewer",
  "GET /api/storage": "viewer",
  "POST /api/storage": "admin",
  "PUT /api/storage/:id": "admin",
  "DELETE /api/storage/:id": "admin",
  "POST /api/storage/:id/test": "operator",
  "GET /api/plans": "viewer",
  "POST /api/plans": "admin",
  "PUT /api/plans/:id": "admin",
  "DELETE /api/plans/:id": "admin",
  "POST /api/plans/:id/run": "operator",
  "POST /api/plans/:id/prune/plan": "admin",
  "POST /api/plans/:id/prune": "admin",
  "GET /api/storage/:id/backups": "viewer",
  "GET /api/storage/:id/backups/:backupId": "viewer",
  "POST /api/storage/:id/backups/:backupId/verify": "operator",
  "POST /api/storage/:id/backups/:backupId/drill": "operator",
  "POST /api/storage/:id/backups/:backupId/hold": "operator",
  "DELETE /api/storage/:id/backups/:backupId/hold": "admin",
  "GET /api/storage/:id/backups/:backupId/documents": "operator",
  "POST /api/restore/plan": "operator",
  "POST /api/restore": "operator",
  "GET /api/jobs": "viewer",
  "GET /api/jobs/:id": "viewer",
  "POST /api/jobs/:id/cancel": "operator",
  "GET /api/audit": "viewer",
  "GET /api/config/export": "admin",
  "POST /api/config/import": "admin",
};

const ROUTE_KEYS = Object.keys(ROUTE_ROLES).filter((key): key is RouteKey => key in ROUTE_ROLES);

// ---------------------------------------------------------------------------
// Options and the public backend object
// ---------------------------------------------------------------------------

/** How the mock behaves. */
export interface MockBackendOptions {
  /** Start before setup (the setup page needs token `mock-setup-token`). */
  readonly setupComplete?: boolean;
  /** Start signed in as this user (`admin`, `maya`, `sam`). */
  readonly signedInAs?: string;
  /** Delay before each response, to make loading states visible. Default 0. */
  readonly latencyMs?: number;
  /** Time between job progress steps. 0 disables automatic progress (tests drive it). */
  readonly jobTickMs?: number;
  /** Fixed "now" for fixtures, so test output is stable. */
  readonly now?: number;
  /**
   * Sign-in methods the mock advertises. Default `["password"]`. With `"oidc"` or
   * `"proxy"` the login page offers single sign-on and admins may create SSO-only users.
   */
  readonly authMethods?: SessionInfo["authMethods"];
}

/** A running mock server. */
export interface MockBackend {
  readonly fetch: FetchLike;
  readonly openEventSource: EventSourceFactory;
  /** The data, for tests to inspect. */
  readonly data: MockData;
  /** Requests received so far (method, path, headers, body), for tests to inspect. */
  readonly requests: {
    method: string;
    url: string;
    headers: Record<string, string>;
    body: unknown;
  }[];
  /** Moves every running job one step forward (used when `jobTickMs` is 0). */
  tickJobs(): void;
  /** Stops timers. */
  dispose(): void;
}

/** The setup token the mock accepts, shown in mock mode's setup hint. */
export const MOCK_SETUP_TOKEN = "mock-setup-token";

/** Steps a mock job takes from start to finish. */
const JOB_STEPS = 12;

/** Per-job runtime state, including the events replayed to new subscribers. */
interface JobRuntime {
  step: number;
  readonly namespaces: readonly { ns: string; documents: number }[];
  readonly history: JobEvent[];
  readonly listeners: Set<(event: JobEvent) => void>;
  readonly onSuccess?: () => string;
}

/** Creates a fresh mock server with its own copy of the fixtures. */
export function createMockBackend(options: MockBackendOptions = {}): MockBackend {
  const now = options.now ?? Date.now();
  const data = createFixtures(now);
  let setupComplete = options.setupComplete ?? true;
  let sessionUserId: string | undefined = data.users.find(
    (user) => user.username === options.signedInAs,
  )?.id;
  let csrfToken = randomToken();
  let nextId = 2000;
  const authMethods = options.authMethods ?? ["password"];
  // SSO-only accounts are possible only when some single sign-on method is enabled.
  const ssoEnabled = authMethods.includes("oidc") || authMethods.includes("proxy");
  const runtimes = new Map<string, JobRuntime>();
  const requests: MockBackend["requests"] = [];

  // ---- helpers -----------------------------------------------------------

  const newId = (prefix: string) => {
    nextId += 1;
    return `${prefix}-${nextId}`;
  };

  const currentUser = (): UserView | undefined => {
    const user = data.users.find((candidate) => candidate.id === sessionUserId);
    return user === undefined ? undefined : toUserView(user);
  };

  const sessionInfo = (): SessionInfo => {
    const user = currentUser();
    return {
      setupComplete,
      authMethods,
      ...(user === undefined ? {} : { user, csrfToken }),
    };
  };

  const audit = (
    action: string,
    outcome: "success" | "failure",
    target?: string,
    details?: Record<string, string | number | boolean>,
  ) => {
    data.audit.unshift({
      at: new Date().toISOString(),
      actor: currentUser()?.username ?? "anonymous",
      action,
      outcome,
      ...(target === undefined ? {} : { target }),
      ...(details === undefined ? {} : { details }),
    });
  };

  const findConnection = (id: string | undefined) => {
    const connection = data.connections.find((candidate) => candidate.id === id);
    if (connection === undefined)
      throw new MockHttpError(404, "CONSOLE_NOT_FOUND", `Connection "${id}" does not exist.`);
    return connection;
  };
  const findStorage = (id: string | undefined) => {
    const storage = data.storage.find((candidate) => candidate.id === id);
    if (storage === undefined)
      throw new MockHttpError(404, "CONSOLE_NOT_FOUND", `Storage "${id}" does not exist.`);
    return storage;
  };
  const findPlan = (id: string | undefined) => {
    const plan = data.plans.find((candidate) => candidate.id === id);
    if (plan === undefined)
      throw new MockHttpError(404, "CONSOLE_NOT_FOUND", `Plan "${id}" does not exist.`);
    return plan;
  };
  const findBackup = (storageId: string | undefined, backupId: string | undefined) => {
    const backup = data.backups.find(
      (candidate) => candidate.storageId === storageId && candidate.id === backupId,
    );
    if (backup === undefined)
      throw new MockHttpError(
        404,
        "MS_BACKUP_NOT_FOUND",
        `Backup "${backupId}" was not found in this storage.`,
      );
    return backup;
  };
  const findJob = (id: string | undefined) => {
    const job = data.jobs.find((candidate) => candidate.id === id);
    if (job === undefined)
      throw new MockHttpError(404, "CONSOLE_NOT_FOUND", `Job "${id}" does not exist.`);
    return job;
  };

  const requireName = (name: string, what: string) => {
    if (name.trim() === "")
      throw new MockHttpError(400, "CONSOLE_INVALID_INPUT", `The ${what} needs a name.`);
  };

  // ---- jobs --------------------------------------------------------------

  const emit = (jobId: string, event: JobEvent) => {
    const runtime = runtimes.get(jobId);
    if (runtime === undefined) return;
    // Keep status + latest progress + all logs, which is what a reconnecting client needs.
    if (event.type === "progress") {
      const previous = runtime.history.findIndex((entry) => entry.type === "progress");
      if (previous !== -1) runtime.history.splice(previous, 1);
    }
    if (event.type === "status") {
      const previous = runtime.history.findIndex((entry) => entry.type === "status");
      if (previous !== -1) runtime.history.splice(previous, 1);
    }
    runtime.history.push(event);
    for (const listener of runtime.listeners) listener(event);
  };

  const replaceJob = (job: JobSummary) => {
    const index = data.jobs.findIndex((candidate) => candidate.id === job.id);
    if (index !== -1) data.jobs[index] = job;
    for (const plan of data.plans) {
      if (plan.id === job.planId) Object.assign(plan, { lastRun: job });
    }
    emit(job.id, { type: "status", job });
  };

  const startJob = (
    kind: JobKind,
    namespaces: readonly { ns: string; documents: number }[],
    extra: {
      planId?: string;
      storageId?: string;
      backupId?: string;
      onSuccess?: () => string;
    } = {},
  ): JobSummary => {
    const job: JobSummary = {
      id: newId("job"),
      kind,
      status: "running",
      startedAt: new Date().toISOString(),
      startedBy: currentUser()?.username ?? "schedule",
      ...(extra.planId === undefined ? {} : { planId: extra.planId }),
      ...(extra.storageId === undefined ? {} : { storageId: extra.storageId }),
      ...(extra.backupId === undefined ? {} : { backupId: extra.backupId }),
    };
    data.jobs.unshift(job);
    runtimes.set(job.id, {
      step: 0,
      namespaces,
      history: [],
      listeners: new Set(),
      ...(extra.onSuccess === undefined ? {} : { onSuccess: extra.onSuccess }),
    });
    replaceJob(job);
    emit(job.id, { type: "log", level: "info", message: `${kind} started by ${job.startedBy}` });
    return job;
  };

  /** Advances one job by one step: progress, a log line now and then, and the finish. */
  const tickJob = (job: JobSummary) => {
    const runtime = runtimes.get(job.id);
    if (runtime === undefined || job.status !== "running") return;
    runtime.step += 1;
    const total = runtime.namespaces.reduce((sum, entry) => sum + entry.documents, 0);
    const done = Math.round((total * runtime.step) / JOB_STEPS);
    // Which namespace the cursor is in right now; the ones before it are finished,
    // and each is reported once, like the server's unthrottled "namespace" events.
    const previousDone = Math.round((total * (runtime.step - 1)) / JOB_STEPS);
    let cumulative = 0;
    let current = runtime.namespaces[0]?.ns;
    let currentDocuments = 0;
    for (const entry of runtime.namespaces) {
      const start = cumulative;
      cumulative += entry.documents;
      current = entry.ns;
      currentDocuments = done - start;
      if (cumulative > done) break;
      if (cumulative > previousDone) {
        emit(job.id, { type: "namespace", ns: entry.ns, documents: entry.documents });
      }
    }
    emit(job.id, {
      type: "progress",
      documents: done,
      estimatedDocuments: total,
      bytes: done * 1_450,
      etaMs: (JOB_STEPS - runtime.step) * 4_000,
      ...(current === undefined
        ? {}
        : { namespace: current, namespaceDocuments: currentDocuments }),
    });
    if (runtime.step % 4 === 0 && current !== undefined) {
      emit(job.id, { type: "log", level: "info", message: `copying ${current}` });
    }
    if (runtime.step >= JOB_STEPS) {
      const summary =
        runtime.onSuccess?.() ?? `processed ${done.toLocaleString("en-US")} documents`;
      emit(job.id, { type: "log", level: "info", message: summary });
      replaceJob({
        ...job,
        status: "succeeded",
        finishedAt: new Date().toISOString(),
        summary,
        // A backup job's onSuccess returns the new backup id, which the job then points to.
        ...(job.kind === "backup" ? { backupId: summary } : {}),
      });
    }
  };

  const tickJobs = () => {
    for (const job of [...data.jobs]) tickJob(job);
  };

  const timer =
    options.jobTickMs === 0 ? undefined : setInterval(tickJobs, options.jobTickMs ?? 700);

  /** Namespaces (with documents) of the newest complete backup, used for job progress. */
  const backupNamespaces = (backup: BackupDetail | undefined) =>
    namespacesInManifest(backup?.manifest);

  // ---- route handlers ----------------------------------------------------

  const handlers: Handlers = {
    "GET /api/session": () => sessionInfo(),
    "POST /api/session": ({ body }) => {
      // SSO-only accounts have an empty password and can never sign in with one.
      const user = data.users.find(
        (candidate) =>
          candidate.password !== "" &&
          candidate.username === body.username &&
          candidate.password === body.password,
      );
      if (user === undefined) {
        audit("session.login_failed", "failure", undefined, { username: body.username });
        throw new MockHttpError(401, "CONSOLE_LOGIN_FAILED", "Wrong username or password.");
      }
      sessionUserId = user.id;
      csrfToken = randomToken();
      user.lastLoginAt = new Date().toISOString();
      audit("session.login", "success");
      return sessionInfo();
    },
    "DELETE /api/session": () => {
      sessionUserId = undefined;
      return { ok: true };
    },
    "POST /api/setup": ({ body }) => {
      if (setupComplete)
        throw new MockHttpError(
          409,
          "CONSOLE_SETUP_DONE",
          "Setup has already been completed.",
          "Sign in instead.",
        );
      if (body.token !== MOCK_SETUP_TOKEN) {
        throw new MockHttpError(
          403,
          "CONSOLE_SETUP_TOKEN_INVALID",
          "The setup token is invalid or has expired.",
          "Restart the console to print a new setup link.",
        );
      }
      if (body.password.length < 12)
        throw new MockHttpError(
          400,
          "CONSOLE_WEAK_PASSWORD",
          "Use a password of at least 12 characters.",
        );
      const id = newId("user");
      data.users.push({
        id,
        username: body.username,
        role: "admin",
        password: body.password,
        createdAt: new Date().toISOString(),
      });
      setupComplete = true;
      sessionUserId = id;
      csrfToken = randomToken();
      audit("setup.complete", "success", body.username);
      return sessionInfo();
    },

    "GET /api/users": () => data.users.map(toUserView),
    "POST /api/users": ({ body }) => {
      requireName(body.username, "user");
      if (data.users.some((user) => user.username === body.username)) {
        throw new MockHttpError(
          409,
          "CONSOLE_DUPLICATE",
          `A user named "${body.username}" already exists.`,
        );
      }
      if (body.password === undefined && !ssoEnabled) {
        throw new MockHttpError(
          400,
          "CONSOLE_VALIDATION",
          "A password is required for a new user.",
        );
      }
      if (body.password !== undefined && body.password.length < 12) {
        throw new MockHttpError(
          400,
          "CONSOLE_WEAK_PASSWORD",
          "Use a password of at least 12 characters.",
        );
      }
      const user = {
        id: newId("user"),
        username: body.username,
        role: body.role,
        // An empty password marks an SSO-only account (see toUserView).
        password: body.password ?? "",
        createdAt: new Date().toISOString(),
      };
      data.users.push(user);
      audit("user.create", "success", user.username, { role: user.role });
      return toUserView(user);
    },
    "PUT /api/users/:id": ({ params, body }) => {
      const user = data.users.find((candidate) => candidate.id === params.id);
      if (user === undefined) throw new MockHttpError(404, "CONSOLE_NOT_FOUND", "User not found.");
      user.username = body.username;
      user.role = body.role;
      if (body.password !== undefined) user.password = body.password;
      audit("user.update", "success", user.username, { role: user.role });
      return toUserView(user);
    },
    "DELETE /api/users/:id": ({ params, user: actor }) => {
      if (actor?.id === params.id)
        throw new MockHttpError(409, "CONSOLE_SELF_DELETE", "You cannot delete your own account.");
      data.users = data.users.filter((user) => user.id !== params.id);
      audit("user.delete", "success", params.id);
      return { ok: true };
    },

    "GET /api/connections": () => data.connections.map(toConnectionView),
    "POST /api/connections": ({ body }) => {
      requireName(body.name, "connection");
      if (body.uri === undefined || !/^mongodb(\+srv)?:\/\//.test(body.uri)) {
        throw new MockHttpError(
          400,
          "MS_CONFIG_INVALID",
          "The connection string must start with mongodb:// or mongodb+srv://.",
        );
      }
      const connection = {
        id: newId("conn"),
        name: body.name,
        uri: body.uri,
        production: body.production,
        createdAt: new Date().toISOString(),
        topology: "replicaSet",
        serverVersion: "8.0.4",
        missingBackupPrivileges: [],
        missingRestorePrivileges: [],
        namespaces: [
          {
            name: "app",
            collections: [
              { name: "items", type: "collection" as const, estimatedDocuments: 1_000, indexes: 1 },
            ],
          },
        ],
      };
      data.connections.push(connection);
      audit("connection.create", "success", connection.name);
      return toConnectionView(connection);
    },
    "PUT /api/connections/:id": ({ params, body }) => {
      const connection = findConnection(params.id);
      requireName(body.name, "connection");
      connection.name = body.name;
      connection.production = body.production;
      // An omitted URI keeps the stored one; the UI never had it to send back.
      if (body.uri !== undefined) connection.uri = body.uri;
      audit("connection.update", "success", connection.name);
      return toConnectionView(connection);
    },
    "DELETE /api/connections/:id": ({ params }) => {
      if (data.plans.some((plan) => plan.connectionId === params.id)) {
        throw new MockHttpError(
          409,
          "CONSOLE_IN_USE",
          "This connection is used by a backup plan.",
          "Delete or change the plan first.",
        );
      }
      data.connections = data.connections.filter((connection) => connection.id !== params.id);
      audit("connection.delete", "success", params.id);
      return { ok: true };
    },
    "POST /api/connections/:id/test": ({ params }) => {
      const connection = findConnection(params.id);
      if (connection.uri.includes("staging-db.internal")) {
        return {
          ok: false,
          missingBackupPrivileges: [],
          missingRestorePrivileges: [],
          error: {
            code: "MS_SOURCE_UNREACHABLE",
            message: "Could not connect to staging-db.internal:27017 within 30 s.",
            hint: "Check the host name and that the console can reach it.",
          },
        };
      }
      return {
        ok: true,
        topology: connection.topology,
        serverVersion: connection.serverVersion,
        missingBackupPrivileges: connection.missingBackupPrivileges,
        missingRestorePrivileges: connection.missingRestorePrivileges,
      };
    },
    "GET /api/connections/:id/namespaces": ({ params }) => findConnection(params.id).namespaces,

    "GET /api/storage": () => data.storage.map(toStorageView),
    "POST /api/storage": ({ body }) => {
      requireName(body.name, "storage location");
      if (body.url.trim() === "")
        throw new MockHttpError(400, "MS_CONFIG_INVALID", "The storage URL is required.");
      const storage = {
        id: newId("st"),
        name: body.name,
        url: body.url,
        credentials: { ...body.credentials },
        createdAt: new Date().toISOString(),
        objectLock: false,
      };
      data.storage.push(storage);
      audit("storage.create", "success", storage.name);
      return toStorageView(storage);
    },
    "PUT /api/storage/:id": ({ params, body }) => {
      const storage = findStorage(params.id);
      storage.name = body.name;
      storage.url = body.url;
      if (body.credentials !== undefined) storage.credentials = { ...body.credentials };
      audit("storage.update", "success", storage.name);
      return toStorageView(storage);
    },
    "DELETE /api/storage/:id": ({ params }) => {
      if (data.plans.some((plan) => plan.storageId === params.id)) {
        throw new MockHttpError(
          409,
          "CONSOLE_IN_USE",
          "This storage location is used by a backup plan.",
          "Delete or change the plan first.",
        );
      }
      data.storage = data.storage.filter((storage) => storage.id !== params.id);
      audit("storage.delete", "success", params.id);
      return { ok: true };
    },
    "POST /api/storage/:id/test": ({ params }) => {
      const storage = findStorage(params.id);
      return {
        ok: true,
        capabilities: {
          conditionalWrites: storage.url.startsWith("s3://") || storage.url.startsWith("/"),
          rangeReads: true,
          objectLock: storage.objectLock,
        },
      };
    },

    "GET /api/plans": () => data.plans,
    "POST /api/plans": ({ body }) => {
      requireName(body.name, "plan");
      findConnection(body.connectionId);
      findStorage(body.storageId);
      const id = newId("plan");
      const plan = planFromInput(id, body, undefined);
      data.plans.push(plan);
      data.planSecrets[id] = {
        ...(body.encryption.kind === "passphrase" && body.encryption.passphrase !== undefined
          ? { passphrase: body.encryption.passphrase }
          : {}),
        notifyUrls: body.notify.map((target) => target.url ?? ""),
      };
      audit("plan.create", "success", plan.name);
      return plan;
    },
    "PUT /api/plans/:id": ({ params, body }) => {
      const existing = findPlan(params.id);
      const plan = planFromInput(existing.id, body, existing);
      data.plans = data.plans.map((candidate) => (candidate.id === plan.id ? plan : candidate));
      audit("plan.update", "success", plan.name);
      return plan;
    },
    "DELETE /api/plans/:id": ({ params }) => {
      data.plans = data.plans.filter((plan) => plan.id !== params.id);
      audit("plan.delete", "success", params.id);
      return { ok: true };
    },
    "POST /api/plans/:id/run": ({ params }) => {
      const plan = findPlan(params.id);
      const connection = findConnection(plan.connectionId);
      const namespaces = connection.namespaces.flatMap((database) =>
        database.collections
          .map((collection) => ({
            ns: `${database.name}.${collection.name}`,
            documents: collection.estimatedDocuments,
          }))
          .filter((entry) => isSelected(entry.ns, plan.include, plan.exclude)),
      );
      if (data.jobs.some((job) => job.planId === plan.id && job.status === "running")) {
        throw new MockHttpError(409, "MS_LOCKED", "A backup for this plan is already running.");
      }
      audit("plan.run", "success", plan.name);
      return startJob("backup", namespaces, {
        planId: plan.id,
        storageId: plan.storageId,
        onSuccess: () => {
          const started = new Date();
          const id = `${started.toISOString().slice(0, 19).replaceAll(":", "-")}Z_${randomToken().slice(0, 6)}`;
          const template = data.backups.find((backup) => backup.status === "complete");
          data.backups.unshift({
            ...(template ?? { drills: [] }),
            id,
            storageId: plan.storageId,
            planId: plan.id,
            status: "complete",
            startedAt: started.toISOString(),
            completedAt: new Date().toISOString(),
            encrypted: plan.encryption.kind !== "none",
            drills: [],
          } satisfies MockBackup);
          return id;
        },
      });
    },

    "POST /api/plans/:id/prune/plan": ({ params }) => prunePlan(findPlan(params.id)),
    "POST /api/plans/:id/prune": ({ params, body }) => {
      const plan = findPlan(params.id);
      const current = prunePlan(plan);
      if (current.remove.length === 0) {
        throw new MockHttpError(400, "CONSOLE_VALIDATION", "There is nothing to prune.");
      }
      // Never delete more than the user confirmed: the catalog may have changed since.
      const confirmed = new Set(body.remove);
      if (current.remove.some((entry) => !confirmed.has(entry.id))) {
        throw new MockHttpError(
          409,
          "CONSOLE_PRUNE_PLAN_CHANGED",
          "The backups to delete changed since the dry run.",
          "Review the plan again.",
        );
      }
      audit("plan.prune", "success", plan.name, { backups: current.remove.length });
      return startJob("prune", [], {
        planId: plan.id,
        storageId: plan.storageId,
        onSuccess: () => {
          const removed = new Set(current.remove.map((entry) => entry.id));
          data.backups = data.backups.filter((backup) => !removed.has(backup.id));
          return `deleted ${removed.size} backups, kept ${current.keep.length}`;
        },
      });
    },

    "GET /api/storage/:id/backups": ({ params }) => {
      findStorage(params.id);
      return data.backups.filter((backup) => backup.storageId === params.id).map(toBackupSummary);
    },
    "GET /api/storage/:id/backups/:backupId": ({ params }) => {
      const { storageId: _storageId, ...detail } = findBackup(params.id, params.backupId);
      return detail;
    },
    "POST /api/storage/:id/backups/:backupId/verify": ({ params, body }) => {
      const backup = findBackup(params.id, params.backupId);
      if (backup.status !== "complete")
        throw new MockHttpError(
          409,
          "MS_BACKUP_INCOMPLETE",
          "Only complete backups can be verified.",
        );
      audit("backup.verify", "success", backup.id, { mode: body.mode });
      return startJob("verify", backupNamespaces(backup), {
        storageId: backup.storageId,
        backupId: backup.id,
        onSuccess: () => {
          replaceBackup({
            ...backup,
            verification: { mode: body.mode, ok: true, verifiedAt: new Date().toISOString() },
          });
          return `${body.mode} verify passed`;
        },
      });
    },
    "POST /api/storage/:id/backups/:backupId/drill": ({ params, body }) => {
      const backup = findBackup(params.id, params.backupId);
      const target = findConnection(body.targetConnectionId);
      if (target.production) {
        throw new MockHttpError(
          400,
          "CONSOLE_DRILL_PRODUCTION",
          "Drills cannot target a production connection.",
          "Choose a staging or scratch connection.",
        );
      }
      audit("drill.start", "success", target.name);
      return startJob("drill", backupNamespaces(backup), {
        storageId: backup.storageId,
        backupId: backup.id,
        onSuccess: () => {
          replaceBackup({
            ...backup,
            drills: [
              { drilledAt: new Date().toISOString(), ok: true, rtoMs: 9 * 60_000 },
              ...backup.drills,
            ],
          });
          return `drill into ${target.name} succeeded`;
        },
      });
    },
    "POST /api/storage/:id/backups/:backupId/hold": ({ params, body }) => {
      const backup = findBackup(params.id, params.backupId);
      if (body.reason.trim() === "")
        throw new MockHttpError(400, "CONSOLE_INVALID_INPUT", "Give a reason for the hold.");
      replaceBackup({ ...backup, hold: { reason: body.reason, heldAt: new Date().toISOString() } });
      audit("backup.hold", "success", backup.id, { reason: body.reason });
      return { ok: true };
    },
    "DELETE /api/storage/:id/backups/:backupId/hold": ({ params }) => {
      const { hold: _hold, ...backup } = findBackup(params.id, params.backupId);
      replaceBackup(backup);
      audit("backup.release", "success", backup.id);
      return { ok: true };
    },
    "GET /api/storage/:id/backups/:backupId/documents": ({ params, query }) => {
      const backup = findBackup(params.id, params.backupId);
      const ns = query.get("ns") ?? "";
      const entry = backupNamespaces(backup).find((candidate) => candidate.ns === ns);
      if (entry === undefined)
        throw new MockHttpError(
          404,
          "MS_NAMESPACE_NOT_FOUND",
          `The backup has no namespace "${ns}".`,
        );
      const limit = Math.min(100, Math.max(1, Number(query.get("limit") ?? "20")));
      const filter = parseMockFilter(query.get("filter"));
      return pageOfDocuments(entry, backup, filter, Number(query.get("after") ?? "0"), limit);
    },

    "POST /api/restore/plan": ({ body }) => restorePlan(body),
    "POST /api/restore": ({ body, user }) => {
      const target = findConnection(body.targetConnectionId);
      if (target.production) {
        if (!roleIncludes(user?.role, "admin")) {
          throw new MockHttpError(
            403,
            "CONSOLE_FORBIDDEN",
            "Only admins can restore into a production connection.",
          );
        }
        if (body.confirmName !== target.name) {
          throw new MockHttpError(
            400,
            "CONSOLE_CONFIRMATION_REQUIRED",
            `Type the connection name "${target.name}" to confirm a restore into production.`,
          );
        }
      }
      const plan = restorePlan(body);
      if (plan.entries.some((entry) => entry.action === "fail")) {
        throw new MockHttpError(
          409,
          "MS_RESTORE_CONFLICT",
          "Some target collections already contain documents.",
          'Choose mode "drop", "insert" or "upsert", or rename the targets.',
        );
      }
      audit("restore.start", "success", target.name, { mode: body.mode });
      return startJob(
        "restore",
        plan.entries.map((entry) => ({ ns: entry.to, documents: entry.documents })),
        {
          storageId: body.storageId,
          backupId: body.backupId,
          onSuccess: () =>
            `restored ${plan.entries.reduce((sum, entry) => sum + entry.documents, 0).toLocaleString("en-US")} documents into ${target.name}`,
        },
      );
    },

    "GET /api/jobs": () => data.jobs,
    "GET /api/jobs/:id": ({ params }) => findJob(params.id),
    "POST /api/jobs/:id/cancel": ({ params }) => {
      const job = findJob(params.id);
      if (job.status !== "running" && job.status !== "queued") {
        throw new MockHttpError(409, "CONSOLE_JOB_FINISHED", "The job has already finished.");
      }
      const cancelled: JobSummary = {
        ...job,
        status: "cancelled",
        finishedAt: new Date().toISOString(),
        summary: "cancelled by user",
      };
      emit(job.id, {
        type: "log",
        level: "warn",
        message: `cancelled by ${currentUser()?.username ?? "unknown"}`,
      });
      replaceJob(cancelled);
      audit("job.cancel", "success", job.id);
      return cancelled;
    },

    "GET /api/audit": ({ query }) => {
      const limit = Number(query.get("limit") ?? "50");
      const before = query.get("before");
      return data.audit.filter((entry) => before === null || entry.at < before).slice(0, limit);
    },

    "GET /api/config/export": () => ({
      filename: "mongoshield.config.ts",
      content: configExport(data),
    }),
    "POST /api/config/import": ({ body }) => importConfig(body),
  };

  /**
   * The mock's retention planner, scoped like the real one to the plan's own backups
   * (its `planId`); the rest of the storage is only counted as `outOfScope`. Holds and
   * object locks always keep a backup, the newest `last` complete backups are kept,
   * then the newest complete backup of each of the last `daily` days. Incomplete and
   * invalid backups are removed.
   */
  function prunePlan(plan: PlanView): PrunePlanView {
    const policy = plan.retention;
    if (policy === undefined) {
      throw new MockHttpError(
        400,
        "CONSOLE_VALIDATION",
        `The plan "${plan.name}" has no retention policy.`,
        "Add one in the plan editor first.",
      );
    }
    const inStorage = data.backups.filter((backup) => backup.storageId === plan.storageId);
    const backups = inStorage
      .filter((backup) => backup.planId === plan.id)
      .sort((left, right) => right.startedAt.localeCompare(left.startedAt));
    const keep: { id: string; reasons: string[] }[] = [];
    const remove: { id: string; reason: string }[] = [];
    const days = new Set<string>();
    let lastKept = 0;
    for (const backup of backups) {
      const reasons: string[] = [];
      if (backup.hold !== undefined) reasons.push("held");
      if (backup.immutableUntil !== undefined && Date.parse(backup.immutableUntil) > Date.now()) {
        reasons.push("immutable");
      }
      if (backup.status === "complete") {
        if (lastKept < (policy.last ?? 0)) {
          lastKept += 1;
          reasons.push(`last ${policy.last}`);
        }
        const day = backup.startedAt.slice(0, 10);
        if (!days.has(day) && days.size < (policy.daily ?? 0)) {
          days.add(day);
          reasons.push("daily");
        }
      }
      if (reasons.length > 0) keep.push({ id: backup.id, reasons });
      else
        remove.push({
          id: backup.id,
          reason: backup.status === "complete" ? "not selected by the policy" : backup.status,
        });
    }
    return {
      planId: plan.id,
      storageId: plan.storageId,
      policy,
      keep,
      remove,
      warnings: [],
      outOfScope: inStorage.length - backups.length,
    };
  }

  /** Dry run or apply of a config import (see `ConfigImportRequest`). */
  function importConfig(body: ConfigImportRequest): ConfigImportResult {
    const configs = importedConfigs(body);
    const changes: ConfigImportChange[] = [];
    const warnings: string[] = [];
    const apply: (() => void)[] = [];

    for (const [name, config] of configs) {
      const secrets = body.secrets?.[name];
      const existingPlan = data.plans.find((plan) => plan.name === name);

      // Storage: matched by URL, created when new.
      let storage = data.storage.find((candidate) => candidate.url === config.storage);
      if (storage === undefined) {
        const created = {
          id: newId("st"),
          name: config.storage,
          url: config.storage,
          credentials: { ...secrets?.storageCredentials },
          createdAt: new Date().toISOString(),
          objectLock: false,
        };
        storage = created;
        changes.push({ kind: "storage", name: created.name, action: "create", fields: [] });
        apply.push(() => data.storage.push(created));
      }

      // Connection: matched by the URI without its password.
      const uri = secrets?.uri ?? config.uri;
      let connectionId = existingPlan?.connectionId;
      if (uri !== undefined) {
        const match = data.connections.find(
          (candidate) => redactUri(candidate.uri) === redactUri(uri),
        );
        if (match === undefined) {
          const created = {
            id: newId("conn"),
            name: hostOf(uri),
            uri,
            // Imported connections are marked production: the safe default for restores.
            production: true,
            createdAt: new Date().toISOString(),
            topology: "replicaSet",
            serverVersion: "8.0.4",
            missingBackupPrivileges: [],
            missingRestorePrivileges: [],
            namespaces: [],
          };
          connectionId = created.id;
          changes.push({ kind: "connection", name: created.name, action: "create", fields: [] });
          apply.push(() => data.connections.push(created));
        } else {
          connectionId = match.id;
        }
      }
      if (connectionId === undefined) {
        throw new MockHttpError(
          400,
          "CONSOLE_VALIDATION",
          `"${name}" needs a connection string: set source.uri or secrets["${name}"].uri.`,
        );
      }

      const input: PlanInput = {
        name,
        connectionId,
        storageId: storage.id,
        include: config.include,
        exclude: config.exclude,
        compression: config.compression,
        encryption: config.encryption,
        consistency: "auto",
        verify: "fast",
        notify: [],
        ...(config.retention === undefined ? {} : { retention: config.retention }),
        ...(config.cron === undefined
          ? {}
          : { schedule: { cron: config.cron, timezone: config.timezone ?? "UTC" } }),
      };
      if (existingPlan === undefined) {
        changes.push({ kind: "plan", name, action: "create", fields: [] });
        apply.push(() => data.plans.push(planFromInput(newId("plan"), input, undefined)));
      } else {
        const fields = planDifferences(existingPlan, input);
        changes.push({
          kind: "plan",
          name,
          action: fields.length === 0 ? "unchanged" : "update",
          fields,
        });
        apply.push(() => {
          const updated = planFromInput(existingPlan.id, input, existingPlan);
          data.plans = data.plans.map((plan) => (plan.id === updated.id ? updated : plan));
        });
      }
      warnings.push(
        ...config.ignored.map(
          (key) => `"${name}": ${key} is not managed by the console and was ignored.`,
        ),
      );
    }

    if (!body.dryRun) {
      for (const step of apply) step();
      audit("config.import", "success", undefined, { plans: configs.length });
    }
    return { dryRun: body.dryRun, changes, warnings };
  }

  function replaceBackup(backup: BackupDetail) {
    data.backups = data.backups.map((candidate) =>
      candidate.id === backup.id ? { ...backup, storageId: candidate.storageId } : candidate,
    );
  }

  /** The dry-run plan: what goes where, how many documents, and what happens on conflict. */
  function restorePlan(body: RestoreRequest): RestorePlanView {
    const backup = findBackup(body.storageId, body.backupId);
    const target = findConnection(body.targetConnectionId);
    const filter =
      "filter" in body && typeof body.filter === "string"
        ? parseMockFilter(body.filter)
        : undefined;
    const entries = backupNamespaces(backup)
      .filter((entry) => isSelected(entry.ns, body.include ?? [], body.exclude ?? []))
      .map((entry) => {
        const to = applyRename(entry.ns, body.rename ?? {});
        const [database, ...rest] = to.split(".");
        const existing = target.namespaces
          .find((node) => node.name === database)
          ?.collections.find((collection) => collection.name === rest.join("."));
        const existingDocuments = existing?.estimatedDocuments;
        const documents =
          filter === undefined ? entry.documents : countMatching(entry, backup, filter);
        return { from: entry.ns, to, documents, ...actionFor(body.mode, existingDocuments) };
      });
    return { backupId: backup.id, mode: body.mode, entries };
  }

  // ---- fetch and EventSource -----------------------------------------------

  const fetchImpl: FetchLike = async (url, init) => {
    if ((options.latencyMs ?? 0) > 0)
      await new Promise((resolve) => setTimeout(resolve, options.latencyMs));
    const parsedBody: unknown = init.body === undefined ? undefined : JSON.parse(init.body);
    requests.push({ method: init.method, url, headers: init.headers, body: parsedBody });
    try {
      return jsonResponse(200, handle(url, init, parsedBody));
    } catch (error) {
      if (error instanceof MockHttpError) {
        const body: ApiError = {
          error: {
            code: error.code,
            message: error.message,
            ...(error.hint === undefined ? {} : { hint: error.hint }),
          },
        };
        return jsonResponse(error.status, body);
      }
      throw error;
    }
  };

  function handle(url: string, init: HttpRequestInit, body: unknown): unknown {
    const parsedUrl = new URL(url, "http://mock.local");
    for (const route of ROUTE_KEYS) {
      const space = route.indexOf(" ");
      if (route.slice(0, space) !== init.method) continue;
      const params = matchPath(route.slice(space + 1), parsedUrl.pathname);
      if (params === undefined) continue;

      const required = ROUTE_ROLES[route];
      const user = currentUser();
      if (required !== "public") {
        if (user === undefined)
          throw new MockHttpError(
            401,
            "CONSOLE_UNAUTHENTICATED",
            "Your session has expired. Sign in again.",
          );
        if (init.method !== "GET" && init.headers["x-csrf-token"] !== csrfToken) {
          throw new MockHttpError(
            403,
            "CONSOLE_CSRF",
            "The request was missing a valid CSRF token.",
            "Reload the page and try again.",
          );
        }
        if (!roleIncludes(user.role, required)) {
          throw new MockHttpError(
            403,
            "CONSOLE_FORBIDDEN",
            `This needs the ${required} role; you are ${user.role}.`,
          );
        }
      }
      return callHandler(route, { params, query: parsedUrl.searchParams, body, user });
    }
    throw new MockHttpError(
      404,
      "CONSOLE_NOT_FOUND",
      `No route for ${init.method} ${parsedUrl.pathname}.`,
    );
  }

  /**
   * Dispatches to the route's handler. The body is JSON the client produced from the
   * same `RequestOf<Route>` type, so it is passed through as that type.
   */
  function callHandler<Route extends RouteKey>(
    route: Route,
    input: Omit<HandlerInput<Route>, "body"> & { body: unknown },
  ): ResponseOf<Route> {
    const handler: Handler<Route> = handlers[route];
    return handler({ ...input, body: input.body as RequestOf<Route> });
  }

  const openEventSource: EventSourceFactory = (url, streamHandlers) => {
    const match = /\/api\/jobs\/([^/]+)\/events$/.exec(new URL(url, "http://mock.local").pathname);
    const jobId = decodeURIComponent(match?.[1] ?? "");
    let closed = false;
    const listener = (event: JobEvent) => {
      if (!closed) streamHandlers.onMessage(JSON.stringify(event));
    };
    // Open asynchronously, like a real EventSource.
    setTimeout(() => {
      if (closed) return;
      streamHandlers.onOpen();
      const runtime = runtimes.get(jobId);
      if (runtime === undefined) {
        // A job from before this "server" started: just report its final status.
        const job = data.jobs.find((candidate) => candidate.id === jobId);
        if (job !== undefined) listener({ type: "status", job });
        return;
      }
      for (const event of runtime.history) listener(event);
      runtime.listeners.add(listener);
    }, 0);
    return {
      close: () => {
        closed = true;
        runtimes.get(jobId)?.listeners.delete(listener);
      },
    };
  };

  return {
    fetch: fetchImpl,
    openEventSource,
    data,
    requests,
    tickJobs,
    dispose: () => {
      if (timer !== undefined) clearInterval(timer);
    },
  };
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

function jsonResponse(status: number, body: unknown): HttpResponseLike {
  const text = body === undefined ? "" : JSON.stringify(body);
  return { status, text: async () => text };
}

function randomToken(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function toUserView(user: MockData["users"][number]): UserView {
  return {
    id: user.id,
    username: user.username,
    role: user.role,
    signIn: user.password === "" ? "sso" : "password",
    createdAt: user.createdAt,
    ...(user.lastLoginAt === undefined ? {} : { lastLoginAt: user.lastLoginAt }),
  };
}

/** `mongodb+srv://backup:s3cr3t@host/…` → `mongodb+srv://backup:***@host`. */
export function redactUri(uri: string): string {
  const withoutPassword = uri.replace(/\/\/([^:/@]+):[^@]*@/, "//$1:***@");
  const queryStart = withoutPassword.indexOf("?");
  return queryStart === -1 ? withoutPassword : withoutPassword.slice(0, queryStart);
}

function toConnectionView(connection: MockData["connections"][number]): ConnectionView {
  return {
    id: connection.id,
    name: connection.name,
    uri: { configured: true, preview: redactUri(connection.uri) },
    production: connection.production,
    createdAt: connection.createdAt,
  };
}

function toStorageView(storage: MockData["storage"][number]): StorageView {
  const keys = Object.keys(storage.credentials);
  return {
    id: storage.id,
    name: storage.name,
    url: storage.url,
    credentials: {
      configured: keys.length > 0,
      ...(keys.length > 0 ? { preview: keys.join(", ") } : {}),
    },
    createdAt: storage.createdAt,
  };
}

function toBackupSummary(backup: MockBackup): BackupSummary {
  const { storageId: _storageId, manifest: _manifest, drills: _drills, ...summary } = backup;
  return summary;
}

/** Builds the stored plan from editor input; secrets become summaries. */
function planFromInput(id: string, input: PlanInput, existing: PlanView | undefined): PlanView {
  const encryption: PlanView["encryption"] =
    input.encryption.kind === "passphrase"
      ? {
          kind: "passphrase",
          passphrase: {
            configured:
              input.encryption.passphrase !== undefined ||
              existing?.encryption.kind === "passphrase",
          },
        }
      : input.encryption;
  return {
    id,
    name: input.name,
    connectionId: input.connectionId,
    storageId: input.storageId,
    include: input.include,
    exclude: input.exclude,
    compression: input.compression,
    encryption,
    consistency: input.consistency,
    verify: input.verify,
    notify: input.notify.map((target, index) => ({
      type: target.type,
      url:
        target.url === undefined
          ? (existing?.notify[index]?.url ?? { configured: false })
          : { configured: true, preview: `${new URL(target.url).origin}/***` },
    })),
    ...(input.schedule === undefined ? {} : { schedule: input.schedule }),
    ...(input.retention === undefined ? {} : { retention: input.retention }),
    ...(existing?.lastRun === undefined ? {} : { lastRun: existing.lastRun }),
    ...(input.schedule === undefined
      ? {}
      : { nextRunAt: new Date(Date.now() + 3_600_000).toISOString() }),
  };
}

/** Reads `namespaces[].ns/documents` from a manifest of unknown shape. */
function namespacesInManifest(manifest: unknown): { ns: string; documents: number }[] {
  if (typeof manifest !== "object" || manifest === null || !("namespaces" in manifest)) return [];
  const list: unknown = manifest.namespaces;
  if (!Array.isArray(list)) return [];
  const result: { ns: string; documents: number }[] = [];
  for (const item of list) {
    if (typeof item === "object" && item !== null && "ns" in item && typeof item.ns === "string") {
      const documents =
        "documents" in item && typeof item.documents === "number" ? item.documents : 0;
      result.push({ ns: item.ns, documents });
    }
  }
  return result;
}

/** What a restore would do with a namespace, given the mode and what already exists. */
function actionFor(
  mode: RestoreRequest["mode"],
  existingDocuments: number | undefined,
): { action: string; reason?: string; existingDocuments?: number } {
  const exists = existingDocuments !== undefined;
  const base = exists ? { existingDocuments } : {};
  if (!exists) return { ...base, action: "create" };
  switch (mode) {
    case "fail-if-exists":
      return existingDocuments > 0
        ? {
            ...base,
            action: "fail",
            reason: `the target already has ${existingDocuments.toLocaleString("en-US")} documents`,
          }
        : { ...base, action: "restore", reason: "the target exists but is empty" };
    case "drop":
      return {
        ...base,
        action: "drop",
        reason: `drops ${existingDocuments.toLocaleString("en-US")} existing documents first`,
      };
    case "insert":
      return { ...base, action: "insert", reason: "documents with an existing _id will fail" };
    case "upsert":
      return { ...base, action: "upsert", reason: "replaces documents with the same _id" };
  }
}

/** The tiny filter language the mock understands: equality and `$in` per top-level field. */
type MockFilter = Readonly<Record<string, unknown>>;

function parseMockFilter(text: string | null): MockFilter | undefined {
  if (text === null || text === "") return undefined;
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value !== "object" || value === null || Array.isArray(value))
      throw new Error("not an object");
    return Object.fromEntries(Object.entries(value));
  } catch {
    throw new MockHttpError(400, "MS_FILTER_INVALID", "The filter is not valid Extended JSON.");
  }
}

function documentMatches(document: Record<string, unknown>, filter: MockFilter): boolean {
  return Object.entries(filter).every(([field, condition]) => {
    const value = JSON.stringify(document[field]);
    if (
      typeof condition === "object" &&
      condition !== null &&
      "$in" in condition &&
      Array.isArray(condition.$in)
    ) {
      return condition.$in.some((candidate: unknown) => JSON.stringify(candidate) === value);
    }
    return JSON.stringify(condition) === value;
  });
}

/** The mock only scans this many generated documents when filtering. */
const FILTER_SCAN_LIMIT = 5_000;

function backupTime(backup: BackupDetail): number {
  return new Date(backup.startedAt).getTime();
}

function pageOfDocuments(
  entry: { ns: string; documents: number },
  backup: BackupDetail,
  filter: MockFilter | undefined,
  after: number,
  limit: number,
): DocumentPage {
  const documents: string[] = [];
  const end = filter === undefined ? entry.documents : Math.min(entry.documents, FILTER_SCAN_LIMIT);
  let index = Number.isFinite(after) ? after : 0;
  while (index < end && documents.length < limit) {
    const document = generateDocument(entry.ns, index, backupTime(backup));
    if (filter === undefined || documentMatches(document, filter))
      documents.push(JSON.stringify(document));
    index += 1;
  }
  return index < end ? { documents, next: String(index) } : { documents };
}

function countMatching(
  entry: { ns: string; documents: number },
  backup: BackupDetail,
  filter: MockFilter,
): number {
  let count = 0;
  const end = Math.min(entry.documents, FILTER_SCAN_LIMIT);
  for (let index = 0; index < end; index += 1) {
    if (documentMatches(generateDocument(entry.ns, index, backupTime(backup)), filter)) count += 1;
  }
  return count;
}

function configExport(data: MockData): string {
  const plan = data.plans[0];
  return [
    'import { defineConfig } from "mongoshield";',
    "",
    "// Exported from the MongoShield console. Secrets are environment references.",
    "export default defineConfig({",
    "  source: { uri: process.env.MONGODB_URI },",
    `  storage: ${JSON.stringify(data.storage[0]?.url ?? "./backups")},`,
    "  encryption: { recipients: [process.env.BACKUP_PUBLIC_KEY] },",
    `  backup: { include: ${JSON.stringify(plan?.include ?? [])}, exclude: ${JSON.stringify(plan?.exclude ?? [])} },`,
    `  retention: ${JSON.stringify(plan?.retention ?? {})},`,
    "});",
    "",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Config import (mock): a small subset of the real server's validation
// ---------------------------------------------------------------------------

/** The parts of one imported config the mock understands. */
interface MockImportedConfig {
  readonly storage: string;
  readonly uri: string | undefined;
  readonly include: readonly string[];
  readonly exclude: readonly string[];
  readonly compression: PlanInput["compression"];
  readonly encryption: PlanInput["encryption"];
  readonly retention: PlanInput["retention"];
  readonly cron: string | undefined;
  readonly timezone: string | undefined;
  /** Top-level keys the mock does not model, reported as warnings. */
  readonly ignored: readonly string[];
}

/** Config keys the mock models; anything else becomes a warning. */
const MODELLED_KEYS = new Set([
  "source",
  "storage",
  "compression",
  "encryption",
  "backup",
  "retention",
  "schedule",
  "notify",
]);

function isPlainObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalidImport(message: string, hint?: string): MockHttpError {
  return new MockHttpError(400, "CONSOLE_VALIDATION", message, hint);
}

/** `{ storage, … }` is one config; anything else must map plan names to configs. */
function importedConfigs(body: ConfigImportRequest): [string, MockImportedConfig][] {
  const document = body.document;
  if (!isPlainObject(document)) throw invalidImport("The document must be a JSON object.");
  const entries: [string, unknown][] =
    "storage" in document
      ? [[body.planName?.trim() || "Imported plan", document]]
      : Object.entries(document);
  if (entries.length === 0) throw invalidImport("The document contains no config.");
  return entries.map(([name, config]) => [name, parseImportedConfig(name, config)]);
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function parseImportedConfig(name: string, config: unknown): MockImportedConfig {
  if (!isPlainObject(config)) throw invalidImport(`"${name}" must be a config object.`);
  if (typeof config.storage !== "string" || config.storage.trim() === "") {
    throw invalidImport(`"${name}": storage must be a storage URL.`);
  }
  const source = isPlainObject(config.source) ? config.source : {};
  const uri = typeof source.uri === "string" ? source.uri : undefined;
  // Secrets never travel inside the document; the real server refuses them the same way.
  if (uri !== undefined && /\/\/[^/@]*:[^/@]*@/.test(uri)) {
    throw invalidImport(
      `"${name}": source.uri contains a password.`,
      `Pass it as secrets["${name}"].uri instead.`,
    );
  }
  const encryption = isPlainObject(config.encryption) ? config.encryption : undefined;
  if (encryption !== undefined && "passphrase" in encryption) {
    throw invalidImport(
      `"${name}": encryption.passphrase is a secret.`,
      `Pass it as secrets["${name}"].passphrase instead.`,
    );
  }
  const notify = Array.isArray(config.notify) ? config.notify : [];
  if (notify.some((target) => isPlainObject(target) && "url" in target)) {
    throw invalidImport(
      `"${name}": notify URLs are secrets.`,
      `Pass them as secrets["${name}"].notifyUrls instead.`,
    );
  }
  const backup = isPlainObject(config.backup) ? config.backup : {};
  const schedule = isPlainObject(config.schedule) ? config.schedule : undefined;
  const recipients = stringList(encryption?.recipients);
  const compression =
    config.compression === "gzip" || config.compression === "none" ? config.compression : "zstd";
  const retention = isPlainObject(config.retention)
    ? Object.fromEntries(
        Object.entries(config.retention).filter(
          (entry): entry is [string, number] => typeof entry[1] === "number",
        ),
      )
    : undefined;
  return {
    storage: config.storage.trim(),
    uri,
    include: stringList(backup.include),
    exclude: stringList(backup.exclude),
    compression,
    encryption: recipients.length > 0 ? { kind: "recipients", recipients } : { kind: "none" },
    retention,
    cron: typeof schedule?.cron === "string" ? schedule.cron : undefined,
    timezone: typeof schedule?.timezone === "string" ? schedule.timezone : undefined,
    ignored: Object.keys(config).filter((key) => !MODELLED_KEYS.has(key)),
  };
}

/** The changed fields between a stored plan and an imported one, as display strings. */
function planDifferences(existing: PlanView, input: PlanInput): ConfigImportChange["fields"] {
  const compare: [string, unknown, unknown][] = [
    ["storage", existing.storageId, input.storageId],
    ["connection", existing.connectionId, input.connectionId],
    ["compression", existing.compression, input.compression],
    ["include", existing.include, input.include],
    ["exclude", existing.exclude, input.exclude],
    ["retention", existing.retention, input.retention],
    ["schedule", existing.schedule?.cron, input.schedule?.cron],
  ];
  const fields: { field: string; from?: string; to?: string }[] = [];
  for (const [field, from, to] of compare) {
    const before = from === undefined ? undefined : JSON.stringify(from);
    const after = to === undefined ? undefined : JSON.stringify(to);
    if (before === after) continue;
    fields.push({
      field,
      ...(before === undefined ? {} : { from: before }),
      ...(after === undefined ? {} : { to: after }),
    });
  }
  return fields;
}

/** `mongodb+srv://app@cluster0.example.net/db` → `cluster0.example.net`. */
function hostOf(uri: string): string {
  const afterScheme = uri.replace(/^[a-z+]+:\/\//i, "");
  const afterCredentials = afterScheme.slice(afterScheme.indexOf("@") + 1);
  return afterCredentials.split(/[/?]/)[0] || "Imported connection";
}
