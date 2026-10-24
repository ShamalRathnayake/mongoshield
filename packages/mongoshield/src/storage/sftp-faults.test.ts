/**
 * Failure paths of the SFTP adapter that a well-behaved server never takes:
 * request errors with every SFTP status, write failures while requests are in
 * flight, missing protocol extensions, races with concurrent deletes, channels
 * that fail or close, and odd ssh2 module shapes.
 *
 * `ssh2` is replaced (in this file's own module registry) by a scriptable fake:
 * an in-memory filesystem behind the `SFTPWrapper` methods the adapter uses,
 * where each test can make chosen requests fail. Everything else about SFTP is
 * covered against real servers in sftp.test.ts and the OpenSSH integration test.
 */

import { posix } from "node:path";
import { Readable } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { isMongoShieldError } from "../errors.ts";

/** SFTP v3 status codes, as ssh2 attaches them to request errors. */
const STATUS = {
  NO_SUCH_FILE: 2,
  PERMISSION_DENIED: 3,
  FAILURE: 4,
  NO_CONNECTION: 6,
  CONNECTION_LOST: 7,
  OP_UNSUPPORTED: 8,
} as const;

type Callback = (error: Error | null | undefined, value?: unknown) => void;

/** A request the fake fails: an error to answer with, or "throw" to throw synchronously. */
type Fault = Error | "throw";

/**
 * How the fake behaves; reset before each test. A fault handler receives the
 * request's arguments and returns a fault, or `undefined` to let it through.
 */
const scenario = vi.hoisted(() => ({
  /** Server-side files and directories, by absolute path. */
  files: new Map<string, { directory: boolean; data: Buffer; mtime: number }>(),
  faults: new Map<string, (...args: unknown[]) => Error | "throw" | undefined>(),
  /** Which OpenSSH extensions the "server" advertises. */
  extensions: { posixRename: false, fsync: false },
  /** Error for the `sftp()` channel request, if any. */
  channelError: undefined as Error | undefined,
  /** Emit an "error" after the connection is ready (ssh2 does this, then closes). */
  errorAfterReady: false,
  /** Number of `connect()` calls. */
  connects: 0,
  /** Ends the live client, like a dropped connection. */
  dropConnection: () => {},
  /** Ends the live SFTP channel only. */
  dropChannel: () => {},
  /** The module shape: exports on the namespace, on `default`, or no Client at all. */
  shape: "namespace" as "namespace" | "default" | "none",
}));

/** An SFTP status error as ssh2 produces them. */
function statusError(code: number, message = `status ${code}`): Error {
  return Object.assign(new Error(message), { code });
}

/** Mode bits: regular file or directory, 0644/0755. */
const FILE_MODE = 0o100644;
const DIRECTORY_MODE = 0o040755;

vi.mock("ssh2", () => {
  /** Answers a request: a fault if one is scripted, otherwise `run()`. */
  function answer(method: string, args: unknown[], callback: Callback, run: () => unknown): void {
    const fault = scenario.faults.get(method)?.(...args);
    if (fault === "throw") throw new Error(`${method}: channel is closed`);
    queueMicrotask(() => {
      if (fault !== undefined) {
        callback(fault);
        return;
      }
      try {
        callback(null, run());
      } catch (error) {
        callback(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  function statsOf(path: string) {
    const entry = scenario.files.get(path);
    if (entry === undefined) throw statusError(STATUS.NO_SUCH_FILE, "No such file");
    return {
      size: entry.data.length,
      mtime: entry.mtime,
      mode: entry.directory ? DIRECTORY_MODE : FILE_MODE,
    };
  }

  function requireParent(path: string): void {
    const parent = posix.dirname(path);
    if (parent !== path && scenario.files.get(parent)?.directory !== true) {
      throw statusError(STATUS.NO_SUCH_FILE, "No such file");
    }
  }

  class FakeSession {
    private readonly handles = new Map<string, string>();
    private nextHandle = 0;
    private closeListeners: (() => void)[] = [];

    on(_event: "close", listener: () => void) {
      this.closeListeners.push(listener);
    }
    end() {
      for (const listener of this.closeListeners) listener();
    }
    private pathOf(handle: unknown): string {
      const path = this.handles.get(String(handle));
      if (path === undefined) throw statusError(STATUS.FAILURE, "Invalid handle");
      return path;
    }
    open(path: string, flags: string, callback: Callback) {
      answer("open", [path, flags], callback, () => {
        if (flags === "wx") {
          requireParent(path);
          if (scenario.files.has(path)) throw statusError(STATUS.FAILURE, "File exists");
          scenario.files.set(path, {
            directory: false,
            data: Buffer.alloc(0),
            mtime: 1_700_000_000,
          });
        } else if (!scenario.files.has(path)) {
          throw statusError(STATUS.NO_SUCH_FILE, "No such file");
        }
        const handle = String(this.nextHandle++);
        this.handles.set(handle, path);
        return Buffer.from(handle);
      });
    }
    close(handle: Buffer, callback: Callback) {
      answer("close", [handle], callback, () => {
        this.handles.delete(String(handle));
      });
    }
    read(
      handle: Buffer,
      buffer: Buffer,
      offset: number,
      length: number,
      position: number,
      callback: Callback,
    ) {
      answer("read", [handle, position], callback, () => {
        const data = scenario.files.get(this.pathOf(handle))?.data ?? Buffer.alloc(0);
        return data.copy(buffer, offset, position, Math.min(data.length, position + length));
      });
    }
    write(
      handle: Buffer,
      buffer: Buffer,
      offset: number,
      length: number,
      position: number,
      callback: Callback,
    ) {
      answer("write", [handle, position], callback, () => {
        const entry = scenario.files.get(this.pathOf(handle));
        if (entry === undefined) throw statusError(STATUS.NO_SUCH_FILE);
        const end = position + length;
        const grown = Buffer.alloc(Math.max(entry.data.length, end));
        entry.data.copy(grown);
        buffer.copy(grown, position, offset, offset + length);
        entry.data = grown;
      });
    }
    fstat(handle: Buffer, callback: Callback) {
      answer("fstat", [handle], callback, () => statsOf(this.pathOf(handle)));
    }
    stat(path: string, callback: Callback) {
      answer("stat", [path], callback, () => statsOf(path));
    }
    readdir(requested: string, callback: Callback) {
      // Servers accept "dir/" for "dir"; the adapter asks for "<root>/<prefix>/".
      const path = requested.length > 1 ? requested.replace(/\/+$/, "") : requested;
      answer("readdir", [path], callback, () => {
        if (scenario.files.get(path)?.directory !== true) throw statusError(STATUS.NO_SUCH_FILE);
        const entries = [];
        for (const candidate of scenario.files.keys()) {
          if (candidate !== path && posix.dirname(candidate) === path) {
            entries.push({ filename: posix.basename(candidate), attrs: statsOf(candidate) });
          }
        }
        // Real servers include these; the adapter must drop them.
        entries.push({ filename: ".", attrs: statsOf(path) });
        return entries;
      });
    }
    mkdir(path: string, callback: Callback) {
      answer("mkdir", [path], callback, () => {
        requireParent(path);
        if (scenario.files.has(path)) throw statusError(STATUS.FAILURE, "File exists");
        scenario.files.set(path, { directory: true, data: Buffer.alloc(0), mtime: 1_700_000_000 });
      });
    }
    rmdir(path: string, callback: Callback) {
      answer("rmdir", [path], callback, () => {
        if (!scenario.files.has(path)) throw statusError(STATUS.NO_SUCH_FILE);
        for (const candidate of scenario.files.keys()) {
          if (posix.dirname(candidate) === path && candidate !== path) {
            throw statusError(STATUS.FAILURE, "Directory not empty");
          }
        }
        scenario.files.delete(path);
      });
    }
    unlink(path: string, callback: Callback) {
      answer("unlink", [path], callback, () => {
        const entry = scenario.files.get(path);
        if (entry === undefined) throw statusError(STATUS.NO_SUCH_FILE);
        if (entry.directory) throw statusError(STATUS.FAILURE, "Is a directory");
        scenario.files.delete(path);
      });
    }
    rename(from: string, to: string, callback: Callback) {
      answer("rename", [from, to], callback, () => this.move(from, to, false));
    }
    ext_openssh_rename(from: string, to: string, callback: Callback) {
      if (!scenario.extensions.posixRename) {
        throw new Error("Server does not support this extended request");
      }
      answer("posixRename", [from, to], callback, () => this.move(from, to, true));
    }
    ext_openssh_fsync(handle: Buffer, callback: Callback) {
      if (!scenario.extensions.fsync) {
        throw new Error("Server does not support this extended request");
      }
      answer("fsync", [handle], callback, () => undefined);
    }
    private move(from: string, to: string, replace: boolean) {
      const entry = scenario.files.get(from);
      if (entry === undefined) throw statusError(STATUS.NO_SUCH_FILE);
      if (!replace && scenario.files.has(to)) throw statusError(STATUS.FAILURE, "File exists");
      scenario.files.delete(from);
      scenario.files.set(to, entry);
    }
  }

  class Client {
    private readonly listeners = new Map<string, ((...args: unknown[]) => void)[]>();
    private ended = false;

    on(event: string, listener: (...args: unknown[]) => void) {
      this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
      return this;
    }
    private emit(event: string, ...args: unknown[]) {
      for (const listener of this.listeners.get(event) ?? []) listener(...args);
    }
    connect(config: { hostVerifier: (key: Buffer) => boolean }) {
      scenario.connects++;
      scenario.dropConnection = () => this.end();
      queueMicrotask(() => {
        if (!config.hostVerifier(Buffer.from("fake host key"))) {
          this.emit("error", Object.assign(new Error("Host denied"), { level: "client-dns" }));
          this.end();
          return;
        }
        this.emit("ready");
        if (scenario.errorAfterReady) {
          queueMicrotask(() => this.emit("error", new Error("late failure")));
        }
      });
    }
    sftp(callback: (error: Error | undefined, session?: FakeSession) => void) {
      queueMicrotask(() => {
        if (scenario.channelError !== undefined) {
          callback(scenario.channelError);
          return;
        }
        const session = new FakeSession();
        scenario.dropChannel = () => session.end();
        callback(undefined, session);
      });
    }
    end() {
      if (this.ended) return;
      this.ended = true;
      queueMicrotask(() => this.emit("close"));
    }
  }

  // Getters, so each test can choose how the module looks when it is imported.
  return {
    get Client() {
      return scenario.shape === "namespace" ? Client : undefined;
    },
    get default() {
      return scenario.shape === "default" ? { Client } : {};
    },
  };
});

const { sftpStorage, sshFingerprint } = await import("./sftp.ts");

const ROOT = "/srv/backups";

function storage(path = ROOT) {
  return sftpStorage({
    host: "sftp.example.com",
    username: "backup",
    privateKey: "unused by the fake",
    hostFingerprint: sshFingerprint(Buffer.from("fake host key")),
    path,
    keepaliveIntervalMs: 0,
  });
}

/** Rejects unless `promise` rejects; returns the rejection. */
async function rejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error("expected the promise to reject");
    },
    (error: unknown) => error,
  );
}

async function readAll(stream: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const piece of stream) chunks.push(Buffer.from(piece));
  return Buffer.concat(chunks).toString();
}

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const items: T[] = [];
  for await (const item of iterable) items.push(item);
  return items;
}

/** Creates directories (and their parents) in the fake filesystem. */
function makeDirectory(path: string): void {
  let current = path;
  while (!scenario.files.has(current)) {
    scenario.files.set(current, { directory: true, data: Buffer.alloc(0), mtime: 1_700_000_000 });
    const parent = posix.dirname(current);
    if (parent === current) break;
    current = parent;
  }
}

/** Puts a file straight into the fake filesystem. */
function seedFile(path: string, content: string): void {
  makeDirectory(posix.dirname(path));
  scenario.files.set(path, { directory: false, data: Buffer.from(content), mtime: 1_700_000_000 });
}

/** Fails `method` requests whose first argument passes `matches`, `times` times (default always). */
function failRequests(
  method: string,
  fault: Fault,
  matches: (first: unknown) => boolean = () => true,
  times = Number.POSITIVE_INFINITY,
): void {
  let remaining = times;
  scenario.faults.set(method, (first) => {
    if (remaining <= 0 || !matches(first)) return undefined;
    remaining--;
    return fault;
  });
}

const isTempFile = (path: unknown) => /\.[0-9a-f]{16}\.tmp$/.test(String(path));

beforeEach(() => {
  scenario.files.clear();
  scenario.faults.clear();
  scenario.extensions = { posixRename: false, fsync: false };
  scenario.channelError = undefined;
  scenario.errorAfterReady = false;
  scenario.connects = 0;
  scenario.shape = "namespace";
  makeDirectory(ROOT);
});

describe("sftpStorage against a failing server", () => {
  describe("error mapping", () => {
    it.each([
      [STATUS.NO_CONNECTION, "MS_STORAGE_IO", "reconnects"],
      [STATUS.CONNECTION_LOST, "MS_STORAGE_IO", "reconnects"],
      [STATUS.PERMISSION_DENIED, "MS_STORAGE_FORBIDDEN", "may read and write"],
    ] as const)("maps status %i to %s with a hint", async (status, code, hint) => {
      failRequests("stat", statusError(status));
      const error = await rejection(storage().head("a"));
      expect(isMongoShieldError(error, code)).toBe(true);
      expect(isMongoShieldError(error) && error.hint).toContain(hint);
      expect(isMongoShieldError(error) && error.details).toEqual({ sftpStatus: status });
    });

    it("maps a FAILURE that says the disk is full to MS_STORAGE_INSUFFICIENT_SPACE", async () => {
      failRequests("write", statusError(STATUS.FAILURE, "No space left on device"));
      const error = await rejection(storage().put("a", Buffer.from("x")));
      expect(isMongoShieldError(error, "MS_STORAGE_INSUFFICIENT_SPACE")).toBe(true);
    });

    it("maps a bare FAILURE and unknown errors to MS_STORAGE_IO", async () => {
      failRequests("stat", statusError(STATUS.FAILURE, "Failure"), () => true, 1);
      expect(isMongoShieldError(await rejection(storage().head("a")), "MS_STORAGE_IO")).toBe(true);
      failRequests("stat", new Error("something odd"), () => true, 1);
      expect(isMongoShieldError(await rejection(storage().head("a")), "MS_STORAGE_IO")).toBe(true);
    });

    it("reports a failed listing as MS_STORAGE_IO naming the prefix", async () => {
      failRequests("readdir", statusError(STATUS.FAILURE, "Failure"));
      const error = await rejection(collect(storage().list("backups/")));
      expect(isMongoShieldError(error, "MS_STORAGE_IO")).toBe(true);
      expect(String(error)).toContain("backups/");
    });

    it("reports a failed stat during get as a read error and closes the handle", async () => {
      seedFile(`${ROOT}/a`, "x");
      failRequests("fstat", statusError(STATUS.FAILURE, "Failure"));
      const closes: unknown[] = [];
      scenario.faults.set("close", (handle) => {
        closes.push(handle);
        return undefined;
      });
      const error = await rejection(storage().get("a"));
      expect(isMongoShieldError(error, "MS_STORAGE_IO")).toBe(true);
      expect(closes).toHaveLength(1);
    });
  });

  describe("connections", () => {
    it("fails when the SFTP subsystem cannot be opened", async () => {
      scenario.channelError = new Error("Unable to start subsystem: sftp");
      const error = await rejection(storage().head("a"));
      expect(isMongoShieldError(error, "MS_STORAGE_IO")).toBe(true);
      expect(String(error)).toContain("Unable to start subsystem");
    });

    it("ignores errors after the handshake and reconnects once the connection closes", async () => {
      scenario.errorAfterReady = true;
      const adapter = storage();
      seedFile(`${ROOT}/a`, "1");
      expect(await adapter.head("a")).toBeDefined();
      scenario.dropConnection();
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(await adapter.head("a")).toBeDefined();
      expect(scenario.connects).toBe(2);
    });

    it("drops the whole connection when only the SFTP channel closes", async () => {
      const adapter = storage();
      expect(await adapter.head("a")).toBeUndefined();
      scenario.dropChannel();
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(await adapter.head("a")).toBeUndefined();
      expect(scenario.connects).toBe(2);
    });

    it("forgets a connection that closes while a reconnect is already under way", async () => {
      const adapter = storage();
      expect(await adapter.head("a")).toBeUndefined();
      // close() forgets the first connection; its late "close" must not clear the new one.
      await adapter.close?.();
      const second = adapter.head("a");
      expect(await second).toBeUndefined();
      expect(await adapter.head("a")).toBeUndefined();
      expect(scenario.connects).toBe(2);
    });

    it("loads ssh2 when its exports sit on `default`", async () => {
      scenario.shape = "default";
      expect(await storage().head("a")).toBeUndefined();
    });

    it("refuses an ssh2 module without a Client export", async () => {
      scenario.shape = "none";
      const error = await rejection(storage().head("a"));
      expect(isMongoShieldError(error, "MS_CONFIG_INVALID")).toBe(true);
      expect(isMongoShieldError(error) && error.hint).toContain("ssh2@1");
    });

    it("destroys a streamed body when it cannot connect", async () => {
      scenario.channelError = new Error("no channel");
      const body = Readable.from([Buffer.from("x")]);
      await rejection(storage().put("a", body));
      expect(body.destroyed).toBe(true);
    });
  });

  describe("writes", () => {
    it("retries creating the temp file when a concurrent delete removed its directory", async () => {
      failRequests("open", statusError(STATUS.NO_SUCH_FILE), isTempFile, 2);
      const info = await storage().put("dir/a", Buffer.from("abc"));
      expect(info.size).toBe(3);
      expect(scenario.files.get(`${ROOT}/dir/a`)?.data.toString()).toBe("abc");
    });

    it("gives up after a few attempts to create the temp file", async () => {
      failRequests("open", statusError(STATUS.NO_SUCH_FILE), isTempFile);
      const error = await rejection(storage().put("dir/a", Buffer.from("abc")));
      expect(isMongoShieldError(error, "MS_STORAGE_NOT_FOUND")).toBe(true);
      // The directory it created for the write is removed again.
      expect(scenario.files.has(`${ROOT}/dir`)).toBe(false);
    });

    it("accepts a directory created concurrently between its stat and mkdir", async () => {
      scenario.faults.set("mkdir", (path) => {
        makeDirectory(String(path));
        return statusError(STATUS.FAILURE, "File exists");
      });
      await storage().put("dir/a", Buffer.from("x"));
      expect(scenario.files.get(`${ROOT}/dir/a`)?.data.toString()).toBe("x");
    });

    it("fails when a directory cannot be created", async () => {
      failRequests("mkdir", statusError(STATUS.PERMISSION_DENIED));
      const error = await rejection(storage().put("dir/a", Buffer.from("x")));
      expect(isMongoShieldError(error, "MS_STORAGE_FORBIDDEN")).toBe(true);
    });

    it("stops sending and cleans up when one of the in-flight writes fails", async () => {
      failRequests("write", statusError(STATUS.FAILURE, "Failure"), () => true, 1);
      // Many 64 KiB requests, so later ones are sent after the failure is known.
      const body = Readable.from(Array.from({ length: 40 }, () => Buffer.alloc(64 * 1024, 1)));
      const error = await rejection(storage().put("big", body));
      expect(isMongoShieldError(error, "MS_STORAGE_IO")).toBe(true);
      expect([...scenario.files.keys()].filter((path) => isTempFile(path))).toEqual([]);
      expect(body.destroyed).toBe(true);
    });

    it("reports the failure of the last write after all requests are answered", async () => {
      failRequests("write", statusError(STATUS.FAILURE, "Failure"), () => true, 1);
      const error = await rejection(storage().put("small", Buffer.from("x")));
      expect(isMongoShieldError(error, "MS_STORAGE_IO")).toBe(true);
    });

    it("flushes with fsync@openssh.com when available, and fails when the flush fails", async () => {
      scenario.extensions.fsync = true;
      await storage().put("a", Buffer.from("x"));
      failRequests("fsync", statusError(STATUS.FAILURE, "I/O error"));
      const error = await rejection(storage().put("b", Buffer.from("x")));
      expect(isMongoShieldError(error, "MS_STORAGE_IO")).toBe(true);
      expect(scenario.files.has(`${ROOT}/b`)).toBe(false);
    });

    it("treats an OP_UNSUPPORTED answer to fsync like a missing extension", async () => {
      scenario.extensions.fsync = true;
      failRequests("fsync", statusError(STATUS.OP_UNSUPPORTED));
      await storage().put("a", Buffer.from("x"));
      expect(scenario.files.get(`${ROOT}/a`)?.data.toString()).toBe("x");
    });

    it("cleans up the temp file when closing it fails", async () => {
      failRequests("close", statusError(STATUS.FAILURE, "Failure"));
      const error = await rejection(storage().put("a", Buffer.from("x")));
      expect(isMongoShieldError(error, "MS_STORAGE_IO")).toBe(true);
      expect([...scenario.files.keys()].filter((path) => isTempFile(path))).toEqual([]);
    });

    it("fails a posix-rename that the server refuses", async () => {
      scenario.extensions.posixRename = true;
      failRequests("posixRename", statusError(STATUS.PERMISSION_DENIED));
      const error = await rejection(storage().put("a", Buffer.from("x")));
      expect(isMongoShieldError(error, "MS_STORAGE_FORBIDDEN")).toBe(true);
    });

    it("removes the old object and retries when the plain rename cannot overwrite", async () => {
      seedFile(`${ROOT}/a`, "old");
      await storage().put("a", Buffer.from("new"));
      expect(scenario.files.get(`${ROOT}/a`)?.data.toString()).toBe("new");
    });

    it("gives up on overwriting after a concurrent writer recreated the object three times", async () => {
      // However often the old object is removed, it is back before the rename.
      scenario.faults.set("rename", (from) => {
        if (isTempFile(from)) seedFile(`${ROOT}/a`, "theirs");
        return undefined;
      });
      const error = await rejection(storage().put("a", Buffer.from("mine")));
      expect(isMongoShieldError(error, "MS_STORAGE_IO")).toBe(true);
    });

    it("fails a plain rename that fails for another reason", async () => {
      failRequests("rename", statusError(STATUS.PERMISSION_DENIED));
      const error = await rejection(storage().put("a", Buffer.from("x")));
      expect(isMongoShieldError(error, "MS_STORAGE_FORBIDDEN")).toBe(true);
    });

    it("reports a conditional create that loses the rename race as a precondition failure", async () => {
      // The target appears between the early check and the rename.
      scenario.faults.set("rename", (from) => {
        if (isTempFile(from)) seedFile(`${ROOT}/claim`, "theirs");
        return undefined;
      });
      const error = await rejection(storage().put("claim", Buffer.from("x"), { ifNoneMatch: "*" }));
      expect(isMongoShieldError(error, "MS_STORAGE_PRECONDITION_FAILED")).toBe(true);
      expect(scenario.files.get(`${ROOT}/claim`)?.data.toString()).toBe("theirs");
    });

    it("reports a conditional rename that fails for another reason as that error", async () => {
      failRequests("rename", statusError(STATUS.PERMISSION_DENIED));
      const error = await rejection(storage().put("claim", Buffer.from("x"), { ifNoneMatch: "*" }));
      expect(isMongoShieldError(error, "MS_STORAGE_FORBIDDEN")).toBe(true);
    });

    it("stops pruning directories at the first one that cannot be removed", async () => {
      seedFile(`${ROOT}/a/b/keep`, "x");
      failRequests("rmdir", statusError(STATUS.PERMISSION_DENIED));
      await storage().delete(["a/b/keep"]);
      expect(scenario.files.has(`${ROOT}/a/b`)).toBe(true);
    });

    it("never prunes above a root of /", async () => {
      seedFile("/a/b", "x");
      await storage("/").delete(["a/b"]);
      expect(scenario.files.has("/a")).toBe(false);
      expect(scenario.files.has("/")).toBe(true);
    });
  });

  describe("reads", () => {
    it("ends the stream at the end of the file", async () => {
      seedFile(`${ROOT}/a`, "hello");
      expect(await readAll(await storage().get("a"))).toBe("hello");
    });

    it("destroys the stream when a read request fails", async () => {
      seedFile(`${ROOT}/a`, "hello");
      failRequests("read", statusError(STATUS.FAILURE, "Failure"));
      const stream = await storage().get("a");
      await expect(readAll(stream)).rejects.toThrow("Failure");
    });

    it("destroys the stream when the channel is already closed", async () => {
      seedFile(`${ROOT}/a`, "hello");
      failRequests("read", "throw");
      const stream = await storage().get("a");
      await expect(readAll(stream)).rejects.toThrow("channel is closed");
    });

    it("still finishes destroying when closing the handle throws", async () => {
      seedFile(`${ROOT}/a`, "hello");
      const stream = await storage().get("a");
      failRequests("close", "throw");
      stream.destroy();
      await new Promise((resolve) => stream.once("close", resolve));
      expect(stream.destroyed).toBe(true);
    });

    it("reports a missing object on open as MS_STORAGE_NOT_FOUND", async () => {
      const error = await rejection(storage().get("missing"));
      expect(isMongoShieldError(error, "MS_STORAGE_NOT_FOUND")).toBe(true);
    });

    it("reports an aborted get after the open as MS_ABORTED and closes the handle", async () => {
      seedFile(`${ROOT}/a`, "hello");
      const controller = new AbortController();
      scenario.faults.set("fstat", () => {
        controller.abort();
        return undefined;
      });
      const error = await rejection(storage().get("a", { signal: controller.signal }));
      expect(isMongoShieldError(error, "MS_ABORTED")).toBe(true);
    });
  });

  describe("listings and deletes", () => {
    it("treats a directory that vanishes during the walk as empty", async () => {
      seedFile(`${ROOT}/a/x`, "1");
      seedFile(`${ROOT}/b/y`, "2");
      failRequests("readdir", statusError(STATUS.NO_SUCH_FILE), (path) => path === `${ROOT}/a`);
      expect((await collect(storage().list(""))).map((info) => info.key)).toEqual(["b/y"]);
      expect(await collect(storage().listPrefixes(""))).toEqual(["b/"]);
    });

    it("finds objects in nested directories when deciding which prefixes exist", async () => {
      seedFile(`${ROOT}/a/deep/er/x`, "1");
      makeDirectory(`${ROOT}/b/empty/too`);
      expect(await collect(storage().listPrefixes(""))).toEqual(["a/"]);
    });

    it("ignores keys that are directories when deleting", async () => {
      seedFile(`${ROOT}/dir/x`, "1");
      await storage().delete(["dir"]);
      expect(scenario.files.has(`${ROOT}/dir/x`)).toBe(true);
    });

    it("reports an unlink failure on a file as a delete error", async () => {
      seedFile(`${ROOT}/a`, "1");
      failRequests("unlink", statusError(STATUS.PERMISSION_DENIED));
      const error = await rejection(storage().delete(["a"]));
      expect(isMongoShieldError(error, "MS_STORAGE_FORBIDDEN")).toBe(true);
    });

    it("reports a stat failure that is not 'no such file' while deciding how to delete", async () => {
      seedFile(`${ROOT}/a`, "1");
      failRequests("unlink", statusError(STATUS.FAILURE, "Failure"));
      failRequests("stat", statusError(STATUS.PERMISSION_DENIED));
      const error = await rejection(storage().delete(["a"]));
      expect(isMongoShieldError(error, "MS_STORAGE_FORBIDDEN")).toBe(true);
    });

    it("rejects a delete with MS_ABORTED when the signal fires between unlinks", async () => {
      seedFile(`${ROOT}/a`, "1");
      seedFile(`${ROOT}/b`, "2");
      const controller = new AbortController();
      scenario.faults.set("unlink", () => {
        controller.abort();
        return undefined;
      });
      const keys = Array.from({ length: 20 }, (_, index) => `k${index}`);
      const error = await rejection(
        storage().delete(["a", "b", ...keys], { signal: controller.signal }),
      );
      expect(isMongoShieldError(error, "MS_ABORTED")).toBe(true);
    });
  });
});
