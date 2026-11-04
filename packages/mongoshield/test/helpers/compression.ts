/**
 * The compression tests use when they only need "some compression", not zstd itself.
 *
 * The package supports Node.js 22.12+, but `node:zlib` only has zstd since 22.15 /
 * 23.8, and the library refuses an explicit zstd request on a runtime without it.
 * Tests that just need compressed files therefore use `TEST_COMPRESSION`: zstd where
 * the runtime has it (so modern Node keeps exercising the default codec), gzip
 * otherwise. Tests whose point IS zstd skip themselves with `ZSTD_UNAVAILABLE`.
 *
 *   await writeTestBackup(storage, { namespaces, compression: TEST_COMPRESSION });
 *   expect(key).toMatch(new RegExp(`\\.bson${TEST_EXTENSION_PATTERN}$`));
 *   it.skipIf(ZSTD_UNAVAILABLE)("round-trips with zstd", ...);
 */

import { defaultCompression, isZstdAvailable } from "../../src/compression/index.ts";
import { COMPRESSION_EXTENSIONS } from "../../src/format/layout.ts";
import type { Compression } from "../../src/format/manifest.ts";

/** The library's own default: zstd where this Node.js has it, gzip otherwise. */
export const TEST_COMPRESSION: Compression = defaultCompression();

/** The file extension of `TEST_COMPRESSION` (`".zst"` or `".gz"`). */
export const TEST_EXTENSION: string = COMPRESSION_EXTENSIONS[TEST_COMPRESSION];

/** `TEST_EXTENSION` escaped for use inside a regular expression (`"\\.zst"`). */
export const TEST_EXTENSION_PATTERN: string = TEST_EXTENSION.replace(".", "\\.");

/**
 * True on a Node.js without zstd (before 22.15 / 23.8). Use it as
 * `it.skipIf(ZSTD_UNAVAILABLE)` for tests that must run zstd itself.
 */
export const ZSTD_UNAVAILABLE: boolean = !isZstdAvailable();
