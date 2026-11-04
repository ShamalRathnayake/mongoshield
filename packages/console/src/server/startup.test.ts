/**
 * Tests for the startup decisions main.ts makes: the listen address (dual stack with
 * an IPv4 fallback), the printed setup link, and the message for a data directory the
 * console may not write.
 */

import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { loadOrCreateSecretKey } from "../state/secret-key.ts";
import {
  canListenOnIpv6,
  DataDirAccessError,
  DUAL_STACK_HOST,
  dataDirAccessError,
  IPV4_ANY_HOST,
  listenHost,
  setupLinkBase,
} from "./startup.ts";

describe("listenHost", () => {
  it("listens on :: by default, and on 0.0.0.0 where IPv6 is unavailable", async () => {
    expect(await listenHost(undefined, async () => true)).toBe(DUAL_STACK_HOST);
    expect(await listenHost(undefined, async () => false)).toBe(IPV4_ANY_HOST);
  });

  it("uses HOST exactly as given", async () => {
    expect(await listenHost("127.0.0.1", async () => true)).toBe("127.0.0.1");
    expect(await listenHost("0.0.0.0", async () => true)).toBe("0.0.0.0");
  });

  it("probes IPv6 for real without keeping a port open", async () => {
    expect(typeof (await canListenOnIpv6())).toBe("boolean");
  });
});

describe("setupLinkBase", () => {
  it("uses MONGOSHIELD_PUBLIC_URL when set, with nothing to add", () => {
    expect(setupLinkBase("https://backups.example.com", 8080)).toEqual({
      base: "https://backups.example.com",
    });
  });

  it("otherwise uses the console's port and says that a -p mapping changes it", () => {
    const link = setupLinkBase(undefined, 8080);
    expect(link.base).toBe("http://localhost:8080");
    expect(link.note).toContain("-p 18080:8080");
    expect(link.note).toContain("MONGOSHIELD_PUBLIC_URL");
  });
});

describe("dataDirAccessError", () => {
  const user = { uid: 65532, gid: 65532 };
  const denied = (code: string) =>
    Object.assign(new Error(`${code}: permission denied, mkdir '/data/backups'`), {
      code,
      path: "/data/backups",
    });

  it("turns EACCES and EPERM into the chown command, without a stack trace", () => {
    for (const code of ["EACCES", "EPERM"]) {
      const error = dataDirAccessError(denied(code), "/data", user);
      expect(error, code).toBeInstanceOf(DataDirAccessError);
      expect(error?.message).toContain("chown -R 65532:65532");
      expect(error?.message).toContain("/data/backups");
      expect(error?.message).toContain(code);
      expect(error?.message).toContain("-v mongoshield-data:/data");
    }
  });

  it("leaves every other error alone", () => {
    expect(dataDirAccessError(new Error("boom"), "/data", user)).toBeUndefined();
    expect(
      dataDirAccessError(Object.assign(new Error("x"), { code: "ENOSPC" }), "/data", user),
    ).toBeUndefined();
    expect(dataDirAccessError("EACCES", "/data", user)).toBeUndefined();
  });

  // Root ignores file modes, so the real refusal can only be seen as another user.
  const unprivileged = process.platform !== "win32" && process.getuid?.() !== 0;
  const directories: string[] = [];
  afterAll(async () => {
    for (const directory of directories) {
      await chmod(directory, 0o700).catch(() => {});
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.runIf(unprivileged)(
    "recognises the real error from a data directory the console may not write",
    async () => {
      const parent = await mkdtemp(join(tmpdir(), "ms-readonly-"));
      directories.push(parent);
      const dataDir = join(parent, "data");
      await mkdir(dataDir);
      await chmod(dataDir, 0o500);
      const failure = await loadOrCreateSecretKey(dataDir).then(
        () => undefined,
        (error: unknown) => error,
      );
      const explained = dataDirAccessError(failure, dataDir);
      expect(explained).toBeInstanceOf(DataDirAccessError);
      expect(explained?.message).toContain("chown -R");
    },
  );
});
