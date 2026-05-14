[**MongoShield Documentation**](../../../README.md)

***

[MongoShield Documentation](../../../modules.md) / [mongoshield/src](../README.md) / MongoShieldOptions

# Interface: MongoShieldOptions

Defined in: [packages/mongoshield/src/MongoShield.ts:11](https://github.com/ShamalRathnayake/mongoshield/blob/37c34f4f1cc9c7701b1a943dbf51b10313c93a11/packages/mongoshield/src/MongoShield.ts#L11)

## Properties

### config

> **config**: `object`

Defined in: [packages/mongoshield/src/MongoShield.ts:12](https://github.com/ShamalRathnayake/mongoshield/blob/37c34f4f1cc9c7701b1a943dbf51b10313c93a11/packages/mongoshield/src/MongoShield.ts#L12)

#### connection?

> `optional` **connection?**: `object`

##### connection.authenticationDatabase?

> `optional` **authenticationDatabase?**: `string`

##### connection.authenticationMechanism?

> `optional` **authenticationMechanism?**: `"DEFAULT"` \| `"GSSAPI"` \| `"PLAIN"` \| `"MONGODB-X509"` \| `"SCRAM-SHA-1"` \| `"SCRAM-SHA-256"` \| `"MONGODB-AWS"`

##### connection.directConnection?

> `optional` **directConnection?**: `boolean`

##### connection.host?

> `optional` **host?**: `string`

##### connection.password?

> `optional` **password?**: `string`

##### connection.port?

> `optional` **port?**: `number`

##### connection.tls?

> `optional` **tls?**: `boolean`

##### connection.tlsAllowInvalidCertificates?

> `optional` **tlsAllowInvalidCertificates?**: `boolean`

##### connection.tlsCAFile?

> `optional` **tlsCAFile?**: `string`

##### connection.tlsCertificateKeyFile?

> `optional` **tlsCertificateKeyFile?**: `string`

##### connection.tlsCertificateKeyFilePassword?

> `optional` **tlsCertificateKeyFilePassword?**: `string`

##### connection.username?

> `optional` **username?**: `string`

#### output?

> `optional` **output?**: `object`

##### output.archivePath?

> `optional` **archivePath?**: `string`

##### output.batchSize?

> `optional` **batchSize?**: `number`

##### output.encryptionKey?

> `optional` **encryptionKey?**: `string`

##### output.gzip?

> `optional` **gzip?**: `boolean`

##### output.numParallelCollections?

> `optional` **numParallelCollections?**: `number`

##### output.oplog?

> `optional` **oplog?**: `boolean`

##### output.outPath?

> `optional` **outPath?**: `string`

#### target?

> `optional` **target?**: `object`

##### target.collections?

> `optional` **collections?**: `string`[]

##### target.dbName?

> `optional` **dbName?**: `string`

##### target.dumpDbUsersAndRoles?

> `optional` **dumpDbUsersAndRoles?**: `boolean`

##### target.excludeCollections?

> `optional` **excludeCollections?**: `string`[]

##### target.excludeCollectionsWithPrefix?

> `optional` **excludeCollectionsWithPrefix?**: `string`[]

##### target.query?

> `optional` **query?**: `Record`\<`string`, `any`\>

##### target.queryFile?

> `optional` **queryFile?**: `string`

##### target.readPreference?

> `optional` **readPreference?**: `"primary"` \| `"primaryPreferred"` \| `"secondary"` \| `"secondaryPreferred"` \| `"nearest"`

##### target.viewsAsCollections?

> `optional` **viewsAsCollections?**: `boolean`

***

### storage

> **storage**: [`StorageProvider`](StorageProvider.md)

Defined in: [packages/mongoshield/src/MongoShield.ts:13](https://github.com/ShamalRathnayake/mongoshield/blob/37c34f4f1cc9c7701b1a943dbf51b10313c93a11/packages/mongoshield/src/MongoShield.ts#L13)
