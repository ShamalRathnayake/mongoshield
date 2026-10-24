# Resetting test databases between tests

Integration tests that share a database leak state into each other: one test
deletes a fixture, the next one fails. `mongoshield/testing` snapshots your test
databases once and puts them back before every test, using the same backup and
restore engines as production backups, tuned for speed (no compression, no
encryption, in memory, several collections at once).

```ts
import { useMongoSnapshot } from "mongoshield/testing";
```

It works with [mongodb-memory-server](https://github.com/typegoose/mongodb-memory-server)
(standalone or replica set) and with real servers, and does not depend on a
test framework.

## Vitest

```ts
// test/users.test.ts
import { MongoClient } from "mongodb";
import { MongoMemoryServer } from "mongodb-memory-server";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { useMongoSnapshot } from "mongoshield/testing";

let server: MongoMemoryServer;
let client: MongoClient;

beforeAll(async () => {
  server = await MongoMemoryServer.create();
  client = await MongoClient.connect(server.getUri());
  await seedFixtures(client.db("app_test")); // your baseline data
});

// `() => client`: the client only exists once beforeAll has run.
const db = useMongoSnapshot(() => client, { databases: ["app_test"] });

beforeEach(() => db.reset()); // 1st call: snapshot; later calls: restore it
afterAll(async () => {
  await db.dispose();
  await client.close();
  await server.stop();
});

it("deletes a user", async () => {
  await client.db("app_test").collection("users").deleteOne({ email: "ada@example.com" });
  expect(await client.db("app_test").collection("users").countDocuments()).toBe(2);
});

it("still sees every user", async () => {
  expect(await client.db("app_test").collection("users").countDocuments()).toBe(3);
});
```

Hooks run in the order they are registered, so register `beforeEach(() => db.reset())`
after the `beforeAll` that seeds the data: the first `reset()` then captures the
seeded state.

## Jest

The same code works in Jest; only the imports change (Jest's globals need none):

```ts
import { useMongoSnapshot } from "mongoshield/testing";

const db = useMongoSnapshot(() => client, { databases: ["app_test"] });

beforeAll(seedFixtures);
beforeEach(() => db.reset());
afterAll(() => db.dispose());
```

With `@shelf/jest-mongodb` or a global mongodb-memory-server, connect to
`process.env.MONGO_URL` as usual and pass that client.

## Managing the snapshot yourself

`createDatabaseSnapshot` takes the snapshot immediately and returns
`{ namespaces, restore(), dispose() }`:

```ts
import { createDatabaseSnapshot } from "mongoshield/testing";

const snapshot = await createDatabaseSnapshot(client, { databases: ["app_test"] });
// … tests change data …
await snapshot.restore(); // back to the captured state
await snapshot.dispose(); // free the memory
```

`useMongoSnapshot(...).snapshot()` does the same inside the helper, replacing the
baseline: call it at the end of a `beforeAll` to snapshot a state other than the
one the first test sees.

## Options

| Option | Meaning |
|---|---|
| `databases` | Whole databases to snapshot, e.g. `["app_test"]`. |
| `include` | Namespace patterns instead of (or as well as) databases: `["app_test.*", "shared.settings"]`. |
| `exclude` | Namespaces to leave alone: neither captured nor dropped on restore, e.g. `["app_test.migrations"]`. |
| `storage` | Where the snapshot is kept. Defaults to a private in-memory store; pass `fileStorage({ path })` for very large fixtures. |
| `parallelism` | Collections restored at the same time (default 8). |
| `logger` | A MongoShield `Logger`, to see what the engines do. |

## What a reset does

1. Drops every collection and view matching `databases`/`include` (minus `exclude`)
   that did not exist when the snapshot was taken (created by a test).
2. Compares each snapshotted namespace with how it looked right after the snapshot
   (or the previous reset): its options and indexes, and a hash of its documents
   from the server's `dbHash` command. Then, per namespace:
   - **nothing changed**: left alone (no work);
   - **only documents changed**: all documents deleted and the snapshotted ones
     inserted again;
   - **options or indexes changed, or the collection was dropped**: dropped and
     recreated with its options, documents and indexes by the restore engine.
     Capped collections whose documents changed are recreated too (documents
     cannot be deleted from them on every server version), and time series
     collections on every reset (the server cannot hash them).

So after `reset()` the selected databases are exactly as captured, including
indexes a test added or collections it dropped, and a test that touched one
collection only pays for that one. Namespaces outside the selection are never
touched. Snapshotting a database that does not exist yet is fine: its reset drops
whatever the tests created.

Without the `dbHash` privilege (it is part of `dbAdmin`, not `readWrite`), every
collection counts as changed and is reloaded: still exact, just slower.

## How fast is it?

Measured on a laptop (Apple Silicon, mongod 7.0, single-node replica set from
mongodb-memory-server) for 10 collections × 1,000 small documents with one
secondary index each, median of 5 runs (`test/integration/testing.test.ts`):

| | Time |
|---|---|
| snapshot (once) | ~55 ms |
| reset, nothing changed | ~9 ms |
| reset after a test changed one collection's documents | ~30 ms |
| reset after a test changed every collection's documents | ~85 ms |
| reset after a test added an index to every collection | ~520 ms |

Recreating a collection costs a drop, a create, the inserts and one index build
per index, done 8 collections at a time; reloading only costs a delete and the
inserts. Keep fixture databases small, and keep large reference data in a
database you do not reset.

## Things to know

- **It drops collections.** Point it at test databases only. It refuses MongoDB's
  own `admin`, `config` and `local` databases.
- **Parallel test files** must use different databases (e.g. one per Vitest worker:
  `` `app_test_${process.env.VITEST_POOL_ID}` ``), or resets of one file will wipe
  the data another file is using.
- **Connections stay open.** The helpers use the client you give them and never
  close it.
- **Users, roles and server settings** are not part of a snapshot; only
  collections, views, their options, indexes and documents are.
