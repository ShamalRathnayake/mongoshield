/**
 * Downloads the official MongoDB Database Tools (mongodump, mongorestore, …) for
 * this platform into packages/mongoshield/.tools/, for the compatibility tests in
 * test/integration/interop.test.ts. MongoShield itself never runs these binaries;
 * the tests use them to prove that our archives and directories are what the real
 * tools read and write.
 *
 * Run with:  node scripts/fetch-mongo-tools.ts            (from packages/mongoshield)
 * Prints the `bin` directory as the last line of stdout, so CI can do
 *   echo "MONGO_TOOLS_BIN=$(node scripts/fetch-mongo-tools.ts | tail -1)" >> "$GITHUB_ENV"
 *
 * The release index (downloads.mongodb.org/tools/db/full.json) gives the archive URL
 * and its SHA-256; the download is verified before it is unpacked. Running it again
 * is a no-op once the tools are in place.
 *
 * Environment overrides:
 *   MONGO_TOOLS_VERSION    release to fetch (default below)
 *   MONGO_TOOLS_PLATFORM   release platform name, e.g. ubuntu2404, debian12, rhel93, macos
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** The tools release the tests are known to pass with. */
const DEFAULT_VERSION = "100.16.0";

/** The index of every Database Tools release, with download URLs and checksums. */
const RELEASE_INDEX_URL = "https://downloads.mongodb.org/tools/db/full.json";

/** packages/mongoshield/.tools/ (git-ignored). */
const TOOLS_DIRECTORY = fileURLToPath(new URL("../.tools/", import.meta.url));

/** One downloadable build in the release index. */
interface ReleaseDownload {
  readonly name: string;
  readonly arch: string;
  readonly archive: { readonly url: string; readonly sha256: string };
}

async function main(): Promise<void> {
  const version = process.env.MONGO_TOOLS_VERSION ?? DEFAULT_VERSION;
  const platform = process.env.MONGO_TOOLS_PLATFORM ?? detectPlatform();
  const arch = releaseArch(platform);

  const download = await findDownload(version, platform, arch);
  const fileName = download.archive.url.slice(download.archive.url.lastIndexOf("/") + 1);
  // The archives unpack into a directory named like the file without its extension.
  const unpackedName = fileName.replace(/\.(tgz|zip)$/, "");
  const binDirectory = join(TOOLS_DIRECTORY, unpackedName, "bin");
  const executable = process.platform === "win32" ? "mongodump.exe" : "mongodump";

  if (existsSync(join(binDirectory, executable))) {
    process.stdout.write(`${binDirectory}\n`);
    return;
  }

  process.stderr.write(`Downloading ${download.archive.url}\n`);
  const response = await fetch(download.archive.url);
  if (!response.ok) throw new Error(`Download failed: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());

  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (sha256 !== download.archive.sha256) {
    throw new Error(
      `Checksum mismatch for ${fileName}: got ${sha256}, expected ${download.archive.sha256}`,
    );
  }

  await mkdir(TOOLS_DIRECTORY, { recursive: true });
  const archivePath = join(TOOLS_DIRECTORY, fileName);
  await writeFile(archivePath, bytes);
  try {
    // bsdtar (macOS, Windows) unpacks .zip and .tgz; GNU tar (Linux) gets .tgz builds.
    const result = spawnSync("tar", ["-xf", archivePath, "-C", TOOLS_DIRECTORY], {
      stdio: "inherit",
    });
    if (result.status !== 0) throw new Error(`tar failed with status ${String(result.status)}`);
  } finally {
    await rm(archivePath, { force: true });
  }

  if (!existsSync(join(binDirectory, executable))) {
    throw new Error(`The archive did not contain ${join(unpackedName, "bin", executable)}`);
  }
  process.stdout.write(`${binDirectory}\n`);
}

/** Finds the build for this platform in the release index. */
async function findDownload(
  version: string,
  platform: string,
  arch: string,
): Promise<ReleaseDownload> {
  const response = await fetch(RELEASE_INDEX_URL);
  if (!response.ok)
    throw new Error(`Fetching ${RELEASE_INDEX_URL} failed: HTTP ${response.status}`);
  const index: unknown = await response.json();
  const versions: unknown =
    typeof index === "object" && index !== null ? Reflect.get(index, "versions") : undefined;
  if (!Array.isArray(versions)) throw new Error("Unexpected release index format");

  const release: unknown = versions.find(
    (entry: unknown) => readString(entry, "version") === version,
  );
  const downloads: unknown =
    typeof release === "object" && release !== null ? Reflect.get(release, "downloads") : undefined;
  if (!Array.isArray(downloads))
    throw new Error(`Database Tools ${version} is not in the release index`);

  for (const entry of downloads) {
    if (readString(entry, "name") !== platform || readString(entry, "arch") !== arch) continue;
    const archive: unknown = Reflect.get(Object(entry), "archive");
    const url = readString(archive, "url");
    const sha256 = readString(archive, "sha256");
    if (url !== undefined && sha256 !== undefined) {
      return { name: platform, arch, archive: { url, sha256 } };
    }
  }
  const available = downloads.map(
    (entry: unknown) => `${readString(entry, "name")}/${readString(entry, "arch")}`,
  );
  throw new Error(
    `No Database Tools ${version} build for ${platform}/${arch}. Set MONGO_TOOLS_PLATFORM to one of: ${available.join(", ")}`,
  );
}

/** The release platform name for this machine: macos, windows, or a Linux distribution. */
function detectPlatform(): string {
  if (process.platform === "darwin") return "macos";
  if (process.platform === "win32") return "windows";
  if (process.platform !== "linux") throw new Error(`Unsupported platform ${process.platform}`);

  // Linux builds are per distribution; fall back to Ubuntu 22.04, which runs on
  // most current glibc-based systems.
  const osRelease = existsSync("/etc/os-release") ? readFileSync("/etc/os-release", "utf8") : "";
  const id = /^ID="?([^"\n]+)"?$/m.exec(osRelease)?.[1];
  const versionId = /^VERSION_ID="?([^"\n]+)"?$/m.exec(osRelease)?.[1] ?? "";
  if (id === "ubuntu" && ["20.04", "22.04", "24.04"].includes(versionId)) {
    return `ubuntu${versionId.replace(".", "")}`;
  }
  if (id === "debian" && ["11", "12"].includes(versionId)) return `debian${versionId}`;
  return "ubuntu2204";
}

/** The release index's name for this CPU (it differs between platforms). */
function releaseArch(platform: string): string {
  if (process.arch === "x64") return "x86_64";
  if (process.arch === "arm64") {
    return platform === "macos" || platform.startsWith("ubuntu") ? "arm64" : "aarch64";
  }
  throw new Error(`Unsupported CPU architecture ${process.arch}`);
}

function readString(value: unknown, key: string): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const field: unknown = Reflect.get(value, key);
  return typeof field === "string" ? field : undefined;
}

await main();
