import { EventEmitter } from "node:events";
import { PassThrough, type Writable } from "node:stream";
import type {
  PruningPolicy,
  PruningResult,
  StorageProvider,
} from "./StorageProvider";

/**
 * AbstractStorageProvider serves as the secure, robust foundation for all storage adapters.
 *
 * It provides:
 * 1. Strict Path Sanitization: Blocks path traversal attacks (`../`, `/`) natively.
 * 2. Automatic Telemetry: Wraps created write streams in a PassThrough interceptor to emit `progress` events automatically.
 */
export abstract class AbstractStorageProvider
  extends EventEmitter
  implements StorageProvider
{
  public async initialize(expectedSizeInBytes?: number): Promise<void> {
    await this._initialize(expectedSizeInBytes);
  }

  public async createBsonWriteStream(
    dbName: string,
    collectionName: string,
  ): Promise<Writable> {
    this.sanitizePath(dbName);
    this.sanitizePath(collectionName);

    const stream = await this._createBsonWriteStream(dbName, collectionName);
    return this.wrapWithTelemetry(stream);
  }

  public async createMetadataWriteStream(
    dbName: string,
    collectionName: string,
  ): Promise<Writable> {
    this.sanitizePath(dbName);
    this.sanitizePath(collectionName);

    const stream = await this._createMetadataWriteStream(
      dbName,
      collectionName,
    );
    return this.wrapWithTelemetry(stream);
  }

  public async createArchiveWriteStream(filename: string): Promise<Writable> {
    this.sanitizePath(filename);

    if (!this._createArchiveWriteStream) {
      throw new Error(
        "This StorageProvider does not support monolithic archive streams.",
      );
    }

    const stream = await this._createArchiveWriteStream(filename);
    return this.wrapWithTelemetry(stream);
  }

  public async finalize(): Promise<void> {
    await this._finalize();
  }

  public async prune(policy: PruningPolicy): Promise<PruningResult> {
    return this._prune(policy);
  }

  /**
   * Sanitizes input to prevent severe Path Traversal vulnerabilities when constructing local paths or remote object keys.
   */
  protected sanitizePath(input: string): void {
    if (
      !input ||
      input.includes("/") ||
      input.includes("\\") ||
      input.includes("..")
    ) {
      throw new Error(
        `AbstractStorageProvider: Invalid path segment detected for security reasons: "${input}"`,
      );
    }
  }

  /**
   * Wraps an underlying Writable stream with a PassThrough stream that intercepts data events
   * and automatically emits `progress` events to the Engine.
   */
  private wrapWithTelemetry(destination: Writable): Writable {
    const passThrough = new PassThrough();

    passThrough.on("data", (chunk: Buffer) => {
      this.emit("progress", chunk.length);
    });

    passThrough.on("error", (err) => {
      this.emit("error", err);
    });

    // CRITICAL: Propagate errors from the actual destination (e.g., disk full)
    // back to the PassThrough stream so the Engine detects it immediately.
    destination.on("error", (err) => {
      passThrough.destroy(err);
      this.emit("error", err);
    });

    passThrough.pipe(destination);

    return passThrough;
  }

  /**
   * Child classes must implement these specific methods instead of the public interface.
   */
  protected abstract _initialize(expectedSizeInBytes?: number): Promise<void>;
  protected abstract _createBsonWriteStream(
    dbName: string,
    collectionName: string,
  ): Promise<Writable>;
  protected abstract _createMetadataWriteStream(
    dbName: string,
    collectionName: string,
  ): Promise<Writable>;
  protected _createArchiveWriteStream?(filename: string): Promise<Writable>;
  protected abstract _finalize(): Promise<void>;
  protected abstract _prune(policy: PruningPolicy): Promise<PruningResult>;
}
