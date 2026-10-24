// The official MongoDB Database Tools (mongodump, mongorestore) for the compatibility
// tests in test/integration/interop*.test.ts. MongoShield itself never runs them; the
// tests use them to prove that what MongoShield reads and writes is what the real
// tools write and read.
//
// The tools come from MONGO_TOOLS_BIN, or from packages/mongoshield/.tools/ (fill it
// with `node scripts/fetch-mongo-tools.ts`). Without them the tests are skipped locally,
// but fail in CI (CI=true), where a skipped compatibility test would hide a regression.

import { execFile } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { mongoUri } from "./mongo.ts";

const run = promisify(execFile);

/** The directory holding mongodump and mongorestore, or undefined when they are not installed. */
function findToolsBin(): string | undefined {
  const fromEnv = process.env.MONGO_TOOLS_BIN;
  if (fromEnv !== undefined && fromEnv !== "") return fromEnv;
  const toolsRoot = fileURLToPath(new URL("../../.tools/", import.meta.url));
  if (!existsSync(toolsRoot)) return undefined;
  for (const entry of readdirSync(toolsRoot)) {
    const bin = join(toolsRoot, entry, "bin");
    if (existsSync(join(bin, "mongodump")) || existsSync(join(bin, "mongodump.exe"))) return bin;
  }
  return undefined;
}

/** Where the tools are; undefined when they are missing (outside CI only). */
export const toolsBin: string | undefined = findToolsBin();

if (toolsBin === undefined && process.env.CI === "true") {
  throw new Error(
    "The MongoDB Database Tools are missing in CI: run `node scripts/fetch-mongo-tools.ts` and set MONGO_TOOLS_BIN.",
  );
}

/** True when the compatibility tests cannot run (`describe.skipIf(toolsMissing)`). */
export const toolsMissing: boolean = toolsBin === undefined;

/**
 * Runs mongodump or mongorestore against the test replica set (or `options.uri`);
 * fails the test with the tool's output on error. Returns the tool's stderr (where
 * both tools log).
 */
export async function tool(
  name: "mongodump" | "mongorestore",
  args: readonly string[],
  options: { readonly uri?: string } = {},
): Promise<string> {
  if (toolsBin === undefined) throw new Error("tools not installed");
  try {
    const uri = options.uri ?? mongoUri();
    const result = await run(join(toolsBin, name), ["--uri", uri, ...args], {
      maxBuffer: 64 * 1024 * 1024,
    });
    return result.stderr;
  } catch (error) {
    const stderr = String(Reflect.get(Object(error), "stderr") ?? "");
    throw new Error(`${name} ${args.join(" ")} failed:\n${stderr}`);
  }
}
