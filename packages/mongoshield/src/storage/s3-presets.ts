/**
 * Backblaze B2 and Cloudflare R2 presets on the S3 adapter: the endpoint, region,
 * addressing style and checksum settings each service needs, so users only name
 * their bucket. Exported from `mongoshield/storage/s3`, and behind the `b2://` and
 * `r2://` storage URLs (schemes.ts).
 *
 *   b2Storage({ bucket: "acme-backups", prefix: "prod", region: "us-west-004" })
 *   r2Storage({ accountId: "0123…cdef", bucket: "acme-backups", prefix: "prod" })
 *
 * Credentials work exactly as for `s3Storage`: the AWS SDK's default chain
 * (`AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY`), or `credentials`.
 * - B2: an *application key*. Its "keyID" is the access key id and its
 *   "applicationKey" the secret access key. The master key does not work with the S3
 *   API; create an application key limited to the bucket (docs/guides/b2-and-r2.md).
 * - R2: an R2 API token's "Access Key ID" and "Secret Access Key".
 *
 * Why these settings:
 * - Both use `requestChecksumCalculation` and `responseChecksumValidation`
 *   "WHEN_REQUIRED", the setting the S3 adapter already uses for custom endpoints:
 *   neither service reliably accepts the SDK's default per-part CRC32 checksums on
 *   multipart uploads (see the s3.ts header). Backups stay verified end to end by the
 *   SHA-256 of every file in the manifest. Both can be overridden.
 * - B2 is addressed path-style (`https://s3.<region>.backblazeb2.com/<bucket>/…`):
 *   B2 accepts both styles, and path style also works for bucket names that are not
 *   valid DNS labels. Its conditional writes are probed once (s3.ts), as for any
 *   S3-compatible host.
 * - R2 keeps virtual-hosted addressing, which Cloudflare documents, and region
 *   "auto". R2 honours `If-None-Match: *`, so the storage lock works without a probe.
 */

import { MongoShieldError } from "../errors.ts";
import { type S3StorageOptions, s3Storage } from "./s3.ts";
import type { StorageAdapter } from "./types.ts";

/** s3Storage options a preset decides itself, so its callers cannot pass them. */
type PresetManaged = "endpoint" | "region" | "forcePathStyle" | "client";

/** Options for {@link b2Storage}: the S3 options, with `region` required and no `endpoint`. */
export interface B2StorageOptions extends Omit<S3StorageOptions, PresetManaged> {
  /**
   * The bucket's region, as in its S3 endpoint `s3.<region>.backblazeb2.com`, e.g.
   * `"us-west-004"` or `"eu-central-003"` (Buckets → the bucket's "Endpoint").
   */
  readonly region: string;
}

/** Options for {@link r2Storage}: the S3 options, with the account instead of an endpoint. */
export interface R2StorageOptions extends Omit<S3StorageOptions, PresetManaged> {
  /** The Cloudflare account id: 32 hex characters, shown on the R2 overview page. */
  readonly accountId: string;
  /**
   * The jurisdiction of buckets created with one (`eu`, `fedramp`), which have their
   * own endpoint. Omit it for ordinary buckets.
   */
  readonly jurisdiction?: R2Jurisdiction;
}

/** R2 jurisdictions with their own S3 endpoint. */
export type R2Jurisdiction = "eu" | "fedramp";

/** The jurisdictions `r2Storage` accepts, for validation and error hints. */
export const R2_JURISDICTIONS: readonly R2Jurisdiction[] = ["eu", "fedramp"];

/**
 * B2 region names: two letters, a direction and a three-digit cluster number
 * (`us-west-004`, `eu-central-003`, `ca-east-006`). AWS-style names such as
 * `us-west-2` are a common mistake and are refused early.
 */
const B2_REGION = /^[a-z]{2}-[a-z]+-\d{3}$/;

/** A Cloudflare account id: 32 hex digits. */
const R2_ACCOUNT_ID = /^[0-9a-f]{32}$/;

/** The checksum settings both presets default to (see the file header). */
const COMPATIBLE_CHECKSUMS = {
  requestChecksumCalculation: "WHEN_REQUIRED",
  responseChecksumValidation: "WHEN_REQUIRED",
} as const;

/** The S3 options a B2 bucket needs (exported for tests and the console). */
export function b2S3Options(options: B2StorageOptions): S3StorageOptions {
  const region = typeof options.region === "string" ? options.region.toLowerCase() : "";
  if (!B2_REGION.test(region)) {
    throw new MongoShieldError("MS_CONFIG_INVALID", `Invalid Backblaze B2 region "${region}".`, {
      hint:
        "Use the region from the bucket's S3 endpoint s3.<region>.backblazeb2.com, " +
        "e.g. us-west-004 or eu-central-003.",
    });
  }
  return {
    ...COMPATIBLE_CHECKSUMS,
    ...options,
    region,
    endpoint: `https://s3.${region}.backblazeb2.com`,
    forcePathStyle: true,
  };
}

/** The S3 options an R2 bucket needs (exported for tests and the console). */
export function r2S3Options(options: R2StorageOptions): S3StorageOptions {
  const accountId = typeof options.accountId === "string" ? options.accountId.toLowerCase() : "";
  if (!R2_ACCOUNT_ID.test(accountId)) {
    throw new MongoShieldError("MS_CONFIG_INVALID", "Invalid Cloudflare account id for R2.", {
      hint: "Use the 32-character account id from the R2 overview page (Account details).",
    });
  }
  const { jurisdiction, accountId: _accountId, ...rest } = options;
  if (jurisdiction !== undefined && !R2_JURISDICTIONS.includes(jurisdiction)) {
    throw new MongoShieldError("MS_CONFIG_INVALID", `Invalid R2 jurisdiction "${jurisdiction}".`, {
      hint: `Use one of ${R2_JURISDICTIONS.join(", ")}, or leave it out for ordinary buckets.`,
    });
  }
  const host =
    jurisdiction === undefined
      ? `${accountId}.r2.cloudflarestorage.com`
      : `${accountId}.${jurisdiction}.r2.cloudflarestorage.com`;
  return {
    ...COMPATIBLE_CHECKSUMS,
    ...rest,
    // R2 ignores the region, but the SDK needs one; "auto" is what Cloudflare documents.
    region: "auto",
    endpoint: `https://${host}`,
  };
}

/** A Backblaze B2 bucket through the S3 adapter. See the file header for credentials. */
export function b2Storage(options: B2StorageOptions): StorageAdapter {
  return s3Storage(b2S3Options(options));
}

/** A Cloudflare R2 bucket through the S3 adapter. See the file header for credentials. */
export function r2Storage(options: R2StorageOptions): StorageAdapter {
  return s3Storage(r2S3Options(options));
}
