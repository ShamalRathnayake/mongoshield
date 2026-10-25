/**
 * Feature module for backups. MongoShieldModule (global) provides the MongoShield
 * instance; this module adds the scheduled job.
 */

import { Module } from "@nestjs/common";
import { BackupService } from "./backup.service.js";

@Module({
  providers: [BackupService],
  exports: [BackupService],
})
export class BackupModule {}
