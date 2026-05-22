import { z } from "zod";

export const SchedulerOptionsSchema = z.object({
  cron: z.string(), // Standard cron expression
  timezone: z.string().default("UTC"),

  // Advanced Safeguards
  preventOverlap: z.boolean().default(true),
  timeoutMs: z.number().positive().optional(), // Max duration for a backup run
  gracePeriodMs: z.number().positive().default(30000), // Time allowed to finish on SIGTERM

  // Retry Logic
  retries: z.number().int().min(0).default(3),
  retryDelayMs: z.number().min(0).default(5000), // Base delay
  backoffFactor: z.number().min(1).default(2), // Multiplier for exponential backoff

  // Audit Logging
  auditLogPath: z.string().default("./mongoshield-audit.json"),
  maxAuditHistory: z.number().int().positive().default(100),
});

export type SchedulerOptions = z.infer<typeof SchedulerOptionsSchema>;
export type SchedulerOptionsInput = z.input<typeof SchedulerOptionsSchema>;

export function validateSchedulerConfig(config: unknown): SchedulerOptions {
  return SchedulerOptionsSchema.parse(config);
}
