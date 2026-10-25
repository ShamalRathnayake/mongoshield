/**
 * Asking before doing something destructive (dropping collections, deleting backups).
 *
 * The rules, in order:
 *   1. `--yes` answers for the user (scripts, CI).
 *   2. Without a person at a terminal, refuse: a script that would destroy data
 *      must say so explicitly with `--yes`, never by accident.
 *   3. Otherwise ask, defaulting to "No".
 */

import { confirm, isCancel } from "@clack/prompts";
import { MongoShieldError } from "../errors.ts";
import type { CommandContext } from "./command.ts";

/** What to ask, and what to say when refusing in non-interactive mode. */
export interface ConfirmRequest {
  /** The yes/no question, e.g. "Drop 3 collections and restore into them?". */
  readonly question: string;
  /** The command to suggest when refusing, e.g. "mongoshield restore … --yes". */
  readonly action: string;
}

/**
 * Resolves when the user agreed. Throws `MS_CONFIRMATION_REQUIRED` when
 * confirmation is needed but nobody can give it, and `MS_ABORTED` when the user says no.
 */
export async function confirmOrThrow(
  context: CommandContext,
  request: ConfirmRequest,
): Promise<void> {
  if (context.global.yes) return;

  if (!context.out.interactive) {
    throw new MongoShieldError(
      "MS_CONFIRMATION_REQUIRED",
      `Refusing to ${request.action} without confirmation in a non-interactive session.`,
      { hint: "Review the plan above, then re-run with --yes to confirm." },
    );
  }

  const answer = await confirm({
    message: request.question,
    initialValue: false,
    // Prompts go to stderr so stdout stays clean for results and --json.
    output: context.io.stderr,
    ...(context.io.stdin ? { input: context.io.stdin } : {}),
    signal: context.signal,
  });
  if (isCancel(answer) || answer !== true) {
    throw new MongoShieldError("MS_ABORTED", "Cancelled. Nothing was changed.");
  }
}
