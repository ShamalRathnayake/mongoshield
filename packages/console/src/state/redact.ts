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

import { redactSecrets } from "mongoshield";

/** Any MongoDB URI with userinfo, anywhere in a text (for scrubbing error messages). */
const MONGO_URI_ANYWHERE = /(mongodb(?:\+srv)?:\/\/)([^@/\s"']+)@/gi;

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
