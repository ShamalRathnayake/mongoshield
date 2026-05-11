import { EventEmitter } from "node:events";
import {
  BackupEngine,
  type BackupConfigInput,
  type BackupConfig,
  BackupConfigSchema,
  type StorageProvider,
} from "@mongoshield/core";
import { logger } from "./logger";

export interface MongoShieldOptions {
  config: BackupConfigInput;
  storage: StorageProvider;
}

export class MongoShield extends EventEmitter {
  private engine: BackupEngine;

  constructor(private options: MongoShieldOptions) {
    super();

    // Validate the core configuration
    let parsedConfig: BackupConfig;
    try {
      parsedConfig = BackupConfigSchema.parse(options.config);
    } catch (err: any) {
      logger.error({ err }, "Invalid MongoShield configuration");
      throw new Error(`MongoShield Configuration Error: ${err.message}`);
    }

    this.engine = new BackupEngine(parsedConfig, options.storage);

    // Wire up telemetry events from the storage provider
    options.storage.on("progress", (bytesWritten: number) => {
      this.emit("progress", bytesWritten);
    });

    options.storage.on("error", (err: Error) => {
      this.emit("error", err);
    });

    logger.info("MongoShield instance initialized");
  }

  /**
   * Executes the backup pipeline.
   * Emits `backup:started`, `backup:completed`, and `backup:failed` lifecycle events.
   */
  public async backup(): Promise<void> {
    logger.info("Starting MongoShield backup process...");
    this.emit("backup:started");

    try {
      await this.engine.run();
      
      logger.info("Backup process completed successfully.");
      this.emit("backup:completed");
    } catch (err: any) {
      logger.error({ err }, "Backup process failed");
      this.emit("backup:failed", err);
      throw err;
    }
  }
}
