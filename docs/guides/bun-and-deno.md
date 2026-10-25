# Bun and Deno

MongoShield runs on **Bun** and **Deno** as well as Node.js: the library, the CLI and
config files, with the same backup format byte for byte. A backup written under one
runtime restores under any other.

| Runtime | Minimum | Tested in CI |
|---|---|---|
| Node.js | 22.12 | 22, 24 (`ci.yml`) |
| Bun | 1.4.0 | 1.4.0, 1.4.4 (`runtimes.yml`) |
| Deno | 2.9.0 | 2.9.0, 2.9.8 (`runtimes.yml`) |

The `mongodb` driver is still a peer dependency (6.10+ or 7.x), whatever the runtime.

## Bun

```bash
bun add mongoshield mongodb
bunx --bun mongoshield backup --to ./backups
```

`--bun` makes Bun run the CLI itself. Without it, `bunx` follows the `#!/usr/bin/env node`
line of the bin and runs it with Node.js when Node.js is installed.

The library is used exactly as on Node.js:

```ts
import { MongoShield } from "mongoshield";
import { fileStorage } from "mongoshield/storage/file";

const shield = new MongoShield({
  source: { uri: process.env.MONGODB_URI! },
  storage: fileStorage({ path: "./backups" }),
  encryption: { recipients: [process.env.BACKUP_PUBLIC_KEY!] },
});
const backup = await shield.backup();
await shield.close();
```

## Deno

Without installing anything:

```bash
deno run -A npm:mongoshield backup --to ./backups
```

`-A` grants every permission. The CLI needs only these, if you prefer to list them:

```bash
deno run --allow-env --allow-read --allow-write --allow-net --allow-sys \
  npm:mongoshield backup --to ./backups
```

`--allow-sys` is for the MongoDB driver, which sends the host name and OS to the server
when it connects. In a Deno project, add the packages and import them by name:

```bash
deno add npm:mongoshield npm:mongodb
```

```ts
import { MongoShield } from "mongoshield";
import { s3Storage } from "mongoshield/storage/s3";
```

Every entry point in the package's `exports` (`mongoshield`, `mongoshield/storage/*`,
`mongoshield/kms`, `mongoshield/testing`) resolves the same way in Node.js, Bun and Deno.

## What is tested

`packages/mongoshield/test/runtimes` runs the built package under each runtime against a
real `mongod`, on every pull request:

| Area | Checked |
|---|---|
| Package | every entry point loads; the bin runs as an installed package (`bunx --bun`, `deno run npm:`) |
| Backup → deep verify → restore | zstd and gzip and none; age recipients and passphrases (scrypt); file, memory and S3 storage (S3Mock) |
| Damaged data | a corrupted zstd file is reported (`MS_INTEGRITY_FAILED`, a failed deep verify), never crashes the process |
| Cancellation | an `AbortSignal` stops a running backup with `MS_ABORTED` |
| Backpressure | while the storage consumer stands still, reads from MongoDB stop and memory stays flat |
| CLI | `keygen`, `backup`, `list`, `verify --deep`, `restore --rename`, a `mongoshield.config.ts` file, Ctrl-C (exit code 60) |

Run it yourself (it builds the package first; `MONGOMS_SYSTEM_BINARY` reuses a local
`mongod`):

```bash
MONGOMS_SYSTEM_BINARY=$(which mongod) pnpm --filter mongoshield test:runtimes
pnpm --filter mongoshield test:runtimes --runtime bun --require --s3   # one runtime, plus S3Mock (Docker)
```

## Differences MongoShield handles for you

These are runtime gaps MongoShield detects by feature, not by runtime name, and works
around. You do not need to configure anything.

- **Bun has no ChaCha20-Poly1305 in `node:crypto`** (nor in Web Crypto), and age encrypts
  everything with it. Where the cipher is missing, MongoShield uses the audited
  [`@noble/ciphers`](https://github.com/paulmillr/noble-ciphers) implementation, a
  dependency of the package that is loaded only on such runtimes (Node.js and Deno never
  load it). Its output is identical to OpenSSL's, which MongoShield's tests check against
  the RFC 8439 vectors, against `node:crypto` on random inputs and with the official age
  test vectors, so backups stay readable by the `age` CLI. It is slower than OpenSSL: about
  90 to 105 MB/s per CPU core on an Apple M5 Pro under Bun 1.4.4, so encrypted backups on
  Bun become CPU-bound sooner. Unencrypted backups, and X25519, scrypt and HKDF (which Bun
  has), are unaffected.
- **Deno's `node:zlib` can throw a zstd error outside the stream.** When a damaged zstd
  file decompresses to more than 16 KiB before the damage is found, Deno raises the error
  from a callback instead of failing the stream, which crashed the process. MongoShield
  turns it back into a normal stream error, so you get `MS_INTEGRITY_FAILED` like on
  Node.js.

## Not supported, or not tested yet

- **Older runtimes.** Bun before 1.4 cannot load `bson` 7 (the MongoDB driver 7's BSON
  library): it throws on `v8.startupSnapshot.isBuildingSnapshot()`. Driver 6.x may work
  on older Bun, but this is not tested. Deno before 2.9 is not supported: 2.7 and 2.8
  crash on damaged zstd data (the gap above, through an internal method MongoShield does
  not wrap), 2.6 rejects zstd compression parameters, and 2.5 and older lack `fs.statfs`.
- **Not tested under Bun or Deno yet:** Google Cloud Storage, Azure Blob Storage, SFTP
  (`ssh2`), cloud KMS (AWS, Google Cloud, Azure), OpenTelemetry, the change journal and
  point-in-time restores, and `mongoshield schedule` / `run`. Their entry points load,
  but their SDKs and code paths have only been exercised on Node.js. Reports are welcome.
- **The web console** (`@mongoshield/console`) is a Node.js application.
- **Edge and serverless runtimes without TCP sockets or a file system** (Deno Deploy,
  Bun or Deno compiled into edge functions, Cloudflare Workers) cannot run MongoShield,
  because the MongoDB driver needs raw TCP. Single-file executables (`bun build --compile`,
  `deno compile`) are untested.
