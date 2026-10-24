/**
 * Reading and writing the secrets inside console records, in one place.
 *
 * Each kind of secret is encrypted with its own AES-GCM "context" (see
 * crypto.ts): the record id plus the field. A ciphertext pasted into another
 * record or field then fails to decrypt instead of leaking across records.
 * Keeping the context strings here means the code that writes a secret and the
 * code that reads it can never disagree about them.
 */

import type { StateStore } from "./store.ts";
import type { ConnectionRecord, PlanRecord, StorageRecord } from "./types.ts";

/** AES-GCM context of a connection's URI. */
function connectionUriContext(connectionId: string): string {
  return `connection:${connectionId}:uri`;
}

/** AES-GCM context of a storage location's credentials. */
function storageCredentialsContext(storageId: string): string {
  return `storage:${storageId}:credentials`;
}

/** AES-GCM context of a plan's passphrase. */
function planPassphraseContext(planId: string): string {
  return `plan:${planId}:passphrase`;
}

/** AES-GCM context of a plan's notification URLs. */
function planNotifyContext(planId: string): string {
  return `plan:${planId}:notify`;
}

/** Encrypts a connection URI for storage. */
export function sealConnectionUri(store: StateStore, connectionId: string, uri: string): string {
  return store.encrypt(uri, connectionUriContext(connectionId));
}

/** The plaintext URI of a connection. Only for connecting; never for responses. */
export function openConnectionUri(store: StateStore, record: ConnectionRecord): string {
  return store.decrypt(record.uri, connectionUriContext(record.id));
}

/** Encrypts storage credentials (environment-style pairs) for storage. */
export function sealStorageCredentials(
  store: StateStore,
  storageId: string,
  credentials: Readonly<Record<string, string>>,
): string {
  return store.encrypt(JSON.stringify(credentials), storageCredentialsContext(storageId));
}

/** The plaintext credentials of a storage location (empty when none are stored). */
export function openStorageCredentials(
  store: StateStore,
  record: StorageRecord,
): Readonly<Record<string, string>> {
  if (record.credentials === undefined) return {};
  const parsed: unknown = JSON.parse(
    store.decrypt(record.credentials, storageCredentialsContext(record.id)),
  );
  const credentials: Record<string, string> = {};
  if (typeof parsed === "object" && parsed !== null) {
    for (const [name, value] of Object.entries(parsed)) {
      if (typeof value === "string") credentials[name] = value;
    }
  }
  return credentials;
}

/** Encrypts a plan's backup passphrase. */
export function sealPlanPassphrase(store: StateStore, planId: string, passphrase: string): string {
  return store.encrypt(passphrase, planPassphraseContext(planId));
}

/** The plaintext passphrase of a passphrase-encrypted plan, else `undefined`. */
export function openPlanPassphrase(store: StateStore, plan: PlanRecord): string | undefined {
  if (plan.encryption.kind !== "passphrase") return undefined;
  return store.decrypt(plan.encryption.passphrase, planPassphraseContext(plan.id));
}

/** Encrypts one notification URL of a plan. */
export function sealNotifyUrl(store: StateStore, planId: string, url: string): string {
  return store.encrypt(url, planNotifyContext(planId));
}

/** The plaintext notification URL. */
export function openNotifyUrl(store: StateStore, planId: string, sealed: string): string {
  return store.decrypt(sealed, planNotifyContext(planId));
}
