/**
 * Tests for the generic login providers (flows.ts) against a fake authorization
 * server: the browser provider end to end (with a scripted "browser" following the
 * redirect), a sign-in without a refresh token, and apps without the endpoint a
 * flow needs. Also the gh helper's input checks.
 */

import { afterEach, describe, expect, it } from "vitest";
import {
  type FakeHttpServer,
  type FakeResponse,
  startFakeHttpServer,
} from "../../../test/helpers/fake-http-server.ts";
import { isMongoShieldError } from "../../errors.ts";
import { OAUTH_APPS } from "../../storage/oauth/apps.ts";
import { setGitHubSecret } from "../github/secrets.ts";
import { browserLoginProvider, deviceLoginProvider } from "./flows.ts";
import type { LoginInstructions } from "./types.ts";

let server: FakeHttpServer | undefined;

afterEach(async () => {
  await server?.close();
  server = undefined;
});

async function failure(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => undefined,
    (error: unknown) => error,
  );
}

async function tokenServer(answer: FakeResponse): Promise<FakeHttpServer> {
  server = await startFakeHttpServer(() => answer);
  return server;
}

describe("browserLoginProvider", () => {
  it("signs in through the loopback redirect and returns the refresh token", async () => {
    const fake = await tokenServer({ json: { access_token: "at", refresh_token: "rt-dropbox" } });
    const provider = browserLoginProvider({
      ...OAUTH_APPS.dropbox,
      endpoints: {
        authorization: "https://auth.example.com/oauth2/authorize",
        token: `${fake.url}/token`,
      },
    });
    expect(provider).toMatchObject({
      id: "dropbox",
      tokenEnv: "MONGOSHIELD_DROPBOX_TOKEN",
      flow: "browser",
    });
    const shown: LoginInstructions[] = [];
    const result = await provider.login({
      env: { MONGOSHIELD_DROPBOX_CLIENT_ID: "app-key" },
      signal: new AbortController().signal,
      show: (instructions) => {
        shown.push(instructions);
        if (instructions.kind !== "open-url") return;
        // Play the browser: come back to the redirect URI with the code and state.
        const authorization = new URL(instructions.url);
        const redirect = new URL(authorization.searchParams.get("redirect_uri") ?? "");
        redirect.searchParams.set("code", "the-code");
        redirect.searchParams.set("state", authorization.searchParams.get("state") ?? "");
        void fetch(redirect);
      },
    });
    expect(result).toEqual({ refreshToken: "rt-dropbox" });
    const url = shown[0]?.kind === "open-url" ? new URL(shown[0].url) : undefined;
    expect(url?.searchParams.get("token_access_type")).toBe("offline");
    expect(url?.searchParams.get("client_id")).toBe("app-key");
  });

  it("uses a fixed --port when given", async () => {
    const fake = await tokenServer({ json: { access_token: "at", refresh_token: "rt" } });
    const provider = browserLoginProvider({
      ...OAUTH_APPS.dropbox,
      endpoints: {
        authorization: "https://auth.example.com/authorize",
        token: `${fake.url}/token`,
      },
    });
    // Find a free port, then ask for it.
    const probe = await startFakeHttpServer(() => ({}));
    const port = probe.port;
    await probe.close();
    let redirectUri = "";
    await provider.login({
      env: { MONGOSHIELD_DROPBOX_CLIENT_ID: "app-key" },
      signal: new AbortController().signal,
      port,
      show: (instructions) => {
        if (instructions.kind !== "open-url") return;
        const authorization = new URL(instructions.url);
        redirectUri = authorization.searchParams.get("redirect_uri") ?? "";
        const redirect = new URL(redirectUri);
        redirect.searchParams.set("code", "c");
        redirect.searchParams.set("state", authorization.searchParams.get("state") ?? "");
        void fetch(redirect);
      },
    });
    expect(redirectUri).toBe(`http://127.0.0.1:${port}/callback`);
  });

  it("refuses an app without an authorization endpoint", () => {
    let caught: unknown;
    try {
      browserLoginProvider(OAUTH_APPS.gdrive);
    } catch (error) {
      caught = error;
    }
    expect(isMongoShieldError(caught, "MS_INTERNAL")).toBe(true);
  });
});

describe("deviceLoginProvider", () => {
  it("fails with MS_STORAGE_FORBIDDEN when the provider returns no refresh token", async () => {
    server = await startFakeHttpServer((request) =>
      request.path === "/device"
        ? {
            json: {
              device_code: "d",
              user_code: "U",
              verification_uri: "https://example.com/device",
              interval: 1,
            },
          }
        : { json: { access_token: "only-an-access-token" } },
    );
    const provider = deviceLoginProvider({
      ...OAUTH_APPS.onedrive,
      endpoints: { deviceAuthorization: `${server.url}/device`, token: `${server.url}/token` },
    });
    const error = await failure(
      provider.login({
        env: { MONGOSHIELD_ONEDRIVE_CLIENT_ID: "own" },
        signal: new AbortController().signal,
        show: () => {},
      }),
    );
    expect(isMongoShieldError(error, "MS_STORAGE_FORBIDDEN")).toBe(true);
    expect(isMongoShieldError(error) && error.hint).toContain("mongoshield login onedrive");
  });

  it("refuses an app without a device authorization endpoint", () => {
    let caught: unknown;
    try {
      deviceLoginProvider(OAUTH_APPS.dropbox);
    } catch (error) {
      caught = error;
    }
    expect(isMongoShieldError(caught, "MS_INTERNAL")).toBe(true);
  });
});

describe("setGitHubSecret", () => {
  it("refuses a repository that is not owner/name before running gh", async () => {
    const error = await failure(
      setGitHubSecret("MONGOSHIELD_GDRIVE_TOKEN", "x", { repo: "not a repo", cwd: ".", env: {} }),
    );
    expect(isMongoShieldError(error, "MS_CONFIG_INVALID")).toBe(true);
    expect(isMongoShieldError(error) && error.hint).toContain("owner/name");
  });

  it("refuses a secret name gh would not take", async () => {
    const error = await failure(setGitHubSecret("not-a-name", "x", { cwd: ".", env: {} }));
    expect(isMongoShieldError(error, "MS_INTERNAL")).toBe(true);
  });
});
