# MongoShield AI Agent Context & Directives

**ATTENTION AI AGENTS:** This document is your System Prompt and Source of Truth for the MongoShield repository. Read this entirely before making any modifications to the codebase. 

---

## 1. Core Project Identity & Directives

**MongoShield** is a 100% native Node.js MongoDB data protection utility. 

**CRITICAL DIRECTIVES:**
1. **NO EXTERNAL BINARIES:** You are strictly forbidden from writing code that spawns `child_process` to execute `mongodump` or `mongorestore`. Everything MUST be implemented natively using the `mongodb` Node.js driver.
2. **STREAMING ONLY:** You are strictly forbidden from loading entire collections or databases into memory (`toArray()`). You MUST use asynchronous cursors (`collection.find().stream()`) and Node.js `stream.Transform` pipelines to process data. The engine must be "No-Crash" regardless of database size.
3. **STRICT TYPING:** Do not use `any` or `@ts-ignore` to bypass type errors. The project relies on deep type safety.
4. **100% TEST COVERAGE:** You MUST maintain 100% unit test coverage (statements, lines, branches) for the `@mongoshield/core` package. Every PR must be verified with `pnpm test --coverage`.
5. **NO HUMAN INTERVENTION FOR PUBLISHING:** Do not modify package versions manually. We use `@changesets/cli` and automated semantic versioning. 
6. **DOCUMENTATION PARITY:** Whenever you add a new feature, change an architecture pattern, or modify the monorepo structure, you MUST immediately update this document (`AGENT_CONTEXT.md`), the `DEVELOPER_GUIDE.md`, and the `PROJECT_PLAN.md`.

---

## 2. Monorepo Architecture

This project is a strict Monorepo managed by `pnpm workspaces`. 

*   **`@mongoshield/core` (`packages/core`)**: The pure engine. It connects to MongoDB, extracts the stream, compresses it, encrypts it, and writes it to a generic `StorageProvider` interface. It includes the `ArchiveProvider` (MSAF) middleware for monolithic stream multiplexing.
*   **`@mongoshield/provider-*` (e.g., `packages/provider-s3`)**: Specific cloud adapters. These packages declare `@mongoshield/core` as a dependency and implement the `StorageProvider` interface to pipe the compressed, encrypted data stream to external services (like AWS S3). 

**Rule:** Never add AWS, Google Cloud, or Azure dependencies to `@mongoshield/core`. Cloud integrations MUST be separate provider packages.

---

## 3. Technology Stack & Tooling

When modifying configuration or adding tooling, adhere to the following stack:

*   **Package Manager**: `pnpm`
*   **Language**: TypeScript (Strict Mode).
*   **Target Environments**: Node.js `>= 20.x`. Prefer native Node.js APIs (`node:fs`, `node:stream`, `node:crypto`, `fetch()`) over external polyfills.
*   **Linting & Formatting**: `Biome` (`biome.json`). Do NOT use ESLint or Prettier.
*   **Bundler**: `tsup` configured for dual-builds (`esm` and `cjs`).
*   **Testing**: `Vitest` + `v8` coverage (Strict 100% threshold).
*   **Database Virtualization**: `@testcontainers/mongodb`. ALL integration tests must spin up an ephemeral Docker container instead of mocking the database connection.
*   **Git Hooks**: `Husky` + `lint-staged` + `commitlint`.
*   **Configuration Validation**: `Zod` (`zod` schemas in `src/config/`).

---

## 4. Current State & Implementation Gaps

As an agent, you must be aware of the exact current state of the codebase. We are in **Phase 2 (MVP Release)**, with Phase 1 fully completed. 

**Working Features:**
*   Monorepo linking.
*   Native connection via `MongoClient` with TLS/Auth support.
*   BSON Encoding (`BSONEncoderStream`).
*   GZIP Compression.
*   AES Encryption (`EncryptionStream` with HKDF-SHA256).
*   Archive multiplexing (`ArchiveProvider` using MSAF protocol).
*   100% Unit Test Coverage for core logic.
*   Vitest integration with Testcontainers.

**Known Gaps & Stubs (DO NOT HALLUCINATE THESE FEATURES EXIST):**
*   `OplogTailer.ts` is missing. We need a class that queries the `local.oplog.rs` replica set collection and streams incremental changes. (Note: This is scheduled for Phase 5).

---

## 5. Security Context

Data protection tools are high-value targets. 
*   **Encryption**: Encryption (`node:crypto`) must be applied to the stream *before* it hits any network provider. We use `AES-256-GCM` initialized via HKDF-SHA256 key derivation with a per-stream 32-byte salt. Key reuse is impossible. The salt and IV are prepended to the stream.
*   **Path Traversal**: Providers MUST extend `AbstractStorageProvider` which automatically sanitizes `dbName` and `collectionName` against path traversal attacks (e.g., rejecting `../../etc`).
*   **Validation**: Inputs MUST be strictly validated via Zod schemas, specifically enforcing enums and regex validators before establishing database connections.
*   **CI Security Checks**: `pnpm audit` is strictly enforced in the Git pre-commit hook and Github Actions pipelines. Do not add highly volatile dependencies.
