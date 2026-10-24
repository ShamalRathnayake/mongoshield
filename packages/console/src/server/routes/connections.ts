/**
 * MongoDB connections.
 *
 *   GET    /api/connections                   viewer
 *   POST   /api/connections                   admin
 *   PUT    /api/connections/:id               admin   (omit `uri` to keep the stored one)
 *   DELETE /api/connections/:id               admin   (refused while a plan uses it)
 *   POST   /api/connections/:id/test          operator
 *   GET    /api/connections/:id/namespaces    viewer
 *   PUT    /api/connections/:id/live-edits    admin   (routes/live.ts)
 *
 * The URI (with its password) is encrypted at rest and never returned; views
 * carry a redacted preview computed when the URI is saved.
 */

import type { Hono } from "hono";
import { MongoShieldError, redactMongoUri } from "mongoshield";
import { connectionById } from "../../jobs/tasks.ts";
import { randomId } from "../../state/crypto.ts";
import { scrubText } from "../../state/redact.ts";
import { openConnectionUri, sealConnectionUri } from "../../state/secrets.ts";
import type { ConnectionRecord } from "../../state/types.ts";
import { recordAudit } from "../audit.ts";
import { requireRole } from "../auth.ts";
import type { AppEnv, ConsoleServices } from "../context.ts";
import { ConsoleError, invalid, notFound } from "../errors.ts";
import { namespaceTree, testConnection } from "../mongo-inspect.ts";
import { readJson } from "../security.ts";
import {
  asObject,
  type Fields,
  optionalString,
  requiredBoolean,
  requiredString,
} from "../validate.ts";
import { connectionView } from "../views.ts";

/** Longest accepted connection string (long seed lists and options fit easily). */
const MAX_URI_LENGTH = 4096;

/** Registers the connection routes. */
export function connectionRoutes(app: Hono<AppEnv>, services: ConsoleServices): void {
  const { store } = services;

  app.get("/api/connections", (c) => {
    requireRole(c, "viewer");
    return c.json(store.current.connections.map(connectionView));
  });

  app.post("/api/connections", async (c) => {
    const principal = requireRole(c, "admin");
    const body = asObject(await readJson(c));
    const name = requiredString(body, "name", 100);
    const uri = uriField(body);
    if (uri === undefined) throw invalid('"uri" is required for a new connection.');
    const production = requiredBoolean(body, "production");
    const id = randomId();
    const record: ConnectionRecord = {
      id,
      name,
      uri: sealConnectionUri(store, id, uri),
      uriPreview: redactMongoUri(uri),
      production,
      createdAt: services.now().toISOString(),
    };
    await store.update((state) => {
      assertNameFree(state.connections, name, undefined);
      state.connections = [...state.connections, record];
    });
    await recordAudit(services, {
      actor: principal,
      action: "connection.create",
      target: name,
      outcome: "success",
      details: { id, production },
    });
    return c.json(connectionView(record));
  });

  app.put("/api/connections/:id", async (c) => {
    const principal = requireRole(c, "admin");
    const id = c.req.param("id");
    const body = asObject(await readJson(c));
    const name = requiredString(body, "name", 100);
    const uri = uriField(body);
    const production = requiredBoolean(body, "production");
    const updated = await store.update((state) => {
      const existing = state.connections.find((connection) => connection.id === id);
      if (existing === undefined) throw notFound("The connection");
      assertNameFree(state.connections, name, id);
      const next: ConnectionRecord = {
        ...existing,
        name,
        production,
        ...(uri === undefined
          ? {}
          : { uri: sealConnectionUri(store, id, uri), uriPreview: redactMongoUri(uri) }),
        ...liveEditsAfterUpdate(existing, production, principal.user.username, services.now()),
      };
      state.connections = state.connections.map((connection) =>
        connection.id === id ? next : connection,
      );
      return next;
    });
    await recordAudit(services, {
      actor: principal,
      action: "connection.update",
      target: name,
      outcome: "success",
      details: {
        id,
        production,
        uriChanged: uri !== undefined,
        liveEditsEnabled: updated.liveEdits?.enabled === true,
      },
    });
    return c.json(connectionView(updated));
  });

  app.delete("/api/connections/:id", async (c) => {
    const principal = requireRole(c, "admin");
    const id = c.req.param("id");
    const removed = await store.update((state) => {
      const existing = state.connections.find((connection) => connection.id === id);
      if (existing === undefined) throw notFound("The connection");
      const user = state.plans.find((plan) => plan.connectionId === id);
      if (user !== undefined) {
        throw new ConsoleError(
          409,
          "CONSOLE_IN_USE",
          `The connection is used by the plan "${user.name}".`,
          "Delete or change that plan first.",
        );
      }
      state.connections = state.connections.filter((connection) => connection.id !== id);
      return existing;
    });
    await recordAudit(services, {
      actor: principal,
      action: "connection.delete",
      target: removed.name,
      outcome: "success",
      details: { id },
    });
    return c.json({ ok: true as const });
  });

  app.post("/api/connections/:id/test", async (c) => {
    const principal = requireRole(c, "operator");
    const connection = connectionById(store, c.req.param("id"));
    const result = await testConnection(openConnectionUri(store, connection));
    await recordAudit(services, {
      actor: principal,
      action: "connection.test",
      target: connection.name,
      outcome: result.ok ? "success" : "failure",
    });
    return c.json(result);
  });

  app.get("/api/connections/:id/namespaces", async (c) => {
    requireRole(c, "viewer");
    const connection = connectionById(store, c.req.param("id"));
    const uri = openConnectionUri(store, connection);
    try {
      return c.json(await namespaceTree(uri));
    } catch (error) {
      // Driver errors are not MongoShieldErrors; describe them safely (URI scrubbed).
      throw new MongoShieldError(
        "MS_CONNECTION_FAILED",
        scrubText(error instanceof Error ? error.message : String(error), [uri]),
        { hint: "Test the connection for details." },
      );
    }
  });
}

/** The optional `uri` field: a MongoDB connection string. */
function uriField(body: Fields): string | undefined {
  const uri = optionalString(body, "uri", MAX_URI_LENGTH);
  if (uri === undefined) return undefined;
  if (!/^mongodb(\+srv)?:\/\//i.test(uri.trim())) {
    throw invalid('"uri" must start with mongodb:// or mongodb+srv://.');
  }
  return uri.trim();
}

/**
 * Live edits were confirmed for the connection as it was. Marking it production
 * afterwards turns them off: production needs its own confirmation (name + reason),
 * which only `PUT /api/connections/:id/live-edits` takes.
 */
function liveEditsAfterUpdate(
  existing: ConnectionRecord,
  production: boolean,
  username: string,
  now: Date,
): Pick<ConnectionRecord, "liveEdits"> {
  const settings = existing.liveEdits;
  if (settings === undefined || !settings.enabled) return {};
  if (!production || settings.productionConfirmed) return {};
  return {
    liveEdits: {
      ...settings,
      enabled: false,
      changedBy: username,
      changedAt: now.toISOString(),
      reason: "Turned off because the connection was marked production.",
    },
  };
}

/** Connection names are unique: a production restore is confirmed by typing the name. */
function assertNameFree(
  connections: readonly ConnectionRecord[],
  name: string,
  exceptId: string | undefined,
): void {
  if (connections.some((connection) => connection.name === name && connection.id !== exceptId)) {
    throw new ConsoleError(409, "CONSOLE_CONFLICT", `A connection named "${name}" already exists.`);
  }
}
