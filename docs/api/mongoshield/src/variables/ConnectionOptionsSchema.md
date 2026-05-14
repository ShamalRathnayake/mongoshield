[**MongoShield Documentation**](../../../README.md)

***

[MongoShield Documentation](../../../modules.md) / [mongoshield/src](../README.md) / ConnectionOptionsSchema

# Variable: ConnectionOptionsSchema

> `const` **ConnectionOptionsSchema**: `ZodObject`\<\{ `authenticationDatabase`: `ZodOptional`\<`ZodString`\>; `authenticationMechanism`: `ZodOptional`\<`ZodEnum`\<\{ `DEFAULT`: `"DEFAULT"`; `GSSAPI`: `"GSSAPI"`; `MONGODB-AWS`: `"MONGODB-AWS"`; `MONGODB-X509`: `"MONGODB-X509"`; `PLAIN`: `"PLAIN"`; `SCRAM-SHA-1`: `"SCRAM-SHA-1"`; `SCRAM-SHA-256`: `"SCRAM-SHA-256"`; \}\>\>; `directConnection`: `ZodOptional`\<`ZodBoolean`\>; `host`: `ZodDefault`\<`ZodString`\>; `password`: `ZodOptional`\<`ZodString`\>; `port`: `ZodDefault`\<`ZodNumber`\>; `tls`: `ZodOptional`\<`ZodBoolean`\>; `tlsAllowInvalidCertificates`: `ZodOptional`\<`ZodBoolean`\>; `tlsCAFile`: `ZodOptional`\<`ZodString`\>; `tlsCertificateKeyFile`: `ZodOptional`\<`ZodString`\>; `tlsCertificateKeyFilePassword`: `ZodOptional`\<`ZodString`\>; `username`: `ZodOptional`\<`ZodString`\>; \}, `$strip`\>

Defined in: [packages/core/src/config/index.ts:3](https://github.com/ShamalRathnayake/mongoshield/blob/37c34f4f1cc9c7701b1a943dbf51b10313c93a11/packages/core/src/config/index.ts#L3)
