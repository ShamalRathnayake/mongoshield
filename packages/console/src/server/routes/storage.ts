/**
 * Storage locations.
 *
 *   GET    /api/storage            viewer
 *   POST   /api/storage            admin
 *   PUT    /api/storage/:id        admin   (omit `credentials` to keep the stored ones)
 *   DELETE /api/storage/:id        admin   (refused while a plan uses it; backups are NOT deleted)
 *   POST   /api/storage/:id/test   operator (writes, reads back and deletes a probe object)
 *
 * Credentials are encrypted at rest; views show only their names.
 */

import { randomBytes } from "node:crypto";
import type { Hono } from "hono";
import { checkStorageInput } from "../../jobs/storage.ts";
import { storageById } from "../../jobs/tasks.ts";
import type { StorageTestResult } from "../../shared/api.ts";
import { randomId } from "../../state/crypto.ts";
import { sealStorageCredentials } from "../../state/secrets.ts";
import type { StorageRecord } from "../../state/types.ts";
import { recordAudit } from "../audit.ts";
import { requireRole } from "../auth.ts";
import type { AppEnv, ConsoleServices } from "../context.ts";
import { ConsoleError, describeError, notFound } from "../errors.ts";
import { readJson } from "../security.ts";
import { asObject, optionalStringMap, requiredString } from "../validate.ts";
import { storageView } from "../views.ts";

/** Longest accepted storage URL. */
const MAX_URL_LENGTH = 1024;
/** Credential values can be whole service-account JSON files or SSH keys. */
const MAX_CREDENTIAL_LENGTH = 16 * 1024;

/** Registers the storage routes. */
export function storageRoutes(app: Hono<AppEnv>, services: ConsoleServices): void {
  const { store } = services;

  app.get("/api/storage", (c) => {
    requireRole(c, "viewer");
    return c.json(store.current.storage.map(storageView));
  });

  app.post("/api/storage", async (c) => {
    const principal = requireRole(c, "admin");
    const body = asObject(await readJson(c));
    const name = requiredString(body, "name", 100);
    const url = requiredString(body, "url", MAX_URL_LENGTH);
    const credentials = optionalStringMap(body, "credentials", {
      maxEntries: 10,
      maxLength: MAX_CREDENTIAL_LENGTH,
    });
    checkStorageInput(url, Object.keys(credentials ?? {}), services.dataDir);
    const id = randomId();
    const at = services.now().toISOString();
    const record: StorageRecord = {
      id,
      name,
      url,
      createdAt: at,
      updatedAt: at,
      ...credentialFields(services, id, credentials),
    };
    await store.update((state) => {
      assertNameFree(state.storage, name, undefined);
      state.storage = [...state.storage, record];
    });
    await recordAudit(services, {
      actor: principal,
      action: "storage.create",
      target: name,
      outcome: "success",
      details: { id, url },
    });
    return c.json(storageView(record));
  });

  app.put("/api/storage/:id", async (c) => {
    const principal = requireRole(c, "admin");
    const id = c.req.param("id");
    const body = asObject(await readJson(c));
    const name = requiredString(body, "name", 100);
    const url = requiredString(body, "url", MAX_URL_LENGTH);
    const credentials = optionalStringMap(body, "credentials", {
      maxEntries: 10,
      maxLength: MAX_CREDENTIAL_LENGTH,
    });
    const existing = storageById(store, id);
    checkStorageInput(
      url,
      credentials === undefined ? (existing.credentialNames ?? []) : Object.keys(credentials),
      services.dataDir,
    );
    const updated = await store.update((state) => {
      const current = state.storage.find((storage) => storage.id === id);
      if (current === undefined) throw notFound("The storage location");
      assertNameFree(state.storage, name, id);
      // Rebuild without the credential fields, then add back the kept or new ones.
      const { credentials: keptSealed, credentialNames: keptNames, ...rest } = current;
      const next: StorageRecord = {
        ...rest,
        name,
        url,
        updatedAt: services.now().toISOString(),
        ...(credentials === undefined
          ? {
              ...(keptSealed === undefined ? {} : { credentials: keptSealed }),
              ...(keptNames === undefined ? {} : { credentialNames: keptNames }),
            }
          : credentialFields(services, id, credentials)),
      };
      state.storage = state.storage.map((storage) => (storage.id === id ? next : storage));
      return next;
    });
    await services.storage.forget(id);
    await recordAudit(services, {
      actor: principal,
      action: "storage.update",
      target: name,
      outcome: "success",
      details: { id, url, credentialsChanged: credentials !== undefined },
    });
    return c.json(storageView(updated));
  });

  app.delete("/api/storage/:id", async (c) => {
    const principal = requireRole(c, "admin");
    const id = c.req.param("id");
    const removed = await store.update((state) => {
      const existing = state.storage.find((storage) => storage.id === id);
      if (existing === undefined) throw notFound("The storage location");
      const user = state.plans.find((plan) => plan.storageId === id);
      if (user !== undefined) {
        throw new ConsoleError(
          409,
          "CONSOLE_IN_USE",
          `The storage location is used by the plan "${user.name}".`,
          "Delete or change that plan first.",
        );
      }
      // The live edit journal (pre-images for undo) of a connection may live here too.
      const journalOf = state.connections.find(
        (connection) => connection.liveEdits?.journalStorageId === id,
      );
      if (journalOf !== undefined) {
        throw new ConsoleError(
          409,
          "CONSOLE_IN_USE",
          `The storage location keeps the live edit journal of the connection "${journalOf.name}".`,
          "Choose another journal location in that connection's live edit settings first.",
        );
      }
      state.storage = state.storage.filter((storage) => storage.id !== id);
      return existing;
    });
    await services.storage.forget(id);
    await recordAudit(services, {
      actor: principal,
      action: "storage.delete",
      target: removed.name,
      outcome: "success",
      details: { id },
    });
    return c.json({ ok: true as const });
  });

  app.post("/api/storage/:id/test", async (c) => {
    const principal = requireRole(c, "operator");
    const record = storageById(store, c.req.param("id"));
    const result = await probeStorage(services, record);
    await recordAudit(services, {
      actor: principal,
      action: "storage.test",
      target: record.name,
      outcome: result.ok ? "success" : "failure",
    });
    return c.json(result);
  });
}

/** Writes, reads back and deletes a small probe object. Never throws. */
async function probeStorage(
  services: ConsoleServices,
  record: StorageRecord,
): Promise<StorageTestResult> {
  try {
    const adapter = await services.storage.adapterFor(record);
    const key = `_probe/console-${randomBytes(6).toString("hex")}.txt`;
    const content = `mongoshield console probe ${services.now().toISOString()}`;
    await adapter.put(key, Buffer.from(content), { contentType: "text/plain" });
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of await adapter.get(key)) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
      }
      if (Buffer.concat(chunks).toString("utf8") !== content) {
        return {
          ok: false,
          error: { code: "MS_STORAGE_IO", message: "The probe object read back differently." },
        };
      }
    } finally {
      await adapter.delete([key]);
    }
    return { ok: true, capabilities: { ...adapter.capabilities } };
  } catch (error) {
    return { ok: false, error: describeError(error) };
  }
}

/** The stored credential fields for a set of credentials (none when empty). */
function credentialFields(
  services: ConsoleServices,
  id: string,
  credentials: Readonly<Record<string, string>> | undefined,
): Pick<StorageRecord, "credentials" | "credentialNames"> {
  if (credentials === undefined || Object.keys(credentials).length === 0) return {};
  return {
    credentials: sealStorageCredentials(services.store, id, credentials),
    credentialNames: Object.keys(credentials).sort(),
  };
}

function assertNameFree(
  locations: readonly StorageRecord[],
  name: string,
  exceptId: string | undefined,
): void {
  if (locations.some((storage) => storage.name === name && storage.id !== exceptId)) {
    throw new ConsoleError(
      409,
      "CONSOLE_CONFLICT",
      `A storage location named "${name}" already exists.`,
    );
  }
}
