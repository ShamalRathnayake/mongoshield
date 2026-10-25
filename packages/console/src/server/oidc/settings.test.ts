/**
 * Unit tests for the OIDC settings: reading MONGOSHIELD_OIDC_* (config.ts), role
 * mapping and username derivation (settings.ts).
 */

import { describe, expect, it } from "vitest";
import { EnvironmentError, readEnvironment, readOidcEnvironment } from "../config.ts";
import { roleFromClaims, usernameFromClaims } from "./settings.ts";

const BASE = {
  MONGOSHIELD_OIDC_ISSUER: "https://login.example.com/realms/ops",
  MONGOSHIELD_OIDC_CLIENT_ID: "mongoshield",
  MONGOSHIELD_OIDC_REDIRECT_URL: "https://backups.example.com/api/oidc/callback",
};

describe("reading the OIDC environment", () => {
  it("is off when no OIDC variable is set (empty values count as unset)", () => {
    expect(readOidcEnvironment({}, undefined, true)).toBeUndefined();
    expect(readOidcEnvironment({ MONGOSHIELD_OIDC_ISSUER: "  " }, undefined, true)).toBeUndefined();
  });

  it("reads a full configuration", () => {
    const settings = readOidcEnvironment(
      {
        ...BASE,
        MONGOSHIELD_OIDC_CLIENT_SECRET: "s3cret",
        MONGOSHIELD_OIDC_SCOPES: "profile groups",
        MONGOSHIELD_OIDC_ROLE_CLAIM: "groups",
        MONGOSHIELD_OIDC_ROLES_MAP: "ops-admins=admin, team=ops=operator",
        MONGOSHIELD_OIDC_DEFAULT_ROLE: "none",
        MONGOSHIELD_OIDC_AUTO_PROVISION: "FALSE",
        MONGOSHIELD_OIDC_CLOCK_SKEW_SECONDS: "30",
      },
      undefined,
      true,
    );
    expect(settings).toMatchObject({
      issuer: BASE.MONGOSHIELD_OIDC_ISSUER,
      clientId: "mongoshield",
      clientSecret: "s3cret",
      redirectUrl: BASE.MONGOSHIELD_OIDC_REDIRECT_URL,
      // openid is always requested.
      scopes: ["openid", "profile", "groups"],
      roleClaim: "groups",
      defaultRole: "none",
      autoProvision: false,
      clockSkewMs: 30_000,
    });
    // Group names may contain "=": only the last one separates the role.
    expect([...(settings?.rolesMap ?? [])]).toEqual([
      ["ops-admins", "admin"],
      ["team=ops", "operator"],
    ]);
  });

  it("uses safe defaults and derives the redirect URL from the public URL", () => {
    const { MONGOSHIELD_OIDC_REDIRECT_URL: _unused, ...withoutRedirect } = BASE;
    const settings = readOidcEnvironment(withoutRedirect, "https://backups.example.com", true);
    expect(settings).toMatchObject({
      redirectUrl: "https://backups.example.com/api/oidc/callback",
      scopes: ["openid", "profile", "email"],
      defaultRole: "viewer",
      autoProvision: true,
      clockSkewMs: 60_000,
    });
    expect(settings?.clientSecret).toBeUndefined();
    expect(settings?.roleClaim).toBeUndefined();
  });

  it("accepts the roles map as JSON, for claim values with commas such as LDAP DNs", () => {
    const settings = readOidcEnvironment(
      { ...BASE, MONGOSHIELD_OIDC_ROLES_MAP: '{"cn=admins,dc=example":"admin","ops":"operator"}' },
      undefined,
      true,
    );
    expect(settings?.rolesMap.get("cn=admins,dc=example")).toBe("admin");
  });

  it.each([
    [{ MONGOSHIELD_OIDC_ISSUER: BASE.MONGOSHIELD_OIDC_ISSUER }, /needs both/],
    [
      { ...BASE, MONGOSHIELD_OIDC_ROLE_CLAM: "groups" },
      /Unknown OIDC setting MONGOSHIELD_OIDC_ROLE_CLAM/,
    ],
    [{ ...BASE, MONGOSHIELD_OIDC_ISSUER: "http://login.example.com" }, /must be an https URL/],
    [{ ...BASE, MONGOSHIELD_OIDC_ISSUER: "not a url" }, /must be an https URL/],
    [
      { ...BASE, MONGOSHIELD_OIDC_REDIRECT_URL: "http://backups.example.com/api/oidc/callback" },
      /https URL/,
    ],
    [
      { ...BASE, MONGOSHIELD_OIDC_REDIRECT_URL: "https://backups.example.com/callback" },
      /must end in/,
    ],
    [{ ...BASE, MONGOSHIELD_OIDC_REDIRECT_URL: "::nonsense" }, /must be a URL/],
    [{ ...BASE, MONGOSHIELD_OIDC_CLOCK_SKEW_SECONDS: "301" }, /between 0 and 300/],
    [{ ...BASE, MONGOSHIELD_OIDC_CLOCK_SKEW_SECONDS: "soon" }, /between 0 and 300/],
    [{ ...BASE, MONGOSHIELD_OIDC_AUTO_PROVISION: "yes" }, /"true" or "false"/],
    [{ ...BASE, MONGOSHIELD_OIDC_DEFAULT_ROLE: "root" }, /viewer, operator, admin or none/],
    [{ ...BASE, MONGOSHIELD_OIDC_ROLES_MAP: "admins=root" }, /map each claim value/],
    [{ ...BASE, MONGOSHIELD_OIDC_ROLES_MAP: "=admin" }, /map each claim value/],
    [{ ...BASE, MONGOSHIELD_OIDC_ROLES_MAP: "{not json" }, /not valid JSON/],
    [{ ...BASE, MONGOSHIELD_OIDC_ROLES_MAP: '["admin"]' }, /must be a JSON object/],
  ])("refuses %o", (env, message) => {
    expect(() => readOidcEnvironment(env, undefined, true)).toThrow(EnvironmentError);
    expect(() => readOidcEnvironment(env, undefined, true)).toThrow(message);
  });

  it("needs a redirect URL when there is no public URL", () => {
    const { MONGOSHIELD_OIDC_REDIRECT_URL: _unused, ...withoutRedirect } = BASE;
    expect(() => readOidcEnvironment(withoutRedirect, undefined, true)).toThrow(
      /MONGOSHIELD_OIDC_REDIRECT_URL/,
    );
  });

  it("allows plain-HTTP redirects only on loopback or with insecure cookies", () => {
    const http = { ...BASE, MONGOSHIELD_OIDC_REDIRECT_URL: "http://backups.lan/api/oidc/callback" };
    expect(readOidcEnvironment(http, undefined, false)?.redirectUrl).toBe(
      http.MONGOSHIELD_OIDC_REDIRECT_URL,
    );
    const loopback = {
      ...BASE,
      MONGOSHIELD_OIDC_REDIRECT_URL: "http://localhost:8080/api/oidc/callback",
    };
    expect(readOidcEnvironment(loopback, undefined, true)?.redirectUrl).toContain("localhost");
  });

  it("is part of the console environment", () => {
    const environment = readEnvironment({
      MONGOSHIELD_SECRET: "x".repeat(40),
      MONGOSHIELD_PUBLIC_URL: "https://backups.example.com/",
      MONGOSHIELD_OIDC_ISSUER: BASE.MONGOSHIELD_OIDC_ISSUER,
      MONGOSHIELD_OIDC_CLIENT_ID: "mongoshield",
    });
    expect(environment.oidc?.redirectUrl).toBe("https://backups.example.com/api/oidc/callback");
    expect(readEnvironment({ MONGOSHIELD_SECRET: "x".repeat(40) }).oidc).toBeUndefined();
  });
});

describe("role mapping", () => {
  const settings = {
    roleClaim: "groups",
    rolesMap: new Map([
      ["ops-admins", "admin"],
      ["ops", "operator"],
    ] as const),
    defaultRole: "viewer",
  } as const;

  it("is undefined without a role claim (roles are then managed in the console)", () => {
    expect(
      roleFromClaims(
        { groups: ["ops-admins"] },
        { rolesMap: settings.rolesMap, defaultRole: "viewer" },
      ),
    ).toBeUndefined();
  });

  it("picks the highest mapped role from lists, strings and space-separated strings", () => {
    expect(roleFromClaims({ groups: ["ops", "ops-admins"] }, settings)).toBe("admin");
    expect(roleFromClaims({ groups: "ops" }, settings)).toBe("operator");
    expect(roleFromClaims({ groups: "marketing ops" }, settings)).toBe("operator");
    expect(roleFromClaims({ groups: ["ops", 42, null] }, settings)).toBe("operator");
  });

  it("falls back to the default role for no match, a missing claim or an unusable value", () => {
    expect(roleFromClaims({ groups: ["marketing"] }, settings)).toBe("viewer");
    expect(roleFromClaims({}, settings)).toBe("viewer");
    expect(roleFromClaims({ groups: { ops: true } }, settings)).toBe("viewer");
    expect(roleFromClaims({}, { ...settings, defaultRole: "none" })).toBe("none");
  });

  it("walks dotted paths into nested claims, and prefers a literal dotted claim name", () => {
    const nested = { ...settings, roleClaim: "realm_access.roles" };
    expect(roleFromClaims({ realm_access: { roles: ["ops-admins"] } }, nested)).toBe("admin");
    expect(
      roleFromClaims(
        { "realm_access.roles": ["ops"], realm_access: { roles: ["ops-admins"] } },
        nested,
      ),
    ).toBe("operator");
    expect(roleFromClaims({ realm_access: ["ops"] }, nested)).toBe("viewer");
    expect(roleFromClaims({ realm_access: "ops" }, nested)).toBe("viewer");
  });
});

describe("usernames", () => {
  const issuer = "https://login.example.com";

  it("prefers preferred_username, then a verified email, then sub", () => {
    expect(
      usernameFromClaims({ preferred_username: "ann", email: "a@x.io", sub: "1" }, issuer),
    ).toBe("ann");
    expect(usernameFromClaims({ email: "a@x.io", sub: "1" }, issuer)).toBe("a@x.io");
    expect(usernameFromClaims({ email: "a@x.io", email_verified: false, sub: "s-1" }, issuer)).toBe(
      "s-1",
    );
  });

  it("derives a stable name when nothing fits the username rule", () => {
    const claims = { preferred_username: "Zoë Smith", sub: "a b" };
    const name = usernameFromClaims(claims, issuer);
    expect(name).toMatch(/^oidc-[0-9a-f]{16}$/);
    expect(usernameFromClaims(claims, issuer)).toBe(name);
    expect(usernameFromClaims(claims, "https://other.example.com")).not.toBe(name);
  });
});
