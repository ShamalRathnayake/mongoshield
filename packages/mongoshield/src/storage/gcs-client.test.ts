/**
 * How `gcsStorage` builds its `Storage` client from the connection options.
 * The SDK is replaced by a recording stub (in this file's own module
 * registry), so no network or credentials are involved.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const constructed: unknown[] = [];
const bucketNames: string[] = [];

vi.mock("@google-cloud/storage", () => ({
  Storage: class {
    constructor(options: unknown) {
      constructed.push(options);
    }
    bucket(name: string) {
      bucketNames.push(name);
      return {
        file: () => ({
          getMetadata: async () => [{ size: "1", updated: "2026-01-01T00:00:00Z" }],
        }),
      };
    }
  },
}));

const { gcsStorage } = await import("./gcs.ts");

describe("gcsStorage client construction", () => {
  beforeEach(() => {
    constructed.length = 0;
    bucketNames.length = 0;
  });

  it("uses Application Default Credentials when no options are given", async () => {
    await gcsStorage({ bucket: "bkt" }).head("a");
    expect(constructed).toEqual([{}]);
    expect(bucketNames).toEqual(["bkt"]);
  });

  it("passes projectId, keyFilename, credentials and apiEndpoint to the SDK", async () => {
    const credentials = { client_email: "svc@example.iam.gserviceaccount.com", private_key: "k" };
    await gcsStorage({
      bucket: "bkt",
      projectId: "proj",
      keyFilename: "/secrets/key.json",
      credentials,
      apiEndpoint: "http://localhost:4443",
    }).head("a");
    expect(constructed).toEqual([
      {
        projectId: "proj",
        keyFilename: "/secrets/key.json",
        credentials,
        apiEndpoint: "http://localhost:4443",
      },
    ]);
  });

  it("creates the client once, and again after close()", async () => {
    const storage = gcsStorage({ bucket: "bkt" });
    await storage.head("a");
    await storage.head("b");
    expect(constructed).toHaveLength(1);
    await storage.close?.();
    await storage.head("c");
    expect(constructed).toHaveLength(2);
  });
});
