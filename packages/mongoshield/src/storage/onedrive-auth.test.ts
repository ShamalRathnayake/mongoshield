/**
 * Tests for the OneDrive sign-in: the device code flow, the refresh grant, the secret
 * envelope and client id resolution, against the fake identity platform in
 * test/helpers/fake-onedrive-server.ts.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type FakeOneDriveServer,
  startFakeOneDriveServer,
} from "../../test/helpers/fake-onedrive-server.ts";
import { isMongoShieldError, type MongoShieldError } from "../errors.ts";
import {
  encodeOneDriveSecret,
  type LoginOneDriveOptions,
  loginOneDrive,
  ONEDRIVE_SECRET_NAME,
  parseOneDriveSecret,
  refreshOneDriveToken,
  resolveOneDriveClient,
  SHIPPED_ONEDRIVE_CLIENT_ID,
  SIGN_IN_EXPIRED_REASON,
} from "./onedrive-auth.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

async function rejection(promise: Promise<unknown>): Promise<MongoShieldError> {
  const error = await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  if (!isMongoShieldError(error))
    throw new Error(`expected a MongoShieldError, got ${String(error)}`);
  return error;
}

describe("OneDrive sign-in", () => {
  let server: FakeOneDriveServer;
  let clock: Date;

  beforeEach(async () => {
    clock = new Date("2026-11-05T00:00:00Z");
    server = await startFakeOneDriveServer({ now: () => clock });
  });

  afterEach(async () => {
    await server.close();
  });

  function login(overrides: Partial<LoginOneDriveOptions> = {}) {
    const prompts: { userCode?: string; verificationUrl: string }[] = [];
    const result = loginOneDrive({
      clientId: server.clientId,
      authorityUrl: server.authorityUrl,
      now: () => clock,
      onPrompt: (prompt) => prompts.push(prompt),
      ...overrides,
    });
    return { result, prompts };
  }

  describe("loginOneDrive", () => {
    it("shows the code, waits for approval and returns the secret to store", async () => {
      server.device.pendingPolls = 2;
      const { result, prompts } = login();
      const { refreshToken, secretName } = await result;

      expect(prompts).toEqual([
        { userCode: "ABCD-EFGH", verificationUrl: "https://microsoft.com/devicelogin" },
      ]);
      expect(secretName).toBe(ONEDRIVE_SECRET_NAME);
      expect(refreshToken).toMatch(/^onedrive1\./);
      const credential = parseOneDriveSecret(refreshToken);
      expect(credential.issuedAt).toEqual(new Date(Math.floor(clock.getTime() / 1000) * 1000));
      expect(credential.tenant).toBe("consumers");
      expect(credential.clientId).toBe(server.clientId);
      expect(server.device.lastTenant).toBe("consumers");
    });

    it("signs in through /common with the business opt-in", async () => {
      const { refreshToken } = await login({ business: true }).result;
      expect(server.device.lastTenant).toBe("common");
      expect(parseOneDriveSecret(refreshToken).tenant).toBe("common");
    });

    it("slows down when asked to", { timeout: 20_000 }, async () => {
      server.device.slowDownOnce = true;
      // Approve on the poll right after the slow_down, so the test waits one interval.
      server.device.pendingPolls = 0;
      const started = Date.now();
      await login().result;
      // RFC 8628: slow_down adds 5 seconds to the interval (0 in the fake).
      expect(Date.now() - started).toBeGreaterThanOrEqual(4900);
    });

    it("fails with MS_STORAGE_FORBIDDEN when the user declines", async () => {
      server.device.decline = true;
      const error = await rejection(login().result);
      expect(error.code).toBe("MS_STORAGE_FORBIDDEN");
      expect(error.message).toMatch(/declined/);
    });

    it("fails with MS_TIMEOUT when the code expires", async () => {
      server.device.expire = true;
      const error = await rejection(login().result);
      expect(error.code).toBe("MS_TIMEOUT");
    });

    it("refuses an empty client id with setup instructions", async () => {
      const error = await rejection(login({ clientId: " " }).result);
      expect(error.code).toBe("MS_CONFIG_INVALID");
      expect(error.hint).toMatch(/MONGOSHIELD_ONEDRIVE_CLIENT_ID/);
    });

    it("explains an unknown client id", async () => {
      const error = await rejection(login({ clientId: "someone-else" }).result);
      expect(error.code).toBe("MS_STORAGE_FORBIDDEN");
      expect(error.hint).toMatch(/Allow public client flows/);
    });

    it("stops with MS_ABORTED when cancelled while polling", async () => {
      server.device.pendingPolls = 1_000_000;
      const controller = new AbortController();
      const { result } = login({ signal: controller.signal });
      setTimeout(() => controller.abort(), 50);
      const error = await rejection(result);
      expect(error.code).toBe("MS_ABORTED");
    });

    it("uses the fetch it is given", async () => {
      const urls: string[] = [];
      const recordingFetch: typeof fetch = (input, init) => {
        urls.push(new URL(String(input)).pathname);
        return fetch(input, init);
      };
      await login({ fetch: recordingFetch }).result;
      expect(urls[0]).toBe("/consumers/oauth2/v2.0/devicecode");
      expect(urls.at(-1)).toBe("/consumers/oauth2/v2.0/token");
    });
  });

  describe("refreshOneDriveToken", () => {
    it("returns an access token and a new refresh token", async () => {
      const original = server.issueRefreshToken();
      const tokens = await refreshOneDriveToken({
        refreshToken: original,
        clientId: server.clientId,
        tenant: "consumers",
        authorityUrl: server.authorityUrl,
      });
      expect(tokens.accessToken).toMatch(/^at-/);
      expect(tokens.rotated).toBe(true);
      expect(tokens.refreshToken).not.toBe(original);
      expect(tokens.expiresInSeconds).toBe(3600);
    });

    it("reports an expired token as MS_STORAGE_FORBIDDEN with a sign-in hint, never quoting it", async () => {
      const original = server.issueRefreshToken({
        issuedAt: new Date(clock.getTime() - 90 * DAY_MS),
      });
      const error = await rejection(
        refreshOneDriveToken({
          refreshToken: original,
          clientId: server.clientId,
          tenant: "consumers",
          authorityUrl: server.authorityUrl,
        }),
      );
      expect(error.code).toBe("MS_STORAGE_FORBIDDEN");
      expect(error.details).toMatchObject({
        reason: SIGN_IN_EXPIRED_REASON,
        microsoftErrorCodes: [70008],
      });
      expect(error.hint).toMatch(/login onedrive/);
      expect(error.message).not.toContain(original);
    });

    it("retries a throttled token endpoint", async () => {
      let calls = 0;
      const flakyFetch: typeof fetch = (input, init) => {
        calls++;
        if (calls === 1)
          return Promise.resolve(
            new Response("busy", { status: 503, headers: { "Retry-After": "0" } }),
          );
        return fetch(input, init);
      };
      const tokens = await refreshOneDriveToken({
        refreshToken: server.issueRefreshToken(),
        clientId: server.clientId,
        tenant: "consumers",
        authorityUrl: server.authorityUrl,
        fetch: flakyFetch,
      });
      expect(tokens.accessToken).toMatch(/^at-/);
      expect(calls).toBe(2);
    });
  });

  describe("the secret envelope", () => {
    it("round-trips every field", () => {
      const credential = {
        refreshToken: "M.C5_BAY.token",
        issuedAt: new Date("2026-11-05T10:00:00Z"),
        tenant: "consumers" as const,
        clientId: "client-1",
      };
      expect(parseOneDriveSecret(encodeOneDriveSecret(credential))).toEqual(credential);
    });

    it("accepts a bare refresh token with an unknown issue time", () => {
      expect(parseOneDriveSecret("  M.C5_BAY.bare  ")).toEqual({ refreshToken: "M.C5_BAY.bare" });
    });

    it("rejects an empty or damaged secret without quoting it", () => {
      expect(() => parseOneDriveSecret(" ")).toThrow(/is empty/);
      const damaged = `onedrive1.${Buffer.from('{"iat":1}').toString("base64url")}`;
      try {
        parseOneDriveSecret(damaged);
        expect.unreachable();
      } catch (error) {
        expect((error as MongoShieldError).code).toBe("MS_CONFIG_INVALID");
        expect((error as MongoShieldError).message).not.toContain(damaged);
      }
    });
  });

  describe("resolveOneDriveClient", () => {
    it("reads the client id and secret from the environment", () => {
      expect(
        resolveOneDriveClient({
          MONGOSHIELD_ONEDRIVE_CLIENT_ID: " my-app ",
          MONGOSHIELD_ONEDRIVE_CLIENT_SECRET: "shh",
        }),
      ).toEqual({ clientId: "my-app", clientSecret: "shh" });
      expect(resolveOneDriveClient({ MONGOSHIELD_ONEDRIVE_CLIENT_ID: "my-app" })).toEqual({
        clientId: "my-app",
      });
    });

    it.skipIf(SHIPPED_ONEDRIVE_CLIENT_ID !== "")(
      "fails with registration steps while no app is shipped",
      () => {
        expect(() => resolveOneDriveClient({})).toThrow(/No Microsoft app/);
      },
    );
  });
});
