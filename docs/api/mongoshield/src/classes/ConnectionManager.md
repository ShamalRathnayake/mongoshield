[**MongoShield Documentation**](../../../README.md)

***

[MongoShield Documentation](../../../modules.md) / [mongoshield/src](../README.md) / ConnectionManager

# Class: ConnectionManager

Defined in: [packages/core/src/db/ConnectionManager.ts:4](https://github.com/ShamalRathnayake/mongoshield/blob/37c34f4f1cc9c7701b1a943dbf51b10313c93a11/packages/core/src/db/ConnectionManager.ts#L4)

## Constructors

### Constructor

> **new ConnectionManager**(`config`): `ConnectionManager`

Defined in: [packages/core/src/db/ConnectionManager.ts:8](https://github.com/ShamalRathnayake/mongoshield/blob/37c34f4f1cc9c7701b1a943dbf51b10313c93a11/packages/core/src/db/ConnectionManager.ts#L8)

#### Parameters

##### config

###### authenticationDatabase?

`string` = `...`

###### authenticationMechanism?

`"DEFAULT"` \| `"GSSAPI"` \| `"PLAIN"` \| `"MONGODB-X509"` \| `"SCRAM-SHA-1"` \| `"SCRAM-SHA-256"` \| `"MONGODB-AWS"` = `...`

###### directConnection?

`boolean` = `...`

###### host

`string` = `...`

###### password?

`string` = `...`

###### port

`number` = `...`

###### tls?

`boolean` = `...`

###### tlsAllowInvalidCertificates?

`boolean` = `...`

###### tlsCAFile?

`string` = `...`

###### tlsCertificateKeyFile?

`string` = `...`

###### tlsCertificateKeyFilePassword?

`string` = `...`

###### username?

`string` = `...`

#### Returns

`ConnectionManager`

## Methods

### connect()

> **connect**(): `Promise`\<`MongoClient`\>

Defined in: [packages/core/src/db/ConnectionManager.ts:12](https://github.com/ShamalRathnayake/mongoshield/blob/37c34f4f1cc9c7701b1a943dbf51b10313c93a11/packages/core/src/db/ConnectionManager.ts#L12)

#### Returns

`Promise`\<`MongoClient`\>

***

### disconnect()

> **disconnect**(): `Promise`\<`void`\>

Defined in: [packages/core/src/db/ConnectionManager.ts:81](https://github.com/ShamalRathnayake/mongoshield/blob/37c34f4f1cc9c7701b1a943dbf51b10313c93a11/packages/core/src/db/ConnectionManager.ts#L81)

#### Returns

`Promise`\<`void`\>

***

### getClient()

> **getClient**(): `MongoClient`

Defined in: [packages/core/src/db/ConnectionManager.ts:72](https://github.com/ShamalRathnayake/mongoshield/blob/37c34f4f1cc9c7701b1a943dbf51b10313c93a11/packages/core/src/db/ConnectionManager.ts#L72)

#### Returns

`MongoClient`
