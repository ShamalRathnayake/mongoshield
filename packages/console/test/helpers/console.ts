/**
 * Test harness for the console API: opens a console on a temporary data
 * directory, runs the Hono app in-process, and gives tests a small HTTP client
 * that keeps the session cookie and CSRF token like a browser would.
 *
 * Every response body the client sees is recorded, so a test can assert at the
 * end that no secret ever appeared in ANY response.
 */

import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Hono } from "hono";
import { MongoClient } from "mongodb";
import { inject } from "vitest";
import { type ConsoleAppOptions, createConsoleApp } from "../../src/server/app.ts";
import type { AppEnv, ConsoleServices, ConsoleSettings } from "../../src/server/context.ts";
import { closeConsole, type OpenConsoleOptions, openConsole } from "../../src/server/services.ts";
import type { Permission, Role, SessionInfo } from "../../src/shared/api.ts";

declare module "vitest" {
  export interface ProvidedContext {
    mongoUri: string;
  }
}

/** A secret long enough for MONGOSHIELD_SECRET. */
export const TEST_SECRET = "test-secret-0123456789abcdef0123456789abcdef";
/** Cheap scrypt cost for tests (2^14); production uses 2^17. */
export const TEST_PASSWORD_COST = 14;
/** The password every test user gets. */
export const TEST_PASSWORD = "correct horse battery staple";

/** A clock tests can move. */
export class TestClock {
  #now: number;
  constructor(start = Date.parse("2026-10-21T10:00:00.000Z")) {
    this.#now = start;
  }
  now = (): Date => new Date(this.#now);
  advance(ms: number): void {
    this.#now += ms;
  }
}

/** One recorded response. */
export interface RecordedResponse {
  readonly status: number;
  readonly headers: Headers;
  readonly text: string;
  /** Parsed JSON, or `undefined` when the body is not JSON. */
  // biome-ignore lint/suspicious/noExplicitAny: tests read arbitrary response shapes.
  readonly body: any;
}

/** A running test console. */
export interface TestConsole {
  readonly dataDir: string;
  readonly services: ConsoleServices;
  readonly app: Hono<AppEnv>;
  readonly clock: TestClock;
  readonly setupToken: string | undefined;
  /** Every response body seen by any client of this console. */
  readonly transcript: string[];
  /** A new browser-like client. */
  client(): TestClient;
  /** Closes the console (keeps the data directory). */
  close(): Promise<void>;
}

/** Options for {@link startConsole}. */
export interface StartOptions {
  readonly dataDir?: string;
  readonly secret?: string;
  readonly clock?: TestClock;
  readonly settings?: Partial<ConsoleSettings>;
  readonly transcript?: string[];
  /** OIDC provider cache/timeout overrides (see OpenConsoleOptions.oidcProvider). */
  readonly oidcProvider?: OpenConsoleOptions["oidcProvider"];
  /** Options for the HTTP app (e.g. a journal status reader for /metrics). */
  readonly app?: Omit<ConsoleAppOptions, "heartbeatMs">;
}

/** Opens a console on a (new, by default) temporary data directory. */
export async function startConsole(options: StartOptions = {}): Promise<TestConsole> {
  const dataDir = options.dataDir ?? (await mkdtemp(join(tmpdir(), "ms-console-")));
  const clock = options.clock ?? new TestClock();
  const { services, setupToken } = await openConsole({
    dataDir,
    secret: options.secret ?? TEST_SECRET,
    passwordCost: TEST_PASSWORD_COST,
    now: clock.now,
    progressIntervalMs: 0,
    settings: { cookieSecure: false, ...options.settings },
    ...(options.oidcProvider === undefined ? {} : { oidcProvider: options.oidcProvider }),
  });
  const app = createConsoleApp(services, { heartbeatMs: 50, ...options.app });
  const transcript = options.transcript ?? [];
  return {
    dataDir,
    services,
    app,
    clock,
    setupToken,
    transcript,
    client: () => new TestClient(app, transcript),
    close: () => closeConsole(services, 5_000),
  };
}

/** Removes a data directory created by {@link startConsole}. */
export async function removeDataDir(dataDir: string): Promise<void> {
  await rm(dataDir, { recursive: true, force: true });
}

/** A browser-like API client: cookie jar + CSRF header. */
export class TestClient {
  readonly #app: Hono<AppEnv>;
  readonly #transcript: string[];
  /** Cookies by name, as a browser would keep them (attributes are not enforced). */
  readonly #cookies = new Map<string, string>();
  csrfToken: string | undefined;

  constructor(app: Hono<AppEnv>, transcript: string[]) {
    this.#app = app;
    this.#transcript = transcript;
  }

  /** The `Cookie` header this client sends, or undefined without cookies. */
  get cookieHeader(): string | undefined {
    if (this.#cookies.size === 0) return undefined;
    return [...this.#cookies].map(([name, value]) => `${name}=${value}`).join("; ");
  }

  /** Sends a request. `body` is sent as JSON; CSRF and cookie are added unless disabled. */
  async request(
    method: string,
    path: string,
    body?: unknown,
    options: { readonly csrf?: boolean | string; readonly headers?: Record<string, string> } = {},
  ): Promise<RecordedResponse> {
    const headers: Record<string, string> = { ...options.headers };
    if (body !== undefined) headers["content-type"] = "application/json";
    const cookie = this.cookieHeader;
    if (cookie !== undefined) headers.cookie = cookie;
    const csrf = options.csrf ?? true;
    if (typeof csrf === "string") headers["x-csrf-token"] = csrf;
    else if (csrf && this.csrfToken !== undefined) headers["x-csrf-token"] = this.csrfToken;

    const response = await this.#app.request(path, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    this.#storeCookies(response.headers);
    const text = response.headers.get("content-type")?.includes("event-stream")
      ? ""
      : await response.text();
    this.#transcript.push(text);
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = undefined;
    }
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof Reflect.get(parsed, "csrfToken") === "string"
    ) {
      this.csrfToken = String(Reflect.get(parsed, "csrfToken"));
    }
    return { status: response.status, headers: response.headers, text, body: parsed };
  }

  /** Keeps every `Set-Cookie` of a response; an emptied or expired cookie is removed. */
  #storeCookies(headers: Headers): void {
    for (const setCookie of headers.getSetCookie()) {
      const pair = setCookie.split(";")[0] ?? "";
      const separator = pair.indexOf("=");
      if (separator === -1) continue;
      const name = pair.slice(0, separator).trim();
      const value = pair.slice(separator + 1).trim();
      if (value === "" || /Max-Age=0/i.test(setCookie)) this.#cookies.delete(name);
      else this.#cookies.set(name, value);
    }
  }

  /** Opens an SSE stream and collects its `data:` events until it ends. */
  async events(path: string): Promise<unknown[]> {
    const headers: Record<string, string> = {};
    const cookie = this.cookieHeader;
    if (cookie !== undefined) headers.cookie = cookie;
    const response = await this.#app.request(path, { headers });
    if (response.status !== 200 || response.body === null) {
      throw new Error(`SSE request failed with ${response.status}: ${await response.text()}`);
    }
    const text = await new Response(response.body).text();
    this.#transcript.push(text);
    return text
      .split("\n\n")
      .filter((block) => block.startsWith("data: "))
      .map((block) => JSON.parse(block.slice("data: ".length)));
  }

  /** Logs in (and remembers the session). */
  async login(username: string, password = TEST_PASSWORD): Promise<RecordedResponse> {
    return this.request("POST", "/api/session", { username, password });
  }

  /** Refreshes the CSRF token from GET /api/session. */
  async session(): Promise<SessionInfo> {
    return (await this.request("GET", "/api/session")).body;
  }
}

/** Runs setup and returns an admin client. */
export async function setupAdmin(
  testConsole: TestConsole,
  username = "admin",
): Promise<TestClient> {
  const client = testConsole.client();
  const response = await client.request("POST", "/api/setup", {
    token: testConsole.setupToken,
    username,
    password: TEST_PASSWORD,
  });
  if (response.status !== 200) throw new Error(`Setup failed: ${response.text}`);
  return client;
}

/**
 * Creates a user with a role (via the admin client) and returns a logged-in client.
 * `permissions` grants extra permissions such as `data:write`.
 */
export async function userWithRole(
  testConsole: TestConsole,
  admin: TestClient,
  role: Role,
  username = `${role}-${randomBytes(3).toString("hex")}`,
  permissions: readonly Permission[] = [],
): Promise<TestClient> {
  const created = await admin.request("POST", "/api/users", {
    username,
    role,
    password: TEST_PASSWORD,
    ...(permissions.length === 0 ? {} : { permissions }),
  });
  if (created.status !== 200) throw new Error(`Creating ${role} failed: ${created.text}`);
  const client = testConsole.client();
  const login = await client.login(username);
  if (login.status !== 200) throw new Error(`Login as ${role} failed: ${login.text}`);
  return client;
}

// ---------------------------------------------------------------------------
// MongoDB
// ---------------------------------------------------------------------------

/** URI of the shared test replica set (started by the library's global setup). */
export function mongoUri(): string {
  return inject("mongoUri");
}

/** A unique database name so tests never interfere with each other. */
export function uniqueDb(prefix = "c"): string {
  return `${prefix}_${randomBytes(4).toString("hex")}`;
}

/**
 * Creates a MongoDB user with a random password and returns a URI that
 * authenticates as it. Gives the redaction tests a real password to look for.
 */
export async function uriWithPassword(): Promise<{ uri: string; password: string }> {
  const base = mongoUri();
  const username = `console_${randomBytes(4).toString("hex")}`;
  const password = `Pw-${randomBytes(12).toString("hex")}`;
  const client = new MongoClient(base);
  try {
    await client.db("admin").command({ createUser: username, pwd: password, roles: ["root"] });
  } finally {
    await client.close();
  }
  const url = new URL(base);
  url.username = username;
  url.password = password;
  url.searchParams.set("authSource", "admin");
  return { uri: url.toString(), password };
}

/** Inserts `count` simple documents into `db.collection`. */
export async function seed(db: string, collection: string, count: number): Promise<void> {
  const client = new MongoClient(mongoUri());
  try {
    const documents = Array.from({ length: count }, (_, index) => ({
      _id: index,
      name: `user ${index}`,
      email: `user${index}@example.com`,
    }));
    await client.db(db).collection<{ _id: number }>(collection).insertMany(documents);
  } finally {
    await client.close();
  }
}

/** Counts documents in `db.collection`. */
export async function countDocuments(db: string, collection: string): Promise<number> {
  const client = new MongoClient(mongoUri());
  try {
    return await client.db(db).collection(collection).countDocuments();
  } finally {
    await client.close();
  }
}

/** Polls the runner until a job has finished, and returns its summary. */
export async function waitForJob(testConsole: TestConsole, jobId: string) {
  const job = await testConsole.services.runner.finished(jobId);
  if (job === undefined) throw new Error(`Unknown job ${jobId}`);
  return job;
}
