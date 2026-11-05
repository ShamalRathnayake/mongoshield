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
 *   (also `requestChecksumCalculation=WHEN_REQUIRED` for S3-compatible services
 *   that fail multipart uploads with the SDK's default checksums, the default with
 *   an `endpoint`; `responseChecksumValidation`; `exactLastModified=true`;
 *   `conditionalWrites=true|false|probe`; and `partSizeMiB` / `queueSize`, which
 *   bound upload memory; see the s3Storage options)
 * - `b2://bucket/prefix?region=us-west-004`  Backblaze B2 through the S3 adapter
 *   (endpoint `https://s3.<region>.backblazeb2.com`, path-style; see s3-presets.ts)
 * - `r2://<accountId>/bucket/prefix?jurisdiction=eu`  Cloudflare R2 through the S3
 *   adapter (endpoint `https://<accountId>.r2.cloudflarestorage.com`, region `auto`).
 *   `b2://` and `r2://` take the S3 adapter's own parameters too (`retention`,
 *   `partSizeMiB`, `queueSize`, the checksum settings, `conditionalWrites`,
 *   `exactLastModified`), but not `endpoint`, `forcePathStyle` or (R2) `region`.
 * - `gs://bucket/prefix?projectId=…&chunkSizeMiB=…`   Google Cloud Storage
 * - `az://account/container/prefix?endpoint=…&blockSizeMiB=…&uploadConcurrency=…`   Azure Blob Storage
 * - `sftp://user@host:port/path?fingerprint=SHA256:…`   SFTP (`/~/path` = relative to the login directory)
 * - `memory://name`                    in-process store, shared by every URL with the same name
 * - any scheme a package registered with `registerStorageScheme` (registry.ts)
 *
 * Credentials never go in the URL; URLs that contain a password are rejected.
 * - S3, B2 and R2 use the AWS SDK's default credential chain (environment variables,
 *   profiles, instance roles). For B2, `AWS_ACCESS_KEY_ID` is the application key's
 *   keyID and `AWS_SECRET_ACCESS_KEY` its applicationKey; for R2, an API token's keys.
 * - GCS uses Application Default Credentials (`GOOGLE_APPLICATION_CREDENTIALS`,
 *   `gcloud auth application-default login`, the metadata server).
 * - Azure uses the connection string in `AZURE_STORAGE_CONNECTION_STRING` when
 *   it is set (its AccountName must match the URL), and otherwise
 *   `DefaultAzureCredential` (`AZURE_CLIENT_ID`/`AZURE_TENANT_ID`/…, managed or
 *   workload identity, `az login`) against `https://<account>.blob.core.windows.net`
 *   or the `endpoint` parameter. That credential sends a bearer token to the
 *   endpoint, so an `endpoint` outside Azure's own domains is refused unless the URL
 *   also says `allowCustomEndpoint=true`.
 * - An `endpoint` parameter must be a plain `scheme://host[:port][/path]`: user
 *   info or a query string (an Azure SAS token's `sig=…`, presigned S3 parameters)
 *   would put a credential in the URL, and is rejected like a password.
 * - SFTP authenticates with the private key file in `MONGOSHIELD_SFTP_KEY_FILE`
 *   (passphrase in `MONGOSHIELD_SFTP_KEY_PASSPHRASE`) and/or the SSH agent in
 *   `SSH_AUTH_SOCK`. The host key must match `fingerprint` (repeatable) or
 *   `MONGOSHIELD_SFTP_HOST_FINGERPRINT` (comma-separated). Without either, it
 *   must be listed in the known_hosts file named by `MONGOSHIELD_SFTP_KNOWN_HOSTS`
 *   (default `~/.ssh/known_hosts`), and hosts not listed there are refused. Only
 *   `allowUnknownHostKey=true` skips host key verification.
 * - `s3://`, `b2://`, `r2://`, `gs://` and `az://` accept `retention=compliance|governance`:
 *   the write-once retention mode used for immutable backups (`retainDays`). Default
 *   `compliance`. See docs/guides/immutable-backups.md.
 *
 * The first-party factories live in schemes.ts; the registry (registry.ts) serves them
 * next to registered ones. Each factory receives the parsed URL and the environment to
 * read credentials from (`resolveStorage(url, { env })` injects one, e.g. in tests).
 * Pass the adapter factories (`s3Storage`, `gcsStorage`, …) directly for anything else.
 */

import { MongoShieldError } from "../errors.ts";
import { fileStorage } from "./file.ts";
import {
  registeredStorageSchemes,
  type StorageEnvironment,
  storageSchemeFactory,
} from "./registry.ts";
import type { StorageAdapter } from "./types.ts";
import { parseStorageUrl } from "./url-parameters.ts";

export { SUPPORTED_STORAGE_SCHEMES } from "./schemes.ts";

/** Options for {@link resolveStorage}. */
export interface ResolveStorageOptions {
  /**
   * Where scheme factories read credentials from (`AZURE_STORAGE_CONNECTION_STRING`,
   * `MONGOSHIELD_SFTP_KEY_FILE`, a drive token, …). Defaults to `process.env`. The
   * AWS, Google Cloud and Azure SDKs' own credential chains still read the process
   * environment themselves.
   */
  readonly env?: StorageEnvironment;
}

/** A scheme is letters/digits/`+.-` followed by `://`. Windows paths (`C:\…`) never match. */
const SCHEME_PATTERN = /^([a-z][a-z0-9+.-]*):\/\//i;

/**
 * Creates the adapter a storage URL or bare path points to. Bare paths become the
 * file adapter; `<scheme>://` URLs go to the scheme's factory in the registry.
 *
 * @throws MS_CONFIG_INVALID for an empty location, an unknown scheme (the hint lists
 *   every registered one), or whatever the scheme's factory refuses.
 */
export async function resolveStorage(
  url: string,
  options: ResolveStorageOptions = {},
): Promise<StorageAdapter> {
  if (typeof url !== "string" || url.trim() === "") {
    throw new MongoShieldError("MS_CONFIG_INVALID", "The storage location is empty.");
  }
  const scheme = SCHEME_PATTERN.exec(url)?.[1]?.toLowerCase();
  if (scheme === undefined) return fileStorage({ path: url });

  const factory = storageSchemeFactory(scheme);
  if (factory === undefined) {
    const known = registeredStorageSchemes().map((name) => `${name}://`);
    throw new MongoShieldError("MS_CONFIG_INVALID", `Unsupported storage scheme "${scheme}://".`, {
      hint:
        `Use one of ${known.join(", ")}, or a plain directory path. ` +
        "Other schemes come from packages that register them (registerStorageScheme).",
    });
  }
  return factory({ url, parsed: parseStorageUrl(url), scheme, env: options.env ?? process.env });
}
