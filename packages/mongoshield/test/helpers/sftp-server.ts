/**
 * An in-process SSH/SFTP server for tests, built on `ssh2`'s `Server` class
 * and backed by the local filesystem. It lets the SFTP adapter run the full
 * storage conformance suite without Docker or a system sshd.
 *
 *   const server = await startSftpServer();
 *   const storage = sftpStorage({ ...server.clientOptions, path: someTempDir });
 *   …
 *   await server.close();
 *
 * Paths sent by the client are used as real local paths (tests pass absolute
 * temp directories), so this is not a jail: never expose it beyond 127.0.0.1.
 *
 * RENAME follows OpenSSH's sftp-server: link(2) the new name, then unlink(2)
 * the old one, so renaming onto an existing file fails. That is the behaviour
 * the adapter's conditional writes rely on.
 *
 * ssh2's server cannot advertise protocol extensions, so by default clients see
 * none (no posix-rename, no fsync), like a minimal SFTP server. The server does
 * answer `posix-rename@openssh.com`; `simulatePosixRenameSupport()` makes ssh2
 * clients in this process believe it is advertised, to exercise that path.
 */

import { createHash } from "node:crypto";
import type { Dirent, Stats } from "node:fs";
import {
  type FileHandle,
  link,
  lstat,
  mkdir,
  open,
  readdir,
  rename,
  rmdir,
  stat,
  unlink,
} from "node:fs/promises";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import { join, resolve } from "node:path";

/** SFTP v3 status codes. */
const STATUS = {
  OK: 0,
  EOF: 1,
  NO_SUCH_FILE: 2,
  PERMISSION_DENIED: 3,
  FAILURE: 4,
  OP_UNSUPPORTED: 8,
} as const;

/** Attributes as ssh2's server-side `attrs()`/`name()` expect them (times in seconds). */
interface SftpAttributes {
  mode: number;
  uid: number;
  gid: number;
  size: number;
  atime: number;
  mtime: number;
}

/** The server-side SFTP stream methods and events this helper uses. */
interface ServerSftpStream {
  /** ssh2 passes the request id first, then request-specific arguments. */
  on(event: string, listener: (requestId: number, ...args: never[]) => void): unknown;
  handle(requestId: number, handle: Buffer): void;
  status(requestId: number, code: number, message?: string): void;
  data(requestId: number, data: Buffer): void;
  name(
    requestId: number,
    names: { filename: string; longname: string; attrs: SftpAttributes }[],
  ): void;
  attrs(requestId: number, attributes: SftpAttributes): void;
}

interface ParsedKey {
  readonly type: string;
  getPublicSSH(): Buffer;
  verify(data: Buffer, signature: Buffer, hashAlgo?: string): boolean | Error;
}

interface AuthContext {
  readonly username: string;
  readonly method: string;
  readonly key?: { algo: string; data: Buffer };
  readonly blob?: Buffer;
  readonly signature?: Buffer;
  readonly hashAlgo?: string;
  accept(): void;
  reject(): void;
}

interface ServerConnection {
  on(event: "authentication", listener: (context: AuthContext) => void): ServerConnection;
  on(event: "ready" | "close", listener: () => void): ServerConnection;
  on(event: "error", listener: (error: Error) => void): ServerConnection;
  on(
    event: "session",
    listener: (
      accept: () => { on(event: "sftp", listener: (accept: () => ServerSftpStream) => void): void },
    ) => void,
  ): ServerConnection;
  end(): void;
}

interface SshServer {
  listen(port: number, host: string, callback: () => void): void;
  address(): AddressInfo;
  close(callback: () => void): void;
}

interface Ssh2ForTests {
  Server: new (
    config: { hostKeys: string[] },
    onConnection: (connection: ServerConnection) => void,
  ) => SshServer;
  utils: {
    generateKeyPairSync(
      type: HostKeyType,
      options?: { passphrase?: string; cipher?: string; rounds?: number; bits?: number },
    ): { private: string; public: string };
    parseKey(key: string | Buffer, passphrase?: string): ParsedKey | Error;
    sftp: { flagsToString(flags: number): string | null };
  };
}

// ssh2 is CommonJS and ships no type declarations; describe what we use above.
const ssh2: Ssh2ForTests = createRequire(import.meta.url)("ssh2");

/** Key types the test server can use as host keys. */
export type HostKeyType = "ed25519" | "ecdsa" | "rsa";

/** Options for {@link startSftpServer}. */
export interface TestSftpServerOptions {
  /**
   * The server's host key types, in order (default: one ed25519 key). With
   * several, the client's preference decides which one the server presents.
   */
  readonly hostKeyTypes?: readonly HostKeyType[];
}

/** A running test server and everything a client needs to connect to it. */
export interface TestSftpServer {
  readonly host: string;
  readonly port: number;
  readonly username: string;
  /** The client's private key (OpenSSH format, unencrypted). */
  readonly privateKey: string;
  /** The server's (first) host key fingerprint, `SHA256:…`. */
  readonly hostFingerprint: string;
  /**
   * Every host key as a known_hosts key field pair, `<type> <base64 blob>`, in the
   * order of `hostKeyTypes`. Prefix a host pattern to get a known_hosts line.
   */
  readonly hostPublicKeys: readonly string[];
  /** Ready-made `sftpStorage` options (all but `path`). */
  readonly clientOptions: {
    host: string;
    port: number;
    username: string;
    privateKey: string;
    hostFingerprint: string;
  };
  /** Generates another client key pair and authorizes it (optionally passphrase-protected). */
  authorizeNewKey(passphrase?: string): string;
  /** Drops every open client connection, like a server restart or network failure. */
  disconnectAll(): void;
  /** How many SSH connections have been accepted so far. */
  connectionCount(): number;
  /** How many `posix-rename@openssh.com` requests the server has handled. */
  posixRenameCount(): number;
  close(): Promise<void>;
}

/** Starts the server on a random port on 127.0.0.1. */
export async function startSftpServer(
  options: TestSftpServerOptions = {},
): Promise<TestSftpServer> {
  const username = "tester";
  const hostKeys = (options.hostKeyTypes ?? ["ed25519"]).map((type) =>
    generateUsableKeyPair(undefined, type),
  );
  const hostKey = hostKeys[0];
  if (hostKey === undefined) throw new Error("startSftpServer needs at least one host key type");
  const clientKey = generateUsableKeyPair();
  const authorizedKeys: ParsedKey[] = [parsedKey(clientKey.public)];
  const connections = new Set<ServerConnection>();
  let accepted = 0;
  const counters = { posixRenames: 0 };

  const server = new ssh2.Server({ hostKeys: hostKeys.map((key) => key.private) }, (connection) => {
    accepted++;
    connections.add(connection);
    connection
      .on("authentication", (context) => authenticate(context, username, authorizedKeys))
      .on("ready", () => {
        connection.on("session", (acceptSession) => {
          acceptSession().on("sftp", (acceptSftp) => serveFilesystem(acceptSftp(), counters));
        });
      })
      .on("error", () => {
        // Clients disconnecting abruptly is normal in tests.
      })
      .on("close", () => connections.delete(connection));
  });

  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const port = server.address().port;
  const hostFingerprint = fingerprintOf(parsedKey(hostKey.public).getPublicSSH());
  const hostPublicKeys = hostKeys.map((key) => {
    const parsed = parsedKey(key.public);
    return `${parsed.type} ${parsed.getPublicSSH().toString("base64")}`;
  });
  const clientOptions = {
    host: "127.0.0.1",
    port,
    username,
    privateKey: clientKey.private,
    hostFingerprint,
  };

  return {
    ...clientOptions,
    clientOptions,
    hostPublicKeys,
    authorizeNewKey(passphrase) {
      const pair = generateUsableKeyPair(
        passphrase === undefined ? undefined : { passphrase, cipher: "aes256-ctr", rounds: 4 },
      );
      authorizedKeys.push(parsedKey(pair.public));
      return pair.private;
    },
    disconnectAll() {
      for (const connection of connections) connection.end();
    },
    connectionCount: () => accepted,
    posixRenameCount: () => counters.posixRenames,
    close() {
      for (const connection of connections) connection.end();
      return new Promise<void>((done) => server.close(() => done()));
    },
  };
}

/** How often to retry key generation before giving up (see `generateUsableKeyPair`). */
const KEY_GENERATION_ATTEMPTS = 20;

/**
 * A key pair (ed25519 unless asked otherwise) that ssh2 can read back. ssh2's own `generateKeyPairSync`
 * occasionally produces a public key its parser rejects as "Malformed OpenSSH public
 * key" (seen on CI, roughly one run in several hundred). The test server only needs
 * some valid key, so it generates again until both halves parse.
 */
function generateUsableKeyPair(
  options?: { passphrase: string; cipher: string; rounds: number },
  type: HostKeyType = "ed25519",
): {
  private: string;
  public: string;
} {
  // ECDSA and RSA need a size; P-256 and 2048 bits are the common server defaults.
  const sized = type === "ecdsa" ? { bits: 256 } : type === "rsa" ? { bits: 2048 } : {};
  for (let attempt = 1; attempt <= KEY_GENERATION_ATTEMPTS; attempt++) {
    const pair = ssh2.utils.generateKeyPairSync(type, { ...sized, ...options });
    const publicKey = ssh2.utils.parseKey(pair.public);
    const privateKey = ssh2.utils.parseKey(pair.private, options?.passphrase);
    if (!(publicKey instanceof Error) && !(privateKey instanceof Error)) return pair;
  }
  throw new Error(`ssh2 produced no parseable key pair in ${KEY_GENERATION_ATTEMPTS} attempts`);
}

function parsedKey(key: string): ParsedKey {
  const parsed = ssh2.utils.parseKey(key);
  if (parsed instanceof Error) throw parsed;
  return parsed;
}

function fingerprintOf(publicKeyBlob: Buffer): string {
  return `SHA256:${createHash("sha256").update(publicKeyBlob).digest("base64").replace(/=+$/, "")}`;
}

/** Public-key authentication only, like a hardened sshd. */
function authenticate(context: AuthContext, username: string, keys: readonly ParsedKey[]): void {
  if (context.username !== username || context.method !== "publickey" || !context.key) {
    context.reject();
    return;
  }
  const offered = context.key;
  const match = keys.find(
    (key) => key.type === offered.algo && key.getPublicSSH().equals(offered.data),
  );
  if (!match) {
    context.reject();
    return;
  }
  // Without a signature the client only asks whether the key would be accepted.
  if (context.signature && context.blob) {
    if (match.verify(context.blob, context.signature, context.hashAlgo) !== true) {
      context.reject();
      return;
    }
  }
  context.accept();
}

/** Maps a Node.js errno to the SFTP status OpenSSH would send. */
function statusFor(error: unknown): number {
  const code = typeof error === "object" && error !== null && "code" in error ? error.code : "";
  if (code === "ENOENT" || code === "ENOTDIR") return STATUS.NO_SUCH_FILE;
  if (code === "EACCES" || code === "EPERM") return STATUS.PERMISSION_DENIED;
  return STATUS.FAILURE;
}

function attributesOf(stats: Stats): SftpAttributes {
  return {
    mode: stats.mode,
    uid: stats.uid,
    gid: stats.gid,
    size: stats.size,
    atime: Math.floor(stats.atimeMs / 1000),
    mtime: Math.floor(stats.mtimeMs / 1000),
  };
}

/** Wires every SFTP request to the local filesystem. */
function serveFilesystem(sftp: ServerSftpStream, counters: { posixRenames: number }): void {
  const files = new Map<number, FileHandle>();
  const directories = new Map<number, { path: string; sent: boolean }>();
  let nextHandle = 1;

  function newHandle(): { id: number; buffer: Buffer } {
    const id = nextHandle++;
    const buffer = Buffer.alloc(4);
    buffer.writeUInt32BE(id);
    return { id, buffer };
  }

  /** Runs a request handler, turning any thrown error into a status reply. */
  function handle(
    event: string,
    run: (requestId: number, ...args: never[]) => Promise<void>,
  ): void {
    sftp.on(event, (requestId, ...args) => {
      run(requestId, ...args).catch((error: unknown) => sftp.status(requestId, statusFor(error)));
    });
  }

  const fileOf = (handleBuffer: Buffer) => {
    const file = files.get(handleBuffer.readUInt32BE(0));
    if (!file) throw Object.assign(new Error("bad handle"), { code: "EBADF" });
    return file;
  };

  handle("OPEN", async (requestId, path: string, flags: number) => {
    const mode = ssh2.utils.sftp.flagsToString(flags) ?? "r";
    const file = await open(path, mode);
    const { id, buffer } = newHandle();
    files.set(id, file);
    sftp.handle(requestId, buffer);
  });

  handle("READ", async (requestId, handleBuffer: Buffer, offset: number, length: number) => {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await fileOf(handleBuffer).read(buffer, 0, length, offset);
    if (bytesRead === 0) sftp.status(requestId, STATUS.EOF);
    else sftp.data(requestId, buffer.subarray(0, bytesRead));
  });

  handle("WRITE", async (requestId, handleBuffer: Buffer, offset: number, data: Buffer) => {
    await fileOf(handleBuffer).write(data, 0, data.length, offset);
    sftp.status(requestId, STATUS.OK);
  });

  handle("FSTAT", async (requestId, handleBuffer: Buffer) => {
    sftp.attrs(requestId, attributesOf(await fileOf(handleBuffer).stat()));
  });

  handle("STAT", async (requestId, path: string) => {
    sftp.attrs(requestId, attributesOf(await stat(path)));
  });

  handle("LSTAT", async (requestId, path: string) => {
    sftp.attrs(requestId, attributesOf(await lstat(path)));
  });

  handle("CLOSE", async (requestId, handleBuffer: Buffer) => {
    const id = handleBuffer.readUInt32BE(0);
    const file = files.get(id);
    files.delete(id);
    directories.delete(id);
    await file?.close();
    sftp.status(requestId, STATUS.OK);
  });

  handle("OPENDIR", async (requestId, path: string) => {
    if (!(await stat(path)).isDirectory()) throw Object.assign(new Error(), { code: "ENOTDIR" });
    const { id, buffer } = newHandle();
    directories.set(id, { path, sent: false });
    sftp.handle(requestId, buffer);
  });

  handle("READDIR", async (requestId, handleBuffer: Buffer) => {
    const directory = directories.get(handleBuffer.readUInt32BE(0));
    if (!directory || directory.sent) {
      sftp.status(requestId, STATUS.EOF);
      return;
    }
    directory.sent = true;
    const entries: Dirent[] = await readdir(directory.path, { withFileTypes: true });
    const names = [];
    for (const entry of entries) {
      try {
        const attrs = attributesOf(await lstat(join(directory.path, entry.name)));
        names.push({ filename: entry.name, longname: entry.name, attrs });
      } catch {
        // Removed between readdir and lstat.
      }
    }
    if (names.length === 0) sftp.status(requestId, STATUS.EOF);
    else sftp.name(requestId, names);
  });

  handle("MKDIR", async (requestId, path: string) => {
    await mkdir(path);
    sftp.status(requestId, STATUS.OK);
  });

  handle("RMDIR", async (requestId, path: string) => {
    await rmdir(path);
    sftp.status(requestId, STATUS.OK);
  });

  handle("REMOVE", async (requestId, path: string) => {
    await unlink(path);
    sftp.status(requestId, STATUS.OK);
  });

  // OpenSSH: link + unlink, so an existing target makes the rename fail.
  handle("RENAME", async (requestId, from: string, to: string) => {
    await link(from, to);
    await unlink(from);
    sftp.status(requestId, STATUS.OK);
  });

  handle("REALPATH", async (requestId, path: string) => {
    const attrs = attributesOf(await stat("."));
    sftp.name(requestId, [{ filename: resolve(path), longname: resolve(path), attrs }]);
  });

  handle("SETSTAT", async (requestId) => sftp.status(requestId, STATUS.OK));
  handle("FSETSTAT", async (requestId) => sftp.status(requestId, STATUS.OK));
  // posix-rename@openssh.com: rename(2), which atomically replaces the target.
  handle("EXTENDED", async (requestId, name: string, data: Buffer | undefined) => {
    if (name !== "posix-rename@openssh.com" || !data) {
      sftp.status(requestId, STATUS.OP_UNSUPPORTED);
      return;
    }
    const fromLength = data.readUInt32BE(0);
    const from = data.toString("utf8", 4, 4 + fromLength);
    const toLength = data.readUInt32BE(4 + fromLength);
    const to = data.toString("utf8", 8 + fromLength, 8 + fromLength + toLength);
    await rename(from, to);
    counters.posixRenames++;
    sftp.status(requestId, STATUS.OK);
  });
}

/** The client-side SFTP class, reached through ssh2's internals for the simulation below. */
interface ClientSftpPrototype {
  ext_openssh_rename(this: { _extensions: Record<string, string> }, ...args: unknown[]): void;
}

/**
 * Makes ssh2 SFTP clients in this process call `posix-rename@openssh.com` as if
 * the server had advertised it (the test server does handle it). Returns a
 * function that restores the original behaviour.
 */
export function simulatePosixRenameSupport(): () => void {
  const internals: { SFTP: { prototype: ClientSftpPrototype } } = createRequire(import.meta.url)(
    "ssh2/lib/protocol/SFTP.js",
  );
  const prototype = internals.SFTP.prototype;
  const original = prototype.ext_openssh_rename;
  prototype.ext_openssh_rename = function patched(...args) {
    this._extensions["posix-rename@openssh.com"] = "1";
    original.apply(this, args);
  };
  return () => {
    prototype.ext_openssh_rename = original;
  };
}
