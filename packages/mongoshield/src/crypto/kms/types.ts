/**
 * The pluggable cloud KMS interface behind KMS-protected backups.
 *
 * A KMS never sees backup data. It only wraps (encrypts) and unwraps (decrypts) the
 * 16-byte age file key of one small file per backup, `backup-key.age`, which holds
 * the backup's own age identity (see src/engine/backup-key.ts and
 * docs/specs/ENCRYPTION.md, "KMS backups"). So one KMS call is made per backup run
 * and one per restore or deep verification.
 *
 * Each provider has an adapter (aws.ts, gcp.ts, azure.ts) that implements
 * `KmsClient` on top of the provider's SDK, which is loaded lazily because the SDKs
 * are optional peer dependencies. Tests and users can replace the adapters with any
 * object that implements `KmsClient` (see registry.ts).
 */

import type { KmsKeyRef } from "../../types.ts";

/** The cloud providers MongoShield can use as a KMS. */
export type KmsProvider = KmsKeyRef["provider"];

/**
 * A data key wrapped by a KMS, with everything needed to unwrap it later. This is
 * exactly what a `mongoshield-kms` stanza stores (see stanza.ts).
 */
export interface KmsCiphertext {
  /**
   * The key that wrapped the data key, in the form that unwrapping needs. Usually
   * the configured key; adapters may record a more precise one (Azure records the
   * key *version* URL, so key rotation does not break old backups; AWS records the
   * key ARN rather than an alias that may later point elsewhere).
   */
  readonly key: string;
  /**
   * The provider's name for the wrapping algorithm, e.g. `SYMMETRIC_DEFAULT` (AWS),
   * `GOOGLE_SYMMETRIC_ENCRYPTION` (GCP) or `RSA-OAEP-256` (Azure). Recorded so
   * unwrapping uses the same one without extra configuration.
   */
  readonly algorithm: string;
  /** The provider's ciphertext. Opaque; never logged. */
  readonly ciphertext: Uint8Array;
}

/** Per-call options for `KmsClient` methods. */
export interface KmsCallOptions {
  /**
   * Cancels the call. Built-in adapters pass it to the SDK (AWS `abortSignal`,
   * Azure `abortSignal`; Google's client has no signal support, so the adapter
   * stops waiting and lets the request finish in the background) and reject with
   * MS_ABORTED. Custom clients should do the same; ignoring it only delays
   * cancellation until the call returns.
   */
  readonly signal?: AbortSignal | undefined;
}

/**
 * One cloud KMS key that can wrap and unwrap data keys.
 *
 * Implementations throw `MongoShieldError`s: `MS_ENCRYPTION_FAILED` /
 * `MS_DECRYPTION_FAILED` for refused or failed calls (with a hint naming the missing
 * permission when access was denied), `MS_CONFIG_INVALID` when the provider's SDK
 * is not installed, and `MS_ABORTED` when `options.signal` fires. Errors must never
 * contain the data key.
 */
export interface KmsClient {
  readonly provider: KmsProvider;
  /** The key this client was created for (as given to the factory). */
  readonly key: string;
  /** Wraps a data key (here: always a 16-byte age file key). */
  encryptDataKey(dataKey: Uint8Array, options?: KmsCallOptions): Promise<KmsCiphertext>;
  /** Unwraps a data key previously returned by `encryptDataKey`. */
  decryptDataKey(wrapped: KmsCiphertext, options?: KmsCallOptions): Promise<Uint8Array>;
  /**
   * Releases SDK resources (sockets) the client created itself. Never closes an SDK
   * client that was passed in: the caller owns that one.
   */
  close?(): Promise<void>;
}

/**
 * Creates the `KmsClient` for one key. Called once per key per backup run, restore
 * or deep verification; on the read side `ref.key` comes from the stored stanza
 * (`KmsCiphertext.key`).
 */
export type KmsClientFactory = (ref: KmsKeyRef) => KmsClient | Promise<KmsClient>;

/**
 * What the data key is bound to at the KMS, on providers that support it (AWS
 * encryption context, GCP additional authenticated data). It separates MongoShield's
 * ciphertexts from any other use of the same key, and shows up in audit logs
 * (CloudTrail), so KMS calls made for backups are easy to recognise. Changing it
 * would make existing backups unreadable: it is part of the on-disk contract.
 */
export const KMS_DATA_KEY_CONTEXT = {
  /** AWS `EncryptionContext`: a string map. */
  aws: { "mongoshield:purpose": "backup-key" },
  /** GCP `additionalAuthenticatedData`, as UTF-8 bytes. */
  gcp: "mongoshield:purpose=backup-key",
} as const;
