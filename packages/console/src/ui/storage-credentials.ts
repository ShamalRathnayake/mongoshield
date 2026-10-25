/**
 * Storage credentials as named form fields: the pure logic behind the storage dialog's
 * "Credentials" section (pages/storage-form.tsx).
 *
 * The server stores credentials as environment-style pairs, encrypted, and accepts only
 * these names per URL scheme (`CREDENTIAL_NAMES` in src/jobs/storage.ts):
 *
 *   s3://    AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_SESSION_TOKEN
 *   gs://    GOOGLE_CREDENTIALS_JSON (a service account key file, as JSON)
 *   az://    AZURE_STORAGE_CONNECTION_STRING
 *   sftp://  SFTP_PRIVATE_KEY, SFTP_PASSPHRASE
 *   local    none
 *
 * Instead of typing those names, people pick HOW the location authenticates (a radio
 * choice) and fill in named fields; `buildCredentials` turns that into the pairs. The
 * choices are:
 *
 *   keep           editing only: send nothing, the server keeps what it stores
 *   environment    store nothing: the console's own environment is used (an IAM role,
 *                  workload identity, `az login`, the console's SSH agent…)
 *   keys / serviceAccount / accountKey / connectionString / sshKey
 *                  the provider's usual secret, in named fields
 *   lines          KEY=value lines, as the old free-text box took them (advanced)
 *
 * Pure functions, unit-tested in storage-credentials.test.ts.
 */

import type { StorageScheme } from "./storage-url.ts";

/** How a storage location authenticates (see the file header). */
export type CredentialMethod =
  | "keep"
  | "environment"
  | "keys"
  | "serviceAccount"
  | "accountKey"
  | "connectionString"
  | "sshKey"
  | "lines";

/** The values typed into the credential fields (only the chosen method's are used). */
export interface CredentialValues {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly sessionToken: string;
  readonly serviceAccountJson: string;
  readonly accountKey: string;
  readonly connectionString: string;
  readonly privateKey: string;
  readonly keyPassphrase: string;
  readonly lines: string;
}

/** Nothing typed yet. */
export const EMPTY_CREDENTIALS: CredentialValues = {
  accessKeyId: "",
  secretAccessKey: "",
  sessionToken: "",
  serviceAccountJson: "",
  accountKey: "",
  connectionString: "",
  privateKey: "",
  keyPassphrase: "",
  lines: "",
};

/** The credential names the server accepts per scheme (see the file header). */
export const CREDENTIAL_NAMES: Readonly<Record<StorageScheme, readonly string[]>> = {
  s3: ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN"],
  gs: ["GOOGLE_CREDENTIALS_JSON"],
  az: ["AZURE_STORAGE_CONNECTION_STRING"],
  sftp: ["SFTP_PRIVATE_KEY", "SFTP_PASSPHRASE"],
  file: [],
  memory: [],
  // A scheme the console does not know: the server will refuse it anyway; let people
  // type whatever they need in the KEY=value box.
  unknown: [],
};

/** One choice of the "How does the console sign in?" radio group. */
export interface CredentialMethodOption {
  readonly value: CredentialMethod;
  readonly label: string;
  readonly description: string;
}

/** What "the console's environment" means for each provider. */
const ENVIRONMENT_DESCRIPTIONS: Partial<Record<StorageScheme, string>> = {
  s3: "Nothing is stored. The AWS SDK uses the console's environment: AWS_* variables, a profile, or the IAM role of the machine (instance profile, IRSA).",
  gs: "Nothing is stored. Application Default Credentials of the console: GOOGLE_APPLICATION_CREDENTIALS, workload identity or the metadata server.",
  az: "Nothing is stored. Microsoft Entra ID through the console's environment: AZURE_CLIENT_ID/…, managed or workload identity, or az login.",
  sftp: "Nothing is stored. The key file in MONGOSHIELD_SFTP_KEY_FILE or the SSH agent of the console; without a fingerprint the host must be in its known_hosts.",
  unknown: "Nothing is stored.",
};

/** The provider-specific ways to sign in, per scheme, most common first. */
const PROVIDER_METHODS: Partial<Record<StorageScheme, readonly CredentialMethodOption[]>> = {
  s3: [
    {
      value: "keys",
      label: "Access keys",
      description: "An access key ID and secret, stored encrypted.",
    },
  ],
  gs: [
    {
      value: "serviceAccount",
      label: "Service account key",
      description: "The JSON key file of a service account, stored encrypted.",
    },
  ],
  az: [
    {
      value: "accountKey",
      label: "Account key",
      description: "One of the storage account's access keys, stored encrypted.",
    },
    {
      value: "connectionString",
      label: "Connection string",
      description: "A full connection string (e.g. with a SAS token), stored encrypted.",
    },
  ],
  sftp: [
    {
      value: "sshKey",
      label: "Private key",
      description:
        "An SSH private key (and its passphrase), stored encrypted. Passwords are not supported.",
    },
  ],
};

/**
 * The sign-in choices for a scheme. `stored` is the summary of the credentials the
 * server already has (`StorageView.credentials.preview`), or undefined when there are
 * none or they cannot be kept (the scheme changed): only then is "keep" offered.
 * Schemes that take no credentials (local folders) have no choices at all.
 */
export function credentialMethodsFor(
  scheme: StorageScheme,
  stored: string | undefined,
): CredentialMethodOption[] {
  if (scheme === "file" || scheme === "memory") return [];
  const options: CredentialMethodOption[] = [];
  if (stored !== undefined) {
    options.push({
      value: "keep",
      label: "Keep the stored credentials",
      description: `Stored: ${stored}. Nothing is changed.`,
    });
  }
  options.push(...(PROVIDER_METHODS[scheme] ?? []));
  options.push({
    value: "environment",
    label: "The console's environment",
    description: ENVIRONMENT_DESCRIPTIONS[scheme] ?? "Nothing is stored.",
  });
  const names = CREDENTIAL_NAMES[scheme];
  options.push({
    value: "lines",
    label: "KEY=value lines (advanced)",
    description:
      names.length > 0
        ? `Paste environment-style pairs: ${names.join(", ")}.`
        : "Paste environment-style pairs, one per line.",
  });
  return options;
}

/** The choice preselected for a scheme: keep what is stored, else the provider's usual secret. */
export function defaultCredentialMethod(
  scheme: StorageScheme,
  stored: string | undefined,
): CredentialMethod | undefined {
  return credentialMethodsFor(scheme, stored)[0]?.value;
}

/** Most credentials the server stores for one location. */
const MAX_CREDENTIAL_ENTRIES = 10;

/**
 * Parses `KEY=value` lines into credentials. Returns an error message for a bad line.
 * Blank lines and `#` comments are ignored so people can paste a .env snippet.
 */
export function parseCredentials(text: string): Record<string, string> | string {
  const credentials: Record<string, string> = {};
  const lines = text.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = (lines[index] ?? "").trim();
    if (line === "" || line.startsWith("#")) continue;
    const equals = line.indexOf("=");
    if (equals <= 0) return `Line ${index + 1} is not KEY=value.`;
    credentials[line.slice(0, equals).trim()] = line.slice(equals + 1).trim();
  }
  return credentials;
}

/**
 * An Azure connection string for an account key. A custom endpoint (Azurite, a
 * sovereign cloud) becomes `BlobEndpoint`, otherwise the public cloud's suffix is used.
 */
export function azureConnectionString(account: string, key: string, endpoint: string): string {
  if (endpoint !== "") {
    const protocol = endpoint.startsWith("http://") ? "http" : "https";
    return `DefaultEndpointsProtocol=${protocol};AccountName=${account};AccountKey=${key};BlobEndpoint=${endpoint}`;
  }
  return `DefaultEndpointsProtocol=https;AccountName=${account};AccountKey=${key};EndpointSuffix=core.windows.net`;
}

/** The `AccountName=` of a connection string, or undefined when it has none (SAS-only strings). */
function accountNameOf(connectionString: string): string | undefined {
  return /(?:^|;)\s*AccountName=([^;]*)/i.exec(connectionString)?.[1]?.trim();
}

/** What the credentials need to know about the location (Azure builds on its account). */
export interface CredentialContext {
  readonly scheme: StorageScheme;
  /** Azure: the storage account of the location ("" when unknown). */
  readonly account: string;
  /** Azure: the custom endpoint of the location ("" for the public cloud). */
  readonly endpoint: string;
}

/** The result of `buildCredentials`: what to send, or the problems per field. */
export type CredentialsResult =
  | {
      readonly ok: true;
      /** The pairs to send; undefined = send nothing and keep the stored ones. */
      readonly credentials: Readonly<Record<string, string>> | undefined;
    }
  | { readonly ok: false; readonly errors: Partial<Record<keyof CredentialValues, string>> };

/**
 * Turns the chosen method and the typed values into the pairs the server stores, or
 * says which fields are missing or wrong. Values are trimmed; optional ones (session
 * token, key passphrase) are left out when empty.
 */
export function buildCredentials(
  method: CredentialMethod | undefined,
  values: CredentialValues,
  context: CredentialContext,
): CredentialsResult {
  const errors: Partial<Record<keyof CredentialValues, string>> = {};
  /** A finished result: the pairs, unless a field had a problem. */
  const done = (credentials: Record<string, string>): CredentialsResult =>
    Object.keys(errors).length > 0 ? { ok: false, errors } : { ok: true, credentials };

  switch (method) {
    case "keep":
      return { ok: true, credentials: undefined };
    // No method (local folders) and "environment" both store nothing; an empty map
    // also clears whatever was stored before.
    case undefined:
    case "environment":
      return { ok: true, credentials: {} };
    case "keys": {
      const accessKeyId = values.accessKeyId.trim();
      const secretAccessKey = values.secretAccessKey.trim();
      const sessionToken = values.sessionToken.trim();
      if (accessKeyId === "") errors.accessKeyId = "Enter the access key ID.";
      if (secretAccessKey === "") errors.secretAccessKey = "Enter the secret access key.";
      return done({
        AWS_ACCESS_KEY_ID: accessKeyId,
        AWS_SECRET_ACCESS_KEY: secretAccessKey,
        ...(sessionToken === "" ? {} : { AWS_SESSION_TOKEN: sessionToken }),
      });
    }
    case "serviceAccount": {
      const json = values.serviceAccountJson.trim();
      if (json === "")
        errors.serviceAccountJson = "Paste the service account key, or choose its file.";
      else if (!isJsonObject(json)) {
        errors.serviceAccountJson =
          "This is not a JSON key file. Paste the whole file, from { to }.";
      }
      return done({ GOOGLE_CREDENTIALS_JSON: json });
    }
    case "accountKey": {
      const key = values.accountKey.trim();
      if (key === "") errors.accountKey = "Enter one of the storage account's access keys.";
      else if (context.account === "") errors.accountKey = "Enter the storage account above first.";
      return done({
        AZURE_STORAGE_CONNECTION_STRING: azureConnectionString(
          context.account,
          key,
          context.endpoint,
        ),
      });
    }
    case "connectionString": {
      const connectionString = values.connectionString.trim();
      const account = accountNameOf(connectionString);
      if (connectionString === "") errors.connectionString = "Paste the connection string.";
      else if (!/(AccountName|BlobEndpoint|SharedAccessSignature)=/i.test(connectionString)) {
        errors.connectionString =
          "This does not look like a connection string (AccountName=…;AccountKey=…).";
      } else if (account !== undefined && context.account !== "" && account !== context.account) {
        // The library refuses this too: it would silently write to another account.
        errors.connectionString = `This connection string is for the account “${account}”, not “${context.account}”.`;
      }
      return done({ AZURE_STORAGE_CONNECTION_STRING: connectionString });
    }
    case "sshKey": {
      const privateKey = values.privateKey.trim();
      const passphrase = values.keyPassphrase;
      if (privateKey === "") errors.privateKey = "Paste the private key, or choose its file.";
      else if (!/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(privateKey)) {
        errors.privateKey =
          "Paste the whole private key, including the -----BEGIN … PRIVATE KEY----- line.";
      }
      return done({
        // Key files end with a newline; some parsers insist on it.
        SFTP_PRIVATE_KEY: `${privateKey}\n`,
        ...(passphrase === "" ? {} : { SFTP_PASSPHRASE: passphrase }),
      });
    }
    case "lines": {
      const parsed = parseCredentials(values.lines);
      if (typeof parsed === "string") {
        errors.lines = parsed;
        return { ok: false, errors };
      }
      const names = Object.keys(parsed);
      // Nothing typed would silently clear the stored credentials: that is what "the
      // console's environment" is for, so say so instead.
      if (names.length === 0) {
        errors.lines =
          "Enter at least one KEY=value line, or sign in with the console's environment instead.";
        return { ok: false, errors };
      }
      // "KEY=" with nothing after it is a half-pasted line, not a credential.
      const empty = names.find((name) => parsed[name] === "");
      if (empty !== undefined) {
        errors.lines = `“${empty}” has no value after the “=”.`;
        return { ok: false, errors };
      }
      if (names.length > MAX_CREDENTIAL_ENTRIES) {
        errors.lines = `Use at most ${MAX_CREDENTIAL_ENTRIES} credentials.`;
        return { ok: false, errors };
      }
      const allowed = CREDENTIAL_NAMES[context.scheme];
      const unknown = names.find((name) => !allowed.includes(name));
      // Only checked for schemes the console knows; the server checks the rest.
      if (unknown !== undefined && allowed.length > 0) {
        errors.lines = `“${unknown}” is not a credential for this storage. Use ${allowed.join(", ")}.`;
      }
      return done(parsed);
    }
  }
}

/** True when `text` is a JSON object (a key file), not an array, string or garbage. */
function isJsonObject(text: string): boolean {
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === "object" && value !== null && !Array.isArray(value);
  } catch {
    return false;
  }
}
