# @mongoshield/provider-microsoft

> Microsoft Azure Blob Storage provider for [MongoShield](https://www.npmjs.com/package/mongoshield).

A secure, performance-optimized, and memory-efficient streaming adapter to back up MongoDB databases directly to Azure Blob Storage.

## Features

- **No Intermediate Disk Writes:** Streams BSON data directly from your database cursor into Azure Block Blobs using standard PassThrough stream chunk uploads.
- **Fail-Safe Preflight Validation:** Validates container connectivity during startup (`containerClient.exists()`) to raise permission or connection issues early.
- **Automated Pruning:** Integrated retention policy compliance (by age or run count) to automatically clean up old remote backups from Azure Blob containers.
- **Resilient Deletions:** Performs batch listing and sequential deletions over Azure SDK.

## Installation

```bash
npm install @mongoshield/provider-microsoft
```

## Usage

```typescript
import { MongoShield } from 'mongoshield';
import { AzureProvider } from '@mongoshield/provider-microsoft';

// Initialize the Azure Blob Storage provider
const provider = new AzureProvider({
  connectionString: process.env.AZURE_STORAGE_CONNECTION_STRING!,
  container: 'my-azure-container',
  prefix: 'mongo-backups/',
  compress: true, // Enable GZIP compression on the fly
});

// Configure MongoShield
const shield = new MongoShield({
  config: {
    connection: { host: 'localhost', port: 27017 },
    output: {
      encryptionKey: 'your-64-character-hex-master-key', // Strong AES-256-GCM encryption
    },
  },
  storage: provider,
});

// Start the secure backup stream!
await shield.backup();
```

## Configuration API

| Option | Type | Required | Description |
|---|---|---|---|
| `connectionString` | `string` | **Yes** | Connection string for Azure Storage Account authentication. |
| `container` | `string` | **Yes** | Name of the target Blob Container. |
| `prefix` | `string` | No | Base directory path inside the container (defaults to `"backups/"`). |
| `compress` | `boolean` | No | Toggle on-the-fly GZIP compression (defaults to `false`). |

## License

MIT
