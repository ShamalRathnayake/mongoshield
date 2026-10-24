// Runs `mongoshield …` through `runCli` with in-memory stdout/stderr, for the recovery
// extras' CLI tests. Commands not yet in the registry are added by each test file with
// vi.mock (see restore-tenant.test.ts).

import { Writable } from "node:stream";
import type { CliIo } from "../../../src/cli/io.ts";
import { runCli } from "../../../src/cli/run.ts";

/** What one CLI run printed and returned. */
export interface CliRun {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Runs the CLI with `args` in `cwd`, without a terminal (so confirmations need --yes). */
export async function runTestCli(
  args: readonly string[],
  cwd: string,
  env: Record<string, string> = {},
): Promise<CliRun> {
  let stdout = "";
  let stderr = "";
  const sink = (append: (text: string) => void) =>
    new Writable({
      write(chunk: Buffer | string, _encoding, done) {
        append(chunk.toString());
        done();
      },
    });
  const io: CliIo = {
    stdout: sink((text) => {
      stdout += text;
    }),
    stderr: sink((text) => {
      stderr += text;
    }),
    env,
    cwd,
    isTTY: false,
  };
  const code = await runCli(args, io);
  return { code, stdout, stderr };
}
