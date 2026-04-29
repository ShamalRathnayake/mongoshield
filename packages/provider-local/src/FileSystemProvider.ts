import { createWriteStream } from "node:fs";
import { mkdir, readdir, rm, stat } from "node:fs/promises";
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

  protected override async _initialize(): Promise<void> {
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
    return createWriteStream(filepath);
  }

  protected override async _createMetadataWriteStream(
    dbName: string,
    collectionName: string,
  ): Promise<Writable> {
    const dbDir = await this.prepareDbDir(dbName);
    const suffix = this.compress ? ".gz" : "";
    const filepath = join(dbDir, `${collectionName}.metadata.json${suffix}`);
    return createWriteStream(filepath);
  }

  protected override async _finalize(): Promise<void> {
    if (!this.disableRotation && this.currentRunDir.endsWith(".tmp")) {
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
      // Filter for directories and EXCLUDE the active run directory
      const directories = entries.filter((e) => {
        const fullPath = join(this.baseOutPath, e.name);
        return e.isDirectory() && fullPath !== this.currentRunDir;
      });

      // Get stats for all directories to sort them by creation time
      const dirStats = await Promise.all(
        directories.map(async (dir) => {
          const fullPath = join(this.baseOutPath, dir.name);
          const stats = await stat(fullPath);
          return { name: dir.name, path: fullPath, mtimeMs: stats.mtimeMs };
        }),
      );

      // Sort by name (alphabetical) - works perfectly for ISO timestamps
      dirStats.sort((a, b) => a.name.localeCompare(b.name));

      const toDelete = new Set<string>();

      // Identify completed backups vs stale temporary ones
      const completedBackups = dirStats.filter((d) => !d.name.endsWith(".tmp"));
      const staleTempBackups = dirStats.filter((d) => d.name.endsWith(".tmp"));

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
