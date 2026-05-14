# Modular Provider Architecture

To support a wide range of storage platforms while keeping the core library lightweight, MongoShield uses a **Modular Provider Ecosystem**. Providers are grouped by their underlying SDK dependencies and authentication models.

## 1. Provider Grouping (The "Ecosystem" Model)

Storage providers are distributed as separate packages to ensure users only install the dependencies they need.

### Group A: S3 Ecosystem (`@mongoshield/provider-s3`)
**Target Platforms:** AWS S3, DigitalOcean Spaces, Cloudflare R2, Backblaze B2, Wasabi, MinIO.
- **Underlying SDK:** `@aws-sdk/client-s3`.
- **Features:** Multi-part streaming uploads, S3-compatible presets.

### Group B: Google Ecosystem (`@mongoshield/provider-google`)
**Target Platforms:** Google Cloud Storage (GCS), Google Drive.
- **Underlying SDK:** `@google-cloud/storage`, `google-auth-library`.
- **Features:** Service Account support, OAuth2 integration, Drive folder management.

### Group C: Microsoft Ecosystem (`@mongoshield/provider-microsoft`)
**Target Platforms:** Azure Blob Storage, Microsoft OneDrive.
- **Underlying SDK:** `@azure/storage-blob`, `@microsoft/microsoft-graph-client`.
- **Features:** Shared Microsoft Identity integration.

### Group D: Network Protocols (`@mongoshield/provider-network`)
**Target Platforms:** SFTP, SSH, WebDAV.
- **Underlying SDK:** `ssh2`, `webdav`.
- **Features:** Custom port support, key-based authentication.

### Group E: Local Storage (`@mongoshield/provider-local`)
**Target Platforms:** Local Filesystem, Network Mounts (NFS/SMB).
- **Underlying SDK:** Native Node.js `fs`.
- **Features:** Direct stream piping, automatic directory rotation.

---

## 2. Integration Pattern (Provider Registration)

To maintain a "Zero-Dependency" core, MongoShield uses a **Registration Pattern**. The core engine accepts any instance that satisfies the `StorageProvider` interface.

### Example Usage
```typescript
import { MongoShield } from 'mongoshield';
import { S3Provider } from '@mongoshield/provider-s3';

const shield = new MongoShield({
  config: {
    connection: { host: 'localhost', port: 27017 },
    output: { encryptionKey: 'some-hex-key' }
  },
  storage: new S3Provider({
    bucket: 'backups',
    region: 'us-east-1'
  })
});

await shield.backup();
```

---

## 3. Implementation Guidelines
- **Internal Common Core:** Common S3-compatible logic should be abstracted within `@mongoshield/provider-s3` to avoid duplication.
- **Peer Dependencies:** Providers should list `@mongoshield/core` as a peer dependency to ensure type compatibility across the monorepo.
- **Streaming First:** Every provider MUST implement the `WritableStream` interface to support MongoShield's memory-efficient architecture.

---

## 4. Pruning Policies (Old Record Deletion)

To prevent storage costs from spiraling, every provider must implement a standardized **Pruning Interface**. This allows the scheduler to automatically clean up old backups based on user-defined policies.

### The `PruningPolicy` Schema
```typescript
interface PruningPolicy {
  maxCount?: number; // Keep only the last N backups
  maxDays?: number;  // Delete backups older than X days
  strategy: 'count' | 'age' | 'both';
}
```

### Provider Implementation Requirement
Every provider must implement the `prune(policy: PruningPolicy): Promise<PruningResult>` method.
- **Local:** Deletes files/directories.
- **S3/Cloud:** Uses native SDK `DeleteObject` commands.
- **ArchiveProvider (Middleware):** Delegates pruning entirely to its underlying downstream provider (e.g., Local or S3), ensuring monolithic `.msaf` files are cleaned up exactly like native directories.
