import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FileSystemProvider } from "../src/FileSystemProvider";

describe("FileSystemProvider", () => {
  let baseDir: string;

  beforeEach(async () => {
    baseDir = await mkdtemp(join(tmpdir(), "mongoshield-test-"));
  });

  afterEach(async () => {
    await rm(baseDir, { recursive: true, force: true });
  });

  describe("Basic Operations", () => {
    it("should initialize and create a timestamped directory (.tmp) by default", async () => {
      const provider = new FileSystemProvider({ outPath: baseDir });
      await provider.initialize();

      const { readdir } = await import("node:fs/promises");
      const contents = await readdir(baseDir);
      expect(contents.length).toBe(1);
      expect(contents[0]).toContain(".tmp");
    });

    it("should not create a timestamp directory if disableRotation is true", async () => {
      const provider = new FileSystemProvider({
        outPath: baseDir,
        disableRotation: true,
      });
      await provider.initialize();

      const { readdir } = await import("node:fs/promises");
      const contents = await readdir(baseDir);
      expect(contents.length).toBe(0); // uses baseDir directly
    });

    it("should handle initialization with a string path as options", async () => {
      const provider = new FileSystemProvider(baseDir, true); // path + compress=true
      await provider.initialize();
      // @ts-expect-error
      expect(provider.baseOutPath).toBe(baseDir);
      // @ts-expect-error
      expect(provider.compress).toBe(true);
    });

    it("should append .gz extension when compress is true", async () => {
      const provider = new FileSystemProvider({
        outPath: baseDir,
        compress: true,
      });
      await provider.initialize();

      const stream = await provider.createBsonWriteStream("testdb", "testcol");
      stream.write("data");

      // Wait for file creation
      await new Promise((resolve) => setTimeout(resolve, 50));

      // @ts-expect-error
      const runDir = provider.currentRunDir;
      const { readdir } = await import("node:fs/promises");
      const files = await readdir(join(runDir, "testdb"));
      expect(files).toContain("testcol.bson.gz");
      stream.end();
    });

    it("should create monolithic archive streams correctly with compression", async () => {
      const provider = new FileSystemProvider({
        outPath: baseDir,
        compress: true,
      });
      await provider.initialize();

      const stream = await provider.createArchiveWriteStream("backup.msaf");
      stream.write("data");

      await new Promise((resolve) => setTimeout(resolve, 50));

      const runDir = (provider as any).currentRunDir;
      const { readdir } = await import("node:fs/promises");
      const files = await readdir(runDir);

      // Because compress=true and the name doesn't end in .gz, it should append .gz
      expect(files).toContain("backup.msaf.gz");
      stream.end();
    });
  });

  describe("Lifecycle & Atomic Backups", () => {
    it("should follow the full atomic lifecycle correctly", async () => {
      const provider = new FileSystemProvider({ outPath: baseDir });
      await provider.initialize();

      const { readdir } = await import("node:fs/promises");
      let contents = await readdir(baseDir);
      const tmpName = contents[0];
      expect(tmpName.endsWith(".tmp")).toBe(true);

      const stream = await provider.createBsonWriteStream("db", "col");
      stream.write(Buffer.from("test"));

      // Must end stream before rename on Windows
      await new Promise((r) => stream.end(r));
      await new Promise((r) => setTimeout(r, 50));

      await provider.finalize();
      contents = await readdir(baseDir);
      expect(contents[0]).toBe(tmpName.replace(".tmp", ""));
      expect(contents[0].endsWith(".tmp")).toBe(false);
    });

    it("should handle multiple collections concurrently", async () => {
      const provider = new FileSystemProvider({ outPath: baseDir });
      await provider.initialize();

      const s1 = await provider.createBsonWriteStream("db", "col1");
      const s2 = await provider.createBsonWriteStream("db", "col2");

      s1.write("1");
      s2.write("2");

      await Promise.all([
        new Promise((r) => s1.end(r)),
        new Promise((r) => s2.end(r)),
      ]);
      await new Promise((r) => setTimeout(r, 50));
      await provider.finalize();

      const { readdir } = await import("node:fs/promises");
      const runDirName = (await readdir(baseDir))[0];
      const files = await readdir(join(baseDir, runDirName, "db"));
      expect(files).toContain("col1.bson");
      expect(files).toContain("col2.bson");
    });
  });

  describe("Pruning & Retention", () => {
    it("should prune old backups by maxCount", async () => {
      for (let i = 1; i <= 3; i++) {
        await mkdir(join(baseDir, `2026-01-0${i}_12-00-00`), {
          recursive: true,
        });
      }

      const provider = new FileSystemProvider({ outPath: baseDir });
      await provider.initialize();

      const result = await provider.prune({ strategy: "count", maxCount: 1 });
      expect(result.deletedCount).toBe(2);

      const { readdir } = await import("node:fs/promises");
      const completed = (await readdir(baseDir)).filter(
        (c) => !c.endsWith(".tmp"),
      );
      expect(completed.length).toBe(1);
      expect(completed[0]).toBe("2026-01-03_12-00-00");
    });

    it("should implement 'both' strategy correctly (age + count)", async () => {
      // 90 days old
      await mkdir(join(baseDir, "1999-01-01_12-00-00"), { recursive: true });
      // 5 recent ones
      for (let i = 1; i <= 5; i++) {
        await mkdir(join(baseDir, `2026-01-0${i}_12-00-00`), {
          recursive: true,
        });
      }

      const provider = new FileSystemProvider({ outPath: baseDir });
      await provider.initialize();

      const result = await provider.prune({
        strategy: "both",
        maxCount: 2,
        maxDays: 30,
      });
      expect(result.deletedCount).toBe(4); // 1 (old) + 3 (excess count)

      const { readdir } = await import("node:fs/promises");
      const completed = (await readdir(baseDir)).filter(
        (c) => !c.endsWith(".tmp"),
      );
      expect(completed.length).toBe(2);
    });

    it("should cleanup stale .tmp directories and ignore active ones", async () => {
      await mkdir(join(baseDir, "stale.tmp"), { recursive: true });
      await mkdir(join(baseDir, "2026-01-01_12-00-00"), { recursive: true });

      const provider = new FileSystemProvider({ outPath: baseDir });
      await provider.initialize(); // creates active .tmp

      const result = await provider.prune({ strategy: "count", maxCount: 10 });
      expect(result.deletedPaths).toContain(join(baseDir, "stale.tmp"));

      const { readdir } = await import("node:fs/promises");
      const contents = await readdir(baseDir);
      expect(contents).not.toContain("stale.tmp");
      expect(contents.some((c) => c.endsWith(".tmp"))).toBe(true); // active one remains
    });

    it("should ignore regular files during pruning", async () => {
      await writeFile(join(baseDir, "file.txt"), "data");
      await mkdir(join(baseDir, "2026-01-01_12-00-00"), { recursive: true });

      const provider = new FileSystemProvider({ outPath: baseDir });
      await provider.initialize();

      const result = await provider.prune({ strategy: "count", maxCount: 0 });
      expect(result.deletedCount).toBe(1);

      const { readdir } = await import("node:fs/promises");
      const contents = await readdir(baseDir);
      expect(contents).toContain("file.txt");
    });
  });

  describe("Security & Stress", () => {
    it("should prevent path traversal", async () => {
      const provider = new FileSystemProvider({ outPath: baseDir });
      await provider.initialize();
      await expect(
        provider.createBsonWriteStream("../../../etc", "passwd"),
      ).rejects.toThrow();
    });

    it("should handle large scale pruning (150+ directories)", async () => {
      for (let i = 1; i <= 150; i++) {
        // Generate valid looking timestamps: 2026-01-01_00-00-00 ... 2026-01-07_06-00-00
        const day = String(Math.floor(i / 24) + 1).padStart(2, "0");
        const hour = String(i % 24).padStart(2, "0");
        const name = `2026-01-${day}_${hour}-00-00`;
        await mkdir(join(baseDir, name), { recursive: true });
      }

      const provider = new FileSystemProvider({ outPath: baseDir });
      await provider.initialize();
      const result = await provider.prune({ strategy: "count", maxCount: 10 });
      expect(result.deletedCount).toBe(140);
    });

    it("should handle read-only directory errors gracefully", async () => {
      const roDir = join(baseDir, "readonly");
      await mkdir(roDir, { recursive: true });
      await chmod(roDir, 0o555);
      const provider = new FileSystemProvider({ outPath: roDir });
      try {
        await provider.initialize();
      } catch (err: any) {
        expect(err.code).toBe("EACCES");
      } finally {
        await chmod(roDir, 0o755);
      }
    });

    it("should handle prune() when outPath doesn't exist", async () => {
      const provider = new FileSystemProvider({
        outPath: join(baseDir, "ghost"),
      });
      const result = await provider.prune({ strategy: "count", maxCount: 10 });
      expect(result.deletedCount).toBe(0);
    });

    it("should be idempotent when initialized multiple times", async () => {
      const provider = new FileSystemProvider({ outPath: baseDir });
      await provider.initialize();
      const first = (provider as any).currentRunDir;
      await provider.initialize();
      expect((provider as any).currentRunDir).toBe(first);
    });
  });
});
