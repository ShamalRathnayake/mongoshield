/**
 * OIDC sign-in end to end, against an in-process fake provider
 * (test/helpers/oidc-provider.ts) that really serves discovery, a JWKS and a token
 * endpoint and signs tokens. Each test plays the browser: console login redirect →
 * provider → callback, and checks where the console sends the browser and whether
 * a session exists afterwards.
 *
 * Covered: the happy path for RS256, ES256 and EdDSA; every rejection the relying
 * party makes (state, PKCE, signature, algorithm, key, issuer, audience, azp,
 * expiry, nbf, iat, nonce, subject, provider errors and outages); key rotation;
 * role mapping and syncing; account linking, provisioning and conflicts; cookies
 * and audit entries.
 */

import { afterEach, describe, expect, it } from "vitest";
import type { OidcSettings } from "../../src/server/oidc/settings.ts";
import {
  removeDataDir,
  setupAdmin,
  startConsole,
  TEST_PASSWORD,
  type TestClient,
  TestClock,
  type TestConsole,
} from "../helpers/console.ts";
import {
  type FakeOidcProvider,
  FakeOidcProvider as Provider,
  type TokenOptions,
} from "../helpers/oidc-provider.ts";

const REDIRECT_URL = "http://localhost/api/oidc/callback";

const consoles: TestConsole[] = [];
const providers: FakeOidcProvider[] = [];

afterEach(async () => {
  for (const testConsole of consoles.splice(0)) {
    await testConsole.close().catch(() => undefined);
    await removeDataDir(testConsole.dataDir);
  }
  for (const provider of providers.splice(0)) await provider.close();
});

interface Setup {
  readonly provider: FakeOidcProvider;
  readonly testConsole: TestConsole;
  readonly clock: TestClock;
  readonly admin: TestClient;
}

/** A console with OIDC pointed at a fresh fake provider, and its first (password) admin. */
async function setup(
  overrides: Partial<OidcSettings> = {},
  providerOptions: Parameters<typeof Provider.start>[0] = {},
  cookieSecure = false,
): Promise<Setup> {
  const clock = new TestClock();
  const provider = await Provider.start({ now: () => clock.now().getTime(), ...providerOptions });
  providers.push(provider);
  const settings: OidcSettings = {
    issuer: provider.issuer,
    clientId: provider.clientId,
    ...(provider.clientSecret === undefined ? {} : { clientSecret: provider.clientSecret }),
    redirectUrl: REDIRECT_URL,
    scopes: ["openid", "profile", "email"],
    rolesMap: new Map(),
    defaultRole: "viewer",
    autoProvision: true,
    clockSkewMs: 60_000,
    ...overrides,
  };
  const testConsole = await startConsole({
    clock,
    settings: { oidc: settings, cookieSecure },
    oidcProvider: { refreshCooldownMs: 0 },
  });
  consoles.push(testConsole);
  const admin = await setupAdmin(testConsole);
  return { provider, testConsole, clock, admin };
}

/** The outcome of one browser round trip. */
interface Attempt {
  readonly client: TestClient;
  /** Where the callback sent the browser. */
  readonly location: string;
  readonly authorizeUrl: string;
}

/**
 * Plays one sign-in: GET /api/oidc/login, "log in" at the provider (issueCode),
 * GET the callback. `callbackQuery` changes what comes back to the console.
 */
async function signIn(
  { provider, testConsole }: Pick<Setup, "provider" | "testConsole">,
  token: TokenOptions = {},
  callbackQuery: (query: URLSearchParams) => void = () => {},
  client: TestClient = testConsole.client(),
): Promise<Attempt> {
  const login = await client.request("GET", "/api/oidc/login");
  expect(login.status).toBe(302);
  const authorizeUrl = login.headers.get("location") ?? "";
  const { code, request } = provider.issueCode(authorizeUrl, token);
  const query = new URLSearchParams({ code, state: request.state });
  callbackQuery(query);
  const callback = await client.request("GET", `/api/oidc/callback?${query.toString()}`);
  expect(callback.status).toBe(303);
  return { client, location: callback.headers.get("location") ?? "", authorizeUrl };
}

/** Expects a failed sign-in with `code` and no session. */
async function expectFailure(attempt: Attempt, code: string): Promise<void> {
  expect(attempt.location).toBe(`/#/?sso_error=${code}`);
  const session = await attempt.client.request("GET", "/api/session");
  expect(session.body.user).toBeUndefined();
}

/** Expects a successful sign-in and returns the signed-in user. */
async function expectSignedIn(
  attempt: Attempt,
): Promise<{ username: string; role: string; signIn: string }> {
  expect(attempt.location).toBe("/#/");
  const session = await attempt.client.request("GET", "/api/session");
  expect(session.body.user).toBeDefined();
  return session.body.user;
}

describe("OIDC sign-in", () => {
  it("signs a new identity in with RS256, creates an SSO-only viewer and audits it", async () => {
    const context = await setup();
    const attempt = await signIn(context);
    const user = await expectSignedIn(attempt);
    expect(user).toMatchObject({ username: "alice", role: "viewer", signIn: "sso" });

    const session = await attempt.client.session();
    expect(session.authMethods).toEqual(["password", "oidc"]);
    // The session is a normal one: the CSRF token works for state changes.
    expect((await attempt.client.request("DELETE", "/api/session")).status).toBe(200);

    const audit = (await context.admin.request("GET", "/api/audit?limit=20")).body;
    expect(audit).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: "user.provision",
          details: { via: "oidc", role: "viewer" },
        }),
        expect.objectContaining({
          action: "session.login",
          actor: "alice",
          details: { method: "oidc" },
        }),
      ]),
    );
  });

  it("sends a complete authorization request and proves PKCE at the token endpoint", async () => {
    const context = await setup();
    const attempt = await signIn(context);
    await expectSignedIn(attempt);
    const url = new URL(attempt.authorizeUrl);
    expect(url.origin + url.pathname).toBe(`${context.provider.issuer}/authorize`);
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      response_type: "code",
      client_id: context.provider.clientId,
      redirect_uri: REDIRECT_URL,
      scope: "openid profile email",
      code_challenge_method: "S256",
    });
    expect(url.searchParams.get("state")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(url.searchParams.get("nonce")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const [tokenRequest] = context.provider.tokenRequests;
    expect(tokenRequest?.form.get("code_verifier")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    // client_secret_basic: the secret travels in the header, never in the form.
    expect(tokenRequest?.authorization).toMatch(/^Basic /);
    expect(tokenRequest?.form.get("client_secret")).toBeNull();
  });

  it("accepts ES256 and EdDSA signatures", async () => {
    const context = await setup({}, { algorithms: ["ES256", "EdDSA"] });
    const [es256, eddsa] = context.provider.keys;
    await expectSignedIn(await signIn(context, { key: es256 }));
    await expectSignedIn(
      await signIn(context, { key: eddsa, claims: { sub: "user-2", preferred_username: "bob" } }),
    );
  });

  it("sets a short-lived Lax transaction cookie, __Host- prefixed when cookies are secure", async () => {
    const context = await setup({}, {}, true);
    const login = await context.testConsole.client().request("GET", "/api/oidc/login");
    const cookie = login.headers
      .getSetCookie()
      .find((value) => value.startsWith("__Host-mongoshield_oidc="));
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/Secure/);
    expect(cookie).toMatch(/SameSite=Lax/);
    expect(cookie).toMatch(/Max-Age=600/);
    expect(cookie).toMatch(/Path=\//);
  });

  it("uses client_secret_post when the provider only supports it, and no secret for public clients", async () => {
    const post = await setup({}, { authMethods: ["client_secret_post"] });
    await expectSignedIn(await signIn(post));
    expect(post.provider.tokenRequests[0]?.form.get("client_secret")).toBe(
      post.provider.clientSecret,
    );
    expect(post.provider.tokenRequests[0]?.authorization).toBeUndefined();

    const publicClient = await setup({}, { clientSecret: undefined });
    await expectSignedIn(await signIn(publicClient));
    const form = publicClient.provider.tokenRequests[0]?.form;
    expect(form?.get("client_id")).toBe(publicClient.provider.clientId);
    expect(form?.get("client_secret")).toBeNull();
  });

  it("answers 404 when OIDC is not configured", async () => {
    const testConsole = await startConsole();
    consoles.push(testConsole);
    const client = testConsole.client();
    expect((await client.request("GET", "/api/oidc/login")).status).toBe(404);
    expect((await client.request("GET", "/api/oidc/callback?code=x&state=y")).status).toBe(404);
    expect((await client.session()).authMethods).toEqual(["password"]);
  });
});

describe("the state, the transaction cookie and the code", () => {
  it("refuses a callback without the transaction cookie (login CSRF)", async () => {
    const context = await setup();
    const login = await context.testConsole.client().request("GET", "/api/oidc/login");
    const { code, request } = context.provider.issueCode(login.headers.get("location") ?? "");
    // Another browser (the victim's) receives the attacker's callback URL.
    const victim = context.testConsole.client();
    const callback = await victim.request(
      "GET",
      `/api/oidc/callback?code=${code}&state=${request.state}`,
    );
    await expectFailure(
      { client: victim, location: callback.headers.get("location") ?? "", authorizeUrl: "" },
      "CONSOLE_OIDC_STATE",
    );
  });

  it("refuses a wrong state", async () => {
    const context = await setup();
    await expectFailure(
      await signIn(context, {}, (query) => query.set("state", "forged-state")),
      "CONSOLE_OIDC_STATE",
    );
  });

  it("refuses a missing state", async () => {
    const context = await setup();
    await expectFailure(
      await signIn(context, {}, (query) => query.delete("state")),
      "CONSOLE_OIDC_STATE",
    );
  });

  it("works only once per sign-in (no replay of the callback)", async () => {
    const context = await setup();
    const client = context.testConsole.client();
    const login = await client.request("GET", "/api/oidc/login");
    const { code, request } = context.provider.issueCode(login.headers.get("location") ?? "");
    const path = `/api/oidc/callback?code=${code}&state=${request.state}`;
    // Keep the transaction cookie to replay it after it was cleared.
    const cookie = client.cookieHeader ?? "";
    expect((await client.request("GET", path)).headers.get("location")).toBe("/#/");
    const replay = await context.testConsole
      .client()
      .request("GET", path, undefined, { headers: { cookie } });
    expect(replay.headers.get("location")).toBe("/#/?sso_error=CONSOLE_OIDC_STATE");
  });

  it("expires a sign-in after 10 minutes", async () => {
    const context = await setup();
    const client = context.testConsole.client();
    const login = await client.request("GET", "/api/oidc/login");
    const { code, request } = context.provider.issueCode(login.headers.get("location") ?? "");
    context.clock.advance(10 * 60 * 1000 + 1);
    const callback = await client.request(
      "GET",
      `/api/oidc/callback?code=${code}&state=${request.state}`,
    );
    expect(callback.headers.get("location")).toBe("/#/?sso_error=CONSOLE_OIDC_STATE");
  });

  it("refuses a code redeemed with a different PKCE challenge", async () => {
    const context = await setup();
    const client = context.testConsole.client();
    const login = await client.request("GET", "/api/oidc/login");
    const authorizeUrl = new URL(login.headers.get("location") ?? "");
    // An attacker's code, bound to the attacker's own challenge.
    authorizeUrl.searchParams.set("code_challenge", "attacker-challenge-attacker-challenge-attack");
    const { code, request } = context.provider.issueCode(authorizeUrl.toString());
    const callback = await client.request(
      "GET",
      `/api/oidc/callback?code=${code}&state=${request.state}`,
    );
    await expectFailure(
      { client, location: callback.headers.get("location") ?? "", authorizeUrl: "" },
      "CONSOLE_OIDC_PROVIDER_ERROR",
    );
  });

  it("reports provider errors, a missing code and a callback naming another issuer", async () => {
    const context = await setup();
    await expectFailure(
      await signIn(context, {}, (query) => {
        query.delete("code");
        query.set("error", "access_denied");
      }),
      "CONSOLE_OIDC_PROVIDER_ERROR",
    );
    await expectFailure(
      await signIn(context, {}, (query) => query.delete("code")),
      "CONSOLE_OIDC_PROVIDER_ERROR",
    );
    await expectFailure(
      await signIn(context, {}, (query) => query.set("iss", "https://evil.example.com")),
      "CONSOLE_OIDC_INVALID_TOKEN",
    );
    await expectSignedIn(
      await signIn(context, {}, (query) => query.set("iss", context.provider.issuer)),
    );
  });

  it("caps the number of pending sign-ins", async () => {
    const context = await setup();
    const oidc = context.testConsole.services.oidc;
    for (let index = 0; index < 1010; index++) await oidc?.begin();
    expect(oidc?.pendingCount).toBe(1000);
  });
});

describe("the token endpoint and the provider", () => {
  it("refuses a wrong client secret (invalid_client)", async () => {
    const context = await setup({ clientSecret: "wrong-secret" });
    await expectFailure(await signIn(context), "CONSOLE_OIDC_PROVIDER_ERROR");
  });

  it("reports a failing token endpoint as unavailable", async () => {
    const context = await setup();
    await expectFailure(
      await signIn(context, { tokenResponse: { status: 503, body: {} } }),
      "CONSOLE_OIDC_UNAVAILABLE",
    );
  });

  it("refuses a token response without an ID token", async () => {
    const context = await setup();
    await expectFailure(
      await signIn(context, { tokenResponse: { status: 200, body: { access_token: "x" } } }),
      "CONSOLE_OIDC_INVALID_TOKEN",
    );
  });

  it("refuses a discovery document of another issuer (mix-up)", async () => {
    const context = await setup();
    context.provider.discovery = { issuer: "https://other.example.com" };
    const client = context.testConsole.client();
    const login = await client.request("GET", "/api/oidc/login");
    expect(login.status).toBe(303);
    expect(login.headers.get("location")).toBe("/#/?sso_error=CONSOLE_OIDC_UNAVAILABLE");
  });

  it("refuses discovery documents without PKCE S256, the code flow, or https endpoints", async () => {
    for (const discovery of [
      { code_challenge_methods_supported: ["plain"] },
      { response_types_supported: ["id_token"] },
      { token_endpoint: "http://203.0.113.5/token" },
      { jwks_uri: undefined },
    ]) {
      const context = await setup();
      context.provider.discovery = discovery;
      const login = await context.testConsole.client().request("GET", "/api/oidc/login");
      expect(login.headers.get("location"), JSON.stringify(discovery)).toBe(
        "/#/?sso_error=CONSOLE_OIDC_UNAVAILABLE",
      );
    }
  });

  it("reports an unreachable or broken provider as unavailable", async () => {
    const context = await setup();
    context.provider.failures.set("/.well-known/openid-configuration", 500);
    const login = await context.testConsole.client().request("GET", "/api/oidc/login");
    expect(login.headers.get("location")).toBe("/#/?sso_error=CONSOLE_OIDC_UNAVAILABLE");

    context.provider.failures.clear();
    await context.provider.close();
    providers.splice(providers.indexOf(context.provider), 1);
    const offline = await context.testConsole.client().request("GET", "/api/oidc/login");
    expect(offline.headers.get("location")).toBe("/#/?sso_error=CONSOLE_OIDC_UNAVAILABLE");
  });

  it("caches discovery between sign-ins", async () => {
    const context = await setup();
    await signIn(context);
    await signIn(context, { claims: { sub: "user-2", preferred_username: "bob" } });
    const discoveries = context.provider.requests.filter((request) =>
      request.endsWith("openid-configuration"),
    );
    expect(discoveries).toHaveLength(1);
  });
});

describe("ID token verification", () => {
  /** Cases that must all end in CONSOLE_OIDC_INVALID_TOKEN. */
  const nowSeconds = Math.floor(Date.parse("2026-10-21T10:00:00.000Z") / 1000);
  const invalid: [string, (provider: FakeOidcProvider) => TokenOptions][] = [
    ["another issuer", () => ({ claims: { iss: "https://evil.example.com" } })],
    ["another audience", () => ({ claims: { aud: "someone-else" } })],
    [
      "several audiences without azp",
      (provider) => ({ claims: { aud: [provider.clientId, "other"] } }),
    ],
    ["an azp of another client", () => ({ claims: { azp: "other-client" } })],
    ["an expired token (beyond the skew)", () => ({ claims: { exp: nowSeconds - 61 } })],
    ["no expiry", () => ({ claims: { exp: undefined } })],
    ["a token not valid yet (beyond the skew)", () => ({ claims: { nbf: nowSeconds + 61 } })],
    ["a non-numeric nbf", () => ({ claims: { nbf: "soon" } })],
    ["a token issued in the future", () => ({ claims: { iat: nowSeconds + 120 } })],
    ["no issue time", () => ({ claims: { iat: undefined } })],
    ["a wrong nonce", () => ({ claims: { nonce: "replayed-nonce" } })],
    ["no nonce", () => ({ claims: { nonce: undefined } })],
    ["no subject", () => ({ claims: { sub: undefined } })],
    ["an over-long subject", () => ({ claims: { sub: "s".repeat(256) } })],
    [
      "alg none",
      () => ({
        header: { alg: "none" },
        rawToken: ({ header, payload }) => `${header}.${payload}.`,
      }),
    ],
    ["an HMAC algorithm", () => ({ header: { alg: "HS256" } })],
    ["a critical header extension", () => ({ header: { crit: ["exp"] } })],
    ["an unknown key id", () => ({ header: { kid: "no-such-key" } })],
    [
      "a tampered payload",
      () => ({
        rawToken: ({ header }) =>
          `${header}.${Buffer.from('{"sub":"admin"}').toString("base64url")}.AAAA`,
      }),
    ],
    ["a token that is not a JWS", () => ({ rawToken: () => "not-a-token" })],
    [
      "a token with a non-JSON header",
      () => ({ rawToken: ({ payload }) => `bm90IGpzb24.${payload}.AAAA` }),
    ],
  ];

  it.each(invalid)("refuses %s", async (_name, options) => {
    const context = await setup();
    await expectFailure(
      await signIn(context, options(context.provider)),
      "CONSOLE_OIDC_INVALID_TOKEN",
    );
  });

  it("accepts tokens within the clock skew, several audiences with azp, and an expected nbf", async () => {
    const context = await setup();
    await expectSignedIn(
      await signIn(context, {
        claims: {
          exp: nowSeconds - 30,
          nbf: nowSeconds + 30,
          iat: nowSeconds + 30,
          aud: [context.provider.clientId, "other"],
          azp: context.provider.clientId,
        },
      }),
    );
  });

  it("refuses a signature by a key the provider does not publish", async () => {
    const context = await setup();
    const impostor = context.provider.addKey("RS256", context.provider.published[0]?.kid);
    await expectFailure(await signIn(context, { key: impostor }), "CONSOLE_OIDC_INVALID_TOKEN");
  });

  it("refuses keys that are too weak, meant for encryption, or pinned to another algorithm", async () => {
    const context = await setup();
    const weak = context.provider.addKey("RS256", "weak", 1024);
    context.provider.publish(weak);
    await expectFailure(await signIn(context, { key: weak }), "CONSOLE_OIDC_INVALID_TOKEN");

    const encryption = context.provider.addKey("RS256", "enc");
    encryption.jwk = { ...encryption.jwk, use: "enc" };
    context.provider.publish(encryption);
    await expectFailure(await signIn(context, { key: encryption }), "CONSOLE_OIDC_INVALID_TOKEN");

    const pinned = context.provider.addKey("ES256", "pinned");
    pinned.jwk = { ...pinned.jwk, alg: "ES384" };
    context.provider.publish(pinned);
    await expectFailure(await signIn(context, { key: pinned }), "CONSOLE_OIDC_INVALID_TOKEN");
  });

  it("refuses an RS256 token verified against an EC key (algorithm confusion)", async () => {
    const context = await setup({}, { algorithms: ["ES256"] });
    const rsa = context.provider.addKey("RS256", context.provider.published[0]?.kid);
    await expectFailure(await signIn(context, { key: rsa }), "CONSOLE_OIDC_INVALID_TOKEN");
  });

  it("follows key rotation: a new key id triggers one JWKS refresh", async () => {
    const context = await setup();
    await expectSignedIn(await signIn(context));
    const rotated = context.provider.addKey("EdDSA", "rotated");
    context.provider.published = [rotated];
    const before = context.provider.requests.filter((request) => request === "GET /jwks").length;
    await expectSignedIn(await signIn(context, { key: rotated }));
    const after = context.provider.requests.filter((request) => request === "GET /jwks").length;
    expect(after - before).toBe(1);
  });

  it("refreshes for unknown key ids at most once per cooldown", async () => {
    const clock = new TestClock();
    const provider = await Provider.start({ now: () => clock.now().getTime() });
    providers.push(provider);
    const testConsole = await startConsole({
      clock,
      settings: {
        cookieSecure: false,
        oidc: {
          issuer: provider.issuer,
          clientId: provider.clientId,
          clientSecret: provider.clientSecret ?? "",
          redirectUrl: REDIRECT_URL,
          scopes: ["openid"],
          rolesMap: new Map(),
          defaultRole: "viewer",
          autoProvision: true,
          clockSkewMs: 60_000,
        },
      },
      oidcProvider: { refreshCooldownMs: 60_000 },
    });
    consoles.push(testConsole);
    await expectSignedIn(await signIn({ provider, testConsole }));
    const count = (): number =>
      provider.requests.filter((request) => request === "GET /jwks").length;
    const start = count();
    await signIn({ provider, testConsole }, { header: { kid: "made-up-1" } });
    await signIn({ provider, testConsole }, { header: { kid: "made-up-2" } });
    expect(count() - start).toBe(1);
    clock.advance(61_000);
    await signIn({ provider, testConsole }, { header: { kid: "made-up-3" } });
    expect(count() - start).toBe(2);
  });

  it("tries every key when the token names none", async () => {
    const context = await setup({}, { algorithms: ["ES256", "ES256"] });
    const second = context.provider.keys[1];
    await expectSignedIn(await signIn(context, { key: second, header: { kid: undefined } }));
  });
});

describe("roles and accounts", () => {
  const groups = {
    roleClaim: "groups",
    rolesMap: new Map([
      ["ops-admins", "admin"],
      ["ops", "operator"],
    ] as const),
  };

  it("maps the highest matching group to a role, and falls back to the default role", async () => {
    const context = await setup(groups);
    const admin = await expectSignedIn(
      await signIn(context, {
        claims: { sub: "u1", preferred_username: "ann", groups: ["ops", "ops-admins"] },
      }),
    );
    expect(admin.role).toBe("admin");
    const operator = await expectSignedIn(
      await signIn(context, {
        claims: { sub: "u2", preferred_username: "bea", groups: "ops other" },
      }),
    );
    expect(operator.role).toBe("operator");
    const viewer = await expectSignedIn(
      await signIn(context, {
        claims: { sub: "u3", preferred_username: "cid", groups: ["marketing"] },
      }),
    );
    expect(viewer.role).toBe("viewer");
  });

  it("reads nested role claims such as realm_access.roles", async () => {
    const context = await setup({ ...groups, roleClaim: "realm_access.roles" });
    const user = await expectSignedIn(
      await signIn(context, { claims: { realm_access: { roles: ["ops-admins"] } } }),
    );
    expect(user.role).toBe("admin");
  });

  it("refuses identities without a mapped role when the default role is none", async () => {
    const context = await setup({ ...groups, defaultRole: "none" });
    await expectFailure(
      await signIn(context, { claims: { groups: ["marketing"] } }),
      "CONSOLE_OIDC_NO_ROLE",
    );
    const audit = (await context.admin.request("GET", "/api/audit?limit=5")).body;
    expect(audit[0]).toMatchObject({
      action: "session.login_failed",
      outcome: "failure",
      details: { method: "oidc", reason: "CONSOLE_OIDC_NO_ROLE" },
    });
  });

  it("syncs the role from the provider at every sign-in", async () => {
    const context = await setup(groups);
    const claims = { sub: "u1", preferred_username: "ann" };
    expect(
      (
        await expectSignedIn(
          await signIn(context, { claims: { ...claims, groups: ["ops-admins"] } }),
        )
      ).role,
    ).toBe("admin");
    expect(
      (await expectSignedIn(await signIn(context, { claims: { ...claims, groups: ["ops"] } })))
        .role,
    ).toBe("operator");
  });

  it("never demotes the last admin through a role sync", async () => {
    const context = await setup(groups);
    const claims = { sub: "u1", preferred_username: "ann" };
    await expectSignedIn(await signIn(context, { claims: { ...claims, groups: ["ops-admins"] } }));
    // Remove the password admin, so the OIDC account is the last admin.
    const users = (await context.admin.request("GET", "/api/users")).body as {
      id: string;
      username: string;
    }[];
    const ann = await signIn(context, { claims: { ...claims, groups: ["ops-admins"] } });
    await ann.client.session();
    const passwordAdmin = users.find((user) => user.username === "admin");
    expect((await ann.client.request("DELETE", `/api/users/${passwordAdmin?.id}`)).status).toBe(
      200,
    );
    expect(
      (await expectSignedIn(await signIn(context, { claims: { ...claims, groups: [] } }))).role,
    ).toBe("admin");
  });

  it("keeps console-managed roles when no role claim is configured", async () => {
    const context = await setup();
    await expectSignedIn(await signIn(context));
    const users = (await context.admin.request("GET", "/api/users")).body as {
      id: string;
      username: string;
    }[];
    const alice = users.find((user) => user.username === "alice");
    await context.admin.request("PUT", `/api/users/${alice?.id}`, {
      username: "alice",
      role: "operator",
    });
    expect((await expectSignedIn(await signIn(context))).role).toBe("operator");
  });

  it("with auto-provisioning off, refuses unknown identities and links SSO-only accounts an admin created", async () => {
    const context = await setup({ autoProvision: false });
    await expectFailure(await signIn(context), "CONSOLE_OIDC_NOT_PROVISIONED");

    const created = await context.admin.request("POST", "/api/users", {
      username: "alice",
      role: "operator",
    });
    expect(created.status).toBe(200);
    expect(created.body.signIn).toBe("sso");
    expect((await expectSignedIn(await signIn(context))).role).toBe("operator");

    // Linked by issuer + subject from now on: a rename does not break it.
    await context.admin.request("PUT", `/api/users/${created.body.id}`, {
      username: "alice2",
      role: "operator",
    });
    expect((await expectSignedIn(await signIn(context))).username).toBe("alice2");
    // And another identity claiming the old name gets no access.
    await expectFailure(
      await signIn(context, { claims: { sub: "intruder", preferred_username: "alice2" } }),
      "CONSOLE_OIDC_ACCOUNT_CONFLICT",
    );
  });

  it("never takes over a password account with the same username", async () => {
    const context = await setup();
    await expectFailure(
      await signIn(context, { claims: { preferred_username: "admin" } }),
      "CONSOLE_OIDC_ACCOUNT_CONFLICT",
    );
  });

  it("derives usernames from email or sub, or a stable hash when neither fits", async () => {
    const context = await setup();
    const fromEmail = await expectSignedIn(
      await signIn(context, {
        claims: { sub: "a", preferred_username: undefined, email: "eve@example.com" },
      }),
    );
    expect(fromEmail.username).toBe("eve@example.com");
    const fromSub = await expectSignedIn(
      await signIn(context, {
        claims: {
          sub: "subject-b",
          preferred_username: undefined,
          email: "x@example.com",
          email_verified: false,
        },
      }),
    );
    expect(fromSub.username).toBe("subject-b");
    const hashed = await expectSignedIn(
      await signIn(context, {
        claims: { sub: "with spaces", preferred_username: "Ünïcode", email: undefined },
      }),
    );
    expect(hashed.username).toMatch(/^oidc-[0-9a-f]{16}$/);
  });

  it("does not let SSO-only accounts sign in with a password", async () => {
    const context = await setup();
    await expectSignedIn(await signIn(context));
    const login = await context.testConsole.client().login("alice", TEST_PASSWORD);
    expect(login.status).toBe(401);
    expect((await context.testConsole.client().login("alice", "")).status).toBe(401);
  });

  it("refuses SSO-only accounts when no single sign-on is configured", async () => {
    const testConsole = await startConsole();
    consoles.push(testConsole);
    const admin = await setupAdmin(testConsole);
    const created = await admin.request("POST", "/api/users", {
      username: "nopass",
      role: "viewer",
    });
    expect(created.status).toBe(400);
    expect(created.body.error.message).toMatch(/password is required/);
  });
});
