# Chapter 4: The Public Wrapper (`mongoshield`)

While `@mongoshield/core` does all the heavy lifting, it is not designed to be consumed directly by end-users. The `mongoshield` package provides a unified, user-friendly **Facade** pattern over the complex internal engine. 

## 4.1 The Entry Point: `MongoShield.ts`

[`MongoShield.ts`](../../../packages/mongoshield/src/MongoShield.ts) is the class that developers instantiate in their own Node.js scripts.

### Runtime Schema Validation (Zod)
```typescript
let parsedConfig: BackupConfig;
try {
  parsedConfig = BackupConfigSchema.parse(options.config);
} catch (err: any) {
  logger.error({ err }, "Invalid MongoShield configuration");
  throw new Error(`MongoShield Configuration Error: ${err.message}`);
}
this.engine = new BackupEngine(parsedConfig, options.storage);
```
**Logic Decision:**
TypeScript interfaces (`BackupConfigInput`) are entirely erased when code is compiled to JavaScript. If a user installs MongoShield via NPM and passes `{ numParallelCollections: "five" }` (a string instead of a number) in pure JS, TypeScript cannot warn them. By passing the raw input through `Zod` (`BackupConfigSchema.parse`), we perform **Runtime Type Checking**. Zod guarantees that by the time the config reaches the `BackupEngine`, it is perfectly formatted, sanitized, and safe to execute. This fails fast and provides human-readable error messages for bad inputs.

### Event Bubbling & The EventEmitter Pattern
```typescript
export class MongoShield extends EventEmitter {
  // ...
  options.storage.on("progress", (bytesWritten: number) => {
    this.emit("progress", bytesWritten);
  });
}
```
**Logic Decision:**
Remember how the `AbstractStorageProvider` wrapped streams in a `PassThrough` to emit `"progress"` events? The end-user doesn't interact with the StorageProvider directly once they pass it to `MongoShield`. Therefore, the `MongoShield` wrapper must act as an **Event Proxy**. It listens to the internal storage provider's events and re-emits them to the public API surface. This allows developers to easily attach UI progress bars or Datadog metrics to their backup scripts:

```javascript
const shield = new MongoShield({ ... });
shield.on("progress", (bytes) => console.log(`Uploaded ${bytes} bytes`));
await shield.backup();
```

---

# Conclusion

You have now traversed the entire architecture of MongoShield. You understand:
1. Why **PNPM Workspaces** and strict CI/CD pipelines guarantee repository integrity.
2. How **Streams** allow for constant memory ($O(1)$) backups regardless of database size.
3. The cryptographic superiority of deriving temporary Stream Keys using **HKDF** and **AES-256-GCM**.
4. How atomic **file renaming** and `statfs` checks prevent corrupted backups.
5. Why **Zod** is used at the API boundary to enforce runtime safety.

This codebase is a masterclass in defensive, modern Node.js engineering. Use these patterns—streaming telemetry, atomic operations, stream multiplexing, and robust path sanitization—in your own systems to build unbreakable, production-grade applications.
