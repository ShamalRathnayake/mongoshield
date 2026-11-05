/**
 * Tests for the destinations of `mongoshield init` (init-destinations.ts): for every
 * entry of the menu, the questions it asks (with what they pre-fill from `--storage`
 * and which answers they refuse), the storage URL it builds from the answers, the
 * comment it writes into the config and the next steps, secrets and login it reports.
 * The questions are answered by a scripted prompter instead of a terminal; the wizard
 * itself is tested end to end in init.test.ts.
 */

import { describe, expect, it } from "vitest";
import {
  destinationById,
  destinationForStorage,
  GITHUB_ARTIFACTS_LABEL,
  type InitDestination,
  type InitDestinationId,
  type InitPrompter,
  type InitTextQuestion,
} from "./init-destinations.ts";

/** The destination with `id` (fails the test when there is none). */
function destination(id: InitDestinationId): InitDestination {
  const found = destinationById(id);
  if (found === undefined) throw new Error(`no destination ${id}`);
  return found;
}

/**
 * A prompter that gives `answers` in order, the way a person would type them: each
 * one must pass the question's own validation. It records every question it was asked.
 */
function scriptedPrompter(answers: readonly string[]): {
  prompter: InitPrompter;
  asked: InitTextQuestion[];
} {
  const asked: InitTextQuestion[] = [];
  const prompter: InitPrompter = {
    async text(question) {
      const answer = answers[asked.length];
      asked.push(question);
      if (answer === undefined) throw new Error(`unexpected question: ${question.message}`);
      const problem = question.validate?.(answer);
      if (problem !== undefined) throw new Error(`"${answer}" was refused: ${problem}`);
      return answer.trim();
    },
  };
  return { prompter, asked };
}

/** Asks `id`'s questions with `answers`; returns the URL and the questions asked. */
async function ask(
  id: InitDestinationId,
  answers: readonly string[],
  current?: string,
): Promise<{ storage: string; asked: InitTextQuestion[] }> {
  const { prompter, asked } = scriptedPrompter(answers);
  const storage = await destination(id).ask(prompter, current);
  return { storage, asked };
}

/** What `question` says about each value: undefined when accepted, else the problem. */
function verdicts(
  question: InitTextQuestion | undefined,
  values: readonly string[],
): (string | undefined)[] {
  return values.map((value) => question?.validate?.(value));
}

describe("the drive destinations of mongoshield init", () => {
  it.each([
    ["gdrive", "Google Drive", "a folder MongoShield creates in your Google Drive"],
    ["dropbox", "Dropbox", "MongoShield's own app folder in your Dropbox"],
  ] as const)("%s asks for a folder and builds %s's URL from it", async (id, name, where) => {
    const fresh = await ask(id, ["/Prod Backups/mongo/"]);
    expect(fresh.storage).toBe(`${id}://Prod%20Backups/mongo`);
    expect(fresh.asked[0]?.message).toContain(where);
    expect(fresh.asked[0]?.initialValue).toBe("mongoshield-backups");
    expect(destination(id).label).toContain(name);

    // A --storage value for this drive pre-fills the folder.
    const prefilled = await ask(id, ["prod/db"], `${id}://prod/db`);
    expect(prefilled.asked[0]?.initialValue).toBe("prod/db");
    expect(prefilled.storage).toBe(`${id}://prod/db`);
  });

  it("refuses folder names a drive URL cannot hold", async () => {
    const { asked } = await ask("gdrive", ["ok"]);
    expect(
      verdicts(asked[0], ["", " / ", "a//b", "../up", "a/./b", "a?b", "a#b", "50%", "a\\b"]),
    ).toEqual([
      "Enter a folder name.",
      "Enter a folder name.",
      'Use folder names separated by "/", without "." or "..".',
      'Use folder names separated by "/", without "." or "..".',
      'Use folder names separated by "/", without "." or "..".',
      'Leave out "\\", "?", "#" and "%".',
      'Leave out "\\", "?", "#" and "%".',
      'Leave out "\\", "?", "#" and "%".',
      'Leave out "\\", "?", "#" and "%".',
    ]);
    expect(verdicts(asked[0], ["a", "a/b/c", "/a/"])).toEqual([undefined, undefined, undefined]);
  });

  it.each([
    ["gdrive", "MONGOSHIELD_GDRIVE_TOKEN"],
    ["dropbox", "MONGOSHIELD_DROPBOX_TOKEN"],
  ] as const)("%s needs a login and its token secret %s", (id, secret) => {
    const drive = destination(id);
    const storage = `${id}://mongoshield-backups`;
    expect(drive.matches(storage)).toBe(true);
    expect(drive.matches(storage.toUpperCase())).toBe(true);
    expect(drive.matches("./backups")).toBe(false);
    expect(drive.defaultStorage).toBe(storage);
    expect(drive.storageForm).toBe(`${id}://<folder>`);

    const comment = drive.configComment(storage).join("\n");
    expect(comment).toContain(`mongoshield login ${id}`);
    expect(comment).toContain(secret);

    const setup = drive.setup(storage);
    expect(setup.loginProvider).toBe(id);
    expect(setup.secrets.map((entry) => entry.name)).toEqual([secret]);
    expect(setup.steps[0]).toContain(`mongoshield login ${id}`);
    expect(setup.steps[1]).toContain(`gh secret set ${secret}`);
    expect(setup.steps[1]).toContain(`mongoshield login ${id} --gh`);
  });
});

describe("the GitHub artifacts destination of mongoshield init", () => {
  it("asks for the directory the workflow uploads, and refuses an empty one", async () => {
    const fresh = await ask("github-artifacts", ["./out"]);
    expect(fresh.storage).toBe("./out");
    expect(fresh.asked[0]?.initialValue).toBe("./backups");
    expect(verdicts(fresh.asked[0], ["", "  ", "./x"])).toEqual([
      "Enter a directory.",
      "Enter a directory.",
      undefined,
    ]);
    const prefilled = await ask("github-artifacts", ["./kept"], "./kept");
    expect(prefilled.asked[0]?.initialValue).toBe("./kept");
  });

  it("is only ever chosen explicitly, and warns that artifacts expire", () => {
    const artifacts = destination("github-artifacts");
    expect(artifacts.label).toBe(GITHUB_ARTIFACTS_LABEL);
    expect(artifacts.matches("./backups")).toBe(false);
    expect(destinationForStorage("./backups").id).toBe("directory");
    expect(artifacts.configComment("./backups").join(" ")).toContain("actions/upload-artifact");

    const setup = artifacts.setup("./nightly");
    expect(setup.steps[0]).toContain("upload ./nightly with actions/upload-artifact");
    expect(setup.secrets).toEqual([]);
    expect(setup.loginProvider).toBeUndefined();
    expect(setup.notes?.[0]).toContain("deleted after 90 days at most");
  });
});

describe("the Backblaze B2 destination of mongoshield init", () => {
  it("builds the URL from the bucket, a lower-cased region and the folder", async () => {
    const { storage, asked } = await ask("b2", ["acme-backups", "US-WEST-004", "prod/db"]);
    expect(storage).toBe("b2://acme-backups/prod/db?region=us-west-004");
    // Without --storage: no bucket to pre-fill, an empty region and the default folder.
    expect(asked[0]?.initialValue).toBeUndefined();
    expect(asked[1]?.initialValue).toBe("");
    expect(asked[1]?.placeholder).toBe("us-west-004");
    expect(asked[2]?.initialValue).toBe("mongoshield");
  });

  it("writes to the bucket root when the folder is left empty", async () => {
    const { storage } = await ask("b2", ["acme", "eu-central-003", ""]);
    expect(storage).toBe("b2://acme?region=eu-central-003");
  });

  it("pre-fills every answer from a b2:// --storage", async () => {
    const current = "b2://acme/prod/db?region=eu-central-003";
    const { storage, asked } = await ask("b2", ["acme", "eu-central-003", "prod/db"], current);
    expect(asked.map((question) => question.initialValue)).toEqual([
      "acme",
      "eu-central-003",
      "prod/db",
    ]);
    expect(storage).toBe(current);
  });

  it("pre-fills nothing from a --storage value that is not a URL", async () => {
    const { asked } = await ask("b2", ["acme", "us-west-004", ""], "b2://[broken");
    expect(asked.map((question) => question.initialValue)).toEqual([undefined, "", ""]);
  });

  it("refuses bucket names with slashes or spaces, AWS-style regions and bad folders", async () => {
    const { asked } = await ask("b2", ["acme", "us-west-004", ""]);
    expect(verdicts(asked[0], ["", "a/b", "a b", "a?b", "acme"])).toEqual([
      "Enter the bucket name.",
      'The bucket name has no "/", "?", "#" or spaces.',
      'The bucket name has no "/", "?", "#" or spaces.',
      'The bucket name has no "/", "?", "#" or spaces.',
      undefined,
    ]);
    const regionProblem = "Use a region such as us-west-004 or eu-central-003.";
    expect(verdicts(asked[1], ["us-west-2", "", "eu-central-003"])).toEqual([
      regionProblem,
      regionProblem,
      undefined,
    ]);
    expect(verdicts(asked[2], ["", "a/b", "../x"])).toEqual([
      undefined,
      undefined,
      'Use folder names separated by "/", without "." or "..".',
    ]);
  });

  it("names the bucket in the application key step and needs the two AWS keys", () => {
    const b2 = destination("b2");
    const setup = b2.setup("b2://acme-backups/prod?region=us-west-004");
    expect(setup.steps[0]).toBe("npm install @aws-sdk/client-s3 @aws-sdk/lib-storage");
    expect(setup.steps[1]).toContain("the bucket acme-backups only");
    expect(setup.secrets.map((secret) => secret.name)).toEqual([
      "AWS_ACCESS_KEY_ID",
      "AWS_SECRET_ACCESS_KEY",
    ]);
    expect(setup.notes).toBeUndefined();
    expect(b2.configComment("b2://acme").join(" ")).toContain("application key's keyID");
    expect(b2.matches("b2://acme")).toBe(true);
    expect(b2.matches("s3://acme")).toBe(false);
    expect(b2.defaultStorage).toBeUndefined();
  });
});

describe("the Cloudflare R2 destination of mongoshield init", () => {
  const account = "0123456789abcdef0123456789abcdef";

  it("builds the URL from a lower-cased account id, the bucket and the folder", async () => {
    const { storage, asked } = await ask("r2", [account.toUpperCase(), "acme", "prod"]);
    expect(storage).toBe(`r2://${account}/acme/prod`);
    expect(asked.map((question) => question.initialValue)).toEqual([
      undefined,
      undefined,
      "mongoshield",
    ]);
  });

  it("pre-fills every answer from an r2:// --storage", async () => {
    const current = `r2://${account}/acme/prod/db`;
    const { storage, asked } = await ask("r2", [account, "acme", "prod/db"], current);
    expect(asked.map((question) => question.initialValue)).toEqual([account, "acme", "prod/db"]);
    expect(storage).toBe(current);
  });

  it("refuses an account id that is not 32 hex characters", async () => {
    const { asked } = await ask("r2", [account, "acme", ""]);
    const problem = "The account id is 32 hex characters.";
    expect(verdicts(asked[0], ["nope", `${account}0`, account.replace("a", "g"), account])).toEqual(
      [problem, problem, problem, undefined],
    );
    expect(verdicts(asked[1], ["", "acme"])).toEqual(["Enter the bucket name.", undefined]);
  });

  it("needs the R2 token's keys and warns that the account needs a card", () => {
    const r2 = destination("r2");
    const setup = r2.setup(`r2://${account}/acme`);
    expect(setup.steps[1]).toContain("Manage API tokens");
    expect(setup.secrets.map((secret) => secret.name)).toEqual([
      "AWS_ACCESS_KEY_ID",
      "AWS_SECRET_ACCESS_KEY",
    ]);
    expect(setup.notes?.[0]).toContain("payment card");
    expect(r2.configComment(`r2://${account}/acme`).join(" ")).toContain("R2 API token");
  });
});

describe("the local directory destination of mongoshield init", () => {
  it("asks for a directory (or a URL) and refuses an empty answer", async () => {
    const fresh = await ask("directory", ["/srv/backups"]);
    expect(fresh.storage).toBe("/srv/backups");
    expect(fresh.asked[0]?.initialValue).toBe("./backups");
    expect(fresh.asked[0]?.placeholder).toBe("./backups");
    expect(verdicts(fresh.asked[0], ["", "s3://acme"])).toEqual([
      "Enter a directory or URL.",
      undefined,
    ]);
    const prefilled = await ask("directory", ["./mine"], "./mine");
    expect(prefilled.asked[0]?.initialValue).toBe("./mine");
  });

  it("owns bare paths and file:// URLs, and needs nothing else", () => {
    const directory = destination("directory");
    for (const storage of ["./backups", "/abs/path", "relative", "file:///var/backups"]) {
      expect(directory.matches(storage)).toBe(true);
    }
    expect(directory.matches("s3://acme")).toBe(false);
    expect(directory.setup("./backups")).toEqual({ steps: [], secrets: [] });
    expect(directory.configComment("./backups")).toEqual([
      "A directory on this machine (or a mounted network share).",
    ]);
  });
});

describe("the cloud URL destinations of mongoshield init", () => {
  it.each([
    [
      "s3",
      "npm install @aws-sdk/client-s3 @aws-sdk/lib-storage",
      ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"],
    ],
    ["gs", "npm install @google-cloud/storage", []],
    ["az", "npm install @azure/storage-blob @azure/identity", ["AZURE_STORAGE_CONNECTION_STRING"]],
    ["sftp", "npm install ssh2", ["MONGOSHIELD_SFTP_KEY_FILE"]],
  ] as const)(
    "%s asks for a URL of its own scheme and installs its SDK first",
    async (id, install, secrets) => {
      const fresh = await ask(id, [`${id}://acme/prod`]);
      expect(fresh.storage).toBe(`${id}://acme/prod`);
      expect(fresh.asked[0]?.initialValue).toBe(`${id}://`);
      expect(fresh.asked[0]?.message).toContain(destination(id).storageForm);
      const problem = `Use ${destination(id).storageForm}.`;
      expect(
        verdicts(fresh.asked[0], [`${id}://`, "", "pcloud://acme", `${id.toUpperCase()}://acme`]),
      ).toEqual([problem, problem, problem, undefined]);

      const prefilled = await ask(id, [`${id}://other`], `${id}://other`);
      expect(prefilled.asked[0]?.initialValue).toBe(`${id}://other`);

      const setup = destination(id).setup(`${id}://acme`);
      expect(setup.steps[0]).toBe(install);
      expect(setup.steps.length).toBeGreaterThan(1);
      expect(setup.secrets.map((secret) => secret.name)).toEqual(secrets);
      expect(destination(id).configComment(`${id}://acme`)[0]).toMatch(/never from here|SFTP/);
      expect(destination(id).matches(`${id}://acme`)).toBe(true);
    },
  );
});

describe("the other-URL destination of mongoshield init", () => {
  it("asks for any URL with a scheme and refuses a bare path", async () => {
    const fresh = await ask("url", ["pcloud://backups"]);
    expect(fresh.storage).toBe("pcloud://backups");
    expect(fresh.asked[0]?.placeholder).toBe("pcloud://backups");
    expect(fresh.asked[0]?.initialValue).toBeUndefined();
    expect(verdicts(fresh.asked[0], ["./dir", "", "1x://y", "x+y.z-w://ok"])).toEqual([
      "Use <scheme>://…",
      "Use <scheme>://…",
      "Use <scheme>://…",
      undefined,
    ]);
    const prefilled = await ask("url", ["mega://x"], "mega://x");
    expect(prefilled.asked[0]?.initialValue).toBe("mega://x");
  });

  it("needs no secrets and points at community packages", () => {
    const other = destination("url");
    expect(other.setup("pcloud://x")).toEqual({ steps: [], secrets: [] });
    expect(other.configComment("pcloud://x")[0]).toContain("community packages");
  });
});

describe("finding a destination", () => {
  it("finds destinations by id, and nothing for an unknown id", () => {
    expect(destinationById("b2")?.id).toBe("b2");
    expect(destinationById("icloud")).toBeUndefined();
  });

  it.each([
    ["gdrive://folder", "gdrive"],
    ["Dropbox://folder", "dropbox"],
    ["dropbox://folder", "dropbox"],
    ["B2://acme?region=us-west-004", "b2"],
    [`r2://${"a".repeat(32)}/acme`, "r2"],
    ["  ./backups  ", "directory"],
    ["file:///var/backups", "directory"],
    ["s3://acme", "s3"],
    ["gs://acme", "gs"],
    ["az://account/container", "az"],
    [" sftp://user@host/path ", "sftp"],
    ["pcloud://backups", "url"],
  ] as const)("gives %s the %s next steps", (storage, id) => {
    expect(destinationForStorage(storage).id).toBe(id);
  });
});
