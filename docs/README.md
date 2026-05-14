**MongoShield Documentation**

***

# MongoShield 🛡️

**Status:** ✅ PHASE 1 (CORE ENGINE) COMPLETE | 🚧 PHASE 2 (MVP) ACTIVE 🚧

**MongoShield** is a revolutionary, highly secure, and entirely self-contained MongoDB data protection utility tailored specifically for modern Node.js and TypeScript ecosystems. 

### Why this package?

The core motivation behind MongoShield is to solve the glaring flaws present in the deprecated `mongodb-backup-cloud` package and most other Node.js database backup tools. The vast majority of existing tools act as simple wrappers around the host operating system's `mongodump` and `mongorestore` binaries. This creates a massive limitation: they fail immediately in constrained environments where developers cannot install system-level database tools (such as Serverless Functions on Vercel/AWS Lambda, minimal Docker containers, or PaaS deployments like Heroku).

**MongoShield eliminates this dependency entirely.** It is built purely on the native Node.js MongoDB driver.

## Documentation

For deep technical details, roadmaps, and setup instructions, please refer to our `docs/` directory:

- 🗺️ [**Project Plan & Roadmap**](_media/PROJECT_PLAN.md): Vision, core ideas, and phased roadmap.
- 🛠️ [**Developer Guide**](_media/DEVELOPER_GUIDE.md): Deep dive into the streaming engine, monorepo setup, CI/CD, and local testing.
- 🤖 [**Agent Context**](_media/AGENT_CONTEXT.md): System prompt and strict rulebook for AI Agents modifying this codebase.

### Usage Example

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
    target: { 
      dbName: 'production_db', // Omit for full cluster backup!
      collections: ['users', 'orders']
    },
    output: {
      encryptionKey: 'your-64-character-hex-master-key' // Optional
    }
  },
  storage: archivePlugin
});

shield.on("progress", (bytes) => console.log(`Wrote ${bytes} bytes`));

// 4. Run the backup!
await shield.backup();
console.log('Backup completed successfully!');
```

## License
MIT
