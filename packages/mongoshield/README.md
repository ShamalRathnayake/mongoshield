# MongoShield 🛡️

**Status:** ✅ PHASES 0–2 COMPLETE | ✅ SCHEDULER COMPLETE | 🚧 PHASE 3 (PRO DEFENSES) IN PROGRESS 🚧

**MongoShield** is a revolutionary, highly secure, and entirely self-contained MongoDB data protection utility tailored specifically for modern Node.js and TypeScript ecosystems.

### Why this package?

The core motivation behind MongoShield is to solve the glaring flaws present in the deprecated `mongodb-backup-cloud` package and most other Node.js database backup tools. The vast majority of existing tools act as simple wrappers around the host operating system's `mongodump` and `mongorestore` binaries. This creates a massive limitation: they fail immediately in constrained environments where developers cannot install system-level database tools (such as Serverless Functions on Vercel/AWS Lambda, minimal Docker containers, or PaaS deployments like Heroku).

**MongoShield eliminates this dependency entirely.** It is built purely on the native Node.js MongoDB driver.

## Installation

```bash
npm install mongoshield
# or
pnpm add mongoshield
# or
yarn add mongoshield
```

## Packages

MongoShield is a modular ecosystem. The main `mongoshield` package includes the core engine and high-level API. For specific storage providers, install the corresponding package:

| Package | Description |
|---|---|
| [`mongoshield`](https://www.npmjs.com/package/mongoshield) | **Main package** — high-level API + core engine. Start here. |
| [`@mongoshield/core`](https://www.npmjs.com/package/@mongoshield/core) | Low-level streaming engine, providers, and encryption. |
| [`@mongoshield/provider-local`](https://www.npmjs.com/package/@mongoshield/provider-local) | Local filesystem storage with rotation & pruning. |
| [`@mongoshield/provider-s3`](https://www.npmjs.com/package/@mongoshield/provider-s3) | AWS S3 and S3-compatible storage (Cloudflare R2, DigitalOcean Spaces). |
| [`@mongoshield/provider-google`](https://www.npmjs.com/package/@mongoshield/provider-google) | Google Cloud Storage (GCS) and Google Drive. |
| [`@mongoshield/provider-microsoft`](https://www.npmjs.com/package/@mongoshield/provider-microsoft) | Microsoft Azure Blob Storage. |
| [`@mongoshield/provider-network`](https://www.npmjs.com/package/@mongoshield/provider-network) | Network protocols — SFTP/SSH. |
| [`@mongoshield/scheduler`](https://www.npmjs.com/package/@mongoshield/scheduler) | Autonomous backup scheduler with cron, retries, overlap prevention, and audit logging. |

## Quick Start

```typescript
import { MongoShield, ArchiveProvider } from 'mongoshield';
import { FileSystemProvider } from '@mongoshield/provider-local';

// 1. Initialize the downstream storage provider
const localProvider = new FileSystemProvider({ 
  outPath: './backups', 
  compress: true 
});

// 2. Wrap it with the ArchiveProvider to create monolithic .msaf files
const archivePlugin = new ArchiveProvider(localProvider, 'cluster-backup.msaf');

// 3. Initialize MongoShield
const shield = new MongoShield({
  config: {
    connection: { host: 'localhost', port: 27017 },
    output: {
      encryptionKey: 'your-64-character-hex-master-key' // Optional
    }
  },
  storage: archivePlugin
});

// 4. Run the backup!
await shield.backup();
console.log('Backup completed successfully!');
```

## Documentation

For deep technical details, roadmaps, and setup instructions, please refer to our `docs/` directory:

- 🗺️ [**Project Plan & Roadmap**](https://github.com/ShamalRathnayake/mongoshield/blob/main/docs/project/PROJECT_PLAN.md): Vision, core ideas, and phased roadmap.
- 🛠️ [**Developer Guide**](https://github.com/ShamalRathnayake/mongoshield/blob/main/docs/developer/DEVELOPER_GUIDE.md): Deep dive into the streaming engine, monorepo setup, CI/CD, and local testing.
- 🤖 [**Agent Context**](https://github.com/ShamalRathnayake/mongoshield/blob/main/docs/agent/AGENT_CONTEXT.md): System prompt and strict rulebook for AI Agents modifying this codebase.

## License

MIT
