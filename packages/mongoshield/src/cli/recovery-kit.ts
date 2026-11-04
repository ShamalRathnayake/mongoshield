/**
 * The CLI side of the recovery kit (src/crypto/recovery-kit.ts): getting its
 * passphrase from the environment or the terminal, and letting `restore` fall back
 * to the kit when no other secret key was given.
 *
 * Passphrase sources, in order: MONGOSHIELD_RECOVERY_PASSPHRASE, then a hidden
 * prompt on a terminal. Without either, the command fails with a hint instead of
 * hanging, so scripts and CI get a clear error.
 */

import { isCancel, password } from "@clack/prompts";
import {
  hasRecoveryKit,
  MIN_RECOVERY_PASSPHRASE_LENGTH,
  RECOVERY_KIT_KEY,
  RECOVERY_PASSPHRASE_ENV,
  readRecoveryKit,
} from "../crypto/recovery-kit.ts";
import { MongoShieldError } from "../errors.ts";
import type { StorageAdapter } from "../storage/types.ts";
import type { DecryptionOptions } from "../types.ts";
import type { CommandContext } from "./command.ts";

/** Options for {@link askRecoveryPassphrase}. */
export interface AskRecoveryPassphraseOptions {
  /** Ask twice and require both to match (choosing a new passphrase). */
  readonly confirm: boolean;
  /** The prompt text. */
  readonly message: string;
}

/**
 * The kit passphrase: from MONGOSHIELD_RECOVERY_PASSPHRASE, else asked for on the
 * terminal. Remembered as a secret so no output line can show it.
 */
export async function askRecoveryPassphrase(
  context: CommandContext,
  options: AskRecoveryPassphraseOptions,
): Promise<string> {
  const fromEnv = context.io.env[RECOVERY_PASSPHRASE_ENV];
  if (fromEnv !== undefined && fromEnv !== "") {
    context.addSecret(fromEnv);
    return fromEnv;
  }
  if (!context.out.interactive) {
    throw new MongoShieldError(
      "MS_NO_IDENTITY",
      "The recovery kit passphrase is needed, but there is no terminal to ask for it.",
      { hint: `Set ${RECOVERY_PASSPHRASE_ENV}, or pass --identity-file with the secret key.` },
    );
  }
  const first = await promptHidden(context, options.message, options.confirm);
  if (options.confirm) {
    const again = await promptHidden(context, "Type the passphrase again", false);
    if (again !== first) {
      throw new MongoShieldError("MS_CONFIG_INVALID", "The two passphrases do not match.", {
        hint: "Run the command again and type the same passphrase twice.",
      });
    }
  }
  context.addSecret(first);
  return first;
}

/** One hidden prompt on stderr. Cancelling (Ctrl-C) stops the command. */
async function promptHidden(
  context: CommandContext,
  message: string,
  checkLength: boolean,
): Promise<string> {
  const answer = await password({
    message,
    output: context.io.stderr,
    ...(context.io.stdin ? { input: context.io.stdin } : {}),
    signal: context.signal,
    ...(checkLength
      ? {
          validate: (value: string | undefined) =>
            (value ?? "").length < MIN_RECOVERY_PASSPHRASE_LENGTH
              ? `Use at least ${MIN_RECOVERY_PASSPHRASE_LENGTH} characters.`
              : undefined,
        }
      : {}),
  });
  if (isCancel(answer)) throw new MongoShieldError("MS_ABORTED", "Cancelled.");
  return answer;
}

/**
 * For `restore` without --identity-file, --passphrase-env or a decryption config:
 * the keys from the recovery kit, when the location has one and the backup needs a
 * key (`needsKey` is only called once a kit exists). `undefined` otherwise, so the
 * restore goes on exactly as before.
 */
export async function decryptionFromRecoveryKit(
  context: CommandContext,
  storage: StorageAdapter,
  needsKey: () => Promise<boolean>,
): Promise<DecryptionOptions | undefined> {
  const signalOption = { signal: context.signal };
  if (!(await hasRecoveryKit(storage, signalOption))) return undefined;
  if (!(await needsKey())) return undefined;
  context.out.info(
    `No secret key given; using the recovery kit at ${storage.location}${RECOVERY_KIT_KEY}.`,
  );
  const passphrase = await askRecoveryPassphrase(context, {
    confirm: false,
    message: "Recovery kit passphrase",
  });
  const identities = await readRecoveryKit(storage, { passphrase, ...signalOption });
  if (identities === undefined) return undefined;
  for (const identity of identities) context.addSecret(identity);
  return { identities };
}
