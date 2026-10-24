/**
 * Turns a storage URL (from the CLI, a config file or an environment variable)
 * into a `StorageAdapter`.
 *
 *   const storage = await resolveStorage("s3://my-backups/prod?region=eu-west-1");
 *
 * Supported forms:
 * - `file:///abs/path`                 local directory (absolute file URL)
 * - `./backups`, `/var/backups`, `C:\b` bare paths, relative to the working directory
 * - `s3://bucket/prefix?region=…&endpoint=…&forcePathStyle=true`
 * - `gs://bucket/prefix?projectId=…`   Google Cloud Storage
 * - `az://account/container/prefix?endpoint=…`   Azure Blob Storage
 * - `sftp://user@host:port/path?fingerprint=SHA256:…`   SFTP (`/~/path` = relative to the login directory)
 * - `memory://name`                    in-process store, shared by every URL with the same name
 *
 * Credentials never go in the URL; URLs that contain a password are rejected.
 * - S3 uses the AWS SDK's default credential chain (environment variables,
 *   profiles, instance roles).
 * - GCS uses Application Default Credentials (`GOOGLE_APPLICATION_CREDENTIALS`,
 *   `gcloud auth application-default login`, the metadata server).
 * - Azure uses the connection string in `AZURE_STORAGE_CONNECTION_STRING` when
 *   it is set (its AccountName must match the URL), and otherwise
 *   `DefaultAzureCredential` (`AZURE_CLIENT_ID`/`AZURE_TENANT_ID`/…, managed or
 *   workload identity, `az login`) against `https://<account>.blob.core.windows.net`
 *   or the `endpoint` parameter.
 * - SFTP authenticates with the private key file in `MONGOSHIELD_SFTP_KEY_FILE`
 *   (passphrase in `MONGOSHIELD_SFTP_KEY_PASSPHRASE`) and/or the SSH agent in
 *   `SSH_AUTH_SOCK`. The host key must match `fingerprint` (repeatable) or
 *   `MONGOSHIELD_SFTP_HOST_FINGERPRINT` (comma-separated); only
 *   `allowUnknownHostKey=true` skips that check.
 * - `s3://`, `gs://` and `az://` accept `retention=compliance|governance`: the
 *   write-once retention mode used for immutable backups (`retainDays`). Default
 *   `compliance`. See docs/guides/immutable-backups.md.
 * Pass the adapter factories (`s3Storage`, `gcsStorage`, …) directly for anything else.
 */

import { fileURLToPath } from "node:url";
import { MongoShieldError } from "../errors.ts";
import { azureStorage } from "./azure.ts";
import { fileStorage } from "./file.ts";
import { gcsStorage } from "./gcs.ts";
import { type MemoryStorage, memoryStorage } from "./memory.ts";
import { s3Storage } from "./s3.ts";
import { sftpStorage } from "./sftp.ts";
import type { RetentionOptions, StorageAdapter } from "./types.ts";

/** The URL schemes `resolveStorage` understands, for error messages and docs. */
export const SUPPORTED_STORAGE_SCHEMES = ["file", "s3", "gs", "az", "sftp", "memory"] as const;

/** Query parameters accepted on `s3://` URLs. Anything else is rejected to catch typos. */
const S3_QUERY_PARAMETERS = new Set(["region", "endpoint", "forcePathStyle", "retention"]);
/** Query parameters accepted on `gs://` URLs. */
const GCS_QUERY_PARAMETERS = new Set(["projectId", "retention"]);
/** Query parameters accepted on `az://` URLs. */
const AZURE_QUERY_PARAMETERS = new Set(["endpoint", "retention"]);
/** Query parameters accepted on `sftp://` URLs. */
const SFTP_QUERY_PARAMETERS = new Set(["fingerprint", "allowUnknownHostKey"]);

/** Environment variables read for `az://` and `sftp://` URLs (see the header comment). */
const ENV = {
  azureConnectionString: "AZURE_STORAGE_CONNECTION_STRING",
  sftpKeyFile: "MONGOSHIELD_SFTP_KEY_FILE",
  sftpKeyPassphrase: "MONGOSHIELD_SFTP_KEY_PASSPHRASE",
  sftpHostFingerprint: "MONGOSHIELD_SFTP_HOST_FINGERPRINT",
  sshAgent: "SSH_AUTH_SOCK",
} as const;

/**
 * Named in-memory stores. `memory://x` must mean the same store every time it is
 * resolved in a process, or a backup written to it could never be restored from it.
 */
const memoryStores = new Map<string, MemoryStorage>();

/** A scheme is letters/digits/`+.-` followed by `://`. Windows paths (`C:\…`) never match. */
const SCHEME_PATTERN = /^([a-z][a-z0-9+.-]*):\/\//i;

/** Creates the adapter a storage URL or bare path points to. */
export async function resolveStorage(url: string): Promise<StorageAdapter> {
  if (typeof url !== "string" || url.trim() === "") {
    throw configError("The storage location is empty.");
  }
  const scheme = SCHEME_PATTERN.exec(url)?.[1]?.toLowerCase();
  switch (scheme) {
    case undefined:
      return fileStorage({ path: url });
    case "file":
      return fileStorage({ path: filePathOf(url) });
    case "s3":
      return s3StorageOf(url);
    case "gs":
      return gcsStorageOf(url);
    case "az":
      return azureStorageOf(url);
    case "sftp":
      return sftpStorageOf(url);
    case "memory":
      return memoryStorageOf(url);
    default:
      throw configError(`Unsupported storage scheme "${scheme}://".`, {
        hint: `Use one of ${SUPPORTED_STORAGE_SCHEMES.map((name) => `${name}://`).join(", ")}, or a plain directory path.`,
      });
  }
}

/** `file:///abs/path` → `/abs/path`. Only absolute, local file URLs are accepted. */
function filePathOf(url: string): string {
  try {
    return fileURLToPath(url);
  } catch (error) {
    throw configError(`Invalid file URL "${url}".`, {
      cause: error,
      hint: "Use file:///absolute/path, or just give the directory path without a scheme.",
    });
  }
}

/** `s3://bucket/some/prefix?region=…` → `s3Storage({ bucket, prefix, … })`. */
function s3StorageOf(url: string): StorageAdapter {
  const parsed = parseUrl(url);
  if (parsed.username || parsed.password) {
    throw configError("S3 URLs must not contain credentials.", {
      hint: "Set AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY or AWS_PROFILE instead.",
    });
  }
  const bucket = parsed.hostname;
  if (!bucket) {
    throw configError(`The S3 URL "${url}" has no bucket.`, {
      hint: "Use s3://<bucket>/<optional/prefix>.",
    });
  }

  for (const name of parsed.searchParams.keys()) {
    if (!S3_QUERY_PARAMETERS.has(name)) {
      throw configError(`Unknown S3 URL parameter "${name}".`, {
        hint: `Supported parameters: ${[...S3_QUERY_PARAMETERS].join(", ")}.`,
      });
    }
  }
  const region = parsed.searchParams.get("region");
  const endpoint = parsed.searchParams.get("endpoint");
  const forcePathStyle = parsed.searchParams.get("forcePathStyle");
  if (endpoint !== null) parseUrl(endpoint);

  return s3Storage({
    bucket,
    prefix: decodeURIComponent(parsed.pathname),
    ...(region ? { region } : {}),
    ...(endpoint ? { endpoint } : {}),
    ...(forcePathStyle === null ? {} : { forcePathStyle: parseBoolean(forcePathStyle) }),
    ...retentionParameter(parsed),
  });
}

/** `gs://bucket/some/prefix?projectId=…` → `gcsStorage({ bucket, prefix, … })`. */
function gcsStorageOf(url: string): StorageAdapter {
  const parsed = parseUrl(url);
  rejectCredentials(
    parsed,
    "GCS",
    "Use GOOGLE_APPLICATION_CREDENTIALS or gcloud application-default login instead.",
  );
  rejectUnknownParameters(parsed, GCS_QUERY_PARAMETERS, "GCS");
  const bucket = parsed.hostname;
  if (!bucket) {
    throw configError(`The GCS URL "${url}" has no bucket.`, {
      hint: "Use gs://<bucket>/<optional/prefix>.",
    });
  }
  const projectId = parsed.searchParams.get("projectId");
  return gcsStorage({
    bucket,
    prefix: decodeURIComponent(parsed.pathname),
    ...(projectId ? { projectId } : {}),
    ...retentionParameter(parsed),
  });
}

/**
 * `az://account/container/some/prefix` → `azureStorage(…)`, authenticated with
 * `AZURE_STORAGE_CONNECTION_STRING` if set, else `DefaultAzureCredential`.
 */
function azureStorageOf(url: string): StorageAdapter {
  const parsed = parseUrl(url);
  rejectCredentials(
    parsed,
    "Azure",
    `Set ${ENV.azureConnectionString}, or use Microsoft Entra ID (DefaultAzureCredential).`,
  );
  rejectUnknownParameters(parsed, AZURE_QUERY_PARAMETERS, "Azure");
  const account = parsed.hostname;
  const [container = "", ...rest] = decodeURIComponent(parsed.pathname)
    .split("/")
    .filter((segment) => segment.length > 0);
  if (!account || !container) {
    throw configError(`The Azure URL "${url}" needs an account and a container.`, {
      hint: "Use az://<account>/<container>/<optional/prefix>.",
    });
  }
  const prefix = rest.join("/");

  const connectionString = process.env[ENV.azureConnectionString];
  if (connectionString) {
    const storage = azureStorage({
      connectionString,
      container,
      prefix,
      ...retentionParameter(parsed),
    });
    // A connection string for another account would silently send backups elsewhere.
    if (!storage.location.startsWith(`az://${account}/`)) {
      throw configError(
        `${ENV.azureConnectionString} is for a different storage account than "${account}".`,
        {
          hint: `Unset it to use DefaultAzureCredential, or use the matching az://<account>/ URL.`,
        },
      );
    }
    return storage;
  }
  const endpoint = parsed.searchParams.get("endpoint");
  if (endpoint !== null) parseUrl(endpoint);
  return azureStorage({
    accountUrl: endpoint ?? `https://${account}.blob.core.windows.net`,
    container,
    prefix,
    ...retentionParameter(parsed),
  });
}

/**
 * `sftp://user@host:2222/srv/backups?fingerprint=SHA256:…` → `sftpStorage(…)`.
 * The key comes from `MONGOSHIELD_SFTP_KEY_FILE` and/or the SSH agent.
 */
function sftpStorageOf(url: string): StorageAdapter {
  const parsed = parseUrl(url);
  if (parsed.password) {
    throw configError("SFTP URLs must not contain a password.", {
      hint: `Use key authentication: set ${ENV.sftpKeyFile} or start ssh-agent.`,
    });
  }
  rejectUnknownParameters(parsed, SFTP_QUERY_PARAMETERS, "SFTP");
  const username = decodeURIComponent(parsed.username);
  // IPv6 literals come back as "[::1]"; ssh2 wants them bare.
  const host = parsed.hostname.replace(/^\[(.*)\]$/, "$1");
  if (!username || !host) {
    throw configError(`The SFTP URL "${url}" needs a user and a host.`, {
      hint: "Use sftp://<user>@<host>[:port]/<path>.",
    });
  }
  const pathname = decodeURIComponent(parsed.pathname);
  // "/~/backups" means "backups" relative to the login directory, as in curl.
  const path = pathname.startsWith("/~/") ? pathname.slice(3) : pathname;
  if (path === "" || path === "/~") {
    throw configError(`The SFTP URL "${url}" has no path.`, {
      hint: "Add the backup directory, e.g. sftp://backup@host/srv/backups or sftp://backup@host/~/backups.",
    });
  }

  const keyFile = process.env[ENV.sftpKeyFile];
  const passphrase = process.env[ENV.sftpKeyPassphrase];
  const hasAgent = Boolean(process.env[ENV.sshAgent]);
  if (!keyFile && !hasAgent) {
    throw configError(`No SSH key for ${url.split("?")[0]}.`, {
      hint: `Set ${ENV.sftpKeyFile} to a private key file, or start ssh-agent (SSH_AUTH_SOCK).`,
    });
  }

  // URLSearchParams decodes "+" as a space, but base64 fingerprints contain "+".
  const fromUrl = parsed.searchParams
    .getAll("fingerprint")
    .map((value) => value.replaceAll(" ", "+"));
  const fromEnv = (process.env[ENV.sftpHostFingerprint] ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  const fingerprints = fromUrl.length > 0 ? fromUrl : fromEnv;
  const allowUnknown = parsed.searchParams.get("allowUnknownHostKey");

  return sftpStorage({
    host,
    ...(parsed.port ? { port: Number(parsed.port) } : {}),
    username,
    path,
    ...(keyFile ? { privateKeyPath: keyFile } : {}),
    ...(passphrase ? { passphrase } : {}),
    ...(hasAgent ? { agent: true as const } : {}),
    ...(fingerprints.length > 0 ? { hostFingerprint: fingerprints } : {}),
    ...(allowUnknown === null ? {} : { allowUnknownHostKey: parseBoolean(allowUnknown) }),
  });
}

function rejectCredentials(parsed: URL, label: string, hint: string): void {
  if (parsed.username || parsed.password) {
    throw configError(`${label} URLs must not contain credentials.`, { hint });
  }
}

function rejectUnknownParameters(parsed: URL, allowed: ReadonlySet<string>, label: string): void {
  for (const name of parsed.searchParams.keys()) {
    if (!allowed.has(name)) {
      throw configError(`Unknown ${label} URL parameter "${name}".`, {
        hint: `Supported parameters: ${[...allowed].join(", ")}.`,
      });
    }
  }
}

/** `memory://name` → the process-wide store with that name (default `"default"`). */
function memoryStorageOf(url: string): StorageAdapter {
  const name = parseUrl(url).hostname || "default";
  let store = memoryStores.get(name);
  if (!store) {
    store = memoryStorage({ name });
    memoryStores.set(name, store);
  }
  return store;
}

function parseUrl(url: string): URL {
  try {
    return new URL(url);
  } catch (error) {
    throw configError(`Invalid URL "${url}".`, { cause: error });
  }
}

/** `?retention=governance` → `{ retention: { mode: "governance" } }`; absent → `{}`. */
function retentionParameter(parsed: URL): { retention?: RetentionOptions } {
  const mode = parsed.searchParams.get("retention");
  if (mode === null) return {};
  if (mode === "compliance" || mode === "governance") return { retention: { mode } };
  throw configError(`Invalid retention mode "${mode}" in storage URL.`, {
    hint: "Use retention=compliance or retention=governance.",
  });
}

function parseBoolean(value: string): boolean {
  const normalized = value.toLowerCase();
  if (normalized === "true" || normalized === "1" || normalized === "") return true;
  if (normalized === "false" || normalized === "0") return false;
  throw configError(`Invalid boolean "${value}" in storage URL.`, {
    hint: "Use true or false.",
  });
}

function configError(
  message: string,
  options: { hint?: string; cause?: unknown } = {},
): MongoShieldError {
  return new MongoShieldError("MS_CONFIG_INVALID", message, options);
}
