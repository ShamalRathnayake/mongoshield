import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { EnvironmentError, readEnvironment } from "./config.ts";

/** Secret files for the `_FILE` variables. */
const directory = mkdtempSync(join(tmpdir(), "ms-config-"));
let fileCount = 0;
function tempFile(content: string, mode = 0o600): string {
  fileCount += 1;
  const path = join(directory, `file-${fileCount}`);
  writeFileSync(path, content, { mode });
  return path;
}
afterAll(() => rmSync(directory, { recursive: true, force: true }));

const SECRET = "0123456789abcdef0123456789abcdef";

describe("readEnvironment", () => {
  it("starts without MONGOSHIELD_SECRET, using the generated key, but refuses a short one", () => {
    const environment = readEnvironment({});
    expect(environment.secret).toBeUndefined();
    expect(environment.secretSource).toBe("generated");
    expect(() => readEnvironment({ MONGOSHIELD_SECRET: "short" })).toThrow(EnvironmentError);
    expect(() => readEnvironment({ MONGOSHIELD_SECRET: "short" })).toThrow(/at least 32/);
  });

  it("uses MONGOSHIELD_SECRET exactly as given, spaces included", () => {
    // Trimming would derive a different key for consoles that have run with it.
    const padded = ` ${SECRET} `;
    expect(readEnvironment({ MONGOSHIELD_SECRET: padded })).toMatchObject({
      secret: padded,
      secretSource: "env",
    });
  });

  it("reads the secret from MONGOSHIELD_SECRET_FILE (Docker and Kubernetes secrets)", () => {
    const file = tempFile(`${SECRET}\n`, 0o444);
    expect(readEnvironment({ MONGOSHIELD_SECRET_FILE: file })).toMatchObject({
      secret: SECRET,
      secretSource: "file",
    });
    expect(() => readEnvironment({ MONGOSHIELD_SECRET_FILE: tempFile("short\n") })).toThrow(
      /MONGOSHIELD_SECRET_FILE must hold at least 32/,
    );
    expect(() => readEnvironment({ MONGOSHIELD_SECRET_FILE: join(directory, "missing") })).toThrow(
      /cannot read .*ENOENT/,
    );
  });

  it("refuses MONGOSHIELD_SECRET and MONGOSHIELD_SECRET_FILE together", () => {
    expect(() =>
      readEnvironment({ MONGOSHIELD_SECRET: SECRET, MONGOSHIELD_SECRET_FILE: tempFile(SECRET) }),
    ).toThrow(/not both/);
  });

  it("opens a 15-minute setup window by default, configurable and off with 0", () => {
    expect(readEnvironment({}).setupWindowMs).toBe(15 * 60_000);
    expect(readEnvironment({ MONGOSHIELD_SETUP_WINDOW_MINUTES: "5" }).setupWindowMs).toBe(300_000);
    expect(readEnvironment({ MONGOSHIELD_SETUP_WINDOW_MINUTES: "0" }).setupWindowMs).toBe(0);
    for (const bad of ["-1", "1.5", "soon", "1441"]) {
      expect(() => readEnvironment({ MONGOSHIELD_SETUP_WINDOW_MINUTES: bad }), bad).toThrow(
        /MONGOSHIELD_SETUP_WINDOW_MINUTES/,
      );
    }
  });

  it("reads the admin to create from the environment, with the password inline or in a file", () => {
    expect(readEnvironment({}).initialAdmin).toBeUndefined();
    expect(
      readEnvironment({
        MONGOSHIELD_ADMIN_USERNAME: "ops",
        MONGOSHIELD_ADMIN_PASSWORD: "correct horse battery",
      }).initialAdmin,
    ).toEqual({ username: "ops", password: "correct horse battery" });
    // The email alias, and a password file whose trailing newline is not part of it.
    expect(
      readEnvironment({
        MONGOSHIELD_ADMIN_EMAIL: "ops@example.com",
        MONGOSHIELD_ADMIN_PASSWORD_FILE: tempFile("correct horse battery\n"),
      }).initialAdmin,
    ).toEqual({ username: "ops@example.com", password: "correct horse battery" });
  });

  it("refuses half or contradictory admin settings and weak passwords", () => {
    const password = "correct horse battery";
    const cases: NodeJS.ProcessEnv[] = [
      { MONGOSHIELD_ADMIN_USERNAME: "ops" },
      { MONGOSHIELD_ADMIN_PASSWORD: password },
      { MONGOSHIELD_ADMIN_USERNAME: "ops", MONGOSHIELD_ADMIN_PASSWORD: "short" },
      { MONGOSHIELD_ADMIN_USERNAME: "bad name!", MONGOSHIELD_ADMIN_PASSWORD: password },
      {
        MONGOSHIELD_ADMIN_USERNAME: "a",
        MONGOSHIELD_ADMIN_EMAIL: "b@example.com",
        MONGOSHIELD_ADMIN_PASSWORD: password,
      },
      {
        MONGOSHIELD_ADMIN_USERNAME: "ops",
        MONGOSHIELD_ADMIN_PASSWORD: password,
        MONGOSHIELD_ADMIN_PASSWORD_FILE: tempFile(password),
      },
    ];
    for (const env of cases) {
      expect(() => readEnvironment(env), JSON.stringify(Object.keys(env))).toThrow(
        EnvironmentError,
      );
    }
  });

  it("creates the default storage location unless MONGOSHIELD_DEFAULT_STORAGE=false", () => {
    expect(readEnvironment({}).defaultStorage).toBe(true);
    expect(readEnvironment({ MONGOSHIELD_DEFAULT_STORAGE: "FALSE" }).defaultStorage).toBe(false);
    expect(() => readEnvironment({ MONGOSHIELD_DEFAULT_STORAGE: "no" })).toThrow(
      /"true" or "false"/,
    );
  });

  it("applies the documented defaults", () => {
    expect(readEnvironment({ MONGOSHIELD_SECRET: SECRET })).toMatchObject({
      dataDir: "/data",
      port: 8080,
      cookieSecure: true,
      shutdownGraceMs: 60_000,
    });
    expect(readEnvironment({ MONGOSHIELD_SECRET: SECRET }).oidc).toBeUndefined();
    // No HOST: main.ts listens on the dual-stack default (listen.ts).
    expect(readEnvironment({ MONGOSHIELD_SECRET: SECRET }).host).toBeUndefined();
    expect(readEnvironment({ MONGOSHIELD_SECRET: SECRET, HOST: "127.0.0.1" }).host).toBe(
      "127.0.0.1",
    );
  });

  it("reads the optional settings and validates them", () => {
    const environment = readEnvironment({
      MONGOSHIELD_SECRET: SECRET,
      PORT: "9000",
      MONGOSHIELD_PUBLIC_URL: "https://backups.example.com/",
      MONGOSHIELD_TRUST_PROXY_SECRET: SECRET,
      MONGOSHIELD_METRICS_TOKEN: SECRET,
      MONGOSHIELD_COOKIE_SECURE: "false",
      MONGOSHIELD_OIDC_ISSUER: "https://id.example.com",
      MONGOSHIELD_OIDC_CLIENT_ID: "console",
    });
    expect(environment).toMatchObject({
      port: 9000,
      publicUrl: "https://backups.example.com",
      proxySecret: SECRET,
      metricsToken: SECRET,
      cookieSecure: false,
      oidc: {
        issuer: "https://id.example.com",
        clientId: "console",
        redirectUrl: "https://backups.example.com/api/oidc/callback",
      },
    });
    expect(() => readEnvironment({ MONGOSHIELD_SECRET: SECRET, PORT: "http" })).toThrow();
    expect(() =>
      readEnvironment({ MONGOSHIELD_SECRET: SECRET, MONGOSHIELD_TRUST_PROXY_SECRET: "weak" }),
    ).toThrow(/at least 32/);
  });
});

describe("request-handling settings", () => {
  it("reads allowed hosts, trusted proxies and the unsafe-targets opt-out", () => {
    expect(readEnvironment({}).security).toEqual({});
    expect(
      readEnvironment({
        MONGOSHIELD_ALLOWED_HOSTS: "Backups.Example.com, *.corp.example.net",
        MONGOSHIELD_TRUSTED_PROXIES: "10.0.0.0/8 192.0.2.5",
        MONGOSHIELD_ALLOW_UNSAFE_TARGETS: "true",
      }).security,
    ).toEqual({
      allowedHosts: ["backups.example.com", "*.corp.example.net"],
      trustedProxies: ["10.0.0.0/8", "192.0.2.5"],
      allowUnsafeTargets: true,
    });
  });

  it("refuses malformed entries instead of trusting the wrong peer", () => {
    expect(() => readEnvironment({ MONGOSHIELD_TRUSTED_PROXIES: "proxy.local" })).toThrow(
      /not an IP address or CIDR range/,
    );
    expect(() => readEnvironment({ MONGOSHIELD_ALLOWED_HOSTS: "https://x.example" })).toThrow(
      /not a host name/,
    );
    expect(() => readEnvironment({ MONGOSHIELD_ALLOW_UNSAFE_TARGETS: "yes" })).toThrow(
      /"true" or "false"/,
    );
  });

  it("accepts an OIDC redirect URL under a sub-path", () => {
    const environment = readEnvironment({
      MONGOSHIELD_PUBLIC_URL: "https://example.com/mongoshield/",
      MONGOSHIELD_OIDC_ISSUER: "https://login.example.com",
      MONGOSHIELD_OIDC_CLIENT_ID: "console",
    });
    expect(environment.oidc?.redirectUrl).toBe("https://example.com/mongoshield/api/oidc/callback");
  });
});
