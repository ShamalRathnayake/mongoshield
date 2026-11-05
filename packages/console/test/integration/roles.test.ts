/**
 * The role matrix: for every route in the API contract, who may call it.
 *
 * The table is typed as `Record<keyof ApiRoutes, …>`, so adding a route to the
 * contract without deciding its role here is a type error. Routes outside the JSON
 * contract (the SSE stream, OIDC redirects, health and metrics) are listed in
 * `OTHER_ROUTES`, and a test compares both tables with the routes the app actually
 * registers: a route added to the server but to neither table fails it.
 *
 * Requests use ids that do not exist and empty bodies: an authorized caller then
 * gets 400/404 (validation or lookup, which run after the role check), an
 * unauthorized one 403, and an anonymous one 401. Nothing is changed.
 *
 * `"data:write"` routes (live data edits) need the operator role AND the `data:write`
 * permission: every role is refused without the permission, admins included, and an
 * operator who holds it gets through.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ApiRoutes, Role } from "../../src/shared/api.ts";
import {
  removeDataDir,
  setupAdmin,
  startConsole,
  type TestClient,
  type TestConsole,
  userWithRole,
} from "../helpers/console.ts";

type Access = Role | "public" | "signed-in" | "data:write";

const MATRIX: Record<keyof ApiRoutes, Access> = {
  "GET /api/session": "public",
  "POST /api/session": "public",
  "DELETE /api/session": "signed-in",
  "POST /api/setup": "public",

  "GET /api/users": "admin",
  "POST /api/users": "admin",
  "PUT /api/users/:id": "admin",
  "DELETE /api/users/:id": "admin",
  "POST /api/users/:id/sign-out": "admin",

  "GET /api/connections": "viewer",
  "POST /api/connections": "admin",
  "PUT /api/connections/:id": "admin",
  "DELETE /api/connections/:id": "admin",
  "POST /api/connections/:id/test": "operator",
  "POST /api/connections/check": "admin",
  "POST /api/network/public-ip": "admin",
  "GET /api/connections/:id/namespaces": "viewer",
  "PUT /api/connections/:id/live-edits": "admin",

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
  "POST /api/plans/:id/recovery-key": "admin",
  "POST /api/quick-backup": "admin",
  "POST /api/plans/:id/prune/plan": "admin",
  "POST /api/plans/:id/prune": "admin",

  "GET /api/storage/:id/backups": "viewer",
  "GET /api/storage/:id/backups/:backupId": "viewer",
  "POST /api/storage/:id/backups/:backupId/verify": "operator",
  "POST /api/storage/:id/backups/:backupId/drill": "operator",
  "POST /api/storage/:id/backups/:backupId/hold": "operator",
  "DELETE /api/storage/:id/backups/:backupId/hold": "admin",
  "GET /api/storage/:id/backups/:backupId/documents": "operator",
  "GET /api/storage/:id/backups/:backupId/sample": "operator",
  "GET /api/storage/:id/backups/:backupId/export": "operator",

  "POST /api/restore/plan": "operator",
  "POST /api/restore": "operator",
  "POST /api/restore/preview": "operator",
  "GET /api/restore/preview/:id": "operator",
  "GET /api/restore/preview/:id/documents": "operator",
  "POST /api/restore/preview/:id/document": "operator",

  "GET /api/live/:id/collection": "operator",
  "GET /api/live/:id/documents": "operator",
  "GET /api/live/:id/sample": "operator",
  "GET /api/live/:id/export": "operator",
  "POST /api/live/:id/documents": "data:write",
  "PUT /api/live/:id/documents": "data:write",
  "POST /api/live/:id/documents/delete": "data:write",
  "POST /api/live/:id/bulk/preview": "data:write",
  "POST /api/live/:id/bulk": "data:write",
  "GET /api/live-edits": "operator",
  "GET /api/live-edits/:id": "operator",
  "POST /api/live-edits/:id/undo": "data:write",

  "GET /api/jobs": "viewer",
  "GET /api/jobs/:id": "viewer",
  "POST /api/jobs/:id/cancel": "operator",

  "GET /api/audit": "viewer",

  // Admin only: the export maps every connection, bucket and plan in one file.
  "GET /api/config/export": "admin",
  "POST /api/config/import": "admin",
};

/**
 * Routes that are not in the JSON contract, with who may call them:
 *   "token"   needs MONGOSHIELD_METRICS_TOKEN (404 while it is not configured)
 *   "public"  anyone (the OIDC routes answer 404 while OIDC is not configured)
 */
const OTHER_ROUTES: Record<string, Access | "token"> = {
  "GET /api/jobs/:id/events": "viewer",
  "GET /api/oidc/login": "public",
  "GET /api/oidc/callback": "public",
  "GET /healthz": "public",
  "GET /metrics": "token",
};

/** `"POST /api/plans/:id/run"` → method and a concrete path with ids that do not exist. */
function concrete(route: string): { method: string; path: string } {
  const [method = "GET", template = "/"] = route.split(" ");
  const path = template
    .replace(":backupId", "2026-01-01T00-00-00Z_abcdef")
    .replace(":id", "missing");
  return { method, path };
}

const RANK: Record<Role, number> = { viewer: 0, operator: 1, admin: 2 };

let testConsole: TestConsole;
const clients = {} as Record<Role | "writer", TestClient>;

beforeAll(async () => {
  testConsole = await startConsole();
  clients.admin = await setupAdmin(testConsole);
  clients.operator = await userWithRole(testConsole, clients.admin, "operator");
  clients.viewer = await userWithRole(testConsole, clients.admin, "viewer");
  clients.writer = await userWithRole(testConsole, clients.admin, "operator", "writer", [
    "data:write",
  ]);
});

afterAll(async () => {
  await testConsole.close();
  await removeDataDir(testConsole.dataDir);
});

describe("role matrix", () => {
  const protectedRoutes = Object.entries(MATRIX).filter(
    (entry): entry is [string, Role] =>
      entry[1] !== "public" && entry[1] !== "signed-in" && entry[1] !== "data:write",
  );
  const dataWriteRoutes = Object.entries(MATRIX)
    .filter((entry) => entry[1] === "data:write")
    .map(([route]) => route);

  it.each(protectedRoutes)("%s needs %s", async (route, minimum) => {
    const { method, path } = concrete(route);
    const body = method === "POST" || method === "PUT" ? {} : undefined;
    const query = route.endsWith("/documents") ? "?ns=app.users" : "";

    const anonymous = await testConsole.client().request(method, path + query, body);
    expect(anonymous.status, `${route} anonymous`).toBe(401);

    for (const role of ["viewer", "operator", "admin"] as const) {
      const response = await clients[role].request(method, path + query, body);
      if (RANK[role] >= RANK[minimum]) {
        expect([401, 403], `${route} as ${role}: ${response.text}`).not.toContain(response.status);
      } else {
        expect(response.status, `${route} as ${role}`).toBe(403);
        expect(response.body.error.code).toBe("CONSOLE_FORBIDDEN");
      }
    }
  });

  it.each(dataWriteRoutes)("%s needs the data:write permission", async (route) => {
    const { method, path } = concrete(route);
    const body = method === "POST" || method === "PUT" ? {} : undefined;

    const anonymous = await testConsole.client().request(method, path, body);
    expect(anonymous.status, `${route} anonymous`).toBe(401);
    // Without the permission every role is refused, admins included.
    for (const role of ["viewer", "operator", "admin"] as const) {
      const response = await clients[role].request(method, path, body);
      expect(response.status, `${route} as ${role}`).toBe(403);
      expect(response.body.error.code).toBe("CONSOLE_FORBIDDEN");
    }
    const writer = await clients.writer.request(method, path, body);
    expect([401, 403], `${route} with data:write: ${writer.text}`).not.toContain(writer.status);
  });

  it("lists every route the app registers, and only those", () => {
    const registered = new Set(
      testConsole.app.routes
        // Middleware and the API's catch-all 404 are registered for every method.
        .filter((route) => route.method !== "ALL")
        .map((route) => `${route.method} ${route.path}`),
    );
    const listed = new Set([...Object.keys(MATRIX), ...Object.keys(OTHER_ROUTES)]);
    expect(
      [...registered].filter((route) => !listed.has(route)),
      "registered but not listed",
    ).toEqual([]);
    expect(
      [...listed].filter((route) => !registered.has(route)),
      "listed but not registered",
    ).toEqual([]);
  });

  it("streams job events to viewers, and to nobody signed out", async () => {
    const path = "/api/jobs/missing/events";
    expect((await testConsole.client().request("GET", path)).status).toBe(401);
    for (const role of ["viewer", "operator", "admin"] as const) {
      // An unknown job: past the role check, so 404.
      expect((await clients[role].request("GET", path)).status, role).toBe(404);
    }
  });

  it("answers health, metrics and the OIDC routes without a session", async () => {
    const anonymous = testConsole.client();
    expect((await anonymous.request("GET", "/healthz")).status).toBe(200);
    // Metrics need their own token; without one configured the endpoint does not exist.
    expect((await anonymous.request("GET", "/metrics")).status).toBe(404);
    expect((await clients.admin.request("GET", "/metrics")).status).toBe(404);
    // OIDC is not configured in this console.
    expect((await anonymous.request("GET", "/api/oidc/login")).status).toBe(404);
    expect((await anonymous.request("GET", "/api/oidc/callback")).status).toBe(404);
  });

  it("lets every signed-in user log out, and nobody else", async () => {
    expect((await testConsole.client().request("DELETE", "/api/session")).status).toBe(401);
    const viewer = await userWithRole(testConsole, clients.admin, "viewer");
    expect((await viewer.request("DELETE", "/api/session")).status).toBe(200);
  });
});
