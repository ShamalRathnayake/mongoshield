/**
 * The destinations `mongoshield init` offers, in menu order: the free drives first,
 * then GitHub artifacts, the S3-compatible services that need no bucket of your own
 * to be paid for, and finally every storage URL.
 *
 *   Google Drive · Dropbox · GitHub artifacts · Backblaze B2 · Cloudflare R2
 *   · a local directory · s3:// · gs:// · az:// · sftp:// · any other URL
 *
 * Each destination knows three things:
 * - which questions turn the person's answers into a storage URL (`ask`), and which
 *   URLs belong to it (`matches`, so `init --storage b2://…` gets the B2 next steps);
 * - what to write above `storage:` in the config (`configComment`, and optional
 *   `extraConfig` lines after it, e.g. a destination that needs other settings);
 * - what to do next (`setup`): steps to print, the secrets a backup needs at run
 *   time, and the `mongoshield login` provider for drives. `init --github` uses the
 *   same data to set repository secrets.
 */

import { OAUTH_APPS, type OAuthProviderId } from "../../storage/oauth/apps.ts";
import { ghSecretSetCommand } from "../github/secrets.ts";

/** Every destination id, also the values of `init --destination`. */
export const INIT_DESTINATION_IDS = [
  "gdrive",
  "dropbox",
  "github-artifacts",
  "b2",
  "r2",
  "directory",
  "s3",
  "gs",
  "az",
  "sftp",
  "url",
] as const;

/** One of {@link INIT_DESTINATION_IDS}. */
export type InitDestinationId = (typeof INIT_DESTINATION_IDS)[number];

/** A text question, as the wizard asks it. Returns the trimmed answer. */
export interface InitTextQuestion {
  readonly message: string;
  readonly placeholder?: string;
  readonly initialValue?: string;
  /** `undefined` when the answer is fine, else what is wrong with it. */
  readonly validate?: (value: string) => string | undefined;
}

/** How a destination asks its questions (the wizard's prompts, or fakes in tests). */
export interface InitPrompter {
  text(question: InitTextQuestion): Promise<string>;
}

/** A secret a backup needs at run time (an environment variable / repository secret). */
export interface InitSecret {
  readonly name: string;
  /** What to put in it, for people. */
  readonly description: string;
}

/** What to do after the config is written. */
export interface DestinationSetup {
  /** Steps in order, each one line (commands or instructions). */
  readonly steps: readonly string[];
  /** Secrets the backup reads from the environment. */
  readonly secrets: readonly InitSecret[];
  /** The `mongoshield login` provider that produces the token secret, for drives. */
  readonly loginProvider?: OAuthProviderId;
  /** Things worth knowing about the destination. */
  readonly notes?: readonly string[];
}

/** One entry of the destination menu. */
export interface InitDestination {
  readonly id: InitDestinationId;
  /** The menu line. */
  readonly label: string;
  /** Whether `storage` (a URL or path) belongs to this destination. */
  matches(storage: string): boolean;
  /** The storage used by `--destination <id>` without `--storage`, if there is a sensible one. */
  readonly defaultStorage?: string;
  /** What `--storage` must look like for this destination, for error hints. */
  readonly storageForm: string;
  /**
   * Asks the follow-up questions and returns the storage URL. `current` is the
   * `--storage` value when it belongs to this destination: its parts pre-fill the answers.
   */
  ask(prompter: InitPrompter, current: string | undefined): Promise<string>;
  /** Comment lines (without indentation) above `storage:` in the config. */
  configComment(storage: string): readonly string[];
  /** Extra config lines (without indentation) after `storage:`, if the destination needs any. */
  extraConfig?(storage: string): readonly string[];
  /** The next steps, secrets and login provider. */
  setup(storage: string): DestinationSetup;
}

/** The exact menu label of GitHub artifacts: the design insists on this wording. */
export const GITHUB_ARTIFACTS_LABEL =
  "GitHub artifacts (quickest to try; deleted after 90 days at most, so not a real backup on its own)";

/** The SDK packages a scheme needs (optional peer dependencies). */
const SDK_INSTALL = {
  s3: "npm install @aws-sdk/client-s3 @aws-sdk/lib-storage",
  gs: "npm install @google-cloud/storage",
  az: "npm install @azure/storage-blob @azure/identity",
  sftp: "npm install ssh2",
} as const;

/** The S3 keys every S3-based destination reads. */
const AWS_KEYS = { id: "AWS_ACCESS_KEY_ID", secret: "AWS_SECRET_ACCESS_KEY" } as const;

/** The lower-cased scheme of a storage URL, or `undefined` for a bare path. */
function schemeOf(storage: string): string | undefined {
  return /^([a-z][a-z0-9+.-]*):\/\//i.exec(storage.trim())?.[1]?.toLowerCase();
}

/** A matcher for URLs of one scheme. */
function hasScheme(scheme: string): (storage: string) => boolean {
  return (storage) => schemeOf(storage) === scheme;
}

/** `undefined` when `value` is a folder path a drive URL can hold, else the problem. */
function folderProblem(value: string): string | undefined {
  const trimmed = value.trim().replace(/^\/+|\/+$/g, "");
  if (trimmed === "") return "Enter a folder name.";
  const segments = trimmed.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    return 'Use folder names separated by "/", without "." or "..".';
  }
  if (/[\\?#%]/.test(trimmed)) return 'Leave out "\\", "?", "#" and "%".';
  return undefined;
}

/** `undefined` when `value` is non-empty and has no slash (a bucket or account name). */
function nameProblem(what: string): (value: string) => string | undefined {
  return (value) => {
    const trimmed = value.trim();
    if (trimmed === "") return `Enter the ${what}.`;
    if (/[/\\?#\s]/.test(trimmed)) return `The ${what} has no "/", "?", "#" or spaces.`;
    return undefined;
  };
}

/** An optional key prefix: empty, or folder names separated by "/". */
function prefixProblem(value: string): string | undefined {
  return value.trim() === "" ? undefined : folderProblem(value);
}

/** The parts of a URL for pre-filling answers; empty strings when it does not parse. */
function urlParts(current: string | undefined): {
  host: string;
  path: string[];
  params: URLSearchParams;
} {
  try {
    const url = new URL(current ?? "");
    const path = decodeURIComponent(url.pathname)
      .split("/")
      .filter((segment) => segment !== "");
    return { host: decodeURIComponent(url.hostname), path, params: url.searchParams };
  } catch {
    return { host: "", path: [], params: new URLSearchParams() };
  }
}

/** `a/b` → `/a/b` for a URL path; "" stays "". */
function pathSuffix(prefix: string): string {
  const trimmed = prefix.trim().replace(/^\/+|\/+$/g, "");
  return trimmed === "" ? "" : `/${trimmed.split("/").map(encodeURIComponent).join("/")}`;
}

/** Google Drive and Dropbox: a folder inside the app's own space, and a login. */
function driveDestination(provider: OAuthProviderId, freeSpace: string): InitDestination {
  const app = OAUTH_APPS[provider];
  const where =
    provider === "gdrive"
      ? "a folder MongoShield creates in your Google Drive (it can only see its own files)"
      : `a folder inside MongoShield's own app folder in your ${app.displayName}`;
  return {
    id: provider,
    label: `${app.displayName} (${freeSpace} free)`,
    matches: hasScheme(provider),
    defaultStorage: `${provider}://mongoshield-backups`,
    storageForm: `${provider}://<folder>`,
    async ask(prompter, current) {
      const parts = urlParts(current);
      const folder = await prompter.text({
        message: `Which folder should backups go in? (${where})`,
        initialValue:
          current === undefined ? "mongoshield-backups" : [parts.host, ...parts.path].join("/"),
        validate: folderProblem,
      });
      const [first = "", ...rest] = folder.replace(/^\/+|\/+$/g, "").split("/");
      return `${provider}://${encodeURIComponent(first)}${pathSuffix(rest.join("/"))}`;
    },
    configComment: () => [
      `${app.displayName}: the folder is ${where}.`,
      `Sign in once with \`mongoshield login ${provider}\`; the token goes in ${app.env.token}.`,
    ],
    setup: () => ({
      steps: [
        `mongoshield login ${provider}     # sign in; prints the token once`,
        `Save the token as the secret ${app.env.token}: ${ghSecretSetCommand(app.env.token)}   (or: mongoshield login ${provider} --gh)`,
      ],
      secrets: [
        {
          name: app.env.token,
          description: `The ${app.displayName} refresh token from \`mongoshield login ${provider}\`.`,
        },
      ],
      loginProvider: provider,
    }),
  };
}

// One constant per drive, each owned by that drive's release: spread the shared one
// and override what the provider needs (`extraConfig`, other questions, more steps).

/** Google Drive (15 GB free, shared with Gmail and Photos). */
const gdrive: InitDestination = driveDestination("gdrive", "15 GB");

/** Dropbox (2 GB free). */
const dropbox: InitDestination = driveDestination("dropbox", "2 GB");

/** GitHub artifacts: a local directory the workflow uploads with actions/upload-artifact. */
const githubArtifacts: InitDestination = {
  id: "github-artifacts",
  label: GITHUB_ARTIFACTS_LABEL,
  // A plain directory: only an explicit choice (menu or --destination) means artifacts.
  matches: () => false,
  defaultStorage: "./backups",
  storageForm: "./<directory>",
  async ask(prompter, current) {
    return prompter.text({
      message: "Which directory should the workflow upload as the artifact?",
      initialValue: current ?? "./backups",
      validate: (value) => (value.trim() === "" ? "Enter a directory." : undefined),
    });
  },
  configComment: () => [
    "GitHub artifacts: the workflow backs up into this directory and uploads it with",
    "actions/upload-artifact. Artifacts are deleted after 90 days at most.",
  ],
  setup: (storage) => ({
    steps: [
      `In the workflow, upload ${storage} with actions/upload-artifact (retention-days: 90 at most);`,
      "see examples/github-actions/atlas-free-tier-artifact.yml",
    ],
    secrets: [],
    notes: [
      "Quickest to try; deleted after 90 days at most, so not a real backup on its own.",
      "Add a second destination (a drive, B2) for copies that outlive the artifacts.",
    ],
  }),
};

/** B2 region names, as in s3.<region>.backblazeb2.com (checked again by the adapter). */
const B2_REGION = /^[a-z]{2}-[a-z]+-\d{3}$/;

/** Backblaze B2: S3-compatible, 10 GB free, no payment card at sign-up. */
const b2: InitDestination = {
  id: "b2",
  label: "Backblaze B2 (10 GB free, no card)",
  matches: hasScheme("b2"),
  storageForm: "b2://<bucket>/<prefix>?region=<region>",
  async ask(prompter, current) {
    const parts = urlParts(current);
    const bucket = await prompter.text({
      message: "B2 bucket name:",
      ...(parts.host === "" ? {} : { initialValue: parts.host }),
      validate: nameProblem("bucket name"),
    });
    const region = await prompter.text({
      message: "B2 region (from the bucket's Endpoint, s3.<region>.backblazeb2.com):",
      placeholder: "us-west-004",
      initialValue: parts.params.get("region") ?? "",
      validate: (value) =>
        B2_REGION.test(value.trim().toLowerCase())
          ? undefined
          : "Use a region such as us-west-004 or eu-central-003.",
    });
    const prefix = await prompter.text({
      message: "Folder inside the bucket (empty for the bucket root):",
      initialValue: current === undefined ? "mongoshield" : parts.path.join("/"),
      validate: prefixProblem,
    });
    return `b2://${bucket}${pathSuffix(prefix)}?region=${region.toLowerCase()}`;
  },
  configComment: () => [
    "Backblaze B2 through its S3 API. Credentials come from AWS_ACCESS_KEY_ID (the",
    "application key's keyID) and AWS_SECRET_ACCESS_KEY (its applicationKey), never from here.",
  ],
  setup: (storage) => ({
    steps: [
      SDK_INSTALL.s3,
      `Backblaze → Application Keys → Add a New Application Key: allow access to the bucket ${urlParts(storage).host} only, Read and Write`,
      `export ${AWS_KEYS.id}="<keyID>"     # the new key's keyID`,
      `export ${AWS_KEYS.secret}="<applicationKey>"     # shown only once by Backblaze`,
    ],
    secrets: [
      { name: AWS_KEYS.id, description: "The B2 application key's keyID." },
      { name: AWS_KEYS.secret, description: "The B2 application key's applicationKey." },
    ],
  }),
};

/** A Cloudflare account id: 32 hex digits. */
const R2_ACCOUNT_ID = /^[0-9a-f]{32}$/i;

/** Cloudflare R2: S3-compatible, 10 GB-month free, free egress; the account needs a card. */
const r2: InitDestination = {
  id: "r2",
  label: "Cloudflare R2 (10 GB free, needs a card)",
  matches: hasScheme("r2"),
  storageForm: "r2://<accountId>/<bucket>/<prefix>",
  async ask(prompter, current) {
    const parts = urlParts(current);
    const accountId = await prompter.text({
      message: "Cloudflare account id (R2 → Overview → Account details):",
      ...(parts.host === "" ? {} : { initialValue: parts.host }),
      validate: (value) =>
        R2_ACCOUNT_ID.test(value.trim()) ? undefined : "The account id is 32 hex characters.",
    });
    const bucket = await prompter.text({
      message: "R2 bucket name:",
      ...(parts.path[0] === undefined ? {} : { initialValue: parts.path[0] }),
      validate: nameProblem("bucket name"),
    });
    const prefix = await prompter.text({
      message: "Folder inside the bucket (empty for the bucket root):",
      initialValue: current === undefined ? "mongoshield" : parts.path.slice(1).join("/"),
      validate: prefixProblem,
    });
    return `r2://${accountId.toLowerCase()}/${bucket}${pathSuffix(prefix)}`;
  },
  configComment: () => [
    "Cloudflare R2 through its S3 API. Credentials come from AWS_ACCESS_KEY_ID and",
    "AWS_SECRET_ACCESS_KEY (an R2 API token's keys), never from here.",
  ],
  setup: () => ({
    steps: [
      SDK_INSTALL.s3,
      "Cloudflare → R2 → Manage API tokens → Create API token: Object Read & Write, for this bucket only",
      `export ${AWS_KEYS.id}="<Access Key ID>"`,
      `export ${AWS_KEYS.secret}="<Secret Access Key>"`,
    ],
    secrets: [
      { name: AWS_KEYS.id, description: "The R2 API token's Access Key ID." },
      { name: AWS_KEYS.secret, description: "The R2 API token's Secret Access Key." },
    ],
    notes: ["R2 asks for a payment card on the Cloudflare account, even on the free tier."],
  }),
};

/** A local directory (or a mounted network share). */
const directory: InitDestination = {
  id: "directory",
  label: "A local directory",
  matches: (storage) => {
    const scheme = schemeOf(storage);
    return scheme === undefined || scheme === "file";
  },
  defaultStorage: "./backups",
  storageForm: "./<directory>",
  async ask(prompter, current) {
    return prompter.text({
      message: "Where should backups be stored?",
      placeholder: "./backups",
      initialValue: current ?? "./backups",
      validate: (value) => (value.trim() === "" ? "Enter a directory or URL." : undefined),
    });
  },
  configComment: () => ["A directory on this machine (or a mounted network share)."],
  setup: () => ({ steps: [], secrets: [] }),
};

/** A URL destination of a cloud SDK scheme: the person types the URL. */
function urlDestination(options: {
  id: "s3" | "gs" | "az" | "sftp";
  label: string;
  form: string;
  comment: readonly string[];
  steps: readonly string[];
  secrets: readonly InitSecret[];
}): InitDestination {
  const prefix = `${options.id}://`;
  return {
    id: options.id,
    label: options.label,
    matches: hasScheme(options.id),
    storageForm: options.form,
    async ask(prompter, current) {
      return prompter.text({
        message: `Storage URL (${options.form}):`,
        initialValue: current ?? prefix,
        validate: (value) =>
          value.trim().toLowerCase().startsWith(prefix) && value.trim().length > prefix.length
            ? undefined
            : `Use ${options.form}.`,
      });
    },
    configComment: () => options.comment,
    setup: () => ({ steps: [SDK_INSTALL[options.id], ...options.steps], secrets: options.secrets }),
  };
}

/** Any other storage URL, e.g. a scheme a community package registers. */
const otherUrl: InitDestination = {
  id: "url",
  label: "Another storage URL",
  matches: (storage) => schemeOf(storage) !== undefined,
  storageForm: "<scheme>://…",
  async ask(prompter, current) {
    return prompter.text({
      message: "Storage URL:",
      placeholder: "pcloud://backups",
      ...(current === undefined ? {} : { initialValue: current }),
      validate: (value) => (schemeOf(value) === undefined ? "Use <scheme>://…" : undefined),
    });
  },
  configComment: () => [
    "A storage URL. Schemes from community packages need the package imported above.",
  ],
  setup: () => ({ steps: [], secrets: [] }),
};

/** The menu, in order (see the file header). */
export const INIT_DESTINATIONS: readonly InitDestination[] = [
  gdrive,
  dropbox,
  githubArtifacts,
  b2,
  r2,
  directory,
  urlDestination({
    id: "s3",
    label: "Amazon S3 or an S3-compatible service (s3://)",
    form: "s3://<bucket>/<prefix>?region=<region>",
    comment: [
      "Amazon S3 (credentials come from the usual AWS environment or profile, never from here).",
    ],
    steps: [
      `export ${AWS_KEYS.id}=… ${AWS_KEYS.secret}=…     # or AWS_PROFILE, or an instance role`,
    ],
    secrets: [
      { name: AWS_KEYS.id, description: "An access key id allowed to use the bucket." },
      { name: AWS_KEYS.secret, description: "Its secret access key." },
    ],
  }),
  urlDestination({
    id: "gs",
    label: "Google Cloud Storage (gs://)",
    form: "gs://<bucket>/<prefix>",
    comment: ["Google Cloud Storage (Application Default Credentials, never from here)."],
    steps: [
      "export GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account.json     # or gcloud auth application-default login",
    ],
    secrets: [],
  }),
  urlDestination({
    id: "az",
    label: "Azure Blob Storage (az://)",
    form: "az://<account>/<container>/<prefix>",
    comment: [
      "Azure Blob Storage (AZURE_STORAGE_CONNECTION_STRING or Microsoft Entra ID, never from here).",
    ],
    steps: ['export AZURE_STORAGE_CONNECTION_STRING="…"     # or az login / a managed identity'],
    secrets: [
      {
        name: "AZURE_STORAGE_CONNECTION_STRING",
        description: "The storage account's connection string.",
      },
    ],
  }),
  urlDestination({
    id: "sftp",
    label: "SFTP (sftp://)",
    form: "sftp://<user>@<host>/<path>?fingerprint=SHA256:…",
    comment: ["SFTP with key authentication (MONGOSHIELD_SFTP_KEY_FILE or ssh-agent)."],
    steps: ["export MONGOSHIELD_SFTP_KEY_FILE=~/.ssh/id_ed25519     # or start ssh-agent"],
    secrets: [
      { name: "MONGOSHIELD_SFTP_KEY_FILE", description: "The path of the SSH private key file." },
    ],
  }),
  otherUrl,
];

/** The destination with id `id`, or `undefined`. */
export function destinationById(id: string): InitDestination | undefined {
  return INIT_DESTINATIONS.find((destination) => destination.id === id);
}

/** The destination a storage URL or path belongs to (a directory or "another URL" at worst). */
export function destinationForStorage(storage: string): InitDestination {
  return INIT_DESTINATIONS.find((destination) => destination.matches(storage)) ?? otherUrl;
}
