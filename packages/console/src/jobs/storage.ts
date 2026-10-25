/**
 * Turning a stored storage location (URL + encrypted credentials) into a
 * `StorageAdapter` from the mongoshield library.
 *
 * Locations WITHOUT stored credentials go through the library's `resolveStorage`,
 * exactly like the CLI: `memory://` names are shared with it, URL parameters are
 * validated the same way, and cloud SDKs use their default credential chains
 * (instance roles, workload identity, the console host's environment).
 *
 * Locations WITH stored credentials cannot: `resolveStorage` reads credentials
 * only from the process environment, which is one set for the whole process,
 * while the console holds a different set per location. For those the console
 * maps its decrypted credential pairs onto the adapter factories' options here.
 *
 * Accepted URLs:
 *   memory://name                 in-process store (tests, demos; lost on restart)
 *   <path> or file:///<path>      a directory INSIDE the data directory (see below)
 *   s3://bucket/prefix?region=&endpoint=&forcePathStyle=
 *       credentials AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_SESSION_TOKEN
 *   gs://bucket/prefix?projectId=
 *       credentials GOOGLE_CREDENTIALS_JSON (a service account key, as JSON)
 *   az://account/container/prefix?endpoint=
 *       credentials AZURE_STORAGE_CONNECTION_STRING
 *   sftp://user@host:port/path?fingerprint=SHA256:…
 *       credentials SFTP_PRIVATE_KEY, SFTP_PASSPHRASE
 *
 * Why local paths must stay inside the data directory: the console runs with
 * its own file system permissions, and an admin account (or whoever stole one)
 * must not be able to point "storage" at /etc or another volume and read or
 * delete files there through backup, restore or prune.
 *
 * Cloud adapters are imported lazily, so their SDKs load only when used.
 */

import { isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  MongoShieldError,
  resolveStorage,
  type StorageAdapter,
  SUPPORTED_STORAGE_SCHEMES,
} from "mongoshield";
import type { StorageRecord } from "../state/types.ts";

/** Credential names accepted per scheme. Anything else is refused (catches typos). */
export const CREDENTIAL_NAMES: Readonly<Record<string, readonly string[]>> = {
  s3: ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN"],
  gs: ["GOOGLE_CREDENTIALS_JSON"],
  az: ["AZURE_STORAGE_CONNECTION_STRING"],
  sftp: ["SFTP_PRIVATE_KEY", "SFTP_PASSPHRASE"],
  memory: [],
  file: [],
};

/** The kind of location a URL points to (the library's supported schemes). */
export type StorageScheme = (typeof SUPPORTED_STORAGE_SCHEMES)[number];

/** Recognises the scheme of a storage URL (a bare path is `file`). */
export function storageSchemeOf(url: string): StorageScheme {
  const match = /^([a-z][a-z0-9+.-]*):\/\//i.exec(url);
  if (match === null) return "file";
  const scheme = (match[1] ?? "").toLowerCase();
  const known = SUPPORTED_STORAGE_SCHEMES.find((candidate) => candidate === scheme);
  if (known !== undefined) return known;
  throw configError(`Unsupported storage URL scheme "${scheme}://".`, {
    hint: "Use s3://, gs://, az://, sftp://, memory:// or a directory inside the data volume.",
  });
}

/**
 * Validates a storage URL and its credential names before they are saved, so a
 * mistake is reported when the location is created, not at 3 a.m. by the first
 * scheduled backup.
 */
export function checkStorageInput(
  url: string,
  credentialNames: readonly string[],
  dataDir: string,
): void {
  const scheme = storageSchemeOf(url);
  if (scheme === "file") {
    localPathOf(url, dataDir);
  } else if (scheme !== "memory") {
    const parsed = parseUrl(url);
    // Credentials in the URL would be stored and shown in clear text.
    if (parsed.password !== "" || (scheme !== "sftp" && parsed.username !== "")) {
      throw configError("Storage URLs must not contain credentials.", {
        hint: "Put credentials in the credentials fields; they are stored encrypted.",
      });
    }
  }
  const allowed = CREDENTIAL_NAMES[scheme] ?? [];
  for (const name of credentialNames) {
    if (!allowed.includes(name)) {
      throw configError(`"${name}" is not a credential for ${scheme} storage.`, {
        hint:
          allowed.length > 0
            ? `Use ${allowed.join(", ")}.`
            : `${scheme} storage takes no credentials.`,
      });
    }
  }
}

/** Options for {@link StorageRegistry}. */
export interface StorageRegistryOptions {
  readonly dataDir: string;
  /** Decrypts a record's credentials (owned by the state store). */
  readonly credentialsOf: (record: StorageRecord) => Readonly<Record<string, string>>;
}

/**
 * Creates and caches one adapter per storage location. A cached adapter is
 * rebuilt when its record changes (`updatedAt`), and closed when it is replaced.
 */
export class StorageRegistry {
  readonly #options: StorageRegistryOptions;
  readonly #cache = new Map<
    string,
    { readonly version: string; readonly adapter: StorageAdapter }
  >();

  constructor(options: StorageRegistryOptions) {
    this.#options = options;
  }

  /** The adapter for a storage record. */
  async adapterFor(record: StorageRecord): Promise<StorageAdapter> {
    const cached = this.#cache.get(record.id);
    if (cached !== undefined && cached.version === record.updatedAt) return cached.adapter;
    if (cached !== undefined) await closeQuietly(cached.adapter);
    const adapter = await createAdapter(
      record.url,
      this.#options.credentialsOf(record),
      this.#options.dataDir,
    );
    this.#cache.set(record.id, { version: record.updatedAt, adapter });
    return adapter;
  }

  /** Drops (and closes) the cached adapter of a location that was changed or deleted. */
  async forget(id: string): Promise<void> {
    const cached = this.#cache.get(id);
    this.#cache.delete(id);
    if (cached !== undefined) await closeQuietly(cached.adapter);
  }

  /** Closes every cached adapter (shutdown). */
  async closeAll(): Promise<void> {
    const adapters = [...this.#cache.values()].map((entry) => entry.adapter);
    this.#cache.clear();
    await Promise.all(adapters.map(closeQuietly));
  }
}

/** Builds the adapter for a URL with the given credentials. */
async function createAdapter(
  url: string,
  credentials: Readonly<Record<string, string>>,
  dataDir: string,
): Promise<StorageAdapter> {
  const scheme = storageSchemeOf(url);
  // Local paths are confined to the data directory before the library sees them.
  if (scheme === "file") return resolveStorage(localPathOf(url, dataDir));
  if (Object.keys(credentials).length === 0) return resolveStorage(url);
  switch (scheme) {
    case "memory":
      return resolveStorage(url);
    case "s3":
      return s3Adapter(url, credentials);
    case "gs":
      return gcsAdapter(url, credentials);
    case "az":
      return azureAdapter(url, credentials);
    case "sftp":
      return sftpAdapter(url, credentials);
  }
}

/**
 * Resolves a local storage path and insists it lies strictly inside the data
 * directory (see the file header). Relative paths are relative to the data directory.
 */
export function localPathOf(url: string, dataDir: string): string {
  let path = url;
  if (/^file:\/\//i.test(url)) {
    try {
      path = fileURLToPath(url);
    } catch (error) {
      throw configError(`Invalid file URL "${url}".`, { cause: error });
    }
  }
  const root = resolve(dataDir);
  const absolute = resolve(root, path);
  const inside = relative(root, absolute);
  if (inside === "" || inside.startsWith("..") || isAbsolute(inside)) {
    throw configError(`Local storage must be a directory inside the data directory (${root}).`, {
      hint: `Use a relative path such as "backups", or an absolute path under ${root}.`,
    });
  }
  return absolute;
}

async function s3Adapter(
  url: string,
  credentials: Readonly<Record<string, string>>,
): Promise<StorageAdapter> {
  const parsed = parseUrl(url);
  const { s3Storage } = await import("mongoshield/storage/s3");
  const accessKeyId = credentials.AWS_ACCESS_KEY_ID;
  const secretAccessKey = credentials.AWS_SECRET_ACCESS_KEY;
  const sessionToken = credentials.AWS_SESSION_TOKEN;
  const region = parsed.searchParams.get("region");
  const endpoint = parsed.searchParams.get("endpoint");
  const forcePathStyle = parsed.searchParams.get("forcePathStyle");
  return s3Storage({
    bucket: parsed.hostname,
    prefix: decodeURIComponent(parsed.pathname),
    ...(region ? { region } : {}),
    ...(endpoint ? { endpoint } : {}),
    ...(forcePathStyle === null ? {} : { forcePathStyle: forcePathStyle === "true" }),
    // Without explicit keys the SDK's default chain (instance role, IRSA…) is used.
    ...(accessKeyId && secretAccessKey
      ? {
          credentials: {
            accessKeyId,
            secretAccessKey,
            ...(sessionToken ? { sessionToken } : {}),
          },
        }
      : {}),
  });
}

async function gcsAdapter(
  url: string,
  credentials: Readonly<Record<string, string>>,
): Promise<StorageAdapter> {
  const parsed = parseUrl(url);
  const { gcsStorage } = await import("mongoshield/storage/gcs");
  const projectId = parsed.searchParams.get("projectId");
  const json = credentials.GOOGLE_CREDENTIALS_JSON;
  let serviceAccount: unknown;
  if (json !== undefined) {
    try {
      serviceAccount = JSON.parse(json);
    } catch {
      throw configError("GOOGLE_CREDENTIALS_JSON is not valid JSON.", {
        hint: "Paste the whole service account key file.",
      });
    }
  }
  return gcsStorage({
    bucket: parsed.hostname,
    prefix: decodeURIComponent(parsed.pathname),
    ...(projectId ? { projectId } : {}),
    ...(isRecord(serviceAccount) ? { credentials: serviceAccount } : {}),
  });
}

async function azureAdapter(
  url: string,
  credentials: Readonly<Record<string, string>>,
): Promise<StorageAdapter> {
  const parsed = parseUrl(url);
  const { azureStorage } = await import("mongoshield/storage/azure");
  const [container = "", ...rest] = decodeURIComponent(parsed.pathname)
    .split("/")
    .filter((segment) => segment.length > 0);
  const connectionString = credentials.AZURE_STORAGE_CONNECTION_STRING;
  const endpoint = parsed.searchParams.get("endpoint");
  return azureStorage({
    container,
    prefix: rest.join("/"),
    ...(connectionString
      ? { connectionString }
      : { accountUrl: endpoint ?? `https://${parsed.hostname}.blob.core.windows.net` }),
  });
}

async function sftpAdapter(
  url: string,
  credentials: Readonly<Record<string, string>>,
): Promise<StorageAdapter> {
  const parsed = parseUrl(url);
  const { sftpStorage } = await import("mongoshield/storage/sftp");
  const pathname = decodeURIComponent(parsed.pathname);
  const fingerprints = parsed.searchParams
    .getAll("fingerprint")
    .map((value) => value.replaceAll(" ", "+"));
  const privateKey = credentials.SFTP_PRIVATE_KEY;
  const passphrase = credentials.SFTP_PASSPHRASE;
  return sftpStorage({
    host: parsed.hostname.replace(/^\[(.*)\]$/, "$1"),
    ...(parsed.port ? { port: Number(parsed.port) } : {}),
    username: decodeURIComponent(parsed.username),
    path: pathname.startsWith("/~/") ? pathname.slice(3) : pathname,
    ...(privateKey ? { privateKey } : {}),
    ...(passphrase ? { passphrase } : {}),
    ...(fingerprints.length > 0 ? { hostFingerprint: fingerprints } : {}),
    allowUnknownHostKey: parsed.searchParams.get("allowUnknownHostKey") === "true",
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseUrl(url: string): URL {
  try {
    return new URL(url);
  } catch (error) {
    throw configError(`Invalid storage URL "${url}".`, { cause: error });
  }
}

async function closeQuietly(adapter: StorageAdapter): Promise<void> {
  // Memory stores are shared and must keep their contents.
  if (adapter.kind === "memory") return;
  await adapter.close?.().catch(() => undefined);
}

function configError(
  message: string,
  options: { readonly hint?: string; readonly cause?: unknown } = {},
): MongoShieldError {
  return new MongoShieldError("MS_CONFIG_INVALID", message, options);
}
