/**
 * Storage URLs as form fields: the pure logic behind the storage dialog's "Type" select
 * and per-type fields (pages/storage-form.tsx).
 *
 * The server stores a storage location as one URL, in the forms the library's
 * `storage/resolve.ts` and the console's `jobs/storage.ts` accept:
 *
 *   <folder>                                      local folder inside the data volume
 *   s3://bucket/prefix?region=…                   Amazon S3
 *   s3://bucket/prefix?region=…&endpoint=…&forcePathStyle=true
 *                                                 S3-compatible (R2, MinIO, B2, Wasabi…)
 *   gs://bucket/prefix?projectId=…                Google Cloud Storage
 *   az://account/container/prefix?endpoint=…      Azure Blob Storage
 *   sftp://user@host:port/path?fingerprint=SHA256:…&allowUnknownHostKey=true
 *                                                 SFTP (`/~/path` = relative to the login directory)
 *
 * `buildStorageUrl` turns the fields into that URL, and `parseStorageUrl` turns a URL
 * back into fields when editing. Parsing is only accepted when building the fields
 * again gives the very same URL, so editing a location through the fields can never
 * silently change a URL the form does not fully understand (`file://`, `memory://`,
 * unusual parameter orders…); those open in the "Edit as URL" mode instead. Parameters
 * the fields have no control for (e.g. `retention=governance`) are carried along
 * unchanged in `extraQuery`.
 *
 * Pure functions, unit-tested in storage-url.test.ts.
 */

/** The kinds of storage the "Type" select offers. */
export type StorageKind = "local" | "s3" | "s3-compatible" | "gcs" | "azure" | "sftp";

/** The options of the "Type" select, in the order they are shown. */
export const STORAGE_KINDS: readonly { readonly value: StorageKind; readonly label: string }[] = [
  { value: "s3", label: "Amazon S3" },
  { value: "s3-compatible", label: "S3-compatible (Cloudflare R2, MinIO, Backblaze B2, Wasabi…)" },
  { value: "gcs", label: "Google Cloud Storage" },
  { value: "azure", label: "Azure Blob Storage" },
  { value: "sftp", label: "SFTP server" },
  { value: "local", label: "Local folder (in the console's data volume)" },
];

/** S3-compatible providers the form knows how to build an endpoint for. */
export type S3Provider = "r2" | "b2" | "wasabi" | "spaces" | "minio" | "other";

/** How one S3-compatible provider's endpoint and region are made. */
interface S3ProviderPreset {
  readonly label: string;
  /**
   * For providers whose endpoint is a template: the label of the one value it needs
   * (an account ID or a region), an example, and how to build and recognise it.
   */
  readonly parameter?: {
    readonly label: string;
    readonly placeholder: string;
    /** What a valid value looks like, and what to say otherwise. */
    readonly pattern: RegExp;
    readonly problem: string;
    readonly endpoint: (value: string) => string;
    /** Recognises the endpoint, capturing the value. */
    readonly match: RegExp;
    /** The region the provider wants for a given value. */
    readonly region: (value: string) => string;
  };
  /** Whether the provider needs path-style requests (`forcePathStyle=true`). */
  readonly pathStyle: boolean;
}

/** Account IDs and regions are lowercase letters, digits and hyphens. */
const SLUG = /^[a-z0-9][a-z0-9-]*$/;

/** The S3-compatible providers, with what the s3 adapter's docs say each one needs. */
export const S3_PROVIDERS: Readonly<Record<S3Provider, S3ProviderPreset>> = {
  r2: {
    label: "Cloudflare R2",
    pathStyle: false,
    parameter: {
      label: "Cloudflare account ID",
      placeholder: "0123456789abcdef0123456789abcdef",
      pattern: /^[a-f0-9]+$/,
      problem: "Account IDs are lowercase hexadecimal (shown in the R2 dashboard).",
      endpoint: (value) => `https://${value}.r2.cloudflarestorage.com`,
      match: /^https:\/\/([a-f0-9]+)\.r2\.cloudflarestorage\.com$/,
      // R2 accepts only the region "auto".
      region: () => "auto",
    },
  },
  b2: {
    label: "Backblaze B2",
    pathStyle: false,
    parameter: {
      label: "B2 region",
      placeholder: "us-west-004",
      pattern: SLUG,
      problem: "Regions look like us-west-004 (shown with the bucket's endpoint).",
      endpoint: (value) => `https://s3.${value}.backblazeb2.com`,
      match: /^https:\/\/s3\.([a-z0-9-]+)\.backblazeb2\.com$/,
      region: (value) => value,
    },
  },
  wasabi: {
    label: "Wasabi",
    pathStyle: false,
    parameter: {
      label: "Wasabi region",
      placeholder: "eu-central-1",
      pattern: SLUG,
      problem: "Regions look like eu-central-1.",
      endpoint: (value) => `https://s3.${value}.wasabisys.com`,
      match: /^https:\/\/s3\.([a-z0-9-]+)\.wasabisys\.com$/,
      region: (value) => value,
    },
  },
  spaces: {
    label: "DigitalOcean Spaces",
    pathStyle: false,
    parameter: {
      label: "Spaces region",
      placeholder: "nyc3",
      pattern: SLUG,
      problem: "Regions look like nyc3 or fra1.",
      endpoint: (value) => `https://${value}.digitaloceanspaces.com`,
      match: /^https:\/\/([a-z0-9-]+)\.digitaloceanspaces\.com$/,
      // Spaces ignores the region, but the AWS SDK needs one; DigitalOcean documents this.
      region: () => "us-east-1",
    },
  },
  minio: { label: "MinIO / self-hosted (path-style)", pathStyle: true },
  other: { label: "Other S3-compatible service", pathStyle: false },
};

/** The order of the provider select. */
export const S3_PROVIDER_ORDER: readonly S3Provider[] = [
  "r2",
  "minio",
  "b2",
  "wasabi",
  "spaces",
  "other",
];

/** Common AWS regions for the region select ("Other…" covers the rest). */
export const AWS_REGIONS: readonly { readonly value: string; readonly label: string }[] = [
  { value: "us-east-1", label: "US East (N. Virginia) · us-east-1" },
  { value: "us-east-2", label: "US East (Ohio) · us-east-2" },
  { value: "us-west-1", label: "US West (N. California) · us-west-1" },
  { value: "us-west-2", label: "US West (Oregon) · us-west-2" },
  { value: "ca-central-1", label: "Canada (Central) · ca-central-1" },
  { value: "sa-east-1", label: "South America (São Paulo) · sa-east-1" },
  { value: "eu-west-1", label: "Europe (Ireland) · eu-west-1" },
  { value: "eu-west-2", label: "Europe (London) · eu-west-2" },
  { value: "eu-west-3", label: "Europe (Paris) · eu-west-3" },
  { value: "eu-central-1", label: "Europe (Frankfurt) · eu-central-1" },
  { value: "eu-central-2", label: "Europe (Zurich) · eu-central-2" },
  { value: "eu-north-1", label: "Europe (Stockholm) · eu-north-1" },
  { value: "eu-south-1", label: "Europe (Milan) · eu-south-1" },
  { value: "me-south-1", label: "Middle East (Bahrain) · me-south-1" },
  { value: "af-south-1", label: "Africa (Cape Town) · af-south-1" },
  { value: "ap-south-1", label: "Asia Pacific (Mumbai) · ap-south-1" },
  { value: "ap-east-1", label: "Asia Pacific (Hong Kong) · ap-east-1" },
  { value: "ap-southeast-1", label: "Asia Pacific (Singapore) · ap-southeast-1" },
  { value: "ap-southeast-2", label: "Asia Pacific (Sydney) · ap-southeast-2" },
  { value: "ap-northeast-1", label: "Asia Pacific (Tokyo) · ap-northeast-1" },
  { value: "ap-northeast-2", label: "Asia Pacific (Seoul) · ap-northeast-2" },
  { value: "ap-northeast-3", label: "Asia Pacific (Osaka) · ap-northeast-3" },
];

/**
 * Every field of every type. Only the fields of `kind` are used; the others keep what
 * was typed, so switching the type back and forth loses nothing.
 */
export interface StorageFields {
  readonly kind: StorageKind;
  /** local: the folder, relative to the data volume or absolute inside it. */
  readonly folder: string;
  /** s3, s3-compatible, gcs: the bucket name. */
  readonly bucket: string;
  /** s3, s3-compatible, gcs, azure: the folder inside the bucket/container ("" = the root). */
  readonly prefix: string;
  /** s3, s3-compatible "other": the region ("" = the console's default, `AWS_REGION`). */
  readonly region: string;
  /** s3-compatible: which provider the endpoint is for. */
  readonly provider: S3Provider;
  /** s3-compatible presets: the account ID or region the endpoint template needs. */
  readonly providerValue: string;
  /** s3-compatible minio/other, azure (optional): the service endpoint URL. */
  readonly endpoint: string;
  /** s3-compatible "other": send path-style requests. */
  readonly forcePathStyle: boolean;
  /** gcs (optional): the project ID. */
  readonly projectId: string;
  /** azure: the storage account and the container. */
  readonly account: string;
  readonly container: string;
  /** sftp: the login, server and port ("" = 22). */
  readonly user: string;
  readonly host: string;
  readonly port: string;
  /** sftp: the folder; absolute (`/srv/backups`) or relative to the login directory (`~/backups`). */
  readonly path: string;
  /** sftp: host key fingerprints (`SHA256:…`), separated by commas or spaces. */
  readonly fingerprint: string;
  /** sftp: accept any host key (dangerous). */
  readonly allowUnknownHostKey: boolean;
  /** Query parameters the fields do not cover, kept verbatim (`retention=governance`). */
  readonly extraQuery: string;
}

/** Empty fields for a new location of `kind`. */
export function emptyStorageFields(kind: StorageKind = "s3"): StorageFields {
  return {
    kind,
    folder: "",
    bucket: "",
    prefix: "",
    region: "",
    provider: "r2",
    providerValue: "",
    endpoint: "",
    forcePathStyle: false,
    projectId: "",
    account: "",
    container: "",
    user: "",
    host: "",
    port: "",
    path: "",
    fingerprint: "",
    allowUnknownHostKey: false,
    extraQuery: "",
  };
}

// ---------------------------------------------------------------------------
// Building
// ---------------------------------------------------------------------------

/**
 * Encodes a query value, but leaves `:` and `/` readable: `endpoint=https://x` reads
 * better than `endpoint=https%3A%2F%2Fx`, and both are valid in a query string.
 * Fingerprints also keep their `+`: base64 uses it, and the adapters turn the space a
 * URL parser reads for it back into `+` (`%2B` would work too, but reads worse).
 */
function queryValue(name: string, value: string): string {
  const encoded = encodeURIComponent(value).replace(/%3A/gi, ":").replace(/%2F/gi, "/");
  return name === "fingerprint" ? encoded.replace(/%2B/gi, "+") : encoded;
}

/** `?a=1&b=2` from name/value pairs (empty values are left out) plus the extra parameters. */
function queryString(parameters: readonly (readonly [string, string])[], extra: string): string {
  const parts = parameters
    .filter(([, value]) => value !== "")
    .map(([name, value]) => `${name}=${queryValue(name, value)}`);
  if (extra !== "") parts.push(extra);
  return parts.length === 0 ? "" : `?${parts.join("&")}`;
}

/** Percent-encodes each segment of a path, keeping the slashes between them. */
function encodePath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

/** The prefix without leading slashes (the adapters strip them anyway). */
function cleanPrefix(prefix: string): string {
  return prefix.trim().replace(/^\/+/, "");
}

/** The endpoint and region an S3-compatible location uses, from its provider. */
export function s3CompatibleTarget(fields: StorageFields): {
  endpoint: string;
  region: string;
  forcePathStyle: boolean;
} {
  const preset = S3_PROVIDERS[fields.provider];
  const value = fields.providerValue.trim();
  if (preset.parameter !== undefined) {
    return {
      endpoint: preset.parameter.endpoint(value),
      region: preset.parameter.region(value),
      forcePathStyle: false,
    };
  }
  return {
    endpoint: fields.endpoint.trim(),
    // MinIO accepts any region; the adapter picks a default when none is given.
    region: fields.provider === "minio" ? "" : fields.region.trim(),
    forcePathStyle: preset.pathStyle || fields.forcePathStyle,
  };
}

/** `s3://bucket/prefix`: always a slash after the bucket, then the prefix (may be empty). */
function bucketPath(scheme: string, bucket: string, prefix: string): string {
  return `${scheme}://${bucket.trim()}/${encodePath(cleanPrefix(prefix))}`;
}

/** The storage URL the fields stand for (see the file header for the forms). */
export function buildStorageUrl(fields: StorageFields): string {
  switch (fields.kind) {
    case "local":
      return fields.folder.trim();
    case "s3":
      return (
        bucketPath("s3", fields.bucket, fields.prefix) +
        queryString([["region", fields.region.trim()]], fields.extraQuery)
      );
    case "s3-compatible": {
      const target = s3CompatibleTarget(fields);
      return (
        bucketPath("s3", fields.bucket, fields.prefix) +
        queryString(
          [
            ["region", target.region],
            ["endpoint", target.endpoint],
            ["forcePathStyle", target.forcePathStyle ? "true" : ""],
          ],
          fields.extraQuery,
        )
      );
    }
    case "gcs":
      return (
        bucketPath("gs", fields.bucket, fields.prefix) +
        queryString([["projectId", fields.projectId.trim()]], fields.extraQuery)
      );
    case "azure": {
      const prefix = cleanPrefix(fields.prefix);
      return (
        `az://${fields.account.trim()}/${encodeURIComponent(fields.container.trim())}` +
        (prefix === "" ? "" : `/${encodePath(prefix)}`) +
        queryString([["endpoint", fields.endpoint.trim()]], fields.extraQuery)
      );
    }
    case "sftp": {
      const host = fields.host.trim();
      // IPv6 literals go in brackets, as in any URL.
      const hostPart = host.includes(":") ? `[${host}]` : host;
      const port = fields.port.trim();
      const parameters: [string, string][] = fingerprintsOf(fields.fingerprint).map(
        (fingerprint) => ["fingerprint", fingerprint],
      );
      if (fields.allowUnknownHostKey) parameters.push(["allowUnknownHostKey", "true"]);
      return (
        `sftp://${encodeURIComponent(fields.user.trim())}@${hostPart}${port === "" ? "" : `:${port}`}` +
        encodePath(sftpUrlPath(fields.path)) +
        queryString(parameters, fields.extraQuery)
      );
    }
  }
}

/**
 * The URL path of an SFTP folder: absolute paths as they are, `~/backups` (or just
 * `backups`) as `/~/backups`, which the adapter reads as "relative to the login directory".
 */
function sftpUrlPath(path: string): string {
  const trimmed = path.trim();
  if (trimmed.startsWith("/")) return trimmed;
  if (trimmed.startsWith("~/")) return `/${trimmed}`;
  return `/~/${trimmed}`;
}

/** The fingerprints typed in one field, split at commas and spaces. */
export function fingerprintsOf(text: string): string[] {
  return text.split(/[\s,]+/).filter((fingerprint) => fingerprint !== "");
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/** The scheme of a storage URL: `file` for a bare path, `unknown` for anything else. */
export type StorageScheme = "file" | "s3" | "gs" | "az" | "sftp" | "memory" | "unknown";

/** Recognises the scheme of a storage URL the way the server does (a bare path is `file`). */
export function storageSchemeOf(url: string): StorageScheme {
  const match = /^([a-z][a-z0-9+.-]*):\/\//i.exec(url.trim());
  if (match === null) return "file";
  const scheme = (match[1] ?? "").toLowerCase();
  const known: readonly StorageScheme[] = ["file", "s3", "gs", "az", "sftp", "memory"];
  return known.find((candidate) => candidate === scheme) ?? "unknown";
}

/** The query split into the parameters the fields know and the rest, verbatim. */
function splitQuery(
  search: string,
  known: readonly string[],
): { values: URLSearchParams; extra: string } {
  const values = new URLSearchParams();
  const extra: string[] = [];
  for (const part of search.replace(/^\?/, "").split("&")) {
    if (part === "") continue;
    const name = decodeURIComponent(part.split("=")[0] ?? "");
    if (!known.includes(name)) {
      extra.push(part);
      continue;
    }
    // URLSearchParams decodes the one pair the same way the server will.
    for (const [key, value] of new URLSearchParams(part)) values.append(key, value);
  }
  return { values, extra: extra.join("&") };
}

/** Parses a URL, or returns undefined for one that is not valid. */
function tryUrl(url: string): URL | undefined {
  try {
    return new URL(url);
  } catch {
    return undefined;
  }
}

/** The fields for a URL, without the round-trip check (see `parseStorageUrl`). */
function fieldsOf(url: string): StorageFields | undefined {
  const scheme = storageSchemeOf(url);
  const empty = emptyStorageFields();
  if (scheme === "file") {
    // Only bare paths; `file://` URLs are left to the URL mode.
    return /^file:/i.test(url) ? undefined : { ...empty, kind: "local", folder: url };
  }
  const parsed = tryUrl(url);
  // Credentials never belong in the URL (the server refuses them); `user@` only for SFTP.
  if (parsed === undefined || parsed.password !== "") return undefined;
  if (scheme !== "sftp" && parsed.username !== "") return undefined;
  const path = decodeURIComponent(parsed.pathname);

  switch (scheme) {
    case "s3": {
      const { values, extra } = splitQuery(parsed.search, ["region", "endpoint", "forcePathStyle"]);
      const base = {
        ...empty,
        bucket: parsed.hostname,
        prefix: path.replace(/^\//, ""),
        extraQuery: extra,
      };
      const endpoint = values.get("endpoint");
      const region = values.get("region") ?? "";
      if (endpoint === null) return { ...base, kind: "s3", region };
      const forcePathStyle = values.get("forcePathStyle") === "true";
      // A known provider's endpoint, with the region that provider wants…
      for (const provider of S3_PROVIDER_ORDER) {
        const parameter = S3_PROVIDERS[provider].parameter;
        const value = parameter?.match.exec(endpoint)?.[1];
        if (parameter === undefined || value === undefined) continue;
        if (parameter.region(value) === region && !forcePathStyle) {
          return { ...base, kind: "s3-compatible", provider, providerValue: value };
        }
      }
      // …or path-style without a region (MinIO), or anything else.
      const provider: S3Provider = forcePathStyle && region === "" ? "minio" : "other";
      return { ...base, kind: "s3-compatible", provider, endpoint, region, forcePathStyle };
    }
    case "gs": {
      const { values, extra } = splitQuery(parsed.search, ["projectId"]);
      return {
        ...empty,
        kind: "gcs",
        bucket: parsed.hostname,
        prefix: path.replace(/^\//, ""),
        projectId: values.get("projectId") ?? "",
        extraQuery: extra,
      };
    }
    case "az": {
      const { values, extra } = splitQuery(parsed.search, ["endpoint"]);
      // "/container/some/prefix" → "container" and "some/prefix".
      const [, container = "", ...rest] = path.split("/");
      return {
        ...empty,
        kind: "azure",
        account: parsed.hostname,
        container,
        prefix: rest.join("/"),
        endpoint: values.get("endpoint") ?? "",
        extraQuery: extra,
      };
    }
    case "sftp": {
      const { values, extra } = splitQuery(parsed.search, ["fingerprint", "allowUnknownHostKey"]);
      return {
        ...empty,
        kind: "sftp",
        user: decodeURIComponent(parsed.username),
        host: parsed.hostname.replace(/^\[(.*)\]$/, "$1"),
        port: parsed.port,
        // "/~/backups" is shown as "~/backups".
        path: path.startsWith("/~/") ? path.slice(1) : path,
        // URLSearchParams reads "+" as a space; base64 fingerprints contain "+".
        fingerprint: values
          .getAll("fingerprint")
          .map((value) => value.replaceAll(" ", "+"))
          .join(", "),
        allowUnknownHostKey: values.get("allowUnknownHostKey") === "true",
        extraQuery: extra,
      };
    }
    default:
      // memory:// (tests and demos) and unknown schemes: URL mode only.
      return undefined;
  }
}

/**
 * A URL with the trailing slashes of its path removed: `s3://bucket`, `s3://bucket/` and
 * `az://account/container/` mean the same to the adapters (they normalise prefixes).
 */
function withoutTrailingSlash(url: string): string {
  const query = url.indexOf("?");
  const base = query === -1 ? url : url.slice(0, query);
  return base.replace(/\/+$/, "") + (query === -1 ? "" : url.slice(query));
}

/**
 * The fields for an existing location's URL, or undefined when the form cannot show it
 * exactly: then the dialog opens in "Edit as URL" mode. "Exactly" means building the
 * fields again gives the same URL, give or take a trailing slash.
 */
export function parseStorageUrl(url: string): StorageFields | undefined {
  if (url.trim() === "") return undefined;
  let fields: StorageFields | undefined;
  try {
    fields = fieldsOf(url);
  } catch {
    // A malformed percent-escape (decodeURIComponent throws): URL mode.
    return undefined;
  }
  if (fields === undefined) return undefined;
  const rebuilt = buildStorageUrl(fields);
  return withoutTrailingSlash(rebuilt) === withoutTrailingSlash(url) ? fields : undefined;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/** Field name → what is wrong with it. */
export type StorageFieldErrors = Partial<Record<keyof StorageFields, string>>;

/** True for an http(s) URL with a host. */
function isHttpUrl(value: string): boolean {
  const parsed = tryUrl(value);
  return parsed !== undefined && /^https?:$/.test(parsed.protocol) && parsed.hostname !== "";
}

/** AWS bucket names: 3–63 lowercase letters, digits, dots and hyphens. */
const AWS_BUCKET = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;
/** Other providers are more lenient; just no slashes, spaces, `?` or `#`. */
const ANY_BUCKET = /^[^\s/?#]+$/;
/** Azure storage accounts: 3–24 lowercase letters and digits. */
const AZURE_ACCOUNT = /^[a-z0-9]{3,24}$/;
/** Azure containers: 3–63 lowercase letters, digits and single hyphens. */
const AZURE_CONTAINER = /^[a-z0-9](?!.*--)[a-z0-9-]{1,61}[a-z0-9]$/;
/** An OpenSSH SHA256 fingerprint: optional `SHA256:` and 43 base64 characters (padding optional). */
const FINGERPRINT = /^(SHA256:)?[A-Za-z0-9+/]{43}=?$/i;

/**
 * What is wrong with the fields of the chosen type, per field (empty when they are
 * fine). Mirrors the library's checks, so mistakes show next to the field before saving.
 */
export function storageFieldErrors(fields: StorageFields): StorageFieldErrors {
  const errors: StorageFieldErrors = {};
  const bucket = fields.bucket.trim();
  /** Checks the bucket against `pattern`, with the right message. */
  const checkBucket = (pattern: RegExp, problem: string) => {
    if (bucket === "") errors.bucket = "Enter the bucket name.";
    else if (!pattern.test(bucket)) errors.bucket = problem;
  };
  switch (fields.kind) {
    case "local": {
      const folder = fields.folder.trim();
      if (folder === "") errors.folder = "Enter a folder, e.g. backups.";
      else if (folder.split(/[/\\]/).includes("..")) {
        errors.folder = "The folder must stay inside the data volume, so it cannot contain “..”.";
      } else if (storageSchemeOf(folder) !== "file") {
        errors.folder = "That is a URL. Choose its type above, or use “Edit as URL”.";
      }
      break;
    }
    case "s3":
      checkBucket(
        AWS_BUCKET,
        "S3 bucket names are 3–63 lowercase letters, numbers, dots and hyphens.",
      );
      if (fields.region.trim() !== "" && !SLUG.test(fields.region.trim())) {
        errors.region = "Regions look like eu-west-1.";
      }
      break;
    case "s3-compatible": {
      checkBucket(
        ANY_BUCKET,
        "Bucket names cannot contain slashes or spaces; put folders in the prefix.",
      );
      const parameter = S3_PROVIDERS[fields.provider].parameter;
      const value = fields.providerValue.trim();
      if (parameter !== undefined) {
        if (value === "") errors.providerValue = `Enter the ${parameter.label}.`;
        else if (!parameter.pattern.test(value)) errors.providerValue = parameter.problem;
      } else if (!isHttpUrl(fields.endpoint.trim())) {
        errors.endpoint = "Enter the endpoint URL, e.g. https://minio.example.com:9000.";
      }
      break;
    }
    case "gcs":
      checkBucket(
        ANY_BUCKET,
        "Bucket names cannot contain slashes or spaces; put folders in the prefix.",
      );
      break;
    case "azure": {
      const account = fields.account.trim();
      const container = fields.container.trim();
      if (account === "") errors.account = "Enter the storage account name.";
      else if (!AZURE_ACCOUNT.test(account)) {
        errors.account = "Storage account names are 3–24 lowercase letters and numbers.";
      }
      if (container === "") errors.container = "Enter the container name.";
      else if (!AZURE_CONTAINER.test(container)) {
        errors.container =
          "Container names are 3–63 lowercase letters, numbers and single hyphens.";
      }
      if (fields.endpoint.trim() !== "" && !isHttpUrl(fields.endpoint.trim())) {
        errors.endpoint =
          "Enter a URL such as http://127.0.0.1:10000/devstoreaccount1, or leave it empty.";
      }
      break;
    }
    case "sftp": {
      const port = fields.port.trim();
      if (fields.user.trim() === "") errors.user = "Enter the user to log in as.";
      if (fields.host.trim() === "") errors.host = "Enter the server's host name or IP address.";
      else if (/[\s/@?#]/.test(fields.host.trim()))
        errors.host = "Enter only the host name, e.g. backup.example.com.";
      if (port !== "" && !(/^\d+$/.test(port) && Number(port) >= 1 && Number(port) <= 65_535)) {
        errors.port = "Ports are numbers from 1 to 65535.";
      }
      if (fields.path.trim() === "" || fields.path.trim() === "~" || fields.path.trim() === "~/") {
        errors.path = "Enter the folder, e.g. /srv/backups or ~/backups.";
      }
      const invalid = fingerprintsOf(fields.fingerprint).find((value) => !FINGERPRINT.test(value));
      if (invalid !== undefined) {
        errors.fingerprint = `“${invalid}” is not a SHA256 fingerprint (SHA256:… from ssh-keygen -lf).`;
      }
      break;
    }
  }
  return errors;
}
