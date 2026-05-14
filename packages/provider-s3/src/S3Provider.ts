import { PassThrough, type Writable } from "node:stream";
import {
  S3Client,
  type S3ClientConfig,
  HeadBucketCommand,
  ListObjectsV2Command,
  DeleteObjectsCommand,
} from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import {
  AbstractStorageProvider,
  type PruningPolicy,
  type PruningResult,
} from "@mongoshield/core";

export interface S3ProviderOptions extends S3ClientConfig {
  bucket: string;
  prefix?: string;
  compress?: boolean;
}

export class S3Provider extends AbstractStorageProvider {
  private client: S3Client;
  private bucket: string;
  private basePrefix: string;
  private currentRunPrefix: string;
  public readonly compress: boolean;
  private activeUploads: Promise<any>[] = [];

  constructor(options: S3ProviderOptions) {
    super();
    this.bucket = options.bucket;
    
    // Normalize base prefix
    this.basePrefix = options.prefix || "backups/";
    if (this.basePrefix && !this.basePrefix.endsWith("/")) {
      this.basePrefix += "/";
    }
    
    this.compress = options.compress ?? false;

    const { bucket, prefix, compress, ...clientConfig } = options;
    this.client = new S3Client(clientConfig);
    this.currentRunPrefix = "";
  }

  protected override async _initialize(expectedSizeInBytes?: number): Promise<void> {
    try {
      // 1. Verify Bucket Access
      await this.client.send(
        new HeadBucketCommand({
          Bucket: this.bucket,
        })
      );
    } catch (error: any) {
      if (error.name === "NotFound") {
        throw new Error(`S3Provider: Bucket "${this.bucket}" does not exist.`);
      }
      if (error.name === "Forbidden") {
        throw new Error(`S3Provider: Access denied to bucket "${this.bucket}". Check your credentials.`);
      }
      throw error;
    }

    // 2. Generate a timestamped run prefix if not already set (for idempotency)
    if (!this.currentRunPrefix) {
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
      this.currentRunPrefix = `${this.basePrefix}${timestamp}/`;
    }
  }

  private createUploadStream(key: string): Writable {
    const passThrough = new PassThrough();
    
    // Check if we need to append .gz
    const suffix = this.compress && !key.endsWith(".gz") ? ".gz" : "";
    const finalKey = `${key}${suffix}`;

    const upload = new Upload({
      client: this.client,
      params: {
        Bucket: this.bucket,
        Key: finalKey,
        Body: passThrough,
      },
    });

    // Track the upload promise so we can wait for it during finalize()
    const uploadPromise = upload.done().catch((err) => {
      // Propagate unhandled upload errors back to the pipeline if needed
      passThrough.destroy(err);
      throw err;
    });
    
    this.activeUploads.push(uploadPromise);

    return passThrough;
  }

  protected override async _createBsonWriteStream(
    dbName: string,
    collectionName: string
  ): Promise<Writable> {
    const key = `${this.currentRunPrefix}${dbName}/${collectionName}.bson`;
    return this.createUploadStream(key);
  }

  protected override async _createMetadataWriteStream(
    dbName: string,
    collectionName: string
  ): Promise<Writable> {
    const key = `${this.currentRunPrefix}${dbName}/${collectionName}.metadata.json`;
    return this.createUploadStream(key);
  }

  protected override async _createArchiveWriteStream(
    filename: string
  ): Promise<Writable> {
    const key = `${this.currentRunPrefix}${filename}`;
    const fileStream = this.createUploadStream(key);

    if (this.compress) {
      const { createGzip } = await import("node:zlib");
      const gzipStream = createGzip();
      gzipStream.pipe(fileStream);

      fileStream.on("error", (err) => gzipStream.destroy(err));

      return gzipStream;
    }

    return fileStream;
  }

  protected override async _finalize(): Promise<void> {
    // Await all background S3 multipart uploads to finish
    await Promise.all(this.activeUploads);
    this.activeUploads = [];
  }

  protected override async _prune(policy: PruningPolicy): Promise<PruningResult> {
    if (policy.strategy === "count" && policy.maxCount === 0) {
      return { deletedCount: 0, deletedPaths: [] };
    }

    // List all "directories" (prefixes) under the basePrefix
    // Note: S3 ListObjectsV2 with Delimiter='/' will return CommonPrefixes
    const prefixes = await this.listAllRunPrefixes();

    if (prefixes.length === 0) {
      return { deletedCount: 0, deletedPaths: [] };
    }

    // Sort ascending by time (oldest first)
    // Prefixes are usually formatted as backups/YYYY-MM-DDTHH-mm-ss-mmmZ/
    // Since ISO strings are lexically sortable, standard sort works perfectly
    prefixes.sort();

    const toDeletePrefixes: string[] = [];

    // Filter by age (maxDays)
    if (policy.strategy === "age" || policy.strategy === "both") {
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - (policy.maxDays || 0));

      for (const prefix of prefixes) {
        // Attempt to extract the date from the prefix string
        const match = prefix.match(/(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)/);
        if (match) {
          // Actually, our format is: new Date().toISOString().replace(/[:.]/g, "-")
          // Reconstructing valid Date string is complex. Let's just use simple time extraction.
          // Format: 2026-05-14T11-00-00-000Z -> 2026-05-14T11:00:00.000Z
          const isoFormat = match[1].substring(0, 13) + ":" + match[1].substring(14, 16) + ":" + match[1].substring(17, 19) + "." + match[1].substring(20, 23) + "Z";
          const d = new Date(isoFormat);
          if (d < cutoffDate && prefix !== this.currentRunPrefix) {
            toDeletePrefixes.push(prefix);
          }
        }
      }
    }

    // Filter by count (maxCount)
    if (policy.strategy === "count" || policy.strategy === "both") {
      const maxCount = policy.maxCount || 0;
      // We must only count completed backups, so we don't prune the current active run
      const completedPrefixes = prefixes.filter(p => p !== this.currentRunPrefix);
      
      // Calculate remaining items after age pruning
      const remainingPrefixes = completedPrefixes.filter(p => !toDeletePrefixes.includes(p));

      if (remainingPrefixes.length > maxCount) {
        const excessCount = remainingPrefixes.length - maxCount;
        const excessPrefixes = remainingPrefixes.slice(0, excessCount);
        for (const excess of excessPrefixes) {
          if (!toDeletePrefixes.includes(excess)) {
            toDeletePrefixes.push(excess);
          }
        }
      }
    }

    if (toDeletePrefixes.length === 0) {
      return { deletedCount: 0, deletedPaths: [] };
    }

    let totalDeleted = 0;
    const deletedPaths: string[] = [];

    // Delete all objects under each prefix
    for (const prefixToDelete of toDeletePrefixes) {
      const keysToDelete = await this.listAllObjectsWithPrefix(prefixToDelete);
      
      if (keysToDelete.length > 0) {
        // Delete in batches of 1000 (S3 limit)
        for (let i = 0; i < keysToDelete.length; i += 1000) {
          const batch = keysToDelete.slice(i, i + 1000).map(key => ({ Key: key }));
          
          await this.client.send(
            new DeleteObjectsCommand({
              Bucket: this.bucket,
              Delete: {
                Objects: batch,
                Quiet: true
              }
            })
          );
        }
        totalDeleted++;
        deletedPaths.push(`s3://${this.bucket}/${prefixToDelete}`);
      }
    }

    return { deletedCount: totalDeleted, deletedPaths };
  }

  private async listAllRunPrefixes(): Promise<string[]> {
    const prefixes: string[] = [];
    let continuationToken: string | undefined;

    do {
      const response = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: this.basePrefix,
          Delimiter: "/",
          ContinuationToken: continuationToken,
        })
      );

      if (response.CommonPrefixes) {
        for (const commonPrefix of response.CommonPrefixes) {
          if (commonPrefix.Prefix) {
            prefixes.push(commonPrefix.Prefix);
          }
        }
      }
      
      continuationToken = response.NextContinuationToken;
    } while (continuationToken);

    return prefixes;
  }

  private async listAllObjectsWithPrefix(prefix: string): Promise<string[]> {
    const keys: string[] = [];
    let continuationToken: string | undefined;

    do {
      const response = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: prefix,
          ContinuationToken: continuationToken,
        })
      );

      if (response.Contents) {
        for (const object of response.Contents) {
          if (object.Key) {
            keys.push(object.Key);
          }
        }
      }

      continuationToken = response.NextContinuationToken;
    } while (continuationToken);

    return keys;
  }
}
