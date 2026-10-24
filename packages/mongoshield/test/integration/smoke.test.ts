import { describe, expect, it } from "vitest";
import { uniqueDb, useMongoClient } from "../helpers/mongo.ts";

// Proves the integration harness works: a real mongod replica set is reachable.
const client = useMongoClient();

describe("integration harness", () => {
  it("connects to the shared replica set", async () => {
    const db = client().db(uniqueDb());
    await db.collection("ping").insertOne({ ok: true });
    const hello = await db.admin().command({ hello: 1 });
    expect(hello.setName).toBeTypeOf("string");
    await db.dropDatabase();
  });
});
