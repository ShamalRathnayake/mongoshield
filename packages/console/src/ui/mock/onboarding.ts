/**
 * The mock server's side of the welcome flow (src/ui/pages/welcome.tsx and
 * backup-actions.tsx): checking a pasted connection string, the public IP lookup,
 * "Back up now" with a key the console keeps, and the recovery key.
 *
 * It mirrors the real server's rules that the UI depends on (routes/onboarding.ts,
 * routes/plans.ts): placeholders are refused, raw passwords are encoded, Atlas strings
 * are production by default, one quick plan per connection, the recovery key marks
 * the plan saved. Which failure a check reports is chosen by the host name, so every
 * friendly error can be tried in mock mode:
 *
 *   ...@blocked.x.mongodb.net   Atlas IP access list (offers "Show my IP address")
 *   ...@typo.x.mongodb.net      SRV record not found
 *   ...@paused.x.mongodb.net    paused cluster
 *   wrong-password@…            wrong user name or password
 *   ...@tls.example.com         TLS problem
 *   localhost:1                 nothing listening (Docker's localhost)
 *   reader@…                    connects, but may read only some databases
 *
 * `freshStart` empties the fixtures down to what a brand-new console has (the
 * "Local backups" location), which is what `?mock=1&fresh=1` shows.
 */

import type {
  ConnectionProblem,
  JobSummary,
  PlanView,
  QuickBackupResult,
  RecoveryKeyView,
  UserView,
} from "../../shared/api.ts";
import {
  analyzeConnectionString,
  ConnectionStringError,
  cleanPastedConnectionString,
  encodeCredentials,
} from "../../shared/connection-string.ts";
import type { RequestOf, ResponseOf, RouteKey } from "../api.ts";
import type { MockConnection, MockData } from "./fixtures.ts";

/** The routes this module answers. */
export type OnboardingRoute = Extract<
  RouteKey,
  | "POST /api/connections/check"
  | "POST /api/network/public-ip"
  | "POST /api/quick-backup"
  | "POST /api/plans/:id/recovery-key"
>;

/** What a handler receives (the same shape as backend.ts's handler input). */
interface OnboardingHandlerInput<Route extends RouteKey> {
  readonly params: Readonly<Record<string, string>>;
  readonly query: URLSearchParams;
  readonly body: RequestOf<Route>;
  readonly user: UserView | undefined;
}

/** One handler per onboarding route. */
export type OnboardingHandlers = {
  [Route in OnboardingRoute]: (input: OnboardingHandlerInput<Route>) => ResponseOf<Route>;
};

/** Minimum roles, as on the server: all admin. */
export const ONBOARDING_ROUTE_ROLES: { readonly [Route in OnboardingRoute]: "admin" } = {
  "POST /api/connections/check": "admin",
  "POST /api/network/public-ip": "admin",
  "POST /api/quick-backup": "admin",
  "POST /api/plans/:id/recovery-key": "admin",
};

/** What the onboarding mock needs from the backend around it. */
export interface OnboardingMockContext {
  readonly data: MockData;
  readonly fail: (status: number, code: string, message: string, hint?: string) => Error;
  readonly findConnection: (id: string | undefined) => MockConnection;
  readonly audit: (
    action: string,
    outcome: "success" | "failure",
    target?: string,
    details?: Record<string, string | number | boolean>,
  ) => void;
  readonly newId: (prefix: string) => string;
  /** Runs a plan like `POST /api/plans/:id/run`. */
  readonly runPlan: (planId: string) => JobSummary;
}

/** A recognisable fake age key pair for mock plans (the real server generates one). */
const MOCK_RECIPIENT = "age1mockrecipient0000000000000000000000000000000000000000000";
const MOCK_IDENTITY = "AGE-SECRET-KEY-1MOCKIDENTITY000000000000000000000000000000000000000000000";

/** A managed-key encryption view, as a new quick plan gets. */
export function mockManagedKey(): PlanView["encryption"] {
  return { kind: "managed", recipient: MOCK_RECIPIENT, recoveryKeySaved: false };
}

/** Creates the onboarding handlers over the mock's data. */
export function createOnboardingMock(context: OnboardingMockContext): {
  readonly handlers: OnboardingHandlers;
} {
  const { data, fail, audit } = context;

  const handlers: OnboardingHandlers = {
    "POST /api/connections/check": ({ body }) => {
      const uri = normalize(body.uri, fail);
      const info = analyzeConnectionString(uri);
      const problem = mockProblem(uri, info.atlas);
      audit("connection.check", problem === undefined ? "success" : "failure");
      const suggestedName = uniqueName(
        info.suggestedName,
        data.connections.map((connection) => connection.name),
      );
      if (problem !== undefined) {
        return {
          ok: false,
          missingBackupPrivileges: [],
          missingRestorePrivileges: [],
          error: { code: "MS_CONNECTION_FAILED", message: problem.detail, hint: problem.fix },
          problem,
          suggestedName,
          production: info.production,
        };
      }
      const limited = /\/\/reader[:@]/.test(uri);
      return {
        ok: true,
        topology: "replicaSet",
        serverVersion: "8.0.4",
        missingBackupPrivileges: limited ? ["find on all databases"] : [],
        missingRestorePrivileges: limited ? ["insert on all databases"] : [],
        ...(info.atlas
          ? {
              atlas: {
                tier: info.hosts[0]?.startsWith("cluster0") ? "shared" : "dedicated",
              } as const,
            }
          : {}),
        ...(limited
          ? {
              readableDatabases: ["shop"],
              privilegeAdvice: {
                kind: "missing-privileges",
                title: "This user can back up only part of the data",
                message:
                  "Backups need to read every collection (readAnyDatabase), and restores need readWrite on the targets. Backups will include only the databases this user can read: shop.",
                fix: "Grant readAnyDatabase for backups and readWrite for restores.",
                links: [],
                detail: "find on all databases; insert on all databases",
              },
            }
          : {}),
        suggestedName,
        production: info.production,
      };
    },

    "POST /api/network/public-ip": () => {
      audit("network.public_ip", "success");
      return { ip: "203.0.113.7" };
    },

    "POST /api/quick-backup": ({ body }) => {
      const connection = context.findConnection(body.connectionId);
      const include = [...(body.include ?? [])];
      const storage =
        data.storage.find((location) => location.name === "Local backups") ??
        data.storage.find((location) => !location.url.includes("://"));
      if (storage === undefined) {
        throw fail(
          409,
          "CONSOLE_NO_STORAGE",
          "There is no local storage location for one-click backups.",
          "Add a storage location under Storage first.",
        );
      }
      let plan = data.plans.find(
        (candidate) => candidate.origin === "quick" && candidate.connectionId === connection.id,
      );
      const created = plan === undefined;
      if (plan === undefined) {
        plan = {
          id: context.newId("plan"),
          name: uniqueName(
            `Back up ${connection.name}`,
            data.plans.map((candidate) => candidate.name),
          ),
          connectionId: connection.id,
          storageId: storage.id,
          include,
          exclude: [],
          compression: "zstd",
          encryption: mockManagedKey(),
          consistency: "auto",
          verify: "fast",
          notify: [],
          origin: "quick",
        };
        data.plans.push(plan);
        data.planSecrets[plan.id] = { notifyUrls: [] };
        audit("plan.create", "success", plan.name, { origin: "quick" });
      } else {
        const updated: PlanView = { ...plan, include };
        data.plans = data.plans.map((candidate) =>
          candidate.id === updated.id ? updated : candidate,
        );
        plan = updated;
      }
      const job = context.runPlan(plan.id);
      const result: QuickBackupResult = { plan: { ...plan, lastRun: job }, job, created };
      return result;
    },

    "POST /api/plans/:id/recovery-key": ({ params }) => {
      const plan = data.plans.find((candidate) => candidate.id === params.id);
      if (plan === undefined) throw fail(404, "CONSOLE_NOT_FOUND", "The plan does not exist.");
      if (plan.encryption.kind !== "managed") {
        throw fail(
          409,
          "CONSOLE_NO_MANAGED_KEY",
          "This plan does not use a key kept by the console.",
        );
      }
      const recipient = plan.encryption.recipient;
      const saved: PlanView = {
        ...plan,
        encryption: { ...plan.encryption, recoveryKeySaved: true },
      };
      data.plans = data.plans.map((candidate) => (candidate.id === saved.id ? saved : candidate));
      audit("plan.recovery_key", "success", plan.name);
      const view: RecoveryKeyView = {
        planId: plan.id,
        planName: plan.name,
        identity: MOCK_IDENTITY,
        recipient,
        filename: `mongoshield-recovery-key-${plan.name.replace(/[^A-Za-z0-9._-]+/g, "-")}.txt`,
        fileContent: `# MongoShield recovery key (mock)\n${MOCK_IDENTITY}\n`,
      };
      return view;
    },
  };
  return { handlers };
}

/** Empties mock data down to a brand-new console: one "Local backups" location. */
export function freshStart(data: MockData): void {
  data.connections = [];
  data.plans = [];
  data.planSecrets = {};
  data.backups = [];
  data.jobs = [];
  data.audit = [];
  data.storage = [
    {
      id: "st-local",
      name: "Local backups",
      url: "backups",
      credentials: {},
      createdAt: new Date().toISOString(),
      objectLock: false,
    },
  ];
}

/** Cleans and checks a pasted URI like the server does, or throws its 400. */
function normalize(text: string, fail: OnboardingMockContext["fail"]): string {
  const cleaned = cleanPastedConnectionString(text);
  try {
    const info = analyzeConnectionString(cleaned);
    const placeholder = info.passwordPlaceholder ?? info.usernamePlaceholder;
    if (placeholder !== undefined) {
      throw fail(400, "CONSOLE_VALIDATION", `Replace ${placeholder} in the connection string.`);
    }
  } catch (error) {
    if (error instanceof ConnectionStringError) {
      throw fail(400, "CONSOLE_VALIDATION", error.message);
    }
    throw error;
  }
  return encodeCredentials(cleaned).uri;
}

/** The failure a mock check reports, chosen by the host (see the file header). */
function mockProblem(uri: string, atlas: boolean): ConnectionProblem | undefined {
  const base = { links: [] as { label: string; url: string }[] };
  if (uri.includes("@blocked.")) {
    return {
      ...base,
      kind: "network-blocked",
      title: "Atlas did not let this console in",
      message:
        "The connection was closed before it was set up. Atlas does this when the console's IP address is not on the project's IP access list.",
      fix: "In Atlas, open Network Access and add the console's public IP address.",
      links: [
        {
          label: "Atlas: Network Access (IP access list)",
          url: "https://cloud.mongodb.com/v2#/security/network/accessList",
        },
      ],
      detail: "Client network socket disconnected before secure TLS connection was established",
      offerPublicIp: true,
    };
  }
  if (uri.includes("@typo.")) {
    return {
      ...base,
      kind: "dns-not-found",
      title: "That server name does not exist",
      message: "The cluster address could not be found. There may be a typo in the cluster name.",
      fix: "Copy the connection string again from Atlas and paste it unchanged.",
      detail: "querySrv ENOTFOUND _mongodb._tcp.typo.x.mongodb.net",
    };
  }
  if (uri.includes("@paused.")) {
    return {
      ...base,
      kind: "paused-cluster",
      title: "The cluster is paused",
      message: "Atlas paused this cluster.",
      fix: "Resume it in Atlas, then try again.",
      detail: "cluster is paused",
    };
  }
  if (uri.includes(":wrong-password@")) {
    return {
      ...base,
      kind: "auth-failed",
      title: "Wrong user name or password",
      message: "The database refused the user name and password.",
      fix: atlas
        ? "Check the database user in Atlas → Database Access."
        : "Check the user name and password.",
      detail: "Authentication failed.",
    };
  }
  if (uri.includes("@tls.")) {
    return {
      ...base,
      kind: "tls",
      title: "The secure connection (TLS) failed",
      message: "The certificate is not trusted.",
      fix: "Mount the CA file and add tlsCAFile=/path/to/ca.pem to the connection string.",
      detail: "self-signed certificate in certificate chain",
    };
  }
  if (/localhost:1(?:[/?]|$)/.test(uri)) {
    return {
      ...base,
      kind: "connection-refused",
      title: "Nothing is listening there",
      message: "No database accepted the connection on that port.",
      fix: "In Docker, localhost is the console's own container: use host.docker.internal.",
      detail: "connect ECONNREFUSED 127.0.0.1:1",
    };
  }
  return undefined;
}

function uniqueName(name: string, taken: readonly string[]): string {
  if (!taken.includes(name)) return name;
  for (let suffix = 2; ; suffix += 1) {
    if (!taken.includes(`${name} ${suffix}`)) return `${name} ${suffix}`;
  }
}
