import { z } from "zod";
import { logger } from "./logger";

export const MongoShieldConfigSchema = z.object({
  uri: z.string().url("Must be a valid MongoDB URI"),
  destination: z.enum(["local", "s3", "gdrive"]).optional().default("local"),
});

export type MongoShieldConfig = z.infer<typeof MongoShieldConfigSchema>;

export class MongoShield {
  private config: MongoShieldConfig;

  constructor(config: MongoShieldConfig) {
    this.config = MongoShieldConfigSchema.parse(config);
    logger.info(
      { destination: this.config.destination },
      "MongoShield (Alpha) initialized",
    );
    logger.warn(
      "This is an alpha release of MongoShield. DO NOT use in production. Native Backup Streamer is under active development.",
    );
  }

  public async backup(): Promise<void> {
    logger.info("Starting backup process...");
    logger.warn(
      "Not implemented yet! This is a placeholder for the Phase 1 BackupStreamer engine.",
    );
    // Simulate some work
    await new Promise((resolve) => setTimeout(resolve, 1000));
    logger.info("Backup process completed (mock).");
  }
}
