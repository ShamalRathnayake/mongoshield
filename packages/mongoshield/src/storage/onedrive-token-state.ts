/**
 * Keeping the newest OneDrive refresh token across runs, and warning before the
 * sign-in runs out.
 *
 * ## The problem
 *
 * Microsoft refresh tokens last 90 days from the moment they are issued, even when
 * they are used every day, and every refresh returns a new one (with a new 90 days).
 * A nightly GitHub Actions job that always starts from the same repository secret
 * therefore stops working on day 90, although it refreshed hundreds of times.
 *
 * ## The fix
 *
 * After every refresh the newest refresh token is written to a small *token state*
 * file (`MONGOSHIELD_ONEDRIVE_TOKEN_STATE`), and the next run starts from it instead
 * of the secret. The GitHub Action restores that file from the Actions cache before
 * the run and saves it after (action/action.yml), so the chain of tokens never breaks.
 *
 * The file is encrypted with AES-256-GCM under a key derived (HKDF-SHA256) from the
 * secret's value, so the cache only ever holds ciphertext, and nobody without the
 * secret can read the token or plant a different one: a state file that does not
 * decrypt with the current secret (tampered, or left over from an older sign-in) is
 * ignored and replaced. Replacing the secret after a new login therefore resets the
 * chain automatically.
 *
 * File layout (JSON, mode 0600, written atomically: temp file + rename):
 *
 *   { "format": "mongoshield-onedrive-token-state", "version": 1,
 *     "iv": <12 bytes, base64>, "tag": <16 bytes, base64>, "ciphertext": <base64> }
 *
 * The plaintext is JSON: `{ refreshToken, issuedAt, originalIssuedAt? }` (ISO times),
 * `issuedAt` being when the token in the file was issued.
 *
 * ## The day-75 warning
 *
 * `warnings()` reports when the refresh token a run *started from* is 75 days old or
 * more: the state file's token when one was carried over, otherwise the secret's
 * (whose issue time is inside the `onedrive1.` envelope). With working rotation that
 * token is never older than the gap between two runs, so the warning only appears
 * when rotation is not persisted: no state file configured, or the file is not
 * carried from one run to the next (a cache that never restores).
 */

import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import { mkdir, open, readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { abortError, isMongoShieldError, MongoShieldError } from "../errors.ts";
import { renameWithRetry } from "../util/rename.ts";
import { messageOf, propertyOf, stringProperty } from "./adapter-utils.ts";
import {
  ONEDRIVE_SECRET_NAME,
  type OneDriveCredential,
  type OneDriveTenant,
  REFRESH_TOKEN_LIFETIME_DAYS,
  refreshOneDriveToken,
  SIGN_IN_EXPIRED_REASON,
} from "./onedrive-auth.ts";

/** The environment variable naming the token state file. */
export const ONEDRIVE_TOKEN_STATE_ENV = "MONGOSHIELD_ONEDRIVE_TOKEN_STATE";

/** Warnings start when the token a run started from is this many days old (15 days before expiry). */
export const TOKEN_WARNING_DAYS = 75;

const DAY_MS = 24 * 60 * 60 * 1000;

/** Marks the file as ours, so a wrong path fails clearly instead of being overwritten. */
const STATE_FORMAT = "mongoshield-onedrive-token-state";
const STATE_VERSION = 1;

/**
 * HKDF salt and info: fixed, public labels that tie the derived key to this one use.
 * The input key material is the secret's value, which is already high-entropy.
 */
const HKDF_SALT = "mongoshield/onedrive-token-state/v1";
const HKDF_INFO = "aes-256-gcm key";
/** Also authenticated (GCM additional data), so a ciphertext cannot be reused elsewhere. */
const ASSOCIATED_DATA = Buffer.from(`${STATE_FORMAT}/v${STATE_VERSION}`);
/** AES-GCM's standard 96-bit nonce; a random one per write. */
const IV_BYTES = 12;
const KEY_BYTES = 32;

/** Refresh this long before the access token's expiry, so a request never races it. */
const ACCESS_TOKEN_MARGIN_MS = 5 * 60 * 1000;

/** What the token state file holds (after decryption). */
export interface TokenState {
  /** The newest refresh token. Secret. */
  readonly refreshToken: string;
  /** When that token was issued. */
  readonly issuedAt: Date;
  /** When the secret's own token was issued, when known (for diagnostics). */
  readonly originalIssuedAt?: Date;
}

/** Derives the state file key from the secret's value (HKDF-SHA256, 32 bytes). */
export function deriveStateKey(secret: string): Buffer {
  return Buffer.from(hkdfSync("sha256", secret.trim(), HKDF_SALT, HKDF_INFO, KEY_BYTES));
}

/** Encrypts a state into the file's JSON text. */
export function encryptTokenState(state: TokenState, secret: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", deriveStateKey(secret), iv);
  cipher.setAAD(ASSOCIATED_DATA);
  const plaintext = JSON.stringify({
    refreshToken: state.refreshToken,
    issuedAt: state.issuedAt.toISOString(),
    ...(state.originalIssuedAt === undefined
      ? {}
      : { originalIssuedAt: state.originalIssuedAt.toISOString() }),
  });
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return `${JSON.stringify({
    format: STATE_FORMAT,
    version: STATE_VERSION,
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  })}\n`;
}

/**
 * Decrypts the file's JSON text. Returns `undefined` when it does not decrypt with
 * this secret (another sign-in's state, or tampered with) or is not a state file.
 */
export function decryptTokenState(text: string, secret: string): TokenState | undefined {
  let envelope: unknown;
  try {
    envelope = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (propertyOf(envelope, "format") !== STATE_FORMAT) return undefined;
  if (propertyOf(envelope, "version") !== STATE_VERSION) return undefined;
  const iv = stringProperty(envelope, "iv");
  const tag = stringProperty(envelope, "tag");
  const ciphertext = stringProperty(envelope, "ciphertext");
  if (iv === undefined || tag === undefined || ciphertext === undefined) return undefined;
  let plaintext: string;
  try {
    const decipher = createDecipheriv(
      "aes-256-gcm",
      deriveStateKey(secret),
      Buffer.from(iv, "base64"),
    );
    decipher.setAAD(ASSOCIATED_DATA);
    decipher.setAuthTag(Buffer.from(tag, "base64"));
    plaintext = Buffer.concat([
      decipher.update(Buffer.from(ciphertext, "base64")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    // Wrong key (a different secret) or modified bytes: GCM authentication failed.
    return undefined;
  }
  let payload: unknown;
  try {
    payload = JSON.parse(plaintext);
  } catch {
    return undefined;
  }
  const refreshToken = stringProperty(payload, "refreshToken");
  const issuedAt = dateProperty(payload, "issuedAt");
  if (refreshToken === undefined || refreshToken === "" || issuedAt === undefined) {
    return undefined;
  }
  const originalIssuedAt = dateProperty(payload, "originalIssuedAt");
  return {
    refreshToken,
    issuedAt,
    ...(originalIssuedAt === undefined ? {} : { originalIssuedAt }),
  };
}

/**
 * Reads the state file. A missing file, or one that does not decrypt with `secret`,
 * gives `undefined`. A file that is not a token state at all (a wrong path) throws,
 * so it is never overwritten by mistake.
 */
export async function readTokenState(
  path: string,
  secret: string,
): Promise<TokenState | undefined> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    // Missing, or a path that cannot exist (a parent is a file): no state yet. The
    // write after the next refresh then reports the problem as a warning.
    const code = propertyOf(error, "code");
    if (code === "ENOENT" || code === "ENOTDIR") return undefined;
    throw stateFileError(path, "read", error);
  }
  if (text.trim() === "") return undefined;
  let format: unknown;
  try {
    format = propertyOf(JSON.parse(text), "format");
  } catch {
    format = undefined;
  }
  if (format !== STATE_FORMAT) {
    throw new MongoShieldError(
      "MS_CONFIG_INVALID",
      `${ONEDRIVE_TOKEN_STATE_ENV} points at ${path}, which is not a MongoShield OneDrive token state file.`,
      { hint: "Point it at a file of its own (it is created on first use), or unset it." },
    );
  }
  return decryptTokenState(text, secret);
}

/** Writes the state file atomically (temp file in the same folder, then rename), mode 0600. */
export async function writeTokenState(
  path: string,
  secret: string,
  state: TokenState,
): Promise<void> {
  const text = encryptTokenState(state, secret);
  const directory = dirname(path);
  const temporary = join(
    directory,
    `.onedrive-token-${process.pid}-${randomBytes(6).toString("hex")}.tmp`,
  );
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(text, "utf8");
      // Flush before the rename, so a crash cannot leave an empty file in its place.
      await handle.sync();
    } finally {
      await handle.close();
    }
    await renameWithRetry(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw stateFileError(path, "write", error);
  }
}

function stateFileError(path: string, action: string, cause: unknown): MongoShieldError {
  return new MongoShieldError(
    "MS_STORAGE_IO",
    `Could not ${action} the OneDrive token state file ${path}: ${messageOf(cause)}`,
    { cause, hint: `Check ${ONEDRIVE_TOKEN_STATE_ENV} and the folder's permissions.` },
  );
}

function dateProperty(value: unknown, property: string): Date | undefined {
  const text = stringProperty(value, property);
  if (text === undefined) return undefined;
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

// ---------------------------------------------------------------------------
// The token source the adapter uses
// ---------------------------------------------------------------------------

/** Options for {@link createOneDriveTokenSource}. */
export interface OneDriveTokenSourceOptions {
  /** The secret's raw value (envelope or bare token); also the state file's key material. */
  readonly secret: string;
  /** The parsed secret. */
  readonly credential: OneDriveCredential;
  readonly clientId: string;
  readonly clientSecret?: string;
  readonly tenant: OneDriveTenant;
  /** The token state file, or undefined to not keep rotated tokens. */
  readonly statePath?: string;
  readonly fetch?: typeof fetch;
  readonly authorityUrl?: string;
  readonly now: () => Date;
}

/** Hands out access tokens, refreshing (and persisting the rotated refresh token) as needed. */
export interface OneDriveTokenSource {
  /**
   * A valid access token. `forceRefresh` gets a new one even if the cached one has
   * not expired (after Graph answered 401).
   */
  accessToken(options: { signal?: AbortSignal; forceRefresh?: boolean }): Promise<string>;
  /** Things worth fixing (the day-75 warning, a state file that could not be saved). */
  warnings(): readonly string[];
}

/** The refresh token currently in use and where it came from. */
interface CurrentRefreshToken {
  readonly refreshToken: string;
  /** Unknown only for a bare secret without a state file. */
  readonly issuedAt: Date | undefined;
  readonly source: "secret" | "state";
}

/** Creates the token source for one adapter. Nothing is read until the first request. */
export function createOneDriveTokenSource(
  options: OneDriveTokenSourceOptions,
): OneDriveTokenSource {
  const { credential, statePath, now } = options;
  let loaded: Promise<void> | undefined;
  let current: CurrentRefreshToken = {
    refreshToken: credential.refreshToken,
    issuedAt: credential.issuedAt,
    source: "secret",
  };
  /**
   * Issue time of the refresh token this run started from: the state file's when it
   * was carried over, else the secret's. With working rotation it is never older than
   * the gap between two runs, so its age is what the day-75 warning looks at.
   */
  let startIssuedAt: Date | undefined = credential.issuedAt;
  /** The secret's own issue time, or when this chain was first seen (bare tokens). */
  let originalIssuedAt: Date | undefined = credential.issuedAt;
  let saveProblem: string | undefined;
  let access: { token: string; expiresAt: number } | undefined;
  let refreshing: Promise<string> | undefined;

  /** Reads the state file once; its token, when it decrypts, replaces the secret's. */
  async function load(): Promise<void> {
    if (statePath === undefined) return;
    const state = await readTokenState(statePath, options.secret);
    if (state === undefined) return;
    current = { refreshToken: state.refreshToken, issuedAt: state.issuedAt, source: "state" };
    startIssuedAt = state.issuedAt;
    originalIssuedAt = state.originalIssuedAt ?? originalIssuedAt;
  }

  /** One refresh against Microsoft, falling back from the state's token to the secret's. */
  async function refresh(signal: AbortSignal | undefined): Promise<string> {
    loaded ??= load();
    await loaded;
    const startedAt = now();
    let result: Awaited<ReturnType<typeof refreshOneDriveToken>>;
    try {
      result = await refreshWith(current.refreshToken, signal);
    } catch (error) {
      // The state's token was refused (revoked, or the file is stale): the secret may
      // still be good, for example right after a new login replaced it.
      if (current.source !== "state" || !isSignInExpired(error)) throw error;
      current = {
        refreshToken: credential.refreshToken,
        issuedAt: credential.issuedAt,
        source: "secret",
      };
      result = await refreshWith(current.refreshToken, signal);
    }
    access = {
      token: result.accessToken,
      expiresAt: startedAt.getTime() + result.expiresInSeconds * 1000 - ACCESS_TOKEN_MARGIN_MS,
    };
    if (result.rotated) {
      current = { refreshToken: result.refreshToken, issuedAt: startedAt, source: current.source };
      await persist(current.refreshToken, startedAt);
    }
    return result.accessToken;
  }

  function refreshWith(refreshToken: string, signal: AbortSignal | undefined) {
    return refreshOneDriveToken({
      refreshToken,
      clientId: options.clientId,
      tenant: options.tenant,
      ...(options.clientSecret === undefined ? {} : { clientSecret: options.clientSecret }),
      ...(signal === undefined ? {} : { signal }),
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      ...(options.authorityUrl === undefined ? {} : { authorityUrl: options.authorityUrl }),
    });
  }

  /**
   * Saves the rotated token. A failed save is not fatal (this run has its access
   * token), but it is reported, because the next run will start from an older token.
   */
  async function persist(refreshToken: string, issuedAt: Date): Promise<void> {
    if (statePath === undefined) return;
    originalIssuedAt ??= issuedAt;
    try {
      await writeTokenState(statePath, options.secret, {
        refreshToken,
        issuedAt,
        ...(originalIssuedAt === undefined ? {} : { originalIssuedAt }),
      });
      saveProblem = undefined;
    } catch (error) {
      saveProblem = messageOf(error);
    }
  }

  return {
    async accessToken({ signal, forceRefresh = false }) {
      if (!forceRefresh && access !== undefined && now().getTime() < access.expiresAt) {
        return access.token;
      }
      // One refresh at a time: concurrent requests share it instead of each rotating
      // the token (which would leave all but one of the new refresh tokens unsaved).
      if (refreshing === undefined) {
        refreshing = refresh(signal).finally(() => {
          refreshing = undefined;
        });
      }
      try {
        return await refreshing;
      } catch (error) {
        if (signal?.aborted) throw abortError(signal);
        throw error;
      }
    },

    warnings() {
      const warnings: string[] = [];
      if (saveProblem !== undefined) {
        warnings.push(
          `The rotated OneDrive token could not be saved, so the next run starts from an older one: ${saveProblem}`,
        );
      }
      if (startIssuedAt !== undefined) {
        const ageDays = Math.floor((now().getTime() - startIssuedAt.getTime()) / DAY_MS);
        if (ageDays >= TOKEN_WARNING_DAYS) warnings.push(expiryWarning(ageDays, startIssuedAt));
      }
      return warnings;
    },
  };

  function expiryWarning(ageDays: number, issuedAt: Date): string {
    const expires = new Date(issuedAt.getTime() + REFRESH_TOKEN_LIFETIME_DAYS * DAY_MS);
    const keeping =
      statePath === undefined
        ? `Rotated tokens are not being kept: set ${ONEDRIVE_TOKEN_STATE_ENV} to a file that survives between runs (the MongoShield GitHub Action does this for onedrive:// storage through the Actions cache).`
        : "The saved token state is not being carried over between runs (check the Actions cache steps).";
    return (
      `The OneDrive sign-in in ${ONEDRIVE_SECRET_NAME} is ${ageDays} days old; Microsoft stops ` +
      `accepting it ${REFRESH_TOKEN_LIFETIME_DAYS} days after issue (${expires.toISOString().slice(0, 10)}). ` +
      `${keeping} Run \`npx mongoshield login onedrive\` and update the secret before then. ` +
      "See docs/guides/onedrive.md."
    );
  }
}

/** True for the error `refreshOneDriveToken` throws for an expired or revoked token. */
function isSignInExpired(error: unknown): boolean {
  return (
    isMongoShieldError(error, "MS_STORAGE_FORBIDDEN") &&
    error.details?.reason === SIGN_IN_EXPIRED_REASON
  );
}
