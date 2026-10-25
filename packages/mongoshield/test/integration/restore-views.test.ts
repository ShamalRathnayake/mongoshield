// Integration tests: restored views read from the restored (renamed) collections, not
// only through `viewOn` but also through `$lookup`, `$graphLookup` and `$unionWith`,
// at any depth of the pipeline ($facet, $lookup sub-pipelines). See restore-views.ts.

import type { Document } from "mongodb";
import { beforeAll, describe, expect, it } from "vitest";
import { runRestore } from "../../src/engine/restore.ts";
import { type Logger, silentLogger } from "../../src/logger.ts";
import { type MemoryStorage, memoryStorage } from "../../src/storage/memory.ts";
import { backupDatabaseForTest } from "../helpers/backup-fixtures.ts";
import { uniqueDb, useMongoClient } from "../helpers/mongo.ts";

const client = useMongoClient();
const source = uniqueDb("rvsrc");
let storage: MemoryStorage;

/** Test documents use numeric ids (the driver assumes ObjectId otherwise). */
interface NumberedDocument {
  _id: number;
  [field: string]: unknown;
}

/** A view reading `users` four ways, two of them nested. */
const ORDERS_WITH_USERS: Document[] = [
  { $lookup: { from: "users", localField: "user", foreignField: "_id", as: "direct" } },
  {
    $facet: {
      nested: [
        {
          $lookup: {
            from: "users",
            let: { user: "$user" },
            pipeline: [{ $match: { $expr: { $eq: ["$_id", "$$user"] } } }],
            as: "viaPipeline",
          },
        },
      ],
    },
  },
  { $unwind: "$nested" },
  { $replaceRoot: { newRoot: "$nested" } },
  { $project: { direct: "$direct.name", viaPipeline: "$viaPipeline.name" } },
  { $unionWith: { coll: "users", pipeline: [{ $project: { direct: "$name" } }] } },
  { $sort: { _id: 1 } },
];

beforeAll(async () => {
  const db = client().db(source);
  await db.collection<NumberedDocument>("users").insertMany([
    { _id: 1, name: "Ada", manager: null },
    { _id: 2, name: "Grace", manager: 1 },
  ]);
  await db.collection<NumberedDocument>("orders").insertMany([{ _id: 10, user: 2 }]);
  await db.createCollection("order_users", { viewOn: "orders", pipeline: ORDERS_WITH_USERS });
  await db.createCollection("chain", {
    viewOn: "users",
    pipeline: [
      {
        $graphLookup: {
          from: "users",
          startWith: "$manager",
          connectFromField: "manager",
          connectToField: "_id",
          as: "bosses",
        },
      },
      { $project: { bosses: "$bosses.name" } },
    ],
  });
  storage = memoryStorage();
  await backupDatabaseForTest(client(), storage, { include: [`${source}.*`] });
});

/** A logger that keeps warnings. */
function warningLogger(warnings: Document[]): Logger {
  return { ...silentLogger, warn: (message, fields) => warnings.push({ message, ...fields }) };
}

describe("restoring views under rename rules", () => {
  it("points $lookup, nested $lookup, $unionWith and $graphLookup at the renamed collection", async () => {
    const target = uniqueDb("rvdst");
    await runRestore(
      { client: client(), storage, logger: silentLogger },
      {
        backup: "latest",
        rename: { [`${source}.*`]: `${target}.*`, [`${source}.users`]: `${target}.people` },
      },
    );
    // Change the restored people so the view's output proves where it reads from.
    await client()
      .db(target)
      .collection<Document>("people")
      .updateMany({}, [{ $set: { name: { $concat: ["$name", "*"] } } }]);

    const rows = await client().db(target).collection("order_users").find().toArray();
    expect(rows).toEqual([
      { _id: 1, direct: "Ada*" },
      { _id: 2, direct: "Grace*" },
      { _id: 10, direct: ["Grace*"], viaPipeline: ["Grace*"] },
    ]);
    const chain = await client().db(target).collection("chain").find().sort({ _id: 1 }).toArray();
    expect(chain).toEqual([
      { _id: 1, bosses: [] },
      { _id: 2, bosses: ["Ada*"] },
    ]);
    const [info] = await client()
      .db(target)
      .listCollections({ name: "chain" }, { nameOnly: false })
      .toArray();
    expect(info?.options?.viewOn).toBe("people");
  });

  it("keeps a source name that was renamed into another database, with a warning", async () => {
    const target = uniqueDb("rvdst");
    const elsewhere = uniqueDb("rvoth");
    const warnings: Document[] = [];
    await runRestore(
      { client: client(), storage, logger: warningLogger(warnings) },
      {
        backup: "latest",
        rename: { [`${source}.*`]: `${target}.*`, [`${source}.users`]: `${elsewhere}.users` },
      },
    );
    const [info] = await client()
      .db(target)
      .listCollections({ name: "order_users" }, { nameOnly: false })
      .toArray();
    expect(info?.options?.pipeline).toEqual(ORDERS_WITH_USERS);
    const fields = warnings
      .filter((warning) => warning.view === `${target}.order_users`)
      .map((warning) => warning.field);
    expect(fields).toEqual(["$lookup.from", "$lookup.from", "$unionWith.coll"]);
    expect(warnings.find((warning) => warning.view === `${target}.chain`)).toMatchObject({
      field: "viewOn",
      sourceRestoredTo: `${elsewhere}.users`,
    });
  });
});
