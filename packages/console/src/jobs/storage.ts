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
 *   b2://bucket/prefix?region=us-west-004       Backblaze B2 (the library's S3 preset)
 *       credentials AWS_ACCESS_KEY_ID (the application key's keyID), AWS_SECRET_ACCESS_KEY
 *   r2://accountId/bucket/prefix?jurisdiction=  Cloudflare R2 (the library's S3 preset)
 *       credentials AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY (an R2 API token's keys)
 *   gs://bucket/prefix?projectId=
 *       credentials GOOGLE_CREDENTIALS_JSON (a service account key, as JSON)
 *   az://account/container/prefix?endpoint=
 *       credentials AZURE_STORAGE_CONNECTION_STRING, or AZURE_STORAGE_SAS_TOKEN (a SAS
 *       token for the account or container; never in `endpoint=`, where it would be
 *       stored and shown in clear text)
 *   sftp://user@host:port/path?fingerprint=SHA256:…
 *       credentials SFTP_PRIVATE_KEY, SFTP_PASSPHRASE
 *
 * Why local paths must stay inside the data directory: the console runs with
 * its own file system permissions, and an admin account (or whoever stole one)
 * must not be able to point "storage" at /etc or another volume and read or
 * delete files there through backup, restore or prune. Nor at the console's own
 * files inside it (console.json, the audit log, secret.key, the lock, the live edit
 * journal): a prune or delete through such a location would destroy them.
 *
 * Endpoints (`endpoint=`) must not carry credentials (a SAS token in its query string
 * would be stored and shown in clear), must not point at cloud metadata or link-local
 * addresses, and an Azure location that uses the console's own managed identity (no
 * connection string and no signed SAS token: see `AzureAuth`) only talks to Azure's
 * storage domains, because the SDK sends the identity's bearer token to the endpoint
 * (src/server/network-targets.ts; the console setting MONGOSHIELD_ALLOW_UNSAFE_TARGETS
 * lifts the last two rules). Stored Azure credentials that would not be used are
 * refused outright, both when saved and when the adapter is built.
 *
 * Cloud adapters are imported lazily, so their SDKs load only when used.
 */

import { isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  MongoShieldError,
  resolveStorage,
  type StorageAdapter,
  SUPPORTED_STORAGE_SCHEMES,
} from "mongoshield";
import { LOCAL_JOURNAL_DIR } from "../server/live/journal.ts";
import {
  UNSAFE_TARGET_HINT,
  unsafeHostReason,
  unsafeManagedIdentityEndpointReason,
} from "../server/network-targets.ts";
import { AUDIT_FILE } from "../state/audit.ts";
import { LOCK_FILE } from "../state/lock.ts";
import { SECRET_KEY_FILE } from "../state/secret-key.ts";
import { STATE_FILE } from "../state/store.ts";
import type { StorageRecord } from "../state/types.ts";

/** Credential names accepted per scheme. Anything else is refused (catches typos). */
export const CREDENTIAL_NAMES: Readonly<Record<string, readonly string[]>> = {
  s3: ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN"],
  b2: ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"],
  r2: ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"],
  gs: ["GOOGLE_CREDENTIALS_JSON"],
  az: ["AZURE_STORAGE_CONNECTION_STRING", "AZURE_STORAGE_SAS_TOKEN"],
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
    hint: "Use s3://, b2://, r2://, gs://, az://, sftp://, memory:// or a directory inside the data volume.",
  });
}

/**
 * Validates a storage URL and its credential names before they are saved, so a
 * mistake is reported when the location is created, not at 3 a.m. by the first
 * scheduled backup.
 */
export function checkStorageInput(
  url: string,
  credentials: Readonly<Record<string, string>>,
  dataDir: string,
  options: { readonly allowUnsafeTargets?: boolean } = {},
): void {
  const scheme = storageSchemeOf(url);
  const credentialNames = Object.keys(credentials);
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
    const endpoint = parsed.searchParams.get("endpoint");
    if (endpoint !== null) {
      checkEndpoint(scheme, endpoint, credentials, options.allowUnsafeTargets === true);
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
  if (scheme === "az" && credentialNames.length > 0) checkAzureCredentials(credentials);
}

/**
 * How an Azure location authenticates, judged by the credentials that would actually be
 * USED, not by which names happen to be stored:
 *
 *   connectionString  a non-empty AZURE_STORAGE_CONNECTION_STRING (the SDK then never
 *                     reaches for an identity of the console)
 *   sas               a non-empty AZURE_STORAGE_SAS_TOKEN carrying a `sig=` signature
 *                     (the library uses a SAS only when `sig` is present)
 *   managedIdentity   neither: the library falls back to DefaultAzureCredential, i.e. the
 *                     console's own managed identity, whose bearer token goes to the endpoint
 *
 * Deciding on names alone let `{"AZURE_STORAGE_SAS_TOKEN": ""}` (or a SAS without `sig=`)
 * skip the managed-identity endpoint check and send the console's token to any host.
 */
export type AzureAuth =
  | { readonly kind: "connectionString"; readonly connectionString: string }
  | { readonly kind: "sas"; readonly sasToken: string }
  | { readonly kind: "managedIdentity" };

/** Works out the {@link AzureAuth} of a set of stored credentials (see there). */
export function azureAuthOf(credentials: Readonly<Record<string, string>>): AzureAuth {
  const connectionString = credentials.AZURE_STORAGE_CONNECTION_STRING?.trim() ?? "";
  if (connectionString !== "") return { kind: "connectionString", connectionString };
  // A SAS token may be pasted with or without its leading "?".
  const sasToken = (credentials.AZURE_STORAGE_SAS_TOKEN ?? "").trim().replace(/^\?/, "");
  const signature = new URLSearchParams(sasToken).get("sig") ?? "";
  if (signature.trim() !== "") return { kind: "sas", sasToken };
  return { kind: "managedIdentity" };
}

/**
 * Stored Azure credentials must be usable: a location that stores some but would still
 * authenticate with the console's managed identity is a mistake at best (and was the
 * way around the endpoint check at worst; see {@link AzureAuth}).
 */
function checkAzureCredentials(credentials: Readonly<Record<string, string>>): void {
  if (azureAuthOf(credentials).kind === "managedIdentity") throw unusableAzureCredentials();
}

/** The error for stored Azure credentials that would not be used (see {@link AzureAuth}). */
function unusableAzureCredentials(): MongoShieldError {
  return configError(
    "The stored Azure credentials cannot be used: there is no connection string, and no SAS token with a signature (sig=).",
    {
      hint: "Give AZURE_STORAGE_CONNECTION_STRING, or a complete SAS token (sv=…&sig=…) in AZURE_STORAGE_SAS_TOKEN. Store no credentials at all to use the console's own Azure identity.",
    },
  );
}

/**
 * The `endpoint=` parameter of an s3:// or az:// URL (see the file header): no
 * credentials in it (Azure SAS tokens go into AZURE_STORAGE_SAS_TOKEN), no metadata or
 * link-local hosts, and no foreign host for Azure's managed identity.
 */
function checkEndpoint(
  scheme: StorageScheme,
  endpoint: string,
  credentials: Readonly<Record<string, string>>,
  allowUnsafe: boolean,
): void {
  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch (error) {
    throw configError("The endpoint parameter is not a URL.", { cause: error });
  }
  if (parsed.username !== "" || parsed.password !== "" || parsed.search !== "") {
    throw configError("The endpoint must not contain credentials or a query string.", {
      hint:
        scheme === "az"
          ? "Put a SAS token in the AZURE_STORAGE_SAS_TOKEN credential instead; credentials are stored encrypted and never shown."
          : "Put credentials in the credentials fields; they are stored encrypted.",
    });
  }
  if (allowUnsafe) return;
  const unsafe = unsafeHostReason(parsed.hostname);
  if (unsafe !== undefined) {
    throw configError(`The endpoint is refused: ${unsafe}.`, { hint: UNSAFE_TARGET_HINT });
  }
  // Judged on the credentials that would really be used (see AzureAuth), never on names.
  if (scheme === "az" && azureAuthOf(credentials).kind === "managedIdentity") {
    const foreign = unsafeManagedIdentityEndpointReason(parsed.hostname);
    if (foreign !== undefined) {
      throw configError(`The endpoint is refused: ${foreign}.`, {
        hint: `Store credentials for this location (AZURE_STORAGE_CONNECTION_STRING or AZURE_STORAGE_SAS_TOKEN). ${UNSAFE_TARGET_HINT}`,
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
    case "b2":
    case "r2":
      return s3PresetAdapter(scheme, url, credentials);
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
  const first = (inside.split(sep)[0] ?? "").toLowerCase();
  if (CONSOLE_OWN_NAMES.some((name) => first === name || first.startsWith(`${name}.`))) {
    throw configError(
      `Local storage cannot use "${first}": it belongs to the console itself (state, audit log, keys or the live edit journal).`,
      { hint: `Use a directory of its own, such as "backups".` },
    );
  }
  return absolute;
}

/**
 * Names at the top of the data directory that the console uses itself, with the files
 * derived from them (`console.json.tmp-…`, `audit.jsonl.1`). Local storage must not
 * overlap them (see the file header).
 */
const CONSOLE_OWN_NAMES = [
  STATE_FILE,
  AUDIT_FILE,
  SECRET_KEY_FILE,
  LOCK_FILE,
  LOCAL_JOURNAL_DIR,
].map((name) => name.toLowerCase());

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

/**
 * A `b2://` or `r2://` location with stored keys: the library's B2 / R2 preset (the
 * right endpoint, region and checksum settings) with those keys. The URL is parsed the
 * same way as the library's resolver does.
 */
async function s3PresetAdapter(
  scheme: "b2" | "r2",
  url: string,
  credentials: Readonly<Record<string, string>>,
): Promise<StorageAdapter> {
  const parsed = parseUrl(url);
  const { b2Storage, r2Storage } = await import("mongoshield/storage/s3");
  const accessKeyId = credentials.AWS_ACCESS_KEY_ID;
  const secretAccessKey = credentials.AWS_SECRET_ACCESS_KEY;
  const keys =
    accessKeyId && secretAccessKey ? { credentials: { accessKeyId, secretAccessKey } } : {};
  const segments = decodeURIComponent(parsed.pathname)
    .split("/")
    .filter((segment) => segment !== "");
  if (scheme === "b2") {
    return b2Storage({
      bucket: parsed.hostname,
      prefix: segments.join("/"),
      region: parsed.searchParams.get("region") ?? "",
      ...keys,
    });
  }
  const [bucket = "", ...prefix] = segments;
  const jurisdiction = parsed.searchParams.get("jurisdiction");
  return r2Storage({
    accountId: parsed.hostname,
    bucket,
    prefix: prefix.join("/"),
    ...(jurisdiction === "eu" || jurisdiction === "fedramp" ? { jurisdiction } : {}),
    ...keys,
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
  const auth = azureAuthOf(credentials);
  if (auth.kind === "connectionString") {
    return azureStorage({
      container,
      prefix: rest.join("/"),
      connectionString: auth.connectionString,
    });
  }
  // Credentials are stored (that is how we got here) but none of them is usable. Falling
  // through to the endpoint without a SAS would make the library use the console's own
  // managed identity and send its token to the endpoint, which was never checked for
  // that case (see AzureAuth). Refuse instead.
  if (auth.kind === "managedIdentity") throw unusableAzureCredentials();
  const endpoint = parsed.searchParams.get("endpoint");
  const accountUrl = endpoint ?? `https://${parsed.hostname}.blob.core.windows.net`;
  // A SAS token travels as the account URL's query string (the adapter keeps it there).
  return azureStorage({
    container,
    prefix: rest.join("/"),
    accountUrl: `${accountUrl.replace(/\?.*$/, "")}?${auth.sasToken}`,
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
