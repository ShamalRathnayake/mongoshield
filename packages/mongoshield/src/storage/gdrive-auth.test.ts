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
