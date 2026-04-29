# @mongoshield/provider-local

> The official Local Filesystem storage provider for [MongoShield](https://www.npmjs.com/package/mongoshield).

`@mongoshield/provider-local` is a zero-dependency, high-performance storage adapter that writes MongoDB backup streams directly to your local disk, network-attached storage (NAS), or mounted volumes (NFS/SMB).

## Features

- **🚀 Zero-Copy Streaming:** Pipes data directly from MongoDB to disk with minimal memory overhead.
- **🔄 Smart Rotation:** Automatically creates timestamped subdirectories for every run.
- **🧹 Automated Pruning:** Built-in cleanup logic for aging backups (retention policies).
- **📂 Path Security:** Native protection against path traversal attacks.
- **📦 Compression Support:** Works seamlessly with MongoShield's Gzip/Zstd compression.

---

## Installation

You need both the core `mongoshield` package and this provider:

```bash
npm install mongoshield @mongoshield/provider-local
```

---

## Quick Start

The most common use case: backing up a database to a local folder with automatic timestamping.

```typescript
import { MongoShield } from 'mongoshield';
import { FileSystemProvider } from '@mongoshield/provider-local';

async function backup() {
  // 1. Initialize the provider
  const provider = new FileSystemProvider({
    outPath: './backups/daily-dumps'
  });

  // 2. Initialize MongoShield with the provider
  const shield = new MongoShield({
    target: {
      uri: 'mongodb://localhost:27017',
      dbName: 'production_db'
    }
  }, provider);

  // 3. Run the backup
  await shield.run();
  
  console.log('Backup completed successfully!');
}
```

---

## Comprehensive Guides & Scenarios

### 1. Handling Compressed & Encrypted Backups
MongoShield handles compression and encryption at the engine level. The `FileSystemProvider` simply needs to know if it should append `.gz` or other extensions to the filenames.

```typescript
const provider = new FileSystemProvider({
  outPath: './backups',
  compress: true // Ensures filenames end in .gz
});

const shield = new MongoShield({
  target: { uri: '...', dbName: '...' },
  output: {
    gzip: true,
    encryption: {
      enabled: true,
      passphrase: 'your-secure-passphrase' // Data is encrypted BEFORE writing to disk
    }
  }
}, provider);
```

### 2. Monitoring Progress & Telemetry
Every provider emits `progress` events. You can use these to build progress bars or log the size of data written.

```typescript
provider.on('progress', (bytesWritten) => {
  console.log(`Wrote ${bytesWritten} bytes to disk...`);
});

provider.on('error', (err) => {
  console.error('Storage Error:', err.message);
});
```

### 3. Implementing Retention Policies (Pruning)
Retention policies prevent your disk from filling up. You should typically call `prune()` after a successful backup run.

#### Scenario A: Keep only the 5 most recent backups
```typescript
await provider.prune({
  strategy: 'count',
  maxCount: 5
});
```

#### Scenario B: Delete anything older than 14 days
```typescript
await provider.prune({
  strategy: 'age',
  maxDays: 14
});
```

#### Scenario C: The "Safety First" Approach (Both)
Deletes files older than 30 days, BUT ensures you never have more than 50 backups total regardless of age.
```typescript
await provider.prune({
  strategy: 'both',
  maxDays: 30,
  maxCount: 50
});
```

### 4. Zero-Rotation Mode (Overwriting)
If you want to maintain a "Latest" folder that gets overwritten every time (useful for simpler sync tools), disable rotation.

```typescript
const provider = new FileSystemProvider({
  outPath: './backups/latest',
  disableRotation: true 
});
```

---

## Directory Structure
By default (`disableRotation: false`), the provider organizes your data into ISO-timestamped folders for safe concurrency and historical auditing:

```text
backups/
  ├── 2026-04-29_14-30-00/           <-- Auto-generated timestamp
  │   └── production_db/             <-- Database Name
  │       ├── users.bson             <-- Collection Data
  │       ├── users.metadata.json    <-- Indexes & Metadata
  │       └── logs.bson
  └── 2026-04-30_14-30-00/
```

---

## API Reference

### `new FileSystemProvider(options)`

| Option | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `outPath` | `string` | **Required** | The root directory where backups are stored. |
| `compress` | `boolean` | `false` | If true, adds `.gz` extensions to filenames. |
| `disableRotation` | `boolean` | `false` | If true, prevents creation of timestamped subfolders. |

### `provider.prune(policy: PruningPolicy)`

| Property | Type | Description |
| :--- | :--- | :--- |
| `strategy` | `'count' \| 'age' \| 'both'` | The logic used for cleanup. |
| `maxCount` | `number` | Max number of backup directories to keep. |
| `maxDays` | `number` | Max age in days for a backup directory. |

---

## Best Practices

1. **Absolute Paths:** Always use absolute paths for `outPath` when running in production (e.g., Docker/PM2).
2. **Permissions:** Ensure the Node.js process has `rwx` permissions on the target directory.
3. **Mount Points:** When using NFS/SMB, verify the mount is available before starting the backup to avoid writing to the local root partition.

---

## Links

- 🐙 [GitHub Repository](https://github.com/ShamalRathnayake/mongoshield)
- 📦 [Main MongoShield Package](https://www.npmjs.com/package/mongoshield)

## License

MIT
