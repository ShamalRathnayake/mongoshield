/**
 * Tests for the Dropbox login (authorization code + PKCE, loopback redirect and
 * pasted code) and the refresh-token exchange, against the fake authorize/token
 * endpoints of test/helpers/fake-dropbox-server.ts. A "browser" here is just fetch
 * following (or not following) the authorize page's redirect.
 */

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type FakeDropboxServer,
  startFakeDropboxServer,
} from "../../test/helpers/fake-dropbox-server.ts";
import { isMongoShieldError } from "../errors.ts";
import {
  DROPBOX_LOOPBACK_PORTS,
  DROPBOX_SCOPES,
  DROPBOX_SHIPPED_CLIENT_ID,
  type DropboxLoginOptions,
  type DropboxLoginPrompt,
  dropboxRedirectUri,
  loginDropbox,
  refreshDropboxAccessToken,
  resolveDropboxClient,
} from "./dropbox-auth.ts";

let server: FakeDropboxServer;

beforeAll(async () => {
  server = await startFakeDropboxServer();
});

afterAll(async () => {
  await server.close();
});

/** Login options against the fake, on a random free port, outside any SSH session. */
function loginOptions(overrides: Partial<DropboxLoginOptions> = {}): DropboxLoginOptions {
  return {
    clientId: server.clientId,
    authorizeUrl: server.authorizeUrl,
    tokenUrl: server.tokenUrl,
    ports: [0],
    env: {},
    onPrompt: (prompt) => {
      void approveInBrowser(prompt);
    },
    ...overrides,
  };
}

/** Plays the user's browser: opens the authorize page and follows its redirect. */
async function approveInBrowser(prompt: DropboxLoginPrompt): Promise<string | null> {
  const page = await fetch(prompt.verificationUrl, { redirect: "manual" });
  const location = page.headers.get("location");
  if (location) await fetch(location);
  return location;
}

/** The code the authorize page shows when no redirect_uri is given (pasted-code flow). */
async function codeShownBy(verificationUrl: string): Promise<string> {
  const page = await fetch(verificationUrl, { redirect: "manual" });
  return page.headers.get("x-fake-code") ?? "";
}

/** Holds a 127.0.0.1 port so the login has to skip it. */
async function occupyPort(): Promise<{ port: number; release: () => Promise<void> }> {
  const blocker: Server = createServer();
  await new Promise<void>((resolve) => blocker.listen(0, "127.0.0.1", resolve));
  const { port } = blocker.address() as AddressInfo;
  return { port, release: () => new Promise((resolve) => blocker.close(() => resolve())) };
}

async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error("expected a rejection");
    },
    (error: unknown) => error,
  );
}

function codeOf(error: unknown): string | undefined {
  return isMongoShieldError(error) ? error.code : undefined;
}

/** The query of the latest authorize request the fake saw. */
function lastAuthorizeQuery(): Record<string, string> {
  const request = server.requests.filter((entry) => entry.endpoint === "/oauth2/authorize").at(-1);
  return (request?.arg ?? {}) as Record<string, string>;
}

describe("loginDropbox", () => {
  it("logs in through the loopback redirect and returns a working refresh token", async () => {
    const prompts: DropboxLoginPrompt[] = [];
    const result = await loginDropbox(
      loginOptions({
        onPrompt: (prompt) => {
          prompts.push(prompt);
          void approveInBrowser(prompt);
        },
      }),
    );
    expect(result.secretName).toBe("MONGOSHIELD_DROPBOX_TOKEN");
    expect(prompts).toHaveLength(1);
    expect(prompts[0]?.mode).toBe("loopback");
    expect(prompts[0]?.userCode).toBeUndefined();

    const query = lastAuthorizeQuery();
    expect(query).toMatchObject({
      client_id: server.clientId,
      response_type: "code",
      code_challenge_method: "S256",
      token_access_type: "offline",
      scope: DROPBOX_SCOPES.join(" "),
    });
    expect(query.redirect_uri).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);
    expect(query.state?.length).toBeGreaterThanOrEqual(16);

    const access = await refreshDropboxAccessToken({
      clientId: server.clientId,
      refreshToken: result.refreshToken,
      tokenUrl: server.tokenUrl,
    });
    expect(access.accessToken).toMatch(/^sl\./);
  });

  it("sends the PKCE verifier and the same redirect_uri in the code exchange, and no secret", async () => {
    await loginDropbox(loginOptions());
    const exchange = server.requests.filter((entry) => entry.endpoint === "/oauth2/token").at(-1);
    const form = exchange?.arg as Record<string, string>;
    expect(form.grant_type).toBe("authorization_code");
    expect(form.code_verifier).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
    expect(form.redirect_uri).toBe(lastAuthorizeQuery().redirect_uri);
    expect(form.client_secret).toBeUndefined();
  });

  it("sends clientSecret in the code exchange when given", async () => {
    await loginDropbox(loginOptions({ clientSecret: "app-secret" }));
    const exchange = server.requests.filter((entry) => entry.endpoint === "/oauth2/token").at(-1);
    expect(exchange?.arg).toMatchObject({ client_secret: "app-secret" });
  });

  it("tries the next port when the first one is in use", async () => {
    const blocker = await occupyPort();
    try {
      await loginDropbox(loginOptions({ ports: [blocker.port, 0] }));
      const redirect = new URL(lastAuthorizeQuery().redirect_uri ?? "");
      expect(Number(redirect.port)).not.toBe(blocker.port);
    } finally {
      await blocker.release();
    }
  });

  it("closes the loopback server afterwards", async () => {
    await loginDropbox(loginOptions());
    const redirect = lastAuthorizeQuery().redirect_uri ?? "";
    await expect(fetch(redirect)).rejects.toThrow();
  });

  it("falls back to the pasted code (no redirect_uri) when every port is busy", async () => {
    const blocker = await occupyPort();
    try {
      let mode: string | undefined;
      let shown: Promise<string> = Promise.resolve("");
      const result = await loginDropbox(
        loginOptions({
          ports: [blocker.port],
          onPrompt: (prompt) => {
            mode = prompt.mode;
            shown = codeShownBy(prompt.verificationUrl);
          },
          readCode: () => shown,
        }),
      );
      expect(mode).toBe("paste");
      expect(lastAuthorizeQuery().redirect_uri).toBeUndefined();
      expect(result.refreshToken).toMatch(/^refresh-/);
    } finally {
      await blocker.release();
    }
  });

  it("fails instead of falling back with mode loopback", async () => {
    const blocker = await occupyPort();
    try {
      const error = await rejectionOf(
        loginDropbox(loginOptions({ mode: "loopback", ports: [blocker.port] })),
      );
      expect(codeOf(error)).toBe("MS_CONFIG_INVALID");
      expect(String(error)).toMatch(/in use/);
    } finally {
      await blocker.release();
    }
  });

  it("uses the pasted code in an SSH session or Codespace", async () => {
    for (const env of [{ SSH_CONNECTION: "1.2.3.4 5 6.7.8.9 22" }, { CODESPACES: "true" }]) {
      let mode: string | undefined;
      let shown: Promise<string> = Promise.resolve("");
      await loginDropbox(
        loginOptions({
          env,
          onPrompt: (prompt) => {
            mode = prompt.mode;
            shown = codeShownBy(prompt.verificationUrl);
          },
          readCode: () => shown,
        }),
      );
      expect(mode).toBe("paste");
    }
  });

  it("uses the pasted code with mode paste, and needs readCode for it", async () => {
    let shown: Promise<string> = Promise.resolve("");
    await loginDropbox(
      loginOptions({
        mode: "paste",
        onPrompt: (prompt) => {
          shown = codeShownBy(prompt.verificationUrl);
        },
        readCode: () => shown,
      }),
    );
    expect(lastAuthorizeQuery().redirect_uri).toBeUndefined();

    const error = await rejectionOf(loginDropbox(loginOptions({ mode: "paste" })));
    expect(codeOf(error)).toBe("MS_CONFIG_INVALID");
  });

  it("accepts the redirected URL pasted from a browser on another machine", async () => {
    let redirected: Promise<string | null> = Promise.resolve(null);
    const result = await loginDropbox(
      loginOptions({
        onPrompt: (prompt) => {
          // The browser cannot reach this machine's loopback; the user copies the URL.
          redirected = fetch(prompt.verificationUrl, { redirect: "manual" }).then((page) =>
            page.headers.get("location"),
          );
        },
        readCode: async () => (await redirected) ?? "",
      }),
    );
    expect(result.refreshToken).toMatch(/^refresh-/);
  });

  it("rejects a pasted URL from another login (wrong state)", async () => {
    const error = await rejectionOf(
      loginDropbox(
        loginOptions({
          onPrompt: () => {},
          readCode: async () => "http://127.0.0.1:53917/callback?code=abc&state=someone-else",
        }),
      ),
    );
    expect(codeOf(error)).toBe("MS_CONFIG_INVALID");
  });

  it("ignores callbacks with the wrong state or path, then accepts the real one", async () => {
    const statuses: number[] = [];
    await loginDropbox(
      loginOptions({
        onPrompt: (prompt) => {
          void (async () => {
            const redirect = new URL(
              new URL(prompt.verificationUrl).searchParams.get("redirect_uri") ?? "",
            );
            statuses.push((await fetch(`${redirect.origin}/favicon.ico`)).status);
            statuses.push((await fetch(`${redirect.href}?code=forged&state=wrong`)).status);
            await approveInBrowser(prompt);
          })();
        },
      }),
    );
    expect(statuses).toEqual([404, 400]);
  });

  it("fails with MS_STORAGE_FORBIDDEN when the user denies access", async () => {
    server.denyAuthorization();
    const error = await rejectionOf(loginDropbox(loginOptions()));
    expect(codeOf(error)).toBe("MS_STORAGE_FORBIDDEN");
  });

  it("gives up after timeoutMs with MS_TIMEOUT, and on abort with MS_ABORTED", async () => {
    const quiet = { onPrompt: () => {} };
    expect(codeOf(await rejectionOf(loginDropbox(loginOptions({ ...quiet, timeoutMs: 50 }))))).toBe(
      "MS_TIMEOUT",
    );
    const controller = new AbortController();
    const pending = loginDropbox(loginOptions({ ...quiet, signal: controller.signal }));
    setTimeout(() => controller.abort(), 20);
    expect(codeOf(await rejectionOf(pending))).toBe("MS_ABORTED");
    expect(
      codeOf(await rejectionOf(loginDropbox(loginOptions({ signal: AbortSignal.abort() })))),
    ).toBe("MS_ABORTED");
  });

  it("uses the injected fetch for the code exchange", async () => {
    const seen: string[] = [];
    await loginDropbox(
      loginOptions({
        fetch: (input, init) => {
          seen.push(String(input));
          return fetch(input, init);
        },
      }),
    );
    expect(seen).toEqual([server.tokenUrl]);
  });

  it("fails with a hint when the client id is empty", async () => {
    const error = await rejectionOf(loginDropbox(loginOptions({ clientId: "" })));
    expect(codeOf(error)).toBe("MS_CONFIG_INVALID");
  });

  it("sends the user to Dropbox's own authorize page by default", async () => {
    const controller = new AbortController();
    let verificationUrl = "";
    const { authorizeUrl: _fake, env: _env, ...defaults } = loginOptions();
    const error = await rejectionOf(
      loginDropbox({
        ...defaults,
        signal: controller.signal,
        // Never asked: the prompt cancels the login before anyone could paste a code.
        readCode: () => new Promise<string>(() => {}),
        onPrompt: (prompt) => {
          verificationUrl = prompt.verificationUrl;
          controller.abort();
        },
      }),
    );
    expect(codeOf(error)).toBe("MS_ABORTED");
    expect(verificationUrl.startsWith("https://www.dropbox.com/oauth2/authorize?")).toBe(true);
  });

  it("stops with MS_ABORTED when the prompt itself cancels the login and then fails", async () => {
    const controller = new AbortController();
    const error = await rejectionOf(
      loginDropbox(
        loginOptions({
          signal: controller.signal,
          onPrompt: () => {
            controller.abort();
            throw new Error("the terminal went away");
          },
        }),
      ),
    );
    expect(codeOf(error)).toBe("MS_ABORTED");
  });

  it("keeps waiting for the browser when the optional pasted-code prompt fails", async () => {
    const result = await loginDropbox(
      loginOptions({
        readCode: async () => {
          throw new Error("stdin was closed");
        },
      }),
    );
    expect(result.refreshToken).toMatch(/^refresh-/);
  });

  it("refuses an empty or multi-word pasted code", async () => {
    for (const pasted of ["   ", "two words"]) {
      const error = await rejectionOf(
        loginDropbox(
          loginOptions({ mode: "paste", onPrompt: () => {}, readCode: async () => pasted }),
        ),
      );
      expect(codeOf(error)).toBe("MS_CONFIG_INVALID");
      expect(String(error)).toMatch(/empty or invalid/);
    }
  });

  it("fails with MS_STORAGE_FORBIDDEN when the redirect carries neither a code nor an error", async () => {
    const error = await rejectionOf(
      loginDropbox(
        loginOptions({
          onPrompt: (prompt) => {
            const query = new URL(prompt.verificationUrl).searchParams;
            const callback = new URL(query.get("redirect_uri") ?? "");
            callback.searchParams.set("state", query.get("state") ?? "");
            void fetch(callback);
          },
        }),
      ),
    );
    expect(codeOf(error)).toBe("MS_STORAGE_FORBIDDEN");
    expect(isMongoShieldError(error) && error.details).toMatchObject({ error: "missing_code" });
  });

  it("fails with MS_STORAGE_IO and an offline-access hint when the exchange returns no refresh token", async () => {
    const error = await rejectionOf(
      loginDropbox(
        loginOptions({
          fetch: async () => Response.json({ access_token: "sl.short-lived", expires_in: 14_400 }),
        }),
      ),
    );
    expect(codeOf(error)).toBe("MS_STORAGE_IO");
    expect(isMongoShieldError(error) && error.hint).toMatch(/offline access/);
  });

  it("stops with MS_ABORTED when cancelled during the code exchange", async () => {
    const controller = new AbortController();
    const error = await rejectionOf(
      loginDropbox(
        loginOptions({
          signal: controller.signal,
          fetch: async () => {
            controller.abort();
            throw new TypeError("The operation was aborted");
          },
        }),
      ),
    );
    expect(codeOf(error)).toBe("MS_ABORTED");
  });
});

describe("refreshDropboxAccessToken", () => {
  it("sends the clientSecret with the refresh when given", async () => {
    await refreshDropboxAccessToken({
      clientId: server.clientId,
      clientSecret: "app-secret",
      refreshToken: server.issueRefreshToken(),
      tokenUrl: server.tokenUrl,
    });
    const refresh = server.requests.filter((entry) => entry.endpoint === "/oauth2/token").at(-1);
    expect(refresh?.arg).toMatchObject({
      grant_type: "refresh_token",
      client_secret: "app-secret",
    });
  });

  it("returns an access token and its expiry", async () => {
    const before = Date.now();
    const access = await refreshDropboxAccessToken({
      clientId: server.clientId,
      refreshToken: server.issueRefreshToken(),
      tokenUrl: server.tokenUrl,
    });
    expect(access.expiresAt.getTime()).toBeGreaterThanOrEqual(before + 14_000 * 1000);
  });

  it("maps a revoked token to MS_STORAGE_FORBIDDEN without echoing it", async () => {
    const error = await rejectionOf(
      refreshDropboxAccessToken({
        clientId: server.clientId,
        refreshToken: "refresh-revoked-token",
        tokenUrl: server.tokenUrl,
      }),
    );
    expect(codeOf(error)).toBe("MS_STORAGE_FORBIDDEN");
    expect(String(error)).toMatch(/invalid_grant/);
    expect(String(error)).not.toContain("refresh-revoked-token");
    expect(isMongoShieldError(error) && error.hint).toMatch(/mongoshield login dropbox/);
  });

  it("maps server errors and unreachable endpoints to MS_STORAGE_IO", async () => {
    const failing: typeof fetch = async () => new Response("oops", { status: 503 });
    const unreachable: typeof fetch = async () => {
      throw new TypeError("connect ECONNREFUSED for refresh-secret-token");
    };
    for (const doFetch of [failing, unreachable]) {
      const error = await rejectionOf(
        refreshDropboxAccessToken({
          clientId: "x",
          refreshToken: "refresh-secret-token",
          fetch: doFetch,
        }),
      );
      expect(codeOf(error)).toBe("MS_STORAGE_IO");
      expect(String(error)).not.toContain("refresh-secret-token");
    }
  });

  it("scrubs the refresh token from a network failure that is not an Error", async () => {
    const error = await rejectionOf(
      refreshDropboxAccessToken({
        clientId: "x",
        refreshToken: "refresh-secret-token",
        fetch: async () => {
          throw "socket closed while sending refresh-secret-token";
        },
      }),
    );
    expect(codeOf(error)).toBe("MS_STORAGE_IO");
    expect(String(error)).toMatch(/socket closed/);
    expect(String(error)).not.toContain("refresh-secret-token");
  });

  it("names the HTTP status when a rejection carries no OAuth error code", async () => {
    const error = await rejectionOf(
      refreshDropboxAccessToken({
        clientId: "x",
        refreshToken: "r",
        fetch: async () => new Response("", { status: 401 }),
      }),
    );
    expect(codeOf(error)).toBe("MS_STORAGE_FORBIDDEN");
    expect(String(error)).toMatch(/HTTP 401/);
    expect(isMongoShieldError(error) && error.details).toEqual({ status: 401 });
  });

  it("fails with MS_STORAGE_IO when a successful answer holds no access token", async () => {
    for (const body of ["{}", '"just text"', "null", '{"access_token":""}']) {
      const error = await rejectionOf(
        refreshDropboxAccessToken({
          clientId: "x",
          refreshToken: "r",
          fetch: async () => new Response(body, { status: 200 }),
        }),
      );
      expect(codeOf(error)).toBe("MS_STORAGE_IO");
      expect(String(error)).toMatch(/no access token/);
    }
  });

  it("assumes the documented four hours when the answer has no expires_in", async () => {
    const before = Date.now();
    const access = await refreshDropboxAccessToken({
      clientId: "x",
      refreshToken: "r",
      fetch: async () => Response.json({ access_token: "sl.no-expiry" }),
    });
    expect(access.accessToken).toBe("sl.no-expiry");
    const lifetime = access.expiresAt.getTime() - before;
    expect(lifetime).toBeGreaterThanOrEqual(4 * 60 * 60 * 1000 - 1000);
    expect(lifetime).toBeLessThanOrEqual(4 * 60 * 60 * 1000 + 1000);
  });
});

describe("Dropbox app settings", () => {
  it("registers http://127.0.0.1:<port>/callback for each fixed loopback port", () => {
    expect(DROPBOX_LOOPBACK_PORTS.map(dropboxRedirectUri)).toEqual([
      "http://127.0.0.1:53917/callback",
      "http://127.0.0.1:53918/callback",
    ]);
  });

  it("asks for exactly the least-privilege scopes", () => {
    expect([...DROPBOX_SCOPES]).toEqual([
      "account_info.read",
      "files.content.read",
      "files.content.write",
      "files.metadata.read",
    ]);
  });

  it("resolves the app key and secret from the environment", () => {
    expect(
      resolveDropboxClient({
        MONGOSHIELD_DROPBOX_CLIENT_ID: " key ",
        MONGOSHIELD_DROPBOX_CLIENT_SECRET: "secret",
      }),
    ).toEqual({ clientId: "key", clientSecret: "secret" });
    expect(resolveDropboxClient({ MONGOSHIELD_DROPBOX_CLIENT_ID: "key" })).toEqual({
      clientId: "key",
    });
  });

  it("falls back to the shipped app key, and fails with a hint while there is none", () => {
    if (DROPBOX_SHIPPED_CLIENT_ID !== "") {
      expect(resolveDropboxClient({})).toEqual({ clientId: DROPBOX_SHIPPED_CLIENT_ID });
      return;
    }
    let error: unknown;
    try {
      resolveDropboxClient({});
    } catch (caught) {
      error = caught;
    }
    expect(codeOf(error)).toBe("MS_CONFIG_INVALID");
    expect(isMongoShieldError(error) && error.hint).toMatch(/MONGOSHIELD_DROPBOX_CLIENT_ID/);
  });
});
