/**
 * Tests for the OneDrive adapter against the in-process fake of Microsoft Graph
 * (test/helpers/fake-onedrive-server.ts): the storage conformance suite, then the
 * OneDrive-specific behaviour (upload sizes and fragments, temp files, conflict
 * behaviour, retries, recycle bin, quota, options and URL parsing).
 */

import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type FakeOneDriveServer,
  startFakeOneDriveServer,
} from "../../test/helpers/fake-onedrive-server.ts";
import { describeStorageConformance } from "../../test/helpers/storage-conformance.ts";
import { isMongoShieldError, type MongoShieldError } from "../errors.ts";
import {
  FRAGMENT_GRANULARITY,
  type OneDriveStorage,
  type OneDriveStorageOptions,
  onedriveStorage,
  onedriveStorageFromUrl,
  SIMPLE_UPLOAD_LIMIT,
} from "./onedrive.ts";
import { encodeOneDriveSecret } from "./onedrive-auth.ts";

const MIB = 1024 * 1024;

/** An adapter on `server` with test-friendly defaults. */
function adapterFor(
  server: FakeOneDriveServer,
  overrides: Partial<OneDriveStorageOptions> = {},
): OneDriveStorage {
  return onedriveStorage({
    folder: "mongoshield-backups",
    token: server.secret(),
    graphUrl: server.graphUrl,
    authorityUrl: server.authorityUrl,
    ...overrides,
  });
}

/** Reads a whole object. */
async function read(
  storage: OneDriveStorage,
  key: string,
  range?: { start: number; end?: number },
) {
  const chunks: Buffer[] = [];
  for await (const chunk of await storage.get(key, range ? { range } : {}))
    chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const items: T[] = [];
  for await (const item of iterable) items.push(item);
  return items;
}

/** The MongoShieldError a promise rejects with. */
async function rejection(promise: Promise<unknown>): Promise<MongoShieldError> {
  const error = await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  if (!isMongoShieldError(error))
    throw new Error(`expected a MongoShieldError, got ${String(error)}`);
  return error;
}

/**
 * Compares buffers with `Buffer.equals`: vitest's deep equality walks every byte with
 * its diff machinery and takes seconds on a few MiB.
 */
function expectSameBytes(actual: Buffer | undefined, expected: Buffer): void {
  expect(actual?.length).toBe(expected.length);
  expect(actual?.equals(expected)).toBe(true);
}

/** Deterministic bytes, so read-backs can be compared. */
function pattern(size: number, seed = 7): Buffer {
  const data = Buffer.alloc(size);
  for (let index = 0; index < size; index++) data[index] = (index * 31 + seed) & 0xff;
  return data;
}

/** A stream of `data` in 64 KiB chunks, of unknown size to the adapter. */
function streamOf(data: Buffer): Readable {
  const chunks: Buffer[] = [];
  for (let offset = 0; offset < data.length; offset += 64 * 1024) {
    chunks.push(data.subarray(offset, offset + 64 * 1024));
  }
  return Readable.from(chunks);
}

describeStorageConformance("onedrive (fake Graph)", async () => {
  // Small pages and fragments, so paging and multi-fragment sessions are exercised.
  const server = await startFakeOneDriveServer({ pageSize: 3 });
  return {
    storage: adapterFor(server, { fragmentSize: 4 * FRAGMENT_GRANULARITY }),
    cleanup: () => server.close(),
  };
});

describe("onedriveStorage", () => {
  let server: FakeOneDriveServer;
  let tempDirectory: string;

  beforeEach(async () => {
    server = await startFakeOneDriveServer();
    tempDirectory = await mkdtemp(join(tmpdir(), "onedrive-test-"));
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await server.close();
    await rm(tempDirectory, { recursive: true, force: true });
  });

  describe("uploads", () => {
    it("sends objects under 4 MiB in one PUT, from a buffer and from a stream", async () => {
      const storage = adapterFor(server, { tempDirectory });
      await storage.put("small/buffer.bin", pattern(SIMPLE_UPLOAD_LIMIT - 1));
      await storage.put("small/stream.bin", streamOf(pattern(SIMPLE_UPLOAD_LIMIT - 1, 3)));
      expect(server.stats.simplePuts).toBe(2);
      expect(server.stats.sessionsCreated).toBe(0);
      expectSameBytes(
        server.read("mongoshield-backups/small/stream.bin"),
        pattern(SIMPLE_UPLOAD_LIMIT - 1, 3),
      );
    });

    it("sends 4 MiB or more through an upload session in 320 KiB-multiple fragments", async () => {
      const fragmentSize = 2 * FRAGMENT_GRANULARITY;
      const storage = adapterFor(server, { fragmentSize, tempDirectory });
      const data = pattern(SIMPLE_UPLOAD_LIMIT + 12345);
      const info = await storage.put("large/buffer.bin", data);

      expect(info.size).toBe(data.length);
      expect(server.stats.simplePuts).toBe(0);
      expect(server.stats.sessionsCreated).toBe(1);
      const fragments = server.stats.fragments;
      expect(fragments.slice(0, -1).every((length) => length === fragmentSize)).toBe(true);
      expect(fragments.reduce((sum, length) => sum + length, 0)).toBe(data.length);
      expectSameBytes(server.read("mongoshield-backups/large/buffer.bin"), data);
    });

    it("defaults to 10 MiB fragments", async () => {
      const storage = adapterFor(server, { tempDirectory });
      await storage.put("large/default.bin", pattern(10 * MIB + 1));
      expect(server.stats.fragments).toEqual([10 * MIB, 1]);
    });

    it("stages a stream of 4 MiB or more in a temp file, and removes it afterwards", async () => {
      const seen: string[][] = [];
      const spyingFetch: typeof fetch = async (input, init) => {
        // While a fragment is sent, the staged file must be on disk.
        if (String(input).includes("/upload/") && init?.method === "PUT") {
          const folders = await readdir(tempDirectory);
          const files = await Promise.all(
            folders.map((folder) => readdir(join(tempDirectory, folder))),
          );
          seen.push(
            folders.flatMap((folder, index) =>
              (files[index] ?? []).map((file) => `${folder}/${file}`),
            ),
          );
        }
        return fetch(input, init);
      };
      const storage = adapterFor(server, { tempDirectory, fetch: spyingFetch });
      const data = pattern(6 * MIB);
      await storage.put("large/stream.bin", streamOf(data));

      expect(seen.length).toBeGreaterThan(0);
      expect(seen[0]?.[0]).toMatch(/^mongoshield-onedrive-.+\/upload\.bin$/);
      expect(await readdir(tempDirectory)).toEqual([]);
      expectSameBytes(server.read("mongoshield-backups/large/stream.bin"), data);
    });

    it("removes the temp file and cancels the session when an upload fails", async () => {
      const controller = new AbortController();
      let fragments = 0;
      const abortingFetch: typeof fetch = async (input, init) => {
        const response = await fetch(input, init);
        if (String(input).includes("/upload/") && init?.method === "PUT" && ++fragments === 2) {
          controller.abort();
        }
        return response;
      };
      const storage = adapterFor(server, {
        tempDirectory,
        fetch: abortingFetch,
        fragmentSize: FRAGMENT_GRANULARITY,
      });
      const error = await rejection(
        storage.put("large/aborted.bin", streamOf(pattern(5 * MIB)), { signal: controller.signal }),
      );

      expect(error.code).toBe("MS_ABORTED");
      expect(await readdir(tempDirectory)).toEqual([]);
      expect(server.stats.sessionsCancelled).toBe(1);
      expect(server.openSessions()).toBe(0);
      expect(server.files()).toEqual([]);
    });

    it("never sends the bearer token to upload or download URLs", async () => {
      const storage = adapterFor(server, { tempDirectory, fragmentSize: FRAGMENT_GRANULARITY });
      await storage.put("large/x.bin", pattern(5 * MIB));
      await read(storage, "large/x.bin");
      await read(storage, "large/x.bin", { start: 10, end: 20 });
      expect(server.stats.bearerOnPreauthenticatedUrls).toBe(0);
    });

    it("refuses a large conditional create when the name exists, keeping the original", async () => {
      const storage = adapterFor(server, { tempDirectory });
      await storage.put("locks/big.lock", pattern(5 * MIB, 1), { ifNoneMatch: "*" });
      const error = await rejection(
        storage.put("locks/big.lock", streamOf(pattern(5 * MIB, 2)), { ifNoneMatch: "*" }),
      );
      expect(error.code).toBe("MS_STORAGE_PRECONDITION_FAILED");
      expectSameBytes(server.read("mongoshield-backups/locks/big.lock"), pattern(5 * MIB, 1));
      expect(await readdir(tempDirectory)).toEqual([]);
    });

    it("asks for conflictBehavior fail only for ifNoneMatch, and replace otherwise", async () => {
      const urls: string[] = [];
      const recordingFetch: typeof fetch = (input, init) => {
        urls.push(String(input));
        return fetch(input, init);
      };
      const storage = adapterFor(server, { fetch: recordingFetch });
      await storage.put("a.txt", Buffer.from("1"), { ifNoneMatch: "*" });
      await storage.put("a.txt", Buffer.from("2"));
      const puts = urls.filter((url) => url.includes(":/content"));
      expect(puts[0]).toMatch(/conflictBehavior=fail$/);
      expect(puts[1]).toMatch(/conflictBehavior=replace$/);
    });

    it("resumes from the server's position when a fragment's answer is lost", async () => {
      const storage = adapterFor(server, { tempDirectory, fragmentSize: FRAGMENT_GRANULARITY });
      server.loseFragmentAnswers = 1;
      const data = pattern(5 * MIB, 9);
      await storage.put("large/resumed.bin", data);
      expectSameBytes(server.read("mongoshield-backups/large/resumed.bin"), data);
    });

    it("refuses an upload session up front when the drive is too full", async () => {
      server.quotaTotal = 5 * MIB;
      const storage = adapterFor(server, { tempDirectory });
      const error = await rejection(storage.put("large/too-big.bin", streamOf(pattern(6 * MIB))));
      expect(error.code).toBe("MS_STORAGE_INSUFFICIENT_SPACE");
      expect(error.hint).toMatch(/recycle bin/);
      expect(await readdir(tempDirectory)).toEqual([]);
    });

    it("maps quotaLimitReached on a small upload to MS_STORAGE_INSUFFICIENT_SPACE", async () => {
      server.quotaTotal = 10;
      const error = await rejection(adapterFor(server).put("x.bin", Buffer.alloc(100)));
      expect(error.code).toBe("MS_STORAGE_INSUFFICIENT_SPACE");
      expect(error.details).toMatchObject({ httpStatus: 507, graphCode: "quotaLimitReached" });
    });

    it("writes under the app folder by path", async () => {
      await adapterFor(server, { folder: "prod/app" }).put(
        "backups/b1/manifest.json",
        Buffer.from("{}"),
      );
      expect(server.files()).toEqual(["prod/app/backups/b1/manifest.json"]);
      expect(server.stats.graphRequests).toContain(
        "PUT /v1.0/me/drive/special/approot:/prod/app/backups/b1/manifest.json:/content",
      );
    });
  });

  describe("retries and errors", () => {
    it.each([429, 503] as const)(
      "retries %i answers with the Retry-After Graph sends",
      async (status) => {
        const storage = adapterFor(server);
        await storage.put("first.txt", Buffer.from("x"));
        server.throttle(3, status, "0");
        await storage.put("retried.txt", Buffer.from("y"));
        expect(server.stats.throttled).toBe(3);
        expect(server.read("mongoshield-backups/retried.txt")?.toString()).toBe("y");
      },
    );

    it("waits as long as Retry-After asks", async () => {
      const storage = adapterFor(server);
      await storage.head("warm-up");
      server.throttle(1, 429, "1");
      const started = Date.now();
      await storage.head("anything");
      expect(Date.now() - started).toBeGreaterThanOrEqual(950);
    });

    it("gives up with MS_STORAGE_IO and a throttling hint when throttling does not stop", async () => {
      const storage = adapterFor(server);
      await storage.head("warm-up");
      server.throttle(100, 429, "0");
      const error = await rejection(storage.head("anything"));
      expect(error.code).toBe("MS_STORAGE_IO");
      expect(error.hint).toMatch(/throttling/);
    });

    it("refreshes the access token once when Graph answers 401", async () => {
      let spoiled = false;
      const spoilingFetch: typeof fetch = (input, init) => {
        const headers = new Headers(init?.headers);
        if (!spoiled && headers.has("authorization")) {
          spoiled = true;
          headers.set("authorization", "Bearer not-a-token");
          return fetch(input, { ...init, headers });
        }
        return fetch(input, init);
      };
      const storage = adapterFor(server, { fetch: spoilingFetch });
      await storage.put("after-401.txt", Buffer.from("ok"));
      expect(server.stats.refreshes).toBe(2);
    });

    it("maps accessDenied to MS_STORAGE_FORBIDDEN with a sign-in hint", async () => {
      const denyingFetch: typeof fetch = async (input, init) => {
        if (String(input).includes("approot")) {
          return new Response(
            JSON.stringify({ error: { code: "accessDenied", message: "Nope." } }),
            {
              status: 403,
            },
          );
        }
        return fetch(input, init);
      };
      const error = await rejection(adapterFor(server, { fetch: denyingFetch }).head("x"));
      expect(error.code).toBe("MS_STORAGE_FORBIDDEN");
      expect(error.hint).toMatch(/login onedrive/);
    });

    it("never puts the refresh or access token in an error message", async () => {
      const secret = server.secret();
      server.revokeAllRefreshTokens();
      const error = await rejection(adapterFor(server, { token: secret }).head("x"));
      expect(error.code).toBe("MS_STORAGE_FORBIDDEN");
      expect(
        JSON.stringify({ message: error.message, hint: error.hint, details: error.details }),
      ).not.toMatch(/rt-[0-9a-f]{10}|onedrive1\./);
    });
  });

  describe("reads and listings", () => {
    it("reads a range through the download URL with a Range header", async () => {
      const ranges: string[] = [];
      const recordingFetch: typeof fetch = (input, init) => {
        const range = new Headers(init?.headers).get("range");
        if (range !== null)
          ranges.push(`${new URL(String(input)).pathname.split("/")[1]} ${range}`);
        return fetch(input, init);
      };
      const storage = adapterFor(server, { fetch: recordingFetch });
      await storage.put("r.bin", pattern(1000));
      expect(await read(storage, "r.bin", { start: 100, end: 199 })).toEqual(
        pattern(1000).subarray(100, 200),
      );
      expect(await read(storage, "r.bin", { start: 990 })).toEqual(pattern(1000).subarray(990));
      expect(ranges).toEqual(["download bytes=100-199", "download bytes=990-999"]);
    });

    it("returns an empty stream for a range past the end", async () => {
      const storage = adapterFor(server);
      await storage.put("r.bin", pattern(10));
      expect(await read(storage, "r.bin", { start: 10 })).toEqual(Buffer.alloc(0));
    });

    it("fails with MS_INTEGRITY_FAILED when a download ends early", async () => {
      const truncatingFetch: typeof fetch = async (input, init) => {
        const response = await fetch(input, init);
        if (!String(input).includes("/download/")) return response;
        const bytes = Buffer.from(await response.arrayBuffer());
        return new Response(bytes.subarray(0, bytes.length - 5), { status: 200 });
      };
      const storage = adapterFor(server, { fetch: truncatingFetch });
      await storage.put("cut.bin", pattern(100));
      await expect(read(storage, "cut.bin")).rejects.toMatchObject({ code: "MS_INTEGRITY_FAILED" });
    });

    it("pages through children with @odata.nextLink", async () => {
      server.pageSize = 2;
      const storage = adapterFor(server);
      const keys = ["p/1", "p/2", "p/3", "p/4", "p/5", "p/sub/6", "p/sub/7"];
      for (const key of keys) await storage.put(key, Buffer.from(key));
      expect((await collect(storage.list("p/"))).map((info) => info.key)).toEqual(keys);
      expect(await collect(storage.listPrefixes("p/"))).toEqual(["p/sub/"]);
    });

    it("lists nothing when the folder does not exist yet", async () => {
      expect(await collect(adapterFor(server).list(""))).toEqual([]);
    });
  });

  describe("deletes", () => {
    it("sends deleted files to the recycle bin, which space() counts as trash", async () => {
      const storage = adapterFor(server);
      await storage.put("backups/b1/data.bin", Buffer.alloc(1000));
      await storage.delete(["backups/b1/data.bin"]);
      expect(server.recycleBin()).toContainEqual({
        path: "mongoshield-backups/backups/b1/data.bin",
        size: 1000,
      });
      const space = await storage.space();
      expect(space?.trash).toBe(1000);
    });

    it("ignores a key that names a folder instead of deleting the folder", async () => {
      const storage = adapterFor(server);
      await storage.put("backups/b1/data.bin", Buffer.from("x"));
      await storage.delete(["backups", "backups/b1"]);
      expect(server.files()).toEqual(["mongoshield-backups/backups/b1/data.bin"]);
    });

    it("removes folders left empty below the first level, and keeps first-level ones", async () => {
      const storage = adapterFor(server);
      await storage.put("backups/b1/app/users.bson", Buffer.from("x"));
      await storage.put("backups/b1/manifest.json", Buffer.from("x"));
      await storage.put("backups/b2/manifest.json", Buffer.from("x"));
      await storage.delete(["backups/b1/app/users.bson", "backups/b1/manifest.json"]);
      expect(server.folders()).toEqual([
        "mongoshield-backups",
        "mongoshield-backups/backups",
        "mongoshield-backups/backups/b2",
      ]);
      await storage.delete(["backups/b2/manifest.json"]);
      expect(server.folders()).toEqual(["mongoshield-backups", "mongoshield-backups/backups"]);
      expect(await collect(storage.listPrefixes(""))).toEqual([]);
    });
  });

  describe("space", () => {
    it("reports total, used, free and trash from the drive quota", async () => {
      server.quotaTotal = 10_000;
      const storage = adapterFor(server);
      await storage.put("a.bin", Buffer.alloc(1000));
      await storage.put("b.bin", Buffer.alloc(500));
      await storage.delete(["b.bin"]);
      expect(await storage.space()).toEqual({ total: 10_000, used: 1500, free: 8500, trash: 500 });
    });

    it("returns undefined when Graph does not report the quota to this app", async () => {
      server.driveForbidden = true;
      expect(await adapterFor(server).space()).toBeUndefined();
    });

    it("rejects with MS_ABORTED when the signal is already aborted", async () => {
      const error = await rejection(adapterFor(server).space({ signal: AbortSignal.abort() }));
      expect(error.code).toBe("MS_ABORTED");
    });
  });

  describe("options", () => {
    it("requires a folder", () => {
      expect(() => adapterFor(server, { folder: "" })).toThrow(/folder is required/);
      expect(() => adapterFor(server, { folder: "../x" })).toThrow(/Invalid OneDrive folder/);
    });

    it.each([0, 1000, FRAGMENT_GRANULARITY + 1, 61 * MIB, 1.5])(
      "rejects fragmentSize %d",
      (fragmentSize) => {
        expect(() => adapterFor(server, { fragmentSize })).toThrow(/multiple of 320 KiB/);
      },
    );

    it("needs the business opt-in for a work or school sign-in", () => {
      const token = server.secret({ tenant: "common" });
      expect(() => adapterFor(server, { token })).toThrow(/work or school/);
      expect(() => adapterFor(server, { token, business: true })).not.toThrow();
    });

    it("refreshes through /consumers by default and /common with business: true", async () => {
      const tokenUrls: string[] = [];
      const recordingFetch: typeof fetch = (input, init) => {
        if (String(input).endsWith("/token")) tokenUrls.push(new URL(String(input)).pathname);
        return fetch(input, init);
      };
      await adapterFor(server, { fetch: recordingFetch }).head("x");
      await adapterFor(server, {
        fetch: recordingFetch,
        business: true,
        token: server.secret({ tenant: "common" }),
      }).head("x");
      expect(tokenUrls).toEqual(["/consumers/oauth2/v2.0/token", "/common/oauth2/v2.0/token"]);
    });

    it("uses clientId over the one in the token, and sends clientSecret when given", async () => {
      const forms: URLSearchParams[] = [];
      const recordingFetch: typeof fetch = (input, init) => {
        if (String(input).endsWith("/token")) forms.push(new URLSearchParams(String(init?.body)));
        return fetch(input, init);
      };
      const storage = adapterFor(server, {
        fetch: recordingFetch,
        clientId: "other-client",
        clientSecret: "s3cret-value",
      });
      // The fake only knows "test-client", so the other id is refused, as Microsoft would.
      const error = await rejection(storage.head("x"));
      expect(error.code).toBe("MS_STORAGE_FORBIDDEN");
      expect(forms[0]?.get("client_id")).toBe("other-client");
      expect(forms[0]?.get("client_secret")).toBe("s3cret-value");
      expect(error.message).not.toContain("s3cret-value");
    });

    it("refuses a bare token when no client id is known", () => {
      expect(() => adapterFor(server, { token: server.issueRefreshToken() })).toThrow(/client id/);
      expect(() =>
        adapterFor(server, { token: server.issueRefreshToken(), clientId: server.clientId }),
      ).not.toThrow();
    });

    it("rejects a damaged token envelope without quoting it", () => {
      const error = (() => {
        try {
          adapterFor(server, { token: "onedrive1.!!!not-base64-json" });
        } catch (caught) {
          return caught as MongoShieldError;
        }
        return undefined;
      })();
      expect(error?.code).toBe("MS_CONFIG_INVALID");
      expect(error?.message).not.toContain("not-base64-json");
    });

    it("reports its kind, location and capabilities", () => {
      const storage = adapterFor(server, { folder: "/prod/app/" });
      expect(storage.kind).toBe("onedrive");
      expect(storage.location).toBe("onedrive://prod/app/");
      expect(storage.capabilities).toEqual({
        conditionalWrites: true,
        rangeReads: true,
        objectLock: false,
      });
    });
  });

  describe("onedriveStorageFromUrl", () => {
    /** Sends what would go to Microsoft to the fake instead. */
    function routeToFake(record?: string[]) {
      vi.stubGlobal("fetch", (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input)
          .replace("https://graph.microsoft.com/v1.0", server.graphUrl)
          .replace("https://login.microsoftonline.com", server.authorityUrl);
        record?.push(url);
        return globalFetch(url, init);
      });
    }
    const globalFetch = fetch;

    it("parses the folder from the host and path, percent-decoded", () => {
      const env = { MONGOSHIELD_ONEDRIVE_TOKEN: server.secret() };
      expect(onedriveStorageFromUrl(new URL("onedrive://backups"), env).location).toBe(
        "onedrive://backups/",
      );
      expect(onedriveStorageFromUrl(new URL("onedrive://prod/my%20app/"), env).location).toBe(
        "onedrive://prod/my app/",
      );
    });

    it("needs MONGOSHIELD_ONEDRIVE_TOKEN and a folder", () => {
      expect(() => onedriveStorageFromUrl(new URL("onedrive://backups"), {})).toThrow(
        /MONGOSHIELD_ONEDRIVE_TOKEN/,
      );
      const env = { MONGOSHIELD_ONEDRIVE_TOKEN: server.secret() };
      expect(() => onedriveStorageFromUrl(new URL("onedrive://"), env)).toThrow(
        /folder is required/,
      );
    });

    it("rejects unknown parameters, credentials and other schemes", () => {
      const env = { MONGOSHIELD_ONEDRIVE_TOKEN: server.secret() };
      expect(() => onedriveStorageFromUrl(new URL("onedrive://b?region=x"), env)).toThrow(
        /Unknown/,
      );
      expect(() => onedriveStorageFromUrl(new URL("onedrive://user:pw@b"), env)).toThrow(
        /credentials/,
      );
      expect(() => onedriveStorageFromUrl(new URL("gdrive://b"), env)).toThrow(/Not a onedrive/);
      expect(() => onedriveStorageFromUrl(new URL("onedrive://b?business=maybe"), env)).toThrow(
        /true or false/,
      );
      expect(() => onedriveStorageFromUrl(new URL("onedrive://b?fragmentSizeMiB=3"), env)).toThrow(
        /320 KiB/,
      );
    });

    it("accepts business=true for a work or school sign-in", () => {
      const env = { MONGOSHIELD_ONEDRIVE_TOKEN: server.secret({ tenant: "common" }) };
      expect(() => onedriveStorageFromUrl(new URL("onedrive://b"), env)).toThrow(/work or school/);
      expect(() =>
        onedriveStorageFromUrl(new URL("onedrive://b?business=true"), env),
      ).not.toThrow();
    });

    it("uses fragmentSizeMiB, the token state file and the client id from the environment", async () => {
      const record: string[] = [];
      routeToFake(record);
      const statePath = join(tempDirectory, "state", "onedrive-token.json");
      const storage = onedriveStorageFromUrl(new URL("onedrive://from-url?fragmentSizeMiB=5"), {
        // A bare token, so the client id can only come from the environment.
        MONGOSHIELD_ONEDRIVE_TOKEN: server.issueRefreshToken(),
        MONGOSHIELD_ONEDRIVE_TOKEN_STATE: statePath,
        MONGOSHIELD_ONEDRIVE_CLIENT_ID: server.clientId,
      });
      await storage.put("big.bin", pattern(11 * MIB));
      expect(server.stats.fragments).toEqual([5 * MIB, 5 * MIB, MIB]);
      expect(await readdir(join(tempDirectory, "state"))).toEqual(["onedrive-token.json"]);
      expect(server.files()).toEqual(["from-url/big.bin"]);
    });

    it("passes MONGOSHIELD_ONEDRIVE_CLIENT_SECRET to the token endpoint", async () => {
      const bodies: string[] = [];
      vi.stubGlobal("fetch", (input: string | URL | Request, init?: RequestInit) => {
        if (String(input).endsWith("/token")) bodies.push(String(init?.body));
        const url = String(input)
          .replace("https://graph.microsoft.com/v1.0", server.graphUrl)
          .replace("https://login.microsoftonline.com", server.authorityUrl);
        return globalFetch(url, init);
      });
      const storage = onedriveStorageFromUrl(new URL("onedrive://b"), {
        MONGOSHIELD_ONEDRIVE_TOKEN: encodeOneDriveSecret({
          refreshToken: server.issueRefreshToken(),
          clientId: server.clientId,
        }),
        MONGOSHIELD_ONEDRIVE_CLIENT_SECRET: "client-secret-value",
      });
      await storage.head("x");
      expect(new URLSearchParams(bodies[0]).get("client_secret")).toBe("client-secret-value");
    });
  });
});
