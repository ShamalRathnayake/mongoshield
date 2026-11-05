/**
 * Reading the query parameters of storage URLs (`?region=…&partSizeMiB=8`), shared by
 * the first-party scheme factories in schemes.ts. Every helper fails with
 * MS_CONFIG_INVALID and a hint naming the accepted values, and none of them repeats a
 * value that could be a secret.
 */

import { MongoShieldError } from "../errors.ts";
import type { RetentionOptions } from "./types.ts";

/** Bytes in one MiB, for the `…SizeMiB` URL parameters. */
export const MIB = 1024 * 1024;

/** Parses a storage URL, failing with MS_CONFIG_INVALID (without echoing it) when it is not one. */
export function parseStorageUrl(url: string): URL {
  try {
    return new URL(url);
  } catch (error) {
    throw configError("The storage location is not a valid URL.", {
      cause: error,
      hint: "Use <scheme>://… (for example s3://bucket/prefix), or a plain directory path.",
    });
  }
}

/** Refuses `user:password@` in a URL: credentials come from the environment. */
export function rejectCredentials(parsed: URL, label: string, hint: string): void {
  if (parsed.username || parsed.password) {
    throw configError(`${label} URLs must not contain credentials.`, { hint });
  }
}

/** Refuses query parameters outside `allowed`, to catch typos such as `regoin=`. */
export function rejectUnknownParameters(
  parsed: URL,
  allowed: ReadonlySet<string>,
  label: string,
): void {
  for (const name of parsed.searchParams.keys()) {
    if (!allowed.has(name)) {
      throw configError(`Unknown ${label} URL parameter "${name}".`, {
        hint: `Supported parameters: ${[...allowed].join(", ")}.`,
      });
    }
  }
}

/** `true`, `1` or an empty value → true; `false` or `0` → false; anything else fails. */
export function parseBoolean(value: string): boolean {
  const normalized = value.toLowerCase();
  if (normalized === "true" || normalized === "1" || normalized === "") return true;
  if (normalized === "false" || normalized === "0") return false;
  throw configError(`Invalid boolean "${value}" in storage URL.`, {
    hint: "Use true or false.",
  });
}

/** An optional boolean parameter as an option of the same name, or nothing when absent. */
export function booleanParameter<Name extends string>(
  parsed: URL,
  name: Name,
): { [Key in Name]?: boolean } {
  const value = parsed.searchParams.get(name);
  if (value === null) return {};
  return { [name]: parseBoolean(value) } as { [Key in Name]?: boolean };
}

/**
 * `?requestChecksumCalculation=WHEN_REQUIRED` or `?responseChecksumValidation=…`
 * (values case-insensitive) → the s3Storage option of the same name.
 */
export function checksumParameter<
  Name extends "requestChecksumCalculation" | "responseChecksumValidation",
>(parsed: URL, name: Name): { [Key in Name]?: "WHEN_SUPPORTED" | "WHEN_REQUIRED" } {
  const value = parsed.searchParams.get(name);
  if (value === null) return {};
  const normalized = value.toUpperCase();
  if (normalized === "WHEN_SUPPORTED" || normalized === "WHEN_REQUIRED") {
    return { [name]: normalized } as { [Key in Name]?: "WHEN_SUPPORTED" | "WHEN_REQUIRED" };
  }
  throw configError(`Invalid ${name} "${value}" in storage URL.`, {
    hint: `Use ${name}=WHEN_REQUIRED or WHEN_SUPPORTED.`,
  });
}

/** `?conditionalWrites=true|false|probe` → the s3Storage option (see its docs). */
export function conditionalWritesParameter(parsed: URL): { conditionalWrites?: boolean | "probe" } {
  const value = parsed.searchParams.get("conditionalWrites");
  if (value === null) return {};
  if (value.toLowerCase() === "probe") return { conditionalWrites: "probe" };
  return { conditionalWrites: parseBoolean(value) };
}

/**
 * A positive whole-number URL parameter, multiplied by `unit` (`MIB` for sizes given
 * in MiB, 1 for counts), as the adapter option `option`. The adapter checks its own
 * limits (S3's 5 MiB minimum part size, GCS's 256 KiB chunk granularity).
 */
export function sizeParameter<Option extends string>(
  parsed: URL,
  name: string,
  option: Option,
  unit: number,
): { [Key in Option]?: number } {
  const value = parsed.searchParams.get(name);
  if (value === null) return {};
  if (!/^[1-9]\d{0,5}$/.test(value)) {
    throw configError(`Invalid ${name} "${value}" in storage URL.`, {
      hint: `Use a positive whole number, e.g. ${name}=${unit === MIB ? 8 : 2}.`,
    });
  }
  return { [option]: Number(value) * unit } as { [Key in Option]?: number };
}

/** `?retention=governance` → `{ retention: { mode: "governance" } }`; absent → `{}`. */
export function retentionParameter(parsed: URL): { retention?: RetentionOptions } {
  const mode = parsed.searchParams.get("retention");
  if (mode === null) return {};
  if (mode === "compliance" || mode === "governance") return { retention: { mode } };
  throw configError(`Invalid retention mode "${mode}" in storage URL.`, {
    hint: "Use retention=compliance or retention=governance.",
  });
}

/** The URL path without its leading slash, percent-decoded: `/prod/mongo` → `prod/mongo`. */
export function decodedPath(parsed: URL): string {
  return decodeURIComponent(parsed.pathname);
}

/** The error every helper here throws. */
export function configError(
  message: string,
  options: { hint?: string; cause?: unknown } = {},
): MongoShieldError {
  return new MongoShieldError("MS_CONFIG_INVALID", message, options);
}
