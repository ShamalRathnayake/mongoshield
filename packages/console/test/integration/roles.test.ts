/**
 * The role matrix: for every route in the API contract, who may call it.
 *
 * The table is typed as `Record<keyof ApiRoutes, …>`, so adding a route to the
 * contract without deciding its role here is a type error.
 *
 * Requests use ids that do not exist and empty bodies: an authorized caller then
 * gets 400/404 (validation or lookup, which run after the role check), an
 * unauthorized one 403, and an anonymous one 401. Nothing is changed.
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

type Access = Role | "public" | "signed-in";

const MATRIX: Record<keyof ApiRoutes, Access> = {
  "GET /api/session": "public",
  "POST /api/session": "public",
  "DELETE /api/session": "signed-in",
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

  "GET /api/config/export": "viewer",
  "POST /api/config/import": "admin",
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
const clients = {} as Record<Role, TestClient>;

beforeAll(async () => {
  testConsole = await startConsole();
  clients.admin = await setupAdmin(testConsole);
  clients.operator = await userWithRole(testConsole, clients.admin, "operator");
  clients.viewer = await userWithRole(testConsole, clients.admin, "viewer");
});

afterAll(async () => {
  await testConsole.close();
  await removeDataDir(testConsole.dataDir);
});

describe("role matrix", () => {
  const protectedRoutes = Object.entries(MATRIX).filter(
    (entry): entry is [string, Role] => entry[1] !== "public" && entry[1] !== "signed-in",
  );

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

  it("lets every signed-in user log out, and nobody else", async () => {
    expect((await testConsole.client().request("DELETE", "/api/session")).status).toBe(401);
    const viewer = await userWithRole(testConsole, clients.admin, "viewer");
    expect((await viewer.request("DELETE", "/api/session")).status).toBe(200);
  });
});
