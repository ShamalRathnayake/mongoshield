/**
 * Writes the CRD manifests from src/api/crds.ts (the source of truth):
 *
 *   deploy/helm/mongoshield-operator/crds/mongoshield.io_crds.yaml   installed by Helm before templates
 *   deploy/operator/crds.yaml                                        for `kubectl apply -f`
 *
 *   node scripts/generate-crds.ts           write the files
 *   node scripts/generate-crds.ts --check   fail if they are out of date (CI)
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { renderCrdsYaml } from "../src/api/crds-yaml.ts";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

/** Where the generated copies live, relative to the repository root. */
export const CRD_FILES = [
  "deploy/helm/mongoshield-operator/crds/mongoshield.io_crds.yaml",
  "deploy/operator/crds.yaml",
];

async function main(): Promise<void> {
  const check = process.argv.includes("--check");
  const expected = renderCrdsYaml();
  let stale = 0;
  for (const relative of CRD_FILES) {
    const path = resolve(repositoryRoot, relative);
    if (check) {
      const actual = await readFile(path, "utf8").catch(() => "");
      if (actual !== expected) {
        process.stderr.write(
          `${relative} is out of date. Run: pnpm --filter @mongoshield/operator crds\n`,
        );
        stale += 1;
      }
      continue;
    }
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, expected);
    process.stdout.write(`wrote ${relative}\n`);
  }
  if (stale > 0) process.exit(1);
}

await main();
