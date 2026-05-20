# Chapter 2: The Core Engine (`@mongoshield/core`)

The `@mongoshield/core` package is the brain of the backup utility. It handles connecting to MongoDB, querying collections, and building the complex transform streams that process the data on the fly. In this chapter, we will dissect the streaming orchestration layer line by logic-driven line.

## 2.1 The Orchestrator: `BackupEngine.ts`

[`BackupEngine.ts`](../../../packages/core/src/core/BackupEngine.ts) is the central coordinator. It is responsible for figuring out *what* to backup and orchestrating *how* the data flows from the database to the storage provider.

### Concurrency and Batching Logic
```typescript
const concurrencyLimit = this.config.output.numParallelCollections || 4;

for (let i = 0; i < collections.length; i += concurrencyLimit) {
  const batch = collections.slice(i, i + concurrencyLimit);

  await Promise.all(
    batch.map(async (col) => {
      await this.extractCollectionMetadata(dbName, db, col.name, signal);
      await this.extractCollectionBSON(dbName, db, col.name, signal);
    }),
  );
}
```
**Logic Decision:**
Instead of backing up collections one-by-one sequentially (which is slow) or firing off all collections concurrently (which crashes Node via OOM and overwhelms the DB cluster), the engine chunks the collections into batches of 4 (by default). The `for` loop acts as a synchronous gate, waiting for `Promise.all()` to finish processing the current 4 collections before moving to the next batch. This guarantees a bounded, constant memory ceiling regardless of whether the database has 10 collections or 10,000.

### Expected Size Calculation
```typescript
if (targetDbName) {
  const stats = await client.db(targetDbName).stats();
  expectedSizeInBytes += stats.dataSize || 0;
} else {
  // ... loop over admin().listDatabases() and sum sizeOnDisk
}
await this.storage.initialize(expectedSizeInBytes);
```
**Logic Decision:**
Storage providers (like S3 or local disk) often need to know if there is enough space *before* a 50GB backup starts, to prevent failing 99% of the way through. The engine queries MongoDB for `dataSize` or `sizeOnDisk`. This value isn't perfectly exact (since the backup will be compressed), but it serves as an upper-bound heuristic passed into `storage.initialize()`. If the disk has 5GB free and `expectedSizeInBytes` is 50GB, the process fails fast.

### Dynamic Pipeline Assembly
```typescript
const readStream = cursor.stream();
const bsonEncoder = new BSONEncoderStream();

const streams: any[] = [readStream, bsonEncoder];

if (this.config.output.gzip) streams.push(createGzip());
if (this.config.output.encryptionKey) streams.push(new EncryptionTransform(this.config.output.encryptionKey));

const writeStream = await this.storage.createBsonWriteStream(dbName, collectionName);
streams.push(writeStream);

if (signal) streams.push({ signal });

await pipeline(...streams);
```
**Logic Decision:**
This is the holy grail of MongoShield's architecture. Instead of hardcoding a massive, nested chain of `.pipe()` commands, the code constructs an array of stream instances dynamically based on the configuration. 
- The `cursor.stream()` outputs JavaScript objects.
- `BSONEncoderStream` converts them to binary buffers.
- Optional transforms (`createGzip` and `EncryptionTransform`) are conditionally injected into the array.
- Finally, the `pipeline` utility from `node:stream/promises` takes the array using spread syntax `...streams`. The `pipeline` function is vastly superior to `.pipe()` because it automatically propagates errors backward and forward through the chain, ensuring no memory leaks occur if a middle stream crashes.

## 2.2 The Object-to-Binary Bridge: `BSONEncoderStream.ts`

MongoDB's Node.js driver returns cursor data as parsed JavaScript objects. However, native MongoDB tools like `mongorestore` expect raw binary BSON files.

[`BSONEncoderStream.ts`](../../../packages/core/src/streams/BSONEncoderStream.ts) acts as the bridge.
```typescript
export class BSONEncoderStream extends Transform {
  constructor() {
    super({
      writableObjectMode: true, // We accept JS/BSON Document objects
      readableObjectMode: false, // We emit raw binary Buffers
    });
  }
}
```
**Logic Decision:**
Node.js Streams operate in binary by default. To accept JavaScript objects, a stream must explicitly declare `writableObjectMode: true`. Inside the stream's `_transform` function, `BSON.serialize(chunk)` is called. Because `readableObjectMode` is `false`, the stream successfully outputs pure `Buffer` chunks, seamlessly transitioning the data pipeline from "objects" to "network-ready bytes".

## 2.3 The Archive Protocol: `MultiplexWriteStream.ts`

When a user requests to backup their database into a *single file* (rather than a folder of files), MongoShield utilizes a custom protocol: The MongoShield Archive Format (MSAF).

[`MultiplexWriteStream.ts`](../../../packages/core/src/streams/MultiplexWriteStream.ts) handles the complex task of interleaving multiple concurrent collection streams into a single writable destination stream.

### The Atomic MSAF Header
If Collection A and Collection B are piping data into the same file simultaneously, how does the restorer know which byte belongs to which collection?
```typescript
// Header layout:
// Type (1 byte)
// Name Length (2 bytes, UInt16LE)
// Name (N bytes)
// Payload Length (4 bytes, UInt32LE)

const header = Buffer.alloc(1 + 2 + this.nameBuffer.length + 4);
header.writeUInt8(this.chunkType, 0);
header.writeUInt16LE(this.nameBuffer.length, 1);
this.nameBuffer.copy(header, 3);
header.writeUInt32LE(payload.length, 3 + this.nameBuffer.length);

const atomicChunk = Buffer.concat([header, payload]);
```
**Logic Decision:**
Every single chunk of data is prefixed with a binary header. The header declares the target collection's name and the exact length of the upcoming payload.
Crucially, `Buffer.concat([header, payload])` binds them together into an `atomicChunk` *before* calling `destination.write()`. If we called `write(header)` and then `write(payload)`, Node.js could theoretically intercept the stream and inject a chunk from Collection B right in between them, permanently corrupting the archive. Concatenation guarantees atomicity.

### Deep Backpressure Handshakes
```typescript
const canContinue = this.destination.write(atomicChunk);

if (!canContinue) {
  // Handle backpressure
  this.destination.once("drain", callback);
} else {
  callback();
}
```
**Logic Decision:**
If the shared destination (like a slow Network drive) is saturated, `write()` returns `false`. By hooking into the destination's `"drain"` event, the `MultiplexWriteStream` pauses its own upstream MongoDB cursor until the network drive has emptied its buffer. This is how MongoShield prevents Out-of-Memory (OOM) crashes across multiplexed pipelines.

## 2.4 Streaming Cryptography: `EncryptionStream.ts`

[`EncryptionStream.ts`](../../../packages/core/src/streams/EncryptionStream.ts) implements military-grade AES-256-GCM encryption on the fly. Cryptography is incredibly easy to get wrong. Let's look at how MongoShield prevents key reuse and guarantees integrity.

### HKDF Key Derivation and Salt Injection
```typescript
this.salt = randomBytes(32);
const streamKey = hkdfSync(
  "sha256",
  masterKeyBuffer,
  this.salt,
  "mongoshield-stream-key",
  32,
);
this.iv = randomBytes(12);
this.cipher = createCipheriv("aes-256-gcm", Buffer.from(streamKey), this.iv);
```
**Logic Decision:**
- **The Problem:** In AES-GCM, if you encrypt two different files using the exact same Key and the exact same Initialization Vector (IV), an attacker can easily crack the cipher. 
- **The Solution:** The user provides a static "Master Key". However, we *never* use the Master Key directly in the cipher! For every single collection stream, we generate a random 32-byte `salt`. We use the **HMAC-based Extract-and-Expand Key Derivation Function (HKDF)** to mix the Master Key and the Salt into a unique, mathematically isolated 32-byte `streamKey`. Even if a user never rotates their Master Key, every backup stream is encrypted with a completely unique key.

### Stream Protocol Design
```typescript
if (this.isFirstChunk) {
  this.push(this.salt);
  this.push(this.iv);
  this.isFirstChunk = false;
}
```
**Logic Decision:**
Because we generated a random `salt` and a random `iv`, the decryption process needs to know what they are to derive the same key. By prepending the 32-byte salt and the 12-byte IV directly to the first chunk of the binary stream, they are stored at the exact head of the resulting backup file. During restoration, the restorer simply reads the first 44 bytes to reconstruct the cryptographic state.

### Auth Tag Finalization (AEAD)
```typescript
public override _flush(callback: TransformCallback): void {
  // ... final cipher push
  const authTag = (this.cipher as any).getAuthTag();
  this.push(authTag);
}
```
**Logic Decision:**
AES-GCM is an Authenticated cipher. It computes a 16-byte authentication tag based on the encrypted data. If a single byte is flipped (by a network error or a hacker), the tag won't match during decryption. Because this is a *stream*, the tag is only computed after the *last* byte of data has passed through the cipher. The `_flush` method is called when the upstream cursor ends. We extract the `authTag` and append it directly to the tail of the stream.

## 2.5 Connection Management: `ConnectionManager.ts`

[`ConnectionManager.ts`](../../../packages/core/src/db/ConnectionManager.ts) is responsible for turning the user's config object into a valid MongoDB connection string and managing the lifecycle of the `MongoClient`.

### Connection String Assembly
```typescript
let uri = `mongodb://${credentials}${host}:${port}`;
const queryParams = new URLSearchParams();

if (authenticationDatabase) queryParams.set("authSource", authenticationDatabase);
if (authenticationMechanism) queryParams.set("authMechanism", authenticationMechanism);

const qs = queryParams.toString();
if (qs) {
  uri += `/?${qs}`;
}
```
**Logic Decision:**
Rather than relying solely on the MongoDB Node Driver's options object, the code manually assembles the `mongodb://` URI using Node's native `URLSearchParams`. 
- **Why?** It ensures consistent escaping and URL-encoding of special characters. For example, if a user's password contains an `@` or `#` symbol, `encodeURIComponent` properly sanitizes it, preventing URI parsing errors. By pushing parameters like `authSource` into the query string, the driver can natively parse the URI exactly as it would for a standard connection string used in a CLI tool like `mongosh`.

---

*This concludes Chapter 2. In the next chapter, we will examine the storage interface, specifically looking at how providers write and rotate files safely.*
