/**
 * Helpers that keep secrets out of logs, errors, events and manifests.
 */

const MONGO_URI_CREDENTIALS = /^(mongodb(?:\+srv)?:\/\/)([^@/]+)@/i;
const SENSITIVE_QUERY_KEYS = new Set([
  "password",
  "authmechanismproperties",
  "tlscertificatekeyfilepassword",
  "aws_session_token",
  "secret",
  "token",
]);

/** `mongodb://user:pass@host/db?x=1` → `mongodb://user:***@host/db?x=1`. */
export function redactMongoUri(uri: string): string {
  let redacted = uri.replace(MONGO_URI_CREDENTIALS, (_match, scheme: string, userinfo: string) => {
    const user = userinfo.split(":")[0] ?? "";
    return `${scheme}${user}:***@`;
  });

  const queryStart = redacted.indexOf("?");
  if (queryStart !== -1) {
    const base = redacted.slice(0, queryStart);
    const params = new URLSearchParams(redacted.slice(queryStart + 1));
    for (const key of [...params.keys()]) {
      if (SENSITIVE_QUERY_KEYS.has(key.toLowerCase())) params.set(key, "***");
    }
    redacted = `${base}?${params.toString()}`;
  }
  return redacted;
}

/** Replaces every occurrence of the given secrets in a string with `***`. */
export function redactSecrets(text: string, secrets: readonly (string | undefined)[]): string {
  let out = text;
  for (const secret of secrets) {
    if (secret && secret.length >= 4) out = out.split(secret).join("***");
  }
  return out;
}
