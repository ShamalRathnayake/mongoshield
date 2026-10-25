# NestJS: a MongoShield module

A small, copyable integration:

| File | What it does |
|---|---|
| [`src/backup/mongoshield.module.ts`](./src/backup/mongoshield.module.ts) | `MongoShieldModule.forRoot` / `forRootAsync`: one shared `MongoShield`, closed on shutdown; `@InjectMongoShield()` |
| [`src/backup/backup.service.ts`](./src/backup/backup.service.ts) | nightly backup + verify + prune with `@nestjs/schedule`, and `backupNow()` for other code |
| [`src/app.module.ts`](./src/app.module.ts) | wiring with `ConfigService` |

```bash
npm install
MONGODB_URI=… BACKUP_BUCKET=… BACKUP_PUBLIC_KEY=age1… BACKUP_SCHEDULE_ENABLED=true npm run build && npm start
```

Notes:

- **One scheduler.** Every replica of your app runs the `@Cron`. Enable it on one
  instance only (`BACKUP_SCHEDULE_ENABLED=true`), or schedule backups outside the app with
  the [Docker image](../../docs/guides/docker.md) or a
  [Kubernetes CronJob](../../docs/guides/kubernetes.md), which lock across machines.
- **Reuse your connection.** With Mongoose, pass `source: { client: connection.getClient() }`.
  MongoShield never closes a client it did not create.
- **Load.** A backup reads every collection. Run it off-peak, and consider a
  `readPreference=secondary` connection string so the primary isn't affected.
- Want an HTTP endpoint to trigger backups? See [`../express-admin`](../express-admin/) for
  the security checklist first.
