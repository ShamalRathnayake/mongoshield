import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { Writable } from "node:stream";
import {
  CHUNK_TYPE_BSON,
  CHUNK_TYPE_EOF,
  CHUNK_TYPE_META,
  MultiplexWriteStream,
} from "../streams/MultiplexWriteStream";
import { AbstractStorageProvider } from "./AbstractStorageProvider";
import type { PruningPolicy, PruningResult } from "./StorageProvider";

export const MSAF_MAGIC = Buffer.from("MSHLDARC", "utf8");
export const MSAF_VERSION = Buffer.from([0x01]);

export class ArchiveProvider extends AbstractStorageProvider {
  private archiveStream: Writable | null = null;

  constructor(
    private archivePath: string,
    compress = false,
  ) {
    super();
  }

  protected async _initialize(): Promise<void> {
    // Ensure directory exists
    const dir = dirname(this.archivePath);
    await mkdir(dir, { recursive: true });

    // Open the shared archive write stream
    this.archiveStream = createWriteStream(this.archivePath);

    // Wait for the stream to open
    await new Promise<void>((resolve, reject) => {
      if (!this.archiveStream)
        return reject(new Error("Archive stream is null"));
      this.archiveStream.once("open", () => resolve());
      this.archiveStream.once("error", reject);
    });

    // Write the Global Header (Magic Bytes + Version)
    const headerBuffer = Buffer.concat([MSAF_MAGIC, MSAF_VERSION]);

    await new Promise<void>((resolve, reject) => {
      this.archiveStream!.write(headerBuffer, (error) => {
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

    await new Promise<void>((resolve, reject) => {
      this.archiveStream!.end(eofHeader, () => {
        resolve();
      });
    });
  }

  protected async _prune(policy: PruningPolicy): Promise<PruningResult> {
    // ArchiveProvider natively creates single file archives (.msaf)
    // Pruning in this context would mean deleting old .msaf files.
    // Usually, the higher-level scheduler or file system provider manages this.
    // For now, this is a no-op stub for the standalone archive stream.
    return { deletedCount: 0, deletedPaths: [] };
  }
}
