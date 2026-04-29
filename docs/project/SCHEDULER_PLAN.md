# Production-Grade Scheduler Implementation Plan

This document outlines a robust, enterprise-grade scheduling system for MongoShield. Moving beyond a simple cron trigger, this architecture ensures reliability, observability, and safety for production database environments.

## 1. Core Requirements & Modern Features
To qualify as "production-level", the scheduler must implement the following safeguards and features:
- **Overlap Prevention (Concurrency Lock):** Prevents a new backup from starting if the previous scheduled backup is still running.
- **Resilience (Retries with Backoff):** Automatically retries failed backup attempts with configurable exponential backoff.
- **Timeouts:** Ensures a hung stream or lost connection doesn't permanently lock the scheduler.
- **Graceful Shutdown (Grace Period Strategy):** Intercepts `SIGINT`/`SIGTERM`, grants the active backup a strict 30-second grace period to cleanly finish processing its current chunk, and then aggressively aborts the stream to prevent zombie processes while maintaining data integrity.
- **Rich Observability:** Emits standard events for monitoring tools.
- **Audit Logging:** Persists a detailed, rolling history of the last 100 backup operations to disk for compliance and debugging.

## 2. Configuration Schema Enhancements
We will expand `MongoShieldConfigSchema` to include a robust `SchedulerOptions` object.

```typescript
export const SchedulerOptionsSchema = z.object({
  enabled: z.boolean().default(false),
  cron: z.string(), // Standard cron expression
  timezone: z.string().default("UTC"),
  
  // Advanced Safeguards
  preventOverlap: z.boolean().default(true),
  timeoutMs: z.number().positive().optional(), // Max duration for a backup run
  gracePeriodMs: z.number().positive().default(30000), // Time allowed to finish on SIGTERM
  
  // Retry Logic
  retries: z.number().int().min(0).default(3),
  retryDelayMs: z.number().min(1000).default(5000), // Base delay
  backoffFactor: z.number().min(1).default(2), // Multiplier for exponential backoff

  // Audit Logging
  auditLogPath: z.string().default('./mongoshield-audit.json'),
  maxAuditHistory: z.number().int().positive().default(100),
});
```

## 3. Architecture & State Management

### Detailed Audit History
Instead of just keeping the latest state in memory, we will manage a JSON-based rolling log file that stores the last 100 detailed records. This allows administrators to audit exactly what happened over the weekend.

```typescript
interface AuditRecord {
  id: string; // UUID
  timestamp: string; // ISO date
  status: 'success' | 'failed' | 'aborted';
  durationMs: number;
  
  // What was backed up?
  source: {
    host: string;
    port: number;
    dbName: string;
    collectionsTargeted: string[] | 'all';
    viewsIncluded: boolean;
  };
  
  // Where did it go?
  destination: {
    provider: 'local' | 's3' | 'gdrive';
    pathOrUri: string;
    encrypted: boolean;
  };
  
  // Error details if applicable
  error?: {
    message: string;
    code?: string;
  };
}
```

### The `BackupScheduler` Class
This class will wrap the `croner` library and the `BackupEngine`.

**Key Methods:**
- `start()`: Initializes the cron job and attaches termination signal listeners.
- `stop(force?: boolean)`: Implements the Graceful Shutdown strategy. Initiates a 30s timer; if the engine is still running after the timer, an `AbortController` triggers stream destruction.
- `getHistory(): AuditRecord[]`: Reads the persistent audit log file.
- `private async executeJob()`: The core wrapper.

## 4. Execution Flow (The `executeJob` Method)

When the cron triggers, the following lifecycle occurs:
1. **Concurrency Check:** If `state === 'running'` and `preventOverlap` is true, log a warning and exit early.
2. **Locking:** Set `state = 'running'`.
3. **Execution Loop:**
   - Emit `backup:started`.
   - Wrap `engine.run()` with the `AbortController` (for graceful shutdown) and a Timeout rejection.
   - If successful: 
     - Emit `backup:completed`.
     - **Automated Pruning:** Trigger `provider.prune()` based on the configured retention policy.
   - If failed: 
     - Check retry count. If retries remain, wait `retryDelayMs * (backoffFactor ^ attempt)` and loop.
     - If all retries exhausted, emit `backup:failed`.
4. **Audit Flush:** Gather the `AuditRecord` metrics (duration, targets, destination, final status) and append them to the rolling `mongoshield-audit.json` file. If the file exceeds 100 records, shift the oldest record out.
5. **Unlocking:** Set `state = 'idle'`.

## 5. Observability & Event Hooks
MongoShield will expose an `EventEmitter` interface so users can hook into the lifecycle for custom alerting.

```typescript
// Example user integration
mongoshield.on('scheduler:jobFailed', (err, auditRecord) => {
  slack.sendMessage(`🚨 Backup of ${auditRecord.source.dbName} failed after retries: ${err.message}`);
});
```

## 6. Dependencies
- **`croner`**: Modern, fast, zero-dependency cron parser.
- **`pino`**: Structured logging.
- **`uuid`**: Already in the monorepo, used for generating unique Audit Record IDs.

## 7. Implementation Milestones
1. **Phase 1: Config & Boilerplate** - Expand Zod schemas, install `croner`.
2. **Phase 2: Audit Logger** - Build the file-system rolling JSON persister (`AuditLogger.ts`) that manages the 100-record limit safely.
3. **Phase 3: Execution Wrapper** - Implement the `executeJob` method with overlap lock, timeout, and retry/backoff logic.
4. **Phase 4: Graceful Shutdown** - Wire up the `AbortController` to the `BackupEngine` streams and attach `process.on('SIGTERM')` listeners with the 30-second grace period.
5. **Phase 5: Testing** - Write tests simulating SIGTERM signals, JSON truncation limits, and cron logic.
