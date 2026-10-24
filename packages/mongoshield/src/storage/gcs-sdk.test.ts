/**
 * Runs the storage conformance suite through the real `@google-cloud/storage`
 * SDK against an in-process fake of the GCS JSON API
 * (`test/helpers/fake-gcs-server.ts`). This exercises what the mocked unit
 * tests cannot: resumable sessions, multipart uploads, checksum validation,
 * eager error detection on downloads and the SDK's error shapes.
 */

import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type FakeGcsServer, startFakeGcsServer } from "../../test/helpers/fake-gcs-server.ts";
import { describeStorageConformance } from "../../test/helpers/storage-conformance.ts";
import { isMongoShieldError } from "../errors.ts";
import { gcsStorage } from "./gcs.ts";

const BUCKET = "conformance";
let server: FakeGcsServer;

beforeAll(async () => {
  server = await startFakeGcsServer([BUCKET]);
});

afterAll(async () => {
  await server.close();
});

describeStorageConformance("gcs (real SDK, in-process fake API)", async () => ({
  // 256 KiB chunks (the minimum) so the >10 MiB test exercises multi-chunk resumable uploads.
  storage: gcsStorage({
    bucket: BUCKET,
    prefix: `run-${randomUUID()}`,
    storage: server.client(),
    chunkSize: 256 * 1024,
  }),
  cleanup: async () => {},
  // The fake's buckets have no object retention: retained puts must fail with MS_CONFIG_INVALID.
  objectLockConfigured: false,
}));

describe("gcsStorage with the real SDK", () => {
  it("streams in a single request when chunkSize is 0", async () => {
    const storage = gcsStorage({
      bucket: BUCKET,
      prefix: randomUUID(),
      storage: server.client(),
      chunkSize: 0,
    });
    const info = await storage.put("a.bin", Readable.from([Buffer.alloc(300_000, 1)]));
    expect(info.size).toBe(300_000);
    expect((await storage.head("a.bin"))?.size).toBe(300_000);
  });

  it("reports a missing bucket as MS_STORAGE_NOT_FOUND from every operation", async () => {
    const storage = gcsStorage({ bucket: "no-such-bucket", storage: server.client() });
    for (const attempt of [
      storage.head("a"),
      storage.get("a"),
      storage.put("a", Buffer.from("x")),
    ]) {
      const error = await attempt.catch((reason: unknown) => reason);
      expect(isMongoShieldError(error, "MS_STORAGE_NOT_FOUND"), String(error)).toBe(true);
      expect(isMongoShieldError(error) && error.hint).toContain("no-such-bucket");
    }
  });
});
