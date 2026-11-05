/**
 * Tests for OneDrive token rotation: the encrypted token state file, and the behaviour
 * over months of nightly runs under a simulated clock. The fake identity platform
 * expires refresh tokens 90 days after issue on the same clock, as Microsoft does.
 *
 * Each "run" builds a fresh adapter, as a new GitHub Actions job would, with the same
 * secret and (when rotation is persisted) the same state file.
 */

import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type FakeOneDriveServer,
  startFakeOneDriveServer,
} from "../../test/helpers/fake-onedrive-server.ts";
import { isMongoShieldError } from "../errors.ts";
import { onedriveStorage } from "./onedrive.ts";
import { encodeOneDriveSecret } from "./onedrive-auth.ts";
import {
  decryptTokenState,
  encryptTokenState,
  readTokenState,
  writeTokenState,
} from "./onedrive-token-state.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
const START = new Date("2026-11-05T03:00:00Z");

describe("OneDrive token rotation", () => {
  let server: FakeOneDriveServer;
  let clock: Date;
  let directory: string;

  beforeEach(async () => {
    clock = START;
    server = await startFakeOneDriveServer({ now: () => clock });
    directory = await mkdtemp(join(tmpdir(), "onedrive-state-"));
  });

  afterEach(async () => {
    await server.close();
    await rm(directory, { recursive: true, force: true });
  });

  /** Moves the simulated clock to `days` after the start. */
  function setDay(days: number): void {
    clock = new Date(START.getTime() + days * DAY_MS);
  }

  /** One nightly run: a fresh adapter writes a backup-sized object and lists it. */
  async function nightlyRun(secret: string, statePath?: string) {
    const storage = onedriveStorage({
      folder: "backups",
      token: secret,
      graphUrl: server.graphUrl,
      authorityUrl: server.authorityUrl,
      now: () => clock,
      ...(statePath === undefined ? {} : { tokenStatePath: statePath }),
    });
    const key = `run-${clock.toISOString().slice(0, 10)}.bin`;
    await storage.put(key, Buffer.from("backup"));
    const keys: string[] = [];
    for await (const info of storage.list("")) keys.push(info.key);
    expect(keys).toContain(key);
    return storage.warnings();
  }

  it("keeps backups working past day 90 when the rotated token is persisted", async () => {
    const secret = server.secret();
    const statePath = join(directory, "token-state.json");
    const tokensSeen = new Set<string>();
    // Runs at most 70 days apart: each rotated token has its own 90 days.
    for (const day of [0, 1, 30, 60, 75, 89, 90, 91, 120, 179, 180, 250, 320, 365]) {
      setDay(day);
      const warnings = await nightlyRun(secret, statePath);
      expect(warnings, `day ${day}`).toEqual([]);
      const state = await readTokenState(statePath, secret);
      expect(state?.issuedAt).toEqual(clock);
      tokensSeen.add(state?.refreshToken ?? "");
    }
    // Every run rotated the token and saved the new one.
    expect(tokensSeen.size).toBe(14);
  });

  it("warns from day 75 and fails from day 90 when rotation is not persisted", async () => {
    const secret = server.secret();
    setDay(74);
    expect(await nightlyRun(secret)).toEqual([]);

    setDay(75);
    const warnings = await nightlyRun(secret);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/is 75 days old/);
    expect(warnings[0]).toMatch(/2027-02-03/);
    expect(warnings[0]).toMatch(/MONGOSHIELD_ONEDRIVE_TOKEN_STATE/);
    expect(warnings[0]).toMatch(/login onedrive/);

    setDay(89);
    expect(await nightlyRun(secret)).toHaveLength(1);

    setDay(90);
    const error = await nightlyRun(secret).then(
      () => undefined,
      (reason: unknown) => reason,
    );
    expect(isMongoShieldError(error, "MS_STORAGE_FORBIDDEN")).toBe(true);
    expect(isMongoShieldError(error) ? error.hint : "").toMatch(/login onedrive/);
  });

  it("warns that the state is not carried over when every run starts without it", async () => {
    const secret = server.secret();
    setDay(80);
    // A state path that is new every run: the cache never restores anything.
    const warnings = await nightlyRun(secret, join(directory, "run-80", "state.json"));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/not being carried over/);
  });

  it("falls back to the secret when the saved token is refused, then saves the new one", async () => {
    const secret = server.secret();
    const statePath = join(directory, "state.json");
    // A state that decrypts but whose token Microsoft no longer accepts.
    await writeTokenState(statePath, secret, { refreshToken: "rt-revoked", issuedAt: clock });
    expect(await nightlyRun(secret, statePath)).toEqual([]);
    expect((await readTokenState(statePath, secret))?.refreshToken).not.toBe("rt-revoked");
  });

  it("starts from a new secret after a new login, ignoring the old state", async () => {
    const statePath = join(directory, "state.json");
    setDay(0);
    await nightlyRun(server.secret(), statePath);
    setDay(100);
    const newSecret = server.secret();
    expect(await nightlyRun(newSecret, statePath)).toEqual([]);
    expect(await readTokenState(statePath, newSecret)).toBeDefined();
  });

  it("reports a state file that cannot be saved, and keeps working", async () => {
    const blocker = join(directory, "a-file");
    await writeFile(blocker, "not a folder");
    const warnings = await nightlyRun(server.secret(), join(blocker, "state.json"));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/could not be saved/);
  });

  it("refreshes once for many concurrent requests", async () => {
    const storage = onedriveStorage({
      folder: "backups",
      token: server.secret(),
      graphUrl: server.graphUrl,
      authorityUrl: server.authorityUrl,
      now: () => clock,
    });
    await Promise.all(Array.from({ length: 10 }, (_, index) => storage.head(`k${index}`)));
    expect(server.stats.refreshes).toBe(1);
  });

  it("refreshes the access token when it expires during a long run", async () => {
    const storage = onedriveStorage({
      folder: "backups",
      token: server.secret(),
      graphUrl: server.graphUrl,
      authorityUrl: server.authorityUrl,
      now: () => clock,
    });
    await storage.head("a");
    clock = new Date(clock.getTime() + 2 * 60 * 60 * 1000);
    await storage.head("b");
    expect(server.stats.refreshes).toBe(2);
  });

  it("does not warn about a bare token, whose issue time is unknown", async () => {
    const bare = encodeOneDriveSecret({
      refreshToken: server.issueRefreshToken(),
      clientId: server.clientId,
    });
    setDay(80);
    expect(await nightlyRun(bare)).toEqual([]);
  });

  describe("the state file", () => {
    it("is encrypted: the token is not in the file, and another secret cannot read it", async () => {
      const path = join(directory, "state.json");
      const state = {
        refreshToken: "rt-very-secret-token",
        issuedAt: START,
        originalIssuedAt: START,
      };
      await writeTokenState(path, "secret-one", state);
      const text = await readFile(path, "utf8");
      expect(text).not.toContain("rt-very-secret-token");
      expect(await readTokenState(path, "secret-one")).toEqual(state);
      expect(await readTokenState(path, "secret-two")).toBeUndefined();
    });

    it("rejects a tampered file", () => {
      const text = encryptTokenState({ refreshToken: "rt-x", issuedAt: START }, "secret");
      const envelope = JSON.parse(text) as { ciphertext: string };
      const bytes = Buffer.from(envelope.ciphertext, "base64");
      bytes[0] = (bytes[0] ?? 0) ^ 1;
      const tampered = JSON.stringify({ ...envelope, ciphertext: bytes.toString("base64") });
      expect(decryptTokenState(tampered, "secret")).toBeUndefined();
    });

    it.skipIf(process.platform === "win32")("is written with mode 0600", async () => {
      const path = join(directory, "nested", "state.json");
      await writeTokenState(path, "secret", { refreshToken: "rt-x", issuedAt: START });
      expect((await stat(path)).mode & 0o777).toBe(0o600);
    });

    it("treats a missing file as no state, and refuses to use someone else's file", async () => {
      expect(await readTokenState(join(directory, "missing.json"), "secret")).toBeUndefined();
      const other = join(directory, "package.json");
      await writeFile(other, '{"name":"not-a-state-file"}');
      await expect(readTokenState(other, "secret")).rejects.toThrow(
        /not a MongoShield OneDrive token state/,
      );
    });
  });
});
