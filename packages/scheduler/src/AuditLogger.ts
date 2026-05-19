import { promises as fs } from "node:fs";
import * as path from "node:path";
import { v4 as uuidv4 } from "uuid";

export interface AuditRecord {
  id: string; // UUID
  timestamp: string; // ISO date
  status: "success" | "failed" | "aborted";
  durationMs: number;

  // What was backed up?
  source: {
    host: string;
    port: number;
    dbName: string;
    collectionsTargeted: string[] | "all";
    viewsIncluded: boolean;
  };

  // Where did it go?
  destination: {
    provider: string;
    pathOrUri: string;
    encrypted: boolean;
  };

  // Error details if applicable
  error?: {
    message: string;
    code?: string;
  };
}

export class AuditLogger {
  private logPath: string;
  private maxHistory: number;

  constructor(logPath: string, maxHistory: number = 100) {
    this.logPath = path.resolve(logPath);
    this.maxHistory = maxHistory;
  }

  public async getHistory(): Promise<AuditRecord[]> {
    try {
      const data = await fs.readFile(this.logPath, "utf-8");
      return JSON.parse(data) as AuditRecord[];
    } catch (err: any) {
      if (err.code === "ENOENT") {
        return [];
      }
      throw err;
    }
  }

  public async appendRecord(record: Omit<AuditRecord, "id" | "timestamp">): Promise<AuditRecord> {
    const history = await this.getHistory();

    const newRecord: AuditRecord = {
      ...record,
      id: uuidv4(),
      timestamp: new Date().toISOString(),
    };

    history.push(newRecord);

    // Truncate to maxHistory
    if (history.length > this.maxHistory) {
      history.splice(0, history.length - this.maxHistory);
    }

    // Atomic write by writing to a temp file first, then renaming
    const tempPath = `${this.logPath}.tmp.${uuidv4()}`;
    await fs.writeFile(tempPath, JSON.stringify(history, null, 2), "utf-8");
    await fs.rename(tempPath, this.logPath);

    return newRecord;
  }
}
