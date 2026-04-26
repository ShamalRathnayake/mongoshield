import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Writable } from "node:stream";
import { AbstractStorageProvider } from "@mongoshield/core";

export class FileSystemProvider extends AbstractStorageProvider {
  private baseOutPath: string;
  private compress: boolean;

  constructor(outPath: string, compress = false) {
    super();
    this.baseOutPath = outPath;
    this.compress = compress;
  }

  protected async _initialize(): Promise<void> {
    // Ensure base dump directory exists
    await mkdir(this.baseOutPath, { recursive: true });
  }

  private async prepareDbDir(dbName: string): Promise<string> {
    const dbDir = join(this.baseOutPath, dbName);
    await mkdir(dbDir, { recursive: true });
    return dbDir;
  }

  protected async _createBsonWriteStream(
    dbName: string,
    collectionName: string,
  ): Promise<Writable> {
    const dbDir = await this.prepareDbDir(dbName);
    const suffix = this.compress ? ".gz" : "";
    // Format: dump/mydb/mycollection.bson.gz
    const filepath = join(dbDir, `${collectionName}.bson${suffix}`);
    return createWriteStream(filepath);
  }

  protected async _createMetadataWriteStream(
    dbName: string,
    collectionName: string,
  ): Promise<Writable> {
    const dbDir = await this.prepareDbDir(dbName);
    const suffix = this.compress ? ".gz" : "";
    // Format: dump/mydb/mycollection.metadata.json.gz
    const filepath = join(dbDir, `${collectionName}.metadata.json${suffix}`);
    return createWriteStream(filepath);
  }

  protected async _finalize(): Promise<void> {
    // No-op for standard filesystem extraction.
    // If it was .archive, here we might finalize multiplexers.
  }
}
