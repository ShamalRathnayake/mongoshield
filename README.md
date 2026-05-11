# MongoShield 🛡️

**Status:** ✅ PHASE 1 (CORE ENGINE) COMPLETE | 🚧 PHASE 2 (MVP) ACTIVE 🚧

**MongoShield** is a revolutionary, highly secure, and entirely self-contained MongoDB data protection utility tailored specifically for modern Node.js and TypeScript ecosystems.

### Why this package?

The core motivation behind MongoShield is to solve the glaring flaws present in the deprecated `mongodb-backup-cloud` package and most other Node.js database backup tools. The vast majority of existing tools act as simple wrappers around the host operating system's `mongodump` and `mongorestore` binaries. This creates a massive limitation: they fail immediately in constrained environments where developers cannot install system-level database tools (such as Serverless Functions on Vercel/AWS Lambda, minimal Docker containers, or PaaS deployments like Heroku).

**MongoShield eliminates this dependency entirely.** It is built purely on the native Node.js MongoDB driver.

## Installation

```bash
npm install mongoshield
```

## Packages

This is a monorepo containing the following packages:

| Package | npm | Description |
|---|---|---|
| [`mongoshield`](./packages/mongoshield) | [![npm](https://img.shields.io/npm/v/mongoshield)](https://www.npmjs.com/package/mongoshield) | **Main package** — high-level API + core re-exports. Start here. |
| [`@mongoshield/core`](./packages/core) | [![npm](https://img.shields.io/npm/v/@mongoshield/core)](https://www.npmjs.com/package/@mongoshield/core) | Low-level streaming engine, providers, and encryption. |
| [`@mongoshield/provider-local`](./packages/provider-local) | [![npm](https://img.shields.io/npm/v/@mongoshield/provider-local)](https://www.npmjs.com/package/@mongoshield/provider-local) | Local filesystem storage provider. |
| [`@mongoshield/provider-s3`](./packages/provider-s3) | [![npm](https://img.shields.io/npm/v/@mongoshield/provider-s3)](https://www.npmjs.com/package/@mongoshield/provider-s3) | AWS S3 and S3-compatible storage provider. |

## Usage Example

```typescript
import { MongoShield } from 'mongoshield';
import { FileSystemProvider } from '@mongoshield/provider-local';

const provider = new FileSystemProvider({
  outPath: './backups',
  compress: true
});

const shield = new MongoShield({
  config: {
    connection: { host: 'localhost', port: 27017 },
    target: { 
      dbName: 'production_db', // Omit for full cluster backup!
      collections: ['users', 'orders']
    },
    output: {
      outPath: 'dump',
      gzip: true,
      encryptionKey: 'your-64-character-hex-master-key'
    }
  },
  storage: provider
});

shield.on("progress", (bytes) => console.log(`Wrote ${bytes} bytes`));

await shield.backup();
console.log('Backup completed successfully!');
```

## Documentation

For deep technical details, roadmaps, and setup instructions, please refer to our `docs/` directory:

- 🗺️ [**Project Plan & Roadmap**](./docs/project/PROJECT_PLAN.md): Vision, core ideas, and phased roadmap.
- 🛠️ [**Developer Guide**](./docs/developer/DEVELOPER_GUIDE.md): Deep dive into the streaming engine, monorepo setup, CI/CD, and local testing.
- 🤖 [**Agent Context**](./docs/agent/AGENT_CONTEXT.md): System prompt and strict rulebook for AI Agents modifying this codebase.

## Development

```bash
# Install dependencies
pnpm install

# Build all packages
pnpm build

# Run all tests
pnpm test
```

## License

MIT
