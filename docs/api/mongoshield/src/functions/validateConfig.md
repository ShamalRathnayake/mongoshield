[**MongoShield Documentation**](../../../README.md)

***

[MongoShield Documentation](../../../modules.md) / [mongoshield/src](../README.md) / validateConfig

# Function: validateConfig()

> **validateConfig**(`config`): `object`

Defined in: [packages/core/src/config/index.ts:85](https://github.com/ShamalRathnayake/mongoshield/blob/37c34f4f1cc9c7701b1a943dbf51b10313c93a11/packages/core/src/config/index.ts#L85)

## Parameters

### config

`unknown`

## Returns

`object`

### connection

> **connection**: `object`

#### connection.authenticationDatabase?

> `optional` **authenticationDatabase?**: `string`

#### connection.authenticationMechanism?

> `optional` **authenticationMechanism?**: `"DEFAULT"` \| `"GSSAPI"` \| `"PLAIN"` \| `"MONGODB-X509"` \| `"SCRAM-SHA-1"` \| `"SCRAM-SHA-256"` \| `"MONGODB-AWS"`

#### connection.directConnection?

> `optional` **directConnection?**: `boolean`

#### connection.host

> **host**: `string`

#### connection.password?

> `optional` **password?**: `string`

#### connection.port

> **port**: `number`

#### connection.tls?

> `optional` **tls?**: `boolean`

#### connection.tlsAllowInvalidCertificates?

> `optional` **tlsAllowInvalidCertificates?**: `boolean`

#### connection.tlsCAFile?

> `optional` **tlsCAFile?**: `string`

#### connection.tlsCertificateKeyFile?

> `optional` **tlsCertificateKeyFile?**: `string`

#### connection.tlsCertificateKeyFilePassword?

> `optional` **tlsCertificateKeyFilePassword?**: `string`

#### connection.username?

> `optional` **username?**: `string`

### output

> **output**: `object`

#### output.archivePath?

> `optional` **archivePath?**: `string`

#### output.batchSize?

> `optional` **batchSize?**: `number`

#### output.encryptionKey?

> `optional` **encryptionKey?**: `string`

#### output.gzip

> **gzip**: `boolean`

#### output.numParallelCollections

> **numParallelCollections**: `number`

#### output.oplog

> **oplog**: `boolean`

#### output.outPath

> **outPath**: `string`

### target

> **target**: `object`

#### target.collections?

> `optional` **collections?**: `string`[]

#### target.dbName?

> `optional` **dbName?**: `string`

#### target.dumpDbUsersAndRoles

> **dumpDbUsersAndRoles**: `boolean`

#### target.excludeCollections?

> `optional` **excludeCollections?**: `string`[]

#### target.excludeCollectionsWithPrefix?

> `optional` **excludeCollectionsWithPrefix?**: `string`[]

#### target.query?

> `optional` **query?**: `Record`\<`string`, `any`\>

#### target.queryFile?

> `optional` **queryFile?**: `string`

#### target.readPreference?

> `optional` **readPreference?**: `"primary"` \| `"primaryPreferred"` \| `"secondary"` \| `"secondaryPreferred"` \| `"nearest"`

#### target.viewsAsCollections

> **viewsAsCollections**: `boolean`
