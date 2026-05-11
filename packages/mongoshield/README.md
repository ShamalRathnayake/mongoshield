# MongoShield 🛡️

**Status:** ✅ PHASE 1 (CORE ENGINE) COMPLETE | 🚧 PHASE 2 (MVP) ACTIVE 🚧

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
| [`@mongoshield/provider-local`](https://www.npmjs.com/package/@mongoshield/provider-local) | Local filesystem storage provider. |
| [`@mongoshield/provider-s3`](https://www.npmjs.com/package/@mongoshield/provider-s3) | AWS S3 and S3-compatible storage provider. |

## Quick Start

```typescript
import { BackupEngine, ArchiveProvider } from 'mongoshield';

const provider = new ArchiveProvider('./backups/my_backup.msaf');

const engine = new BackupEngine({
  target: {
    uri: 'mongodb://localhost:27017',
    dbName: 'production_db',
    // Optional: filter collections
    includeCollections: ['users', 'orders']
  },
  output: {
    compression: { enabled: true, level: 9 },
    encryption: {
      enabled: true,
      masterKey: 'your-64-character-hex-master-key'
    }
  }
}, provider);

await engine.run();
console.log('Backup completed successfully!');
```

## Documentation

For deep technical details, roadmaps, and setup instructions, please refer to our `docs/` directory:

- 🗺️ [**Project Plan & Roadmap**](https://github.com/ShamalRathnayake/mongoshield/blob/main/docs/project/PROJECT_PLAN.md): Vision, core ideas, and phased roadmap.
- 🛠️ [**Developer Guide**](https://github.com/ShamalRathnayake/mongoshield/blob/main/docs/developer/DEVELOPER_GUIDE.md): Deep dive into the streaming engine, monorepo setup, CI/CD, and local testing.
- 🤖 [**Agent Context**](https://github.com/ShamalRathnayake/mongoshield/blob/main/docs/agent/AGENT_CONTEXT.md): System prompt and strict rulebook for AI Agents modifying this codebase.

## License

MIT
