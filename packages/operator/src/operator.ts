/**
 * The operator: informers, controllers, leader election and the HTTP endpoint,
 * wired together.
 *
 *   informers (list+watch) ──change──▶ work queues ──key──▶ reconcilers ──▶ API writes
 *        ▲                                                                     │
 *        └──────────────────────────── watch events ◀──────────────────────────┘
 *
 * Which changes wake which controller:
 *   - a plan                       → that plan, and its runs still waiting to start
 *   - a MongoShieldBackup          → that backup, and its plan (status summary)
 *   - a MongoShieldRestore         → that restore
 *   - a MongoShieldDrill           → that drill
 *   - a Job                        → the backup, restore or drill that owns it; for a
 *                                    CronJob's Job, the plan and the run record
 *   - a CronJob                    → its plan (drift is repaired: edit or delete the
 *                                    CronJob by hand and the plan puts it back)
 * Every object is also re-checked every RESYNC_SECONDS, as a safety net.
 *
 * Life cycle: informers start at once on every replica (a standby has warm caches
 * when it takes over); controllers run only on the leader. Losing leadership is fatal
 * (the process exits and restarts as a standby). On SIGTERM: stop handing out work,
 * let running reconciles finish, release the Lease, stop the watches, close HTTP.
 */

import type { Server } from "node:http";
import { KINDS, LABELS, MANAGED_BY } from "./api/constants.ts";
import {
  type Backup,
  type BackupPlan,
  type Drill,
  type Restore,
  TERMINAL_BACKUP_PHASES,
} from "./api/types.ts";
import { Controller, type ObjectRef } from "./controller/controller.ts";
import { ApiEventRecorder } from "./controller/events.ts";
import { controllerOf } from "./controller/ownership.ts";
import { startHttpServer, stopHttpServer } from "./http/server.ts";
import { type KubeClient, RESOURCES } from "./kube/client.ts";
import { Informer } from "./kube/informer.ts";
import type { CronJob, Job, KubeObject } from "./kube/objects.ts";
import { LeaderElector } from "./leader/lease.ts";
import type { Logger } from "./logger.ts";
import { OperatorMetrics } from "./operator-metrics.ts";
import { reconcileBackup } from "./reconcilers/backup.ts";
import type { ReconcilerContext } from "./reconcilers/context.ts";
import { reconcileDrill } from "./reconcilers/drill.ts";
import { reconcilePlan } from "./reconcilers/plan.ts";
import { reconcileRestore } from "./reconcilers/restore.ts";
import type { OperatorSettings } from "./settings.ts";

/** How long a graceful shutdown waits for running reconciles. */
const SHUTDOWN_GRACE_MS = 20_000;

export interface OperatorOptions {
  readonly client: KubeClient;
  readonly settings: OperatorSettings;
  readonly logger: Logger;
  /** Called when the operator cannot continue (lost leadership); main.ts exits. */
  readonly onFatal?: (reason: string) => void;
  /** Start the HTTP endpoint (off in unit tests). */
  readonly serveHttp?: boolean;
  readonly now?: () => Date;
  /** Informer retry/timeout tuning, for tests. */
  readonly informerBackoff?: { readonly initialMs: number; readonly maxMs: number };
  /** Leader election timing (defaults: 15 s lease, 10 s renew deadline, 2 s retry), for tests. */
  readonly leaderTiming?: {
    readonly leaseDurationMs: number;
    readonly renewDeadlineMs: number;
    readonly retryPeriodMs: number;
  };
}

export class Operator {
  readonly metrics: OperatorMetrics;
  readonly plans: Informer<BackupPlan>;
  readonly backups: Informer<Backup>;
  readonly restores: Informer<Restore>;
  readonly drills: Informer<Drill>;
  readonly jobs: Informer<Job>;
  readonly cronJobs: Informer<CronJob>;
  readonly planController: Controller;
  readonly backupController: Controller;
  readonly restoreController: Controller;
  readonly drillController: Controller;

  readonly #options: OperatorOptions;
  readonly #logger: Logger;
  readonly #elector: LeaderElector | undefined;
  /** Stops the informers' watches. */
  readonly #informerAbort = new AbortController();
  /** Stops leader election (releasing the Lease). */
  readonly #electionAbort = new AbortController();
  #controllersRunning: Promise<void> | undefined;
  #electionDone: Promise<void> | undefined;
  #resyncTimer: NodeJS.Timeout | undefined;
  #server: Server | undefined;
  #leading = false;
  #stopping = false;

  constructor(options: OperatorOptions) {
    this.#options = options;
    const { client, settings, logger } = options;
    this.#logger = logger;
    const now = options.now ?? (() => new Date());

    // Caches. Jobs and CronJobs are filtered to the ones this operator created.
    const informer = <T extends KubeObject>(
      type: (typeof RESOURCES)[keyof typeof RESOURCES],
      labelSelector?: string,
    ) =>
      new Informer<T>(client, {
        type,
        namespaces: settings.watchNamespaces,
        logger,
        ...(labelSelector ? { labelSelector } : {}),
        ...(options.informerBackoff ? { backoff: options.informerBackoff } : {}),
      });
    const managed = `${LABELS.managedBy}=${MANAGED_BY}`;
    this.plans = informer<BackupPlan>(RESOURCES.plans);
    this.backups = informer<Backup>(RESOURCES.backups);
    this.restores = informer<Restore>(RESOURCES.restores);
    this.drills = informer<Drill>(RESOURCES.drills);
    this.jobs = informer<Job>(RESOURCES.jobs, managed);
    this.cronJobs = informer<CronJob>(RESOURCES.cronJobs, managed);

    this.metrics = new OperatorMetrics({
      backups: () => this.backups.list(),
      restores: () => this.restores.list(),
      drills: () => this.drills.list(),
      queueDepths: () =>
        [
          this.planController,
          this.backupController,
          this.restoreController,
          this.drillController,
        ].map((controller) => ({
          controller: controller.name,
          depth: controller.queue.length,
        })),
      isLeader: () => this.#leading,
    });

    const context: ReconcilerContext = {
      client,
      plans: this.plans,
      backups: this.backups,
      restores: this.restores,
      drills: this.drills,
      jobs: this.jobs,
      cronJobs: this.cronJobs,
      events: new ApiEventRecorder(client, logger, settings.identity, now),
      metrics: this.metrics,
      logger,
      defaults: {
        image: settings.image,
        ...(settings.imagePullPolicy ? { imagePullPolicy: settings.imagePullPolicy } : {}),
      },
      now,
    };
    const controller = (
      name: string,
      reconcile: (ref: ObjectRef) => ReturnType<typeof reconcilePlan>,
    ) =>
      new Controller({ name, reconcile, workers: settings.workers, logger, metrics: this.metrics });
    this.planController = controller("plan", (ref) => reconcilePlan(context, ref));
    this.backupController = controller("backup", (ref) => reconcileBackup(context, ref));
    this.restoreController = controller("restore", (ref) => reconcileRestore(context, ref));
    this.drillController = controller("drill", (ref) => reconcileDrill(context, ref));

    this.#wireEvents();

    this.#elector = settings.leaderElection
      ? new LeaderElector({
          client,
          namespace: settings.operatorNamespace,
          name: settings.leaseName,
          identity: settings.identity,
          logger,
          ...options.leaderTiming,
          ...(options.now ? { now: options.now } : {}),
        })
      : undefined;
  }

  /** True when the operator should receive traffic (see http/server.ts). */
  isReady(): boolean {
    if (this.#stopping) return false;
    if (!this.#leading) return this.#elector !== undefined;
    return this.#informers().every((informer) => informer.hasSynced());
  }

  /** True while this replica runs the controllers. */
  isLeading(): boolean {
    return this.#leading;
  }

  /** Starts everything; resolves once started (not when stopped). */
  async start(): Promise<void> {
    const { settings } = this.#options;
    for (const informer of this.#informers()) informer.start(this.#informerAbort.signal);
    if (this.#options.serveHttp) {
      this.#server = await startHttpServer({
        port: settings.httpPort,
        isReady: () => this.isReady(),
        metrics: () => this.metrics.render(),
      });
    }
    this.#logger.info("operator started", {
      namespaces: settings.watchNamespaces ?? "all",
      leaderElection: settings.leaderElection,
      image: settings.image,
    });

    if (!this.#elector) {
      await this.#startLeading();
      return;
    }
    this.#electionDone = this.#elector.run(this.#electionAbort.signal, {
      onStartedLeading: () => {
        void this.#startLeading();
      },
      onStoppedLeading: (reason) => {
        if (reason === "lost") {
          // Another replica may already be reconciling: stop at once.
          this.#stopControllers();
          this.#options.onFatal?.("lost leadership");
        }
      },
    });
  }

  /** Graceful shutdown (see the file header for the order). */
  async stop(): Promise<void> {
    if (this.#stopping) return;
    this.#stopping = true;
    this.#logger.info("shutting down");
    this.#stopControllers();
    if (this.#controllersRunning) {
      await Promise.race([
        this.#controllersRunning,
        new Promise((resolve) => setTimeout(resolve, SHUTDOWN_GRACE_MS).unref()),
      ]);
    }
    this.#electionAbort.abort();
    await this.#electionDone;
    this.#informerAbort.abort();
    await Promise.all(this.#informers().map((informer) => informer.stopped()));
    if (this.#server) await stopHttpServer(this.#server);
    this.#logger.info("stopped");
  }

  /** Becoming leader: wait for warm caches, queue everything, run the controllers. */
  async #startLeading(): Promise<void> {
    this.#leading = true;
    for (const informer of this.#informers())
      await informer.waitForSync(this.#informerAbort.signal);
    if (this.#stopping) return;
    this.#resyncAll();
    this.#resyncTimer = setInterval(() => this.#resyncAll(), this.#options.settings.resyncMs);
    this.#resyncTimer.unref();
    this.#controllersRunning = Promise.all([
      this.planController.run(),
      this.backupController.run(),
      this.restoreController.run(),
      this.drillController.run(),
    ]).then(() => undefined);
  }

  #stopControllers(): void {
    this.#leading = false;
    if (this.#resyncTimer) clearInterval(this.#resyncTimer);
    this.planController.stop();
    this.backupController.stop();
    this.restoreController.stop();
    this.drillController.stop();
  }

  /** Queues every cached object (initial sync and periodic resync). */
  #resyncAll(): void {
    for (const plan of this.plans.list()) this.planController.enqueue(refOf(plan));
    for (const backup of this.backups.list()) this.backupController.enqueue(refOf(backup));
    for (const restore of this.restores.list()) this.restoreController.enqueue(refOf(restore));
    for (const drill of this.drills.list()) this.drillController.enqueue(refOf(drill));
  }

  /** Maps informer changes to controller keys (see the file header). */
  #wireEvents(): void {
    this.plans.onChange((_change, plan) => {
      this.planController.enqueue(refOf(plan));
      // Runs waiting for this plan to become Ready can start now.
      for (const backup of this.backups.list(plan.metadata.namespace)) {
        const waiting =
          !backup.status?.phase || !TERMINAL_BACKUP_PHASES.includes(backup.status.phase);
        if (backup.spec.planRef.name === plan.metadata.name && waiting) {
          this.backupController.enqueue(refOf(backup));
        }
      }
      for (const restore of this.restores.list(plan.metadata.namespace)) {
        if (
          restore.spec.planRef.name === plan.metadata.name &&
          restore.status?.phase !== "Succeeded" &&
          restore.status?.phase !== "Failed"
        ) {
          this.restoreController.enqueue(refOf(restore));
        }
      }
      for (const drill of this.drills.list(plan.metadata.namespace)) {
        if (drill.spec.planRef.name === plan.metadata.name && !isFinished(drill.status?.phase)) {
          this.drillController.enqueue(refOf(drill));
        }
      }
    });
    this.backups.onChange((_change, backup) => {
      this.backupController.enqueue(refOf(backup));
      this.planController.enqueue({
        namespace: backup.metadata.namespace ?? "",
        name: backup.spec.planRef.name,
      });
      // Restores waiting for this backup to finish.
      for (const restore of this.restores.list(backup.metadata.namespace)) {
        if (restore.spec.backup?.name === backup.metadata.name)
          this.restoreController.enqueue(refOf(restore));
      }
      // …and drills.
      for (const drill of this.drills.list(backup.metadata.namespace)) {
        if (drill.spec.backup?.name === backup.metadata.name)
          this.drillController.enqueue(refOf(drill));
      }
    });
    this.restores.onChange((_change, restore) => this.restoreController.enqueue(refOf(restore)));
    this.drills.onChange((_change, drill) => this.drillController.enqueue(refOf(drill)));
    this.jobs.onChange((_change, job) => this.#onJobChange(job));
    this.cronJobs.onChange((_change, cronJob) => {
      const owner = controllerOf(cronJob, KINDS.plan);
      if (owner)
        this.planController.enqueue({
          namespace: cronJob.metadata.namespace ?? "",
          name: owner.name,
        });
    });
  }

  #onJobChange(job: Job): void {
    const namespace = job.metadata.namespace ?? "";
    const backupOwner = controllerOf(job, KINDS.backup);
    if (backupOwner) this.backupController.enqueue({ namespace, name: backupOwner.name });
    const restoreOwner = controllerOf(job, KINDS.restore);
    if (restoreOwner) this.restoreController.enqueue({ namespace, name: restoreOwner.name });
    const drillOwner = controllerOf(job, KINDS.drill);
    if (drillOwner) this.drillController.enqueue({ namespace, name: drillOwner.name });
    if (controllerOf(job, "CronJob")) {
      // A scheduled run: its record has the Job's name; the plan creates that record.
      this.backupController.enqueue({ namespace, name: job.metadata.name ?? "" });
      const planName = this.#planOfCronJobJob(job);
      if (planName) this.planController.enqueue({ namespace, name: planName });
    }
  }

  /** The plan whose CronJob started this Job (via the CronJob's owner reference). */
  #planOfCronJobJob(job: Job): string | undefined {
    const cronJobName = controllerOf(job, "CronJob")?.name;
    if (!cronJobName) return undefined;
    const cronJob = this.cronJobs.get(job.metadata.namespace ?? "", cronJobName);
    return cronJob ? controllerOf(cronJob, KINDS.plan)?.name : undefined;
  }

  #informers(): Informer<KubeObject>[] {
    return [
      this.plans,
      this.backups,
      this.restores,
      this.drills,
      this.jobs,
      this.cronJobs,
    ] as unknown as Informer<KubeObject>[];
  }
}

/** True for the final phases of restores and drills. */
function isFinished(phase: string | undefined): boolean {
  return phase === "Succeeded" || phase === "Failed";
}

function refOf(object: KubeObject): ObjectRef {
  return { namespace: object.metadata.namespace ?? "", name: object.metadata.name ?? "" };
}
