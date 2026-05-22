[**MongoShield Documentation**](../../../README.md)

***

[MongoShield Documentation](../../../modules.md) / [mongoshield/src](../README.md) / BackupEngine

# Class: BackupEngine

Defined in: [packages/core/src/core/BackupEngine.ts:16](https://github.com/ShamalRathnayake/mongoshield/blob/37c34f4f1cc9c7701b1a943dbf51b10313c93a11/packages/core/src/core/BackupEngine.ts#L16)

## Constructors

### Constructor

> **new BackupEngine**(`config`, `storage`): `BackupEngine`

Defined in: [packages/core/src/core/BackupEngine.ts:21](https://github.com/ShamalRathnayake/mongoshield/blob/37c34f4f1cc9c7701b1a943dbf51b10313c93a11/packages/core/src/core/BackupEngine.ts#L21)

#### Parameters

##### config

###### connection

\{ `authenticationDatabase?`: `string`; `authenticationMechanism?`: `"DEFAULT"` \| `"GSSAPI"` \| `"PLAIN"` \| `"MONGODB-X509"` \| `"SCRAM-SHA-1"` \| `"SCRAM-SHA-256"` \| `"MONGODB-AWS"`; `directConnection?`: `boolean`; `host`: `string`; `password?`: `string`; `port`: `number`; `tls?`: `boolean`; `tlsAllowInvalidCertificates?`: `boolean`; `tlsCAFile?`: `string`; `tlsCertificateKeyFile?`: `string`; `tlsCertificateKeyFilePassword?`: `string`; `username?`: `string`; \} = `...`

###### connection.authenticationDatabase?

`string` = `...`

###### connection.authenticationMechanism?

`"DEFAULT"` \| `"GSSAPI"` \| `"PLAIN"` \| `"MONGODB-X509"` \| `"SCRAM-SHA-1"` \| `"SCRAM-SHA-256"` \| `"MONGODB-AWS"` = `...`

###### connection.directConnection?

`boolean` = `...`

###### connection.host

`string` = `...`

###### connection.password?

`string` = `...`

###### connection.port

`number` = `...`

###### connection.tls?

`boolean` = `...`

###### connection.tlsAllowInvalidCertificates?

`boolean` = `...`

###### connection.tlsCAFile?

`string` = `...`

###### connection.tlsCertificateKeyFile?

`string` = `...`

###### connection.tlsCertificateKeyFilePassword?

`string` = `...`

###### connection.username?

`string` = `...`

###### output

\{ `archivePath?`: `string`; `batchSize?`: `number`; `encryptionKey?`: `string`; `gzip`: `boolean`; `numParallelCollections`: `number`; `oplog`: `boolean`; `outPath`: `string`; \} = `...`

###### output.archivePath?

`string` = `...`

###### output.batchSize?

`number` = `...`

###### output.encryptionKey?

`string` = `...`

###### output.gzip

`boolean` = `...`

###### output.numParallelCollections

`number` = `...`

###### output.oplog

`boolean` = `...`

###### output.outPath

`string` = `...`

###### target

\{ `collections?`: `string`[]; `dbName?`: `string`; `dumpDbUsersAndRoles`: `boolean`; `excludeCollections?`: `string`[]; `excludeCollectionsWithPrefix?`: `string`[]; `query?`: `Record`\<`string`, `any`\>; `queryFile?`: `string`; `readPreference?`: `"primary"` \| `"primaryPreferred"` \| `"secondary"` \| `"secondaryPreferred"` \| `"nearest"`; `viewsAsCollections`: `boolean`; \} = `...`

###### target.collections?

`string`[] = `...`

###### target.dbName?

`string` = `...`

###### target.dumpDbUsersAndRoles

`boolean` = `...`

###### target.excludeCollections?

`string`[] = `...`

###### target.excludeCollectionsWithPrefix?

`string`[] = `...`

###### target.query?

`Record`\<`string`, `any`\> = `...`

###### target.queryFile?

`string` = `...`

###### target.readPreference?

`"primary"` \| `"primaryPreferred"` \| `"secondary"` \| `"secondaryPreferred"` \| `"nearest"` = `...`

###### target.viewsAsCollections

`boolean` = `...`

##### storage

[`StorageProvider`](../interfaces/StorageProvider.md)

#### Returns

`BackupEngine`

## Methods

### getTargetCollections()

> **getTargetCollections**(`db`): `Promise`\<[`CollectionTarget`](../interfaces/CollectionTarget.md)[]\>

Defined in: [packages/core/src/core/BackupEngine.ts:30](https://github.com/ShamalRathnayake/mongoshield/blob/37c34f4f1cc9c7701b1a943dbf51b10313c93a11/packages/core/src/core/BackupEngine.ts#L30)

Discovers and filters the collections to be backed up based on the TargetOptions.

#### Parameters

##### db

`Db`

#### Returns

`Promise`\<[`CollectionTarget`](../interfaces/CollectionTarget.md)[]\>

***

### run()

> **run**(): `Promise`\<`void`\>

Defined in: [packages/core/src/core/BackupEngine.ts:73](https://github.com/ShamalRathnayake/mongoshield/blob/37c34f4f1cc9c7701b1a943dbf51b10313c93a11/packages/core/src/core/BackupEngine.ts#L73)

#### Returns

`Promise`\<`void`\>
