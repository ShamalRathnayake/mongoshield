/**
 * Resuming a checkpointed backup: finding the checkpoint, checking that it may be
 * continued with the current options, and saving progress while a resumable run
 * goes on. The checkpoint format itself lives in backup-checkpoint.ts.
 *
 * A checkpoint is only continued when:
 * - the options fingerprint matches (same patterns, query, compression, encryption,
 *   retention): otherwise the parts would not belong to one backup;
 * - the source is the same deployment (`clusterId`), if both runs know it;
 * - for `resume: "auto"`, the labels are the same too: two scheduled jobs with the
 *   same selection (say plans "hourly" and "nightly") must never continue each
 *   other's checkpoint, or one plan's backup would be committed with the other's
 *   labels and pruned by the wrong retention scope;
 * - no manifest exists yet for it (a backup cannot be committed twice);
 * - every file it claims is finished still exists with its recorded size.
 */

import { identityToRecipient } from "../crypto/index.ts";
import { isMongoShieldError, MongoShieldError } from "../errors.ts";
import { manifestKey } from "../format/layout.ts";
import type { Logger } from "../logger.ts";
import type { DeploymentInfo } from "../mongo/index.ts";
import type { StorageAdapter } from "../storage/types.ts";
import { version } from "../version.ts";
import {
  type BackupFingerprint,
  CHECKPOINT_FORMAT_VERSION,
  type Checkpoint,
  checkCheckpointFiles,
  checkpointKey,
  fingerprintDifferences,
  listCheckpointIds,
  readCheckpoint,
  writeCheckpoint,
} from "./backup-checkpoint.ts";
import { type NamespacePlan, planToCheckpoint } from "./backup-dump.ts";
import type { FileEncryption } from "./backup-key.ts";
import type { EncryptionPlan } from "./backup-options.ts";
import { unlockBackupKey } from "./read-pipeline.ts";

/** How long a checkpoint write may take once the run itself was aborted. */
const CHECKPOINT_WRITE_TIMEOUT_MS = 60_000;

/** What `findCheckpointToResume` needs. */
export interface ResumeRequest {
  readonly storage: StorageAdapter;
  readonly logger: Logger;
  /** `BackupOptions.resume`: a backup id, `"latest"` or `"auto"`. */
  readonly resume: string;
  readonly fingerprint: BackupFingerprint;
  /**
   * The labels of this run. `"auto"` only continues a checkpoint with exactly these
   * labels; a named or the latest checkpoint keeps its own (it is that backup).
   */
  readonly labels: Readonly<Record<string, string>>;
  readonly deployment: DeploymentInfo;
  readonly signal: AbortSignal | undefined;
}

/**
 * The checkpoint to continue, validated (see the file header), or `undefined` for
 * `resume: "auto"` when there is nothing to continue (a new backup starts).
 *
 * @throws MS_BACKUP_NOT_FOUND when the named (or any, for `"latest"`) checkpoint is
 *   missing; MS_CONFIG_INVALID for different options, another deployment or an
 *   already committed backup; MS_INTEGRITY_FAILED when finished files are missing
 *   or changed; MS_MANIFEST_INVALID for an unreadable checkpoint.
 */
export async function findCheckpointToResume(
  request: ResumeRequest,
): Promise<Checkpoint | undefined> {
  const { storage, resume, signal } = request;
  if (resume === "auto") return findMatchingCheckpoint(request);

  let id = resume;
  if (resume === "latest") {
    const [newest] = await listCheckpointIds(storage, signal);
    if (newest === undefined) {
      throw new MongoShieldError(
        "MS_BACKUP_NOT_FOUND",
        "There is no checkpointed backup to resume.",
        {
          hint: 'Start a backup with maxDurationMs (CLI: --max-duration), or use resume "auto" to start one when there is nothing to resume.',
        },
      );
    }
    id = newest;
  }

  const checkpoint = await readCheckpoint(storage, id, signal);
  if (checkpoint === undefined) {
    throw new MongoShieldError("MS_BACKUP_NOT_FOUND", `Backup ${id} has no checkpoint to resume.`, {
      hint: "It may have completed, or been pruned. Run `mongoshield list` to see the backups.",
    });
  }
  await assertResumable(checkpoint, request);
  return checkpoint;
}

/**
 * `resume: "auto"`: the newest checkpoint made with the same options and labels for
 * the same deployment and not yet committed, or `undefined`. Damaged candidates still fail
 * loudly: silently starting over would hide the damage.
 */
async function findMatchingCheckpoint(request: ResumeRequest): Promise<Checkpoint | undefined> {
  for (const id of await listCheckpointIds(request.storage, request.signal)) {
    const checkpoint = await readCheckpoint(request.storage, id, request.signal).catch(
      (error: unknown) => {
        request.logger.warn("Ignoring an unreadable checkpoint", {
          id,
          error: error instanceof Error ? error.message : String(error),
        });
        return undefined;
      },
    );
    if (checkpoint === undefined) continue;
    const sameOptions =
      fingerprintDifferences(checkpoint.fingerprint, request.fingerprint).length === 0;
    if (!sameOptions || !sameDeployment(checkpoint, request.deployment)) continue;
    if (!sameLabels(checkpoint.labels, request.labels)) continue;
    if (await hasManifest(request.storage, id, request.signal)) continue;
    await assertFilesIntact(checkpoint, request);
    return checkpoint;
  }
  return undefined;
}

/** The checks of the file header, for an explicitly chosen checkpoint. */
async function assertResumable(checkpoint: Checkpoint, request: ResumeRequest): Promise<void> {
  const { id } = checkpoint;
  if (await hasManifest(request.storage, id, request.signal)) {
    throw new MongoShieldError("MS_CONFIG_INVALID", `Backup ${id} is already complete.`, {
      hint: `Its checkpoint ${checkpointKey(id)} is left over; it can be deleted.`,
    });
  }

  const differences = fingerprintDifferences(checkpoint.fingerprint, request.fingerprint);
  if (differences.length > 0) {
    throw new MongoShieldError(
      "MS_CONFIG_INVALID",
      `Backup ${id} was started with different options (${differences.join(", ")}), so it cannot be resumed with these.`,
      {
        hint: "Resume with the options the backup was started with, or start a new backup.",
        details: { differences },
      },
    );
  }

  if (!sameDeployment(checkpoint, request.deployment)) {
    throw new MongoShieldError(
      "MS_CONFIG_INVALID",
      `Backup ${id} was started on a different MongoDB deployment.`,
      { hint: "Resume it against the deployment it was started on, or start a new backup." },
    );
  }
  await assertFilesIntact(checkpoint, request);
}

async function assertFilesIntact(checkpoint: Checkpoint, request: ResumeRequest): Promise<void> {
  const problems = await checkCheckpointFiles(request.storage, checkpoint, request.signal);
  if (problems.length === 0) return;
  const listed = problems
    .slice(0, 5)
    .map((item) => `${item.key}: ${item.problem}`)
    .join("; ");
  throw new MongoShieldError(
    "MS_INTEGRITY_FAILED",
    `Backup ${checkpoint.id} cannot be resumed: ${problems.length} finished file(s) changed (${listed}).`,
    {
      hint: "Something modified the backup's files since the last invocation. Start a new backup.",
      details: { problems },
    },
  );
}

/** Exactly the same label keys and values; key order does not matter. */
function sameLabels(
  stored: Readonly<Record<string, string>>,
  wanted: Readonly<Record<string, string>>,
): boolean {
  const storedKeys = Object.keys(stored);
  if (storedKeys.length !== Object.keys(wanted).length) return false;
  return storedKeys.every((key) => Object.hasOwn(wanted, key) && wanted[key] === stored[key]);
}

/** Same `clusterId` (checkpoints of old writers may not record one). */
function sameDeployment(checkpoint: Checkpoint, deployment: DeploymentInfo): boolean {
  const before = checkpoint.source.clusterId;
  return before === undefined || before === deployment.clusterId;
}

async function hasManifest(
  storage: StorageAdapter,
  id: string,
  signal: AbortSignal | undefined,
): Promise<boolean> {
  const info = await storage.head(manifestKey(id), signal === undefined ? {} : { signal });
  return info !== undefined;
}

// ---------------------------------------------------------------------------
// Encryption of a resumed backup
// ---------------------------------------------------------------------------

/**
 * How the remaining files of a resumed backup are encrypted: to exactly the
 * recipients of its first invocation.
 *
 * - recipients: the current ones (the fingerprint guarantees they are the same);
 * - passphrase: the key envelope is unlocked with the given passphrase (one
 *   scrypt) and its identity's recipient is used, which also proves the passphrase
 *   is the one the backup started with;
 * - KMS: the envelope's public recipient recorded in the checkpoint (unlocking it
 *   would need KMS decrypt permission, which a backup role should not have).
 *
 * @throws MS_DECRYPTION_FAILED for a passphrase that does not open the envelope.
 */
export async function resumeFileEncryption(
  checkpoint: Checkpoint,
  plan: EncryptionPlan | undefined,
  storage: StorageAdapter,
  signal: AbortSignal | undefined,
): Promise<FileEncryption | undefined> {
  const stored = checkpoint.encryption;
  if (plan === undefined || stored === null) return undefined;
  if (plan.kind === "recipients") {
    return { recipients: plan.recipients, manifestRecipients: plan.recipients, keyFile: undefined };
  }
  const keyFile = stored.keyFile;
  if (keyFile === undefined) {
    throw new MongoShieldError(
      "MS_MANIFEST_INVALID",
      `The checkpoint of backup ${checkpoint.id} has no key envelope.`,
    );
  }
  if (plan.kind === "passphrase") {
    const identity = await unlockBackupKey(
      storage,
      checkpoint.id,
      keyFile,
      { decryption: { passphrase: plan.passphrase } },
      signal === undefined ? {} : { signal },
    );
    return {
      recipients: [identityToRecipient(identity)],
      manifestRecipients: stored.manifestRecipients,
      keyFile,
    };
  }
  return { recipients: stored.recipients, manifestRecipients: stored.manifestRecipients, keyFile };
}

// ---------------------------------------------------------------------------
// Saving progress
// ---------------------------------------------------------------------------

/** The parts of a run a checkpoint is made from. */
export interface CheckpointState {
  readonly id: string;
  readonly startedAt: Date;
  readonly invocations: number;
  readonly fingerprint: BackupFingerprint;
  readonly labels: Readonly<Record<string, string>>;
  readonly deployment: DeploymentInfo;
  readonly encryption: FileEncryption | undefined;
  readonly plans: readonly NamespacePlan[];
}

/** Builds the checkpoint document for the current state of a run. */
export function buildCheckpoint(state: CheckpointState): Checkpoint {
  const { deployment, encryption } = state;
  return {
    formatVersion: CHECKPOINT_FORMAT_VERSION,
    id: state.id,
    tool: `mongoshield@${version}`,
    startedAt: state.startedAt.toISOString(),
    updatedAt: new Date().toISOString(),
    invocations: state.invocations,
    fingerprint: state.fingerprint,
    labels: { ...state.labels },
    source: {
      topology: deployment.topology,
      serverVersion: deployment.serverVersion,
      clusterId: deployment.clusterId,
    },
    encryption:
      encryption === undefined
        ? null
        : {
            manifestRecipients: [...encryption.manifestRecipients],
            recipients: [...encryption.recipients],
            ...(encryption.keyFile === undefined ? {} : { keyFile: encryption.keyFile }),
          },
    namespaces: state.plans.map((plan) => planToCheckpoint(plan)),
  };
}

/**
 * Writes checkpoints one at a time, always with the latest state. Writes run on
 * their own timeout, not the run's signal: progress must still be saved when the
 * run is being aborted.
 */
export class CheckpointSaver {
  readonly #storage: StorageAdapter;
  readonly #logger: Logger;
  readonly #state: () => CheckpointState;
  #chain: Promise<void> = Promise.resolve();
  #saved = false;

  constructor(storage: StorageAdapter, logger: Logger, state: () => CheckpointState) {
    this.#storage = storage;
    this.#logger = logger;
    this.#state = state;
  }

  /** True once a checkpoint was written by this run (or the run resumed one). */
  get saved(): boolean {
    return this.#saved;
  }

  /** Marks that a checkpoint already exists (a resumed run). */
  markExisting(): void {
    this.#saved = true;
  }

  /**
   * Saves the current state after the writes already queued.
   *
   * @throws the storage error when the write fails.
   */
  save(): Promise<void> {
    const next = this.#chain.then(async () => {
      await writeCheckpoint(
        this.#storage,
        buildCheckpoint(this.#state()),
        AbortSignal.timeout(CHECKPOINT_WRITE_TIMEOUT_MS),
      );
      this.#saved = true;
    });
    // Later saves wait for this one, but must not inherit its failure.
    this.#chain = next.catch(() => undefined);
    return next;
  }

  /** `save`, but a failure is only logged: the next save will try again. */
  async saveQuietly(): Promise<void> {
    try {
      await this.save();
    } catch (error) {
      this.#logger.warn("Could not save the backup checkpoint; continuing", {
        error: error instanceof Error ? error.message : String(error),
        code: isMongoShieldError(error) ? error.code : undefined,
      });
    }
  }
}
