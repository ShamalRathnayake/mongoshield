import type { Writable } from "node:stream";
import {
  CHUNK_TYPE_BSON,
  CHUNK_TYPE_EOF,
  CHUNK_TYPE_META,
  MultiplexWriteStream,
} from "../streams/MultiplexWriteStream";
import { AbstractStorageProvider } from "./AbstractStorageProvider";
import type { PruningPolicy, PruningResult, StorageProvider } from "./StorageProvider";

export const MSAF_MAGIC = Buffer.from("MSHLDARC", "utf8");
export const MSAF_VERSION = Buffer.from([0x01]);

export class ArchiveProvider extends AbstractStorageProvider {
  private archiveStream: Writable | null = null;

  constructor(
    private downstream: StorageProvider,
    private archiveFilename = "backup.msaf",
  ) {
    super();
  }

  protected async _initialize(expectedSizeInBytes?: number): Promise<void> {
    await this.downstream.initialize(expectedSizeInBytes);

    // Assert that the downstream provider supports monolithic archives
    // The cast to any is safe here as we are checking for the method's existence
    if (!(this.downstream as any).createArchiveWriteStream) {
      throw new Error(
        "The provided downstream StorageProvider does not support monolithic archive streams (missing createArchiveWriteStream).",
      );
    }

    // Request the single archive stream from the downstream provider
    this.archiveStream = await (this.downstream as any).createArchiveWriteStream(
      this.archiveFilename,
    );

    // Write the Global Header (Magic Bytes + Version)
    const headerBuffer = Buffer.concat([MSAF_MAGIC, MSAF_VERSION]);

    await new Promise<void>((resolve, reject) => {
      if (!this.archiveStream) {
        return reject(new Error("Archive stream is null"));
      }
      this.archiveStream.write(headerBuffer, (error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }

  protected async _createBsonWriteStream(
    dbName: string,
    collectionName: string,
  ): Promise<Writable> {
    if (!this.archiveStream) {
      throw new Error("ArchiveProvider not initialized");
    }
    const name = `${dbName}.${collectionName}`;
    return new MultiplexWriteStream(this.archiveStream, CHUNK_TYPE_BSON, name);
  }

  protected async _createMetadataWriteStream(
    dbName: string,
    collectionName: string,
  ): Promise<Writable> {
    if (!this.archiveStream) {
      throw new Error("ArchiveProvider not initialized");
    }
    const name = `${dbName}.${collectionName}`;
    return new MultiplexWriteStream(this.archiveStream, CHUNK_TYPE_META, name);
  }

  protected async _finalize(): Promise<void> {
    if (!this.archiveStream) {
      throw new Error("ArchiveProvider not initialized");
    }

    // Write the EOF marker block
    const eofHeader = Buffer.alloc(1 + 2 + 0 + 4);
    eofHeader.writeUInt8(CHUNK_TYPE_EOF, 0); // Type
    eofHeader.writeUInt16LE(0, 1); // Name length (0)
    eofHeader.writeUInt32LE(0, 3); // Payload length (0)

    await new Promise<void>((resolve, _reject) => {
      this.archiveStream?.end(eofHeader, () => {
        resolve();
      });
    });

    await this.downstream.finalize();
  }

  protected async _prune(policy: PruningPolicy): Promise<PruningResult> {
    // Delegate pruning entirely to the downstream provider.
    // The downstream provider manages the files/objects.
    return this.downstream.prune(policy);
  }
}
