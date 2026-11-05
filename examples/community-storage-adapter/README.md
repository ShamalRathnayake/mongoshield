# Example community storage adapter: `flatdir://`

A complete third-party storage adapter for MongoShield, written the way a community
package would be: it imports only the public `mongoshield` API, registers its own URL
scheme, and passes the contract test kit (`mongoshield/testing/storage`).

`flatdir:///srv/backups` keeps every object as one file in one folder, with the key
percent-encoded into the file name (`backups%2F2026-…%2Fmanifest%2Ejson`). It is a
teaching example, not a better file adapter: use `./backups` for real local backups.

| File | What it shows |
|:--|:--|
| [`index.mjs`](./index.mjs) | `StorageAdapter` (atomic writes, conditional creates, ordered listings, `space()`), MongoShieldError codes, and `registerStorageScheme` with an `owner` |
| [`test/conformance.test.mjs`](./test/conformance.test.mjs) | the contract test kit with Vitest, and resolving a `flatdir://` URL |

Use it in a config file:

```ts
import "mongoshield-flat-folder";
import { defineConfig } from "mongoshield";

export default defineConfig({ storage: "flatdir:///srv/backups" });
```

Run the tests here with `npm install && npm test`. In the MongoShield repository they
run with the `mongoshield` package's unit tests, against its source.

The guide: [docs/guides/community-storage-adapters.md](../../docs/guides/community-storage-adapters.md).
