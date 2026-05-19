# @mongoshield/provider-s3

> AWS S3 and S3-compatible cloud storage provider for [MongoShield](https://www.npmjs.com/package/mongoshield).

A secure, performance-optimized, and memory-efficient streaming adapter to back up MongoDB databases directly to AWS S3, Cloudflare R2, Backblaze B2, DigitalOcean Spaces, MinIO, or any other S3-compatible storage.

## Features

- **No Intermediate Disk Writes:** Streams BSON data directly from your database cursor into S3 multipart uploads.
- **S3-Compatible presets:** Connect to any S3-compatible service by specifying custom endpoint and credentials.
- **Fail-Safe Preflight Validation:** Checks bucket access via `HeadBucketCommand` during startup to catch connection issues early.
- **Automated Pruning:** Integrated retention policy compliance (by age or run count) to automatically clean up old remote backups.

## Installation

```bash
npm install @mongoshield/provider-s3
```

## Usage

```typescript
import { MongoShield } from 'mongoshield';
import { S3Provider } from '@mongoshield/provider-s3';

// Initialize the S3 storage provider
const provider = new S3Provider({
  bucket: 'my-backup-bucket',
  region: 'us-east-1',
  prefix: 'mongo-backups/',
  compress: true, // Enable GZIP compression on the fly
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
  },
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

The `S3Provider` extends AWS SDK's `S3ClientConfig`, meaning you can pass standard SDK options (like credentials, custom endpoints, retry limits) directly:

| Option | Type | Required | Description |
|---|---|---|---|
| `bucket` | `string` | **Yes** | Name of the target S3 bucket. |
| `prefix` | `string` | No | Base directory path inside the bucket (defaults to `"backups/"`). |
| `compress` | `boolean` | No | Toggle on-the-fly GZIP compression (defaults to `false`). |
| `endpoint` | `string` | No | Target custom S3-compatible endpoint url (e.g. for R2 or MinIO). |

## License

MIT
