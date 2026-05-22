# @mongoshield/scheduler

> Production-grade autonomous backup scheduler for [MongoShield](https://www.npmjs.com/package/mongoshield).

A secure, highly resilient, and zero-dependency cron orchestrator tailored to manage the lifecycle of MongoShield backup jobs with concurrency locks, exponential backoff retries, process timeouts, and atomic audit logging.

## Features

- **Overlap Prevention (Concurrency Lock):** Prevents new backups from starting if a previous scheduled run is still active.
- **Fail-Safe Resilience:** Automatically retries failed runs with configurable exponential backoff delays.
- **Hard Process Timeouts:** Aborts long-running or hung streams using native `AbortController` pipelines.
- **Graceful Shutdown (SIGTERM/SIGINT):** Allows active backup streams up to 30 seconds (configurable) to complete their current data chunk before cleanly closing to avoid database corruption or zombie processes.
- **Atomic Rolling Audit Logging:** Persists a secure, rollable 100-record historical execution JSON log on disk using write-and-rename tactics to prevent data corruption.
- **Rich Observability Event Hooks:** Standard Node.js `EventEmitter` to hook into scheduler lifecycle events for Slack/Discord webhooks, metrics tracking, or alerting.

## Installation

```bash
npm install @mongoshield/scheduler
```

## Usage

```typescript
import { FileSystemProvider } from '@mongoshield/provider-local';
import { BackupScheduler } from '@mongoshield/scheduler';
import type { BackupConfig } from '@mongoshield/core';

// 1. Configure the core engine settings
const config: BackupConfig = {
  connection: { host: '127.0.0.1', port: 27017 },
  target: { dbName: 'production_db' },
  output: { outPath: './backups', gzip: true },
};

const storage = new FileSystemProvider({ outPath: './backups', compress: true });

// 2. Define autonomous scheduler rules
const scheduler = new BackupScheduler(
  config,
  {
    cron: '0 0 * * *', // Run every day at midnight
    preventOverlap: true,
    timeoutMs: 600000, // 10 minutes timeout limit
    retries: 3,
    retryDelayMs: 5000,
    backoffFactor: 2,
    auditLogPath: './mongoshield-audit.json',
  },
  storage
);

// 3. Setup event listeners for Slack alerts
scheduler.on('backup:started', ({ attempt }) => {
  console.log(`Backup started (attempt ${attempt})`);
});

scheduler.on('backup:completed', ({ record }) => {
  console.log(`Backup completed successfully in ${record.durationMs}ms`);
});

scheduler.on('backup:failed', ({ error, record }) => {
  console.error(`Backup failed permanently after retries:`, error);
});

// 4. Start the scheduler daemon!
scheduler.start();
```

## Configuration API

| Option | Type | Default | Description |
|---|---|---|---|
| `cron` | `string` | **Required** | Standard 5-field or 6-field cron expression for schedule interval. |
| `timezone` | `string` | `"UTC"` | Timezone for cron triggers. |
| `preventOverlap` | `boolean` | `true` | Prevents starting a backup if the previous one is still executing. |
| `timeoutMs` | `number` | `undefined` | Hard limit on backup duration before aborting the job. |
| `gracePeriodMs` | `number` | `30000` | Process signal (`SIGTERM`/`SIGINT`) grace period (ms) for streams to flush cleanly. |
| `retries` | `number` | `3` | Maximum retry attempts for a failed backup job. |
| `retryDelayMs` | `number` | `5000` | Initial base delay (ms) for retries. |
| `backoffFactor` | `number` | `2` | Multiplier applied to retry delays exponentially. |
| `auditLogPath` | `string` | `"./mongoshield-audit.json"` | Path on disk to save the audit log file. |
| `maxAuditHistory` | `number` | `100` | Max rolling history of backup runs to keep in the audit file. |

## Observability Events

The `BackupScheduler` extends the standard Node `EventEmitter` and emits the following:

- `scheduler:started` - Emitted when the cron job is successfully active.
- `scheduler:overlapPrevented` - Emitted when a run was skipped because a previous job is still running.
- `backup:started` - Emitted on every attempt run (arguments: `{ attempt }`).
- `backup:completed` - Emitted on a successful run (arguments: `{ record: AuditRecord }`).
- `backup:failed` - Emitted when a run fails after all retry attempts (arguments: `{ error, record: AuditRecord }`).

## License

MIT
