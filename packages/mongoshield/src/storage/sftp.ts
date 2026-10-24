/**
 * SFTP storage adapter (entry point `mongoshield/storage/sftp`).
 *
 * Stores every object as a regular file under one directory on an SSH server,
 * like the file adapter does locally: `backups/<id>/manifest.json` becomes
 * `<path>/backups/<id>/manifest.json`.
 *
 *   import { sftpStorage } from "mongoshield/storage/sftp";
 *   const storage = sftpStorage({
 *     host: "backup.example.com",
 *     username: "mongoshield",
 *     privateKeyPath: "/run/secrets/backup_ed25519",
 *     // `ssh-keygen -lf <(ssh-keyscan backup.example.com)` prints it; verify it out of band.
 *     hostFingerprint: "SHA256:k3S1xS1v8bM0gYp4m7bJ1rQ6yQ0b0v8vXr5Y2rVwA6c",
 *     path: "/srv/backups/mongo",
 *   });
 *
 * The `ssh2` package is an optional peer dependency, loaded lazily on first use:
 *
 *   npm install ssh2
 *
 * Security:
 * - Authentication is by private key (`privateKey`/`privateKeyPath`, optionally
 *   with a `passphrase`) or an SSH agent. Passwords are deliberately not supported.
 * - The server's host key is always verified, against `hostFingerprint` (the
 *   OpenSSH `SHA256:…` form) and/or an OpenSSH `known_hosts` file
 *   (`knownHostsPath`, or its contents as `knownHosts`; plain, hashed and
 *   `[host]:port` entries, see ./known-hosts.ts). A key accepted by either is
 *   trusted. Unknown hosts are refused unless you opt out with
 *   `allowUnknownHostKey: true`, which allows man-in-the-middle attacks.
 *
 * How the contract is met:
 * - One SSH connection per adapter, opened on first use and re-opened on the
 *   next call after it drops. SFTP multiplexes requests, so concurrent calls
 *   share it.
 * - Atomic writes: data goes to a hidden temp file next to the target
 *   (`.<name>.<random>.tmp`, flushed with `fsync@openssh.com` when available),
 *   which is then renamed into place, so readers never see a partial object.
 *   Overwrites use `posix-rename@openssh.com` (atomic replace). Servers without
 *   that extension get "remove old, then rename": readers may briefly see no
 *   object, but never a partial one.
 * - Conditional writes (`ifNoneMatch: "*"`) use the plain SFTP rename, which
 *   the protocol defines to fail when the target exists. OpenSSH implements it
 *   with link(2) + unlink(2), an atomic create-if-absent, so racing writers
 *   cannot both win, and the published file is already complete. Servers that
 *   silently overwrite on rename break this guarantee; with those, do not rely
 *   on storage-based locks.
 * - `list()` walks directories and sorts by UTF-8 bytes, so keys come back in
 *   the same order as from S3. Temp files are never listed.
 * - `delete()` removes empty parent directories, so `listPrefixes()` only shows
 *   "directories" that still contain objects.
 * - Ranged reads read only the requested bytes.
 *
 * Known limitation (as with the file adapter): a key cannot be both an object
 * and a "directory" (for example `a` and `a/b`). MongoShield's layout never does this.
 *
 * The ssh2 types are described locally (below) rather than imported from
 * `@types/ssh2`, so that users of this entry point need no extra type package.
 */

import { createHash, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { posix } from "node:path";
import { Readable } from "node:stream";
import { abortError, MongoShieldError, throwIfAborted } from "../errors.ts";
import { redactSecrets } from "../redact.ts";
import {
  assertValidRange,
  compareBytes,
  destroyOnAbort,
  forEachWithConcurrency,
  messageOf,
  missingPackageError,
  numberProperty,
  propertyOf,
  stringProperty,
  toBuffer,
} from "./adapter-utils.ts";
import { assertValidKey, assertValidPrefix } from "./keys.ts";
import {
  checkKnownHost,
  entriesForHost,
  expandHome,
  hostKeyAlgorithmsFor,
  type KnownHostEntry,
  type KnownHostVerdict,
  parseKnownHosts,
} from "./known-hosts.ts";
import { rejectRetention } from "./retention.ts";
import type {
  GetOptions,
  ObjectInfo,
  PutOptions,
  SignalOptions,
  StorageAdapter,
  StorageCapabilities,
} from "./types.ts";

/** Options for {@link sftpStorage}. */
export interface SftpStorageOptions {
  /** Server host name or IP address. */
  readonly host: string;
  /** SSH port (default 22). */
  readonly port?: number;
  /** Login user name. */
  readonly username: string;
  /** Private key contents (OpenSSH or PEM format). */
  readonly privateKey?: string | Uint8Array;
  /** Path to a private key file on this machine; read on each (re)connect. */
  readonly privateKeyPath?: string;
  /**
   * Authenticate with an SSH agent: its socket path, or `true` for the agent
   * in `SSH_AUTH_SOCK`. Can be combined with a private key (the key is tried first).
   */
  readonly agent?: string | true;
  /** Passphrase for an encrypted private key. Never logged. */
  readonly passphrase?: string;
  /**
   * The server's host key fingerprint(s) in OpenSSH form, `SHA256:<base64>`
   * (the `SHA256:` prefix is optional). Strongly recommended: connections to a
   * host presenting any other key are refused. Several values allow key rotation.
   */
  readonly hostFingerprint?: string | readonly string[];
  /**
   * Path to an OpenSSH `known_hosts` file, e.g. `~/.ssh/known_hosts` (a leading
   * `~/` means the home directory). Read on each (re)connect. The server must
   * present a key listed for `host` (or `[host]:port` on other ports); a host
   * listed with other keys, or a `@revoked` key, is refused. An alternative to
   * `hostFingerprint`; both may be given.
   */
  readonly knownHostsPath?: string;
  /** The contents of a `known_hosts` file, instead of `knownHostsPath`. */
  readonly knownHosts?: string;
  /**
   * Accept any host key when neither `hostFingerprint` nor known hosts are given. Dangerous: anyone
   * who can intercept the connection can read and replace your backups. Only
   * for throwaway test setups.
   */
  readonly allowUnknownHostKey?: boolean;
  /**
   * Root directory for all objects on the server. Absolute (`/srv/backups`) or
   * relative to the login directory (`backups`). Created on the first write.
   */
  readonly path: string;
  /** How long to wait for the SSH handshake, in milliseconds (default 20,000). */
  readonly readyTimeoutMs?: number;
  /** Interval for SSH keep-alive messages, in milliseconds (default 15,000; 0 disables). */
  readonly keepaliveIntervalMs?: number;
}

/** The subset of an `ssh2` `Stats` object this adapter reads. */
interface SftpStats {
  readonly size: number;
  /** Modification time in whole seconds since the epoch. */
  readonly mtime: number;
  readonly mode: number;
}

/** One entry returned by `readdir` ("." and ".." are already filtered out by ssh2). */
interface SftpDirectoryEntry {
  readonly filename: string;
  readonly attrs: SftpStats;
}

type Callback = (error: Error | null | undefined) => void;
type ValueCallback<T> = (error: Error | null | undefined, value: T) => void;

/** The subset of ssh2's `SFTPWrapper` this adapter uses. */
interface SftpSession {
  open(path: string, flags: string, callback: ValueCallback<Buffer>): void;
  close(handle: Buffer, callback: Callback): void;
  read(
    handle: Buffer,
    buffer: Buffer,
    offset: number,
    length: number,
    position: number,
    callback: ValueCallback<number>,
  ): void;
  write(
    handle: Buffer,
    buffer: Buffer,
    offset: number,
    length: number,
    position: number,
    callback: Callback,
  ): void;
  fstat(handle: Buffer, callback: ValueCallback<SftpStats>): void;
  stat(path: string, callback: ValueCallback<SftpStats>): void;
  readdir(path: string, callback: ValueCallback<SftpDirectoryEntry[]>): void;
  mkdir(path: string, callback: Callback): void;
  rmdir(path: string, callback: Callback): void;
  unlink(path: string, callback: Callback): void;
  rename(from: string, to: string, callback: Callback): void;
  on(event: "close", listener: () => void): unknown;
  /** Throws synchronously when the server does not advertise the extension. */
  ext_openssh_rename(from: string, to: string, callback: Callback): void;
  /** Throws synchronously when the server does not advertise the extension. */
  ext_openssh_fsync(handle: Buffer, callback: Callback): void;
  end(): void;
}

/** The ssh2 `connect()` options this adapter sets. */
interface SshConnectConfig {
  host: string;
  port: number;
  username: string;
  privateKey?: Buffer | string;
  passphrase?: string;
  agent?: string;
  hostVerifier: (key: Buffer) => boolean;
  readyTimeout: number;
  keepaliveInterval: number;
  /**
   * Algorithm preferences. ssh2 applies the operations of an object in key order,
   * so `{ remove, prepend }` moves the listed algorithms to the front.
   */
  algorithms?: {
    serverHostKey: { remove: readonly string[]; prepend: readonly string[] };
  };
}

/** The subset of ssh2's `Client` this adapter uses. */
interface SshClient {
  on(event: "ready" | "close" | "end", listener: () => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
  connect(config: SshConnectConfig): void;
  sftp(callback: ValueCallback<SftpSession>): void;
  end(): void;
}

/** The parts of the `ssh2` module this adapter uses. */
interface Ssh2Module {
  readonly Client: new () => SshClient;
}

/** An open connection: the SSH client and its SFTP channel. */
interface Connection {
  readonly client: SshClient;
  readonly sftp: SftpSession;
}

/** SFTP v3 status codes (draft-ietf-secsh-filexfer-02, section 7). */
const SFTP_STATUS = {
  OK: 0,
  EOF: 1,
  NO_SUCH_FILE: 2,
  PERMISSION_DENIED: 3,
  FAILURE: 4,
  BAD_MESSAGE: 5,
  NO_CONNECTION: 6,
  CONNECTION_LOST: 7,
  OP_UNSUPPORTED: 8,
} as const;

const CAPABILITIES: StorageCapabilities = {
  conditionalWrites: true,
  rangeReads: true,
  objectLock: false,
};

const DEFAULT_PORT = 22;
const DEFAULT_READY_TIMEOUT_MS = 20_000;
const DEFAULT_KEEPALIVE_MS = 15_000;
/**
 * Size of each WRITE/READ request. ssh2 splits anything larger than the
 * server's packet limit (≈32 KiB for most servers, 256 KiB for OpenSSH).
 */
const IO_CHUNK_SIZE = 64 * 1024;
/**
 * How many WRITE requests may be in flight at once. SFTP replies are matched
 * by request id, so pipelining hides the network round-trip; 16 × 64 KiB
 * keeps about 1 MiB in flight per upload.
 */
const MAX_WRITES_IN_FLIGHT = 16;
/** How many unlink requests `delete()` keeps in flight. */
const DELETE_CONCURRENCY = 8;
/** How often a put retries creating its temp file when a concurrent delete prunes the directory (as in the file adapter). */
const MAX_TEMP_OPEN_ATTEMPTS = 5;
/** Same shape as the file adapter's temp files: `.<final name>.<16 hex chars>.tmp`. */
const TEMP_FILE_PATTERN = /^\..+\.[0-9a-f]{16}\.tmp$/;
/** POSIX file type bits in `mode`. */
const S_IFMT = 0o170000;
const S_IFREG = 0o100000;
const S_IFDIR = 0o040000;

const SSH2_PACKAGE = "ssh2";
const INSTALL_HINT = "npm install ssh2";

/** What an adapter call was doing, used in error messages ("Could not read …"). */
type Operation = "read" | "write" | "stat" | "list" | "delete";

/** Creates a storage adapter that keeps objects as files on an SFTP server. */
export function sftpStorage(options: SftpStorageOptions): StorageAdapter {
  const settings = validateOptions(options);
  const { root } = settings;
  const location = locationFor(settings);

  let connection: Promise<Connection> | undefined;

  /** The shared connection, opened on first use and re-opened after it drops. */
  function connected(): Promise<Connection> {
    if (!connection) {
      const attempt = connect(settings, () => {
        // Called when this connection closes: forget it so the next call reconnects.
        if (connection === attempt) connection = undefined;
      });
      connection = attempt;
      attempt.catch(() => {
        if (connection === attempt) connection = undefined;
      });
    }
    return connection;
  }

  async function session(operation: Operation, key: string, signal?: AbortSignal) {
    try {
      return (await connected()).sftp;
    } catch (error) {
      throw fail(error, operation, key, signal);
    }
  }

  function fail(
    error: unknown,
    operation: Operation,
    key: string,
    signal?: AbortSignal,
  ): MongoShieldError {
    return sftpError(error, { operation, target: `${location}${key}`, settings, signal });
  }

  /** Maps a key to its server path. Keys are already validated against traversal. */
  function pathForKey(key: string): string {
    assertValidKey(key);
    if (TEMP_FILE_PATTERN.test(posix.basename(key))) {
      // Such a key could be written but never listed, so refuse it up front.
      throw new MongoShieldError(
        "MS_STORAGE_IO",
        `Invalid storage key "${key}": names shaped like temp files (.name.<hex>.tmp) are reserved.`,
      );
    }
    return posix.join(root, key);
  }

  /**
   * Creates `directory` and any missing parents, like `mkdir -p`. Creating a
   * directory that already exists (perhaps made by a concurrent put) is fine.
   */
  async function ensureDirectory(sftp: SftpSession, directory: string): Promise<void> {
    const existing = await statIfExists(sftp, directory);
    if (existing && isDirectory(existing)) return;
    const parent = posix.dirname(directory);
    if (parent !== directory) await ensureDirectory(sftp, parent);
    try {
      await call<void>((done) => sftp.mkdir(directory, done));
    } catch (error) {
      const now = await statIfExists(sftp, directory);
      if (!now || !isDirectory(now)) throw error;
    }
  }

  /**
   * Removes `directory` and then each parent while they are empty, stopping at
   * the root (which is never removed). rmdir refuses non-empty directories, so
   * this is safe against concurrent writers. Best effort.
   */
  async function pruneEmptyDirectories(sftp: SftpSession, directory: string): Promise<void> {
    let current = directory;
    while (current !== root && current.startsWith(root === "/" ? "/" : `${root}/`)) {
      try {
        await call<void>((done) => sftp.rmdir(current, done));
      } catch (error) {
        // Already gone (a concurrent prune): keep going up. Anything else: stop.
        if (statusOf(error) !== SFTP_STATUS.NO_SUCH_FILE) return;
      }
      current = posix.dirname(current);
    }
  }

  /** Opens a fresh temp file next to `finalPath`, creating parent directories as needed. */
  async function openTempFile(
    sftp: SftpSession,
    finalPath: string,
  ): Promise<{ path: string; handle: Buffer }> {
    const directory = posix.dirname(finalPath);
    for (let attempt = 1; ; attempt++) {
      await ensureDirectory(sftp, directory);
      const path = posix.join(directory, tempNameFor(finalPath));
      try {
        // "wx" = create exclusively, so two writers can never share a temp file.
        return { path, handle: await call<Buffer>((done) => sftp.open(path, "wx", done)) };
      } catch (error) {
        const raced = statusOf(error) === SFTP_STATUS.NO_SUCH_FILE;
        if (!raced || attempt >= MAX_TEMP_OPEN_ATTEMPTS) throw error;
      }
    }
  }

  /**
   * Moves a finished temp file into place; see the header comment for the
   * semantics. `ifNoneMatch` uses the plain rename, which refuses to overwrite.
   */
  async function publishTempFile(
    sftp: SftpSession,
    tempPath: string,
    finalPath: string,
    key: string,
    ifNoneMatch: boolean,
  ): Promise<void> {
    if (ifNoneMatch) {
      // Cheap early answer; the rename below is what actually guarantees it.
      if (await statIfExists(sftp, finalPath)) throw alreadyExists(key);
      try {
        await call<void>((done) => sftp.rename(tempPath, finalPath, done));
      } catch (error) {
        if (await statIfExists(sftp, finalPath)) throw alreadyExists(key, error);
        throw error;
      }
      return;
    }
    if (await posixRename(sftp, tempPath, finalPath)) return;
    // No atomic replace on this server: plain rename refuses to overwrite, so
    // remove the old object first. Retry in case a concurrent writer recreates it.
    for (let attempt = 1; ; attempt++) {
      try {
        await call<void>((done) => sftp.rename(tempPath, finalPath, done));
        return;
      } catch (error) {
        if (attempt >= 3 || !(await statIfExists(sftp, finalPath))) throw error;
        await unlinkIfExists(sftp, finalPath);
      }
    }
  }

  function alreadyExists(key: string, cause?: unknown): MongoShieldError {
    return new MongoShieldError(
      "MS_STORAGE_PRECONDITION_FAILED",
      `${location}${key} already exists.`,
      cause === undefined ? {} : { cause },
    );
  }

  /**
   * Writes the body into a new temp file next to `finalPath` and closes it.
   * On failure the temp file is removed again. Returns its path, the byte
   * count and its stats (rename keeps the inode, so they become the object's).
   */
  async function writeTempFile(
    sftp: SftpSession,
    finalPath: string,
    body: Readable | Uint8Array,
    signal: AbortSignal | undefined,
  ): Promise<{ path: string; size: number; stats: SftpStats }> {
    const temp = await openTempFile(sftp, finalPath);
    let handleOpen = true;
    try {
      const size = await writeBody(sftp, temp.handle, body, signal);
      await fsyncIfSupported(sftp, temp.handle);
      const stats = await call<SftpStats>((done) => sftp.fstat(temp.handle, done));
      handleOpen = false;
      await closeHandle(sftp, temp.handle);
      return { path: temp.path, size, stats };
    } catch (error) {
      if (handleOpen) await closeHandle(sftp, temp.handle).catch(() => {});
      await unlinkIfExists(sftp, temp.path).catch(() => {});
      throw error;
    }
  }

  async function put(
    key: string,
    body: Readable | Uint8Array,
    putOptions: PutOptions = {},
  ): Promise<ObjectInfo> {
    const finalPath = pathForKey(key);
    const { signal } = putOptions;
    throwIfAborted(signal);
    // SFTP servers have no write-once retention (anyone with the login can delete),
    // so a retained put is refused before the body is read. See ./retention.ts.
    rejectRetention(putOptions, body, "sftp", location);
    // Destroying the body also interrupts a source that is stalled waiting for data.
    if (body instanceof Readable) destroyOnAbort(body, signal);

    let sftp: SftpSession;
    try {
      sftp = await session("write", key, signal);
    } catch (error) {
      if (body instanceof Readable) body.destroy();
      throw error;
    }
    let tempPath: string | undefined;
    try {
      const temp = await writeTempFile(sftp, finalPath, body, signal);
      tempPath = temp.path;
      throwIfAborted(signal);
      await publishTempFile(sftp, temp.path, finalPath, key, putOptions.ifNoneMatch === "*");
      tempPath = undefined;
      return { key, size: temp.size, lastModified: new Date(temp.stats.mtime * 1000) };
    } catch (error) {
      // Make sure an upstream pipeline does not wait forever on a stream we gave up on.
      if (body instanceof Readable) body.destroy();
      if (tempPath !== undefined) await unlinkIfExists(sftp, tempPath).catch(() => {});
      // A failed write must not leave the directories it created behind.
      await pruneEmptyDirectories(sftp, posix.dirname(finalPath));
      throw fail(error, "write", key, signal);
    }
  }

  async function get(key: string, getOptions: GetOptions = {}): Promise<Readable> {
    const path = pathForKey(key);
    const { signal, range } = getOptions;
    throwIfAborted(signal);
    if (range) assertValidRange(range, key);
    const sftp = await session("read", key, signal);

    // Open eagerly so a missing object is reported here as MS_STORAGE_NOT_FOUND
    // rather than later as an error event on the stream.
    let handle: Buffer;
    try {
      handle = await call<Buffer>((done) => sftp.open(path, "r", done));
    } catch (error) {
      throw fail(error, "read", key, signal);
    }
    try {
      const stats = await call<SftpStats>((done) => sftp.fstat(handle, done));
      if (!isRegularFile(stats)) throw notAFile();
      throwIfAborted(signal);
    } catch (error) {
      await closeHandle(sftp, handle).catch(() => {});
      throw fail(error, "read", key, signal);
    }
    const stream = new SftpReadStream(sftp, handle, range?.start ?? 0, range?.end);
    destroyOnAbort(stream, signal);
    return stream;
  }

  async function head(key: string, headOptions: SignalOptions = {}) {
    const path = pathForKey(key);
    const { signal } = headOptions;
    throwIfAborted(signal);
    const sftp = await session("stat", key, signal);
    try {
      const stats = await statIfExists(sftp, path);
      throwIfAborted(signal);
      return stats && isRegularFile(stats) ? objectInfo(key, stats) : undefined;
    } catch (error) {
      throw fail(error, "stat", key, signal);
    }
  }

  /**
   * Reads a directory and sorts its entries so that a depth-first walk yields
   * keys in byte order. Directories sort as `name/`, because every key below
   * them starts with `name/` (see the file adapter for the worked example).
   * A missing directory is simply empty.
   */
  async function readDirectorySorted(
    sftp: SftpSession,
    directoryKey: string,
    signal: AbortSignal | undefined,
  ): Promise<SftpDirectoryEntry[]> {
    throwIfAborted(signal);
    let entries: SftpDirectoryEntry[];
    try {
      entries = await call<SftpDirectoryEntry[]>((done) =>
        sftp.readdir(posix.join(root, directoryKey), done),
      );
    } catch (error) {
      if (statusOf(error) === SFTP_STATUS.NO_SUCH_FILE) return [];
      throw fail(error, "list", directoryKey, signal);
    }
    const sortName = (entry: SftpDirectoryEntry) =>
      isDirectory(entry.attrs) ? `${entry.filename}/` : entry.filename;
    return entries
      .filter((entry) => entry.filename !== "." && entry.filename !== "..")
      .sort((left, right) => compareBytes(sortName(left), sortName(right)));
  }

  /**
   * Yields every object under `directoryKey` in key order. Only entries whose
   * name starts with `namePrefix` are considered at this level; that is how a
   * prefix ending in a partial name (`backups/2026-0`) is handled.
   */
  async function* walk(
    sftp: SftpSession,
    directoryKey: string,
    namePrefix: string,
    signal: AbortSignal | undefined,
  ): AsyncGenerator<ObjectInfo> {
    for (const entry of await readDirectorySorted(sftp, directoryKey, signal)) {
      throwIfAborted(signal);
      if (!entry.filename.startsWith(namePrefix)) continue;
      const key = directoryKey + entry.filename;
      if (isDirectory(entry.attrs)) {
        yield* walk(sftp, `${key}/`, "", signal);
      } else if (isRegularFile(entry.attrs) && !TEMP_FILE_PATTERN.test(entry.filename)) {
        // Symlinks and other special files are not objects and are never followed.
        yield objectInfo(key, entry.attrs);
      }
    }
  }

  async function* list(prefix: string, listOptions: SignalOptions = {}) {
    assertValidPrefix(prefix);
    const { signal } = listOptions;
    throwIfAborted(signal);
    const sftp = await session("list", prefix, signal);
    const directoryKey = directoryKeyOf(prefix);
    yield* walk(sftp, directoryKey, prefix.slice(directoryKey.length), signal);
  }

  /** True if the directory (recursively) holds at least one object. Stops at the first one. */
  async function containsObject(
    sftp: SftpSession,
    directoryKey: string,
    signal: AbortSignal | undefined,
  ): Promise<boolean> {
    const entries = await readDirectorySorted(sftp, directoryKey, signal);
    for (const entry of entries) {
      if (isRegularFile(entry.attrs) && !TEMP_FILE_PATTERN.test(entry.filename)) return true;
    }
    for (const entry of entries) {
      const nested = `${directoryKey}${entry.filename}/`;
      if (isDirectory(entry.attrs) && (await containsObject(sftp, nested, signal))) return true;
    }
    return false;
  }

  async function* listPrefixes(prefix: string, listOptions: SignalOptions = {}) {
    assertValidPrefix(prefix);
    const { signal } = listOptions;
    throwIfAborted(signal);
    const sftp = await session("list", prefix, signal);
    const directoryKey = directoryKeyOf(prefix);
    const namePrefix = prefix.slice(directoryKey.length);
    for (const entry of await readDirectorySorted(sftp, directoryKey, signal)) {
      throwIfAborted(signal);
      if (!isDirectory(entry.attrs) || !entry.filename.startsWith(namePrefix)) continue;
      const childKey = `${directoryKey}${entry.filename}/`;
      // Like S3, a "sub-directory" only exists while some object lives below it.
      if (await containsObject(sftp, childKey, signal)) yield childKey;
    }
  }

  async function deleteObjects(keys: readonly string[], deleteOptions: SignalOptions = {}) {
    const { signal } = deleteOptions;
    throwIfAborted(signal);
    // Validate everything first so an invalid key cannot leave a half-done delete.
    const targets = keys.map((key) => ({ key, path: pathForKey(key) }));
    if (targets.length === 0) return;
    const sftp = await session("delete", targets[0]?.key ?? "", signal);

    await forEachWithConcurrency(targets, DELETE_CONCURRENCY, async ({ key, path }) => {
      throwIfAborted(signal);
      try {
        await deleteFile(sftp, path);
      } catch (error) {
        throw fail(error, "delete", key, signal);
      }
    });
    // Deepest directories first, so a parent is only tried once its children are gone.
    const directories = [...new Set(targets.map(({ path }) => posix.dirname(path)))].sort(
      (left, right) => right.length - left.length,
    );
    for (const directory of directories) await pruneEmptyDirectories(sftp, directory);
  }

  return {
    kind: "sftp",
    location,
    capabilities: CAPABILITIES,
    put,
    get,
    head,
    list,
    listPrefixes,
    delete: deleteObjects,
    async close() {
      const pending = connection;
      connection = undefined;
      const open = await pending?.catch(() => undefined);
      if (!open) return;
      open.sftp.end();
      open.client.end();
    },
  };
}

/** Validated options with defaults applied and the agent socket resolved. */
interface SftpSettings {
  readonly host: string;
  readonly port: number;
  readonly username: string;
  readonly privateKey?: string | Uint8Array;
  readonly privateKeyPath?: string;
  readonly agent?: string;
  readonly passphrase?: string;
  /** Normalized fingerprints (base64 without `SHA256:` and padding). */
  readonly fingerprints: readonly string[];
  /** Where the known hosts come from, if configured (`path` already has `~` expanded). */
  readonly knownHosts?: { readonly path: string } | { readonly text: string };
  readonly root: string;
  readonly readyTimeoutMs: number;
  readonly keepaliveIntervalMs: number;
}

function validateOptions(options: SftpStorageOptions): SftpSettings {
  const invalid = (message: string, hint?: string) =>
    new MongoShieldError("MS_CONFIG_INVALID", message, hint === undefined ? {} : { hint });

  if (typeof options.host !== "string" || options.host.length === 0) {
    throw invalid("sftpStorage() needs a `host`.");
  }
  if (typeof options.username !== "string" || options.username.length === 0) {
    throw invalid("sftpStorage() needs a `username`.");
  }
  if (
    typeof options.path !== "string" ||
    options.path.length === 0 ||
    options.path.includes("\0")
  ) {
    throw invalid("sftpStorage() needs a `path` (the root directory on the server).");
  }
  const port = options.port ?? DEFAULT_PORT;
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw invalid(`Invalid SFTP port ${port}.`);
  }

  const agent = options.agent === true ? process.env.SSH_AUTH_SOCK : options.agent;
  if (options.agent === true && !agent) {
    throw invalid(
      "sftpStorage({ agent: true }) needs SSH_AUTH_SOCK, but it is not set.",
      "Start ssh-agent, or pass privateKeyPath.",
    );
  }
  if (options.privateKey === undefined && options.privateKeyPath === undefined && !agent) {
    throw invalid(
      "sftpStorage() needs a private key or an SSH agent to authenticate.",
      "Pass privateKeyPath, privateKey or agent: true. Password authentication is not supported.",
    );
  }

  const fingerprints = (
    typeof options.hostFingerprint === "string"
      ? [options.hostFingerprint]
      : (options.hostFingerprint ?? [])
  ).map(normalizeFingerprint);
  const knownHosts = knownHostsSource(options, invalid);
  if (fingerprints.length === 0 && !knownHosts && options.allowUnknownHostKey !== true) {
    throw invalid(
      `Refusing to connect to ${options.host} without a host key fingerprint or known_hosts file.`,
      `Get it with \`ssh-keyscan -p ${port} ${options.host} | ssh-keygen -lf -\`, verify it out of band, and pass it as hostFingerprint ("SHA256:…"), or pass knownHostsPath.`,
    );
  }

  // Normalize "/srv/backups/" → "/srv/backups" and "./backups" → "backups".
  const normalized = posix.normalize(options.path);
  const root = normalized.length > 1 ? normalized.replace(/\/+$/, "") : normalized;

  return {
    host: options.host,
    port,
    username: options.username,
    ...(options.privateKey === undefined ? {} : { privateKey: options.privateKey }),
    ...(options.privateKeyPath === undefined ? {} : { privateKeyPath: options.privateKeyPath }),
    ...(agent ? { agent } : {}),
    ...(options.passphrase === undefined ? {} : { passphrase: options.passphrase }),
    fingerprints,
    ...(knownHosts ? { knownHosts } : {}),
    root,
    readyTimeoutMs: options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS,
    keepaliveIntervalMs: options.keepaliveIntervalMs ?? DEFAULT_KEEPALIVE_MS,
  };
}

/** The configured known hosts: a file (with `~/` expanded) or literal contents. */
function knownHostsSource(
  options: SftpStorageOptions,
  invalid: (message: string, hint?: string) => MongoShieldError,
): SftpSettings["knownHosts"] {
  const { knownHostsPath, knownHosts } = options;
  if (knownHostsPath !== undefined && knownHosts !== undefined) {
    throw invalid("sftpStorage() takes knownHostsPath or knownHosts, not both.");
  }
  if (knownHosts !== undefined) return { text: knownHosts };
  if (knownHostsPath === undefined) return undefined;
  if (typeof knownHostsPath !== "string" || knownHostsPath.trim() === "") {
    throw invalid("sftpStorage() needs a non-empty knownHostsPath.");
  }
  return { path: expandHome(knownHostsPath) };
}

/** `"SHA256:abc="` and `"abc"` both become `"abc"`: OpenSSH prints base64 without padding. */
function normalizeFingerprint(fingerprint: string): string {
  const value = fingerprint
    .trim()
    .replace(/^SHA256:/i, "")
    .replace(/=+$/, "");
  if (!/^[A-Za-z0-9+/]{43}$/.test(value)) {
    throw new MongoShieldError(
      "MS_CONFIG_INVALID",
      `Invalid SSH host fingerprint "${fingerprint}".`,
      {
        hint: 'Use the SHA256 form printed by `ssh-keygen -lf`, e.g. "SHA256:k3S1xS1v8bM0…".',
      },
    );
  }
  return value;
}

/** The OpenSSH SHA256 fingerprint of a raw host key: base64 of its SHA-256, without padding. */
export function sshFingerprint(hostKey: Uint8Array): string {
  return `SHA256:${createHash("sha256").update(hostKey).digest("base64").replace(/=+$/, "")}`;
}

/** `sftp://user@host:2222/srv/backups/`; relative roots are shown as `/~/path`. */
function locationFor(settings: SftpSettings): string {
  const host = settings.host.includes(":") ? `[${settings.host}]` : settings.host;
  const port = settings.port === DEFAULT_PORT ? "" : `:${settings.port}`;
  const path = settings.root.startsWith("/") ? settings.root : `/~/${settings.root}`;
  return `sftp://${encodeURIComponent(settings.username)}@${host}${port}${path.endsWith("/") ? path : `${path}/`}`;
}

/**
 * Opens an SSH connection and its SFTP channel. `onClose` runs when the
 * connection later drops, so the adapter can reconnect on the next call.
 */
async function connect(settings: SftpSettings, onClose: () => void): Promise<Connection> {
  const ssh2 = await loadSsh2();
  const privateKey =
    settings.privateKeyPath === undefined
      ? settings.privateKey
      : await readPrivateKey(settings.privateKeyPath);
  const knownHosts = await loadKnownHosts(settings);
  const verifier = hostKeyVerifier(settings, knownHosts);

  return new Promise<Connection>((resolve, reject) => {
    const client = new ssh2.Client();
    let ready = false;

    client.on("error", (error) => {
      if (ready) return; // later errors also end in "close", which triggers a reconnect
      // A refused host key is reported with what was presented and why it was refused.
      const rejection = verifier.rejection();
      reject(
        rejection === undefined ? error : Object.assign(error, { hostKeyRejection: rejection }),
      );
    });
    client.on("close", () => {
      if (!ready) reject(new Error("The SSH connection closed during the handshake."));
      onClose();
    });
    client.on("ready", () => {
      client.sftp((error, sftp) => {
        if (error) {
          client.end();
          reject(error);
          return;
        }
        ready = true;
        // If only the SFTP channel goes away, drop the whole connection so the
        // next call opens a fresh one.
        sftp.on("close", () => client.end());
        resolve({ client, sftp });
      });
    });

    client.connect({
      host: settings.host,
      port: settings.port,
      username: settings.username,
      ...(privateKey === undefined ? {} : { privateKey: Buffer.from(privateKey) }),
      ...(settings.passphrase === undefined ? {} : { passphrase: settings.passphrase }),
      ...(settings.agent === undefined ? {} : { agent: settings.agent }),
      hostVerifier: verifier.verify,
      readyTimeout: settings.readyTimeoutMs,
      keepaliveInterval: settings.keepaliveIntervalMs,
      ...preferredHostKeyAlgorithms(settings, knownHosts),
    });
  });
}

/** Why a host key was refused, attached to the connection error for {@link sftpError}. */
interface HostKeyRejection {
  /** The presented key's `SHA256:…` fingerprint. */
  readonly fingerprint: string;
  /** What known_hosts said, or `fingerprint-mismatch` when only fingerprints were configured. */
  readonly reason: Exclude<KnownHostVerdict, "trusted"> | "fingerprint-mismatch";
  /** The known_hosts file consulted, for messages (`known_hosts` for literal contents). */
  readonly source?: string;
}

/**
 * The `hostVerifier` for one connection attempt, and what it refused (if anything).
 * A key is trusted when it matches a configured fingerprint or a known_hosts entry
 * for this host; a `@revoked` key is refused even if a fingerprint matches.
 */
function hostKeyVerifier(
  settings: SftpSettings,
  knownHosts: readonly KnownHostEntry[] | undefined,
): { verify: (hostKey: Buffer) => boolean; rejection: () => HostKeyRejection | undefined } {
  let rejection: HostKeyRejection | undefined;
  const source = knownHostsLabel(settings);
  const verify = (hostKey: Buffer): boolean => {
    // allowUnknownHostKey: nothing to verify against.
    if (settings.fingerprints.length === 0 && knownHosts === undefined) return true;
    // ssh2 hands us the raw host key blob; its SHA-256 is the OpenSSH fingerprint.
    const fingerprint = sshFingerprint(hostKey);
    const verdict =
      knownHosts === undefined
        ? undefined
        : checkKnownHost(knownHosts, settings.host, settings.port, hostKey);
    if (verdict === "trusted") return true;
    const fingerprintMatches = settings.fingerprints.includes(fingerprint.slice("SHA256:".length));
    if (fingerprintMatches && verdict !== "revoked") return true;
    rejection = {
      fingerprint,
      reason: verdict ?? "fingerprint-mismatch",
      ...(source === undefined ? {} : { source }),
    };
    return false;
  };
  return { verify, rejection: () => rejection };
}

/**
 * Asks the server for a host key type that known_hosts lists for it, like OpenSSH.
 * Without this, a server with ed25519 and RSA keys presents ed25519 even when
 * only its RSA key is listed, and the connection is refused.
 */
function preferredHostKeyAlgorithms(
  settings: SftpSettings,
  knownHosts: readonly KnownHostEntry[] | undefined,
): Pick<SshConnectConfig, "algorithms"> {
  if (knownHosts === undefined) return {};
  const keyTypes = entriesForHost(knownHosts, settings.host, settings.port).map(
    (entry) => entry.keyType,
  );
  const preferred = hostKeyAlgorithmsFor(keyTypes);
  if (preferred.length === 0) return {};
  return { algorithms: { serverHostKey: { remove: preferred, prepend: preferred } } };
}

/** Reads and parses the configured known hosts; `undefined` when none are configured. */
async function loadKnownHosts(settings: SftpSettings): Promise<KnownHostEntry[] | undefined> {
  const source = settings.knownHosts;
  if (source === undefined) return undefined;
  if ("text" in source) return parseKnownHosts(source.text);
  try {
    return parseKnownHosts(await readFile(source.path, "utf8"));
  } catch (error) {
    throw new MongoShieldError(
      "MS_CONFIG_INVALID",
      `Could not read the known_hosts file ${source.path}.`,
      {
        cause: error,
        hint: `Create it with \`ssh-keyscan -p ${settings.port} ${settings.host} >> ${source.path}\` after verifying the fingerprints out of band, or set knownHostsPath (MONGOSHIELD_SFTP_KNOWN_HOSTS) or hostFingerprint.`,
      },
    );
  }
}

/** The known_hosts file named in messages, if known hosts are configured. */
function knownHostsLabel(settings: SftpSettings): string | undefined {
  const source = settings.knownHosts;
  if (source === undefined) return undefined;
  return "path" in source ? source.path : "known_hosts";
}

/**
 * Loads `ssh2` lazily. The specifier is a variable on purpose: `ssh2` ships no
 * type declarations, and this keeps TypeScript from requiring `@types/ssh2`;
 * the module is checked at runtime and described by the interfaces above.
 */
async function loadSsh2(): Promise<Ssh2Module> {
  let loaded: unknown;
  try {
    loaded = await import(SSH2_PACKAGE);
  } catch (error) {
    throw missingPackageError(error, "SFTP storage", INSTALL_HINT);
  }
  // ssh2 is CommonJS; depending on the loader its exports sit on the namespace or on `default`.
  for (const candidate of [loaded, propertyOf(loaded, "default")]) {
    if (typeof propertyOf(candidate, "Client") === "function") return candidate as Ssh2Module;
  }
  throw new MongoShieldError(
    "MS_CONFIG_INVALID",
    "The installed ssh2 package has no Client export.",
    {
      hint: "Install ssh2 version 1.x: npm install ssh2@1",
    },
  );
}

async function readPrivateKey(path: string): Promise<Buffer> {
  try {
    return await readFile(path);
  } catch (error) {
    throw new MongoShieldError(
      "MS_CONFIG_INVALID",
      `Could not read the SSH private key file ${path}.`,
      {
        cause: error,
        hint: "Check privateKeyPath (or MONGOSHIELD_SFTP_KEY_FILE) and the file's permissions.",
      },
    );
  }
}

/** Turns a callback-style ssh2 call into a promise. Synchronous throws become rejections. */
function call<T>(start: (done: ValueCallback<T>) => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    try {
      start((error, value) => (error ? reject(error) : resolve(value)));
    } catch (error) {
      reject(error);
    }
  });
}

function closeHandle(sftp: SftpSession, handle: Buffer): Promise<void> {
  return call<void>((done) => sftp.close(handle, done));
}

/**
 * Streams the body into an open file handle, keeping up to
 * {@link MAX_WRITES_IN_FLIGHT} WRITE requests outstanding. Each request
 * carries its own absolute offset, so they may complete in any order.
 * Returns the number of bytes written.
 */
async function writeBody(
  sftp: SftpSession,
  handle: Buffer,
  body: Readable | Uint8Array,
  signal: AbortSignal | undefined,
): Promise<number> {
  const source: AsyncIterable<unknown> | Iterable<unknown> =
    body instanceof Readable ? body : [toBuffer(body)];
  const inFlight: Promise<void>[] = [];
  // Recorded instead of rejecting, so a failed write never becomes an unhandled rejection.
  let failure: { error: unknown } | undefined;
  let position = 0;

  for await (const piece of source) {
    const buffer = toBuffer(piece);
    for (let offset = 0; offset < buffer.length; offset += IO_CHUNK_SIZE) {
      throwIfAborted(signal);
      if (failure) throw failure.error;
      const slice = buffer.subarray(offset, offset + IO_CHUNK_SIZE);
      const at = position;
      position += slice.length;
      inFlight.push(
        call<void>((done) => sftp.write(handle, slice, 0, slice.length, at, done)).catch(
          (error: unknown) => {
            failure ??= { error };
          },
        ),
      );
      // Backpressure: wait for the oldest request before sending more.
      if (inFlight.length >= MAX_WRITES_IN_FLIGHT) await inFlight.shift();
    }
  }
  await Promise.all(inFlight);
  if (failure) throw failure.error;
  return position;
}

/**
 * Flushes the file to disk before it is published, so a server crash cannot
 * leave a complete-looking but truncated object. Needs the OpenSSH
 * `fsync@openssh.com` extension; without it, durability is up to the server.
 */
async function fsyncIfSupported(sftp: SftpSession, handle: Buffer): Promise<void> {
  try {
    await call<void>((done) => sftp.ext_openssh_fsync(handle, done));
  } catch (error) {
    if (!isUnsupported(error)) throw error;
  }
}

/**
 * Atomically replaces `to` with `from` using `posix-rename@openssh.com`.
 * Returns `false` if the server does not support the extension.
 */
async function posixRename(sftp: SftpSession, from: string, to: string): Promise<boolean> {
  try {
    await call<void>((done) => sftp.ext_openssh_rename(from, to, done));
    return true;
  } catch (error) {
    if (isUnsupported(error)) return false;
    throw error;
  }
}

/** ssh2 throws "Server does not support this extended request"; servers may answer OP_UNSUPPORTED. */
function isUnsupported(error: unknown): boolean {
  return (
    statusOf(error) === SFTP_STATUS.OP_UNSUPPORTED ||
    /does not support this extended request/i.test(messageOf(error))
  );
}

async function statIfExists(sftp: SftpSession, path: string): Promise<SftpStats | undefined> {
  try {
    return await call<SftpStats>((done) => sftp.stat(path, done));
  } catch (error) {
    if (statusOf(error) === SFTP_STATUS.NO_SUCH_FILE) return undefined;
    throw error;
  }
}

async function unlinkIfExists(sftp: SftpSession, path: string): Promise<void> {
  try {
    await call<void>((done) => sftp.unlink(path, done));
  } catch (error) {
    if (statusOf(error) !== SFTP_STATUS.NO_SUCH_FILE) throw error;
  }
}

/** Unlinks an object. Missing files and directories (which are not objects) are ignored. */
async function deleteFile(sftp: SftpSession, path: string): Promise<void> {
  try {
    await unlinkIfExists(sftp, path);
  } catch (error) {
    const stats = await statIfExists(sftp, path);
    if (stats && isDirectory(stats)) return;
    throw error;
  }
}

/**
 * A readable stream over an open SFTP file handle, from `start` to `end`
 * (inclusive). Reads one chunk at a time; the handle is closed when the stream
 * ends or is destroyed.
 */
class SftpReadStream extends Readable {
  private position: number;

  constructor(
    private readonly sftp: SftpSession,
    private readonly handle: Buffer,
    start: number,
    private readonly end: number | undefined,
  ) {
    super({ highWaterMark: IO_CHUNK_SIZE });
    this.position = start;
  }

  override _read(): void {
    const remaining = this.end === undefined ? IO_CHUNK_SIZE : this.end - this.position + 1;
    if (remaining <= 0) {
      this.push(null);
      return;
    }
    const length = Math.min(IO_CHUNK_SIZE, remaining);
    const buffer = Buffer.allocUnsafe(length);
    try {
      this.sftp.read(this.handle, buffer, 0, length, this.position, (error, bytesRead) => {
        if (error) {
          this.destroy(error);
        } else if (bytesRead === 0) {
          this.push(null); // end of file
        } else {
          this.position += bytesRead;
          this.push(buffer.subarray(0, bytesRead));
        }
      });
    } catch (error) {
      // ssh2 throws synchronously when the channel is already closed.
      this.destroy(error instanceof Error ? error : new Error(String(error)));
    }
  }

  override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    try {
      this.sftp.close(this.handle, () => callback(error));
    } catch {
      callback(error);
    }
  }
}

function isRegularFile(stats: SftpStats): boolean {
  return (stats.mode & S_IFMT) === S_IFREG;
}

function isDirectory(stats: SftpStats): boolean {
  return (stats.mode & S_IFMT) === S_IFDIR;
}

function objectInfo(key: string, stats: SftpStats): ObjectInfo {
  return { key, size: stats.size, lastModified: new Date(stats.mtime * 1000) };
}

/** The "directory" part of a key or prefix, including the trailing slash: `a/b/c` → `a/b/`. */
function directoryKeyOf(prefix: string): string {
  return prefix.slice(0, prefix.lastIndexOf("/") + 1);
}

/** `.<name>.<random>.tmp`, unique per write so concurrent writers never collide. */
function tempNameFor(finalPath: string): string {
  return `.${posix.basename(finalPath)}.${randomBytes(8).toString("hex")}.tmp`;
}

/** A directory sitting where an object was expected is reported like a missing object. */
function notAFile(): Error {
  return Object.assign(new Error("not a regular file"), { code: SFTP_STATUS.NO_SUCH_FILE });
}

/** The SFTP status code ssh2 attaches to failed requests as a numeric `code`. */
function statusOf(error: unknown): number | undefined {
  return numberProperty(error, "code");
}

/** Reads the {@link HostKeyRejection} that `connect` attached to a handshake error. */
function hostKeyRejectionOf(error: unknown): HostKeyRejection | undefined {
  const rejection = propertyOf(error, "hostKeyRejection");
  const fingerprint = stringProperty(rejection, "fingerprint");
  const reason = stringProperty(rejection, "reason");
  if (fingerprint === undefined || reason === undefined) return undefined;
  const source = stringProperty(rejection, "source");
  const known = ["revoked", "changed", "unknown", "fingerprint-mismatch"] as const;
  const matched = known.find((candidate) => candidate === reason);
  if (matched === undefined) return undefined;
  return { fingerprint, reason: matched, ...(source === undefined ? {} : { source }) };
}

/** The error for a refused host key: what was presented, and what to do about it. */
function hostKeyError(
  rejection: HostKeyRejection,
  cause: unknown,
  context: SftpErrorContext,
): MongoShieldError {
  const { operation, target, settings } = context;
  const presented = `the server presented host key ${rejection.fingerprint}`;
  const source = rejection.source ?? "known_hosts";
  const intercepting =
    "If the server's key was rotated on purpose, verify the new fingerprint out of band and update";
  const prefix = `Could not ${operation} ${target}: ${presented}`;
  switch (rejection.reason) {
    case "revoked":
      return new MongoShieldError(
        "MS_STORAGE_FORBIDDEN",
        `${prefix}, which ${source} marks @revoked.`,
        {
          cause,
          hint: "A revoked key must never be trusted again. Ask the server's administrator for its current host key.",
        },
      );
    case "unknown": {
      const fingerprints = settings.fingerprints.length > 0 ? " or hostFingerprint" : "";
      return new MongoShieldError(
        "MS_STORAGE_FORBIDDEN",
        `${prefix}, but ${settings.host}:${settings.port} is not listed in ${source}${fingerprints}.`,
        {
          cause,
          hint: `Verify the fingerprint out of band, then add the host: \`ssh-keyscan -p ${settings.port} ${settings.host} >> ${source}\` (or pass hostFingerprint).`,
        },
      );
    }
    case "changed":
      return new MongoShieldError(
        "MS_STORAGE_FORBIDDEN",
        `${prefix}, which does not match the keys ${source} lists for ${settings.host}:${settings.port}.`,
        {
          cause,
          hint: `${intercepting} ${source}. Otherwise someone may be intercepting the connection.`,
        },
      );
    case "fingerprint-mismatch":
      return new MongoShieldError(
        "MS_STORAGE_FORBIDDEN",
        `${prefix}, which does not match hostFingerprint.`,
        {
          cause,
          hint: `${intercepting} hostFingerprint. Otherwise someone may be intercepting the connection.`,
        },
      );
  }
}

/** Context for {@link sftpError}. */
interface SftpErrorContext {
  readonly operation: Operation;
  readonly target: string;
  readonly settings: SftpSettings;
  readonly signal?: AbortSignal | undefined;
}

/**
 * Maps an ssh2 error to a `MongoShieldError`. Request failures carry an SFTP
 * status code: NO_SUCH_FILE → NOT_FOUND, PERMISSION_DENIED → FORBIDDEN,
 * everything else → IO. Connection failures carry an ssh2 `level`
 * (`client-authentication`, `client-timeout`, …) or a socket `code`
 * (`ECONNREFUSED`, …). Secrets are scrubbed from messages.
 */
function sftpError(error: unknown, context: SftpErrorContext): MongoShieldError {
  const { operation, target, settings, signal } = context;
  if (signal?.aborted) return abortError(signal);
  if (error instanceof MongoShieldError) return error;

  const reason = redactSecrets(messageOf(error), [settings.passphrase]);
  const status = statusOf(error);
  const message = `Could not ${operation} ${target}: ${reason}`;
  const base = {
    cause: error,
    ...(status === undefined ? {} : { details: { sftpStatus: status } }),
  };
  const server = `${settings.host}:${settings.port}`;

  const rejection = hostKeyRejectionOf(error);
  if (rejection !== undefined) return hostKeyError(rejection, error, context);
  // ssh2 parses the key before connecting; a wrong passphrase or a malformed
  // key fails there, without ever reaching the server.
  if (/privateKey|passphrase/i.test(reason) && stringProperty(error, "level") === undefined) {
    return new MongoShieldError("MS_CONFIG_INVALID", message, {
      cause: error,
      hint: "Check the private key (OpenSSH or PEM format) and, for an encrypted key, the passphrase.",
    });
  }
  if (stringProperty(error, "level") === "client-authentication") {
    return new MongoShieldError("MS_STORAGE_FORBIDDEN", message, {
      ...base,
      hint: `Check that the public key for "${settings.username}" is in ~/.ssh/authorized_keys on ${settings.host}, and the passphrase if the key is encrypted.`,
    });
  }
  switch (status) {
    case SFTP_STATUS.NO_SUCH_FILE:
      return new MongoShieldError("MS_STORAGE_NOT_FOUND", message, base);
    case SFTP_STATUS.PERMISSION_DENIED:
      return new MongoShieldError("MS_STORAGE_FORBIDDEN", message, {
        ...base,
        hint: `Check that "${settings.username}" may read and write ${settings.root} on ${settings.host}.`,
      });
    case SFTP_STATUS.NO_CONNECTION:
    case SFTP_STATUS.CONNECTION_LOST:
      return new MongoShieldError("MS_STORAGE_IO", message, {
        ...base,
        hint: "The SSH connection dropped; the next operation reconnects.",
      });
    case SFTP_STATUS.FAILURE:
      // OpenSSH reports most errnos, including a full disk, as a bare FAILURE;
      // servers that pass strerror() through let us do better.
      if (/no space|quota/i.test(reason)) {
        return new MongoShieldError("MS_STORAGE_INSUFFICIENT_SPACE", message, {
          ...base,
          hint: `Free up space on ${settings.host}, or back up to another location.`,
        });
      }
      return new MongoShieldError("MS_STORAGE_IO", message, base);
  }
  const socketCode = stringProperty(error, "code");
  if (socketCode !== undefined || stringProperty(error, "level")?.startsWith("client-") === true) {
    return new MongoShieldError("MS_STORAGE_IO", message, {
      ...base,
      hint: `Check that ${server} is reachable and runs an SSH server with the SFTP subsystem enabled.`,
    });
  }
  return new MongoShieldError("MS_STORAGE_IO", message, base);
}
