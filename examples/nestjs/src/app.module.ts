/**
 * Wiring: configuration, the scheduler, MongoShield and the backup feature.
 * Secrets come from the environment (MONGODB_URI, AWS credentials), never from code.
 */

import { Module } from "@nestjs/common";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { ScheduleModule } from "@nestjs/schedule";
import { s3Storage } from "mongoshield/storage/s3";
import { BackupModule } from "./backup/backup.module.js";
import { MongoShieldModule } from "./backup/mongoshield.module.js";

@Module({
  imports: [
    ConfigModule.forRoot(),
    ScheduleModule.forRoot(),
    MongoShieldModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        // Already using Mongoose or a MongoClient? Pass it instead of a URI:
        //   source: { client: connection.getClient() }  (MongoShield won't close it)
        source: { uri: config.getOrThrow<string>("MONGODB_URI") },
        storage: s3Storage({
          bucket: config.getOrThrow<string>("BACKUP_BUCKET"),
          prefix: "mongodb/",
        }),
        // Public key only: the app can write backups but not read them.
        encryption: { recipients: [config.getOrThrow<string>("BACKUP_PUBLIC_KEY")] },
      }),
    }),
    BackupModule,
  ],
})
export class AppModule {}
