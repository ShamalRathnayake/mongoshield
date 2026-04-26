import { EventEmitter } from "node:events";
import { PassThrough, type Readable, type Writable } from "node:stream";
import type { StorageProvider } from "./StorageProvider";

/**
 * AbstractStorageProvider serves as the secure, robust foundation for all storage adapters.
 *
 * It provides:
 * 1. Strict Path Sanitization: Blocks path traversal attacks (`../`, `/`) natively.
 * 2. Automatic Telemetry: Wraps created streams in a PassThrough interceptor to emit `progress` events automatically.
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

  public async listContents(): Promise<
    Array<{ dbName: string; collectionName: string }>
  > {
    return this._listContents();
  }

  public async createBsonReadStream(
    dbName: string,
    collectionName: string,
  ): Promise<Readable> {
    this.sanitizePath(dbName);
    this.sanitizePath(collectionName);

    const stream = await this._createBsonReadStream(dbName, collectionName);
    return this.wrapWithReadTelemetry(stream);
  }

  public async createMetadataReadStream(
    dbName: string,
    collectionName: string,
  ): Promise<Readable> {
    this.sanitizePath(dbName);
    this.sanitizePath(collectionName);

    const stream = await this._createMetadataReadStream(dbName, collectionName);
    return this.wrapWithReadTelemetry(stream);
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

    // CRITICAL: Propagate errors from the actual destination (e.g., disk full, EACCES)
    // back to the PassThrough stream so that the Engine (pipeline) detects it.
    destination.on("error", (err) => {
      passThrough.destroy(err);
      this.emit("error", err);
    });

    passThrough.pipe(destination);

    return passThrough;
  }

  /**
   * Wraps an underlying Readable stream with a PassThrough stream that intercepts data events
   * for telemetry.
   */
  private wrapWithReadTelemetry(source: Readable): Readable {
    const passThrough = new PassThrough();

    source.on("data", (chunk: Buffer) => {
      this.emit("progress", chunk.length);
    });

    source.on("error", (err) => {
      passThrough.destroy(err);
      this.emit("error", err);
    });

    source.pipe(passThrough);

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

  protected abstract _listContents(): Promise<
    Array<{ dbName: string; collectionName: string }>
  >;

  protected abstract _createBsonReadStream(
    dbName: string,
    collectionName: string,
  ): Promise<Readable>;

  protected abstract _createMetadataReadStream(
    dbName: string,
    collectionName: string,
  ): Promise<Readable>;

  protected abstract _finalize(): Promise<void>;
}
