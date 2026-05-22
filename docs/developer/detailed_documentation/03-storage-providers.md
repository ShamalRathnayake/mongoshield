# Chapter 3: Storage Providers & Network Adapters

Once the data is extracted, optionally compressed, and encrypted by the core engine, it must be stored. MongoShield abstracts storage behind the `StorageProvider` interface. This allows developers to write the core engine once and plug in different backends (Local Disk, AWS S3, Azure Blob, SFTP) without changing the engine's core code.

## 3.1 The Base Class: `AbstractStorageProvider.ts`

[`AbstractStorageProvider.ts`](../../../packages/core/src/providers/AbstractStorageProvider.ts) is the foundation that all providers inherit from. It enforces strict security and telemetry contracts so that individual providers don't have to implement them.

### Path Sanitization
```typescript
protected sanitizePath(input: string): void {
  if (!input || input.includes("/") || input.includes("\\") || input.includes("..")) {
    throw new Error(`Invalid path segment detected for security reasons: "${input}"`);
  }
}
```
**Logic Decision:**
When a user configures a backup for the `admin` database, that database name is used to create a folder (`./backups/admin/`). If a malicious user manipulated the MongoDB database name to be `../../../etc/`, the engine might try to write the backup to `/etc/shadow.bson`. This is a classic **Path Traversal Attack**. By hooking `sanitizePath` directly into the base class's `createBsonWriteStream` method, MongoShield mathematically guarantees that no child provider can ever be tricked into writing outside its intended directory sandbox.

### Stream Telemetry Injection
```typescript
private wrapWithTelemetry(destination: Writable): Writable {
  const passThrough = new PassThrough();
  passThrough.on("data", (chunk: Buffer) => {
    this.emit("progress", chunk.length);
  });
  passThrough.pipe(destination);
  return passThrough;
}
```
**Logic Decision:**
We want the main engine to log how many megabytes have been uploaded. However, if an S3 provider is just pushing bytes to a remote server, how does the engine know how fast it's going? The Abstract provider wraps every returned `Writable` stream inside a Node `PassThrough` stream. A `PassThrough` is essentially a transparent tube. The `AbstractStorageProvider` listens to the `"data"` events passing through the tube, measures the `chunk.length`, and emits a `"progress"` event. This is an elegant application of the **Decorator Pattern**.

## 3.2 Local Disk Deep Dive: `FileSystemProvider.ts`

[`FileSystemProvider.ts`](../../../packages/provider-local/src/FileSystemProvider.ts) handles writing backups to the local disk. Because local disks can run out of space and crash, this provider implements extreme filesystem safety mechanisms.

### 1. Pre-flight Disk Space Validation
```typescript
const stats = await statfs(this.baseOutPath);
const freeSpace = stats.bavail * stats.bsize;
if (freeSpace < expectedSizeInBytes) {
  throw new Error(`Insufficient disk space...`);
}
```
**Logic Decision:**
There is nothing worse than a 10-hour backup job failing in the 9th hour because the disk filled up. The `statfs` system call checks the operating system's filesystem block availability. By multiplying available blocks (`bavail`) by block size (`bsize`), MongoShield calculates the exact free bytes on the target drive *before* starting the stream pipeline. If there isn't enough room, the backup aborts instantly.

### 2. Atomic Directory Rotation
```typescript
this.currentRunDir = join(this.baseOutPath, `${timestamp}.tmp`);
await mkdir(this.currentRunDir, { recursive: true });

protected override async _finalize(): Promise<void> {
  const finalPath = this.currentRunDir.replace(/\.tmp$/, "");
  await rename(this.currentRunDir, finalPath);
}
```
**Logic Decision:**
When a backup starts, the provider streams all data into a temporary directory with a `.tmp` extension (e.g., `2026-05-20_15-30-00.tmp`). If the power goes out, or the Node process crashes mid-backup, the directory remains `.tmp`. Only when every collection has successfully finished streaming does `_finalize()` run, using `fs.rename` to remove the `.tmp` extension. In UNIX systems, `rename` is an **atomic operation**. This guarantees that any backup folder *without* a `.tmp` extension is mathematically proven to be 100% complete and uncorrupted.

### 3. Flat Directory Stale Cleanup
If a user selects `disableRotation: true`, MongoShield backs up directly into the base folder, overwriting previous files instead of creating timestamped subfolders.
```typescript
// Inside cleanupStaleFiles()
if (entry.isFile() && !this.writtenFiles.has(fullPath)) {
  if (fullPath.includes('.bson') || fullPath.includes('.json')) {
    await rm(fullPath, { force: true });
  }
}
```
**Logic Decision:**
If the database drops a collection named `users`, the next backup won't overwrite `users.bson`. That old file would sit there forever. To fix this, `FileSystemProvider` tracks every single stream it opens during the run in a `writtenFiles: Set<string>`. During finalize, it recursively reads the folder. Any `.bson` file that wasn't touched in the current run is declared "stale" and deleted!

### 4. Rigorous Pruning Policies
```typescript
// Sorting using localeCompare works perfectly for ISO dates!
backupStats.sort((a, b) => a.name.localeCompare(b.name));

const completedBackups = backupStats.filter((d) => !d.name.endsWith(".tmp"));
const staleTempBackups = backupStats.filter((d) => d.name.endsWith(".tmp"));

// Delete failed runs unconditionally
for (const stale of staleTempBackups) toDelete.add(stale.path);
```
**Logic Decision:**
The pruning engine reads all folders and sorts them. It applies a dual-stage cleanup:
1. It automatically deletes *all* `.tmp` folders (representing historical crashed runs).
2. It calculates `mtimeMs` (Modified Time) for completed folders. If they exceed `maxDays`, they are deleted.
3. If the remaining count exceeds `maxCount`, the oldest folders are deleted using `rm(path, { recursive: true })`.

## 3.3 Network Streaming Deep Dive: `SftpProvider.ts`

[`SftpProvider.ts`](../../../packages/provider-network/src/SftpProvider.ts) uses `ssh2` to stream files to remote legacy servers. SFTP is notoriously rigid, requiring complex workarounds.

### 1. The Recursive `mkdirp` Hack
```typescript
private async mkdirp(dirPath: string): Promise<void> {
  const parts = dirPath.split("/").filter(Boolean);
  let currentPath = "";
  
  for (const part of parts) {
    currentPath += part + "/";
    await new Promise<void>((resolve, reject) => {
      this.sftp!.mkdir(currentPath, (err) => {
        if (err && (err as any).code !== 4) reject(err); // Code 4 is "Failure" (often meaning it exists)
        else resolve();
      });
    });
  }
}
```
**Logic Decision:**
Unlike local filesystems (`fs.mkdir(path, { recursive: true })`), the raw SFTP protocol has **no support for recursive directory creation**. If you try to create `/a/b/c` and `/a` doesn't exist, it crashes. MongoShield manually splits the path string by `/` and loops through every segment sequentially, attempting to `mkdir()` at each level. It explicitly catches and ignores SSH Code 4 errors, which typically indicate the directory already exists.

### 2. Manual Recursive Directory Deletion
SFTP has no `rm -rf` equivalent. You cannot delete a folder if it has files inside it.
```typescript
private async rmdirRecursive(dirPath: string, result: PruningResult): Promise<void> {
  // 1. Read directory contents
  this.sftp!.readdir(dirPath, async (err, list) => {
    for (const item of list) {
      const fullPath = path.join(dirPath, item.filename);
      // 2. If it's a directory, dive deeper
      if (item.attrs.isDirectory()) {
        await this.rmdirRecursive(fullPath, result);
      } else {
        // 3. If it's a file, unlink it
        await new Promise((res, rej) => this.sftp!.unlink(fullPath, ...));
      }
    }
    // 4. Once all children are gone, delete the empty directory
    this.sftp!.rmdir(dirPath, ...);
  });
}
```
**Logic Decision:**
To implement the `maxDays` pruning policy over SFTP, MongoShield implements a depth-first search recursive algorithm. It reads a directory, recursively calls `rmdirRecursive` on subdirectories, calls `unlink` on raw files, and finally calls `rmdir` on the root once it is guaranteed to be empty.

## 3.4 The Interceptor Deep Dive: `ArchiveProvider.ts`

[`ArchiveProvider.ts`](../../../packages/core/src/providers/ArchiveProvider.ts) is **not a true storage provider**. It is a brilliant implementation of the **Adapter Pattern**. 

If the user wants to output a single monolithic `.archive` file instead of a sprawling folder of `.bson` files, `ArchiveProvider` intercepts the core engine's calls and funnels them through the MSAF multiplexer.

### 1. The Global Magic Header
```typescript
export const MSAF_MAGIC = Buffer.from("MSHLDARC", "utf8");
export const MSAF_VERSION = Buffer.from([0x01]);

// Inside _initialize:
this.archiveStream = await this.downstream.createArchiveWriteStream(this.archiveFilename);
const headerBuffer = Buffer.concat([MSAF_MAGIC, MSAF_VERSION]);
this.archiveStream.write(headerBuffer);
```
**Logic Decision:**
When `ArchiveProvider` initializes, it hijacks the downstream provider (like `S3Provider` or `FileSystemProvider`) by asking it to create just *one* file stream: `createArchiveWriteStream`. Before any collection data is written, it immediately pushes the `MSAF_MAGIC` bytes (`MSHLDARC`) and the version `0x01` directly to the stream. This allows the MongoShield restoration tool to instantly identify the file type and protocol version without reading the whole file.

### 2. Multiplex Delegation
```typescript
protected async _createBsonWriteStream(dbName: string, collectionName: string): Promise<Writable> {
  const name = `${dbName}.${collectionName}`;
  return new MultiplexWriteStream(this.archiveStream, CHUNK_TYPE_BSON, name);
}
```
**Logic Decision:**
Whenever the core engine asks for a collection stream, the `ArchiveProvider` hands it a `MultiplexWriteStream` (which we explored in Chapter 2). This forces all concurrent collections to wrap their chunks in MSAF headers and interleave their bytes safely into the *single* downstream archive stream. 

### 3. The EOF Marker & Delegation
```typescript
protected async _finalize(): Promise<void> {
  const eofHeader = Buffer.alloc(1 + 2 + 0 + 4);
  eofHeader.writeUInt8(CHUNK_TYPE_EOF, 0); // Type 0xff
  
  this.archiveStream!.end(eofHeader);
  await this.downstream.finalize();
}

protected async _prune(policy: PruningPolicy): Promise<PruningResult> {
  return this.downstream.prune(policy);
}
```
**Logic Decision:**
When the backup finishes, the `ArchiveProvider` explicitly writes a `CHUNK_TYPE_EOF` (0xff) marker to the binary stream. This tells the restorer that the archive successfully completed and wasn't truncated by a crash. Finally, notice how `_finalize` and `_prune` just call `this.downstream.finalize()` and `this.downstream.prune()`. The Adapter acts transparently, delegating the actual filesystem or cloud cleanup directly to the underlying provider!

## 3.5 AWS S3: `S3Provider.ts`

[`S3Provider.ts`](../../../packages/provider-s3/src/S3Provider.ts) pushes data to AWS S3, Cloudflare R2, or DigitalOcean Spaces.

### Streaming Without Content-Length
```typescript
const upload = new Upload({
  client: this.client,
  params: {
    Bucket: this.bucket,
    Key: finalKey,
    Body: passThrough,
  },
});
this.activeUploads.push(upload.done());
```
**Logic Decision:**
Standard REST APIs require a `Content-Length` header before an upload begins. Because MongoShield streams live cursors, the final backup size is unknown! The `@aws-sdk/lib-storage` `Upload` utility automatically intercepts the incoming stream, chunks it into 5MB parts, and initiates a **Multipart Upload**. It uploads the chunks in parallel and stitches them together on the AWS servers once the stream ends. We push the `upload.done()` promise into an array and wait for all parts to finish during `_finalize()`.

## 3.6 Microsoft Azure: `AzureProvider.ts`

[`AzureProvider.ts`](../../../packages/provider-microsoft/src/AzureProvider.ts) pushes data to Azure Blob Storage containers.

### Block Blob Streaming
```typescript
const blockBlobClient = this.containerClient.getBlockBlobClient(finalKey);
const uploadPromise = blockBlobClient.uploadStream(passThrough);
```
**Logic Decision:**
Similar to S3, Azure supports streaming via `uploadStream()`. Under the hood, this converts the continuous stream into discrete "Blocks". Once the stream finishes, Azure commits the block list, creating a single massive blob without ever loading it entirely into Node.js memory.

---

*This concludes Chapter 3. In the final chapter, we will examine the user-facing API wrapper and how the pieces are assembled into a unified library.*
