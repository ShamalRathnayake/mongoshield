/**
 * Tests for the OAuth helpers against a local fake authorization server: client app
 * resolution (apps.ts), the device flow (RFC 8628), the browser flow with PKCE and a
 * loopback redirect, and refresh-token exchange with caching and rotation.
 */

import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import {
  type FakeHttpServer,
  type FakeResponse,
  type RecordedRequest,
  startFakeHttpServer,
} from "../../../test/helpers/fake-http-server.ts";
import { isMongoShieldError } from "../../errors.ts";
import { OAUTH_APPS, OAUTH_PROVIDER_IDS, oauthSecretEnvNames, resolveOAuthClient } from "./apps.ts";
import { createPkcePair, runBrowserFlow } from "./browser-flow.ts";
import { type DeviceAuthorizationPrompt, runDeviceFlow } from "./device-flow.ts";
import { createAccessTokenSource } from "./refresh.ts";

let server: FakeHttpServer | undefined;

afterEach(async () => {
  await server?.close();
  server = undefined;
});

async function serve(handler: (request: RecordedRequest) => FakeResponse): Promise<FakeHttpServer> {
  server = await startFakeHttpServer(handler);
  return server;
}

/** The form fields of a recorded token request. */
function form(request: RecordedRequest | undefined): Record<string, string> {
  return Object.fromEntries(new URLSearchParams(request?.body.toString() ?? ""));
}

async function failure(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => undefined,
    (error: unknown) => error,
  );
}

const client = { clientId: "client-123", source: "environment" as const };
/** Sleeps recorded, not slept. */
function recordingSleep() {
  const waits: number[] = [];
  return { waits, sleep: async (ms: number) => void waits.push(ms) };
}

describe("resolveOAuthClient", () => {
  it("uses MONGOSHIELD_<PROVIDER>_CLIENT_ID and _CLIENT_SECRET when set", () => {
    expect(
      resolveOAuthClient("gdrive", {
        MONGOSHIELD_GDRIVE_CLIENT_ID: " own-id ",
        MONGOSHIELD_GDRIVE_CLIENT_SECRET: "own-secret",
      }),
    ).toEqual({ clientId: "own-id", clientSecret: "own-secret", source: "environment" });
    expect(resolveOAuthClient("dropbox", { MONGOSHIELD_DROPBOX_CLIENT_ID: "app-key" })).toEqual({
      clientId: "app-key",
      source: "environment",
    });
  });

  it("fails with MS_CONFIG_INVALID and the variables to set while a shipped id is empty", () => {
    for (const provider of OAUTH_PROVIDER_IDS) {
      if (OAUTH_APPS[provider].clientId !== "") continue;
      let caught: unknown;
      try {
        resolveOAuthClient(provider, {});
      } catch (error) {
        caught = error;
      }
      expect(isMongoShieldError(caught, "MS_CONFIG_INVALID")).toBe(true);
      expect(isMongoShieldError(caught) && caught.hint).toContain(
        OAUTH_APPS[provider].env.clientId,
      );
    }
  });

  it("names every provider's variables MONGOSHIELD_<PROVIDER>_…", () => {
    expect(OAUTH_APPS.gdrive.env).toEqual({
      clientId: "MONGOSHIELD_GDRIVE_CLIENT_ID",
      clientSecret: "MONGOSHIELD_GDRIVE_CLIENT_SECRET",
      token: "MONGOSHIELD_GDRIVE_TOKEN",
    });
    expect(OAUTH_APPS.dropbox.env.token).toBe("MONGOSHIELD_DROPBOX_TOKEN");
    expect(oauthSecretEnvNames()).toContain("MONGOSHIELD_DROPBOX_TOKEN");
    expect(oauthSecretEnvNames()).toContain("MONGOSHIELD_GDRIVE_CLIENT_SECRET");
  });

  it("asks only for least-privilege scopes", () => {
    expect(OAUTH_APPS.gdrive.scopes).toEqual(["https://www.googleapis.com/auth/drive.file"]);
    expect(OAUTH_APPS.dropbox.flow).toBe("browser");
  });
});

describe("runDeviceFlow", () => {
  /** A device flow server whose token endpoint answers with `answers` in turn. */
  async function deviceServer(deviceAnswer: FakeResponse, ...answers: FakeResponse[]) {
    let polls = 0;
    return serve((request) => {
      if (request.path === "/device") return deviceAnswer;
      const answer = answers[Math.min(polls, answers.length - 1)] ?? { status: 500 };
      polls += 1;
      return answer;
    });
  }

  const deviceCode = {
    status: 200,
    json: {
      device_code: "dev-1",
      user_code: "WDJB-MJHT",
      verification_url: "https://example.com/device",
      expires_in: 900,
      interval: 2,
    },
  };
  const pending = { status: 400, json: { error: "authorization_pending" } };

  async function run(fake: FakeHttpServer, extra: { now?: () => number } = {}) {
    const prompts: DeviceAuthorizationPrompt[] = [];
    const { waits, sleep } = recordingSleep();
    const result = runDeviceFlow({
      service: "Test Drive",
      deviceAuthorizationUrl: `${fake.url}/device`,
      tokenUrl: `${fake.url}/token`,
      client: { ...client, clientSecret: "shh" },
      scopes: ["files", "offline"],
      onPrompt: (prompt) => void prompts.push(prompt),
      sleep,
      ...extra,
    });
    return { result, prompts, waits };
  }

  it("shows the code, polls at the interval through authorization_pending, and returns the tokens", async () => {
    const fake = await deviceServer(deviceCode, pending, pending, {
      status: 200,
      json: { access_token: "at", refresh_token: "rt", expires_in: 3600, token_type: "Bearer" },
    });
    const { result, prompts, waits } = await run(fake, { now: () => 1_000 });
    expect(await result).toEqual({
      accessToken: "at",
      refreshToken: "rt",
      expiresAt: 1_000 + 3_600_000,
      tokenType: "Bearer",
    });
    // Google's `verification_url` is accepted as the RFC's `verification_uri`.
    expect(prompts).toEqual([
      {
        userCode: "WDJB-MJHT",
        verificationUri: "https://example.com/device",
        expiresAt: new Date(1_000 + 900_000),
      },
    ]);
    expect(waits).toEqual([2000, 2000, 2000]);
    expect(form(fake.requests[0])).toEqual({
      client_id: "client-123",
      client_secret: "shh",
      scope: "files offline",
    });
    expect(form(fake.requests[1])).toEqual({
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      device_code: "dev-1",
      client_id: "client-123",
      client_secret: "shh",
    });
  });

  it("slows down by 5 seconds for good on slow_down", async () => {
    const fake = await deviceServer(
      deviceCode,
      { status: 400, json: { error: "slow_down" } },
      pending,
      { status: 200, json: { access_token: "at" } },
    );
    const { result, waits } = await run(fake);
    await result;
    expect(waits).toEqual([2000, 7000, 7000]);
  });

  it("fails with MS_STORAGE_FORBIDDEN when the person declines", async () => {
    const fake = await deviceServer(deviceCode, { status: 400, json: { error: "access_denied" } });
    const error = await failure((await run(fake)).result);
    expect(isMongoShieldError(error, "MS_STORAGE_FORBIDDEN")).toBe(true);
    expect(String(error)).toContain("declined");
  });

  it("fails with MS_TIMEOUT when the code expires", async () => {
    const fake = await deviceServer(deviceCode, { status: 400, json: { error: "expired_token" } });
    const error = await failure((await run(fake)).result);
    expect(isMongoShieldError(error, "MS_TIMEOUT")).toBe(true);
  });

  it("stops polling at the deadline even if the server keeps saying pending", async () => {
    let clock = 0;
    const fake = await deviceServer(deviceCode, pending);
    const { result } = await run(fake, {
      now: () => {
        clock += 400_000;
        return clock;
      },
    });
    const error = await failure(result);
    expect(isMongoShieldError(error, "MS_TIMEOUT")).toBe(true);
  });

  it("reports a client the provider refuses as MS_CONFIG_INVALID", async () => {
    const fake = await deviceServer({ status: 401, json: { error: "invalid_client" } });
    const error = await failure((await run(fake)).result);
    expect(isMongoShieldError(error, "MS_CONFIG_INVALID")).toBe(true);
    expect(isMongoShieldError(error) && error.hint).toContain("CLIENT_ID");
  });

  it("stops with MS_ABORTED on Ctrl-C while waiting", async () => {
    const fake = await deviceServer(deviceCode, pending);
    const controller = new AbortController();
    const result = runDeviceFlow({
      service: "Test Drive",
      deviceAuthorizationUrl: `${fake.url}/device`,
      tokenUrl: `${fake.url}/token`,
      client,
      scopes: [],
      onPrompt: () => {
        setTimeout(() => controller.abort(), 10);
      },
      signal: controller.signal,
    });
    expect(isMongoShieldError(await failure(result), "MS_ABORTED")).toBe(true);
  });
});

describe("runBrowserFlow", () => {
  /** Plays the browser: follows the authorization URL's redirect with `query`. */
  function browser(query: (authorization: URL) => Record<string, string>) {
    const visited: URL[] = [];
    return {
      visited,
      onAuthorizationUrl: async (href: string) => {
        const authorization = new URL(href);
        visited.push(authorization);
        const redirect = new URL(authorization.searchParams.get("redirect_uri") ?? "");
        // A stray request first: it must not count as the callback.
        await fetch(new URL("/favicon.ico", redirect));
        for (const [name, value] of Object.entries(query(authorization))) {
          redirect.searchParams.set(name, value);
        }
        const page = await fetch(redirect);
        expect(page.status).toBe(200);
      },
    };
  }

  async function tokenServer(
    answer: FakeResponse = { status: 200, json: { access_token: "at", refresh_token: "rt" } },
  ) {
    return serve(() => answer);
  }

  function options(fake: FakeHttpServer, onAuthorizationUrl: (href: string) => Promise<void>) {
    return {
      service: "Test Box",
      authorizationUrl: "https://auth.example.com/oauth2/authorize",
      tokenUrl: `${fake.url}/token`,
      client,
      scopes: ["files.read"],
      authorizationParams: { token_access_type: "offline" },
      onAuthorizationUrl,
    };
  }

  it("runs PKCE on a loopback redirect and exchanges the code once", async () => {
    const fake = await tokenServer();
    const play = browser((authorization) => ({
      code: "the-code",
      state: authorization.searchParams.get("state") ?? "",
    }));
    const tokens = await runBrowserFlow(options(fake, play.onAuthorizationUrl));
    expect(tokens).toMatchObject({ accessToken: "at", refreshToken: "rt" });

    const authorization = play.visited[0];
    expect(`${authorization?.origin}${authorization?.pathname}`).toBe(
      "https://auth.example.com/oauth2/authorize",
    );
    const params = Object.fromEntries(authorization?.searchParams ?? []);
    expect(params).toMatchObject({
      response_type: "code",
      client_id: "client-123",
      code_challenge_method: "S256",
      scope: "files.read",
      token_access_type: "offline",
    });
    expect(params.redirect_uri).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);
    expect(params.state).toMatch(/^[A-Za-z0-9_-]{32}$/);

    // The verifier sent to the token endpoint matches the challenge in the URL.
    const exchange = form(fake.requests[0]);
    expect(exchange).toMatchObject({
      grant_type: "authorization_code",
      code: "the-code",
      redirect_uri: params.redirect_uri,
      client_id: "client-123",
    });
    const challenge = createHash("sha256")
      .update(exchange.code_verifier ?? "")
      .digest("base64url");
    expect(challenge).toBe(params.code_challenge);
    expect(fake.requests).toHaveLength(1);
  });

  it("refuses a callback with the wrong state, and closes the listener", async () => {
    const fake = await tokenServer();
    let redirectUri = "";
    const play = browser((authorization) => {
      redirectUri = authorization.searchParams.get("redirect_uri") ?? "";
      return { code: "the-code", state: "forged" };
    });
    const error = await failure(runBrowserFlow(options(fake, play.onAuthorizationUrl)));
    expect(isMongoShieldError(error, "MS_STORAGE_FORBIDDEN")).toBe(true);
    expect(String(error)).toContain("wrong state");
    // No code exchange happened, and the port is closed now.
    expect(fake.requests).toHaveLength(0);
    expect(
      await fetch(redirectUri).then(
        () => "open",
        () => "closed",
      ),
    ).toBe("closed");
  });

  it("reports a declined consent as MS_STORAGE_FORBIDDEN", async () => {
    const fake = await tokenServer();
    const play = browser((authorization) => ({
      error: "access_denied",
      state: authorization.searchParams.get("state") ?? "",
    }));
    const error = await failure(runBrowserFlow(options(fake, play.onAuthorizationUrl)));
    expect(isMongoShieldError(error, "MS_STORAGE_FORBIDDEN")).toBe(true);
    expect(String(error)).toContain("declined");
  });

  it("times out with MS_TIMEOUT when the browser never comes back", async () => {
    const fake = await tokenServer();
    const error = await failure(
      runBrowserFlow({ ...options(fake, async () => {}), timeoutMs: 30 }),
    );
    expect(isMongoShieldError(error, "MS_TIMEOUT")).toBe(true);
  });

  it("stops with MS_ABORTED on Ctrl-C", async () => {
    const fake = await tokenServer();
    const controller = new AbortController();
    const error = await failure(
      runBrowserFlow({
        ...options(fake, async () => {
          setTimeout(() => controller.abort(), 10);
        }),
        signal: controller.signal,
      }),
    );
    expect(isMongoShieldError(error, "MS_ABORTED")).toBe(true);
  });

  it("makes a fresh 43-character verifier and its S256 challenge", () => {
    const first = createPkcePair();
    expect(first.verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(first.challenge).toBe(createHash("sha256").update(first.verifier).digest("base64url"));
    expect(createPkcePair().verifier).not.toBe(first.verifier);
  });
});

describe("createAccessTokenSource", () => {
  function source(
    fake: FakeHttpServer,
    extra: Partial<Parameters<typeof createAccessTokenSource>[0]> = {},
  ) {
    return createAccessTokenSource({
      service: "Test Drive",
      tokenUrl: `${fake.url}/token`,
      client,
      refreshToken: "refresh-1",
      authHint: "Run `mongoshield login test` again.",
      ...extra,
    });
  }

  it("refreshes once, caches the access token and refreshes shortly before it expires", async () => {
    let issued = 0;
    const fake = await serve(() => {
      issued += 1;
      return { status: 200, json: { access_token: `access-${issued}`, expires_in: 3600 } };
    });
    let clock = 0;
    const tokens = source(fake, { now: () => clock });
    expect(await tokens.getAccessToken()).toBe("access-1");
    clock = 3_600_000 - 61_000;
    expect(await tokens.getAccessToken()).toBe("access-1");
    clock = 3_600_000 - 59_000;
    expect(await tokens.getAccessToken()).toBe("access-2");
    expect(form(fake.requests[0])).toEqual({
      grant_type: "refresh_token",
      refresh_token: "refresh-1",
      client_id: "client-123",
    });
  });

  it("shares one refresh between concurrent callers", async () => {
    const fake = await serve(() => ({
      status: 200,
      delayMs: 20,
      json: { access_token: "shared" },
    }));
    const tokens = source(fake);
    const all = await Promise.all([
      tokens.getAccessToken(),
      tokens.getAccessToken(),
      tokens.getAccessToken(),
    ]);
    expect(all).toEqual(["shared", "shared", "shared"]);
    expect(fake.requests).toHaveLength(1);
  });

  it("refreshes again on forceRefresh (after a 401)", async () => {
    let issued = 0;
    const fake = await serve(() => ({ status: 200, json: { access_token: `access-${++issued}` } }));
    const tokens = source(fake);
    await tokens.getAccessToken();
    expect(await tokens.getAccessToken({ forceRefresh: true })).toBe("access-2");
  });

  it("hands a rotated refresh token to the hook and uses it from then on", async () => {
    let issued = 0;
    const fake = await serve(() => {
      issued += 1;
      return {
        status: 200,
        json: {
          access_token: `access-${issued}`,
          refresh_token: `refresh-${issued + 1}`,
          expires_in: 1,
        },
      };
    });
    const rotated: string[] = [];
    const tokens = source(fake, {
      scopes: ["Files.ReadWrite.AppFolder", "offline_access"],
      onRefreshTokenRotated: (token) => void rotated.push(token),
    });
    await tokens.getAccessToken();
    await tokens.getAccessToken();
    expect(rotated).toEqual(["refresh-2", "refresh-3"]);
    expect(tokens.currentRefreshToken()).toBe("refresh-3");
    expect(form(fake.requests[1])).toMatchObject({
      refresh_token: "refresh-2",
      scope: "Files.ReadWrite.AppFolder offline_access",
    });
  });

  it("turns invalid_grant into MS_STORAGE_FORBIDDEN with the login hint, never echoing the token", async () => {
    const fake = await serve(() => ({
      status: 400,
      json: { error: "invalid_grant", error_description: "Token has been expired or revoked." },
    }));
    const error = await failure(source(fake).getAccessToken());
    expect(isMongoShieldError(error, "MS_STORAGE_FORBIDDEN")).toBe(true);
    expect(isMongoShieldError(error) && error.hint).toBe("Run `mongoshield login test` again.");
    expect(String(error)).not.toContain("refresh-1");
  });

  it("does not cache a failed refresh", async () => {
    let calls = 0;
    const fake = await serve(() => {
      calls += 1;
      return calls === 1
        ? { status: 400, json: { error: "temporarily_unavailable" } }
        : { status: 200, json: { access_token: "ok" } };
    });
    const tokens = source(fake);
    await failure(tokens.getAccessToken());
    expect(await tokens.getAccessToken()).toBe("ok");
  });

  it("refuses an empty refresh token up front", () => {
    let caught: unknown;
    try {
      createAccessTokenSource({
        service: "Test Drive",
        tokenUrl: "http://x",
        client,
        refreshToken: " ",
      });
    } catch (error) {
      caught = error;
    }
    expect(isMongoShieldError(caught, "MS_CONFIG_INVALID")).toBe(true);
  });
});
