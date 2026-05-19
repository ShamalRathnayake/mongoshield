import { EventEmitter } from "node:events";
import { Cron } from "croner";
import pino from "pino";
import type { BackupConfig, StorageProvider } from "@mongoshield/core";
import { BackupEngine } from "@mongoshield/core";
import { validateSchedulerConfig, type SchedulerOptions, type SchedulerOptionsInput } from "./config";
import { AuditLogger, type AuditRecord } from "./AuditLogger";

export class BackupScheduler extends EventEmitter {
  private config: BackupConfig;
  private schedulerOptions: SchedulerOptions;
  private storage: StorageProvider;
  private logger: pino.Logger;
  private auditLogger: AuditLogger;
  
  private cronJob: Cron | null = null;
  private state: "idle" | "running" = "idle";
  private currentAbortController: AbortController | null = null;

  constructor(
    config: BackupConfig,
    schedulerOptions: SchedulerOptionsInput,
    storage: StorageProvider,
    logger?: pino.Logger
  ) {
    super();
    this.config = config;
    this.schedulerOptions = validateSchedulerConfig(schedulerOptions);
    this.storage = storage;
    this.logger = logger || pino({ level: "info" });
    this.auditLogger = new AuditLogger(
      this.schedulerOptions.auditLogPath,
      this.schedulerOptions.maxAuditHistory
    );
  }

  public start() {
    if (this.cronJob) {
      throw new Error("Scheduler is already running");
    }

    this.logger.info(`Starting BackupScheduler with cron: ${this.schedulerOptions.cron}`);

    this.cronJob = new Cron(this.schedulerOptions.cron, {
      timezone: this.schedulerOptions.timezone
    }, () => {
      this.executeJob().catch(err => {
        this.logger.error({ err }, "Unhandled error in executeJob");
      });
    });

    // Handle graceful shutdown
    process.on("SIGINT", this.handleGracefulShutdown);
    process.on("SIGTERM", this.handleGracefulShutdown);

    this.emit("scheduler:started");
  }

  public async stop(force: boolean = false) {
    if (this.cronJob) {
      this.cronJob.stop();
      this.cronJob = null;
    }

    process.removeListener("SIGINT", this.handleGracefulShutdown);
    process.removeListener("SIGTERM", this.handleGracefulShutdown);

    if (this.state === "running" && this.currentAbortController) {
      if (force) {
        this.logger.warn("Force stopping active backup immediately");
        this.currentAbortController.abort(new Error("Backup aborted forcefully"));
      } else {
        this.logger.info(`Waiting for grace period (${this.schedulerOptions.gracePeriodMs}ms) to finish current backup chunk...`);
        // Wait for grace period
        await new Promise(resolve => setTimeout(resolve, this.schedulerOptions.gracePeriodMs));
        
        // If still running, abort
        if (this.state === "running") {
          this.logger.warn("Grace period expired, aborting active backup");
          this.currentAbortController.abort(new Error("Backup aborted after grace period"));
        }
      }
    }
  }

  public getHistory(): Promise<AuditRecord[]> {
    return this.auditLogger.getHistory();
  }

  private handleGracefulShutdown = () => {
    this.logger.info("Received termination signal, initiating graceful shutdown...");
    this.stop(false).then(() => {
      process.exit(0);
    }).catch(err => {
      this.logger.error({ err }, "Error during graceful shutdown");
      process.exit(1);
    });
  };

  private async executeJob() {
    if (this.state === "running") {
      if (this.schedulerOptions.preventOverlap) {
        this.logger.warn("Backup job overlap prevented. Previous job is still running.");
        this.emit("scheduler:overlapPrevented");
        return;
      }
    }

    this.state = "running";
    this.currentAbortController = new AbortController();
    
    let attempt = 0;
    const maxAttempts = this.schedulerOptions.retries + 1;
    let finalError: Error | undefined;
    const startTime = Date.now();

    while (attempt < maxAttempts) {
      try {
        this.logger.info(`Starting backup attempt ${attempt + 1}/${maxAttempts}`);
        this.emit("backup:started", { attempt: attempt + 1 });

        const engine = new BackupEngine(this.config, this.storage);

        // Handle timeout
        let timeoutId: NodeJS.Timeout | null = null;
        const timeoutPromise = new Promise<void>((_, reject) => {
          if (this.schedulerOptions.timeoutMs) {
            timeoutId = setTimeout(() => {
              const err = new Error(`Backup timed out after ${this.schedulerOptions.timeoutMs}ms`);
              this.currentAbortController?.abort(err);
              reject(err);
            }, this.schedulerOptions.timeoutMs);
          }
        });

        const enginePromise = engine.run(this.currentAbortController.signal);

        // Race between timeout and engine completion
        await Promise.race([enginePromise, timeoutPromise]);

        if (timeoutId) clearTimeout(timeoutId);

        // Success!
        this.logger.info("Backup completed successfully");
        
        // Prune
        try {
          if (typeof (this.storage as any).prune === "function") {
            await (this.storage as any).prune();
          }
        } catch (pruneErr) {
          this.logger.warn({ err: pruneErr }, "Automated pruning failed, but backup was successful");
        }

        const durationMs = Date.now() - startTime;
        
        const record = await this.auditLogger.appendRecord({
          status: "success",
          durationMs,
          source: {
            host: this.config.connection.host || "127.0.0.1",
            port: this.config.connection.port || 27017,
            dbName: this.config.target.dbName || "cluster",
            collectionsTargeted: this.config.target.collections || "all",
            viewsIncluded: this.config.target.viewsAsCollections,
          },
          destination: {
            provider: this.storage.constructor.name,
            pathOrUri: this.config.output.outPath,
            encrypted: !!this.config.output.encryptionKey,
          }
        });

        this.emit("backup:completed", { record });
        this.state = "idle";
        this.currentAbortController = null;
        return; // Exit loop

      } catch (err: any) {
        this.logger.error({ err, attempt: attempt + 1 }, "Backup attempt failed");
        
        if (err.name === "AbortError" || err.message.includes("aborted")) {
          // If it was gracefully aborted or forced, we don't retry
          finalError = err;
          break;
        }

        attempt++;
        if (attempt < maxAttempts) {
          const delay = this.schedulerOptions.retryDelayMs * Math.pow(this.schedulerOptions.backoffFactor, attempt - 1);
          this.logger.info(`Waiting ${delay}ms before next attempt...`);
          await new Promise(resolve => setTimeout(resolve, delay));
        } else {
          finalError = err;
        }
      }
    }

    // If we reach here, all retries failed or it was aborted
    const durationMs = Date.now() - startTime;
    const isAborted = finalError?.message?.includes("aborted");

    const record = await this.auditLogger.appendRecord({
      status: isAborted ? "aborted" : "failed",
      durationMs,
      source: {
        host: this.config.connection.host || "127.0.0.1",
        port: this.config.connection.port || 27017,
        dbName: this.config.target.dbName || "cluster",
        collectionsTargeted: this.config.target.collections || "all",
        viewsIncluded: this.config.target.viewsAsCollections,
      },
      destination: {
        provider: this.storage.constructor.name,
        pathOrUri: this.config.output.outPath,
        encrypted: !!this.config.output.encryptionKey,
      },
      error: {
        message: finalError?.message || "Unknown error",
        code: (finalError as any)?.code
      }
    });

    this.emit("backup:failed", { error: finalError, record });
    this.state = "idle";
    this.currentAbortController = null;
  }
}
