import { EventEmitter } from "node:events";
import { PassThrough, type Writable } from "node:stream";
import type { StorageProvider } from "./StorageProvider";

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
  public async initialize(): Promise<void> {
    await this._initialize();
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

  public async finalize(): Promise<void> {
    await this._finalize();
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

    passThrough.pipe(destination);

    return passThrough;
  }

  /**
   * Child classes must implement these specific methods instead of the public interface.
   */
  protected abstract _initialize(): Promise<void>;
  protected abstract _createBsonWriteStream(
    dbName: string,
    collectionName: string,
  ): Promise<Writable>;
  protected abstract _createMetadataWriteStream(
    dbName: string,
    collectionName: string,
  ): Promise<Writable>;
  protected abstract _finalize(): Promise<void>;
}
