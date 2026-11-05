---
"mongoshield": minor
---

Platform and credential fixes found by the environment and security audits:

- zstd is only chosen where the runtime has it (Node 22.15 / 23.8 and later): the
  `atlas-free` / `atlas-flex` presets and the config written by `mongoshield init` use
  gzip on Node 22.12-22.14 instead of failing every backup. `defaultCompression()` and
  `isZstdAvailable()` are now exported.
- File storage: a conditional write whose `link()` reports EEXIST for its own file
  (NFSv3 retransmits) counts as written; the no-hard-link lock (SMB, FAT) measures its
  age with the file server's clock; renames are retried for a moment on Windows when
  another program holds the file, and EPERM is no longer described as a read-only
  filesystem.
- The storage lock holds the lock when a retried create finds its own lock object.
- Windows device names (`con`, `nul`, `aux`, `com1`, …) are escaped in backup keys and
  in mongodump directory exports (docs/specs/FORMAT.md).
- S3: conditional writes are only trusted without a check on AWS and Cloudflare R2;
  other endpoints are probed once. A store without them makes the storage lock refuse
  clearly and the manifest write fall back to an unconditional put. New options
  `conditionalWrites` and `responseChecksumValidation`; with a custom `endpoint` both
  checksum settings default to `WHEN_REQUIRED`. `s3://` URLs accept
  `conditionalWrites`, `responseChecksumValidation`, `partSizeMiB` and `queueSize`,
  `gs://` URLs `chunkSizeMiB`, `az://` URLs `blockSizeMiB` and `uploadConcurrency`, to
  bound upload memory in small functions (docs/guides/aws-lambda.md).
- `copy` / `pull` write their checkpoint once before changing the target, and the CLI
  keeps the default checkpoint in the system temp directory when the working directory
  is not writable.
- TypeScript and JavaScript configs that import `mongoshield` resolve to the running
  package, so they load under `npx` and in the GitHub Action.
- `redactMongoUri` also hides `proxyPassword` and `sslPEMKeyPassword`.
- Notify and heartbeat URLs can come from `{ env: "NAME" }` or `{ file: "/path" }`
  references, and the heartbeat from `MONGOSHIELD_HEARTBEAT_URL`.
- Storage URLs refuse credentials inside `endpoint=` (an Azure SAS token, presigned S3
  parameters), and `az://` URLs using `DefaultAzureCredential` refuse an endpoint
  outside Azure Storage's domains unless `allowCustomEndpoint=true`.
