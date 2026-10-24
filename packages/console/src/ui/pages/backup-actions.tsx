/**
 * The backup actions bar: shown above a connection's live data browser
 * (`#/connections/:id/data`), so the next step after connecting is always in view.
 *
 *   Nothing backed up yet   → "Back up now" (everything except admin/local/config, or
 *                             what "Choose what to back up" picked), one click
 *   A backup is running     → its progress, live (job events over SSE)
 *   The backup succeeded    → when, how much, "encrypted"; then one click each for
 *                             "Check the backup" (deep verify), "Test a restore" (drill),
 *                             "Back up every night" (schedule + retention) and
 *                             "Restore a backup" (straight into the restore wizard)
 *   The key was not saved   → the "Save your recovery key" dialog, once, and a reminder
 *
 * "Back up now" uses the connection's quick plan (`POST /api/quick-backup`, admin), a
 * normal plan the server creates with every choice made: the "Local backups" location,
 * zstd, encryption with a key the console keeps, automatic consistency, a fast verify.
 * Operators can run an existing quick plan; viewers do not see the bar.
 */

import { useEffect, useRef, useState } from "react";
import type {
  ConnectionView,
  DatabaseNode,
  JobSummary,
  PlanView,
  RecoveryKeyView,
} from "../../shared/api.ts";
import { describeError, isJobFinished } from "../api.ts";
import { Button, LinkButton } from "../components/button.tsx";
import { Dialog } from "../components/dialog.tsx";
import { CheckboxField } from "../components/field.tsx";
import { ErrorNotice, Notice, Panel, Time } from "../components/layout.tsx";
import { ProgressBar } from "../components/progress-bar.tsx";
import { StatusBadge } from "../components/status-badge.tsx";
import { useToast } from "../components/toast.tsx";
import { useApi, useLoad, useSession } from "../context.tsx";
import { formatDuration, formatNumber, plural } from "../format.ts";
import {
  atlasTierLabel,
  browserTimeZone,
  downloadTextFile,
  NIGHTLY_RETENTION,
  nightlyPlanInput,
} from "../onboarding.ts";
import { buildHref, segment } from "../router.ts";
import { useJobEvents } from "./job-detail.tsx";
import "./onboarding.css";

/** What the bar needs: the connection and its quick plan (if any). */
interface BarData {
  readonly connection: ConnectionView;
  readonly plan: PlanView | undefined;
}

/** Props for `BackupActions`. */
export interface BackupActionsProps {
  readonly connectionId: string;
}

/**
 * The selection of "Back up now" as include patterns: `[]` (everything) when every
 * database is fully chosen, else `db.*` per fully chosen database and `db.collection`
 * for the rest. Exported for tests.
 */
export function includeFor(tree: readonly DatabaseNode[], chosen: ReadonlySet<string>): string[] {
  const include: string[] = [];
  let everything = true;
  for (const database of tree) {
    const names = database.collections.map((collection) => `${database.name}.${collection.name}`);
    const picked = names.filter((ns) => chosen.has(ns));
    if (picked.length === names.length && names.length > 0) {
      include.push(`${database.name}.*`);
    } else {
      everything = false;
      include.push(...picked);
    }
  }
  return everything ? [] : include;
}

/** The namespaces an include list selects in a tree (the picker's starting point). */
export function chosenFrom(tree: readonly DatabaseNode[], include: readonly string[]): Set<string> {
  const chosen = new Set<string>();
  for (const database of tree) {
    for (const collection of database.collections) {
      const ns = `${database.name}.${collection.name}`;
      if (include.length === 0 || include.includes(ns) || include.includes(`${database.name}.*`)) {
        chosen.add(ns);
      }
    }
  }
  return chosen;
}

/** The bar. Renders nothing for viewers, and nothing until its data has loaded. */
export function BackupActions(props: BackupActionsProps) {
  const client = useApi();
  const { hasRole } = useSession();
  const isAdmin = hasRole("admin");
  const loaded = useLoad<BarData>(`backup-actions:${props.connectionId}`, async (signal) => {
    const [connections, plans] = await Promise.all([
      client.call("GET /api/connections", undefined, { signal }),
      client.call("GET /api/plans", undefined, { signal }),
    ]);
    const connection = connections.find((candidate) => candidate.id === props.connectionId);
    if (connection === undefined) throw new Error("This connection does not exist any more.");
    const plan = plans.find(
      (candidate) => candidate.origin === "quick" && candidate.connectionId === connection.id,
    );
    return { connection, plan };
  });

  if (!hasRole("operator")) return null;
  // Until it has loaded, and when loading fails, the bar stays out of the way: the data
  // browser below explains a missing connection or an unreachable server itself.
  if (loaded.data === undefined) return null;
  const data = loaded.data;
  return (
    <BackupActionsBar
      connection={data.connection}
      plan={data.plan}
      isAdmin={isAdmin}
      onPlanChanged={(plan) => loaded.setData({ connection: data.connection, plan })}
      reload={loaded.reload}
    />
  );
}

/** The bar itself, once its data is there. */
function BackupActionsBar(props: {
  connection: ConnectionView;
  plan: PlanView | undefined;
  isAdmin: boolean;
  onPlanChanged: (plan: PlanView) => void;
  reload: () => void;
}) {
  const { connection, plan, isAdmin } = props;
  const client = useApi();
  const toast = useToast();
  const [job, setJob] = useState<JobSummary | undefined>(plan?.lastRun);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<unknown>(undefined);
  const [picking, setPicking] = useState(false);
  const [chosenInclude, setChosenInclude] = useState<readonly string[]>(plan?.include ?? []);
  const [keyDialog, setKeyDialog] = useState(false);
  const keyOffered = useRef(false);

  // The latest run of the plan, kept in step when the plan reloads.
  useEffect(() => setJob(plan?.lastRun), [plan?.lastRun]);

  const backUpNow = async () => {
    setStarting(true);
    setError(undefined);
    try {
      if (isAdmin) {
        const result = await client.call("POST /api/quick-backup", {
          connectionId: connection.id,
          include: chosenInclude,
        });
        props.onPlanChanged(result.plan);
        setJob(result.job);
      } else if (plan !== undefined) {
        setJob(
          await client.call("POST /api/plans/:id/run", undefined, { params: { id: plan.id } }),
        );
      }
      setPicking(false);
    } catch (failure) {
      setError(failure);
    } finally {
      setStarting(false);
    }
  };

  // After the first successful backup with a key nobody has saved yet: offer it, once.
  const onFinished = (finished: JobSummary) => {
    setJob(finished);
    props.reload();
    if (finished.status === "succeeded") {
      toast.show("success", "Backup complete.");
      if (
        isAdmin &&
        plan?.encryption.kind === "managed" &&
        !plan.encryption.recoveryKeySaved &&
        !keyOffered.current
      ) {
        keyOffered.current = true;
        setKeyDialog(true);
      }
    }
  };

  const running = job !== undefined && !isJobFinished(job);
  const lastSucceeded = job?.status === "succeeded" ? job : undefined;
  const keyUnsaved =
    plan?.encryption.kind === "managed" && !plan.encryption.recoveryKeySaved && isAdmin;
  const canStart = isAdmin || plan !== undefined;

  return (
    <Panel
      className="backup-actions"
      title={`Backups of ${connection.name}`}
      actions={<ConnectionBadges connection={connection} />}
    >
      {plan === undefined && !isAdmin ? (
        <p className="muted">
          No backups are set up for this database yet. Ask an admin to click "Back up now" here.
        </p>
      ) : null}

      {plan === undefined && isAdmin && job === undefined ? (
        <p>
          Nothing is backed up yet. <strong>Back up now</strong> saves{" "}
          {chosenInclude.length === 0
            ? "every database (except MongoDB's own admin, local and config)"
            : plural(chosenInclude.length, "selection")}{" "}
          to Local backups, encrypted, and checks it afterwards.
        </p>
      ) : null}

      {running && job !== undefined ? <RunningJob job={job} onFinished={onFinished} /> : null}

      {!running && job !== undefined ? <LastRun job={job} plan={plan} /> : null}

      {keyUnsaved && lastSucceeded !== undefined ? (
        <Notice tone="warning" title="Save your recovery key">
          Your backups are encrypted with a key the console keeps. Download it and keep it somewhere
          safe: it is the only way to restore them if this console is ever lost.{" "}
          <Button size="small" onClick={() => setKeyDialog(true)}>
            Save recovery key
          </Button>
        </Notice>
      ) : null}

      {error === undefined ? null : (
        <ErrorNotice title="The backup could not start" error={error} />
      )}

      <div className="backup-actions-buttons">
        {canStart ? (
          <Button
            variant={lastSucceeded === undefined ? "primary" : "secondary"}
            busy={starting || running}
            onClick={() => void backUpNow()}
          >
            {running ? "Backing up…" : "Back up now"}
          </Button>
        ) : null}
        {isAdmin && !running ? (
          <Button
            variant="ghost"
            onClick={() => setPicking((open) => !open)}
            aria-expanded={picking}
          >
            {picking ? "Hide the choice" : "Choose what to back up"}
          </Button>
        ) : null}
        {lastSucceeded?.backupId !== undefined && lastSucceeded.storageId !== undefined ? (
          <AfterBackupActions
            connection={connection}
            plan={plan}
            backupId={lastSucceeded.backupId}
            storageId={lastSucceeded.storageId}
            isAdmin={isAdmin}
            onPlanChanged={props.onPlanChanged}
          />
        ) : (
          <Button disabled title="Make a backup first">
            Restore a backup
          </Button>
        )}
      </div>

      {picking ? (
        <DatabasePicker
          connectionId={connection.id}
          include={chosenInclude}
          onInclude={setChosenInclude}
        />
      ) : null}

      {keyDialog && plan !== undefined ? (
        <RecoveryKeyDialog plan={plan} onClose={() => setKeyDialog(false)} onSaved={props.reload} />
      ) : null}
    </Panel>
  );
}

/** Production / test and Atlas tier, as badges next to the bar's title. */
function ConnectionBadges(props: { connection: ConnectionView }) {
  const { connection } = props;
  return (
    <span className="stack">
      {connection.production ? (
        <StatusBadge status="production" />
      ) : (
        <span className="badge badge-neutral">Test database</span>
      )}
      {connection.deployment?.atlas === undefined ? null : (
        <span className="badge badge-neutral">{atlasTierLabel(connection.deployment.atlas)}</span>
      )}
    </span>
  );
}

/** A running job's live progress; calls `onFinished` once when it ends. */
function RunningJob(props: { job: JobSummary; onFinished: (job: JobSummary) => void }) {
  const { state } = useJobEvents(props.job.id, props.job);
  const finished = state.job !== undefined && isJobFinished(state.job);
  const reported = useRef(false);
  const onFinished = props.onFinished;
  useEffect(() => {
    if (finished && state.job !== undefined && !reported.current) {
      reported.current = true;
      onFinished(state.job);
    }
  }, [finished, state.job, onFinished]);
  const progress = state.progress;
  const what =
    props.job.kind === "backup"
      ? "Backing up"
      : props.job.kind === "verify"
        ? "Checking"
        : "Working";
  return (
    <div role="status" aria-live="polite">
      <ProgressBar
        label={`${what}${progress?.namespace === undefined ? "" : ` ${progress.namespace}`}…`}
        value={progress?.documents ?? 0}
        max={progress?.estimatedDocuments ?? 0}
        detail={
          progress === undefined
            ? "starting"
            : `${formatNumber(progress.documents)} of about ${formatNumber(progress.estimatedDocuments)} documents${progress.etaMs === undefined ? "" : `, ${formatDuration(progress.etaMs)} left`}`
        }
      />
    </div>
  );
}

/** The outcome of the plan's last run. */
function LastRun(props: { job: JobSummary; plan: PlanView | undefined }) {
  const { job, plan } = props;
  const href = buildHref(`/jobs/${segment(job.id)}`);
  if (job.status === "succeeded") {
    return (
      <div className="stack-vertical">
        <p className="backup-actions-status">
          <StatusBadge status="succeeded" label="Backed up" /> <Time value={job.finishedAt} />
          {plan?.encryption.kind === "none" ? null : (
            <span className="badge badge-success">Encrypted</span>
          )}
          <a href={href}>Details</a>
        </p>
        {plan?.schedule === undefined ? null : (
          <p className="muted">
            Backs up automatically ({plan.schedule.cron} in {plan.schedule.timezone})
            {plan.nextRunAt === undefined ? "" : ", next run "}
            {plan.nextRunAt === undefined ? null : <Time value={plan.nextRunAt} relativeOnly />}.
          </p>
        )}
      </div>
    );
  }
  // A server without any database of its own: nothing is wrong, there is just no data yet.
  if (job.status === "failed" && /No namespace matches/i.test(job.error?.message ?? "")) {
    return (
      <Notice tone="info" title="Nothing to back up yet">
        <p>
          This server has no databases besides MongoDB's own (admin, local and config, which are
          never backed up), or none of the chosen ones. Add some data, or choose what to back up,
          then click Back up now again.
        </p>
      </Notice>
    );
  }
  return (
    <Notice
      tone={job.status === "failed" ? "danger" : "info"}
      title={job.status === "failed" ? "The last backup failed" : "The last backup was cancelled"}
    >
      <p>{job.error?.message ?? job.summary ?? "See the job for details."}</p>
      {job.error?.hint === undefined ? null : <p>{job.error.hint}</p>}
      <a href={href}>Open the job</a>
    </Notice>
  );
}

/** One click each: check the backup, test a restore, back up nightly, restore. */
function AfterBackupActions(props: {
  connection: ConnectionView;
  plan: PlanView | undefined;
  backupId: string;
  storageId: string;
  isAdmin: boolean;
  onPlanChanged: (plan: PlanView) => void;
}) {
  const { connection, plan, backupId, storageId } = props;
  const client = useApi();
  const toast = useToast();
  const [followUp, setFollowUp] = useState<JobSummary | undefined>(undefined);
  const [busy, setBusy] = useState<string | undefined>(undefined);
  const [error, setError] = useState<unknown>(undefined);

  const start = async (what: "verify" | "drill") => {
    setBusy(what);
    setError(undefined);
    try {
      const params = { id: storageId, backupId };
      setFollowUp(
        what === "verify"
          ? await client.call(
              "POST /api/storage/:id/backups/:backupId/verify",
              { mode: "deep" },
              { params },
            )
          : await client.call(
              "POST /api/storage/:id/backups/:backupId/drill",
              { targetConnectionId: connection.id },
              { params },
            ),
      );
    } catch (failure) {
      setError(failure);
    } finally {
      setBusy(undefined);
    }
  };

  const makeNightly = async () => {
    if (plan === undefined) return;
    setBusy("nightly");
    setError(undefined);
    try {
      const updated = await client.call(
        "PUT /api/plans/:id",
        nightlyPlanInput(plan, browserTimeZone()),
        {
          params: { id: plan.id },
        },
      );
      props.onPlanChanged(updated);
      toast.show(
        "success",
        `Backs up every night at 02:00 and keeps ${NIGHTLY_RETENTION.daily} daily, ${NIGHTLY_RETENTION.weekly} weekly and ${NIGHTLY_RETENTION.monthly} monthly backups.`,
      );
    } catch (failure) {
      setError(failure);
    } finally {
      setBusy(undefined);
    }
  };

  const restoreHref = buildHref(`/backups/${segment(storageId)}/${segment(backupId)}/restore`);
  return (
    <>
      <Button
        busy={busy === "verify"}
        onClick={() => void start("verify")}
        title="Reads every document of the backup and checks it against its checksums"
      >
        Check the backup
      </Button>
      <Button
        busy={busy === "drill"}
        disabled={connection.production}
        title={
          connection.production
            ? "Test restores write temporary databases; they are not run against production. Open the backup to pick a test connection."
            : "Restores the backup into temporary databases, checks it and removes them again"
        }
        onClick={() => void start("drill")}
      >
        Test a restore
      </Button>
      {props.isAdmin && plan !== undefined && plan.schedule === undefined ? (
        <Button
          busy={busy === "nightly"}
          onClick={() => void makeNightly()}
          title={`Every night at 02:00 (${browserTimeZone()}); keeps 7 daily, 4 weekly and 12 monthly backups`}
        >
          Back up every night
        </Button>
      ) : null}
      <LinkButton href={restoreHref}>Restore a backup</LinkButton>
      {connection.production ? (
        <p className="muted">
          Test restores write temporary databases, so they never run against a production database.{" "}
          <a href={buildHref(`/backups/${segment(storageId)}/${segment(backupId)}`)}>
            Open the backup
          </a>{" "}
          to test it against a test connection.
        </p>
      ) : null}
      {followUp === undefined ? null : <FollowUp job={followUp} />}
      {error === undefined ? null : <ErrorNotice error={error} />}
    </>
  );
}

/** The live status of a verify or drill started from the bar. */
function FollowUp(props: { job: JobSummary }) {
  const { state } = useJobEvents(props.job.id, props.job);
  const job = state.job ?? props.job;
  const label = job.kind === "verify" ? "Check" : "Test restore";
  return (
    <p className="backup-actions-status" role="status">
      <StatusBadge
        status={job.status}
        label={`${label}: ${job.status === "succeeded" ? "passed" : job.status}`}
      />
      {job.summary === undefined ? null : <span className="muted">{job.summary}</span>}
      {job.error === undefined ? null : <span>{job.error.message}</span>}
      <a href={buildHref(`/jobs/${segment(job.id)}`)}>Details</a>
    </p>
  );
}

/** Databases (all chosen by default) with their collections, as checkboxes. */
function DatabasePicker(props: {
  connectionId: string;
  include: readonly string[];
  onInclude: (include: string[]) => void;
}) {
  const client = useApi();
  const tree = useLoad(`namespaces:${props.connectionId}`, (signal) =>
    client.call("GET /api/connections/:id/namespaces", undefined, {
      params: { id: props.connectionId },
      signal,
    }),
  );
  const [chosen, setChosen] = useState<Set<string> | undefined>(undefined);
  // The selection to start from; later changes come from the checkboxes, not from props.
  const startingInclude = useRef(props.include);
  const data = tree.data;
  useEffect(() => {
    if (data !== undefined) setChosen(chosenFrom(data, startingInclude.current));
  }, [data]);

  if (tree.error !== undefined) return <ErrorNotice error={tree.error} onRetry={tree.reload} />;
  if (data === undefined || chosen === undefined)
    return <p className="muted">Loading databases…</p>;
  if (data.length === 0)
    return <p className="muted">This database server has no databases to back up yet.</p>;

  const update = (next: Set<string>) => {
    setChosen(next);
    props.onInclude(includeFor(data, next));
  };
  const toggle = (names: readonly string[], on: boolean) => {
    const next = new Set(chosen);
    for (const ns of names) {
      if (on) next.add(ns);
      else next.delete(ns);
    }
    update(next);
  };

  return (
    <fieldset className="backup-picker">
      <legend>What "Back up now" saves</legend>
      {data.map((database) => {
        const names = database.collections.map(
          (collection) => `${database.name}.${collection.name}`,
        );
        const count = names.filter((ns) => chosen.has(ns)).length;
        return (
          <div key={database.name}>
            <CheckboxField
              label={`${database.name} (${count} of ${plural(names.length, "collection")})`}
              checked={count === names.length && names.length > 0}
              onChecked={(on) => toggle(names, on)}
            />
            {names.length === 0 ? null : (
              <details>
                <summary>Choose collections in {database.name}</summary>
                <div className="backup-picker-collections">
                  {database.collections.map((collection) => {
                    const ns = `${database.name}.${collection.name}`;
                    return (
                      <CheckboxField
                        key={ns}
                        label={collection.name}
                        checked={chosen.has(ns)}
                        onChecked={(on) => toggle([ns], on)}
                      />
                    );
                  })}
                </div>
              </details>
            )}
          </div>
        );
      })}
      <p className="muted">MongoDB's own databases (admin, local, config) are never included.</p>
    </fieldset>
  );
}

/**
 * "Save your recovery key": downloads the plan's private key as a text file. The key is
 * fetched only when the button is pressed (the request is audited on the server).
 */
function RecoveryKeyDialog(props: { plan: PlanView; onClose: () => void; onSaved: () => void }) {
  const client = useApi();
  const [key, setKey] = useState<RecoveryKeyView | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const download = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const view = await client.call("POST /api/plans/:id/recovery-key", undefined, {
        params: { id: props.plan.id },
      });
      setKey(view);
      downloadTextFile(view.filename, view.fileContent);
      props.onSaved();
    } catch (failure) {
      setError(describeError(failure));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      title="Save your recovery key"
      onClose={props.onClose}
      description="Your backups are encrypted. The console keeps the key, so restoring needs no typing. Keep a copy elsewhere too."
      footer={
        key === undefined ? (
          <>
            <Button variant="ghost" onClick={props.onClose}>
              Later
            </Button>
            <Button variant="primary" busy={busy} data-autofocus onClick={() => void download()}>
              Download recovery key
            </Button>
          </>
        ) : (
          <Button variant="primary" data-autofocus onClick={props.onClose}>
            Done
          </Button>
        )
      }
    >
      {key === undefined ? (
        <p>
          If this console or its volume is lost, the recovery key is the only way to restore these
          backups. Store it in a password manager or vault, not next to the backups.
        </p>
      ) : (
        <div className="stack-vertical">
          <Notice tone="success" title="Downloaded">
            <p>
              Saved as <code>{key.filename}</code>. If the download did not start, copy the key:
            </p>
          </Notice>
          <code className="recovery-key">{key.identity}</code>
        </div>
      )}
      {error === undefined ? null : (
        <Notice tone="danger" title="The key could not be fetched">
          {error}
        </Notice>
      )}
    </Dialog>
  );
}
