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
import { BackupEngine, ArchiveProvider } from '@mongoshield/core';

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

## License
MIT
