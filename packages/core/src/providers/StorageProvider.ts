import type { Readable, Writable } from "node:stream";

/**
 * StorageProvider abstracts the destination/source logic for backup and restore.
 * It provides a standardized contract so the Engine can work with Local Disk, AWS S3, or any other cloud provider agnostically.
 *
 * Implementations should strongly prefer extending `AbstractStorageProvider` rather than implementing this interface directly.
 * `AbstractStorageProvider` provides critical security sanitization and automatic progress telemetry.
 */
export interface StorageProvider {
  /**
   * Called before backup/restore begins.
   * Useful for creating base directories on a filesystem or allocating/verifying cloud buckets.
   */
  initialize(): Promise<void>;

  /**
   * Obtains a writable stream for the BSON data of a specific collection.
   *
   * @param dbName The name of the database being backed up.
   * @param collectionName The name of the collection being backed up.
   * @returns A Node.js Writable stream to pipe the compressed/encrypted data into.
   */
  createBsonWriteStream(
    dbName: string,
    collectionName: string,
  ): Promise<Writable>;

  /**
   * Obtains a writable stream for the metadata JSON of a specific collection.
   *
   * @param dbName The name of the database being backed up.
   * @param collectionName The name of the collection being backed up.
   * @returns A Node.js Writable stream to pipe the metadata payload into.
   */
  createMetadataWriteStream(
    dbName: string,
    collectionName: string,
  ): Promise<Writable>;

  /**
   * Lists the contents of the storage to identify what can be restored.
   * @returns An array of objects representing discovered database and collection backups.
   */
  listContents(): Promise<Array<{ dbName: string; collectionName: string }>>;

  /**
   * Obtains a readable stream for the BSON data of a specific collection.
   *
   * @param dbName The name of the database to restore.
   * @param collectionName The name of the collection to restore.
   * @returns A Node.js Readable stream emitting the compressed/encrypted BSON data.
   */
  createBsonReadStream(
    dbName: string,
    collectionName: string,
  ): Promise<Readable>;

  /**
   * Obtains a readable stream for the metadata JSON of a specific collection.
   *
   * @param dbName The name of the database to restore.
   * @param collectionName The name of the collection to restore.
   * @returns A Node.js Readable stream emitting the metadata JSON payload.
   */
  createMetadataReadStream(
    dbName: string,
    collectionName: string,
  ): Promise<Readable>;

  /**
   * Called to finalize the process after all collections have finished streaming.
   * Useful for uploading final manifests or closing multiplexed archive files.
   */
  finalize(): Promise<void>;

  /**
   * Telemetry Event: Emitted as data chunks are processed in the underlying storage.
   * @param event 'progress'
   * @param listener Callback receiving the number of bytes processed in the latest chunk.
   */
  on(event: "progress", listener: (bytesProcessed: number) => void): this;

  /**
   * Error Event: Emitted if the storage provider encounters a fatal error during stream operations.
   * @param event 'error'
   * @param listener Callback receiving the Error object.
   */
  on(event: "error", listener: (error: Error) => void): this;
}
