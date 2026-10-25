/**
 * Point-in-time recovery: the change journal (docs/specs/JOURNAL.md).
 *
 *   startJournal            the writer: records every change into chained segments
 *   journalStatus           recovery point, RPO, covered ranges and gaps
 *   readJournalSegments     the events of a time range, chain-verified
 *   planPointInTimeRestore  which base backup and which segments reach a given time
 *   replayJournal           replays (base time, at] onto a restored base backup
 *   pruneJournal            deletes segments older than the oldest kept base backup
 */

export {
  type CoveredRange,
  type JournalCoverage,
  type JournalSegment,
  loadJournalCoverage,
} from "./coverage.ts";
export { JOURNAL_PREFIX } from "./layout.ts";
export {
  type BaseBackup,
  baseTimeOf,
  listBaseBackups,
  type PointInTimePlan,
  planPointInTimeRestore,
  type RecoverableRange,
} from "./plan.ts";
export { type PruneJournalOptions, type PruneJournalResult, pruneJournal } from "./prune.ts";
export { type ReadJournalOptions, readJournalSegments, verifyJournal } from "./reader.ts";
export type { CommittedSegment, GapRecord, JournalState } from "./records.ts";
export {
  JOURNAL_PROGRESS_LABEL,
  type ReplayJournalOptions,
  type ReplayJournalResult,
  replayJournal,
} from "./replay.ts";
export { type JournalStatus, journalStatus } from "./status.ts";
export { clusterTimeOfDate, predecessor, toJournalTime } from "./time.ts";
export {
  DEFAULT_JOURNAL_LEASE_MS,
  DEFAULT_SEGMENT_BYTES,
  DEFAULT_SEGMENT_SECONDS,
  type JournalHandle,
  type JournalOptions,
  type JournalWriterStatus,
  startJournal,
} from "./writer.ts";
