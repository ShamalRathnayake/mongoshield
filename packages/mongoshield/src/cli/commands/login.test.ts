// `mongoshield login <provider>`: with a fake provider (no network) for the output
// rules, a fake `gh` for --gh, and the generic device-flow provider against a fake
// authorization server for the whole path.

import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { plain, runTestCli } from "../../../test/helpers/cli.ts";
import { startFakeHttpServer } from "../../../test/helpers/fake-http-server.ts";
import { MongoShieldError } from "../../errors.ts";
import { OAUTH_APPS } from "../../storage/oauth/apps.ts";
import { deviceLoginProvider } from "../login/flows.ts";
import { registerLoginProvider } from "../login/providers.ts";
import type { LoginContext, LoginProvider } from "../login/types.ts";

const TOKEN = "1//refresh-token-from-the-fake";

let cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
  cleanups = [];
});

/** Registers a fake provider for one test. */
function fakeProvider(
  login: (context: LoginContext) => Promise<{ refreshToken: string; account?: string }>,
) {
  const provider: LoginProvider = {
    id: "fakedrive",
    displayName: "Fake Drive",
    tokenEnv: "MONGOSHIELD_FAKEDRIVE_TOKEN",
    flow: "device",
    login,
  };
  cleanups.push(registerLoginProvider(provider));
  return provider;
}

/** A provider that shows a device code, then succeeds. */
function approvingProvider(): LoginProvider {
  return fakeProvider(async (context) => {
    context.show({
      kind: "device-code",
      userCode: "WDJB-MJHT",
      verificationUri: "https://example.com/device",
      expiresAt: new Date(Date.now() + 900_000),
    });
    return { refreshToken: TOKEN, account: "ada@example.com" };
  });
}

/** Counts how often the token appears in a text. */
function occurrences(text: string): number {
  return text.split(TOKEN).length - 1;
}

describe("mongoshield login", () => {
  it("prints the token exactly once, on stdout, and names the secret it belongs in", async () => {
    approvingProvider();
    const run = await runTestCli(["login", "fakedrive"]);
    expect(run.code, run.stderr).toBe(0);
    expect(run.stdout).toBe(`${TOKEN}\n`);
    expect(occurrences(run.stdout + run.stderr)).toBe(1);
    const stderr = plain(run.stderr);
    expect(stderr).toContain("open https://example.com/device");
    expect(stderr).toContain("enter the code WDJB-MJHT");
    expect(stderr).toContain("Signed in to Fake Drive as ada@example.com.");
    expect(stderr).toContain("Save this token as the secret MONGOSHIELD_FAKEDRIVE_TOKEN");
    expect(stderr).toContain("gh secret set MONGOSHIELD_FAKEDRIVE_TOKEN");
  });

  it("shows the sign-in link for browser providers, even with --quiet", async () => {
    fakeProvider(async (context) => {
      context.show({ kind: "open-url", url: "https://example.com/authorize?state=x" });
      return { refreshToken: TOKEN };
    });
    const run = await runTestCli(["login", "fakedrive", "--quiet"]);
    expect(run.code, run.stderr).toBe(0);
    expect(plain(run.stderr)).toContain("https://example.com/authorize?state=x");
    expect(run.stdout).toBe(`${TOKEN}\n`);
  });

  it("prints one JSON document with --json", async () => {
    approvingProvider();
    const run = await runTestCli(["login", "FakeDrive", "--json"]);
    expect(run.code, run.stderr).toBe(0);
    expect(run.json()).toEqual({
      provider: "fakedrive",
      secretName: "MONGOSHIELD_FAKEDRIVE_TOKEN",
      refreshToken: TOKEN,
      account: "ada@example.com",
    });
    expect(occurrences(run.stdout + run.stderr)).toBe(1);
  });

  it("lists the providers when none or an unknown one is named", async () => {
    const none = await runTestCli(["login"]);
    expect(none.code).toBe(2);
    expect(none.stderr).toContain("gdrive, dropbox");
    const unknown = await runTestCli(["login", "icloud"]);
    expect(unknown.code).toBe(2);
    expect(unknown.stderr).toContain('Unknown provider "icloud"');
  });

  it.each([
    [["login", "fakedrive", "--repo", "acme/web"], "--repo only applies with --gh"],
    [["login", "fakedrive", "--port", "70000"], "--port must be a whole number"],
    [["login", "fakedrive", "extra"], "Unexpected argument: extra"],
  ])("rejects %j with exit code 2", async (args, message) => {
    approvingProvider();
    const run = await runTestCli(args);
    expect(run.code).toBe(2);
    expect(run.stderr).toContain(message);
    expect(run.stdout).toBe("");
  });

  it("passes --port to browser providers", async () => {
    let port: number | undefined;
    fakeProvider(async (context) => {
      port = context.port;
      return { refreshToken: TOKEN };
    });
    expect((await runTestCli(["login", "fakedrive", "--port", "53682"])).code).toBe(0);
    expect(port).toBe(53682);
  });

  it("reports a failed sign-in with its exit code and never prints a token", async () => {
    fakeProvider(async () => {
      throw new MongoShieldError("MS_STORAGE_FORBIDDEN", "The Fake Drive sign-in was declined.");
    });
    const run = await runTestCli(["login", "fakedrive"]);
    expect(run.code).toBe(21);
    expect(run.stderr).toContain("declined");
    expect(run.stdout).toBe("");
  });

  it("keeps drive tokens from the environment out of every error", async () => {
    const secret = "1//token-already-in-the-environment";
    fakeProvider(async () => {
      throw new MongoShieldError("MS_STORAGE_IO", `the provider echoed ${secret}`);
    });
    const run = await runTestCli(["login", "fakedrive"], {
      env: { MONGOSHIELD_GDRIVE_TOKEN: secret },
    });
    expect(run.code).not.toBe(0);
    expect(run.stderr).not.toContain(secret);
    expect(run.stderr).toContain("the provider echoed ***");
  });

  it("refuses a built-in provider whose app is not registered yet, naming the override", async () => {
    if (OAUTH_APPS.gdrive.clientId !== "") return;
    const run = await runTestCli(["login", "gdrive"]);
    expect(run.code).toBe(2);
    expect(run.stderr).toContain("MONGOSHIELD_GDRIVE_CLIENT_ID");
  });

  it("is listed in the help", async () => {
    const run = await runTestCli(["--help"]);
    expect(plain(run.stdout)).toMatch(/login\s+Sign in to Google Drive or Dropbox/);
  });
});

describe.skipIf(process.platform === "win32")("mongoshield login --gh", () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "mongoshield-login-gh-"));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
  });

  /** Puts a fake `gh` first on PATH: it records its arguments and stdin, then exits `code`. */
  async function fakeGh(code: number): Promise<NodeJS.ProcessEnv> {
    const script = join(directory, "gh");
    await writeFile(
      script,
      [
        "#!/bin/sh",
        `echo "$@" > "${join(directory, "args")}"`,
        `cat > "${join(directory, "stdin")}"`,
        code === 0
          ? "exit 0"
          : 'echo "HTTP 403: Resource not accessible by integration" >&2; exit 1',
        "",
      ].join("\n"),
    );
    await chmod(script, 0o755);
    return { PATH: `${directory}${delimiter}${process.env.PATH ?? ""}` };
  }

  it("stores the token with gh secret set, on stdin, and does not print it", async () => {
    approvingProvider();
    const env = await fakeGh(0);
    const run = await runTestCli(["login", "fakedrive", "--gh", "--repo", "acme/web"], {
      env,
      cwd: directory,
    });
    expect(run.code, run.stderr).toBe(0);
    expect(await readFile(join(directory, "args"), "utf8")).toBe(
      "secret set MONGOSHIELD_FAKEDRIVE_TOKEN --repo acme/web\n",
    );
    expect(await readFile(join(directory, "stdin"), "utf8")).toBe(TOKEN);
    expect(occurrences(run.stdout + run.stderr)).toBe(0);
    expect(plain(run.stderr)).toContain(
      "Saved the token as the repository secret MONGOSHIELD_FAKEDRIVE_TOKEN",
    );
  });

  it("reports savedTo in --json without the token", async () => {
    approvingProvider();
    const run = await runTestCli(["login", "fakedrive", "--gh", "--json"], {
      env: await fakeGh(0),
      cwd: directory,
    });
    expect(run.code, run.stderr).toBe(0);
    expect(run.json()).toEqual({
      provider: "fakedrive",
      secretName: "MONGOSHIELD_FAKEDRIVE_TOKEN",
      savedTo: "github",
      account: "ada@example.com",
    });
  });

  it("prints the token instead when gh fails, so the sign-in is not lost", async () => {
    approvingProvider();
    const run = await runTestCli(["login", "fakedrive", "--gh"], {
      env: await fakeGh(1),
      cwd: directory,
    });
    expect(run.code, run.stderr).toBe(0);
    expect(plain(run.stderr)).toContain("gh could not set the secret MONGOSHIELD_FAKEDRIVE_TOKEN");
    expect(plain(run.stderr)).toContain("Resource not accessible");
    expect(run.stdout).toBe(`${TOKEN}\n`);
  });

  it("explains a missing gh", async () => {
    approvingProvider();
    const run = await runTestCli(["login", "fakedrive", "--gh"], {
      env: { PATH: directory },
      cwd: directory,
    });
    expect(run.code, run.stderr).toBe(0);
    expect(plain(run.stderr)).toContain("The GitHub CLI (gh) is not installed.");
    expect(run.stdout).toBe(`${TOKEN}\n`);
  });
});

describe("the generic device-flow provider", () => {
  it("signs in against an authorization server and returns the refresh token", async () => {
    const server = await startFakeHttpServer((request) => {
      if (request.path === "/device") {
        return {
          json: {
            device_code: "dev",
            user_code: "ABCD-EFGH",
            verification_uri: "https://example.com/device",
            expires_in: 600,
            interval: 1,
          },
        };
      }
      return { json: { access_token: "at", refresh_token: TOKEN, expires_in: 3600 } };
    });
    cleanups.push(() => server.close());
    const provider = {
      ...deviceLoginProvider({
        ...OAUTH_APPS.gdrive,
        endpoints: { deviceAuthorization: `${server.url}/device`, token: `${server.url}/token` },
      }),
      id: "fakedrive",
    };
    cleanups.push(registerLoginProvider(provider));

    const run = await runTestCli(["login", "fakedrive", "--json"], {
      env: {
        MONGOSHIELD_GDRIVE_CLIENT_ID: "own-id",
        MONGOSHIELD_GDRIVE_CLIENT_SECRET: "own-secret",
      },
    });
    expect(run.code, run.stderr).toBe(0);
    expect(run.json()).toMatchObject({
      refreshToken: TOKEN,
      secretName: "MONGOSHIELD_GDRIVE_TOKEN",
    });
    expect(plain(run.stderr)).toContain("enter the code ABCD-EFGH");
    const poll = new URLSearchParams(server.requests[1]?.body.toString());
    expect(poll.get("client_id")).toBe("own-id");
    expect(poll.get("client_secret")).toBe("own-secret");
  });
});
