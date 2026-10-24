/**
 * Tests for the generated secret (`<data>/secret.key`): created once, atomically and
 * privately; read back unchanged; and refused when it is malformed, too open, a symlink,
 * or missing next to state that was created with an operator's secret.
 */

import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadOrCreateSecretKey, SECRET_KEY_FILE, SecretKeyError } from "./secret-key.ts";
import { STATE_FILE, StateStore } from "./store.ts";

const directories: string[] = [];

async function tempDir(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "ms-secret-"));
  directories.push(directory);
  return directory;
}

afterEach(async () => {
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

/** POSIX permission checks do not apply on Windows. */
const posixOnly = process.platform === "win32" ? it.skip : it;

describe("loadOrCreateSecretKey", () => {
  posixOnly(
    "generates a 256-bit key on a fresh data directory, readable only by its owner",
    async () => {
      const dataDir = await tempDir();
      const loaded = await loadOrCreateSecretKey(dataDir);
      expect(loaded.created).toBe(true);
      expect(loaded.path).toBe(join(dataDir, SECRET_KEY_FILE));
      expect(loaded.secret).toMatch(/^[0-9a-f]{64}$/);
      expect(await readFile(loaded.path, "utf8")).toBe(`${loaded.secret}\n`);
      expect((await stat(loaded.path)).mode & 0o777).toBe(0o600);
      // No temp files are left behind.
      expect(await readdir(dataDir)).toEqual([SECRET_KEY_FILE]);
    },
  );

  it("creates the data directory when it does not exist yet", async () => {
    const dataDir = join(await tempDir(), "nested", "data");
    const loaded = await loadOrCreateSecretKey(dataDir);
    expect(loaded.created).toBe(true);
  });

  it("returns the same key on every later start", async () => {
    const dataDir = await tempDir();
    const first = await loadOrCreateSecretKey(dataDir);
    const second = await loadOrCreateSecretKey(dataDir);
    expect(second).toEqual({ ...first, created: false });
  });

  it("opens the state it was created with (end to end with the store)", async () => {
    const dataDir = await tempDir();
    const { secret } = await loadOrCreateSecretKey(dataDir);
    const store = await StateStore.open({ dataDir, secret });
    await store.close();
    const again = await loadOrCreateSecretKey(dataDir);
    const reopened = await StateStore.open({ dataDir, secret: again.secret });
    await reopened.close();
  });

  it("agrees on one key when two consoles start at the same moment", async () => {
    const dataDir = await tempDir();
    const results = await Promise.all(
      Array.from({ length: 8 }, () => loadOrCreateSecretKey(dataDir)),
    );
    const secrets = new Set(results.map((result) => result.secret));
    expect(secrets.size).toBe(1);
    expect(results.filter((result) => result.created)).toHaveLength(1);
    expect((await readdir(dataDir)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("accepts a file without the trailing newline", async () => {
    const dataDir = await tempDir();
    const secret = "ab".repeat(32);
    await writeFile(join(dataDir, SECRET_KEY_FILE), secret, { mode: 0o600 });
    expect((await loadOrCreateSecretKey(dataDir)).secret).toBe(secret);
  });

  it("refuses a truncated or edited key instead of deriving a different one", async () => {
    const dataDir = await tempDir();
    await writeFile(join(dataDir, SECRET_KEY_FILE), "abc123\n", { mode: 0o600 });
    await expect(loadOrCreateSecretKey(dataDir)).rejects.toThrow(SecretKeyError);
    await expect(loadOrCreateSecretKey(dataDir)).rejects.toThrow(/64 hex characters/);
    // The file is left as it is: it may be repairable, and it is the operator's call.
    expect(await readFile(join(dataDir, SECRET_KEY_FILE), "utf8")).toBe("abc123\n");
  });

  posixOnly("refuses a key readable by other users and says how to fix it", async () => {
    const dataDir = await tempDir();
    const path = join(dataDir, SECRET_KEY_FILE);
    await writeFile(path, `${"cd".repeat(32)}\n`, { mode: 0o600 });
    await chmod(path, 0o644);
    await expect(loadOrCreateSecretKey(dataDir)).rejects.toThrow(/mode 644.*chmod 600/s);
    await chmod(path, 0o640);
    await expect(loadOrCreateSecretKey(dataDir)).rejects.toThrow(SecretKeyError);
    await chmod(path, 0o600);
    await expect(loadOrCreateSecretKey(dataDir)).resolves.toMatchObject({ created: false });
  });

  posixOnly("refuses a symlink, which could point outside the volume", async () => {
    const dataDir = await tempDir();
    const elsewhere = join(await tempDir(), "key");
    await writeFile(elsewhere, `${"ef".repeat(32)}\n`, { mode: 0o600 });
    await symlink(elsewhere, join(dataDir, SECRET_KEY_FILE));
    await expect(loadOrCreateSecretKey(dataDir)).rejects.toThrow(/regular file/);
  });

  it("refuses a directory in its place", async () => {
    const dataDir = await tempDir();
    await mkdir(join(dataDir, SECRET_KEY_FILE));
    await expect(loadOrCreateSecretKey(dataDir)).rejects.toThrow(/regular file/);
  });

  it("never generates a key for state created with an operator's secret", async () => {
    const dataDir = await tempDir();
    const store = await StateStore.open({
      dataDir,
      secret: "operator-secret-0123456789abcdef0123",
    });
    await store.close();
    await expect(loadOrCreateSecretKey(dataDir)).rejects.toThrow(
      /created with one[\s\S]*same MONGOSHIELD_SECRET/,
    );
    expect(await readdir(dataDir)).not.toContain(SECRET_KEY_FILE);
    expect(await readdir(dataDir)).toContain(STATE_FILE);
  });
});
