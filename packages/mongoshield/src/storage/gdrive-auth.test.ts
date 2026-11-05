/**
 * Tests for the Google Drive login (device flow) and the refresh-token exchange,
 * against the fake OAuth endpoints of test/helpers/fake-gdrive-server.ts. Polling
 * waits go through an injected `sleep`, so nothing waits for real.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type FakeGdriveServer,
  startFakeGdriveServer,
} from "../../test/helpers/fake-gdrive-server.ts";
import { isMongoShieldError } from "../errors.ts";
import {
  abortableSleep,
  exchangeGdriveRefreshToken,
  GDRIVE_SCOPE,
  GDRIVE_TOKEN_SECRET,
  type GdriveLoginPrompt,
  gdriveClientCredentials,
  loginGdrive,
} from "./gdrive-auth.ts";

/** The error a promise rejects with. */
async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error("expected a rejection");
    },
    (error: unknown) => error,
  );
}

describe("loginGdrive", () => {
  let server: FakeGdriveServer;
  let waits: number[];
  let prompts: GdriveLoginPrompt[];

  beforeEach(async () => {
    server = await startFakeGdriveServer();
    waits = [];
    prompts = [];
  });
  afterEach(async () => {
    await server.close();
  });

  function login(extra: { clientId?: string; signal?: AbortSignal } = {}) {
    return loginGdrive({
      clientId: extra.clientId ?? server.clientId,
      clientSecret: server.clientSecret,
      deviceCodeUrl: server.deviceCodeUrl,
      tokenUrl: server.tokenUrl,
      onPrompt: (prompt) => prompts.push(prompt),
      sleep: async (milliseconds) => {
        waits.push(milliseconds);
      },
      ...(extra.signal ? { signal: extra.signal } : {}),
    });
  }

  it("shows the user code and returns the refresh token with its secret name", async () => {
    server.deviceLogin = { pendingPolls: 2 };
    const result = await login();
    expect(prompts).toEqual([
      { userCode: "ABCD-EFGH", verificationUrl: "https://www.google.com/device" },
    ]);
    expect(result).toEqual({ refreshToken: server.refreshToken, secretName: GDRIVE_TOKEN_SECRET });
    expect(result.secretName).toBe("MONGOSHIELD_GDRIVE_TOKEN");
    // Polls at the interval Google asked for (5 s), until approved.
    expect(waits).toEqual([5000, 5000, 5000]);
  });

  it("asks only for the drive.file scope", async () => {
    await login();
    expect(GDRIVE_SCOPE).toBe("https://www.googleapis.com/auth/drive.file");
  });

  it("polls 5 seconds less often after slow_down", async () => {
    server.deviceLogin = { slowDownOnce: true };
    await login();
    expect(waits).toEqual([5000, 10000]);
  });

  it("fails with MS_ABORTED when the user declines", async () => {
    server.deviceLogin = { outcome: "deny" };
    const error = await rejectionOf(login());
    expect(isMongoShieldError(error, "MS_ABORTED")).toBe(true);
    expect(String(error)).toMatch(/declined/);
  });

  it("fails with MS_TIMEOUT when the code expires", async () => {
    server.deviceLogin = { outcome: "expire" };
    expect(isMongoShieldError(await rejectionOf(login()), "MS_TIMEOUT")).toBe(true);
  });

  it("explains an unknown OAuth client", async () => {
    const error = await rejectionOf(login({ clientId: "wrong" }));
    expect(isMongoShieldError(error, "MS_CONFIG_INVALID")).toBe(true);
    expect((error as { hint?: string }).hint).toMatch(/TVs and Limited Input devices/);
  });

  it("stops with MS_ABORTED when the signal fires", async () => {
    expect(
      isMongoShieldError(await rejectionOf(login({ signal: AbortSignal.abort() })), "MS_ABORTED"),
    ).toBe(true);
  });
});

describe("exchangeGdriveRefreshToken", () => {
  let server: FakeGdriveServer;

  beforeEach(async () => {
    server = await startFakeGdriveServer();
  });
  afterEach(async () => {
    await server.close();
  });

  it("returns an access token and its expiry", async () => {
    const before = Date.now();
    const token = await exchangeGdriveRefreshToken({
      clientId: server.clientId,
      clientSecret: server.clientSecret,
      refreshToken: server.refreshToken,
      tokenUrl: server.tokenUrl,
    });
    expect(token.accessToken).toMatch(/^ya29\./);
    expect(token.expiresAt.getTime()).toBeGreaterThan(before + 3000_000);
  });

  it("fails with MS_STORAGE_FORBIDDEN and a login hint for a revoked token, without echoing it", async () => {
    const refreshToken = server.refreshToken;
    server.revokeRefreshToken();
    const error = await rejectionOf(
      exchangeGdriveRefreshToken({
        clientId: server.clientId,
        clientSecret: server.clientSecret,
        refreshToken,
        tokenUrl: server.tokenUrl,
      }),
    );
    expect(isMongoShieldError(error, "MS_STORAGE_FORBIDDEN")).toBe(true);
    expect((error as { hint?: string }).hint).toMatch(/mongoshield login gdrive/);
    expect(JSON.stringify(error)).not.toContain(refreshToken);
    expect(String(error)).not.toContain(refreshToken);
  });

  it("retries 5xx answers before giving up", async () => {
    let calls = 0;
    const flaky: typeof fetch = async (input, init) => {
      calls++;
      if (calls < 3) return new Response("busy", { status: 503 });
      return fetch(input, init);
    };
    const token = await exchangeGdriveRefreshToken({
      clientId: server.clientId,
      clientSecret: server.clientSecret,
      refreshToken: server.refreshToken,
      tokenUrl: server.tokenUrl,
      fetch: flaky,
      sleep: async () => {},
    });
    expect(token.accessToken).toBeTruthy();
    expect(calls).toBe(3);
  });

  it("reports an unreachable token endpoint as MS_STORAGE_IO", async () => {
    const error = await rejectionOf(
      exchangeGdriveRefreshToken({
        clientId: "id",
        refreshToken: "token",
        fetch: async () => {
          throw new TypeError("fetch failed");
        },
        sleep: async () => {},
      }),
    );
    expect(isMongoShieldError(error, "MS_STORAGE_IO")).toBe(true);
  });
});

/**
 * A scripted OAuth endpoint: answers each POST with the next of `answers` (JSON
 * bodies, or a raw string body), and records every form it was sent.
 */
function scriptedEndpoint(answers: readonly { status?: number; body: unknown }[]) {
  const forms: { url: string; form: URLSearchParams }[] = [];
  let next = 0;
  const fetchFn: typeof fetch = async (input, init) => {
    forms.push({ url: String(input), form: new URLSearchParams(String(init?.body ?? "")) });
    const answer = answers[Math.min(next++, answers.length - 1)] ?? { body: {} };
    const text = typeof answer.body === "string" ? answer.body : JSON.stringify(answer.body);
    return new Response(text, { status: answer.status ?? 200 });
  };
  return { fetch: fetchFn, forms };
}

/** A device-code answer that polls immediately (interval 0) unless told otherwise. */
const DEVICE_CODE = {
  device_code: "device-1",
  user_code: "WXYZ-1234",
  verification_url: "https://www.google.com/device",
  expires_in: 1800,
  interval: 0,
};

describe("loginGdrive against scripted answers", () => {
  function scriptedLogin(
    answers: readonly { status?: number; body: unknown }[],
    extra: { clientSecret?: string; signal?: AbortSignal; useRealSleep?: boolean } = {},
  ) {
    const endpoint = scriptedEndpoint(answers);
    const prompts: GdriveLoginPrompt[] = [];
    const waits: number[] = [];
    const result = loginGdrive({
      clientId: "client-1",
      ...(extra.clientSecret === undefined ? {} : { clientSecret: extra.clientSecret }),
      onPrompt: (prompt) => prompts.push(prompt),
      fetch: endpoint.fetch,
      ...(extra.useRealSleep
        ? {}
        : {
            sleep: async (milliseconds: number) => {
              waits.push(milliseconds);
            },
          }),
      ...(extra.signal ? { signal: extra.signal } : {}),
    });
    return { result, forms: endpoint.forms, prompts, waits };
  }

  it("talks to Google's own endpoints by default, without a client secret when none is given", async () => {
    const { result, forms } = scriptedLogin([
      { body: DEVICE_CODE },
      { body: { access_token: "ya29.x", refresh_token: "1//new" } },
    ]);
    expect((await result).refreshToken).toBe("1//new");
    expect(forms.map((entry) => entry.url)).toEqual([
      "https://oauth2.googleapis.com/device/code",
      "https://oauth2.googleapis.com/token",
    ]);
    expect(forms[0]?.form.get("scope")).toBe(GDRIVE_SCOPE);
    expect(forms[1]?.form.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:device_code");
    expect(forms[1]?.form.get("device_code")).toBe("device-1");
    expect(forms[1]?.form.has("client_secret")).toBe(false);
  });

  it("waits with the built-in sleep when none is injected", async () => {
    const { result } = scriptedLogin(
      [{ body: DEVICE_CODE }, { body: { refresh_token: "1//new" } }],
      { useRealSleep: true },
    );
    expect((await result).refreshToken).toBe("1//new");
  });

  it("accepts RFC 8628's verification_uri and Google's defaults for a missing interval and expiry", async () => {
    const { result, prompts, waits } = scriptedLogin([
      {
        body: {
          device_code: "device-1",
          user_code: "WXYZ-1234",
          verification_uri: "https://example.com/activate",
        },
      },
      { body: { refresh_token: "1//new" } },
    ]);
    await result;
    expect(prompts).toEqual([
      { userCode: "WXYZ-1234", verificationUrl: "https://example.com/activate" },
    ]);
    // Google's documented default interval: 5 seconds.
    expect(waits).toEqual([5000]);
  });

  it("reads the interval when Google sends it as a string", async () => {
    const { result, waits } = scriptedLogin([
      { body: { ...DEVICE_CODE, interval: "7" } },
      { body: { refresh_token: "1//new" } },
    ]);
    await result;
    expect(waits).toEqual([7000]);
  });

  it("ignores an interval that is not a number", async () => {
    const { result, waits } = scriptedLogin([
      { body: { ...DEVICE_CODE, interval: "soon" } },
      { body: { refresh_token: "1//new" } },
    ]);
    await result;
    expect(waits).toEqual([5000]);
  });

  it("fails with MS_STORAGE_IO when Google approves without a refresh token", async () => {
    const { result } = scriptedLogin([{ body: DEVICE_CODE }, { body: { access_token: "ya29.x" } }]);
    const error = await rejectionOf(result);
    expect(isMongoShieldError(error, "MS_STORAGE_IO")).toBe(true);
    expect(String(error)).toMatch(/sent no refresh token/);
  });

  it("fails with MS_TIMEOUT once the code's lifetime has passed without an answer", async () => {
    const { result, forms } = scriptedLogin([{ body: { ...DEVICE_CODE, expires_in: 0 } }]);
    const error = await rejectionOf(result);
    expect(isMongoShieldError(error, "MS_TIMEOUT")).toBe(true);
    expect(String(error)).toMatch(/expired before it was approved/);
    // Only the device-code request: no polling after the deadline.
    expect(forms).toHaveLength(1);
  });

  it("explains a client Google calls unauthorized for the device flow", async () => {
    const { result } = scriptedLogin([{ status: 401, body: { error: "unauthorized_client" } }]);
    const error = await rejectionOf(result);
    expect(isMongoShieldError(error, "MS_CONFIG_INVALID")).toBe(true);
    expect((error as { details?: { httpStatus?: number } }).details?.httpStatus).toBe(401);
  });

  it("reports another device-code failure with its status and error", async () => {
    const { result } = scriptedLogin([{ status: 400, body: { error: "invalid_scope" } }]);
    const error = await rejectionOf(result);
    expect(isMongoShieldError(error, "MS_STORAGE_IO")).toBe(true);
    expect(String(error)).toMatch(/Could not start the Google login \(HTTP 400, invalid_scope\)/);
  });

  it("reports a device-code answer that is not JSON, or misses fields, by its status alone", async () => {
    const html = scriptedLogin([{ status: 404, body: "<html>Not Found</html>" }]);
    expect(String(await rejectionOf(html.result))).toMatch(/\(HTTP 404\)\.$/);
    // 200 but no user code: not something a user could act on.
    const partial = scriptedLogin([{ body: { device_code: "d", verification_url: "u" } }]);
    expect(String(await rejectionOf(partial.result))).toMatch(/\(HTTP 200\)\.$/);
  });

  it("treats a JSON answer that is not an object as empty", async () => {
    const { result } = scriptedLogin([{ status: 400, body: "null" }]);
    expect(String(await rejectionOf(result))).toMatch(/\(HTTP 400\)\.$/);
  });

  it("explains a Workspace policy that blocks the app, with Google's description", async () => {
    const { result } = scriptedLogin([
      { body: DEVICE_CODE },
      {
        status: 400,
        body: { error: "admin_policy_enforced", error_description: "Blocked by admin" },
      },
    ]);
    const error = await rejectionOf(result);
    expect(isMongoShieldError(error, "MS_STORAGE_FORBIDDEN")).toBe(true);
    expect(String(error)).toMatch(/Google refused the login: Blocked by admin\./);
    expect((error as { hint?: string }).hint).toMatch(/Workspace policy/);
  });

  it("explains an internal-only app without a description, by its error code", async () => {
    const { result } = scriptedLogin([
      { body: DEVICE_CODE },
      { status: 403, body: { error: "org_internal" } },
    ]);
    const error = await rejectionOf(result);
    expect(isMongoShieldError(error, "MS_STORAGE_FORBIDDEN")).toBe(true);
    expect(String(error)).toMatch(/Google refused the login: org_internal\./);
  });

  it("reports an unknown polling error with and without an error code", async () => {
    const named = scriptedLogin([
      { body: DEVICE_CODE },
      { status: 400, body: { error: "invalid_request" } },
    ]);
    const namedError = await rejectionOf(named.result);
    expect(isMongoShieldError(namedError, "MS_STORAGE_IO")).toBe(true);
    expect(String(namedError)).toMatch(/The Google login failed \(HTTP 400, invalid_request\)/);
    const bare = scriptedLogin([{ body: DEVICE_CODE }, { status: 400, body: {} }]);
    expect(String(await rejectionOf(bare.result))).toMatch(/The Google login failed \(HTTP 400\)/);
  });

  it("stops with MS_ABORTED when cancelled between polls", async () => {
    const controller = new AbortController();
    const endpoint = scriptedEndpoint([
      { body: DEVICE_CODE },
      { status: 428, body: { error: "authorization_pending" } },
    ]);
    const error = await rejectionOf(
      loginGdrive({
        clientId: "client-1",
        onPrompt: () => {},
        fetch: endpoint.fetch,
        signal: controller.signal,
        sleep: async () => controller.abort(),
      }),
    );
    expect(isMongoShieldError(error, "MS_ABORTED")).toBe(true);
    // Cancelled after the first wait: no poll was sent.
    expect(endpoint.forms).toHaveLength(1);
  });
});

describe("exchangeGdriveRefreshToken against scripted answers", () => {
  function exchange(answers: readonly { status?: number; body: unknown }[]) {
    const endpoint = scriptedEndpoint(answers);
    const result = exchangeGdriveRefreshToken({
      clientId: "client-1",
      refreshToken: "1//refresh",
      fetch: endpoint.fetch,
      sleep: async () => {},
    });
    return { result, forms: endpoint.forms };
  }

  it("posts to Google's token endpoint by default, without a secret when none is given", async () => {
    const { result, forms } = exchange([{ body: { access_token: "ya29.x", expires_in: 60 } }]);
    const token = await result;
    expect(token.accessToken).toBe("ya29.x");
    expect(forms[0]?.url).toBe("https://oauth2.googleapis.com/token");
    expect(forms[0]?.form.get("grant_type")).toBe("refresh_token");
    expect(forms[0]?.form.has("client_secret")).toBe(false);
  });

  it("assumes an hour when Google does not say how long the token lasts", async () => {
    const before = Date.now();
    const token = await exchange([{ body: { access_token: "ya29.x" } }]).result;
    expect(token.expiresAt.getTime()).toBeGreaterThanOrEqual(before + 3600_000);
    expect(token.expiresAt.getTime()).toBeLessThan(before + 3600_000 + 5_000);
  });

  it("fails with MS_STORAGE_IO when Google answers without an access token", async () => {
    const error = await rejectionOf(exchange([{ body: { expires_in: 3599 } }]).result);
    expect(isMongoShieldError(error, "MS_STORAGE_IO")).toBe(true);
    expect(String(error)).toMatch(/sent no access token/);
    // A 200 whose JSON is not even an object.
    const odd = await rejectionOf(exchange([{ body: "null" }]).result);
    expect(String(odd)).toMatch(/sent no access token/);
  });

  it("retries a 5xx whose body breaks off, and reads a broken error body as empty", async () => {
    /** A body stream that fails at once, like a connection reset mid-response. */
    const brokenBody = () =>
      new ReadableStream({
        start(controller) {
          controller.error(new Error("socket hang up"));
        },
      });
    let calls = 0;
    const error = await rejectionOf(
      exchangeGdriveRefreshToken({
        clientId: "client-1",
        refreshToken: "1//refresh",
        sleep: async () => {},
        fetch: async () => {
          calls++;
          return new Response(brokenBody(), { status: calls === 1 ? 503 : 400 });
        },
      }),
    );
    expect(calls).toBe(2);
    expect(isMongoShieldError(error, "MS_STORAGE_IO")).toBe(true);
    expect(String(error)).toMatch(/\(HTTP 400\)\.$/);
  });

  it("fails with MS_CONFIG_INVALID when Google refuses the OAuth client", async () => {
    for (const code of ["invalid_client", "unauthorized_client"]) {
      const error = await rejectionOf(exchange([{ status: 401, body: { error: code } }]).result);
      expect(isMongoShieldError(error, "MS_CONFIG_INVALID")).toBe(true);
      expect((error as { hint?: string }).hint).toMatch(/MONGOSHIELD_GDRIVE_CLIENT_ID/);
    }
  });

  it("reports another refusal with its status, and its error code when there is one", async () => {
    const named = await rejectionOf(
      exchange([{ status: 400, body: { error: "invalid_request" } }]).result,
    );
    expect(isMongoShieldError(named, "MS_STORAGE_IO")).toBe(true);
    expect(String(named)).toMatch(/\(HTTP 400, invalid_request\)/);
    const bare = await rejectionOf(exchange([{ status: 400, body: "Bad Request" }]).result);
    expect(String(bare)).toMatch(/\(HTTP 400\)\.$/);
  });

  it("retries 429 and 5xx at most four times, then reports the last answer", async () => {
    const { result, forms } = exchange([{ status: 429, body: "slow down" }]);
    const error = await rejectionOf(result);
    expect(forms).toHaveLength(5);
    expect(String(error)).toMatch(/\(HTTP 429\)/);
  });

  it("stops with MS_ABORTED when cancelled during a request, without retrying", async () => {
    const controller = new AbortController();
    let calls = 0;
    const error = await rejectionOf(
      exchangeGdriveRefreshToken({
        clientId: "client-1",
        refreshToken: "1//refresh",
        signal: controller.signal,
        sleep: async () => {},
        fetch: async () => {
          calls++;
          controller.abort();
          throw new DOMException("aborted", "AbortError");
        },
      }),
    );
    expect(isMongoShieldError(error, "MS_ABORTED")).toBe(true);
    expect(calls).toBe(1);
  });
});

describe("abortableSleep", () => {
  it("resolves after the time has passed", async () => {
    const controller = new AbortController();
    await expect(abortableSleep(1, controller.signal)).resolves.toBeUndefined();
    await expect(abortableSleep(1)).resolves.toBeUndefined();
  });

  it("rejects with MS_ABORTED at once for a signal that already fired", async () => {
    const error = await rejectionOf(abortableSleep(60_000, AbortSignal.abort()));
    expect(isMongoShieldError(error, "MS_ABORTED")).toBe(true);
  });

  it("rejects with MS_ABORTED as soon as the signal fires during the wait", async () => {
    const controller = new AbortController();
    const started = Date.now();
    const sleeping = rejectionOf(abortableSleep(60_000, controller.signal));
    setTimeout(() => controller.abort(), 5);
    expect(isMongoShieldError(await sleeping, "MS_ABORTED")).toBe(true);
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});

describe("gdriveClientCredentials", () => {
  it("reads MONGOSHIELD_GDRIVE_CLIENT_ID and _CLIENT_SECRET", () => {
    expect(
      gdriveClientCredentials({
        MONGOSHIELD_GDRIVE_CLIENT_ID: " my-id ",
        MONGOSHIELD_GDRIVE_CLIENT_SECRET: "my-secret",
      }),
    ).toEqual({ clientId: "my-id", clientSecret: "my-secret" });
  });

  it("fails with a hint while no client is shipped or configured", () => {
    const error = (() => {
      try {
        gdriveClientCredentials({});
      } catch (caught) {
        return caught;
      }
      return undefined;
    })();
    expect(isMongoShieldError(error, "MS_CONFIG_INVALID")).toBe(true);
    expect((error as { hint?: string }).hint).toMatch(/MONGOSHIELD_GDRIVE_CLIENT_ID/);
  });
});
