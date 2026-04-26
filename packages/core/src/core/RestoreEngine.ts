import { Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";
import type { Db } from "mongodb";

import type { RestoreConfig } from "../config";
import { ConnectionManager } from "../db/ConnectionManager";
import type { StorageProvider } from "../providers/StorageProvider";
import { BSONDecoderStream } from "../streams/BSONDecoderStream";
import { DecryptionTransform } from "../streams/EncryptionStream";

export class RestoreEngine {
  private config: RestoreConfig;
  private connectionManager: ConnectionManager;
  private storage: StorageProvider;

  constructor(config: RestoreConfig, storage: StorageProvider) {
    this.config = config;
    this.connectionManager = new ConnectionManager(config.connection);
    this.storage = storage;
  }

  public async run(): Promise<void> {
    const client = await this.connectionManager.connect();

    try {
      await this.storage.initialize();
      const contents = await this.storage.listContents();

      // Filter contents based on requested db/collections
      let targets = contents;
      if (this.config.input.dbName) {
        targets = targets.filter((c) => c.dbName === this.config.input.dbName);
      }
      if (
        this.config.input.collections &&
        this.config.input.collections.length > 0
      ) {
        targets = targets.filter((c) =>
          this.config.input.collections!.includes(c.collectionName),
        );
      }

      if (targets.length === 0) {
        throw new Error("RestoreEngine: No matching backups found in storage.");
      }

      // Process collections in parallel batches
      const concurrency = this.config.input.numParallelCollections || 4;
      for (let i = 0; i < targets.length; i += concurrency) {
        const batch = targets.slice(i, i + concurrency);
        await Promise.all(
          batch.map(async (target) => {
            const db = client.db(target.dbName);

            // 1. Restore Metadata (Indexes/Options)
            await this.restoreMetadata(
              target.dbName,
              db,
              target.collectionName,
            );

            // 2. Restore BSON Data
            await this.restoreBSON(target.dbName, db, target.collectionName);
          }),
        );
      }

      await this.storage.finalize();
    } finally {
      await this.connectionManager.disconnect();
    }
  }

  private async restoreMetadata(
    dbName: string,
    db: Db,
    collectionName: string,
  ): Promise<void> {
    try {
      const readStream = await this.storage.createMetadataReadStream(
        dbName,
        collectionName,
      );

      let payload = Buffer.alloc(0);
      for await (const chunk of readStream) {
        payload = Buffer.concat([payload, chunk]);
      }

      const metadata = JSON.parse(payload.toString("utf8"));

      if (this.config.input.dryRun) return;

      // Drop if requested
      if (this.config.input.drop) {
        await db
          .collection(collectionName)
          .drop()
          .catch(() => {});
      }

      // Create collection with options
      await db
        .createCollection(collectionName, metadata.options || {})
        .catch(() => {});

      // Create indexes
      if (metadata.indexes && metadata.indexes.length > 0) {
        const col = db.collection(collectionName);
        for (const idx of metadata.indexes) {
          if (idx.name === "_id_") continue;
          await col.createIndex(idx.key, idx).catch((err) => {
            console.warn(
              `RestoreEngine: Failed to create index ${idx.name} on ${collectionName}: ${err.message}`,
            );
          });
        }
      }
    } catch (error) {
      console.warn(
        `RestoreEngine: Metadata restore failed for ${collectionName}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async restoreBSON(
    dbName: string,
    db: Db,
    collectionName: string,
  ): Promise<void> {
    if (this.config.input.dryRun) return;

    const readStream = await this.storage.createBsonReadStream(
      dbName,
      collectionName,
    );

    // biome-ignore lint/suspicious/noExplicitAny: Streams can be various types
    const streams: any[] = [readStream];

    if (this.config.input.encryptionKey) {
      streams.push(new DecryptionTransform(this.config.input.encryptionKey));
    }

    if (this.config.input.gzip) {
      streams.push(createGunzip());
    }

    streams.push(new BSONDecoderStream());

    // Final sink: Bulk insert into MongoDB
    const col = db.collection(collectionName);
    const writeStream = new Writable({
      objectMode: true,
      write: async (doc, _enc, cb) => {
        try {
          // In a real production tool, we'd use batching for performance.
          // For this implementation, we'll keep it simple or implement a basic batcher.
          await col.insertOne(doc);
          cb();
        } catch (err) {
          cb(err instanceof Error ? err : new Error(String(err)));
        }
      },
    });

    streams.push(writeStream);

    // biome-ignore lint/suspicious/noExplicitAny: pipeline signature is complex
    await (pipeline as any)(...streams);
  }
}
