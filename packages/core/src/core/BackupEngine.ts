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

  public async run(): Promise<void> {
    const client = await this.connectionManager.connect();

    try {
      const dbName = this.config.target.dbName;
      if (!dbName) {
        throw new Error("BackupEngine: target.dbName is currently required.");
      }

      const db = client.db(dbName);

      const collections = await this.getTargetCollections(db);

      await this.storage.initialize();

      // Batch parallel processing loop
      const concurrencyLimit = this.config.output.numParallelCollections || 4;

      for (let i = 0; i < collections.length; i += concurrencyLimit) {
        const batch = collections.slice(i, i + concurrencyLimit);

        await Promise.all(
          batch.map(async (col) => {
            await this.extractCollectionMetadata(dbName, db, col.name);
            await this.extractCollectionBSON(dbName, db, col.name);
          }),
        );
      }

      await this.storage.finalize();
    } finally {
      await this.connectionManager.disconnect();
    }
  }

  private async extractCollectionMetadata(
    dbName: string,
    db: Db,
    collectionName: string,
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

    if (this.config.output.gzip) {
      const gz = createGzip();
      gz.pipe(metaStream);
      gz.end(payload);
    } else {
      metaStream.end(payload);
    }
  }

  private async extractCollectionBSON(
    dbName: string,
    db: Db,
    collectionName: string,
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

    // @ts-expect-error - TS has varied overloads for pipeline, but spread array is supported at runtime
    await pipeline(...streams);
  }
}
