import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";
import type { Db } from "mongodb";

import type { BackupConfig } from "../config";
import { ConnectionManager } from "../db/ConnectionManager";
import type { StorageProvider } from "../providers/StorageProvider";
import { BSONEncoderStream } from "../streams/BSONEncoderStream";
import { EncryptionTransform } from "../streams/EncryptionStream";

export interface CollectionTarget {
  name: string;
  type: string;
}

export class BackupEngine {
  private config: BackupConfig;
  private connectionManager: ConnectionManager;
  private storage: StorageProvider;

  constructor(config: BackupConfig, storage: StorageProvider) {
    this.config = config;
    this.connectionManager = new ConnectionManager(config.connection);
    this.storage = storage;
  }

  /**
   * Discovers and filters the collections to be backed up based on the TargetOptions.
   */
  public async getTargetCollections(db: Db): Promise<CollectionTarget[]> {
    const {
      collections: includeCmd,
      excludeCollections,
      excludeCollectionsWithPrefix,
      viewsAsCollections,
    } = this.config.target;

    const allCollections = await db.listCollections().toArray();

    // Filter out views unless explicitly requested
    let filtered = allCollections.filter((c) =>
      viewsAsCollections ? true : c.type !== "view",
    );

    // 1. Explicit inclusions (if provided, ignore everything else except exclusions)
    if (includeCmd && includeCmd.length > 0) {
      filtered = filtered.filter((c) => includeCmd.includes(c.name));
    }

    // 2. Explicit exclusions
    if (excludeCollections && excludeCollections.length > 0) {
      filtered = filtered.filter((c) => !excludeCollections.includes(c.name));
    }

    // 3. Prefix exclusions
    if (
      excludeCollectionsWithPrefix &&
      excludeCollectionsWithPrefix.length > 0
    ) {
      filtered = filtered.filter((c) => {
        return !excludeCollectionsWithPrefix.some((prefix) =>
          c.name.startsWith(prefix),
        );
      });
    }

    return filtered.map((c) => ({
      name: c.name,
      type: c.type || "collection",
    }));
  }

  public async run(signal?: AbortSignal): Promise<void> {
    const client = await this.connectionManager.connect();

    try {
      const targetDbName = this.config.target.dbName;
      let expectedSizeInBytes = 0;

      try {
        if (targetDbName) {
          const stats = await client.db(targetDbName).stats();
          expectedSizeInBytes += stats.dataSize || 0;
        } else {
          const adminDb = client.db().admin();
          const { databases } = await adminDb.listDatabases();
          for (const dbInfo of databases) {
            const name = dbInfo.name;
            if (name !== "admin" && name !== "config" && name !== "local") {
              expectedSizeInBytes += dbInfo.sizeOnDisk || 0;
            }
          }
        }
      } catch (_err) {
        // Fallback to 0 if stats fail (e.g., due to missing clusterMonitor role)
        expectedSizeInBytes = 0;
      }

      await this.storage.initialize(expectedSizeInBytes);

      if (targetDbName) {
        // Backup specific database
        const db = client.db(targetDbName);
        await this.backupDatabase(db, targetDbName, signal);
      } else {
        // Backup entire cluster (all non-internal databases)
        const adminDb = client.db().admin();
        const { databases } = await adminDb.listDatabases();

        for (const dbInfo of databases) {
          const name = dbInfo.name;
          if (name === "admin" || name === "config" || name === "local") {
            continue; // Skip internal MongoDB databases
          }
          const db = client.db(name);
          await this.backupDatabase(db, name, signal);
        }
      }

      await this.storage.finalize();
    } finally {
      await this.connectionManager.disconnect();
    }
  }

  private async backupDatabase(
    db: Db,
    dbName: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const collections = await this.getTargetCollections(db);
    const concurrencyLimit = this.config.output.numParallelCollections || 4;

    for (let i = 0; i < collections.length; i += concurrencyLimit) {
      const batch = collections.slice(i, i + concurrencyLimit);

      await Promise.all(
        batch.map(async (col) => {
          await this.extractCollectionMetadata(dbName, db, col.name, signal);
          await this.extractCollectionBSON(dbName, db, col.name, signal);
        }),
      );
    }
  }

  private async extractCollectionMetadata(
    dbName: string,
    db: Db,
    collectionName: string,
    signal?: AbortSignal,
  ) {
    const col = db.collection(collectionName);

    // Attempt to gather indexes and options
    let options = {};
    let indexes: any[] = [];

    try {
      const allColls = await db
        .listCollections({ name: collectionName })
        .toArray();
      if (allColls.length > 0) {
        options = (allColls[0] as any).options || {};
      }
      indexes = await col.indexes();
    } catch {
      // Views do not have indexes, and sometimes permissions deny access
    }

    const metadata = { options, indexes };
    const payload = Buffer.from(JSON.stringify(metadata, null, 2));

    const metaStream = await this.storage.createMetadataWriteStream(
      dbName,
      collectionName,
    );

    const streams: any[] = [];
    if (this.config.output.gzip) {
      streams.push(createGzip());
    }
    streams.push(metaStream);

    // Create a pipeline from a string/buffer is possible by using a readable or stream.Readable.from
    // But since we just pipe directly, we can manually handle abort signal or use pipeline:
    const { Readable } = require("node:stream");
    const readStream = Readable.from([payload]);

    streams.unshift(readStream);

    if (signal) {
      streams.push({ signal });
    }

    // @ts-expect-error
    await pipeline(...streams);
  }

  private async extractCollectionBSON(
    dbName: string,
    db: Db,
    collectionName: string,
    signal?: AbortSignal,
  ) {
    const col = db.collection(collectionName);

    // Construct Query parameters
    const filter = this.config.target.query || {};
    const cursorOptions: any = {};
    if (this.config.target.readPreference) {
      cursorOptions.readPreference = this.config.target.readPreference;
    }

    const cursor = col.find(filter, cursorOptions);
    if (this.config.output.batchSize)
      cursor.batchSize(this.config.output.batchSize);

    // Build the data pipeline dynamically
    const readStream = cursor.stream();
    const bsonEncoder = new BSONEncoderStream();

    const streams: any[] = [readStream, bsonEncoder];

    if (this.config.output.gzip) {
      streams.push(createGzip());
    }

    if (this.config.output.encryptionKey) {
      streams.push(new EncryptionTransform(this.config.output.encryptionKey));
    }

    const writeStream = await this.storage.createBsonWriteStream(
      dbName,
      collectionName,
    );
    streams.push(writeStream);

    if (signal) {
      streams.push({ signal });
    }

    // @ts-expect-error - TS has varied overloads for pipeline, but spread array is supported at runtime
    await pipeline(...streams);
  }
}
