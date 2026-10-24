// Unit tests for the erasure ledger records (src/extras/erasure.ts) that need no
// database: what new records hold, and how records with or without a `matchVersion`
// are read. Applying erasures is tested against a real mongod in
// test/integration/extras/erasure.test.ts.

import { describe, expect, it } from "vitest";
import { isMongoShieldError } from "../errors.ts";
import { memoryStorage } from "../storage/memory.ts";
import { ERASURES_PREFIX, listErasures, recordErasure } from "./erasure.ts";
import { MATCH_VERSION } from "./erasure-match.ts";

const SECRET = "a-long-enough-erasure-secret";

/** A hashed record as it would be stored, with `matchVersion` set as given (or absent). */
function hashedRecord(id: string, matchVersion: unknown): Record<string, unknown> {
  const match: Record<string, unknown> = {
    kind: "hashed",
    keyed: false,
    fields: [{ path: "email", digest: "a".repeat(64) }],
  };
  if (matchVersion !== undefined) match.matchVersion = matchVersion;
  return {
    formatVersion: 1,
    id,
    recordedAt: "2026-10-01T03:00:00.000Z",
    namespace: "app.users",
    match,
    reason: "GDPR request #1",
    tool: "mongoshield@test",
  };
}

async function putRecord(
  storage: ReturnType<typeof memoryStorage>,
  record: Record<string, unknown>,
): Promise<void> {
  await storage.put(
    `${ERASURES_PREFIX}${String(record.id)}.json`,
    Buffer.from(JSON.stringify(record)),
  );
}

describe("erasure ledger records", () => {
  it("stores the match version on new hashed records", async () => {
    const storage = memoryStorage();
    const record = await recordErasure(storage, {
      namespace: "app.users",
      filter: { email: "ada@example.com" },
      reason: "GDPR request #1",
      secret: SECRET,
    });
    expect(record.match).toMatchObject({ kind: "hashed", matchVersion: MATCH_VERSION });
    const [read] = await listErasures(storage);
    expect(read?.match).toMatchObject({ kind: "hashed", matchVersion: MATCH_VERSION });
  });

  it("reads hashed records without a match version as the current version", async () => {
    const storage = memoryStorage();
    await putRecord(storage, hashedRecord("old", undefined));
    const [read] = await listErasures(storage);
    expect(read?.match).toMatchObject({ kind: "hashed", matchVersion: MATCH_VERSION });
  });

  it("refuses a record with a match version it does not know rather than misapply it", async () => {
    const storage = memoryStorage();
    await putRecord(storage, hashedRecord("future", MATCH_VERSION + 1));
    const error: unknown = await listErasures(storage).catch((caught: unknown) => caught);
    expect(isMongoShieldError(error) && error.code).toBe("MS_INTEGRITY_FAILED");
  });

  it("keeps plain filters free of a match version", async () => {
    const storage = memoryStorage();
    const record = await recordErasure(storage, {
      namespace: "app.users",
      filter: { userId: 1042 },
      reason: "GDPR request #2",
    });
    expect(record.match).toEqual({ kind: "filter", filter: { userId: { $numberInt: "1042" } } });
  });
});
