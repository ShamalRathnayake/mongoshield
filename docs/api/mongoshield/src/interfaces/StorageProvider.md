[**MongoShield Documentation**](../../../README.md)

***

[MongoShield Documentation](../../../modules.md) / [mongoshield/src](../README.md) / StorageProvider

# Interface: StorageProvider

Defined in: [packages/core/src/providers/StorageProvider.ts:21](https://github.com/ShamalRathnayake/mongoshield/blob/37c34f4f1cc9c7701b1a943dbf51b10313c93a11/packages/core/src/providers/StorageProvider.ts#L21)

StorageProvider abstracts the destination logic for the backup stream.
It provides a standardized contract so the BackupEngine can write to Local Disk, AWS S3, or any other cloud provider agnostically.

Implementations should strongly prefer extending `AbstractStorageProvider` rather than implementing this interface directly.
`AbstractStorageProvider` provides critical security sanitization and automatic progress telemetry.

## Methods

### createArchiveWriteStream()?

> `optional` **createArchiveWriteStream**(`filename`): `Promise`\<`Writable`\>

Defined in: [packages/core/src/providers/StorageProvider.ts:59](https://github.com/ShamalRathnayake/mongoshield/blob/37c34f4f1cc9c7701b1a943dbf51b10313c93a11/packages/core/src/providers/StorageProvider.ts#L59)

Obtains a generic writable stream for a single monolithic archive file.
This allows middleware like ArchiveProvider to multiplex streams into one file.

#### Parameters

##### filename

`string`

The desired filename of the archive.

#### Returns

`Promise`\<`Writable`\>

A Node.js Writable stream.

***

### createBsonWriteStream()

> **createBsonWriteStream**(`dbName`, `collectionName`): `Promise`\<`Writable`\>

Defined in: [packages/core/src/providers/StorageProvider.ts:36](https://github.com/ShamalRathnayake/mongoshield/blob/37c34f4f1cc9c7701b1a943dbf51b10313c93a11/packages/core/src/providers/StorageProvider.ts#L36)

Obtains a writable stream for the BSON data of a specific collection.

#### Parameters

##### dbName

`string`

The name of the database being backed up.

##### collectionName

`string`

The name of the collection being backed up.

#### Returns

`Promise`\<`Writable`\>

A Node.js Writable stream to pipe the compressed/encrypted data into.

***

### createMetadataWriteStream()

> **createMetadataWriteStream**(`dbName`, `collectionName`): `Promise`\<`Writable`\>

Defined in: [packages/core/src/providers/StorageProvider.ts:48](https://github.com/ShamalRathnayake/mongoshield/blob/37c34f4f1cc9c7701b1a943dbf51b10313c93a11/packages/core/src/providers/StorageProvider.ts#L48)

Obtains a writable stream for the metadata JSON of a specific collection.

#### Parameters

##### dbName

`string`

The name of the database being backed up.

##### collectionName

`string`

The name of the collection being backed up.

#### Returns

`Promise`\<`Writable`\>

A Node.js Writable stream to pipe the metadata payload into.

***

### finalize()

> **finalize**(): `Promise`\<`void`\>

Defined in: [packages/core/src/providers/StorageProvider.ts:65](https://github.com/ShamalRathnayake/mongoshield/blob/37c34f4f1cc9c7701b1a943dbf51b10313c93a11/packages/core/src/providers/StorageProvider.ts#L65)

Called to finalize the backup process after all collections have finished streaming.
Useful for uploading final manifests or closing multiplexed archive files.

#### Returns

`Promise`\<`void`\>

***

### initialize()

> **initialize**(`expectedSizeInBytes?`): `Promise`\<`void`\>

Defined in: [packages/core/src/providers/StorageProvider.ts:27](https://github.com/ShamalRathnayake/mongoshield/blob/37c34f4f1cc9c7701b1a943dbf51b10313c93a11/packages/core/src/providers/StorageProvider.ts#L27)

Called before backup begins.
Useful for creating base directories on a filesystem or allocating/verifying cloud buckets.

#### Parameters

##### expectedSizeInBytes?

`number`

Optional size of the target database to check storage limits.

#### Returns

`Promise`\<`void`\>

***

### on()

#### Call Signature

> **on**(`event`, `listener`): `this`

Defined in: [packages/core/src/providers/StorageProvider.ts:78](https://github.com/ShamalRathnayake/mongoshield/blob/37c34f4f1cc9c7701b1a943dbf51b10313c93a11/packages/core/src/providers/StorageProvider.ts#L78)

Telemetry Event: Emitted as data chunks are written to the underlying storage.

##### Parameters

###### event

`"progress"`

'progress'

###### listener

(`bytesWritten`) => `void`

Callback receiving the number of bytes written in the latest chunk.

##### Returns

`this`

#### Call Signature

> **on**(`event`, `listener`): `this`

Defined in: [packages/core/src/providers/StorageProvider.ts:85](https://github.com/ShamalRathnayake/mongoshield/blob/37c34f4f1cc9c7701b1a943dbf51b10313c93a11/packages/core/src/providers/StorageProvider.ts#L85)

Error Event: Emitted if the storage provider encounters a fatal error during stream writing.

##### Parameters

###### event

`"error"`

'error'

###### listener

(`error`) => `void`

Callback receiving the Error object.

##### Returns

`this`

***

### prune()

> **prune**(`policy`): `Promise`\<[`PruningResult`](PruningResult.md)\>

Defined in: [packages/core/src/providers/StorageProvider.ts:71](https://github.com/ShamalRathnayake/mongoshield/blob/37c34f4f1cc9c7701b1a943dbf51b10313c93a11/packages/core/src/providers/StorageProvider.ts#L71)

Automatically cleans up old backups based on a user-defined policy.

#### Parameters

##### policy

[`PruningPolicy`](PruningPolicy.md)

The pruning policy defining retention rules.

#### Returns

`Promise`\<[`PruningResult`](PruningResult.md)\>
