import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readdir, rename, stat } from "node:fs/promises";
import { join } from "node:path";
import type { Readable, Writable } from "node:stream";
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
    // Ensure base dump directory exists with secure permissions (0700)
    await mkdir(this.baseOutPath, { recursive: true, mode: 0o700 });
  }

  private async prepareDbDir(dbName: string): Promise<string> {
    const dbDir = join(this.baseOutPath, dbName);
    await mkdir(dbDir, { recursive: true, mode: 0o700 });
    return dbDir;
  }

  /**
   * Creates a write stream that writes to a temporary file first,
   * then renames it to the target path upon successful completion.
   */
  private async createAtomicStream(filepath: string): Promise<Writable> {
    const tmpPath = `${filepath}.tmp`;
    // Create stream with 0600 (read/write only by owner)
    const stream = createWriteStream(tmpPath, { mode: 0o600 });

    stream.on("finish", async () => {
      try {
        await rename(tmpPath, filepath);
      } catch (err) {
        // Bubble up rename errors
        this.emit("error", err);
      }
    });

    return stream;
  }

  protected async _createBsonWriteStream(
    dbName: string,
    collectionName: string,
  ): Promise<Writable> {
    const dbDir = await this.prepareDbDir(dbName);
    const suffix = this.compress ? ".gz" : "";
    const filepath = join(dbDir, `${collectionName}.bson${suffix}`);
    return this.createAtomicStream(filepath);
  }

  protected async _createMetadataWriteStream(
    dbName: string,
    collectionName: string,
  ): Promise<Writable> {
    const dbDir = await this.prepareDbDir(dbName);
    const suffix = this.compress ? ".gz" : "";
    const filepath = join(dbDir, `${collectionName}.metadata.json${suffix}`);
    return this.createAtomicStream(filepath);
  }

  protected async _listContents(): Promise<
    Array<{ dbName: string; collectionName: string }>
  > {
    const results: Array<{ dbName: string; collectionName: string }> = [];

    try {
      const dbs = await readdir(this.baseOutPath);
      for (const dbName of dbs) {
        const dbPath = join(this.baseOutPath, dbName);
        const s = await stat(dbPath);
        if (!s.isDirectory()) continue;

        const files = await readdir(dbPath);
        for (const filename of files) {
          if (filename.endsWith(".bson") || filename.endsWith(".bson.gz")) {
            const collectionName = filename.replace(/\.bson(\.gz)?$/, "");
            results.push({ dbName, collectionName });
          }
        }
      }
    } catch (error) {
      // If directory doesn't exist, return empty results
    }

    return results;
  }

  protected async _createBsonReadStream(
    dbName: string,
    collectionName: string,
  ): Promise<Readable> {
    const suffix = this.compress ? ".gz" : "";
    const filepath = join(
      this.baseOutPath,
      dbName,
      `${collectionName}.bson${suffix}`,
    );
    return createReadStream(filepath);
  }

  protected async _createMetadataReadStream(
    dbName: string,
    collectionName: string,
  ): Promise<Readable> {
    const suffix = this.compress ? ".gz" : "";
    const filepath = join(
      this.baseOutPath,
      dbName,
      `${collectionName}.metadata.json${suffix}`,
    );
    return createReadStream(filepath);
  }

  protected async _finalize(): Promise<void> {
    // No-op for standard filesystem extraction.
  }
}
