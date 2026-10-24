/**
 * What the engines need to run, already resolved by the caller (`MongoShield`
 * or the CLI): an open MongoDB client, a storage adapter, a logger and the
 * crypto settings. Engines never open or close connections themselves, which
 * keeps them easy to test and lets callers reuse an application's client.
 */

import type { MongoClient } from "mongodb";
import type { Compression } from "../format/manifest.ts";
import type { Logger } from "../logger.ts";
import type { StorageAdapter } from "../storage/types.ts";
import type { Telemetry } from "../telemetry/telemetry.ts";
import type { EncryptionOptions } from "../types.ts";

/** Shared by every engine. */
export interface EngineContext {
  readonly storage: StorageAdapter;
  readonly logger: Logger;
  /**
   * Opens a span per namespace (and per change replay) inside the operation's span.
   * `MongoShield` passes it only when telemetry is enabled; omitted, the engines
   * record nothing and pay nothing.
   */
  readonly telemetry?: Telemetry;
}

/** Everything `runBackup()` needs besides the per-run options. */
export interface BackupContext extends EngineContext {
  /** Connected client for the source deployment. Not closed by the engine. */
  readonly client: MongoClient;
  readonly compression: Compression;
  /** Omit to write unencrypted backups. */
  readonly encryption: EncryptionOptions | undefined;
}

/** Everything `planRestore()` / `runRestore()` need besides the per-run options. */
export interface RestoreContext extends EngineContext {
  /** Connected client for the target deployment. Not closed by the engine. */
  readonly client: MongoClient;
}

/** `verifyBackup()` only reads storage. */
export type VerifyContext = EngineContext;
