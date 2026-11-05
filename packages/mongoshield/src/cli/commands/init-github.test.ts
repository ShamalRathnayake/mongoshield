// biome-ignore-all lint/suspicious/noTemplateCurlyInString: GitHub Actions expressions (${{ … }}) are literal workflow text here.
/**
 * Tests for `init --github` (init-github.ts): the generated workflow and config,
 * the exact `gh`/`git` calls (through a fake command runner, so nothing real runs),
 * the copy-paste fallback without `gh`, and the first run.
 */

import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startFakeGdriveServer } from "../../../test/helpers/fake-gdrive-server.ts";
import { identityToRecipient, parseIdentityFile } from "../../crypto/index.ts";
import { readRecoveryKit } from "../../crypto/recovery-kit.ts";
import { isMongoShieldError } from "../../errors.ts";
import { memoryStorage } from "../../storage/memory.ts";
import {
  type CommandResult,
  type CommandRunner,
  GITHUB_WORKFLOW_FILE,
  type GithubStorageChoice,
  githubConfigText,
  githubWorkflowText,
  type InitGithubOptions,
  initGithub,
  resolveActionRef,
  spawnRunner,
} from "./init-github.ts";

const SHA = "0123456789abcdef0123456789abcdef01234567";
const TOKEN = "1//refresh-token-secret";
const URI = "mongodb+srv://backup:pa55word@cluster0.example.mongodb.net/";
const PASSPHRASE = "a long kit passphrase";
const GDRIVE: GithubStorageChoice = { kind: "gdrive", url: "gdrive://my-app", refreshToken: TOKEN };

/** One recorded external command. */
interface Call {
  readonly command: string;
  readonly args: readonly string[];
  readonly input: string | undefined;
}

/** A fake `gh`/`git`: answers from a table, records every call. */
function fakeRunner(answer: (call: Call) => Partial<CommandResult> | undefined) {
  const calls: Call[] = [];
  const run: CommandRunner = async (command, args, options = {}) => {
    const call = { command, args, input: options.input };
    calls.push(call);
    return { exitCode: 0, stdout: "", stderr: "", ...answer(call) };
  };
  return { run, calls, line: (call: Call) => [call.command, ...call.args].join(" ") };
}

/** An output that keeps every line, to check nothing secret is printed. */
function recordingOutput() {
  const lines: string[] = [];
  const add = (kind: string) => (text: string) => lines.push(`${kind}: ${text}`);
  return {
    lines,
    out: { info: add("info"), success: add("success"), warn: add("warn"), result: add("result") },
  };
}

/** `gh` logged in, workflow already on GitHub, run 42 succeeds. */
function happyGh(call: Call): Partial<CommandResult> | undefined {
  const line = [call.command, ...call.args].join(" ");
  if (line.startsWith("gh api")) return { stdout: `${SHA}\n` };
  if (line.startsWith("gh run list")) return { stdout: listedRuns.shift() ?? "[]" };
  if (line.startsWith("gh run view")) {
    return {
      stdout: JSON.stringify({
        conclusion: "success",
        url: "https://github.com/o/r/actions/runs/42",
      }),
    };
  }
  return undefined;
}
let listedRuns: string[] = [];

describe("githubWorkflowText", () => {
  const actionRef = `ShamalRathnayake/mongoshield/action@${SHA} # v2.1.0`;

  it("writes a nightly, manually startable workflow with one concurrency group", () => {
    const text = githubWorkflowText({
      storage: GDRIVE,
      actionRef,
      configFile: "mongoshield.config.json",
    });
    expect(text).toContain('  schedule:\n    - cron: "17 3 * * *"\n  workflow_dispatch:\n');
    expect(text).toContain(
      "concurrency:\n  group: mongoshield-backup\n  cancel-in-progress: false\n",
    );
    expect(text).toContain("permissions:\n  contents: read\n");
  });

  it("runs the pinned Action with command run, the config, the secrets and the public key", () => {
    const text = githubWorkflowText({
      storage: GDRIVE,
      actionRef,
      configFile: "mongoshield.config.json",
    });
    expect(text).toContain(
      [
        "      - name: Back up, verify and prune",
        `        uses: ShamalRathnayake/mongoshield/action@${SHA} # v2.1.0`,
        "        with:",
        "          command: run",
        "          config: mongoshield.config.json",
        "          uri: ${{ secrets.MONGODB_URI }}",
        "          recipients: ${{ vars.MONGOSHIELD_RECIPIENTS }}",
        "        env:",
        "          MONGOSHIELD_GDRIVE_TOKEN: ${{ secrets.MONGOSHIELD_GDRIVE_TOKEN }}",
      ].join("\n"),
    );
    expect(text).toContain("actions/checkout@fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09 # v5.1.0");
    expect(text).not.toContain("upload-artifact");
    expect(text).not.toContain(TOKEN);
  });

  it("refuses to run without the public key instead of writing unencrypted backups", () => {
    const text = githubWorkflowText({ storage: GDRIVE, actionRef, configFile: "c.json" });
    expect(text).toContain("RECIPIENTS: ${{ vars.MONGOSHIELD_RECIPIENTS }}");
    expect(text).toContain('if [ -z "$RECIPIENTS" ]; then');
    expect(text.indexOf("Check the encryption key")).toBeLessThan(text.indexOf("Back up, verify"));
  });

  it("uploads backups/ as an artifact for the GitHub artifacts choice", () => {
    const text = githubWorkflowText({
      storage: { kind: "github-artifacts" },
      actionRef,
      configFile: "mongoshield.config.json",
    });
    expect(text).toContain(
      [
        "      - uses: actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02 # v4.6.2",
        "        with:",
        "          name: mongoshield-backup-${{ github.run_id }}",
        "          path: backups/",
        "          retention-days: 90",
        "          if-no-files-found: error",
      ].join("\n"),
    );
    expect(text).not.toContain("MONGOSHIELD_GDRIVE_TOKEN");
  });

  it("passes the secrets of another storage URL as environment variables", () => {
    const text = githubWorkflowText({
      storage: {
        kind: "url",
        url: "s3://b/p",
        secrets: { AWS_ACCESS_KEY_ID: "x", AWS_SECRET_ACCESS_KEY: "y" },
      },
      actionRef,
      configFile: "c.json",
    });
    expect(text).toContain("          AWS_ACCESS_KEY_ID: ${{ secrets.AWS_ACCESS_KEY_ID }}");
    expect(text).toContain("          AWS_SECRET_ACCESS_KEY: ${{ secrets.AWS_SECRET_ACCESS_KEY }}");
  });

  it("uses a custom cron when given", () => {
    expect(
      githubWorkflowText({ storage: GDRIVE, actionRef, configFile: "c", cron: "0 1 * * *" }),
    ).toContain('- cron: "0 1 * * *"');
  });
});

describe("githubConfigText", () => {
  it("sets the storage, a nightly verified schedule without a lock for Google Drive, and the retention", () => {
    expect(JSON.parse(githubConfigText(GDRIVE))).toEqual({
      storage: "gdrive://my-app",
      schedule: { cron: "17 3 * * *", lock: "none", verify: "fast" },
      retention: { last: 7, weekly: 4, monthly: 6 },
    });
  });

  it("keeps the storage lock for storage that can hold one", () => {
    const config = JSON.parse(githubConfigText({ kind: "github-artifacts" }));
    expect(config.storage).toBe("./backups");
    expect(config.schedule.lock).toBe("storage");
    expect(
      JSON.parse(githubConfigText({ kind: "url", url: "s3://b", lock: "mongo" })).schedule.lock,
    ).toBe("mongo");
  });
});

describe("resolveActionRef", () => {
  it("pins the release's commit SHA with the tag as a comment", async () => {
    const { run, calls } = fakeRunner(() => ({ stdout: `${SHA}\n` }));
    expect(await resolveActionRef(run, "2.1.0")).toBe(
      `ShamalRathnayake/mongoshield/action@${SHA} # v2.1.0`,
    );
    expect(calls[0]?.args).toEqual([
      "api",
      "repos/ShamalRathnayake/mongoshield/commits/v2.1.0",
      "--jq",
      ".sha",
    ]);
  });

  it("falls back to the release tag when gh cannot look it up", async () => {
    const { run } = fakeRunner(() => ({ exitCode: 1 }));
    expect(await resolveActionRef(run, "2.1.0")).toBe("ShamalRathnayake/mongoshield/action@v2.1.0");
  });
});

describe("initGithub", () => {
  let cwd: string;
  let storage: ReturnType<typeof memoryStorage>;

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), "mongoshield-init-github-"));
    storage = memoryStorage();
    listedRuns = [];
  });
  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  function options(
    extra: Partial<InitGithubOptions> & Pick<InitGithubOptions, "run" | "out">,
  ): InitGithubOptions {
    return {
      cwd,
      storage: GDRIVE,
      version: "2.1.0",
      mongodbUri: URI,
      recoveryPassphrase: async () => PASSPHRASE,
      openStorage: async () => storage,
      sleep: async () => {},
      scryptWorkFactor: 10,
      ...extra,
    };
  }

  it("sets up everything with gh and follows the first run to success", async () => {
    listedRuns = [
      "[]",
      JSON.stringify([{ databaseId: 42, url: "https://github.com/o/r/actions/runs/42" }]),
    ];
    const gh = fakeRunner(happyGh);
    const { out, lines } = recordingOutput();
    const result = await initGithub(options({ run: gh.run, out }));

    expect(gh.calls.map(gh.line)).toEqual([
      "gh api repos/ShamalRathnayake/mongoshield/commits/v2.1.0 --jq .sha",
      "gh auth status",
      `gh variable set MONGOSHIELD_RECIPIENTS --body ${result.recipient}`,
      "gh secret set MONGODB_URI",
      "gh secret set MONGOSHIELD_GDRIVE_TOKEN",
      "gh workflow view mongoshield-backup.yml --yaml",
      "gh run list --workflow mongoshield-backup.yml --event workflow_dispatch --limit 10 --json databaseId,url",
      "gh workflow run mongoshield-backup.yml",
      "gh run list --workflow mongoshield-backup.yml --event workflow_dispatch --limit 10 --json databaseId,url",
      "gh run watch 42 --exit-status",
      "gh run view 42 --json conclusion,url",
    ]);
    // Secrets travel on stdin, never as arguments.
    expect(gh.calls[3]?.input).toBe(URI);
    expect(gh.calls[4]?.input).toBe(TOKEN);
    expect(result).toMatchObject({
      workflowFile: GITHUB_WORKFLOW_FILE,
      configFile: "mongoshield.config.json",
      recoveryKit: true,
      github: "configured",
      firstRun: { status: "success", runId: "42", url: "https://github.com/o/r/actions/runs/42" },
    });
    expect(lines.join("\n")).not.toContain(TOKEN);
    expect(lines.join("\n")).not.toContain("pa55word");
    expect(lines.join("\n")).not.toContain(PASSPHRASE);
  });

  it("saves the secret key with mode 0600, ignores it in git, and puts it in the recovery kit", async () => {
    const gh = fakeRunner((call) => (call.args[0] === "auth" ? { exitCode: 1 } : undefined));
    const result = await initGithub(options({ run: gh.run, out: recordingOutput().out }));

    const keyText = await readFile(join(cwd, "mongoshield.key"), "utf8");
    const [identity] = parseIdentityFile(keyText);
    expect(identity && identityToRecipient(identity)).toBe(result.recipient);
    if (process.platform !== "win32") {
      expect((await stat(join(cwd, "mongoshield.key"))).mode & 0o777).toBe(0o600);
    }
    expect(await readFile(join(cwd, ".gitignore"), "utf8")).toContain("/mongoshield.key");
    expect(await readRecoveryKit(storage, { passphrase: PASSPHRASE })).toEqual([identity]);
  });

  it("writes the workflow and the config", async () => {
    const gh = fakeRunner((call) => (call.args[0] === "auth" ? { exitCode: 1 } : happyGh(call)));
    await initGithub(options({ run: gh.run, out: recordingOutput().out }));
    const workflow = await readFile(join(cwd, ".github/workflows/mongoshield-backup.yml"), "utf8");
    expect(workflow).toContain(`ShamalRathnayake/mongoshield/action@${SHA} # v2.1.0`);
    expect(workflow).toContain("config: mongoshield.config.json");
    expect(
      JSON.parse(await readFile(join(cwd, "mongoshield.config.json"), "utf8")).schedule.lock,
    ).toBe("none");
  });

  it("prints copy-paste gh lines without gh, keeping secret values in 0600 files", async () => {
    const gh = fakeRunner((call) => (call.args[0] === "auth" ? { exitCode: 1 } : { exitCode: 1 }));
    const { out, lines } = recordingOutput();
    const result = await initGithub(options({ run: gh.run, out }));

    expect(result.github).toBe("manual");
    expect(result.firstRun.status).toBe("not-started");
    // No gh command that changes anything was run.
    expect(
      gh.calls.map(gh.line).filter((line) => /secret set|variable set|workflow run/.test(line)),
    ).toEqual([]);

    const results = lines
      .filter((line) => line.startsWith("result: "))
      .map((line) => line.slice(8));
    expect(results).toContain(
      `gh variable set MONGOSHIELD_RECIPIENTS --body '${result.recipient}'`,
    );
    const tokenLine = results.find((line) =>
      line.startsWith("gh secret set MONGOSHIELD_GDRIVE_TOKEN < "),
    );
    const uriLine = results.find((line) => line.startsWith("gh secret set MONGODB_URI < "));
    if (!tokenLine || !uriLine) throw new Error(`missing secret lines in ${results.join("\n")}`);
    const tokenFile = tokenLine.split(" < ")[1] ?? "";
    expect(await readFile(tokenFile, "utf8")).toBe(TOKEN);
    expect(await readFile(uriLine.split(" < ")[1] ?? "", "utf8")).toBe(URI);
    if (process.platform !== "win32") expect((await stat(tokenFile)).mode & 0o777).toBe(0o600);
    expect(results.some((line) => line.startsWith("rm -r "))).toBe(true);
    expect(results).toContain("gh workflow run mongoshield-backup.yml");
    expect(lines.join("\n")).not.toContain(TOKEN);
    expect(lines.join("\n")).not.toContain("pa55word");
  });

  it("tells the user to set MONGODB_URI when the connection string is not known", async () => {
    const gh = fakeRunner(happyGh);
    const { out, lines } = recordingOutput();
    const result = await initGithub(
      options({ run: gh.run, out, mongodbUri: undefined as never, firstRun: false }),
    );
    expect(result.github).toBe("manual");
    expect(lines).toContain("warn: Set the secret MONGODB_URI yourself: gh secret set MONGODB_URI");
    expect(gh.calls.map(gh.line)).not.toContain("gh secret set MONGODB_URI");
  });

  it("commits and pushes only the workflow and config, after asking, when GitHub does not know the workflow", async () => {
    let views = 0;
    listedRuns = ["[]", JSON.stringify([{ databaseId: 7, url: "u" }])];
    const gh = fakeRunner((call) => {
      if (call.args[0] === "workflow" && call.args[1] === "view")
        return { exitCode: views++ === 0 ? 1 : 0 };
      return happyGh(call);
    });
    const questions: string[] = [];
    const result = await initGithub(
      options({
        run: gh.run,
        out: recordingOutput().out,
        confirm: async (question) => {
          questions.push(question);
          return true;
        },
      }),
    );
    expect(questions).toEqual([
      "Commit .github/workflows/mongoshield-backup.yml and mongoshield.config.json and push, so GitHub can run the workflow?",
    ]);
    const gitCalls = gh.calls.filter((call) => call.command === "git").map(gh.line);
    expect(gitCalls).toEqual([
      "git add -- .github/workflows/mongoshield-backup.yml mongoshield.config.json",
      "git commit -m ci: add MongoShield nightly backups -- .github/workflows/mongoshield-backup.yml mongoshield.config.json",
      "git push",
    ]);
    expect(result.firstRun.status).toBe("success");
  });

  it("does not push or start a run when the user says no", async () => {
    const gh = fakeRunner((call) =>
      call.args[1] === "view" && call.args[0] === "workflow" ? { exitCode: 1 } : happyGh(call),
    );
    const result = await initGithub(
      options({ run: gh.run, out: recordingOutput().out, confirm: async () => false }),
    );
    expect(gh.calls.some((call) => call.command === "git")).toBe(false);
    expect(gh.calls.map(gh.line)).not.toContain("gh workflow run mongoshield-backup.yml");
    expect(result.firstRun.status).toBe("not-started");
  });

  it("reports a failed first run with the way to its log", async () => {
    listedRuns = ["[]", JSON.stringify([{ databaseId: 9, url: "https://x/9" }])];
    const gh = fakeRunner((call) => (call.args[1] === "watch" ? { exitCode: 1 } : happyGh(call)));
    const { out, lines } = recordingOutput();
    const result = await initGithub(options({ run: gh.run, out }));
    expect(result.firstRun).toMatchObject({ status: "failure", runId: "9" });
    expect(lines.some((line) => line.includes("gh run view 9 --log-failed"))).toBe(true);
  });

  it("skips the recovery kit and keeps the storage lock for GitHub artifacts", async () => {
    const gh = fakeRunner((call) => (call.args[0] === "auth" ? { exitCode: 1 } : undefined));
    const { out, lines } = recordingOutput();
    const result = await initGithub(
      options({
        run: gh.run,
        out,
        storage: { kind: "github-artifacts" },
        recoveryPassphrase: undefined as never,
      }),
    );
    expect(result.recoveryKit).toBe(false);
    expect(lines.some((line) => line.includes("offline copy of the secret key"))).toBe(true);
    const workflow = await readFile(join(cwd, ".github/workflows/mongoshield-backup.yml"), "utf8");
    expect(workflow).toContain("path: backups/");
    expect(lines.join("\n")).not.toContain("MONGOSHIELD_GDRIVE_TOKEN");
  });

  it("uses an existing config file instead of writing one", async () => {
    await writeFile(join(cwd, "mongoshield.config.ts"), "export default {};\n");
    const gh = fakeRunner((call) => (call.args[0] === "auth" ? { exitCode: 1 } : undefined));
    const { out, lines } = recordingOutput();
    const result = await initGithub(options({ run: gh.run, out }));
    expect(result.configFile).toBe("mongoshield.config.ts");
    expect(lines.some((line) => line.includes('schedule.lock "none"'))).toBe(true);
    const workflow = await readFile(join(cwd, ".github/workflows/mongoshield-backup.yml"), "utf8");
    expect(workflow).toContain("config: mongoshield.config.ts");
    // The copy-paste commit line adds the config that is in use, not a new one.
    expect(
      lines.some((line) =>
        line.includes(`git add ${GITHUB_WORKFLOW_FILE} mongoshield.config.ts &&`),
      ),
    ).toBe(true);
  });

  it("refuses to overwrite an existing secret key", async () => {
    await writeFile(join(cwd, "mongoshield.key"), "old key\n");
    const gh = fakeRunner(() => undefined);
    const error = await initGithub(options({ run: gh.run, out: recordingOutput().out })).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(isMongoShieldError(error, "MS_CONFIG_INVALID")).toBe(true);
    expect(await readFile(join(cwd, "mongoshield.key"), "utf8")).toBe("old key\n");
    expect(gh.calls).toEqual([]);
  });

  describe("gh and git", () => {
    /** `gh` logged in, workflow known, and `answer` overriding single calls. */
    function ghWith(answer: (line: string) => Partial<CommandResult> | undefined) {
      return fakeRunner((call) => answer([call.command, ...call.args].join(" ")) ?? happyGh(call));
    }

    it("falls back to manual setup when gh cannot set one of the secrets", async () => {
      const gh = ghWith((line) =>
        line === "gh secret set MONGOSHIELD_GDRIVE_TOKEN"
          ? { exitCode: 1, stderr: "HTTP 403: Resource not accessible\nmore detail" }
          : undefined,
      );
      const { out, lines } = recordingOutput();
      const result = await initGithub(options({ run: gh.run, out }));
      expect(result.github).toBe("manual");
      expect(lines).toContain(
        "warn: gh could not set the secret MONGOSHIELD_GDRIVE_TOKEN: HTTP 403: Resource not accessible",
      );
      // Not every secret is set, so no run is started.
      expect(gh.calls.map(gh.line)).not.toContain("gh workflow run mongoshield-backup.yml");
      expect(result.firstRun.status).toBe("not-started");
      expect(lines).toContain(
        "info: Start the first backup when ready: gh workflow run mongoshield-backup.yml",
      );
    });

    it("pins the release tag when the gh api lookup itself throws", async () => {
      const run: CommandRunner = async () => {
        throw new Error("spawn gh ENOENT");
      };
      expect(await resolveActionRef(run, "2.1.0")).toBe(
        "ShamalRathnayake/mongoshield/action@v2.1.0",
      );
    });

    it("pins the release tag when gh answers something that is not a commit SHA", async () => {
      const { run } = fakeRunner(() => ({ stdout: "Not Found\n" }));
      expect(await resolveActionRef(run, "2.1.0")).toBe(
        "ShamalRathnayake/mongoshield/action@v2.1.0",
      );
    });

    it("tells the user how to push when there is no way to ask", async () => {
      const gh = ghWith((line) =>
        line.startsWith("gh workflow view") ? { exitCode: 1 } : undefined,
      );
      const { out, lines } = recordingOutput();
      const result = await initGithub(options({ run: gh.run, out }));
      expect(result.firstRun.status).toBe("not-started");
      expect(gh.calls.some((call) => call.command === "git")).toBe(false);
      expect(lines).toContain(
        "info: Push the workflow, then start it: git add .github/workflows/mongoshield-backup.yml mongoshield.config.json && git commit && git push",
      );
    });

    it("stops at the git step that fails and starts no run", async () => {
      const gh = ghWith((line) => {
        if (line.startsWith("gh workflow view")) return { exitCode: 1 };
        if (line === "git push") return { exitCode: 1, stderr: "rejected: non-fast-forward\n" };
        return undefined;
      });
      const { out, lines } = recordingOutput();
      const result = await initGithub(options({ run: gh.run, out, confirm: async () => true }));
      expect(gh.calls.filter((call) => call.command === "git").map((call) => call.args[0])).toEqual(
        ["add", "commit", "push"],
      );
      expect(lines).toContain("warn: git push failed: rejected: non-fast-forward");
      expect(lines.some((line) => line.includes("Pushed the workflow"))).toBe(false);
      expect(gh.calls.map(gh.line)).not.toContain("gh workflow run mongoshield-backup.yml");
      expect(result.firstRun.status).toBe("not-started");
    });

    it("gives up when GitHub does not pick up a pushed workflow after ten checks", async () => {
      const waits: number[] = [];
      const gh = ghWith((line) =>
        line.startsWith("gh workflow view") ? { exitCode: 1 } : undefined,
      );
      const { out, lines } = recordingOutput();
      const result = await initGithub(
        options({
          run: gh.run,
          out,
          confirm: async () => true,
          sleep: async (milliseconds) => {
            waits.push(milliseconds);
          },
        }),
      );
      // One check before the push, then ten after it, two seconds apart.
      expect(gh.calls.filter((call) => call.args[1] === "view").length).toBe(11);
      expect(waits).toEqual(Array.from({ length: 10 }, () => 2000));
      expect(lines).toContain("warn: GitHub has not picked up the workflow yet.");
      expect(result.firstRun.status).toBe("not-started");
    });

    it("reports a dispatch gh refuses", async () => {
      const gh = ghWith((line) =>
        line === "gh workflow run mongoshield-backup.yml"
          ? { exitCode: 1, stderr: "could not create workflow dispatch event: HTTP 422" }
          : undefined,
      );
      const { out, lines } = recordingOutput();
      const result = await initGithub(options({ run: gh.run, out }));
      expect(lines).toContain(
        "warn: Could not start the first run: could not create workflow dispatch event: HTTP 422",
      );
      expect(gh.calls.map(gh.line)).not.toContain("gh run watch");
      expect(result.firstRun.status).toBe("not-started");
    });

    it("gives up when the dispatched run never shows up in the run list", async () => {
      let waits = 0;
      // The same old run every time: the new one never appears.
      const gh = ghWith((line) =>
        line.startsWith("gh run list")
          ? { stdout: JSON.stringify([{ databaseId: 1, url: "https://x/1" }]) }
          : undefined,
      );
      const { out, lines } = recordingOutput();
      const result = await initGithub(
        options({
          run: gh.run,
          out,
          sleep: async () => {
            waits++;
          },
        }),
      );
      expect(waits).toBe(30);
      expect(result.firstRun).toEqual({ status: "not-started" });
      expect(lines).toContain(
        "warn: Could not find the run that was started. See: gh run list --workflow mongoshield-backup.yml",
      );
      expect(gh.calls.some((call) => call.args[1] === "watch")).toBe(false);
    });

    it("keeps looking for the run when gh run list fails or answers something unexpected", async () => {
      const answers = [
        { stdout: "[]" }, // before the dispatch
        { exitCode: 1, stderr: "HTTP 502" },
        { stdout: "not json" },
        { stdout: JSON.stringify({ databaseId: 5 }) }, // an object, not a list
        { stdout: JSON.stringify([7, { url: "no id" }, { databaseId: true }]) },
        { stdout: JSON.stringify([{ databaseId: "8", url: 123 }]) },
      ];
      const gh = ghWith((line) => {
        if (line.startsWith("gh run list")) return answers.shift();
        // gh run view prints nothing usable, so the result has no URL at all.
        if (line.startsWith("gh run view")) return { stdout: "" };
        return undefined;
      });
      const { out, lines } = recordingOutput();
      const result = await initGithub(options({ run: gh.run, out }));
      expect(result.firstRun).toEqual({ status: "success", runId: "8" });
      expect(lines).toContain("info: Following the run…");
      expect(lines).toContain("success: The first backup succeeded.");
    });

    it("takes the run's URL from the run list when gh run view has none", async () => {
      listedRuns = ["[]", JSON.stringify([{ databaseId: 3, url: "https://x/3" }])];
      const gh = ghWith((line) => {
        if (line.startsWith("gh run view")) return { stdout: JSON.stringify({ conclusion: "x" }) };
        if (line.startsWith("gh run watch")) return { exitCode: 1 };
        return undefined;
      });
      const { out, lines } = recordingOutput();
      const result = await initGithub(options({ run: gh.run, out }));
      expect(result.firstRun).toEqual({ status: "failure", runId: "3", url: "https://x/3" });
      expect(lines).toContain(
        "warn: The first backup failed: https://x/3. See the log: gh run view 3 --log-failed",
      );
    });

    it("reports a failed run without a URL", async () => {
      listedRuns = ["[]", JSON.stringify([{ databaseId: 4 }])];
      const gh = ghWith((line) => {
        if (line.startsWith("gh run view")) return { stdout: "{}" };
        if (line.startsWith("gh run watch")) return { exitCode: 1 };
        return undefined;
      });
      const { out, lines } = recordingOutput();
      const result = await initGithub(options({ run: gh.run, out }));
      expect(result.firstRun).toEqual({ status: "failure", runId: "4" });
      expect(lines).toContain(
        "warn: The first backup failed. See the log: gh run view 4 --log-failed",
      );
    });

    it("does not start a run with firstRun: false, but says how to", async () => {
      const gh = ghWith(() => undefined);
      const { out, lines } = recordingOutput();
      const result = await initGithub(options({ run: gh.run, out, firstRun: false }));
      expect(result.github).toBe("configured");
      expect(result.firstRun.status).toBe("not-started");
      expect(gh.calls.some((call) => call.args[0] === "workflow")).toBe(false);
      expect(lines).toContain(
        "info: Start the first backup when ready: gh workflow run mongoshield-backup.yml",
      );
    });

    it("stops with MS_ABORTED when cancelled before waiting for the run", async () => {
      const controller = new AbortController();
      const gh = ghWith((line) => {
        if (line === "gh workflow run mongoshield-backup.yml") controller.abort();
        return undefined;
      });
      const error = await rejectionOf(
        initGithub({
          ...options({ run: gh.run, out: recordingOutput().out, signal: controller.signal }),
          // The built-in sleep, so cancellation is what ends the wait.
          sleep: undefined as never,
        }),
      );
      expect(isMongoShieldError(error, "MS_ABORTED")).toBe(true);
    });

    it("stops with MS_ABORTED when cancelled while waiting for the run", async () => {
      const controller = new AbortController();
      const gh = ghWith((line) => {
        // Cancel a moment after the dispatch, while the 2 s wait is running.
        if (line === "gh workflow run mongoshield-backup.yml") {
          setTimeout(() => controller.abort(), 5);
        }
        return undefined;
      });
      const started = Date.now();
      const error = await rejectionOf(
        initGithub({
          ...options({ run: gh.run, out: recordingOutput().out, signal: controller.signal }),
          sleep: undefined as never,
        }),
      );
      expect(isMongoShieldError(error, "MS_ABORTED")).toBe(true);
      expect(Date.now() - started).toBeLessThan(1500);
    });

    it("stops with MS_ABORTED before doing anything when already cancelled", async () => {
      const gh = ghWith(() => undefined);
      const error = await rejectionOf(
        initGithub(
          options({ run: gh.run, out: recordingOutput().out, signal: AbortSignal.abort() }),
        ),
      );
      expect(isMongoShieldError(error, "MS_ABORTED")).toBe(true);
      expect(gh.calls).toEqual([]);
      await expect(stat(join(cwd, "mongoshield.key"))).rejects.toThrow();
    });
  });

  describe("storage kinds", () => {
    const notLoggedIn = (call: Call) => (call.args[0] === "auth" ? { exitCode: 1 } : undefined);

    it("uses a storage URL with its secrets and the storage lock by default", async () => {
      const gh = fakeRunner(happyGh);
      listedRuns = ["[]", JSON.stringify([{ databaseId: 11, url: "https://x/11" }])];
      const result = await initGithub(
        options({
          run: gh.run,
          out: recordingOutput().out,
          storage: {
            kind: "url",
            url: "s3://bucket/prod",
            secrets: { AWS_SECRET_ACCESS_KEY: "y" },
          },
        }),
      );
      expect(result.recoveryKit).toBe(true);
      const config = JSON.parse(await readFile(join(cwd, "mongoshield.config.json"), "utf8"));
      expect(config.storage).toBe("s3://bucket/prod");
      expect(config.schedule.lock).toBe("storage");
      const secretCall = gh.calls.find(
        (call) => call.args.join(" ") === "secret set AWS_SECRET_ACCESS_KEY",
      );
      expect(secretCall?.input).toBe("y");
    });

    it("sets only the key variable and the URI for a storage URL without secrets", async () => {
      const gh = fakeRunner(happyGh);
      await initGithub(
        options({
          run: gh.run,
          out: recordingOutput().out,
          storage: { kind: "url", url: "file:///backups" },
          firstRun: false,
        }),
      );
      expect(
        gh.calls.map(gh.line).filter((line) => /secret set|variable set/.test(line)),
      ).toHaveLength(2);
      const workflow = await readFile(join(cwd, GITHUB_WORKFLOW_FILE), "utf8");
      // The Action step gets no env: block, as there are no storage secrets to pass.
      expect(workflow.endsWith("recipients: ${{ vars.MONGOSHIELD_RECIPIENTS }}\n")).toBe(true);
    });

    it("needs openStorage to write the recovery kit to a storage URL", async () => {
      const error = await rejectionOf(
        initGithub(
          options({
            run: fakeRunner(notLoggedIn).run,
            out: recordingOutput().out,
            storage: { kind: "url", url: "s3://bucket" },
            openStorage: undefined as never,
          }),
        ),
      );
      expect(isMongoShieldError(error, "MS_INTERNAL")).toBe(true);
    });

    it("needs a recovery passphrase for storage that keeps a recovery kit", async () => {
      const error = await rejectionOf(
        initGithub(
          options({
            run: fakeRunner(notLoggedIn).run,
            out: recordingOutput().out,
            recoveryPassphrase: undefined as never,
          }),
        ),
      );
      expect(isMongoShieldError(error, "MS_CONFIG_INVALID")).toBe(true);
      expect((error as { hint?: string }).hint).toMatch(/MONGOSHIELD_RECOVERY_PASSPHRASE/);
      expect(await storage.head("_state/recovery-kit.age")).toBeUndefined();
    });

    it("prints a plain gh secret set line and no cleanup for GitHub artifacts without a URI", async () => {
      const { out, lines } = recordingOutput();
      const result = await initGithub(
        options({
          run: fakeRunner(notLoggedIn).run,
          out,
          storage: { kind: "github-artifacts" },
          mongodbUri: undefined as never,
        }),
      );
      expect(result.github).toBe("manual");
      const results = lines.filter((line) => line.startsWith("result: "));
      expect(results).toContain("result: gh secret set MONGODB_URI");
      // No secret value was written to a file, so there is nothing to remove.
      expect(results.some((line) => line.startsWith("result: rm -r"))).toBe(false);
    });

    it("writes the recovery kit to Google Drive by itself when no openStorage is given", async () => {
      const server = await startFakeGdriveServer();
      const realFetch = globalThis.fetch;
      // Send Google's endpoints to the fake; nothing leaves the machine.
      vi.stubGlobal("fetch", (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input instanceof Request ? input.url : input)
          .replace("https://www.googleapis.com", server.endpoint)
          .replace("https://oauth2.googleapis.com", server.endpoint);
        return realFetch(url, init);
      });
      try {
        const result = await initGithub(
          options({
            run: fakeRunner(notLoggedIn).run,
            out: recordingOutput().out,
            storage: { kind: "gdrive", url: "gdrive://my-app", refreshToken: server.refreshToken },
            openStorage: undefined as never,
            env: {
              MONGOSHIELD_GDRIVE_CLIENT_ID: server.clientId,
              MONGOSHIELD_GDRIVE_CLIENT_SECRET: server.clientSecret,
            },
          }),
        );
        expect(result.recoveryKit).toBe(true);
        const kit = [...server.files.values()].find((file) => file.name === "recovery-kit.age");
        expect(kit && server.pathOf(kit.id)).toBe("MongoShield/my-app/_state/recovery-kit.age");
      } finally {
        vi.unstubAllGlobals();
        await server.close();
      }
    });
  });

  describe("files", () => {
    const notLoggedIn = (call: Call) => (call.args[0] === "auth" ? { exitCode: 1 } : undefined);

    it("uses the configFile option as given, relative to the repository", async () => {
      const { out, lines } = recordingOutput();
      const result = await initGithub(
        options({ run: fakeRunner(notLoggedIn).run, out, configFile: join(cwd, "ci/backup.json") }),
      );
      expect(result.configFile).toBe(join("ci", "backup.json"));
      await expect(stat(join(cwd, "mongoshield.config.json"))).rejects.toThrow();
      const workflow = await readFile(join(cwd, GITHUB_WORKFLOW_FILE), "utf8");
      expect(workflow).toContain(`config: ${join("ci", "backup.json")}`);
      expect(
        lines.some((line) =>
          line.startsWith(
            `result: git add ${GITHUB_WORKFLOW_FILE} ${join("ci", "backup.json")} &&`,
          ),
        ),
      ).toBe(true);
    });

    it("refuses to overwrite an existing workflow, with a hint", async () => {
      await mkdir(join(cwd, ".github/workflows"), { recursive: true });
      await writeFile(join(cwd, GITHUB_WORKFLOW_FILE), "name: mine\n");
      const error = await rejectionOf(
        initGithub(options({ run: fakeRunner(notLoggedIn).run, out: recordingOutput().out })),
      );
      expect(isMongoShieldError(error, "MS_CONFIG_INVALID")).toBe(true);
      expect(String(error)).toMatch(/already exists; refusing to overwrite it/);
      expect((error as { hint?: string }).hint).toMatch(/Delete it first/);
      expect(await readFile(join(cwd, GITHUB_WORKFLOW_FILE), "utf8")).toBe("name: mine\n");
    });

    it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
      "passes on a write error other than an existing file",
      async () => {
        const workflows = join(cwd, ".github/workflows");
        await mkdir(workflows, { recursive: true });
        await chmod(workflows, 0o500);
        try {
          const error = await rejectionOf(
            initGithub(options({ run: fakeRunner(notLoggedIn).run, out: recordingOutput().out })),
          );
          expect((error as { code?: string }).code).toBe("EACCES");
        } finally {
          await chmod(workflows, 0o700);
        }
      },
    );

    it("leaves .gitignore alone when it already ignores *.key", async () => {
      await writeFile(join(cwd, ".gitignore"), "node_modules\n*.key\n");
      const { out, lines } = recordingOutput();
      await initGithub(options({ run: fakeRunner(notLoggedIn).run, out }));
      expect(await readFile(join(cwd, ".gitignore"), "utf8")).toBe("node_modules\n*.key\n");
      expect(lines.some((line) => line.includes(".gitignore"))).toBe(false);
    });

    it("adds the key on a new line to a .gitignore without a final newline", async () => {
      await writeFile(join(cwd, ".gitignore"), "node_modules");
      await initGithub(options({ run: fakeRunner(notLoggedIn).run, out: recordingOutput().out }));
      expect(await readFile(join(cwd, ".gitignore"), "utf8")).toBe(
        "node_modules\n# MongoShield secret key: never commit it\n/mongoshield.key\n",
      );
    });

    it("does not touch .gitignore for a key file outside the repository, and shows its full path", async () => {
      const elsewhere = await mkdtemp(join(tmpdir(), "mongoshield-key-"));
      try {
        const keyFile = join(elsewhere, "backup.key");
        const { out, lines } = recordingOutput();
        const result = await initGithub(
          options({ run: fakeRunner(notLoggedIn).run, out, keyFile }),
        );
        expect(result.keyFile).toBe(keyFile);
        await expect(stat(join(cwd, ".gitignore"))).rejects.toThrow();
        expect(lines).toContain(
          `success: Saved the secret key to ${keyFile} (keep an offline copy).`,
        );
      } finally {
        await rm(elsewhere, { recursive: true, force: true });
      }
    });
  });
});

describe("spawnRunner", () => {
  it("runs a command without a shell, with stdin, and collects its output and exit code", async () => {
    const run = spawnRunner(tmpdir());
    const script =
      "let input = ''; process.stdin.on('data', (d) => { input += d; });" +
      "process.stdin.on('end', () => { process.stdout.write('out:' + input + ':' + process.argv[1]);" +
      "process.stderr.write('err'); process.exit(3); });";
    const result = await run(process.execPath, ["-e", script, "$HOME;not-expanded"], {
      input: "secret",
    });
    expect(result).toEqual({ exitCode: 3, stdout: "out:secret:$HOME;not-expanded", stderr: "err" });
  });

  it("answers exit code 127 for a command that does not exist, instead of throwing", async () => {
    const result = await spawnRunner(tmpdir())("mongoshield-no-such-command-xyz", []);
    expect(result.exitCode).toBe(127);
    expect(result.stderr).toMatch(/ENOENT/);
  });
});

/** The error a promise rejects with. */
async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error("expected a rejection");
    },
    (error: unknown) => error,
  );
}
