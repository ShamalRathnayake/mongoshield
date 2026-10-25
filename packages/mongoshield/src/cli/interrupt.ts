/**
 * What Ctrl-C (and SIGTERM for one-off commands) does to the CLI.
 *
 * The first press aborts the running operation, so it stops cleanly: connections
 * are closed, no half-written manifest is left behind, and the command exits with
 * code 60 (cancelled). A second press exits immediately with 130, the shell
 * convention for "terminated by SIGINT" (128 + signal number 2), for when the
 * clean stop takes longer than the person is willing to wait.
 *
 * Kept apart from index.ts, which wires it to the real process, so it can be
 * tested without sending signals.
 */

/** Exit code for "terminated by SIGINT" (128 + signal number 2). */
export const SIGINT_EXIT_CODE = 130;

/** The message printed on the first press. */
export const CANCELLING_MESSAGE = "\nCancelling… (press Ctrl-C again to exit immediately)\n";

/** The side effects of an interrupt, passed in so tests can observe them. */
export interface InterruptEffects {
  /** Cancels the running operation (an AbortController's `abort`). */
  abort(): void;
  /** Ends the process with a code (`process.exit`). */
  exit(code: number): void;
  /** Writes a message for the person at the terminal (stderr). */
  write(message: string): void;
}

/** Returns the signal handler: abort on the first call, exit on any later one. */
export function createInterruptHandler(effects: InterruptEffects): () => void {
  let interruptCount = 0;
  return () => {
    interruptCount++;
    if (interruptCount > 1) {
      effects.exit(SIGINT_EXIT_CODE);
      return;
    }
    effects.write(CANCELLING_MESSAGE);
    effects.abort();
  };
}
