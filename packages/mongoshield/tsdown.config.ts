import { defineConfig } from "tsdown";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    cli: "src/cli/index.ts",
    "storage/file": "src/storage/file.ts",
    "storage/memory": "src/storage/memory.ts",
    "storage/s3": "src/storage/s3.ts",
    "storage/gcs": "src/storage/gcs.ts",
    "storage/azure": "src/storage/azure.ts",
    "storage/sftp": "src/storage/sftp.ts",
    "storage/gdrive": "src/storage/gdrive.ts",
    "storage/dropbox": "src/storage/dropbox.ts",
    kms: "src/crypto/kms/index.ts",
    testing: "src/testing/index.ts",
    // The storage adapter contract test kit, for community adapters.
    "testing/storage": "src/testing/storage-conformance.ts",
  },
  format: "esm",
  platform: "node",
  target: "node22.12",
  fixedExtension: true,
  dts: true,
  sourcemap: true,
  clean: true,
  // Peer and optional peer dependencies must never be bundled: users install the
  // SDKs they need, and MongoShield loads them lazily.
  external: [
    "mongodb",
    /^@aws-sdk\//,
    /^@google-cloud\//,
    /^@azure\//,
    "ssh2",
    /^@opentelemetry\//,
    // Ephemeral servers for upgrade rehearsals (src/engine/upgrade-target.ts).
    "mongodb-memory-server",
  ],
});
