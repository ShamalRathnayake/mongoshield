# MongoShield Project Plan & Roadmap

## 1. The Core Vision
**MongoShield** is a modern, highly secure, and entirely self-contained MongoDB data protection utility built specifically for the Node.js and TypeScript ecosystems.

**The Problem:** Most Node.js database backup tools (like the deprecated `mongodb-backup-cloud`) are just "wrappers." They secretly rely on your server having MongoDB's official `mongodump` and `mongorestore` tools installed. This causes them to instantly fail in modern, constrained environments like Vercel Serverless Functions, AWS Lambda, or minimal Docker containers where you cannot install system-level software.

**The MongoShield Solution:** We eliminate external dependencies entirely. MongoShield uses the native Node.js MongoDB driver to read your database directly. It extracts your data as a continuous "stream", compresses it, encrypts it on the fly, and sends it straight to cloud storage (like AWS S3). 

### Key Guarantees
1. **Absolute Portability ("Plug-and-Play"):** If your server can run Node.js, it can run MongoShield. No extra software needed.
2. **"No-Crash" Streaming Architecture:** Even if your database is 500GB, MongoShield streams the data in tiny chunks. It uses minimal, constant RAM, preventing your server from running out of memory.
3. **Military-Grade Security:** Data is encrypted with quantum-resistant algorithms *before* a single byte leaves your server to go to the cloud.

---

## 2. Development Roadmap
To ensure safe, test-driven delivery, the complete feature set is structured into distinct developmental phases. We are progressively building towards the ultimate "Futuristic Enterprise" tier.

### Phase 0: The Foundation (Completed)
**Goal:** Secure the NPM package name and establish the project architecture.
* Initialize strict TypeScript monorepo using `pnpm` workspaces.
* Setup build systems (`tsup`), testing (`vitest` with `testcontainers`), and CI/CD automated publishing.

### Phase 1: The Core Engine (Completed)
**Goal:** Build the underlying native Node.js data extraction engine, entirely removing the dependency on external binaries, while mirroring `mongodump` feature parity.
* **Stream Pipeline:** Connect to MongoDB, iterate through collections, and generate a readable BSON stream using native cursors.
* **Transformations:** Implement on-the-fly GZIP compression and native AES-256-GCM encryption with HKDF.
* **Modular Storage:** Create the `AbstractStorageProvider` and `ArchiveProvider` (MSAF) to securely manage and multiplex streams.

### Phase 2: The MVP Release (Completed)
**Goal:** Achieve feature-parity with deprecated tools but on our superior architecture. This is the first version recommended for general public use.
* **Runtime Validation (Completed):** Implement `zod` to strictly validate configuration URIs and credentials.
* **Lifecycle Hooks (Completed):** Implement native event emitters (`progress`, `error`) so developers can build custom logging.
* **Cloud Providers (Modular Ecosystem) (Completed):** To maintain absolute portability and minimal package size, cloud providers are organized into "Ecosystem" packages. This allows users to only install the dependencies required for their target platform. See [Provider Architecture](./PROVIDER_ARCHITECTURE.md) for details.
    * ✅ `@mongoshield/provider-local` (Filesystem, NFS, SMB)
    * ✅ `@mongoshield/provider-s3` (AWS, DigitalOcean, R2, B2)
    * ✅ `@mongoshield/provider-google` (GCS, Drive)
    * ✅ `@mongoshield/provider-microsoft` (Azure, OneDrive)
    * ✅ `@mongoshield/provider-network` (SFTP, WebDAV)
* **Automated Pruning (Completed):** Every provider must implement a mandatory `prune()` interface to support automated old record deletion (by count or by age).

### Phase 3: The "Pro" Defenses (In Progress)
**Goal:** Transform MongoShield from a one-way backup script into a robust, two-way, programmable data utility.
* **Native Restore Engine (`.restore()`):** The exact opposite of the backup. Fetch a remote archive, decompress it, and pump data back into a target database via massive parallel bulk operations.
* ✅ **Built-In Scheduler (Completed):** A production-grade backup scheduler (cron) with overlap prevention, exponential backoff retries, and detailed audit logging (persisting last 100 runs). See [Scheduler Plan](./SCHEDULER_PLAN.md) for details.
* **General File Archiving:** Allow developers to specify static server directories (like user uploads) to be tarballed and uploaded alongside the database.
* **Remote Pruning Policies:** APIs to automatically delete old backups in the cloud to save costs.
* **Integrated Webhooks:** Easily send success/failure notifications to Slack, Discord, or Email.

### Phase 4: The Enterprise Pipeline
**Goal:** Introduce advanced DevOps workflows that save bandwidth, automate recovery testing, and allow safe staging environment replication.
* **Zero-Downtime Live Migration:** Pipe the backup stream directly into the restore stream in memory to clone production to staging instantly.
* **PII Scrubbing:** Randomly hash specific paths (like user passwords or emails) during live migrations so staging environments never hold sensitive plain-text data.
* **Zero-Trust Validation:** A background worker that downloads backup chunks to mathematically verify the archive is not corrupted.

### Phase 5: The "Futuristic" Pinnacle
**Goal:** Push Node.js data protection to its absolute limit, rivalling fully-managed cloud database providers like MongoDB Atlas.
* **Point-in-Time Recovery (PiTR):** Listen to the database's replica set log (Oplog) and stream incremental changes to S3 every 5 minutes, allowing rollback to the *exact second* before a disastrous query.
* **Immutable Backups:** Native integration with AWS S3 Object Lock (WORM policies) to guarantee mathematically that a ransomware attacker cannot delete your backups.
* **AI-Driven Anomaly Detection:** Profile the database size. Automatically abort the backup if the outgoing data is suddenly 80% smaller than average, preventing you from overwriting a good backup with an empty one after an accidental `drop()`.
* **Queryable Archives:** Decrypt and search through a remote S3 zip file to recover a single deleted user document without downloading the entire 100GB archive.
