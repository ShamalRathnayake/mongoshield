/**
 * Redacted previews of secrets, and scrubbing of error text.
 *
 * The API never returns a stored secret. Where the UI needs to show *which*
 * secret is configured, it gets a preview made here: a MongoDB URI without its
 * password, a webhook URL reduced to its origin, credential names without values.
 *
 * URI redaction and secret replacement come from the library (`redactMongoUri`,
 * `redactSecrets`), so the console and the CLI redact exactly alike. The console
 * adds `scrubText`, which also finds URIs in the middle of a message (driver
 * errors quote them anywhere, while `redactMongoUri` expects a whole URI).
 */

import { redactMongoUri, redactSecrets } from "mongoshield";

/** Any MongoDB URI with userinfo, anywhere in a text (for scrubbing error messages). */
const MONGO_URI_ANYWHERE = /(mongodb(?:\+srv)?:\/\/)([^@/\s"']+)@/gi;

/**
 * Connection string options that carry secrets (names lower-cased). The library's
 * `redactMongoUri` (src/redact.ts in `mongoshield`) scrubs most of them but does not
 * export its list, and older versions miss `proxyPassword`; the console keeps its own
 * here, for config import (which refuses them in documents) and the connection preview.
 */
export const SECRET_URI_OPTIONS: ReadonlySet<string> = new Set([
  "password",
  "proxypassword",
  "authmechanismproperties",
  "tlscertificatekeyfilepassword",
  "aws_session_token",
  "secret",
  "token",
]);

/**
 * A connection string preview with the value of every secret option (see
 * {@link SECRET_URI_OPTIONS}) replaced by `***`. Applied to stored previews when they
 * are shown, so previews saved by an older version (with `proxyPassword` in clear) are
 * covered too.
 */
export function redactSecretUriOptions(uri: string): string {
  const queryStart = uri.indexOf("?");
  if (queryStart === -1) return uri;
  const query = uri
    .slice(queryStart + 1)
    .split("&")
    .map((pair) => {
      const separator = pair.indexOf("=");
      if (separator === -1) return pair;
      const name = pair.slice(0, separator);
      return SECRET_URI_OPTIONS.has(safeDecode(name).toLowerCase()) ? `${name}=***` : pair;
    })
    .join("&");
  return `${uri.slice(0, queryStart)}?${query}`;
}

/**
 * The stored preview of a connection string: the library's `redactMongoUri` (password
 * and secret options), then {@link redactSecretUriOptions} for what it may miss.
 */
export function previewConnectionUri(uri: string): string {
  return redactSecretUriOptions(redactMongoUri(uri));
}

/**
 * A storage URL as shown to people: the query string of an `endpoint=` parameter is
 * replaced by `***`, because it may be an Azure SAS token saved before such endpoints
 * were refused (src/jobs/storage.ts). Anything that does not parse is shown as is.
 */
export function redactStorageUrl(url: string): string {
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(url) || !url.includes("?")) return url;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  const endpoint = parsed.searchParams.get("endpoint");
  const queryAt = endpoint?.indexOf("?") ?? -1;
  if (endpoint === null || queryAt === -1) return url;
  parsed.searchParams.set("endpoint", `${endpoint.slice(0, queryAt)}?***`);
  return parsed.toString();
}

/** `decodeURIComponent`, or the input when it is not valid percent-encoding. */
function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** `https://hooks.slack.com/services/T0/B0/xyz` → `https://hooks.slack.com/***`. */
export function redactUrlToOrigin(url: string): string {
  try {
    return `${new URL(url).origin}/***`;
  } catch {
    return "***";
  }
}

/**
 * Removes credentials from free text (error messages from drivers and SDKs),
 * and replaces each known secret with `***`. Defense in depth: the library
 * already keeps secrets out of its messages, but third-party errors may not.
 */
export function scrubText(text: string, secrets: readonly string[] = []): string {
  const out = text.replace(MONGO_URI_ANYWHERE, (_match, scheme: string, userinfo: string) => {
    const user = userinfo.split(":")[0] ?? "";
    return `${scheme}${user}:***@`;
  });
  // Very short "secrets" would turn ordinary words into *** (the library skips them).
  return redactSecrets(out, secrets);
}
