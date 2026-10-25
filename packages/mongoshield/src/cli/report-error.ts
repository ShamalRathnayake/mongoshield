/**
 * Turning any failure into what the user sees, and into an exit code.
 *
 *   ✖ MS_CONNECTION_FAILED  Could not connect to MongoDB at mongodb://app:***@db:27017: …
 *     hint  Nothing is accepting connections at that address. Check that mongod is running…
 *     docs  https://github.com/…/docs/errors.md#ms_connection_failed
 *
 * With --json the same information is printed as `{ "error": { … } }` on stdout,
 * so a script reading stdout always receives exactly one JSON document.
 *
 * Every string shown is scrubbed of secrets first: the library already redacts
 * its own messages, but errors can come from anywhere (a driver, the file
 * system, a config file), so the CLI double-checks before printing.
 */

import { ERROR_CODES, isMongoShieldError, MongoShieldError } from "../errors.ts";
import { redactMongoUri, redactSecrets } from "../redact.ts";
import type { Output } from "./io.ts";

/** Where users report bugs. */
const ISSUES_URL = "https://github.com/ShamalRathnayake/mongoshield/issues";

/** Matches MongoDB connection strings embedded in free text. */
const MONGO_URI_IN_TEXT = /mongodb(?:\+srv)?:\/\/[^\s"'`]+/gi;

/** A connection string with a password that has not been redacted yet. */
const UNREDACTED_PASSWORD = /^mongodb(?:\+srv)?:\/\/[^@/]*:(?!\*\*\*@)[^@/]*@/i;

/** Query parameters that carry secrets (see redact.ts). */
const SECRET_QUERY_PARAMETER =
  /[?&](password|secret|token|aws_session_token|authmechanismproperties|tlscertificatekeyfilepassword)=(?!\*\*\*)/i;

/** The JSON shape of an error printed with --json. */
export interface JsonError {
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly hint?: string;
    readonly docsUrl: string;
    readonly exitCode: number;
  };
}

/**
 * Prints `error` and returns the exit code to use. Unknown errors become
 * MS_INTERNAL: they are bugs, so the hint asks for a report.
 */
export function reportError(error: unknown, out: Output, secrets: readonly string[]): number {
  const known = toMongoShieldError(error);
  const scrub = (text: string): string => scrubSecrets(text, secrets);

  if (out.settings.json) {
    const payload: JsonError = {
      error: {
        code: known.code,
        message: scrub(known.message),
        ...(known.hint ? { hint: scrub(known.hint) } : {}),
        docsUrl: known.docsUrl,
        exitCode: known.exitCode,
      },
    };
    out.json(payload);
  } else {
    out.stderr(`${renderHumanError(known, out, scrub)}\n`);
  }

  if (out.settings.verbose) out.stderr(`${scrub(renderStack(error))}\n`);
  return known.exitCode;
}

/** The three-line human error block. */
function renderHumanError(
  error: MongoShieldError,
  out: Output,
  scrub: (text: string) => string,
): string {
  const lines = [`${out.style(["red", "bold"], `✖ ${error.code}`)}  ${scrub(error.message)}`];
  if (error.hint) lines.push(`  ${out.style("dim", "hint")}  ${scrub(error.hint)}`);
  lines.push(`  ${out.style("dim", "docs")}  ${error.docsUrl}`);
  return lines.join("\n");
}

/** Wraps anything thrown into a MongoShieldError, keeping known ones as they are. */
export function toMongoShieldError(error: unknown): MongoShieldError {
  if (isMongoShieldError(error)) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new MongoShieldError(
    "MS_INTERNAL",
    `${ERROR_CODES.MS_INTERNAL.description} ${message}`.trim(),
    {
      cause: error,
      hint: `This is likely a bug. Please report it at ${ISSUES_URL} with the output of the same command run with --verbose.`,
    },
  );
}

/** The error and its causes with stack traces, for --verbose. */
function renderStack(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  // Cause chains are short in practice; the limit guards against cycles.
  for (let depth = 0; depth < 8 && current !== undefined; depth++) {
    const prefix = depth === 0 ? "" : "caused by: ";
    if (current instanceof Error) {
      parts.push(`${prefix}${current.stack ?? `${current.name}: ${current.message}`}`);
      current = current.cause;
    } else {
      parts.push(`${prefix}${String(current)}`);
      current = undefined;
    }
  }
  return parts.join("\n");
}

/** Removes known secrets and passwords in connection strings from `text`. */
export function scrubSecrets(text: string, secrets: readonly string[]): string {
  const withoutUriPasswords = text.replace(MONGO_URI_IN_TEXT, redactEmbeddedUri);
  return redactSecrets(withoutUriPasswords, secrets);
}

/**
 * Redacts one connection string found in text. Messages from the library are
 * already redacted; re-redacting would re-encode their query strings, so only
 * URIs that still hold a secret are touched. Trailing punctuation (`uri: …`)
 * is not part of the URI.
 */
function redactEmbeddedUri(match: string): string {
  const trailing = /[:;,.)\]]+$/.exec(match)?.[0] ?? "";
  const uri = match.slice(0, match.length - trailing.length);
  const holdsSecret = UNREDACTED_PASSWORD.test(uri) || SECRET_QUERY_PARAMETER.test(uri);
  return `${holdsSecret ? redactMongoUri(uri) : uri}${trailing}`;
}
