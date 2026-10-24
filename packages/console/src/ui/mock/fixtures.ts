/**
 * Realistic starting data for mock mode: three connections, three storage locations,
 * three plans, a few weeks of backups with verifications, drills and a hold, recent
 * jobs and audit entries. Times are relative to "now" so the UI always looks lived-in.
 *
 * Secrets (URIs, credentials, passwords) are kept in separate fields that the mock API
 * never returns, mirroring how the real server stores them encrypted.
 */

import type {
  AuditEntry,
  BackupDetail,
  DatabaseNode,
  JobSummary,
  PlanView,
  Role,
} from "../../shared/api.ts";

/** A user plus the password the mock accepts (the real server stores a scrypt hash). */
export interface MockUser {
  readonly id: string;
  username: string;
  role: Role;
  password: string;
  readonly createdAt: string;
  lastLoginAt?: string;
}

/** A connection plus its secret URI. */
export interface MockConnection {
  readonly id: string;
  name: string;
  uri: string;
  production: boolean;
  readonly createdAt: string;
  /** What the connection test reports. */
  topology: string;
  serverVersion: string;
  missingBackupPrivileges: string[];
  missingRestorePrivileges: string[];
  /** The databases and collections "on the server". */
  namespaces: DatabaseNode[];
}

/** A storage location plus its secret credentials. */
export interface MockStorage {
  readonly id: string;
  name: string;
  url: string;
  credentials: Record<string, string>;
  readonly createdAt: string;
  objectLock: boolean;
}

/** A backup in the mock catalog: the API view plus which storage holds it. */
export interface MockBackup extends BackupDetail {
  readonly storageId: string;
}

/** Everything the mock server knows. Mutable so the mock API can change it. */
export interface MockData {
  users: MockUser[];
  connections: MockConnection[];
  storage: MockStorage[];
  plans: PlanView[];
  /** Secrets of plans (passphrases, webhook URLs) by plan id. */
  planSecrets: Record<string, { passphrase?: string; notifyUrls: string[] }>;
  backups: MockBackup[];
  jobs: JobSummary[];
  audit: AuditEntry[];
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** ISO string for `now - ms`. */
function ago(now: number, ms: number): string {
  return new Date(now - ms).toISOString();
}

/** The production database's namespaces (also the shape of every backup of it). */
function productionTree(): DatabaseNode[] {
  return [
    {
      name: "shop",
      collections: [
        { name: "users", type: "collection", estimatedDocuments: 48_210, indexes: 5 },
        { name: "orders", type: "collection", estimatedDocuments: 1_204_332, indexes: 7 },
        { name: "products", type: "collection", estimatedDocuments: 3_120, indexes: 4 },
        { name: "carts", type: "collection", estimatedDocuments: 18_442, indexes: 2 },
        { name: "sessions", type: "collection", estimatedDocuments: 902_113, indexes: 2 },
        { name: "events.2026", type: "timeseries", estimatedDocuments: 12_500_000, indexes: 3 },
      ],
    },
    {
      name: "analytics",
      collections: [
        { name: "daily_rollups", type: "collection", estimatedDocuments: 8_760, indexes: 2 },
        { name: "funnel_view", type: "view", estimatedDocuments: 0, indexes: 0 },
      ],
    },
  ];
}

function stagingTree(): DatabaseNode[] {
  return [
    {
      name: "shop",
      collections: [
        { name: "users", type: "collection", estimatedDocuments: 1_200, indexes: 5 },
        { name: "orders", type: "collection", estimatedDocuments: 25_010, indexes: 7 },
        { name: "products", type: "collection", estimatedDocuments: 3_120, indexes: 4 },
      ],
    },
    {
      name: "shop_restored",
      collections: [{ name: "users", type: "collection", estimatedDocuments: 0, indexes: 1 }],
    },
  ];
}

/** Namespaces in the nightly production backups, with document counts and raw sizes. */
const BACKED_UP_NAMESPACES: readonly {
  ns: string;
  type: string;
  documents: number;
  bytesRaw: number;
}[] = [
  { ns: "shop.users", type: "collection", documents: 48_210, bytesRaw: 41_000_000 },
  { ns: "shop.orders", type: "collection", documents: 1_204_332, bytesRaw: 1_930_000_000 },
  { ns: "shop.products", type: "collection", documents: 3_120, bytesRaw: 9_800_000 },
  { ns: "shop.carts", type: "collection", documents: 18_442, bytesRaw: 12_400_000 },
  { ns: "analytics.daily_rollups", type: "collection", documents: 8_760, bytesRaw: 6_100_000 },
  { ns: "analytics.funnel_view", type: "view", documents: 0, bytesRaw: 0 },
];

/** Builds a manifest shaped like docs/specs/FORMAT.md describes. */
function manifestFor(
  id: string,
  startedAt: string,
  completedAt: string,
  encrypted: boolean,
  bytesStored: number,
) {
  const extension = encrypted ? ".bson.zst.age" : ".bson.zst";
  const namespaces = BACKED_UP_NAMESPACES.map((entry) => {
    const dot = entry.ns.indexOf(".");
    const db = entry.ns.slice(0, dot);
    const collection = entry.ns.slice(dot + 1);
    return {
      ns: entry.ns,
      db,
      collection,
      type: entry.type,
      documents: entry.documents,
      bytesRaw: entry.bytesRaw,
      files:
        entry.type === "view"
          ? []
          : [
              {
                key: `${db}/${collection}${extension}`,
                size: Math.round(entry.bytesRaw * 0.22),
                sha256: "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
              },
            ],
      metadata: {
        key: `${db}/${collection}.metadata.json`,
        size: 412,
        sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      },
    };
  });
  return {
    formatVersion: 1,
    id,
    tool: "mongoshield@2.0.0",
    status: "complete",
    startedAt,
    completedAt,
    source: { topology: "replicaSet", serverVersion: "8.0.4", clusterId: "c1f0a9b2" },
    consistency: { mode: "snapshot" },
    compression: "zstd",
    encryption: encrypted
      ? {
          scheme: "age-v1",
          recipients: ["age1ql3z7hjy54pw3hyww5ayyfg7zqgvc7w3j2elw8zmrj2kg5sfn9aqmcac8p"],
        }
      : null,
    labels: { trigger: "schedule", plan: "Nightly production" },
    namespaces,
    totals: {
      namespaces: namespaces.length,
      documents: BACKED_UP_NAMESPACES.reduce((sum, entry) => sum + entry.documents, 0),
      bytesRaw: BACKED_UP_NAMESPACES.reduce((sum, entry) => sum + entry.bytesRaw, 0),
      bytesStored,
    },
  };
}

/** Backup id in the library's format: `2026-10-21T02-00-04Z_7f3a9c`. */
function backupId(date: Date, suffix: string): string {
  return `${date.toISOString().slice(0, 19).replaceAll(":", "-")}Z_${suffix}`;
}

/** Nightly backups at 02:00 UTC for the last `days` days, newest first. */
function nightlyBackups(now: number, storageId: string, days: number): MockBackup[] {
  const today = new Date(now);
  const backups: MockBackup[] = [];
  for (let day = 0; day < days; day += 1) {
    const started = new Date(
      Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - day, 2, 0, 4),
    );
    if (started.getTime() > now) continue;
    const id = backupId(started, (0x7f3a9c + day * 4099).toString(16).slice(-6));
    const startedAt = started.toISOString();
    const completedAt = new Date(started.getTime() + 11 * MINUTE + day * 7_000).toISOString();
    const bytesStored = 438_000_000 + day * 1_700_000;
    const documents = 1_282_864 - day * 1_310;

    // Day 3 crashed: no manifest, so the catalog reports it as incomplete.
    if (day === 3) {
      backups.push({ id, storageId, status: "incomplete", startedAt, drills: [] });
      continue;
    }
    const verification =
      day === 0
        ? undefined
        : day === 5
          ? {
              mode: "fast",
              ok: false,
              verifiedAt: new Date(started.getTime() + 2 * HOUR).toISOString(),
            }
          : {
              mode: day % 7 === 1 ? "deep" : "fast",
              ok: true,
              verifiedAt: new Date(started.getTime() + 30 * MINUTE).toISOString(),
            };
    const drills =
      day === 1 || day === 8
        ? [
            {
              drilledAt: new Date(started.getTime() + 3 * HOUR).toISOString(),
              ok: true,
              rtoMs: 14 * MINUTE + 12_000,
            },
          ]
        : [];
    backups.push({
      id,
      storageId,
      status: "complete",
      startedAt,
      completedAt,
      namespaces: BACKED_UP_NAMESPACES.length,
      documents,
      bytesStored,
      encrypted: true,
      consistency: "snapshot",
      ...(verification === undefined ? {} : { verification }),
      ...(day === 9
        ? { hold: { reason: "Legal hold: ticket SEC-2291", heldAt: ago(now, 2 * DAY) } }
        : {}),
      ...(day === 2
        ? { immutableUntil: new Date(started.getTime() + 30 * DAY).toISOString() }
        : {}),
      manifest: manifestFor(id, startedAt, completedAt, true, bytesStored),
      drills,
    });
  }
  return backups;
}

/** Weekly offsite copies on Mondays, unencrypted metadata-wise the same shape. */
function weeklyBackups(now: number, storageId: string, weeks: number): MockBackup[] {
  const backups: MockBackup[] = [];
  for (let week = 0; week < weeks; week += 1) {
    const started = new Date(now - (week * 7 + 2) * DAY);
    started.setUTCHours(3, 30, 2, 0);
    const id = backupId(started, (0xa0c311 + week * 977).toString(16).slice(-6));
    const startedAt = started.toISOString();
    const completedAt = new Date(started.getTime() + 13 * MINUTE).toISOString();
    const bytesStored = 441_000_000 - week * 2_100_000;
    backups.push({
      id,
      storageId,
      status: "complete",
      startedAt,
      completedAt,
      namespaces: BACKED_UP_NAMESPACES.length,
      documents: 1_280_000 - week * 9_000,
      bytesStored,
      encrypted: false,
      consistency: "snapshot",
      ...(week < 2
        ? {
            verification: {
              mode: "fast",
              ok: true,
              verifiedAt: new Date(started.getTime() + HOUR).toISOString(),
            },
          }
        : {}),
      manifest: manifestFor(id, startedAt, completedAt, false, bytesStored),
      drills: [],
    });
  }
  return backups;
}

/** Creates a fresh copy of the mock data, with times relative to `now`. */
export function createFixtures(now: number = Date.now()): MockData {
  const nightly = nightlyBackups(now, "st-s3", 16);
  const latestNightly = nightly.find((backup) => backup.status === "complete");

  const jobs: JobSummary[] = [
    {
      id: "job-1042",
      kind: "backup",
      status: "succeeded",
      planId: "plan-nightly",
      startedAt: latestNightly?.startedAt ?? ago(now, 10 * HOUR),
      finishedAt: latestNightly?.completedAt ?? ago(now, 10 * HOUR - 11 * MINUTE),
      startedBy: "schedule",
      storageId: "st-s3",
      ...(latestNightly === undefined ? {} : { backupId: latestNightly.id }),
      summary: latestNightly?.id ?? "backup created",
    },
    {
      id: "job-1041",
      kind: "backup",
      status: "failed",
      planId: "plan-hourly",
      startedAt: ago(now, 45 * MINUTE),
      finishedAt: ago(now, 44 * MINUTE),
      startedBy: "schedule",
      error: {
        code: "MS_SOURCE_UNREACHABLE",
        message: "Could not connect to staging-db.internal:27017 within 30 s.",
        hint: "Check that the database is running and reachable from the console's network.",
      },
    },
    {
      id: "job-1040",
      kind: "verify",
      status: "succeeded",
      startedAt: ago(now, 20 * HOUR),
      finishedAt: ago(now, 20 * HOUR - 4 * MINUTE),
      startedBy: "schedule",
      summary: "fast verify passed: 11 files checked",
    },
    {
      id: "job-1039",
      kind: "drill",
      status: "succeeded",
      startedAt: ago(now, 30 * HOUR),
      finishedAt: ago(now, 30 * HOUR - 14 * MINUTE),
      startedBy: "maya",
      summary: "restored 1.28M documents into Staging in 14 min",
    },
    {
      id: "job-1038",
      kind: "restore",
      status: "cancelled",
      startedAt: ago(now, 3 * DAY),
      finishedAt: ago(now, 3 * DAY - 2 * MINUTE),
      startedBy: "admin",
      summary: "cancelled after 12,400 documents",
    },
    {
      id: "job-1037",
      kind: "prune",
      status: "succeeded",
      planId: "plan-nightly",
      startedAt: ago(now, 34 * HOUR),
      finishedAt: ago(now, 34 * HOUR - 20_000),
      startedBy: "schedule",
      summary: "deleted 1 backup, kept 14",
    },
  ];

  const plans: PlanView[] = [
    {
      id: "plan-nightly",
      name: "Nightly production",
      connectionId: "conn-prod",
      storageId: "st-s3",
      include: ["shop.*", "analytics.*"],
      exclude: ["*.sessions", "shop.events.*"],
      compression: "zstd",
      encryption: {
        kind: "recipients",
        recipients: ["age1ql3z7hjy54pw3hyww5ayyfg7zqgvc7w3j2elw8zmrj2kg5sfn9aqmcac8p"],
      },
      consistency: "auto",
      schedule: { cron: "0 2 * * *", timezone: "UTC" },
      retention: { last: 3, daily: 7, weekly: 4, monthly: 12 },
      verify: "fast",
      notify: [
        {
          type: "slack",
          url: { configured: true, preview: "https://hooks.slack.com/services/T0…/***" },
        },
      ],
      ...(jobs[0] === undefined ? {} : { lastRun: jobs[0] }),
    },
    {
      id: "plan-hourly",
      name: "Staging hourly",
      connectionId: "conn-staging",
      storageId: "st-r2",
      include: ["shop.orders"],
      exclude: [],
      compression: "gzip",
      encryption: { kind: "passphrase", passphrase: { configured: true } },
      consistency: "none",
      schedule: { cron: "15 * * * *", timezone: "Europe/Berlin" },
      retention: { last: 24 },
      verify: "none",
      notify: [],
      ...(jobs[1] === undefined ? {} : { lastRun: jobs[1] }),
    },
    {
      id: "plan-local",
      name: "Local dev snapshot",
      connectionId: "conn-local",
      storageId: "st-local",
      include: [],
      exclude: [],
      compression: "none",
      encryption: { kind: "none" },
      consistency: "auto",
      verify: "deep",
      notify: [],
    },
  ];

  return {
    users: [
      {
        id: "user-admin",
        username: "admin",
        role: "admin",
        password: "admin",
        createdAt: ago(now, 60 * DAY),
        lastLoginAt: ago(now, 2 * HOUR),
      },
      {
        id: "user-maya",
        username: "maya",
        role: "operator",
        password: "operator",
        createdAt: ago(now, 40 * DAY),
        lastLoginAt: ago(now, 30 * HOUR),
      },
      {
        id: "user-sam",
        username: "sam",
        role: "viewer",
        password: "viewer",
        createdAt: ago(now, 12 * DAY),
      },
    ],
    connections: [
      {
        id: "conn-prod",
        name: "Production cluster",
        uri: "mongodb+srv://backup:s3cr3t@prod-cluster.a1b2c.mongodb.net/?retryWrites=true",
        production: true,
        createdAt: ago(now, 60 * DAY),
        topology: "replicaSet",
        serverVersion: "8.0.4",
        missingBackupPrivileges: [],
        missingRestorePrivileges: ["dropCollection on shop.*", "createIndex on shop.*"],
        namespaces: productionTree(),
      },
      {
        id: "conn-staging",
        name: "Staging",
        uri: "mongodb://restore:hunter2@staging-db.internal:27017/?replicaSet=rs0",
        production: false,
        createdAt: ago(now, 45 * DAY),
        topology: "replicaSet",
        serverVersion: "7.0.14",
        missingBackupPrivileges: [],
        missingRestorePrivileges: [],
        namespaces: stagingTree(),
      },
      {
        id: "conn-local",
        name: "Local dev",
        uri: "mongodb://localhost:27017",
        production: false,
        createdAt: ago(now, 5 * DAY),
        topology: "standalone",
        serverVersion: "8.0.1",
        missingBackupPrivileges: [],
        missingRestorePrivileges: [],
        namespaces: [
          {
            name: "test",
            collections: [
              { name: "fixtures", type: "collection", estimatedDocuments: 120, indexes: 1 },
            ],
          },
        ],
      },
    ],
    storage: [
      {
        id: "st-s3",
        name: "S3 primary",
        url: "s3://acme-backups/prod/",
        credentials: { AWS_ACCESS_KEY_ID: "AKIA…", AWS_SECRET_ACCESS_KEY: "…" },
        createdAt: ago(now, 60 * DAY),
        objectLock: true,
      },
      {
        id: "st-r2",
        name: "R2 offsite",
        url: "s3://acme-offsite/weekly/",
        credentials: {
          AWS_ACCESS_KEY_ID: "r2…",
          AWS_SECRET_ACCESS_KEY: "…",
          AWS_ENDPOINT_URL: "https://acc.r2.cloudflarestorage.com",
        },
        createdAt: ago(now, 30 * DAY),
        objectLock: false,
      },
      {
        id: "st-local",
        name: "Local volume",
        url: "/data/backups",
        credentials: {},
        createdAt: ago(now, 5 * DAY),
        objectLock: false,
      },
    ],
    plans,
    planSecrets: {
      "plan-nightly": { notifyUrls: ["https://hooks.slack.com/services/T000/B000/XXXX"] },
      "plan-hourly": { passphrase: "correct horse battery staple", notifyUrls: [] },
      "plan-local": { notifyUrls: [] },
    },
    backups: [...nightly, ...weeklyBackups(now, "st-r2", 4)],
    jobs,
    audit: [
      { at: ago(now, 2 * HOUR), actor: "admin", action: "session.login", outcome: "success" },
      {
        at: ago(now, 3 * HOUR),
        actor: "anonymous",
        action: "session.login_failed",
        outcome: "failure",
        details: { username: "root", ip: "203.0.113.7" },
      },
      {
        at: ago(now, 30 * HOUR),
        actor: "maya",
        action: "drill.start",
        target: "S3 primary",
        outcome: "success",
      },
      {
        at: ago(now, 2 * DAY),
        actor: "admin",
        action: "backup.hold",
        target: nightly[9]?.id ?? "backup",
        outcome: "success",
        details: { reason: "Legal hold: ticket SEC-2291" },
      },
      {
        at: ago(now, 3 * DAY),
        actor: "admin",
        action: "restore.start",
        target: "Staging",
        outcome: "success",
        details: { mode: "drop" },
      },
      {
        at: ago(now, 5 * DAY),
        actor: "admin",
        action: "connection.create",
        target: "Local dev",
        outcome: "success",
      },
      {
        at: ago(now, 12 * DAY),
        actor: "admin",
        action: "user.create",
        target: "sam",
        outcome: "success",
        details: { role: "viewer" },
      },
    ],
  };
}

/** Deterministic pseudo-random hex, so generated documents are stable between pages. */
function hex(seed: number, length: number): string {
  let value = (seed * 2_654_435_761) >>> 0;
  let result = "";
  while (result.length < length) {
    value = (value * 1_103_515_245 + 12_345) >>> 0;
    result += value.toString(16).padStart(8, "0");
  }
  return result.slice(0, length);
}

const FIRST_NAMES = [
  "Ada",
  "Grace",
  "Linus",
  "Margaret",
  "Ken",
  "Barbara",
  "Dennis",
  "Frances",
  "Edsger",
  "Radia",
];
const STATUSES = ["placed", "paid", "shipped", "delivered", "refunded"];

/**
 * Document number `index` of a namespace in a backup, as relaxed Extended JSON.
 * Generated on demand so "1.2M documents" costs no memory.
 */
export function generateDocument(
  ns: string,
  index: number,
  backupTime: number,
): Record<string, unknown> {
  const id = { $oid: `65${hex(index + ns.length * 7_919, 22)}` };
  const created = { $date: new Date(backupTime - (index % 900) * HOUR).toISOString() };
  const name = FIRST_NAMES[index % FIRST_NAMES.length] ?? "Ada";
  if (ns.endsWith(".users")) {
    return {
      _id: id,
      email: `${name.toLowerCase()}.${index}@example.com`,
      name: `${name} #${index}`,
      plan: index % 5 === 0 ? "pro" : "free",
      logins: (index * 37) % 500,
      createdAt: created,
      address: {
        city: index % 2 === 0 ? "Colombo" : "Berlin",
        zip: String(10_000 + (index % 89_999)),
      },
      tags: index % 3 === 0 ? ["beta", "newsletter"] : [],
    };
  }
  if (ns.endsWith(".orders")) {
    return {
      _id: id,
      userId: { $oid: `65${hex(index % 48_210, 22)}` },
      status: STATUSES[index % STATUSES.length],
      total: { $numberDecimal: `${(index % 400) + 9}.${String(index % 100).padStart(2, "0")}` },
      items: [
        { sku: `SKU-${1000 + (index % 3120)}`, quantity: (index % 3) + 1 },
        ...(index % 2 === 0 ? [{ sku: `SKU-${2000 + (index % 777)}`, quantity: 1 }] : []),
      ],
      placedAt: created,
    };
  }
  return {
    _id: id,
    name: `${ns.split(".").pop() ?? "item"} ${index}`,
    value: index,
    updatedAt: created,
  };
}
