# MongoShield: contributor and agent guide

This file is the source of truth for how code in this repository is written.
It applies to humans and AI agents alike. Read it fully before changing anything.

MongoShield is a TypeScript library and CLI that backs up, restores and copies
MongoDB databases without the `mongodump` binary. The product plan lives at
https://claude.ai/artifact/J3ZugGcu1a4ecEgk5nLW97.

## Repository layout

```
packages/mongoshield/          the npm package `mongoshield` (library + CLI)
  src/
    index.ts                   public API; everything exported here is semver-covered
    types.ts                   public option/result types (contract between engine, API and CLI)
    errors.ts                  MongoShieldError + stable error codes
    logger.ts                  tiny Logger interface (no logging by default)
    redact.ts                  keep secrets out of logs/errors/manifests
    storage/                   StorageAdapter interface, key validation, file/memory/s3 adapters
    format/                    manifest schema, backup layout, BSON streams, mongodump metadata
    compression/               zstd / gzip / none streams
    crypto/                    age v1 encryption (streaming)
    mongo/                     connecting, topology, namespace discovery, collection specs
    catalog/                   listing backups, selecting one, retention planning
    engine/                    backup, restore, verify pipelines
    config/                    defineConfig + config-file loading
    cli/                       `mongoshield` command
  test/
    helpers/                   shared test helpers (real mongod via mongodb-memory-server)
    integration/               tests that need a real database
docs/                          docs and specs (FORMAT.md, ENCRYPTION.md, …)
```

## Commands

Run from the repository root (`corepack pnpm …` if `pnpm` is not on PATH):

| Command | What it does |
|---|---|
| `pnpm test` | unit + integration tests |
| `pnpm test:unit` | fast tests next to the source (`src/**/*.test.ts`) |
| `pnpm test:integration` | tests against a real mongod (`test/integration`) |
| `pnpm typecheck` | `tsc` in strict mode |
| `pnpm lint` / `pnpm lint:fix` | Biome lint + format |
| `pnpm build` | bundle with tsdown into `dist/` |
| `pnpm check` | everything CI runs |

Integration tests start a single-node replica set. Locally, export
`MONGOMS_SYSTEM_BINARY=$(which mongod)` to use an installed `mongod` instead of downloading one.

## Code style: readable at a glance

The maintainer must be able to open any file and understand it quickly. This matters
more than brevity or cleverness.

1. **Comment generously.** Every file starts with a short header comment saying what it is
   for and how it fits in. Every exported function, class, type and constant has a JSDoc
   comment. Non-obvious blocks get a comment explaining *why*, not just *what*. Explain
   magic numbers, byte layouts, protocol details and edge cases where they appear.
2. **Small, named pieces.** Prefer short functions with descriptive names over long ones.
   Name things for what they mean in the domain (`namespace`, `manifest`, `recipient`).
3. **No cleverness.** Plain loops over dense chained expressions when it reads better.
   No single-letter names outside tiny lambdas.
4. **Strict types.** No `any`, no `@ts-ignore`, no non-null assertions (`!`) in `src/`.
   Use `unknown` and narrow it. `exactOptionalPropertyTypes` is on.
5. **Imports** use explicit `.ts` extensions and `import type` for types.
   Node built-ins use the `node:` prefix.
6. **Errors** are always `MongoShieldError` with a code from `src/errors.ts`, a message that
   says what went wrong, and a `hint` that says how to fix it when there is one.
   Never put secrets (URIs with passwords, keys, passphrases) in messages; use `src/redact.ts`.
7. **Streams** use `node:stream` + `stream/promises.pipeline` and respect backpressure.
   Never buffer a whole collection or file in memory. Never call `toArray()` on data cursors.
8. **Cancellation:** long operations accept an `AbortSignal` and call `throwIfAborted()`.
9. **No console output** in library code. Use the injected `Logger`. Only `src/cli` prints.

## Tests

- Unit tests live next to the code as `*.test.ts`. Integration tests live in `test/integration`.
- Anything that touches MongoDB is tested against a real mongod (see `test/helpers/mongo.ts`),
  never a mocked driver. Use `uniqueDb()` so tests can run in parallel.
- Test names read as sentences describing behaviour.
- Use `fast-check` for property tests where inputs vary widely (BSON, keys, byte streams).
- Every documented option needs a test that proves it does what the docs say.

## Hard rules

- Never spawn `mongodump`, `mongorestore` or any other binary from library code.
- Never add cloud SDKs as regular dependencies. They are optional peer dependencies,
  imported lazily inside the adapter that needs them.
- Never change `package.json`, `pnpm-lock.yaml` or root configs as part of feature work
  without saying so explicitly; dependency changes are reviewed on their own.
- The on-disk format (manifest, layout, encryption) is a public contract. Changes need an
  update to `docs/specs/` and a format version bump when old readers would break.
- Do not change the package version by hand; use `pnpm changeset`.
