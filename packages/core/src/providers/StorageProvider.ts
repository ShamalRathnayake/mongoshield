import type { Writable } from "node:stream";

export interface PruningPolicy {
  maxCount?: number;
  maxDays?: number;
  strategy: "count" | "age" | "both";
}

export interface PruningResult {
  deletedCount: number;
  deletedPaths: string[];
}

/**
 * StorageProvider abstracts the destination logic for the backup stream.
 * It provides a standardized contract so the BackupEngine can write to Local Disk, AWS S3, or any other cloud provider agnostically.
 *
 * Implementations should strongly prefer extending `AbstractStorageProvider` rather than implementing this interface directly.
 * `AbstractStorageProvider` provides critical security sanitization and automatic progress telemetry.
 */
export interface StorageProvider {
  /**
   * Called before backup begins.
   * Useful for creating base directories on a filesystem or allocating/verifying cloud buckets.
   * @param expectedSizeInBytes Optional size of the target database to check storage limits.
   */
  initialize(expectedSizeInBytes?: number): Promise<void>;

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
   * Obtains a generic writable stream for a single monolithic archive file.
   * This allows middleware like ArchiveProvider to multiplex streams into one file.
   * @param filename The desired filename of the archive.
   * @returns A Node.js Writable stream.
   */
  createArchiveWriteStream?(filename: string): Promise<Writable>;

  /**
   * Called to finalize the backup process after all collections have finished streaming.
   * Useful for uploading final manifests or closing multiplexed archive files.
   */
  finalize(): Promise<void>;

  /**
   * Automatically cleans up old backups based on a user-defined policy.
   * @param policy The pruning policy defining retention rules.
   */
  prune(policy: PruningPolicy): Promise<PruningResult>;

  /**
   * Telemetry Event: Emitted as data chunks are written to the underlying storage.
   * @param event 'progress'
   * @param listener Callback receiving the number of bytes written in the latest chunk.
   */
  on(event: "progress", listener: (bytesWritten: number) => void): this;

  /**
   * Error Event: Emitted if the storage provider encounters a fatal error during stream writing.
   * @param event 'error'
   * @param listener Callback receiving the Error object.
   */
  on(event: "error", listener: (error: Error) => void): this;
}
