/**
 * End-to-end backups to OneDrive, through the in-process fake of Microsoft Graph
 * (test/helpers/fake-onedrive-server.ts) and a real mongod: an encrypted backup that
 * includes a collection big enough for an upload session, a deep verify, a restore,
 * and the day-75 sign-in warning reaching `BackupResult.warnings` under a simulated
 * clock (and staying away when the rotated token is kept).
 */

import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { generateIdentity } from "../../src/crypto/index.ts";
import { MongoShield } from "../../src/shield.ts";
import { onedriveStorage } from "../../src/storage/onedrive.ts";
import { TEST_COMPRESSION } from "../helpers/compression.ts";
import {
  type FakeOneDriveServer,
  startFakeOneDriveServer,
} from "../helpers/fake-onedrive-server.ts";
import { uniqueDb, useMongoClient } from "../helpers/mongo.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
/**
 * Documents of 6 KiB of base64 random bytes, which zstd/gzip can only shrink by about
 * a quarter: 1,500 of them keep the stored file well above the 4 MiB upload limit.
 */
const BIG_DOCUMENTS = 1500;

const client = useMongoClient();

describe("backups to OneDrive (fake Graph)", () => {
  const sourceDb = uniqueDb("onedrive");
  const restoredDb = `${sourceDb}_restored`;
  let server: FakeOneDriveServer;
  let clock: Date;
  let directory: string;

  beforeAll(async () => {
    const big = Array.from({ length: BIG_DOCUMENTS }, (_, index) => ({
      _id: index,
      payload: randomBytes(4608).toString("base64"),
    }));
    await client().db(sourceDb).collection<{ _id: number; payload: string }>("big").insertMany(big);
    await client()
      .db(sourceDb)
      .collection("small")
      .insertMany([{ name: "a" }, { name: "b" }]);
  });

  afterAll(async () => {
    await client().db(sourceDb).dropDatabase();
    await client().db(restoredDb).dropDatabase();
  });

  beforeEach(async () => {
    clock = new Date("2026-11-05T03:00:00Z");
    server = await startFakeOneDriveServer({ now: () => clock });
    directory = await mkdtemp(join(tmpdir(), "onedrive-integration-"));
  });

  afterEach(async () => {
    await server.close();
    await rm(directory, { recursive: true, force: true });
  });

  function shieldFor(secret: string, statePath?: string) {
    const storage = onedriveStorage({
      folder: "mongoshield-backups",
      token: secret,
      graphUrl: server.graphUrl,
      authorityUrl: server.authorityUrl,
      now: () => clock,
      tempDirectory: directory,
      ...(statePath === undefined ? {} : { tokenStatePath: statePath }),
    });
    return {
      storage,
      shield: (recipient: string) =>
        new MongoShield({
          source: { client: client() },
          storage,
          compression: TEST_COMPRESSION,
          encryption: { recipients: [recipient] },
        }),
    };
  }

  it("backs up encrypted, verifies deeply and restores every document", async () => {
    const { identity, recipient } = generateIdentity();
    const { shield: makeShield } = shieldFor(server.secret());
    const shield = makeShield(recipient);

    const backup = await shield.backup({ include: [`${sourceDb}.*`] });
    expect(backup.manifest.totals.documents).toBe(BIG_DOCUMENTS + 2);
    expect(backup.warnings ?? []).toEqual([]);
    // The big collection went up through an upload session, the rest in single PUTs.
    expect(server.stats.sessionsCreated).toBeGreaterThan(0);
    expect(server.stats.simplePuts).toBeGreaterThan(0);

    const deep = await shield.verify({
      backup: backup.id,
      mode: "deep",
      decryption: { identities: [identity] },
    });
    expect(deep.ok).toBe(true);

    const result = await shield.restore({
      backup: backup.id,
      rename: { [`${sourceDb}.*`]: `${restoredDb}.*` },
      decryption: { identities: [identity] },
    });
    expect(result.documentsRestored).toBe(BIG_DOCUMENTS + 2);
    expect(await client().db(restoredDb).collection("big").countDocuments()).toBe(BIG_DOCUMENTS);
  });

  it("reports the day-75 sign-in warning in the backup result when rotation is not kept", async () => {
    const { recipient } = generateIdentity();
    const secret = server.secret();
    clock = new Date(clock.getTime() + 76 * DAY_MS);
    const backup = await shieldFor(secret)
      .shield(recipient)
      .backup({ include: [`${sourceDb}.small`] });
    expect(backup.warnings).toHaveLength(1);
    expect(backup.warnings?.[0]).toMatch(/OneDrive sign-in .* is 76 days old/);
  });

  it("keeps backing up past day 90 without warnings when the rotated token is kept", async () => {
    const { recipient } = generateIdentity();
    const secret = server.secret();
    const statePath = join(directory, "token-state.json");
    for (const day of [0, 60, 120]) {
      clock = new Date(new Date("2026-11-05T03:00:00Z").getTime() + day * DAY_MS);
      const backup = await shieldFor(secret, statePath)
        .shield(recipient)
        .backup({ include: [`${sourceDb}.small`] });
      expect(backup.warnings ?? [], `day ${day}`).toEqual([]);
    }
  });
});
