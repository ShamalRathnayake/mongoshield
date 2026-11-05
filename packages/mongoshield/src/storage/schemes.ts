/**
 * The first-party storage schemes: how each built-in `<scheme>://` URL becomes an
 * adapter. The registry (registry.ts) serves these next to the schemes community
 * packages register, and `resolveStorage` (resolve.ts) dispatches through it.
 *
 *   file    file:///abs/path                       local directory
 *   s3      s3://bucket/prefix?region=…&endpoint=…  Amazon S3 and S3-compatible services
 *   gs      gs://bucket/prefix?projectId=…          Google Cloud Storage
 *   az      az://account/container/prefix           Azure Blob Storage
 *   sftp    sftp://user@host:port/path              SFTP
 *   memory  memory://name                           in-process store (tests)
 *   b2      b2://bucket/prefix?region=us-west-004   Backblaze B2 (S3 preset)
 *   r2      r2://<accountId>/bucket/prefix          Cloudflare R2 (S3 preset)
 *
 * New schemes are appended, so the order of the older ones (and every hint that
 * lists them) stays the same.
 *
 * resolve.ts documents every parameter and credential. Each factory receives the
 * parsed URL and the environment to read credentials from (StorageSchemeContext).
 *
 *   gdrive, onedrive, dropbox   reserved for the drive adapters: until their releases
 *                               replace the placeholders below, they fail with
 *                               MS_NOT_IMPLEMENTED
 *
 * Adding a first-party scheme: write its factory, add it to SUPPORTED_STORAGE_SCHEMES
 * and to FIRST_PARTY_STORAGE_SCHEMES below. The `satisfies` check makes the list and
 * the factories impossible to get out of step. The drive releases only replace their
 * own placeholder line.
 */

import { fileURLToPath } from "node:url";
import { MongoShieldError } from "../errors.ts";
import { azureStorage } from "./azure.ts";
import { fileStorage } from "./file.ts";
import { gcsStorage } from "./gcs.ts";
import { type MemoryStorage, memoryStorage } from "./memory.ts";
import type { StorageSchemeContext, StorageSchemeFactory } from "./registry.ts";
import { s3Storage } from "./s3.ts";
import { b2Storage, R2_JURISDICTIONS, type R2Jurisdiction, r2Storage } from "./s3-presets.ts";
import { sftpStorage } from "./sftp.ts";
import type { StorageAdapter } from "./types.ts";
import {
  booleanParameter,
  checksumParameter,
  conditionalWritesParameter,
  configError,
  decodedPath,
  MIB,
  parseBoolean,
  rejectCredentials,
  rejectUnknownParameters,
  retentionParameter,
  sizeParameter,
} from "./url-parameters.ts";

/**
 * The URL schemes built into MongoShield, in the order docs and hints list them.
 * `registeredStorageSchemes()` also lists the schemes packages registered.
 */
export const SUPPORTED_STORAGE_SCHEMES = [
  "file",
  "s3",
  "gs",
  "az",
  "sftp",
  "memory",
  "b2",
  "r2",
  "gdrive",
  "onedrive",
  "dropbox",
] as const;

/** One of {@link SUPPORTED_STORAGE_SCHEMES}. */
export type FirstPartyStorageScheme = (typeof SUPPORTED_STORAGE_SCHEMES)[number];

/** Query parameters of `s3://`, `b2://` and `r2://` URLs that tune the S3 adapter itself. */
const S3_TUNING_PARAMETERS = [
  "retention",
  "requestChecksumCalculation",
  "responseChecksumValidation",
  "exactLastModified",
  "conditionalWrites",
  "partSizeMiB",
  "queueSize",
] as const;

/** Query parameters accepted on `s3://` URLs. Anything else is rejected to catch typos. */
const S3_QUERY_PARAMETERS = new Set<string>([
  "region",
  "endpoint",
  "forcePathStyle",
  ...S3_TUNING_PARAMETERS,
]);
/** Query parameters accepted on `b2://` URLs: the endpoint follows from the region. */
const B2_QUERY_PARAMETERS = new Set<string>(["region", ...S3_TUNING_PARAMETERS]);
/** Query parameters accepted on `r2://` URLs: the endpoint follows from the account. */
const R2_QUERY_PARAMETERS = new Set<string>(["jurisdiction", ...S3_TUNING_PARAMETERS]);
/** Query parameters accepted on `gs://` URLs. */
const GCS_QUERY_PARAMETERS = new Set(["projectId", "retention", "chunkSizeMiB"]);
/** Query parameters accepted on `az://` URLs. */
const AZURE_QUERY_PARAMETERS = new Set([
  "endpoint",
  "retention",
  "allowCustomEndpoint",
  "blockSizeMiB",
  "uploadConcurrency",
]);
/** Query parameters accepted on `sftp://` URLs. */
const SFTP_QUERY_PARAMETERS = new Set(["fingerprint", "allowUnknownHostKey"]);

/** The credential hint shared by the S3-based schemes. */
const S3_CREDENTIALS_HINT = "Set AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY or AWS_PROFILE instead.";

/**
 * Host name suffixes of Azure's storage endpoints, in the public cloud and the
 * sovereign clouds (China, US Government, the retired Germany cloud). Private Link
 * hosts (`<account>.privatelink.blob.core.windows.net`) end the same way.
 * `DefaultAzureCredential` attaches a bearer token for the storage account to every
 * request, so it must only go to hosts like these unless the user says otherwise.
 */
const AZURE_STORAGE_HOST_SUFFIXES = [
  ".core.windows.net",
  ".core.chinacloudapi.cn",
  ".core.usgovcloudapi.net",
  ".core.cloudapi.de",
] as const;

/** Environment variables read for `az://` and `sftp://` URLs (see resolve.ts). */
const ENV = {
  azureConnectionString: "AZURE_STORAGE_CONNECTION_STRING",
  sftpKeyFile: "MONGOSHIELD_SFTP_KEY_FILE",
  sftpKeyPassphrase: "MONGOSHIELD_SFTP_KEY_PASSPHRASE",
  sftpHostFingerprint: "MONGOSHIELD_SFTP_HOST_FINGERPRINT",
  sftpKnownHosts: "MONGOSHIELD_SFTP_KNOWN_HOSTS",
  sshAgent: "SSH_AUTH_SOCK",
} as const;

/** The known_hosts file `sftp://` URLs use when no fingerprint is given, like `ssh` itself. */
const DEFAULT_KNOWN_HOSTS = "~/.ssh/known_hosts";

/**
 * Named in-memory stores. `memory://x` must mean the same store every time it is
 * resolved in a process, or a backup written to it could never be restored from it.
 */
const memoryStores = new Map<string, MemoryStorage>();

/** `file:///abs/path` → `/abs/path`. Only absolute, local file URLs are accepted. */
function fileStorageOf({ url }: StorageSchemeContext): StorageAdapter {
  let path: string;
  try {
    path = fileURLToPath(url);
  } catch (error) {
    throw configError(`Invalid file URL "${url}".`, {
      cause: error,
      hint: "Use file:///absolute/path, or just give the directory path without a scheme.",
    });
  }
  return fileStorage({ path });
}

/** `s3://bucket/some/prefix?region=…` → `s3Storage({ bucket, prefix, … })`. */
function s3StorageOf({ url, parsed }: StorageSchemeContext): StorageAdapter {
  rejectCredentials(parsed, "S3", S3_CREDENTIALS_HINT);
  const bucket = parsed.hostname;
  if (!bucket) {
    throw configError(`The S3 URL "${url}" has no bucket.`, {
      hint: "Use s3://<bucket>/<optional/prefix>.",
    });
  }
  rejectUnknownParameters(parsed, S3_QUERY_PARAMETERS, "S3");
  const region = parsed.searchParams.get("region");
  const endpoint = parsed.searchParams.get("endpoint");
  // Only checked, not restricted to AWS hosts: SigV4 signs requests and never sends
  // the secret key, and a custom endpoint (MinIO, Wasabi, …) is the normal case for S3.
  if (endpoint !== null) checkEndpoint(endpoint, "S3");

  return s3Storage({
    bucket,
    prefix: decodedPath(parsed),
    ...(region ? { region } : {}),
    ...(endpoint ? { endpoint } : {}),
    ...booleanParameter(parsed, "forcePathStyle"),
    ...s3TuningParameters(parsed),
  });
}

/**
 * `b2://bucket/some/prefix?region=us-west-004` → `b2Storage(…)`: the S3 adapter
 * against `https://s3.<region>.backblazeb2.com` (s3-presets.ts). The region is
 * required because it is part of the endpoint.
 */
function b2StorageOf({ url, parsed }: StorageSchemeContext): StorageAdapter {
  rejectCredentials(
    parsed,
    "Backblaze B2",
    "Set AWS_ACCESS_KEY_ID to the application key's keyID and AWS_SECRET_ACCESS_KEY to the applicationKey instead.",
  );
  rejectUnknownParameters(parsed, B2_QUERY_PARAMETERS, "Backblaze B2");
  const bucket = parsed.hostname;
  const region = parsed.searchParams.get("region");
  if (!bucket || !region) {
    throw configError(`The Backblaze B2 URL "${url}" needs a bucket and a region.`, {
      hint: "Use b2://<bucket>/<optional/prefix>?region=<region>, with the region from the bucket's endpoint s3.<region>.backblazeb2.com (e.g. us-west-004).",
    });
  }
  return b2Storage({
    bucket,
    prefix: decodedPath(parsed),
    region,
    ...s3TuningParameters(parsed),
  });
}

/**
 * `r2://<accountId>/bucket/some/prefix` → `r2Storage(…)`: the S3 adapter against
 * `https://<accountId>.r2.cloudflarestorage.com` (s3-presets.ts). The account id
 * comes first because it, not the bucket, names the endpoint host.
 */
function r2StorageOf({ url, parsed }: StorageSchemeContext): StorageAdapter {
  rejectCredentials(
    parsed,
    "Cloudflare R2",
    "Set AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY to an R2 API token's keys instead.",
  );
  rejectUnknownParameters(parsed, R2_QUERY_PARAMETERS, "Cloudflare R2");
  const accountId = parsed.hostname;
  const [bucket = "", ...rest] = decodedPath(parsed)
    .split("/")
    .filter((segment) => segment.length > 0);
  if (!accountId || !bucket) {
    throw configError(`The Cloudflare R2 URL "${url}" needs an account id and a bucket.`, {
      hint: "Use r2://<accountId>/<bucket>/<optional/prefix>, with the account id from the R2 overview page.",
    });
  }
  return r2Storage({
    accountId,
    bucket,
    prefix: rest.join("/"),
    ...jurisdictionParameter(parsed),
    ...s3TuningParameters(parsed),
  });
}

/** `?jurisdiction=eu|fedramp` on an `r2://` URL. */
function jurisdictionParameter(parsed: URL): { jurisdiction?: R2Jurisdiction } {
  const value = parsed.searchParams.get("jurisdiction");
  if (value === null) return {};
  const jurisdiction = R2_JURISDICTIONS.find((candidate) => candidate === value.toLowerCase());
  if (jurisdiction === undefined) {
    throw configError(`Invalid R2 jurisdiction "${value}" in storage URL.`, {
      hint: `Use jurisdiction=${R2_JURISDICTIONS.join(" or jurisdiction=")}, or leave it out for ordinary buckets.`,
    });
  }
  return { jurisdiction };
}

/** The S3 adapter's own URL parameters, shared by `s3://`, `b2://` and `r2://`. */
function s3TuningParameters(parsed: URL) {
  return {
    ...booleanParameter(parsed, "exactLastModified"),
    ...checksumParameter(parsed, "requestChecksumCalculation"),
    ...checksumParameter(parsed, "responseChecksumValidation"),
    ...conditionalWritesParameter(parsed),
    ...sizeParameter(parsed, "partSizeMiB", "partSize", MIB),
    ...sizeParameter(parsed, "queueSize", "queueSize", 1),
    ...retentionParameter(parsed),
  };
}

/** `gs://bucket/some/prefix?projectId=…` → `gcsStorage({ bucket, prefix, … })`. */
function gcsStorageOf({ url, parsed }: StorageSchemeContext): StorageAdapter {
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
    prefix: decodedPath(parsed),
    ...(projectId ? { projectId } : {}),
    ...sizeParameter(parsed, "chunkSizeMiB", "chunkSize", MIB),
    ...retentionParameter(parsed),
  });
}

/**
 * `az://account/container/some/prefix` → `azureStorage(…)`, authenticated with
 * `AZURE_STORAGE_CONNECTION_STRING` if set, else `DefaultAzureCredential`.
 */
function azureStorageOf({ url, parsed, env }: StorageSchemeContext): StorageAdapter {
  rejectCredentials(
    parsed,
    "Azure",
    `Set ${ENV.azureConnectionString}, or use Microsoft Entra ID (DefaultAzureCredential).`,
  );
  rejectUnknownParameters(parsed, AZURE_QUERY_PARAMETERS, "Azure");
  const account = parsed.hostname;
  const [container = "", ...rest] = decodedPath(parsed)
    .split("/")
    .filter((segment) => segment.length > 0);
  if (!account || !container) {
    throw configError(`The Azure URL "${url}" needs an account and a container.`, {
      hint: "Use az://<account>/<container>/<optional/prefix>.",
    });
  }
  const prefix = rest.join("/");

  const connectionString = env[ENV.azureConnectionString];
  if (connectionString) {
    const storage = azureStorage({
      connectionString,
      container,
      prefix,
      ...azureUploadParameters(parsed),
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
  if (endpoint !== null) checkAzureEndpoint(endpoint, parsed);
  return azureStorage({
    accountUrl: endpoint ?? `https://${account}.blob.core.windows.net`,
    container,
    prefix,
    ...azureUploadParameters(parsed),
    ...retentionParameter(parsed),
  });
}

/** `?blockSizeMiB=…&uploadConcurrency=…` → the azureStorage options bounding upload memory. */
function azureUploadParameters(parsed: URL): { blockSize?: number; uploadConcurrency?: number } {
  return {
    ...sizeParameter(parsed, "blockSizeMiB", "blockSize", MIB),
    ...sizeParameter(parsed, "uploadConcurrency", "uploadConcurrency", 1),
  };
}

/**
 * `sftp://user@host:2222/srv/backups?fingerprint=SHA256:…` → `sftpStorage(…)`.
 * The key comes from `MONGOSHIELD_SFTP_KEY_FILE` and/or the SSH agent.
 */
function sftpStorageOf({ url, parsed, env }: StorageSchemeContext): StorageAdapter {
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
  const pathname = decodedPath(parsed);
  // "/~/backups" means "backups" relative to the login directory, as in curl.
  const path = pathname.startsWith("/~/") ? pathname.slice(3) : pathname;
  if (path === "" || path === "/~") {
    throw configError(`The SFTP URL "${url}" has no path.`, {
      hint: "Add the backup directory, e.g. sftp://backup@host/srv/backups or sftp://backup@host/~/backups.",
    });
  }

  const keyFile = env[ENV.sftpKeyFile];
  const passphrase = env[ENV.sftpKeyPassphrase];
  const hasAgent = Boolean(env[ENV.sshAgent]);
  if (!keyFile && !hasAgent) {
    throw configError(`No SSH key for ${url.split("?")[0]}.`, {
      hint: `Set ${ENV.sftpKeyFile} to a private key file, or start ssh-agent (SSH_AUTH_SOCK).`,
    });
  }

  // URLSearchParams decodes "+" as a space, but base64 fingerprints contain "+".
  const fromUrl = parsed.searchParams
    .getAll("fingerprint")
    .map((value) => value.replaceAll(" ", "+"));
  const fromEnv = (env[ENV.sftpHostFingerprint] ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  const fingerprints = fromUrl.length > 0 ? fromUrl : fromEnv;
  const allowUnknown = parsed.searchParams.get("allowUnknownHostKey");
  const allowUnknownHostKey = allowUnknown === null ? undefined : parseBoolean(allowUnknown);
  // Without a fingerprint, trust what `ssh` would trust: the user's known_hosts.
  // allowUnknownHostKey=true keeps its meaning of "verify nothing".
  const knownHostsPath =
    fingerprints.length === 0 && allowUnknownHostKey !== true
      ? env[ENV.sftpKnownHosts] || DEFAULT_KNOWN_HOSTS
      : undefined;

  return sftpStorage({
    host,
    ...(parsed.port ? { port: Number(parsed.port) } : {}),
    username,
    path,
    ...(keyFile ? { privateKeyPath: keyFile } : {}),
    ...(passphrase ? { passphrase } : {}),
    ...(hasAgent ? { agent: true as const } : {}),
    ...(fingerprints.length > 0 ? { hostFingerprint: fingerprints } : {}),
    ...(knownHostsPath === undefined ? {} : { knownHostsPath }),
    ...(allowUnknownHostKey === undefined ? {} : { allowUnknownHostKey }),
  });
}

/** `memory://name` → the process-wide store with that name (default `"default"`). */
function memoryStorageOf({ parsed }: StorageSchemeContext): StorageAdapter {
  const name = parsed.hostname || "default";
  let store = memoryStores.get(name);
  if (!store) {
    store = memoryStorage({ name });
    memoryStores.set(name, store);
  }
  return store;
}

/**
 * Checks an `endpoint` parameter and returns it parsed. Neither the error message
 * nor its cause repeats the endpoint text, which may hold the very secret it refuses.
 *
 * @throws MS_CONFIG_INVALID when it is not a URL, or carries user info, a query
 *   string or a fragment (where SAS tokens and presigned parameters live).
 */
function checkEndpoint(endpoint: string, label: "S3" | "Azure"): URL {
  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    throw configError(`The ${label} endpoint parameter is not a valid URL.`, {
      hint: "Use endpoint=https://host[:port], percent-encoded inside the storage URL.",
    });
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw configError(`The ${label} endpoint must not contain credentials or a query string.`, {
      hint:
        label === "Azure"
          ? `A SAS token (sv=…&sig=…) is a credential: put it in ${ENV.azureConnectionString} ` +
            "(BlobEndpoint=…;SharedAccessSignature=…) instead of the storage URL."
          : "Use endpoint=https://host[:port]; credentials come from the environment.",
    });
  }
  return parsed;
}

/**
 * Checks the `endpoint` of an `az://` URL that will use `DefaultAzureCredential`.
 * That credential attaches a bearer token for the storage account to every request,
 * so a host outside Azure Storage's domains could collect it (managed identity,
 * workload identity). Such hosts need an explicit `allowCustomEndpoint=true`.
 */
function checkAzureEndpoint(endpoint: string, azureUrl: URL): void {
  const endpointUrl = checkEndpoint(endpoint, "Azure");
  const allowCustom = azureUrl.searchParams.get("allowCustomEndpoint");
  const allowed = allowCustom !== null && parseBoolean(allowCustom);
  if (allowed || isAzureStorageHost(endpointUrl.hostname)) return;
  throw configError(
    `The Azure endpoint host "${endpointUrl.hostname}" is not an Azure Storage domain.`,
    {
      hint:
        "DefaultAzureCredential would send it a bearer token for your storage account. " +
        "If you trust this host (Azurite, a proxy you run), add allowCustomEndpoint=true " +
        `to the storage URL, or set ${ENV.azureConnectionString} instead.`,
    },
  );
}

/** True when `hostname` is one of Azure Storage's own hosts (see the suffix list). */
function isAzureStorageHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return AZURE_STORAGE_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix));
}

/**
 * The factory of a drive scheme whose adapter ships in a later release: the scheme is
 * reserved (no package can claim it by accident, and `init` can already write it), and
 * using it fails with a clear MS_NOT_IMPLEMENTED instead of "unsupported scheme".
 */
function notYetAvailable(service: string, scheme: string): StorageSchemeFactory {
  return () => {
    throw new MongoShieldError(
      "MS_NOT_IMPLEMENTED",
      `${service} storage (${scheme}://) is not available in this release of MongoShield yet.`,
      { hint: "Upgrade MongoShield, or choose another storage location for now." },
    );
  };
}

/**
 * The factory of every first-party scheme. Keys are exactly SUPPORTED_STORAGE_SCHEMES
 * (checked by `satisfies`); the registry looks schemes up here.
 *
 * Future first-party schemes go in their own slot below, each separated by a blank
 * line, so releases that add one each touch different lines.
 */
export const FIRST_PARTY_STORAGE_SCHEMES = {
  file: fileStorageOf,

  s3: s3StorageOf,

  gs: gcsStorageOf,

  az: azureStorageOf,

  sftp: sftpStorageOf,

  memory: memoryStorageOf,

  b2: b2StorageOf,

  r2: r2StorageOf,

  // gdrive://<folder>: the Google Drive release replaces this placeholder with its factory.
  gdrive: notYetAvailable("Google Drive", "gdrive"),

  // onedrive://<folder>: the OneDrive release replaces this placeholder with its factory.
  onedrive: notYetAvailable("OneDrive", "onedrive"),

  // dropbox://<folder>: the Dropbox release replaces this placeholder with its factory.
  dropbox: notYetAvailable("Dropbox", "dropbox"),
} as const satisfies Record<FirstPartyStorageScheme, StorageSchemeFactory>;
