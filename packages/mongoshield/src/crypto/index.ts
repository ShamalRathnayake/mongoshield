/**
 * age v1 encryption for MongoShield backups (https://c2sp.org/age).
 *
 * A dependency-free, streaming implementation on node:crypto of the native
 * X25519 and scrypt recipient types. Files written here can be decrypted with
 * the official `age` CLI, and vice versa. See docs/specs/ENCRYPTION.md.
 */

export { createDecryptStream, type DecryptStreamOptions } from "./decrypt.ts";
export { createEncryptStream, type EncryptStreamOptions } from "./encrypt.ts";
export type { DecryptionStage } from "./failures.ts";
export {
  type FileKeyUnwrapper,
  type FileKeyWrapper,
  isAgeEncrypted,
  type Stanza,
} from "./header.ts";
export {
  assertValidIdentity,
  assertValidRecipient,
  describeRecipient,
  type GeneratedIdentity,
  generateIdentity,
  identityToRecipient,
  PASSPHRASE_RECIPIENT_LABEL,
  parseIdentityFile,
} from "./keys.ts";
export { DEFAULT_MAX_SCRYPT_WORK_FACTOR, DEFAULT_SCRYPT_WORK_FACTOR } from "./scrypt.ts";
