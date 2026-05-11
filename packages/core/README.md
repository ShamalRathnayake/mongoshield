# @mongoshield/core

> The low-level streaming backup engine that powers [MongoShield](https://www.npmjs.com/package/mongoshield).

## ⚠️ You probably want `mongoshield` instead

Unless you are building a custom storage provider or need direct access to the streaming internals, install the main package:

```bash
npm install mongoshield
```

The main [`mongoshield`](https://www.npmjs.com/package/mongoshield) package re-exports everything from `@mongoshield/core` automatically.

## What's in this package?

This package contains the foundational building blocks of the MongoShield ecosystem:

- **`BackupEngine`** — Orchestrates the full backup pipeline: connection → discovery → streaming → storage.
- **`ArchiveProvider`** — Writes backups into the `.msaf` (MongoShield Archive Format) archive format.
- **`AbstractStorageProvider`** — Base class for building custom storage providers.
- **`StorageProvider`** — The interface contract all storage providers must implement.
- **Streams** — `BSONEncoderStream`, `EncryptionTransform`, and other transform streams for the data pipeline.
- **Config** — Zod-validated configuration schemas for backup operations.

## For Provider Authors

If you're building a custom storage provider (e.g., Google Drive, Azure Blob), extend `AbstractStorageProvider`:

```typescript
import { AbstractStorageProvider } from '@mongoshield/core';

export class MyCustomProvider extends AbstractStorageProvider {
  protected async _initialize(): Promise<void> { /* ... */ }
  protected async _createBsonWriteStream(dbName: string, collName: string) { /* ... */ }
  protected async _createMetadataWriteStream(dbName: string, collName: string) { /* ... */ }
  protected async _finalize(): Promise<void> { /* ... */ }
  protected async _prune(policy: any): Promise<any> { /* ... */ }
}
```

## Links

- 📦 [Main Package (`mongoshield`)](https://www.npmjs.com/package/mongoshield)
- 🐙 [GitHub Repository](https://github.com/ShamalRathnayake/mongoshield)
- 📖 [Documentation](https://github.com/ShamalRathnayake/mongoshield/tree/main/docs)

## License

MIT
