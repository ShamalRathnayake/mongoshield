# MongoShield AI Agent Context & Directives

**ATTENTION AI AGENTS:** This document is your Source of Truth for the MongoShield repository. 
To preserve context tokens, this file is strictly limited to **Core Directives**. It does **not** explain how the codebase works. You must dynamically read the architectural documentation when you need to understand specific subsystems.

---

## 1. Context Loading (READ BEFORE CODING)
If you need to understand how the MongoShield engine works, you MUST use the `view_file` tool to read the specific chapter of the engineering book located in `docs/developer/detailed_documentation/`:

- `00-introduction.md`: Read for project constraints and theory.
- `01-architecture.md`: Read for `pnpm` workspace structure, Tsup, Biome, and Changesets.
- `02-core-engine.md`: Read if modifying `BackupEngine`, `BSONEncoderStream`, or `EncryptionStream`.
- `03-storage-providers.md`: Read if modifying `AbstractStorageProvider`, S3/Azure logic, or the `ArchiveProvider` adapter.
- `04-public-api.md`: Read if modifying the `mongoshield` wrapper, Zod validations, or EventEmitters.

If you need practical workflow instructions (how to run Vitest, Testcontainers, or build), read:
- `docs/developer/DEVELOPER_GUIDE.md`

---

## 2. Strict Project Directives

When generating or modifying code, you MUST obey these absolute rules:

1. **NO EXTERNAL BINARIES:** You are strictly forbidden from spawning `child_process` to execute `mongodump` or `mongorestore`. Everything MUST be implemented natively via the `mongodb` Node.js driver.
2. **STREAMING ONLY:** You are strictly forbidden from using `toArray()` to load collections into memory. You MUST use asynchronous cursors (`collection.find().stream()`) and Node.js `stream.Transform` pipelines ($O(1)$ memory).
3. **STRICT TYPING:** Do not use `any` or `@ts-ignore`. 
4. **100% TEST COVERAGE:** You MUST maintain 100% unit test coverage for `@mongoshield/core`. Run `pnpm test --coverage`.
5. **VIRTUALIZED TESTING:** Do not mock database connections. Use `@testcontainers/mongodb` to spin up ephemeral Docker containers for integration tests.
6. **NO HUMAN PUBLISHING:** Do not modify `package.json` versions manually. Run `pnpm changeset` and let the Github Actions pipeline handle semantic versioning.
7. **NO CLOUD DEPENDENCIES IN CORE:** Never add AWS, Google Cloud, or Azure dependencies to `@mongoshield/core`. Cloud integrations MUST be implemented as separate provider packages (e.g. `@mongoshield/provider-s3`) that implement the `StorageProvider` interface.

---

## 3. Technology Stack

- **Manager**: `pnpm` (Workspaces)
- **Language**: TypeScript (Strict Mode)
- **Target**: Node.js `>= 20.x` (Use native `node:fs`, `node:stream`, `node:crypto`)
- **Lint/Format**: `Biome` (NO ESLint or Prettier)
- **Testing**: `Vitest` + `Testcontainers`
- **Validation**: `Zod`

---

## 4. Packages & Current State

### ✅ Phase 0, 1, 2 — Fully Complete
All packages below are fully implemented with 100% test coverage:
- **`@mongoshield/core`** (`packages/core`): Streaming engine. `BackupEngine`, `BSONEncoderStream`, `EncryptionStream` (HKDF + AES-256-GCM), `MultiplexWriteStream` (MSAF archive), `AbstractStorageProvider`, `ArchiveProvider`, `ConnectionManager`, Zod config schemas.
- **`mongoshield`** (`packages/mongoshield`): High-level Facade. `MongoShield` class with Dependency Injection, EventEmitter proxy, Zod runtime validation.
- **`@mongoshield/provider-local`** (`packages/provider-local`): `FileSystemProvider` — atomic `.tmp` rotation, `statfs` disk space checks, stale-file cleanup, age/count-based pruning.
- **`@mongoshield/provider-s3`** (`packages/provider-s3`): `S3Provider` — multipart streaming upload via `@aws-sdk/lib-storage`, prefix-based hierarchical pruning.
- **`@mongoshield/provider-google`** (`packages/provider-google`): `GoogleProvider` — resumable GCS upload streams with MD5 validation, timestamp-based pruning.
- **`@mongoshield/provider-microsoft`** (`packages/provider-microsoft`): `AzureProvider` — `uploadStream` Block Blob streaming, hierarchical prefix pruning.
- **`@mongoshield/provider-network`** (`packages/provider-network`): `SftpProvider` — custom recursive `mkdirp`, recursive SFTP `rmdirRecursive` for pruning.

### ✅ Phase 3 (Partial) — Scheduler Complete
- **`@mongoshield/scheduler`** (`packages/scheduler`): `BackupScheduler` — cron-based scheduling via `croner`, overlap prevention, configurable retries with exponential backoff, `AbortController` timeouts, graceful `SIGTERM`/`SIGINT` shutdown with configurable grace period, and atomic rolling audit log (`AuditLogger`).

### ❌ Phase 3 (Remaining) — Not Started
- **Restore Engine** — Native `.restore()` implementation. No files exist yet. Do NOT hallucinate this feature.
- **Webhooks** — Slack/Discord/Email notifications on backup events. Not implemented.
- **General File Archiving** — Static directory tarball uploads. Not implemented.

### ❌ Phase 4, 5 — Not Started
- Zero-Downtime Migration, PII Scrubbing, Oplog Tailing (`OplogTailer.ts`), Immutable Backups, AI Anomaly Detection. Do NOT hallucinate these features exist.
