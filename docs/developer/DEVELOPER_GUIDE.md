# MongoShield Developer & Contribution Guide

Welcome to the MongoShield codebase. This document is a comprehensive, step-by-step technical breakdown of the entire project architecture. It is designed to be deeply detailed so that any developer—regardless of seniority—can instantly understand how the project is structured, how the streaming engine works under the hood, and how to safely contribute.

---

## 1. Monorepo Architecture (pnpm Workspaces)

MongoShield is built as a **Monorepo** managed by `pnpm`. 

### Why a Monorepo?
A data utility like MongoShield will eventually connect to multiple external services (AWS S3, Google Drive, Azure Blob). If a user only wants to save backups to their local disk, forcing them to download the massive AWS SDK is a terrible Developer Experience (DX) and bloats their deployment.

Instead, we use a "plug-and-play" architecture:
*   **`packages/core`**: The brain of the operation. It contains the native Node.js MongoDB streaming logic, encryption transforms, config validation, and the generic interfaces. It has nearly zero external dependencies.
*   **`packages/provider-local`**: A specific adapter plugin that implements the Core's `StorageProvider` interface to write files to the local disk using the `node:fs` module.
*   **`packages/provider-s3`**: A specific adapter plugin that contains *only* the AWS integration. It declares `@mongoshield/core` as a dependency and handles the heavy lifting of communicating with the cloud.

When a user installs MongoShield, they only install the specific packages they actually need.

### Module Resolution & Bundling
We write our code in modern TypeScript. However, Node.js is currently fractured between Legacy CommonJS (`require()`) and Modern ECMAScript Modules (`import`). A premium library must support both flawlessly.

*   **`tsup`**: We use `tsup` (powered by `esbuild`) to compile our TypeScript. The `tsup.config.ts` file in each package compiles the code into both `cjs` and `esm` formats, while eagerly applying "Tree Shaking" (deleting unused code).
*   **`package.json` Exports**: The `"exports"` map in the package JSONs acts as a traffic controller. If a user's app uses `import`, Node routes them to the `.mjs` file. If they use `require`, it routes them to the `.js` file.

---

## 2. The Database Streaming Engine (Under the Hood)

The core innovation of MongoShield is that it **does not use the `mongodump` binary**. It achieves feature-parity natively.

### Step-by-Step Data Extraction
When `BackupEngine.run()` is executed, here is the exact technical flow:

1.  **Configuration Validation**: Inputs are passed through strict `zod` schemas (`src/config/`). If the user provides a bad URI or a port like `999999`, it fails immediately before touching the database.
2.  **Connection**: The `ConnectionManager` connects to MongoDB using the native Node.js driver (`MongoClient`).
3.  **Collection Discovery**: The engine queries `db.listCollections()` to build a dependency tree. It applies any user-defined inclusion, exclusion, or prefix filters to determine exactly what needs to be backed up.
4.  **The Cursor Stream**: For each targeted collection, we create a cursor (`collection.find()`). Instead of loading all the results into an array (which would crash the server on large databases), we call `.stream()`. This trickles the BSON documents out one by one into our memory pipeline.
5.  **Transformation Pipeline (Node.js Streams)**:
    *   `BSONEncoderStream`: Takes the raw JavaScript objects emitted by the cursor and encodes them into strict binary BSON buffers. This is critical so that standard `mongorestore` tools can eventually read our backups.
    *   `GzipTransform`: A native `node:zlib` stream that compresses the BSON buffers on the fly.
    *   `EncryptionStream`: Uses `node:crypto` (`AES-256-GCM`) to encrypt the compressed buffers before they leave the server. It generates a 32-byte salt per stream and derives a unique encryption key via HKDF-SHA256 to ensure perfect cryptographic isolation.
6.  **Provider Handoff**: The fully encrypted, compressed chunk of binary data is handed off to a `StorageProvider`. All actual providers extend `AbstractStorageProvider`, which intercepts the stream, wraps it in a `PassThrough` to automatically emit progress telemetry, sanitizes the path against traversal attacks, and passes it to the specific cloud adapter (like S3 or LocalFileSystem) which writes it to the final destination.

Because this is a continuous pipeline, MongoShield uses a minimal, constant amount of RAM regardless of whether the database is 50MB or 500GB.

---

## 3. Shift-Left Code Quality & Git Hooks

We utilize strict tooling to ensure code quality is enforced *before* code ever reaches GitHub.

*   **Biome (`biome.json`)**: We use Biome (a blazingly fast Rust-based toolchain) to instantly format and lint code, replacing the traditional ESLint/Prettier setup.
*   **Husky & Lint-Staged**: Husky intercepts Git commands. When you type `git commit`, our `.husky/pre-commit` hook triggers `lint-staged`. This automatically formats only the files you modified. It also runs `pnpm audit` to physically block your commit if you added a dependency with a known critical security vulnerability.
*   **Semantic Commits**: CI/CD pipelines need to know whether to bump the package version as a "Major", "Minor", or "Patch" release. We enforce Semantic Commit conventions. If you try to run `git commit -m "fixed stuff"`, the `@commitlint/cli` hook will violently reject it. Use standard prefixes like `feat:`, `fix:`, or `chore:`.

---

## 4. Testing & Database Virtualization

MongoShield interacts directly with databases. Mocking database connections in tests is dangerous and leads to false positives. We must test against real running databases.

*   **Vitest**: Our unit testing framework, natively aware of ESM formats.
*   **Testcontainers (`@testcontainers/mongodb`)**: This is a game-changing library. During an integration test run, Testcontainers programmatically reaches out to your local Docker daemon, spins up a brand-new, isolated instance of MongoDB in a container, provides the connection string to Vitest, runs the tests against a real database, and then cleanly destroys the container. 
*   **Requirement**: You MUST have Docker Desktop (or the Docker Daemon) running locally to execute the test suite.

---

## 5. Local Setup Instructions

To get your local environment ready for development:

1.  **Install pnpm**: The project strictly uses `pnpm` for workspace management. Ensure you have Node.js >= 20.x installed.
    ```bash
    npm install -g pnpm
    ```
2.  **Install Dependencies**: Run this at the root. It will link all the workspace packages together.
    ```bash
    pnpm install
    ```
3.  **Run the Build**: Compiles TypeScript into ESM/CJS across all packages.
    ```bash
    pnpm build
    ```
4.  **Run Tests**: Ensure Docker is running first!
    ```bash
    pnpm test
    ```

---

## 6. Current State & Known Gaps

The codebase has successfully completed **Phase 1 (Core Engine)** and is currently in **Phase 2 (MVP Release)**.

### Completed in Phase 1:
*   **Native BSON Engine**: 100% binary parity with `mongodump` via `BSONEncoderStream`.
*   **High-Security Pipeline**: HKDF key derivation and AES-256-GCM encryption.
*   **MSAF Protocol**: Implementation of the **MongoShield Archive Format (MSAF)** which allows multiplexing multiple collections into a single streaming file with headers and EOF markers.
*   **100% Unit Test Coverage**: The `@mongoshield/core` package maintains a strict 100% unit test coverage requirement for all logic branches.

### In Progress (Phase 2):
*   **Cloud Providers**: The `@mongoshield/provider-s3` package is under development to support direct-to-cloud streaming.
*   **Separation of Concerns**: We have successfully separated our logic! The `FileSystemProvider` lives in the standalone `@mongoshield/provider-local` package, while the `ArchiveProvider` remains in `@mongoshield/core` as a pure **Middleware** that wraps downstream providers to create monolithic `.msaf` files.

### Upcoming (Phase 5):
*   **Oplog Tailing (`OplogTailer.ts`)**: Real-time incremental backups for Point-In-Time Recovery.

When contributing, please refer to the `PROJECT_PLAN.md` to see what phase of development is currently active.
