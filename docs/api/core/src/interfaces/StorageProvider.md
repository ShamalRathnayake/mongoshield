[**MongoShield Documentation**](../../../README.md)

***

[MongoShield Documentation](../../../modules.md) / [core/src](../README.md) / StorageProvider

# Interface: StorageProvider

Defined in: packages/core/src/providers/StorageProvider.ts:11

StorageProvider abstracts the destination logic for the backup stream.
It provides a standardized contract so the BackupEngine can write to Local Disk, AWS S3, or any other cloud provider agnostically.

Implementations should strongly prefer extending `AbstractStorageProvider` rather than implementing this interface directly.
`AbstractStorageProvider` provides critical security sanitization and automatic progress telemetry.

## Methods

### createBsonWriteStream()

> **createBsonWriteStream**(`dbName`, `collectionName`): `Promise`\<`Writable`\>

Defined in: packages/core/src/providers/StorageProvider.ts:25

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

Defined in: packages/core/src/providers/StorageProvider.ts:34

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

Defined in: packages/core/src/providers/StorageProvider.ts:40

Called to finalize the backup process after all collections have finished streaming.
Useful for uploading final manifests or closing multiplexed archive files.

#### Returns

`Promise`\<`void`\>

***

### initialize()

> **initialize**(): `Promise`\<`void`\>

Defined in: packages/core/src/providers/StorageProvider.ts:16

Called before backup begins. 
Useful for creating base directories on a filesystem or allocating/verifying cloud buckets.

#### Returns

`Promise`\<`void`\>

***

### on()

#### Call Signature

> **on**(`event`, `listener`): `this`

Defined in: packages/core/src/providers/StorageProvider.ts:47

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

Defined in: packages/core/src/providers/StorageProvider.ts:54

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
