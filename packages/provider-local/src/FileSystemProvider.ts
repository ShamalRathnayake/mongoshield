import { createWriteStream } from "node:fs";
import { mkdir, readdir, rm, stat, statfs } from "node:fs/promises";
import { join } from "node:path";
import type { Writable } from "node:stream";
import type { PruningPolicy, PruningResult } from "@mongoshield/core";
import { AbstractStorageProvider } from "@mongoshield/core";

export interface FileSystemProviderOptions {
  outPath: string;
  compress?: boolean;
  disableRotation?: boolean;
}

export class FileSystemProvider extends AbstractStorageProvider {
  private baseOutPath: string;
  private compress: boolean;
  private disableRotation: boolean;
  private currentRunDir: string = "";
  private writtenFiles: Set<string> = new Set();

  constructor(options: FileSystemProviderOptions | string, compress = false) {
    super();
    if (typeof options === "string") {
      this.baseOutPath = options;
      this.compress = compress;
      this.disableRotation = false;
    } else {
      this.baseOutPath = options.outPath;
      this.compress = options.compress ?? false;
      this.disableRotation = options.disableRotation ?? false;
    }
  }

  protected override async _initialize(expectedSizeInBytes?: number): Promise<void> {
    this.writtenFiles.clear();

    // Ensure base output path exists first so we can check statfs
    await mkdir(this.baseOutPath, { recursive: true });

    if (expectedSizeInBytes !== undefined && expectedSizeInBytes > 0) {
      const stats = await statfs(this.baseOutPath);
      const freeSpace = stats.bavail * stats.bsize;
      if (freeSpace < expectedSizeInBytes) {
        throw new Error(
          `FileSystemProvider: Insufficient disk space. Required at least ${expectedSizeInBytes} bytes, but only ${freeSpace} bytes are available on the target drive.`,
        );
      }
    }

    if (this.disableRotation) {
      this.currentRunDir = this.baseOutPath;
    } else {
      // Create a timestamped folder: YYYYMMDD-HHmmss
      const date = new Date();
      const timestamp = date
        .toISOString()
        .replace(/[:.]/g, "-")
        .replace("T", "_")
        .substring(0, 19);
      this.currentRunDir = join(this.baseOutPath, `${timestamp}.tmp`);
    }

    await mkdir(this.currentRunDir, { recursive: true });
  }

  private async prepareDbDir(dbName: string): Promise<string> {
    const dbDir = join(this.currentRunDir, dbName);
    await mkdir(dbDir, { recursive: true });
    return dbDir;
  }

  protected override async _createBsonWriteStream(
    dbName: string,
    collectionName: string,
  ): Promise<Writable> {
    const dbDir = await this.prepareDbDir(dbName);
    const suffix = this.compress ? ".gz" : "";
    const filepath = join(dbDir, `${collectionName}.bson${suffix}`);
    this.writtenFiles.add(filepath);
    return createWriteStream(filepath);
  }

  protected override async _createMetadataWriteStream(
    dbName: string,
    collectionName: string,
  ): Promise<Writable> {
    const dbDir = await this.prepareDbDir(dbName);
    const suffix = this.compress ? ".gz" : "";
    const filepath = join(dbDir, `${collectionName}.metadata.json${suffix}`);
    this.writtenFiles.add(filepath);
    return createWriteStream(filepath);
  }

  protected override async _createArchiveWriteStream(
    filename: string,
  ): Promise<Writable> {
    const suffix = this.compress && !filename.endsWith(".gz") ? ".gz" : "";
    const filepath = join(this.currentRunDir, `${filename}${suffix}`);
    this.writtenFiles.add(filepath);
    
    const fileStream = createWriteStream(filepath);
    
    if (this.compress) {
      const { createGzip } = await import("node:zlib");
      const gzipStream = createGzip();
      gzipStream.pipe(fileStream);
      
      // Propagate errors
      fileStream.on("error", (err) => gzipStream.destroy(err));
      
      return gzipStream;
    }
    
    return fileStream;
  }

  private async cleanupStaleFiles(dir: string): Promise<void> {
    try {
      const entries = await readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = join(dir, entry.name);
        if (entry.isDirectory()) {
          await this.cleanupStaleFiles(fullPath);
          // Delete directory if empty
          try {
            const children = await readdir(fullPath);
            if (children.length === 0) {
              await rm(fullPath, { recursive: true, force: true });
            }
          } catch (e) {
            // Ignore if directory doesn't exist anymore
          }
        } else if (entry.isFile()) {
          // Check if it's a backup file not written in this run
          if (!this.writtenFiles.has(fullPath)) {
            // Be safe, only delete .bson or .json or .gz files
            if (fullPath.includes('.bson') || fullPath.includes('.json') || fullPath.includes('.gz')) {
              await rm(fullPath, { force: true });
            }
          }
        }
      }
    } catch (err: any) {
      if (err.code !== "ENOENT") {
        throw new Error(`FileSystemProvider cleanup failed: ${err.message}`);
      }
    }
  }

  protected override async _finalize(): Promise<void> {
    if (this.disableRotation) {
      // Clean up any stale files from previous runs that were not overwritten
      await this.cleanupStaleFiles(this.currentRunDir);
    } else if (this.currentRunDir.endsWith(".tmp")) {
      const finalPath = this.currentRunDir.replace(/\.tmp$/, "");
      try {
        const { rename } = await import("node:fs/promises");
        await rename(this.currentRunDir, finalPath);
        this.currentRunDir = finalPath; // Update reference
      } catch (err: any) {
        throw new Error(
          `FileSystemProvider: Failed to finalize atomic backup: ${err.message}`,
        );
      }
    }
  }

  protected override async _prune(
    policy: PruningPolicy,
  ): Promise<PruningResult> {
    if (this.disableRotation) {
      return { deletedCount: 0, deletedPaths: [] };
    }

    const result: PruningResult = { deletedCount: 0, deletedPaths: [] };

    try {
      const entries = await readdir(this.baseOutPath, { withFileTypes: true });
      // Filter for backups (files or directories) and EXCLUDE the active run directory
      const backups = entries.filter((e) => {
        const fullPath = join(this.baseOutPath, e.name);
        // Matches YYYY-MM-DD_HH-mm-ss
        const isBackupFormat = /^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}/.test(e.name) || e.name.endsWith(".tmp");
        return isBackupFormat && fullPath !== this.currentRunDir;
      });

      // Get stats for all backups to sort them by creation time
      const backupStats = await Promise.all(
        backups.map(async (entry) => {
          const fullPath = join(this.baseOutPath, entry.name);
          const stats = await stat(fullPath);
          return { name: entry.name, path: fullPath, mtimeMs: stats.mtimeMs };
        }),
      );

      // Sort by name (alphabetical) - works perfectly for ISO timestamps
      backupStats.sort((a, b) => a.name.localeCompare(b.name));

      const toDelete = new Set<string>();

      // Identify completed backups vs stale temporary ones
      const completedBackups = backupStats.filter((d) => !d.name.endsWith(".tmp"));
      const staleTempBackups = backupStats.filter((d) => d.name.endsWith(".tmp"));

      // 1. Cleanup all stale temporary directories
      for (const stale of staleTempBackups) {
        toDelete.add(stale.path);
      }

      // 2. Apply retention policies to COMPLETED backups ONLY
      // Apply maxDays policy
      if (policy.strategy === "age" || policy.strategy === "both") {
        if (policy.maxDays && policy.maxDays > 0) {
          const cutoffTime = Date.now() - policy.maxDays * 24 * 60 * 60 * 1000;
          for (const dir of completedBackups) {
            if (dir.mtimeMs < cutoffTime) {
              toDelete.add(dir.path);
            }
          }
        }
      }

      // Apply maxCount policy
      if (policy.strategy === "count" || policy.strategy === "both") {
        if (policy.maxCount !== undefined) {
          const remainingCompleted = completedBackups.filter(
            (d) => !toDelete.has(d.path),
          );

          if (remainingCompleted.length > policy.maxCount) {
            const countToDelete = remainingCompleted.length - policy.maxCount;
            for (let i = 0; i < countToDelete; i++) {
              toDelete.add(remainingCompleted[i].path);
            }
          }
        }
      }

      // Delete identified directories
      for (const path of toDelete) {
        await rm(path, { recursive: true, force: true });
        result.deletedCount++;
        result.deletedPaths.push(path);
      }
    } catch (err: any) {
      if (err.code !== "ENOENT") {
        throw new Error(`FileSystemProvider pruning failed: ${err.message}`);
      }
    }

    return result;
  }
}
