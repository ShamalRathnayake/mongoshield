import { PassThrough, type Writable } from "node:stream";
import {
  type Bucket,
  Storage,
  type StorageOptions,
} from "@google-cloud/storage";
import {
  AbstractStorageProvider,
  type PruningPolicy,
  type PruningResult,
} from "@mongoshield/core";

export interface GoogleProviderOptions extends StorageOptions {
  bucket: string;
  prefix?: string;
  compress?: boolean;
}

export class GoogleProvider extends AbstractStorageProvider {
  private client: Storage;
  private bucket: Bucket;
  private basePrefix: string;
  private currentRunPrefix: string;
  public readonly compress: boolean;
  private activeUploads: Promise<void>[] = [];

  constructor(options: GoogleProviderOptions) {
    super();
    this.compress = options.compress ?? false;

    // Normalize base prefix
    this.basePrefix = options.prefix || "backups/";
    if (this.basePrefix && !this.basePrefix.endsWith("/")) {
      this.basePrefix += "/";
    }

    const { bucket, prefix, compress, ...clientConfig } = options;
    this.client = new Storage(clientConfig);
    this.bucket = this.client.bucket(bucket);
    this.currentRunPrefix = "";
  }

  protected override async _initialize(
    _expectedSizeInBytes?: number,
  ): Promise<void> {
    try {
      const [exists] = await this.bucket.exists();
      if (!exists) {
        throw new Error(`GCS bucket '${this.bucket.name}' does not exist.`);
      }
    } catch (err: any) {
      if (err.message?.includes("does not exist")) {
        throw err;
      }
      if (
        err.code === 403 ||
        err.message?.includes("Forbidden") ||
        err.message?.includes("access is denied") ||
        err.message?.includes("does not have storage.buckets.get access")
      ) {
        throw new Error(
          `Access denied to GCS bucket '${this.bucket.name}'. Check your Service Account credentials and IAM permissions.`,
        );
      }
      throw err;
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    this.currentRunPrefix = `${this.basePrefix}${timestamp}/`;
  }

  private createGcsWriteStream(key: string): Writable {
    const file = this.bucket.file(key);
    const writeStream = file.createWriteStream({
      resumable: true,
      validation: "md5",
    });

    const uploadPromise = new Promise<void>((resolve, reject) => {
      writeStream.on("finish", () => resolve());
      writeStream.on("error", (err) => reject(err));
    });

    this.activeUploads.push(uploadPromise);
    return writeStream;
  }

  protected override async _createBsonWriteStream(
    dbName: string,
    collectionName: string,
  ): Promise<Writable> {
    let key = `${this.currentRunPrefix}${dbName}/${collectionName}.bson`;
    if (this.compress) key += ".gz";

    const passThrough = new PassThrough();
    const gcsStream = this.createGcsWriteStream(key);
    passThrough.pipe(gcsStream);

    return passThrough;
  }

  protected override async _createMetadataWriteStream(
    dbName: string,
    collectionName: string,
  ): Promise<Writable> {
    const key = `${this.currentRunPrefix}${dbName}/${collectionName}.metadata.json`;

    const passThrough = new PassThrough();
    const gcsStream = this.createGcsWriteStream(key);
    passThrough.pipe(gcsStream);

    return passThrough;
  }

  protected override async _createArchiveWriteStream(
    archiveName: string,
  ): Promise<Writable> {
    let key = `${this.currentRunPrefix}${archiveName}`;
    if (this.compress) key += ".gz";

    const passThrough = new PassThrough();
    const gcsStream = this.createGcsWriteStream(key);
    passThrough.pipe(gcsStream);

    return passThrough;
  }

  protected override async _finalize(): Promise<void> {
    await Promise.all(this.activeUploads);
  }

  protected override async _prune(
    policy: PruningPolicy,
  ): Promise<PruningResult> {
    const result: PruningResult = { deletedCount: 0, deletedPaths: [] };
    if (!policy.maxCount && !policy.maxDays) {
      return result;
    }

    // Google Cloud Storage doesn't have true directories. We use a delimiter to find "subdirectories" (run prefixes)
    const [_, __, apiResponse] = await this.bucket.getFiles({
      prefix: this.basePrefix,
      delimiter: "/",
    });

    const prefixes = (apiResponse as any).prefixes || [];
    if (prefixes.length === 0) return result;

    const runs: { prefix: string; date: Date }[] = [];

    for (const prefix of prefixes) {
      const match = prefix.match(
        /(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)/,
      );
      if (match) {
        const isoFormat = `${match[1].substring(0, 13)}:${match[1].substring(14, 16)}:${match[1].substring(17, 19)}.${match[1].substring(20, 23)}Z`;
        const date = new Date(isoFormat);
        if (!Number.isNaN(date.getTime())) {
          runs.push({ prefix, date });
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

    // Delete objects matching prefixes
    // To be safer and more efficient, we could gather promises, but deleting sequentially or limited concurrency is fine
    // Or we could run them in parallel
    const deletePromises = [];
    for (const prefixToDelete of runsToDelete) {
      const [filesToDelete] = await this.bucket.getFiles({
        prefix: prefixToDelete,
      });
      for (const file of filesToDelete) {
        result.deletedPaths.push(file.name);
        result.deletedCount++;
        deletePromises.push(file.delete().catch(() => {})); // Ignore individual delete errors if they were already deleted
      }
    }

    await Promise.all(deletePromises);

    return result;
  }
}
