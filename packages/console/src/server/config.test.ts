import { describe, expect, it } from "vitest";
import { EnvironmentError, readEnvironment } from "./config.ts";

const SECRET = "0123456789abcdef0123456789abcdef";

describe("readEnvironment", () => {
  it("refuses to start without MONGOSHIELD_SECRET and explains why", () => {
    expect(() => readEnvironment({})).toThrow(EnvironmentError);
    expect(() => readEnvironment({})).toThrow(/openssl rand -hex 32/);
    expect(() => readEnvironment({ MONGOSHIELD_SECRET: "short" })).toThrow(/at least 32/);
  });

  it("applies the documented defaults", () => {
    expect(readEnvironment({ MONGOSHIELD_SECRET: SECRET })).toMatchObject({
      dataDir: "/data",
      port: 8080,
      host: "0.0.0.0",
      cookieSecure: true,
      shutdownGraceMs: 60_000,
    });
    expect(readEnvironment({ MONGOSHIELD_SECRET: SECRET }).oidc).toBeUndefined();
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
