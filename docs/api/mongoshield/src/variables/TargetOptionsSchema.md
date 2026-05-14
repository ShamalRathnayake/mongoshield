[**MongoShield Documentation**](../../../README.md)

***

[MongoShield Documentation](../../../modules.md) / [mongoshield/src](../README.md) / TargetOptionsSchema

# Variable: TargetOptionsSchema

> `const` **TargetOptionsSchema**: `ZodObject`\<\{ `collections`: `ZodOptional`\<`ZodArray`\<`ZodString`\>\>; `dbName`: `ZodOptional`\<`ZodString`\>; `dumpDbUsersAndRoles`: `ZodDefault`\<`ZodBoolean`\>; `excludeCollections`: `ZodOptional`\<`ZodArray`\<`ZodString`\>\>; `excludeCollectionsWithPrefix`: `ZodOptional`\<`ZodArray`\<`ZodString`\>\>; `query`: `ZodOptional`\<`ZodRecord`\<`ZodString`, `ZodAny`\>\>; `queryFile`: `ZodOptional`\<`ZodString`\>; `readPreference`: `ZodOptional`\<`ZodEnum`\<\{ `nearest`: `"nearest"`; `primary`: `"primary"`; `primaryPreferred`: `"primaryPreferred"`; `secondary`: `"secondary"`; `secondaryPreferred`: `"secondaryPreferred"`; \}\>\>; `viewsAsCollections`: `ZodDefault`\<`ZodBoolean`\>; \}, `$strip`\>

Defined in: [packages/core/src/config/index.ts:28](https://github.com/ShamalRathnayake/mongoshield/blob/37c34f4f1cc9c7701b1a943dbf51b10313c93a11/packages/core/src/config/index.ts#L28)
