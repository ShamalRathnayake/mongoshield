/**
 * Runs the nightly backup (with @nestjs/schedule) and exposes it for other code,
 * e.g. an admin command or a pre-migration hook.
 *
 * Only one backup runs at a time in this process. With several app replicas, every
 * replica's cron fires: either run the schedule in one replica only (an env flag, as
 * below) or use the CLI scheduler / a Kubernetes CronJob, which lock across machines.
 */

import { Injectable, Logger } from "@nestjs/common";
import { Cron } from "@nestjs/schedule";
import type { BackupResult, MongoShield } from "mongoshield";
import { InjectMongoShield } from "./mongoshield.module.js";

@Injectable()
export class BackupService {
  private readonly logger = new Logger(BackupService.name);
  private running: Promise<BackupResult> | undefined;

  constructor(@InjectMongoShield() private readonly shield: MongoShield) {}

  /** 03:15 UTC daily. Disabled unless BACKUP_SCHEDULE_ENABLED=true (see the class comment). */
  @Cron("15 3 * * *", { timeZone: "UTC", disabled: process.env.BACKUP_SCHEDULE_ENABLED !== "true" })
  async nightly(): Promise<void> {
    try {
      const backup = await this.backupNow("nightly");
      await this.shield.prune({ daily: 7, weekly: 4, monthly: 12 });
      this.logger.log(`Nightly backup ${backup.id} complete`);
    } catch (error) {
      // MongoShield errors never contain the connection string's password.
      this.logger.error("Nightly backup failed", error instanceof Error ? error.stack : error);
    }
  }

  /** Takes a backup and verifies it. A second call while one runs gets the same result. */
  backupNow(trigger: string): Promise<BackupResult> {
    if (!this.running) {
      this.running = this.backupAndVerify(trigger).finally(() => {
        this.running = undefined;
      });
    }
    return this.running;
  }

  private async backupAndVerify(trigger: string): Promise<BackupResult> {
    const backup = await this.shield.backup({
      exclude: ["*.sessions"],
      labels: { trigger },
      // Abort runaway backups instead of letting them overlap with the next day's.
      signal: AbortSignal.timeout(2 * 60 * 60 * 1000),
    });
    const report = await this.shield.verify({ backup: backup.id, mode: "fast" });
    if (!report.ok) throw new Error(`Backup ${backup.id} failed verification`);
    return backup;
  }
}
