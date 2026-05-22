import { PassThrough, type Writable } from "node:stream";
import { BlobServiceClient, type ContainerClient } from "@azure/storage-blob";
import {
  AbstractStorageProvider,
  type PruningPolicy,
  type PruningResult,
} from "@mongoshield/core";

export interface AzureProviderOptions {
  connectionString: string;
  container: string;
  prefix?: string;
  compress?: boolean;
}

export class AzureProvider extends AbstractStorageProvider {
  private blobServiceClient: BlobServiceClient;
  private containerClient: ContainerClient;
  private containerName: string;
  private basePrefix: string;
  private currentRunPrefix: string;
  public readonly compress: boolean;
  private activeUploads: Promise<any>[] = [];

  constructor(options: AzureProviderOptions) {
    super();
    this.compress = options.compress ?? false;
    this.containerName = options.container;

    // Normalize base prefix
    this.basePrefix = options.prefix || "backups/";
    if (this.basePrefix && !this.basePrefix.endsWith("/")) {
      this.basePrefix += "/";
    }

    this.blobServiceClient = BlobServiceClient.fromConnectionString(
      options.connectionString,
    );
    this.containerClient = this.blobServiceClient.getContainerClient(
      this.containerName,
    );
    this.currentRunPrefix = "";
  }

  protected override async _initialize(
    _expectedSizeInBytes?: number,
  ): Promise<void> {
    try {
      const exists = await this.containerClient.exists();
      if (!exists) {
        throw new Error(
          `Azure container '${this.containerName}' does not exist.`,
        );
      }
    } catch (err: any) {
      if (
        err.statusCode === 403 ||
        err.message?.includes("AuthorizationFailure")
      ) {
        throw new Error(
          `Access denied to Azure container '${this.containerName}'. Check your connection string and permissions.`,
        );
      }
      throw err;
    }

    if (!this.currentRunPrefix) {
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
      this.currentRunPrefix = `${this.basePrefix}${timestamp}/`;
    }
  }

  private createUploadStream(key: string): Writable {
    const passThrough = new PassThrough();
    const finalKey = this.compress && !key.endsWith(".gz") ? `${key}.gz` : key;

    const blockBlobClient = this.containerClient.getBlockBlobClient(finalKey);

    // uploadStream takes (stream, bufferSize, maxBuffers)
    // passThrough acts as a Readable stream for Azure
    const uploadPromise = blockBlobClient
      .uploadStream(passThrough)
      .catch((err) => {
        passThrough.destroy(err);
        throw err;
      });

    this.activeUploads.push(uploadPromise);
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
    const uploadStream = this.createUploadStream(key);

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
  }

  protected override async _prune(
    policy: PruningPolicy,
  ): Promise<PruningResult> {
    const result: PruningResult = { deletedCount: 0, deletedPaths: [] };
    if (!policy.maxCount && !policy.maxDays) {
      return result;
    }

    // List blobs by hierarchy to find run prefixes (simulating directories)
    const prefixes: string[] = [];
    for await (const item of this.containerClient.listBlobsByHierarchy("/", {
      prefix: this.basePrefix,
    })) {
      if (item.kind === "prefix") {
        prefixes.push(item.name);
      }
    }

    if (prefixes.length === 0) return result;

    const runs: { prefix: string; date: Date }[] = [];

    for (const prefix of prefixes) {
      const match = prefix.match(
        /(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)/,
      );
      if (match) {
        // Format: 2026-05-14T11-00-00-000Z -> 2026-05-14T11:00:00.000Z
        const isoFormat = `${match[1].substring(0, 13)}:${match[1].substring(14, 16)}:${match[1].substring(17, 19)}.${match[1].substring(20, 23)}Z`;
        const date = new Date(isoFormat);
        if (!Number.isNaN(date.getTime()) && prefix !== this.currentRunPrefix) {
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

    if (runsToDelete.size === 0) return result;

    const deletePromises: Promise<any>[] = [];

    // Iterate over each prefix to delete and collect all underlying blobs
    for (const prefixToDelete of runsToDelete) {
      // Azure requires deleting each blob individually; there is no bulk delete by prefix directly,
      // but we can batch the requests using BlobBatchClient if we wanted to.
      // For simplicity and to avoid another dependency/complex setup, we'll list and delete individually.
      for await (const blob of this.containerClient.listBlobsFlat({
        prefix: prefixToDelete,
      })) {
        const blockBlobClient = this.containerClient.getBlockBlobClient(
          blob.name,
        );
        result.deletedPaths.push(`azure://${this.containerName}/${blob.name}`);
        result.deletedCount++;
        // Catch and ignore individual delete errors to proceed with as many as possible
        deletePromises.push(blockBlobClient.delete().catch(() => {}));
      }
    }

    await Promise.all(deletePromises);

    return result;
  }
}
