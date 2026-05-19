# @mongoshield/provider-network

> SFTP storage provider for [MongoShield](https://www.npmjs.com/package/mongoshield).

A secure, performance-optimized, and memory-efficient streaming adapter to back up MongoDB databases directly to remote servers over SSH/SFTP.

## Features

- **No Intermediate Disk Writes:** Streams BSON data directly from your database cursor into remote write streams using `ssh2` SFTP wrappers.
- **Fail-Safe Preflight Validation:** Validates SFTP credentials and path structures during startup to catch connection timeouts or SSH keys failures early.
- **Recursive Remote Directory Management:** Natively creates intermediate directories on remote servers using an asynchronous recursive `mkdirp` engine.
- **Automated Directory Pruning:** Integrated retention policy compliance (by age or run count) to recursively delete old remote backup directories and sub-files (cleaning empty directories cleanly).

## Installation

```bash
npm install @mongoshield/provider-network
```

## Usage

```typescript
import { MongoShield } from 'mongoshield';
import { SftpProvider } from '@mongoshield/provider-network';

// Initialize the SFTP storage provider
const provider = new SftpProvider({
  host: 'my-remote-server.com',
  port: 22,
  username: 'backupuser',
  // You can authenticate with password
  password: process.env.SFTP_PASSWORD!,
  // Or load a private SSH Key
  // privateKey: require('fs').readFileSync('/path/to/id_rsa'),
  basePath: '/home/backupuser/db-backups/',
  compress: true, // Enable GZIP compression on the fly
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

The `SftpProvider` options extend the official `ConnectConfig` options from the `ssh2` package, allowing private keys, passphrases, and custom SSH configs:

| Option | Type | Required | Description |
|---|---|---|---|
| `host` | `string` | **Yes** | Hostname or IP address of the target server. |
| `port` | `number` | No | SSH port (defaults to `22`). |
| `username` | `string` | **Yes** | Username for SSH authentication. |
| `password` | `string` | No | Password for auth. |
| `privateKey` | `Buffer | string` | No | Private key buffer/string for auth. |
| `basePath` | `string` | No | Base directory path on the remote server (defaults to `"/backups"`). |
| `compress` | `boolean` | No | Toggle on-the-fly GZIP compression (defaults to `false`). |

## License

MIT
