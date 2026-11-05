/**
 * Resolving `{ env: "NAME" }` and `{ file: "/path" }` in a config (see
 * `SecretReference` in schema.ts) into the values they point to.
 *
 *   notify: [{ type: "slack", url: { env: "SLACK_WEBHOOK_URL" } }],
 *   heartbeat: { file: "/run/secrets/heartbeat-url" },
 *
 * Notify and heartbeat URLs are passwords in all but name: whoever has a Slack
 * webhook URL can post to the channel, whoever has a healthchecks.io ping URL can
 * silence the alarm. A JSON config cannot read `process.env`, and the Helm chart
 * and the operator put the config in a ConfigMap that anyone in the namespace may
 * read, so the URL must be able to come from somewhere else.
 *
 * `loadConfig` (load.ts) runs this on the merged config before validating it, so
 * the schema itself only ever sees plain strings. Error messages name the variable
 * or the file, never the value.
 */

import { readFile } from "node:fs/promises";
import { MongoShieldError } from "../errors.ts";

/** Largest secret file read: a URL is short, so a big file is the wrong file. */
const MAX_SECRET_FILE_BYTES = 64 * 1024;

/**
 * Returns `config` with every secret reference in `notify[].url` and `heartbeat`
 * replaced by its value. Anything else, including values that are not references,
 * is returned unchanged for the schema to check.
 *
 * @throws MongoShieldError `MS_CONFIG_INVALID` for a variable that is not set or a
 *   file that cannot be read.
 */
export async function resolveSecretReferences(
  config: unknown,
  env: NodeJS.ProcessEnv,
): Promise<unknown> {
  if (!isRecord(config)) return config;
  const resolved: Record<string, unknown> = { ...config };

  if (isSecretReference(config.heartbeat)) {
    resolved.heartbeat = await readReference(config.heartbeat, "heartbeat", env);
  }
  if (Array.isArray(config.notify)) {
    const targets: unknown[] = [];
    for (const [index, target] of config.notify.entries()) {
      if (isRecord(target) && isSecretReference(target.url)) {
        const where = `notify[${index}].url`;
        targets.push({ ...target, url: await readReference(target.url, where, env) });
      } else {
        targets.push(target);
      }
    }
    resolved.notify = targets;
  }
  return resolved;
}

/** An object with exactly one string field, `env` or `file`. */
type Reference = { readonly env: string } | { readonly file: string };

/** True for `{ env: "…" }` or `{ file: "…" }` and nothing else. */
function isSecretReference(value: unknown): value is Reference {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value);
  if (keys.length !== 1) return false;
  return (
    (keys[0] === "env" && typeof value.env === "string") ||
    (keys[0] === "file" && typeof value.file === "string")
  );
}

/** Reads one reference; `where` names the config field for error messages. */
async function readReference(
  reference: Reference,
  where: string,
  env: NodeJS.ProcessEnv,
): Promise<string> {
  if ("env" in reference) {
    const value = env[reference.env]?.trim();
    if (!value) {
      throw new MongoShieldError(
        "MS_CONFIG_INVALID",
        `${where} comes from the environment variable ${reference.env}, which is not set.`,
        { hint: `Set ${reference.env}, or remove ${where} from the config.` },
      );
    }
    return value;
  }
  return readSecretFile(reference.file, where);
}

/** Reads a secret file, trimmed. Never puts its content into an error. */
async function readSecretFile(path: string, where: string): Promise<string> {
  let bytes: Buffer;
  try {
    bytes = await readFile(path);
  } catch (error) {
    throw new MongoShieldError(
      "MS_CONFIG_INVALID",
      `${where} comes from the file ${path}, which cannot be read.`,
      { cause: error, hint: "Check that the file (e.g. a mounted Secret) exists and is readable." },
    );
  }
  const value = bytes.length > MAX_SECRET_FILE_BYTES ? "" : bytes.toString("utf8").trim();
  if (!value) {
    throw new MongoShieldError(
      "MS_CONFIG_INVALID",
      `${where} comes from the file ${path}, which is empty or too large to hold a URL.`,
      { hint: "Put just the URL in the file." },
    );
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
