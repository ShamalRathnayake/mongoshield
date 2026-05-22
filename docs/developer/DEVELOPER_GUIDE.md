# MongoShield Contributor Workflow & Developer Guide

Welcome to the MongoShield codebase! This document explains **how to work on the project practically**. 

> [!TIP]
> **Looking for the Architectural Deep Dive?** If you want to understand how the streaming engine works under the hood, read the comprehensive engineering book in the `detailed_documentation` directory:
> 1. [Introduction & Theory](./detailed_documentation/00-introduction.md)
> 2. [Architecture & CI/CD](./detailed_documentation/01-architecture.md)
> 3. [The Core Engine](./detailed_documentation/02-core-engine.md)
> 4. [Storage Providers & Networking](./detailed_documentation/03-storage-providers.md)
> 5. [The Public API](./detailed_documentation/04-public-api.md)

---

## 1. Local Setup & Prerequisites

To contribute to MongoShield, you must have the following installed on your machine:
*   **Node.js**: `>= 20.x` (We rely on native web crypto and fetch APIs)
*   **pnpm**: `v9.x` (`npm install -g pnpm`)
*   **Docker Desktop / Daemon**: Required for running integration tests against real MongoDB instances via Testcontainers.

### Initialization
```bash
# 1. Clone the repository
git clone https://github.com/ShamalRathnayake/mongoshield.git
cd mongoshield

# 2. Install monorepo dependencies and link workspaces
pnpm install

# 3. Build all packages (generates /dist folders)
pnpm build
```

---

## 2. Development Workflow

MongoShield enforces strict code quality using a "shift-left" approach. If your code isn't perfectly formatted or tested, the Git Hooks will block you from committing.

### 2.1 Formatting & Linting
We use **Biome** instead of ESLint/Prettier. It is blazingly fast.
```bash
# Format the entire codebase instantly
pnpm format

# Run linter
pnpm lint
```
*Tip: Install the Biome VS Code extension and enable "Format on Save".*

### 2.2 Running Tests
Mocking databases is dangerous. MongoShield uses **Vitest** paired with **Testcontainers**. When you run tests, it will automatically pull a real MongoDB Docker image and run assertions against a live database.

```bash
# Make sure Docker is running!
pnpm test

# Run tests and check coverage
pnpm test --coverage
```
> [!IMPORTANT]  
> We enforce **100% V8 Test Coverage** on all logic branches in `@mongoshield/core`. Pull Requests that drop coverage below 100% will be automatically rejected by the CI Gatekeeper.

### 2.3 Committing Code (Commitizen)
Do **not** use `git commit -m "my message"`. We use Semantic Release versioning, which requires strict commit formats (`feat:`, `fix:`, `chore:`).

```bash
git add .
pnpm commit
```
This launches an interactive CLI wizard that will guide you through writing a semantic commit. 

When you finish the wizard, **Husky** will intercept the commit, run `biome` on your staged files, run `pnpm audit` to check for critical CVEs, and finally validate your commit message format.

---

## 3. Extending MongoShield: Writing a New Storage Provider

MongoShield was designed to be extended. If you want to add support for a new cloud provider (e.g., Google Cloud Storage or DigitalOcean Spaces), follow this workflow:

### Step 1: Scaffold the Package
Create a new folder in `packages/` (e.g., `packages/provider-gcs`). 
Copy the `package.json`, `tsup.config.ts`, and `tsconfig.json` from `packages/provider-local` and update the package name to `@mongoshield/provider-gcs`.

### Step 2: Implement the Abstract Class
Your new provider must extend `AbstractStorageProvider` from `@mongoshield/core`.

```typescript
import { AbstractStorageProvider } from "@mongoshield/core";
import { Storage } from "@google-cloud/storage";

export class GcsProvider extends AbstractStorageProvider {
  private storage = new Storage();

  protected async _initialize(expectedSizeInBytes?: number): Promise<void> {
    // 1. Authenticate with GCS
    // 2. Throw an error if the bucket doesn't exist or is unreachable
  }

  protected async _createBsonWriteStream(db: string, coll: string): Promise<Writable> {
    // Return a Writable stream that pipes directly to a GCS Bucket object
  }

  protected async _createMetadataWriteStream(db: string, coll: string): Promise<Writable> {
    // Return a Writable stream for the JSON metadata
  }

  protected async _createArchiveWriteStream(archiveName: string): Promise<Writable> {
    // Return a Writable stream for monolithic .archive uploads
  }

  protected async _finalize(): Promise<void> {
    // Await any background multipart upload promises here
  }

  protected async _prune(policy: PruningPolicy): Promise<PruningResult> {
    // Delete old backups based on maxDays or maxCount
  }
}
```

### Step 3: Enforce Security
You do **not** need to worry about:
*   Telemetry/Progress bars
*   Path Traversal vulnerabilities (`../../../`)
*   Catching uncaught stream errors

The `AbstractStorageProvider` handles these automatically before calling your `_createBsonWriteStream` method.

---

## 4. The Release Process (Changesets)

We use [Changesets](https://github.com/changesets/changesets) to automate npm publishing and changelog generation.

When you finish a feature and are ready to open a Pull Request, you must declare how your change affects the version of the package.

```bash
# Run this before opening your PR
pnpm changeset
```
1. Select which packages you modified (e.g., `@mongoshield/core`).
2. Select whether this is a **Major** (breaking), **Minor** (feature), or **Patch** (bugfix).
3. Write a short description for the Changelog.

This will generate a `.md` file in the `.changeset/` folder. **Commit this file to your branch.**
When your PR is merged into `main`, the CI/CD pipeline will automatically read the `.md` file, bump the version, build the dist folders, and publish to NPM via GitHub OIDC Provenance!
