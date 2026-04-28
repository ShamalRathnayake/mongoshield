# @mongoshield/provider-local

> Local filesystem storage provider for [MongoShield](https://www.npmjs.com/package/mongoshield).

## Installation

```bash
npm install @mongoshield/provider-local
```

## Usage

```typescript
import { BackupEngine } from 'mongoshield';
import { FileSystemProvider } from '@mongoshield/provider-local';

// Dumps each collection as individual .bson files to the local filesystem
const provider = new FileSystemProvider('./backups/dump', /* compress */ true);

const engine = new BackupEngine({
  target: {
    uri: 'mongodb://localhost:27017',
    dbName: 'my_database',
  },
  output: {
    gzip: true,
  },
}, provider);

await engine.run();
```

## What it does

The `FileSystemProvider` writes backup data as individual BSON and metadata files to a directory on your local filesystem, mirroring the folder structure of `mongodump`:

```
backups/dump/
  └── my_database/
      ├── users.bson.gz
      ├── users.metadata.json.gz
      ├── orders.bson.gz
      └── orders.metadata.json.gz
```

## Links

- 📦 [Main Package (`mongoshield`)](https://www.npmjs.com/package/mongoshield)
- 🐙 [GitHub Repository](https://github.com/ShamalRathnayake/mongoshield)

## License

MIT
