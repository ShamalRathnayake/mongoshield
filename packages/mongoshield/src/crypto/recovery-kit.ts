/**
 * The recovery kit: a passphrase-protected copy of the backup secret key(s), kept
 * next to the backups so that losing the laptop that ran `mongoshield init` does
 * not mean losing every backup.
 *
 *   await writeRecoveryKit(storage, { identity, passphrase });          // init
 *   const identities = await readRecoveryKit(storage, { passphrase });  // restore
 *
 * What it is (docs/specs/ENCRYPTION.md, "Recovery kit"):
 * - One object at the fixed key `_state/recovery-kit.age` in the storage location's
 *   root. `_state/` is where MongoShield keeps its own objects outside `backups/`,
 *   so catalogs, retention and old readers never look at it.
 * - A standard age file encrypted with a passphrase (one scrypt stanza, work factor
 *   18 by default, like `age -p`). Its plaintext is an age identity file: `#`
 *   comment lines and one `AGE-SECRET-KEY-1…` line per key. So it opens without
 *   MongoShield: `age -d -o mongoshield.key recovery-kit.age`.
 * - Writing a kit where one exists adds the new key to the keys already in it
 *   (which needs the existing kit's passphrase), so a second `init` never makes
 *   older backups unrecoverable from the kit.
 *
 * It is optional and additive: no backup depends on it, and the backup format does
 * not change. The passphrase never appears in an error or log line.
 */

import { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { MongoShieldError, throwIfAborted } from "../errors.ts";
import type { StorageAdapter } from "../storage/types.ts";
import { createDecryptStream } from "./decrypt.ts";
import { createEncryptStream } from "./encrypt.ts";
import { assertValidIdentity, identityToRecipient, parseIdentityFile } from "./keys.ts";

/** Where the kit lives, relative to the storage location's root. */
export const RECOVERY_KIT_KEY = "_state/recovery-kit.age";

/** Environment variable `restore` (and `init`) read the kit passphrase from. */
export const RECOVERY_PASSPHRASE_ENV = "MONGOSHIELD_RECOVERY_PASSPHRASE";

/**
 * Shortest passphrase accepted for a new kit. The kit sits in cloud storage, where
 * anyone who gets the file can try passphrases offline; scrypt slows that down, a
 * long passphrase is what actually stops it.
 */
export const MIN_RECOVERY_PASSPHRASE_LENGTH = 12;

/** A kit is a few hundred bytes; anything far larger is not one. */
const MAX_KIT_BYTES = 64 * 1024;

/** Options for {@link writeRecoveryKit}. */
export interface WriteRecoveryKitOptions {
  /** The secret key to protect, `AGE-SECRET-KEY-1…`. */
  readonly identity: string;
  /** The kit passphrase, at least {@link MIN_RECOVERY_PASSPHRASE_LENGTH} characters. */
  readonly passphrase: string;
  /** log2 of the scrypt cost; default 18 (as the `age` CLI). Tests lower it. */
  readonly scryptWorkFactor?: number;
  readonly signal?: AbortSignal;
}

/** What {@link writeRecoveryKit} wrote. */
export interface RecoveryKitWritten {
  /** The storage key, {@link RECOVERY_KIT_KEY}. */
  readonly key: string;
  /** How many keys the kit holds now (more than one after repeated inits). */
  readonly identities: number;
}

/** Options for {@link readRecoveryKit}. */
export interface ReadRecoveryKitOptions {
  readonly passphrase: string;
  readonly signal?: AbortSignal;
}

/** True when the storage location has a recovery kit. */
export async function hasRecoveryKit(
  storage: StorageAdapter,
  options: { readonly signal?: AbortSignal } = {},
): Promise<boolean> {
  const info = await storage.head(
    RECOVERY_KIT_KEY,
    options.signal ? { signal: options.signal } : {},
  );
  return info !== undefined;
}

/**
 * Writes (or extends) the kit. An existing kit must open with `passphrase`; its keys
 * are kept and `identity` is added, so the kit always covers every key it ever held.
 */
export async function writeRecoveryKit(
  storage: StorageAdapter,
  options: WriteRecoveryKitOptions,
): Promise<RecoveryKitWritten> {
  const { identity, passphrase, signal } = options;
  throwIfAborted(signal);
  assertValidIdentity(identity);
  if (passphrase.length < MIN_RECOVERY_PASSPHRASE_LENGTH) {
    throw new MongoShieldError(
      "MS_CONFIG_INVALID",
      `The recovery kit passphrase must have at least ${MIN_RECOVERY_PASSPHRASE_LENGTH} characters.`,
      {
        hint: "Use a long passphrase, for example four or five random words, and keep it in a password manager.",
      },
    );
  }

  const existing = await readRecoveryKit(storage, {
    passphrase,
    ...(signal ? { signal } : {}),
  }).catch((error: unknown) => {
    if (error instanceof MongoShieldError && error.code === "MS_DECRYPTION_FAILED") {
      throw new MongoShieldError(
        "MS_DECRYPTION_FAILED",
        `A recovery kit already exists at ${storage.location}${RECOVERY_KIT_KEY} and does not open with this passphrase.`,
        {
          cause: error,
          hint:
            "Enter the passphrase of the existing kit: the new key is added to it, so older backups stay recoverable. " +
            "If you no longer need the old keys, delete the kit first.",
        },
      );
    }
    throw error;
  });

  const identities = [...(existing ?? [])];
  if (!identities.includes(identity)) identities.push(identity);
  const plaintext = kitText(identities);
  const encrypted = await encryptToBuffer(plaintext, passphrase, options.scryptWorkFactor);
  await storage.put(RECOVERY_KIT_KEY, encrypted, {
    contentType: "application/octet-stream",
    ...(signal ? { signal } : {}),
  });
  return { key: RECOVERY_KIT_KEY, identities: identities.length };
}

/**
 * Opens the kit and returns its keys, or `undefined` when there is no kit. A wrong
 * passphrase fails with MS_DECRYPTION_FAILED.
 */
export async function readRecoveryKit(
  storage: StorageAdapter,
  options: ReadRecoveryKitOptions,
): Promise<string[] | undefined> {
  const { signal } = options;
  const signalOption = signal ? { signal } : {};
  const info = await storage.head(RECOVERY_KIT_KEY, signalOption);
  if (info === undefined) return undefined;
  if (info.size > MAX_KIT_BYTES) {
    throw new MongoShieldError(
      "MS_INTEGRITY_FAILED",
      `${storage.location}${RECOVERY_KIT_KEY} is ${info.size} bytes, far too large to be a recovery kit.`,
    );
  }
  const chunks: Buffer[] = [];
  try {
    await pipeline(
      await storage.get(RECOVERY_KIT_KEY, signalOption),
      createDecryptStream({ passphrase: options.passphrase }),
      collectInto(chunks),
      signalOption,
    );
  } catch (error) {
    // A wrong passphrase surfaces as MS_NO_IDENTITY (no stanza opens); both mean
    // "this passphrase does not open the kit". Storage errors pass through.
    const wrongKey =
      error instanceof MongoShieldError &&
      (error.code === "MS_DECRYPTION_FAILED" || error.code === "MS_NO_IDENTITY");
    if (error instanceof MongoShieldError && !wrongKey) throw error;
    throw new MongoShieldError(
      "MS_DECRYPTION_FAILED",
      `Could not open the recovery kit at ${storage.location}${RECOVERY_KIT_KEY}.`,
      {
        cause: error,
        hint: "Check the recovery kit passphrase (MONGOSHIELD_RECOVERY_PASSPHRASE).",
      },
    );
  }
  return parseIdentityFile(Buffer.concat(chunks).toString("utf8"));
}

/** The kit's plaintext: an age identity file with one comment per key. */
function kitText(identities: readonly string[]): string {
  const lines = [
    "# MongoShield recovery kit: the secret keys that decrypt the backups stored next to it.",
    "# Decrypt this file with `age -d` and its passphrase; never store the result next to the backups.",
    `# updated: ${new Date().toISOString()}`,
  ];
  for (const identity of identities) {
    lines.push(`# public key: ${identityToRecipient(identity)}`, identity);
  }
  return `${lines.join("\n")}\n`;
}

/** Encrypts a small text with a passphrase into a buffer (a kit is tiny). */
async function encryptToBuffer(
  text: string,
  passphrase: string,
  scryptWorkFactor: number | undefined,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  await pipeline(
    Readable.from([Buffer.from(text, "utf8")]),
    createEncryptStream({
      passphrase,
      ...(scryptWorkFactor === undefined ? {} : { scryptWorkFactor }),
    }),
    collectInto(chunks),
  );
  return Buffer.concat(chunks);
}

/** A writable that keeps every chunk, for small payloads only. */
function collectInto(chunks: Buffer[]): Writable {
  return new Writable({
    write(chunk: Buffer, _encoding, callback) {
      chunks.push(chunk);
      callback();
    },
  });
}
