# @mongoshield/provider-google

> Google Cloud Storage (GCS) provider for [MongoShield](https://www.npmjs.com/package/mongoshield).

A secure, performance-optimized, and memory-efficient streaming adapter to back up MongoDB databases directly to Google Cloud Storage.

## Features

- **No Intermediate Disk Writes:** Streams BSON data directly from your database cursor into GCS resumable upload write streams.
- **Fail-Safe Preflight Validation:** Validates bucket connectivity during startup (`bucket.exists()`) to raise permission or config issues early.
- **Automated Pruning:** Integrated retention policy compliance (by age or run count) to automatically clean up old remote backups.
- **Resilient Batch Operations:** Performs performant folder-level cleanups over GCS API.

## Installation

```bash
npm install @mongoshield/provider-google
```

## Usage

```typescript
import { MongoShield } from 'mongoshield';
import { GoogleProvider } from '@mongoshield/provider-google';

// Initialize the Google Cloud Storage provider
const provider = new GoogleProvider({
  bucket: 'my-gcs-backup-bucket',
  prefix: 'mongo-backups/',
  compress: true, // Enable GZIP compression on the fly
  keyFilename: '/path/to/service-account.json', // Path to your Google Service Account credentials
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

The `GoogleProvider` extends the official `@google-cloud/storage` `StorageOptions` config, giving you access to all standard auth and client configurations:

| Option | Type | Required | Description |
|---|---|---|---|
| `bucket` | `string` | **Yes** | Name of the target Google Cloud Storage bucket. |
| `prefix` | `string` | No | Base directory path inside the bucket (defaults to `"backups/"`). |
| `compress` | `boolean` | No | Toggle on-the-fly GZIP compression (defaults to `false`). |
| `keyFilename` | `string` | No | Path to Service Account private key JSON file. |
| `projectId` | `string` | No | Custom Google Cloud Project ID. |

## License

MIT
