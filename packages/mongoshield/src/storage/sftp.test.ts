/**
 * Tests for the SFTP adapter against a real SSH/SFTP server running in this
 * process (`test/helpers/sftp-server.ts`, built on ssh2's `Server`). The full
 * storage conformance suite runs here, plus SFTP-specific behaviour: host key
 * verification, authentication, reconnects, temp files and error mapping.
 */

import { chmod, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { type AddressInfo, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  simulatePosixRenameSupport,
  startSftpServer,
  type TestSftpServer,
} from "../../test/helpers/sftp-server.ts";
import { describeStorageConformance } from "../../test/helpers/storage-conformance.ts";
import { isMongoShieldError } from "../errors.ts";
import { type SftpStorageOptions, sftpStorage, sshFingerprint } from "./sftp.ts";
import type { StorageAdapter } from "./types.ts";

let server: TestSftpServer;

beforeAll(async () => {
  server = await startSftpServer();
});

afterAll(async () => {
  await server.close();
});

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error("expected the promise to reject");
    },
    (error: unknown) => error,
  );
}

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const items: T[] = [];
  for await (const item of iterable) items.push(item);
  return items;
}

async function readAll(stream: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const piece of stream) chunks.push(Buffer.from(piece));
  return Buffer.concat(chunks).toString();
}

describeStorageConformance("sftp (in-process ssh2 server)", async () => {
  const root = await mkdtemp(join(tmpdir(), "ms-sftp-"));
  const storage = sftpStorage({ ...server.clientOptions, path: join(root, "store") });
  return {
    storage,
    cleanup: async () => {
      await storage.close?.();
      await rm(root, { recursive: true, force: true });
    },
  };
});

describe("sftpStorage", () => {
  let root: string;
  let adapters: StorageAdapter[];

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "ms-sftp-unit-"));
    adapters = [];
  });

  afterEach(async () => {
    for (const adapter of adapters) await adapter.close?.();
    await chmod(root, 0o700).catch(() => {});
    await rm(root, { recursive: true, force: true });
  });

  function storage(overrides: Partial<SftpStorageOptions> = {}): StorageAdapter {
    const adapter = sftpStorage({ ...server.clientOptions, path: root, ...overrides });
    adapters.push(adapter);
    return adapter;
  }

  describe("configuration", () => {
    it("shows user, host, non-default port and path in the location", () => {
      expect(storage({ path: "/srv/backups/" }).location).toBe(
        `sftp://tester@127.0.0.1:${server.port}/srv/backups/`,
      );
      expect(storage({ port: 22, path: "backups" }).location).toBe(
        "sftp://tester@127.0.0.1/~/backups/",
      );
      expect(storage().kind).toBe("sftp");
      expect(storage().capabilities).toEqual({
        conditionalWrites: true,
        rangeReads: true,
        objectLock: false,
      });
    });

    it("refuses to be created without a host fingerprint unless unknown hosts are allowed", () => {
      const { hostFingerprint: _ignored, ...withoutFingerprint } = server.clientOptions;
      const error = rejectionSync(() => sftpStorage({ ...withoutFingerprint, path: root }));
      expect(isMongoShieldError(error, "MS_CONFIG_INVALID")).toBe(true);
      expect(isMongoShieldError(error) && error.hint).toContain("ssh-keyscan");
      expect(() =>
        sftpStorage({ ...withoutFingerprint, path: root, allowUnknownHostKey: true }),
      ).not.toThrow();
    });

    it.each<[string, Partial<SftpStorageOptions>]>([
      ["no host", { host: "" }],
      ["no username", { username: "" }],
      ["no path", { path: "" }],
      ["an invalid port", { port: 70_000 }],
      ["a malformed fingerprint", { hostFingerprint: "MD5:aa:bb" }],
    ])("rejects %s with MS_CONFIG_INVALID", (_label, overrides) => {
      expect(() => sftpStorage({ ...server.clientOptions, path: root, ...overrides })).toThrow(
        expect.objectContaining({ code: "MS_CONFIG_INVALID" }),
      );
    });

    it("needs a key or an agent, and never offers password authentication", () => {
      const { privateKey: _ignored, ...withoutKey } = server.clientOptions;
      const error = rejectionSync(() => sftpStorage({ ...withoutKey, path: root }));
      expect(isMongoShieldError(error, "MS_CONFIG_INVALID")).toBe(true);
      expect(isMongoShieldError(error) && error.hint).toContain(
        "Password authentication is not supported",
      );
    });

    it("accepts fingerprints with or without the SHA256: prefix and padding", async () => {
      const bare = server.hostFingerprint.slice("SHA256:".length);
      const adapter = storage({ hostFingerprint: [`${bare}=`, `SHA256:${"A".repeat(43)}`] });
      await adapter.put("a.txt", Buffer.from("a"));
      expect(await adapter.head("a.txt")).toBeDefined();
    });
  });

  describe("connection security", () => {
    it("refuses a host whose key does not match, naming the presented fingerprint", async () => {
      const adapter = storage({ hostFingerprint: `SHA256:${"B".repeat(43)}` });
      const error = await rejection(adapter.head("a.txt"));
      expect(isMongoShieldError(error, "MS_STORAGE_FORBIDDEN")).toBe(true);
      expect(String(error)).toContain(server.hostFingerprint);
      expect(isMongoShieldError(error) && error.hint).toMatch(/intercepting/);
    });

    it("maps a rejected client key to MS_STORAGE_FORBIDDEN with an authorized_keys hint", async () => {
      const otherServer = await startSftpServer();
      await otherServer.close();
      const error = await rejection(storage({ privateKey: otherServer.privateKey }).head("a.txt"));
      expect(isMongoShieldError(error, "MS_STORAGE_FORBIDDEN")).toBe(true);
      expect(isMongoShieldError(error) && error.hint).toContain("authorized_keys");
    });

    it("reads the key from privateKeyPath and decrypts it with the passphrase", async () => {
      const keyFile = join(root, "id_ed25519");
      await writeFile(keyFile, server.authorizeNewKey("correct horse"), { mode: 0o600 });
      const adapter = storage({ privateKeyPath: keyFile, passphrase: "correct horse" });
      await adapter.put("a.txt", Buffer.from("a"));
      expect(await adapter.head("a.txt")).toBeDefined();
    });

    it("reports a wrong passphrase as MS_CONFIG_INVALID without echoing it", async () => {
      const keyFile = join(root, "id_ed25519");
      await writeFile(keyFile, server.authorizeNewKey("correct horse"), { mode: 0o600 });
      const error = await rejection(
        storage({ privateKeyPath: keyFile, passphrase: "wrong passphrase" }).head("a.txt"),
      );
      expect(isMongoShieldError(error, "MS_CONFIG_INVALID")).toBe(true);
      expect(isMongoShieldError(error) && error.hint).toContain("passphrase");
      expect(String(error)).not.toContain("wrong passphrase");
    });

    it("gives up on a server that never completes the handshake after readyTimeoutMs", async () => {
      const silent = createServer(() => {});
      await new Promise<void>((resolve) => silent.listen(0, "127.0.0.1", resolve));
      try {
        const { port } = silent.address() as AddressInfo;
        const started = Date.now();
        const error = await rejection(storage({ port, readyTimeoutMs: 300 }).head("a.txt"));
        expect(isMongoShieldError(error, "MS_STORAGE_IO")).toBe(true);
        expect(Date.now() - started).toBeLessThan(5_000);
      } finally {
        silent.close();
      }
    });

    it("uses the agent in SSH_AUTH_SOCK for agent: true, and needs it to be set", () => {
      const { privateKey: _ignored, ...withoutKey } = server.clientOptions;
      const original = process.env.SSH_AUTH_SOCK;
      try {
        process.env.SSH_AUTH_SOCK = "/tmp/agent.sock";
        expect(() => sftpStorage({ ...withoutKey, path: root, agent: true })).not.toThrow();
        delete process.env.SSH_AUTH_SOCK;
        expect(() => sftpStorage({ ...withoutKey, path: root, agent: true })).toThrow(
          expect.objectContaining({ code: "MS_CONFIG_INVALID" }),
        );
      } finally {
        if (original === undefined) delete process.env.SSH_AUTH_SOCK;
        else process.env.SSH_AUTH_SOCK = original;
      }
    });

    it("reports an unreadable key file as MS_CONFIG_INVALID", async () => {
      const error = await rejection(
        storage({ privateKeyPath: join(root, "missing-key") }).head("a.txt"),
      );
      expect(isMongoShieldError(error, "MS_CONFIG_INVALID")).toBe(true);
    });

    it("reports an unreachable server as MS_STORAGE_IO with a connectivity hint", async () => {
      const closed = await startSftpServer();
      await closed.close();
      const error = await rejection(storage({ ...closed.clientOptions }).head("a.txt"));
      expect(isMongoShieldError(error, "MS_STORAGE_IO")).toBe(true);
      expect(isMongoShieldError(error) && error.hint).toContain(`127.0.0.1:${closed.port}`);
    });

    it("computes OpenSSH-style SHA256 fingerprints", () => {
      expect(sshFingerprint(Buffer.from("key"))).toBe(
        "SHA256:LHDhK3oGRvkiefQnx7OOczTY5Tic/xZ6HcMOc/gmtoM",
      );
    });
  });

  describe("connection reuse", () => {
    it("uses one connection for many calls and reconnects after it drops", async () => {
      const adapter = storage();
      const before = server.connectionCount();
      await Promise.all(
        Array.from({ length: 10 }, (_, index) => adapter.put(`k/${index}`, Buffer.from("x"))),
      );
      expect(server.connectionCount() - before).toBe(1);

      server.disconnectAll();
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(await collect(adapter.listPrefixes(""))).toEqual(["k/"]);
      expect(server.connectionCount() - before).toBe(2);
    });

    it("reconnects lazily after close()", async () => {
      const adapter = storage();
      await adapter.put("a", Buffer.from("1"));
      await adapter.close?.();
      expect(await readAll(await adapter.get("a"))).toBe("1");
    });
  });

  describe("atomic writes", () => {
    it("writes into a hidden temp file and renames it into place", async () => {
      const adapter = storage();
      let release: () => void = () => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      async function* slowBody() {
        yield Buffer.from("first half, ");
        await gate;
        yield Buffer.from("second half");
      }
      const writing = adapter.put("dir/object.bin", Readable.from(slowBody()));

      // While the body is still streaming only the temp file exists.
      await expect.poll(async () => readdir(join(root, "dir")).catch(() => [])).toHaveLength(1);
      const [tempName] = await readdir(join(root, "dir"));
      expect(tempName).toMatch(/^\.object\.bin\.[0-9a-f]{16}\.tmp$/);
      expect(await adapter.head("dir/object.bin")).toBeUndefined();
      expect(await collect(adapter.list(""))).toEqual([]);

      release();
      const info = await writing;
      expect(info.size).toBe(23);
      expect(await readdir(join(root, "dir"))).toEqual(["object.bin"]);
      expect(await readAll(await adapter.get("dir/object.bin"))).toBe("first half, second half");
    });

    it("replaces existing objects with posix-rename when the server supports it", async () => {
      const restore = simulatePosixRenameSupport();
      try {
        const adapter = storage();
        const before = server.posixRenameCount();
        await adapter.put("a.txt", Buffer.from("old"));
        await adapter.put("a.txt", Buffer.from("new"));
        expect(server.posixRenameCount() - before).toBe(2);
        expect(await readAll(await adapter.get("a.txt"))).toBe("new");
        // Conditional creates still use the plain rename, which refuses to overwrite.
        await expect(adapter.put("a.txt", Buffer.from("x"), { ifNoneMatch: "*" })).rejects.toThrow(
          expect.objectContaining({ code: "MS_STORAGE_PRECONDITION_FAILED" }),
        );
        expect(server.posixRenameCount() - before).toBe(2);
      } finally {
        restore();
      }
    });

    it("falls back to remove-then-rename for overwrites without posix-rename", async () => {
      const adapter = storage();
      const before = server.posixRenameCount();
      await adapter.put("a.txt", Buffer.from("old"));
      await adapter.put("a.txt", Buffer.from("new"));
      expect(server.posixRenameCount()).toBe(before);
      expect(await readAll(await adapter.get("a.txt"))).toBe("new");
    });

    it("refuses keys shaped like its temp files", async () => {
      const error = await rejection(storage().put("a/.b.0123456789abcdef.tmp", Buffer.from("x")));
      expect(String(error)).toMatch(/reserved/);
    });

    it("reports the mtime of the written file as lastModified", async () => {
      const info = await storage().put("a.txt", Buffer.from("x"));
      const stats = await stat(join(root, "a.txt"));
      expect(Math.floor(info.lastModified.getTime() / 1000)).toBe(Math.floor(stats.mtimeMs / 1000));
    });
  });

  describe("error mapping", () => {
    it("maps PERMISSION_DENIED to MS_STORAGE_FORBIDDEN", async ({ skip }) => {
      if (process.getuid?.() === 0) skip(); // root ignores permissions
      await chmod(root, 0o500);
      const error = await rejection(storage().put("dir/a.txt", Buffer.from("x")));
      expect(isMongoShieldError(error, "MS_STORAGE_FORBIDDEN")).toBe(true);
      expect(isMongoShieldError(error) && error.hint).toContain("tester");
    });

    it("treats a directory like a missing object", async () => {
      const adapter = storage();
      await adapter.put("dir/a.txt", Buffer.from("x"));
      const error = await rejection(adapter.get("dir"));
      expect(isMongoShieldError(error, "MS_STORAGE_NOT_FOUND")).toBe(true);
      await adapter.delete(["dir"]);
      expect(await adapter.head("dir/a.txt")).toBeDefined();
    });
  });

  describe("range reads", () => {
    it("reads only the requested bytes, across several request chunks", async () => {
      const adapter = storage();
      const data = Buffer.alloc(200_000, 0);
      for (let index = 0; index < data.length; index++) data[index] = index % 251;
      await adapter.put("big.bin", data);
      const stream = await adapter.get("big.bin", { range: { start: 1000, end: 150_000 } });
      const chunks: Buffer[] = [];
      for await (const piece of stream) chunks.push(Buffer.from(piece));
      expect(Buffer.concat(chunks)).toEqual(data.subarray(1000, 150_001));
    });

    it("returns an empty stream for a range past the end", async () => {
      const adapter = storage();
      await adapter.put("small.bin", Buffer.from("abc"));
      expect(await readAll(await adapter.get("small.bin", { range: { start: 10 } }))).toBe("");
    });

    it("rejects invalid ranges", async () => {
      const adapter = storage();
      await adapter.put("small.bin", Buffer.from("abc"));
      await expect(adapter.get("small.bin", { range: { start: 5, end: 2 } })).rejects.toThrow(
        /Invalid byte range/,
      );
    });
  });
});

/** Captures what a synchronous function throws. */
function rejectionSync(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error("expected the function to throw");
}
