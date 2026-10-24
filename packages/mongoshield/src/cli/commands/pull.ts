/**
 * `mongoshield pull`: copy (production) data into a local MongoDB for development.
 *
 * It is `copy` with defaults chosen so the easy path is the safe one:
 *
 *   - the target defaults to mongodb://localhost:27017;
 *   - the target must be on this machine (every host loopback, or a Unix socket),
 *     unless --allow-remote-target: a typo must never send production data elsewhere;
 *   - masking is REQUIRED: pass --mask <file>, or say explicitly that you want the
 *     raw data with --no-mask --yes (there is no interactive shortcut for that).
 *
 * Everything else (plan, conflicts, confirmation of destructive modes, progress)
 * is the copy flow from copy.ts.
 */

import { isLocalMongoUri } from "../../copy/index.ts";
import { MongoShieldError } from "../../errors.ts";
import { usageError } from "../args.ts";
import type { CommandContext, CommandSpec } from "../command.ts";
import { displayUri } from "../setup.ts";
import {
  COPY_OPTIONS,
  maskFromFlags,
  resolveSourceUri,
  runCopyFlow,
  subsetFromFlags,
} from "./copy.ts";

const NAME = "pull";

/** Where `pull` writes when --to is not given. */
export const DEFAULT_PULL_TARGET = "mongodb://localhost:27017";

/** `mongoshield pull`: see the file header. */
export const pullCommand: CommandSpec = {
  name: NAME,
  summary: "Copy production data into a local MongoDB, masked",
  description: [
    "Like `copy`, with safe defaults for local development: the target defaults to",
    `${DEFAULT_PULL_TARGET} and must be on this machine, and a --mask file is required`,
    "(--no-mask --yes copies raw data, deliberately). Add --subset for a smaller slice.",
  ].join("\n"),
  options: {
    ...COPY_OPTIONS,
    to: {
      type: "string",
      valueName: "<mongodb-uri>",
      defaultText: DEFAULT_PULL_TARGET,
      description: "Copy into this local deployment",
    },
    "no-mask": {
      type: "boolean",
      description: "Copy without masking (needs --yes; the data stays as sensitive as production)",
    },
    "allow-remote-target": {
      type: "boolean",
      description: "Allow a --to that is not on this machine",
    },
  },
  examples: [
    {
      description: "Pull a masked copy of the app database to the local MongoDB",
      command: "mongoshield pull --from $PROD_URI --include 'app.*' --mask ./mask.ts",
    },
    {
      description: "Refresh a masked, recent slice, replacing yesterday's",
      command: "mongoshield pull --mask ./mask.ts --subset ./subset.ts --drop --yes",
    },
  ],
  run: runPull,
};

async function runPull(context: CommandContext): Promise<number> {
  const { flags } = context;
  const targetUri = flags.string("to") ?? DEFAULT_PULL_TARGET;
  assertLocalTarget(context, targetUri);
  assertMaskingDecision(context);

  const sourceUri = await resolveSourceUri(context);
  const mask = await maskFromFlags(context);
  if (mask === undefined) {
    context.out.warn("Pulling WITHOUT masking: the local copy is as sensitive as the source.");
  }
  return runCopyFlow(context, {
    name: NAME,
    sourceUri,
    targetUri,
    mask,
    subset: await subsetFromFlags(context),
  });
}

/** Refuses targets that are not on this machine, unless explicitly allowed. */
function assertLocalTarget(context: CommandContext, targetUri: string): void {
  if (isLocalMongoUri(targetUri) || context.flags.boolean("allow-remote-target")) return;
  throw new MongoShieldError(
    "MS_CONFIG_INVALID",
    `pull only writes to a MongoDB on this machine, and ${displayUri(targetUri)} is not one.`,
    {
      hint: "Use a localhost / 127.0.0.1 URI, add --allow-remote-target if this is intended, or use `mongoshield copy`.",
    },
  );
}

/**
 * Masking is required. Skipping it takes two explicit flags, --no-mask and --yes,
 * and never a prompt: copying raw production data to a laptop should be a decision
 * written down in the command, not a key pressed in passing.
 */
function assertMaskingDecision(context: CommandContext): void {
  const hasMask = context.flags.has("mask");
  const noMask = context.flags.boolean("no-mask");
  if (hasMask && noMask) throw usageError("--mask contradicts --no-mask.", NAME);
  if (hasMask) return;
  if (!noMask) {
    throw new MongoShieldError("MS_CONFIG_INVALID", "pull needs a mask file (--mask ./mask.ts).", {
      hint: "Write one (see docs/guides/staging-data.md), or pass --no-mask --yes to copy unmasked data on purpose.",
    });
  }
  if (!context.global.yes) {
    throw new MongoShieldError(
      "MS_CONFIRMATION_REQUIRED",
      "Refusing to pull unmasked data without --yes.",
      { hint: "Re-run with --no-mask --yes if you really want the raw data locally." },
    );
  }
}
