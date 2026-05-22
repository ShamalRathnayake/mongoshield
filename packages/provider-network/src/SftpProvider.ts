import path from "node:path/posix";
import { PassThrough, type Writable } from "node:stream";
import {
  AbstractStorageProvider,
  type PruningPolicy,
  type PruningResult,
} from "@mongoshield/core";
import { Client, type ConnectConfig, type SFTPWrapper } from "ssh2";

export interface SftpProviderOptions extends ConnectConfig {
  basePath?: string;
  compress?: boolean;
}

export class SftpProvider extends AbstractStorageProvider {
  private client: Client;
  private sftp: SFTPWrapper | null = null;
  private connectConfig: ConnectConfig;
  private basePath: string;
  private currentRunPrefix: string;
  public readonly compress: boolean;
  private activeUploads: Promise<void>[] = [];

  constructor(options: SftpProviderOptions) {
    super();
    const { basePath, compress, ...connectConfig } = options;
    this.connectConfig = connectConfig;
    this.compress = compress ?? false;

    // Normalize base path
    this.basePath = basePath || "/backups";
    if (this.basePath && !this.basePath.endsWith("/")) {
      this.basePath += "/";
    }

    this.client = new Client();
    this.currentRunPrefix = "";
  }

  protected override async _initialize(
    _expectedSizeInBytes?: number,
  ): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.client.on("ready", () => {
        this.client.sftp((err, sftp) => {
          if (err) {
            reject(new Error(`SFTP subsystem failed: ${err.message}`));
            return;
          }
          this.sftp = sftp;
          resolve();
        });
      });
      this.client.on("error", (err) => {
        reject(new Error(`SSH connection failed: ${err.message}`));
      });
      this.client.connect(this.connectConfig);
    });

    if (!this.sftp) {
      throw new Error("SFTP session is not established.");
    }

    // Ensure base directory exists
    await this.mkdirp(this.basePath);

    if (!this.currentRunPrefix) {
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
      this.currentRunPrefix = `${this.basePath}${timestamp}/`;
      await this.mkdirp(this.currentRunPrefix);
    }
  }

  private async mkdirp(dirPath: string): Promise<void> {
    if (!this.sftp) throw new Error("SFTP session is not established.");

    const parts = dirPath.split("/").filter(Boolean);
    let currentPath = dirPath.startsWith("/") ? "/" : "";

    for (const part of parts) {
      currentPath += `${part}/`;
      try {
        await new Promise<void>((resolve, reject) => {
          this.sftp?.mkdir(currentPath, (err) => {
            // Ignore if directory already exists
            if (err && (err as any).code !== 4) {
              // SSH_FX_FAILURE usually, code 4 is failure but could be file exists
              reject(err);
            } else {
              resolve();
            }
          });
        });
      } catch (err: any) {
        // Double check if it's a directory
        await new Promise<void>((resolve, reject) => {
          this.sftp?.stat(currentPath, (statErr, stats) => {
            if (statErr || !stats.isDirectory()) {
              reject(
                new Error(
                  `Failed to create directory ${currentPath}: ${err.message}`,
                ),
              );
            } else {
              resolve();
            }
          });
        });
      }
    }
  }

  private async createUploadStream(filePath: string): Promise<Writable> {
    if (!this.sftp) throw new Error("SFTP session is not established.");

    const dir = path.dirname(filePath);
    await this.mkdirp(dir);

    const finalPath =
      this.compress && !filePath.endsWith(".gz") ? `${filePath}.gz` : filePath;
    const writeStream = this.sftp.createWriteStream(finalPath);
    const passThrough = new PassThrough();

    const uploadPromise = new Promise<void>((resolve, reject) => {
      writeStream.on("close", () => resolve());
      writeStream.on("error", (err: Error) => reject(err));
      passThrough.on("error", (err: Error) => {
        writeStream.destroy();
        reject(err);
      });
    });

    this.activeUploads.push(uploadPromise);
    passThrough.pipe(writeStream);

    return passThrough;
  }

  protected override async _createBsonWriteStream(
    dbName: string,
    collectionName: string,
  ): Promise<Writable> {
    const key = `${this.currentRunPrefix}${dbName}/${collectionName}.bson`;
    return this.createUploadStream(key);
  }

  protected override async _createMetadataWriteStream(
    dbName: string,
    collectionName: string,
  ): Promise<Writable> {
    const key = `${this.currentRunPrefix}${dbName}/${collectionName}.metadata.json`;
    return this.createUploadStream(key);
  }

  protected override async _createArchiveWriteStream(
    archiveName: string,
  ): Promise<Writable> {
    const key = `${this.currentRunPrefix}${archiveName}`;
    const uploadStream = await this.createUploadStream(key);

    if (this.compress) {
      const { createGzip } = await import("node:zlib");
      const gzipStream = createGzip();
      gzipStream.pipe(uploadStream);

      uploadStream.on("error", (err) => gzipStream.destroy(err));

      return gzipStream;
    }

    return uploadStream;
  }

  protected override async _finalize(): Promise<void> {
    await Promise.all(this.activeUploads);
    this.activeUploads = [];

    if (this.sftp) {
      await new Promise<void>((resolve) => {
        // No explicit close for sftp in ssh2 usually, we just end the client
        resolve();
      });
    }

    this.client.end();
  }

  private async rmdirRecursive(
    dirPath: string,
    result: PruningResult,
  ): Promise<void> {
    if (!this.sftp) return;

    return new Promise((resolve, reject) => {
      this.sftp?.readdir(dirPath, async (err, list) => {
        if (err) {
          if ((err as any).code === 2) return resolve(); // SSH_FX_NO_SUCH_FILE
          return reject(err);
        }

        for (const item of list) {
          const fullPath = path.join(dirPath, item.filename);
          if (item.attrs.isDirectory()) {
            await this.rmdirRecursive(fullPath, result);
          } else {
            await new Promise<void>((res, rej) => {
              this.sftp?.unlink(fullPath, (unlinkErr) => {
                if (unlinkErr) return rej(unlinkErr);
                result.deletedCount++;
                result.deletedPaths.push(`sftp://${fullPath}`);
                res();
              });
            });
          }
        }

        this.sftp?.rmdir(dirPath, (rmdirErr) => {
          if (rmdirErr) return reject(rmdirErr);
          result.deletedCount++;
          result.deletedPaths.push(`sftp://${dirPath}`);
          resolve();
        });
      });
    });
  }

  protected override async _prune(
    policy: PruningPolicy,
  ): Promise<PruningResult> {
    const result: PruningResult = { deletedCount: 0, deletedPaths: [] };
    if (!policy.maxCount && !policy.maxDays) {
      return result;
    }
    if (!this.sftp) return result;

    const list = await new Promise<any[]>((resolve, reject) => {
      this.sftp?.readdir(this.basePath, (err, items) => {
        if (err) {
          if ((err as any).code === 2) return resolve([]);
          return reject(err);
        }
        resolve(items);
      });
    });

    const runs: { prefix: string; date: Date }[] = [];

    for (const item of list) {
      if (!item.attrs.isDirectory()) continue;

      const match = item.filename.match(
        /(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)/,
      );
      if (match) {
        const isoFormat = `${match[1].substring(0, 13)}:${match[1].substring(14, 16)}:${match[1].substring(17, 19)}.${match[1].substring(20, 23)}Z`;
        const date = new Date(isoFormat);
        const fullPrefix = `${this.basePath}${item.filename}/`;
        if (
          !Number.isNaN(date.getTime()) &&
          fullPrefix !== this.currentRunPrefix
        ) {
          runs.push({ prefix: fullPrefix, date });
        }
      }
    }

    runs.sort((a, b) => b.date.getTime() - a.date.getTime()); // Newest first

    const runsToDelete = new Set<string>();

    if (policy.maxCount !== undefined && policy.maxCount > 0) {
      const excessRuns = runs.slice(policy.maxCount);
      for (const run of excessRuns) {
        runsToDelete.add(run.prefix);
      }
    }

    if (policy.maxDays !== undefined && policy.maxDays > 0) {
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - policy.maxDays);
      for (const run of runs) {
        if (run.date < cutoffDate) {
          runsToDelete.add(run.prefix);
        }
      }
    }

    if (runsToDelete.size === 0) return result;

    for (const prefixToDelete of runsToDelete) {
      try {
        await this.rmdirRecursive(prefixToDelete, result);
      } catch (_err) {
        // Ignore deletion errors for individual runs, continue pruning
      }
    }

    return result;
  }
}
