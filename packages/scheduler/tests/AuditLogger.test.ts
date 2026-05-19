import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { AuditLogger } from "../src/AuditLogger";

describe("AuditLogger", () => {
  const logPath = path.resolve(__dirname, "./test-audit.json");

  beforeEach(async () => {
    try {
      await fs.unlink(logPath);
    } catch (e) {}
  });

  afterEach(async () => {
    try {
      await fs.unlink(logPath);
    } catch (e) {}
  });

  const mockRecordBase = {
    status: "success" as const,
    durationMs: 1000,
    source: {
      host: "localhost",
      port: 27017,
      dbName: "test",
      collectionsTargeted: "all" as const,
      viewsIncluded: false,
    },
    destination: {
      provider: "local",
      pathOrUri: "/backups",
      encrypted: false,
    },
  };

  it("should create a new log file if it doesn't exist", async () => {
    const logger = new AuditLogger(logPath, 10);
    const history = await logger.getHistory();
    expect(history).toEqual([]);

    await logger.appendRecord(mockRecordBase);

    const newHistory = await logger.getHistory();
    expect(newHistory.length).toBe(1);
    expect(newHistory[0].status).toBe("success");
    expect(newHistory[0].id).toBeDefined();
    expect(newHistory[0].timestamp).toBeDefined();
  });

  it("should enforce maxHistory limits and truncate oldest records", async () => {
    const logger = new AuditLogger(logPath, 3); // Max 3 records
    
    await logger.appendRecord({ ...mockRecordBase, durationMs: 1 });
    await logger.appendRecord({ ...mockRecordBase, durationMs: 2 });
    await logger.appendRecord({ ...mockRecordBase, durationMs: 3 });
    await logger.appendRecord({ ...mockRecordBase, durationMs: 4 }); // Should push out duration 1

    const history = await logger.getHistory();
    expect(history.length).toBe(3);
    expect(history[0].durationMs).toBe(2);
    expect(history[1].durationMs).toBe(3);
    expect(history[2].durationMs).toBe(4);
  });
});
