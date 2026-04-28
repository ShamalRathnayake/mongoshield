# @mongoshield/provider-s3

> AWS S3 and S3-compatible storage provider for [MongoShield](https://www.npmjs.com/package/mongoshield).

🚧 **This package is under active development.** The S3 upload implementation is coming in a future release.

## Installation

```bash
npm install @mongoshield/provider-s3
```

## Planned Usage

```typescript
import { BackupEngine } from 'mongoshield';
import { S3Provider } from '@mongoshield/provider-s3';

const provider = new S3Provider({
  bucket: 'my-backup-bucket',
  region: 'us-east-1',
  prefix: 'mongo-backups/',
});

const engine = new BackupEngine({
  target: {
    uri: 'mongodb://localhost:27017',
    dbName: 'production_db',
  },
  output: {
    gzip: true,
    encryptionKey: 'your-64-character-hex-master-key',
  },
}, provider);

await engine.run();
```

## Links

- 📦 [Main Package (`mongoshield`)](https://www.npmjs.com/package/mongoshield)
- 🐙 [GitHub Repository](https://github.com/ShamalRathnayake/mongoshield)

## License

MIT
