# Writing a storage adapter

MongoShield can back up to anything that stores files by name. A storage adapter is a
small object with seven methods; register it under a URL scheme and the CLI, config
files and the console accept URLs like `pcloud://backups/prod` everywhere a storage
location goes. A contract test kit, `mongoshield/testing/storage`, checks that your
adapter keeps every promise the backup engine relies on.

A complete, tested example lives in
[`examples/community-storage-adapter`](../../examples/community-storage-adapter/): a
`flatdir://` adapter that keeps every object as one file in one folder.

## 1. Implement `StorageAdapter`

The contract is [`src/storage/types.ts`](../../packages/mongoshield/src/storage/types.ts).
In short:

| Method | Must |
|:--|:--|
| `put(key, body, { ifNoneMatch, retainUntil, signal })` | write atomically (readers see the old object, the new one or nothing, never half); with `ifNoneMatch: "*"` fail with `MS_STORAGE_PRECONDITION_FAILED` when the key exists |
| `get(key, { range, signal })` | return a stream; `MS_STORAGE_NOT_FOUND` when missing; honour inclusive byte ranges if `capabilities.rangeReads` |
| `head(key)` | return `{ key, size, lastModified }` or `undefined` |
| `list(prefix)` | every object under `prefix`, recursively, in lexicographic (byte) order |
| `listPrefixes(prefix)` | the immediate "sub-directories", each ending in `/` |
| `delete(keys)` | remove them, ignoring missing ones |
| `space()` (optional) | report total, used, free and trash bytes, for the free-space check |
| `close()` (optional) | release connections; safe to call twice |

Plus `kind` (`"pcloud"`), `location` (shown in messages, with no secrets in it) and
`capabilities` (`conditionalWrites`, `rangeReads`, `objectLock`).

Rules that matter:

- Keys are relative POSIX paths. Check them with `assertValidKey` / `assertValidPrefix`
  (exported from `mongoshield`) before using them.
- Every error is a `MongoShieldError` with an `MS_STORAGE_*` code (`MS_CONFIG_INVALID`
  for bad options). An aborted `signal` must give `MS_ABORTED` (`throwIfAborted`).
- Adapters are stateless between runs: one instance may serve many concurrent and
  successive backups.
- Without write-once retention (`objectLock: false`), a put with `retainUntil` fails
  with `MS_CONFIG_INVALID` before reading the body.
- Never put tokens or passwords in `location` or in error messages.

### `space()`

Implement it when your backend can say cheaply how full it is (one request). Before each
backup MongoShield refuses when the previous full backup would not fit in what is free,
and warns past 80% full. Report what the backend says and leave the rest out:

```ts
async space() {
  const quota = await api.quota();
  return {
    totalBytes: quota.total,
    usedBytes: quota.used,      // everything counted against the quota, the trash included
    freeBytes: quota.remaining, // what can still be written; wins over total − used
    trashBytes: quota.trash,    // the part of usedBytes in the trash or recycle bin
  };
}
```

Return `undefined` when the backend has no fixed size; the check is then skipped.

## 2. Register a scheme

```ts
import { registerStorageScheme } from "mongoshield";

registerStorageScheme(
  "pcloud",
  ({ parsed, env }) =>
    pcloudStorage({
      folder: decodeURIComponent(parsed.host + parsed.pathname),
      token: env.PCLOUD_TOKEN,   // credentials from the environment, never from the URL
    }),
  { owner: "mongoshield-pcloud" },
);
```

- The factory gets `{ url, parsed, scheme, env }`. `env` is `process.env` unless the
  caller passed `resolveStorage(url, { env })`; read credentials from it.
- It may be `async`, for example to `import()` your SDK lazily.
- Registering a scheme that exists (a built-in one such as `s3`, or one another package
  registered) fails, so two packages cannot silently fight over a scheme. `owner` (your
  package name) lets your own module be evaluated twice: the CLI loads config files
  without a module cache. `{ replace: true }` replaces a scheme on purpose (tests).
- `registerStorageScheme` returns a function that undoes the registration.
- `registeredStorageSchemes()` and `isStorageSchemeRegistered()` list and check schemes.
  Registrations are shared between copies of MongoShield in one process, so a package
  that depends on its own copy still reaches the CLI's.

Users then import your package once, in the config file:

```ts
import "mongoshield-pcloud";
import { defineConfig } from "mongoshield";

export default defineConfig({ storage: "pcloud://backups/prod" });
```

## 3. Run the contract test kit

```ts
import { afterEach, beforeEach, describe, it } from "vitest";
import { describeStorageConformance } from "mongoshield/testing/storage";

describeStorageConformance(
  "pcloud",
  async () => {
    const storage = pcloudStorage({ folder: `test-${crypto.randomUUID()}` });
    return { storage, cleanup: () => deleteEverything(storage) };
  },
  { describe, it, beforeEach, afterEach },
);
```

The kit has no test framework of its own: it registers its tests with the functions you
pass and checks with `node:assert`. Vitest and Jest work as shown (Jest with its
globals); with `node:test`, pass `node:test`'s `describe`, `it`, `beforeEach` and
`afterEach`, and set the timeout with `--test-timeout` (one test streams 10 MiB and asks
Vitest and Jest for 60 s).

`setup` runs before every test and must return an empty store (use a unique prefix
per call on shared backends). Tests for a capability your adapter does not declare
(`conditionalWrites`, `rangeReads`, `objectLock`, `space()`) skip themselves. The fixture
can also say `objectLockConfigured: false` (an object-lock adapter on a bucket without
it) or `lockedDeletes: "hidden"` (a store that hides locked objects instead of refusing).

The kit covers round trips of buffers and streams, 10 MiB streaming, empty objects,
atomicity when the body fails midway, conditional creates (including eight racing
writers), ranges, listing order (with the tricky `-` and `.` before `/`), prefixes,
deletes, retention, key validation, cancellation, `space()` and reuse across runs.
