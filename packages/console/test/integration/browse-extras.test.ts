/**
 * Samples and exports for the document viewer, end to end through the API against the
 * real test replica set: live `$sample` (default size, caps, filters, refused
 * server-side JavaScript, roles, audit), live exports in JSON, JSON Lines and CSV
 * (flattening, quoting, the formula guard, limits, canonical Extended JSON), the same
 * for a backup, `ejson=canonical` on both document browsers, quiet cancellation, and
 * the Atlas Free/Flex behaviour with a fake Atlas client (stats explained instead of
 * failing, smaller samples, one sample at a time).
 */

import {
  type Collection,
  type Document,
  Double,
  Long,
  MongoClient,
  MongoServerError,
} from "mongodb";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  ATLAS_STATS_UNAVAILABLE,
  PRIVILEGE_STATS_UNAVAILABLE,
} from "../../src/server/live/collection-stats.ts";
import {
  EXPORT_DEFAULT_LIMIT,
  LIVE_SAMPLE_DEFAULT_SIZE,
  LIVE_SAMPLE_MAX_SIZE,
  LIVE_SAMPLE_SHARED_TIER_MAX_SIZE,
} from "../../src/shared/api.ts";
import {
  mongoUri,
  removeDataDir,
  setupAdmin,
  startConsole,
  type TestClient,
  type TestConsole,
  uniqueDb,
  userWithRole,
  waitForJob,
} from "../helpers/console.ts";

/** The seed documents: integer `_id`s, anything else. */
type NumberedDocument = { _id: number; [field: string]: unknown };

const db = uniqueDb("extras");
/** 30 people with nested fields, arrays and dates. */
const PEOPLE = `${db}.people`;
/** Two documents written for the exact CSV assertions. */
const CSV = `${db}.csvdocs`;
/** More documents than the largest sample. */
const MANY = `${db}.many`;
const PEOPLE_COUNT = 30;
const MANY_COUNT = LIVE_SAMPLE_MAX_SIZE + 100;

let testConsole: TestConsole;
let admin: TestClient;
let operator: TestClient;
let viewer: TestClient;
let mongo: MongoClient;
const ids = { connection: "", storage: "", backup: "" };

/** GET with a query string; returns the recorded response. */
function get(client: TestClient, path: string, query: Record<string, string>) {
  return client.request("GET", `${path}?${new URLSearchParams(query)}`);
}

/** The live route of the test connection, e.g. `live("sample")`. */
const live = (route: string) => `/api/live/${ids.connection}/${route}`;
/** The backup route of the test backup, e.g. `backup("export")`. */
const backup = (route: string) => `/api/storage/${ids.storage}/backups/${ids.backup}/${route}`;

/** Audit entries of an action, newest first. */
async function auditOf(action: string): Promise<{ actor: string; details: Document }[]> {
  const entries = (await admin.request("GET", "/api/audit?limit=500")).body as {
    action: string;
    actor: string;
    details: Document;
  }[];
  return entries.filter((entry) => entry.action === action);
}

beforeAll(async () => {
  testConsole = await startConsole();
  admin = await setupAdmin(testConsole);
  operator = await userWithRole(testConsole, admin, "operator", "olga");
  viewer = await userWithRole(testConsole, admin, "viewer", "victor");
  mongo = new MongoClient(mongoUri());
  await mongo.connect();
  await mongo
    .db(db)
    .collection<NumberedDocument>("people")
    .insertMany(
      Array.from({ length: PEOPLE_COUNT }, (_, index) => ({
        _id: index,
        name: `person ${index}`,
        group: index % 3,
        address: { city: index % 2 === 0 ? "Oslo" : "Lima" },
        tags: ["a", `t${index}`],
        score: new Double(index + 0.5),
      })),
    );
  await mongo
    .db(db)
    .collection<NumberedDocument>("csvdocs")
    .insertMany([
      {
        _id: 1,
        name: "Ada, Countess",
        address: { city: "London" },
        tags: ["math", "poetry"],
        note: "=1+1",
        at: new Date("2026-01-02T03:04:05.000Z"),
      },
      {
        _id: 2,
        name: 'Say "hi"',
        score: new Double(2.5),
        big: Long.fromString("9007199254740993"),
      },
    ]);
  await mongo
    .db(db)
    .collection<NumberedDocument>("many")
    .insertMany(Array.from({ length: MANY_COUNT }, (_, index) => ({ _id: index })));

  ids.connection = (
    await admin.request("POST", "/api/connections", {
      name: "extras",
      uri: mongoUri(),
      production: false,
    })
  ).body.id;
  ids.storage = (
    await admin.request("POST", "/api/storage", {
      name: "extras-store",
      url: `memory://${uniqueDb("store")}`,
    })
  ).body.id;
  const plan = await admin.request("POST", "/api/plans", {
    name: "extras",
    connectionId: ids.connection,
    storageId: ids.storage,
    include: [`${db}.*`],
    exclude: [],
    compression: "zstd",
    encryption: { kind: "passphrase", passphrase: "extras-passphrase-for-the-tests" },
    consistency: "auto",
    verify: "none",
    notify: [],
  });
  expect(plan.status, plan.text).toBe(200);
  const run = await operator.request("POST", `/api/plans/${plan.body.id}/run`);
  const job = await waitForJob(testConsole, run.body.id);
  expect(job.status, job.summary).toBe("succeeded");
  ids.backup = job.backupId ?? "";
});

afterAll(async () => {
  await mongo.close();
  await testConsole.close();
  await removeDataDir(testConsole.dataDir);
});

// ---------------------------------------------------------------------------
// Live samples
// ---------------------------------------------------------------------------

describe("live samples", () => {
  it("need the operator role", async () => {
    expect((await get(viewer, live("sample"), { ns: PEOPLE })).status).toBe(403);
    expect((await get(viewer, live("export"), { ns: PEOPLE })).status).toBe(403);
  });

  it("read a random sample of the default size, as relaxed Extended JSON", async () => {
    const response = await get(operator, live("sample"), { ns: MANY });
    expect(response.status, response.text).toBe(200);
    expect(response.body).toMatchObject({ size: LIVE_SAMPLE_DEFAULT_SIZE, method: "random" });
    expect(response.body.documents).toHaveLength(LIVE_SAMPLE_DEFAULT_SIZE);
    const sampled = new Set(response.body.documents.map((text: string) => JSON.parse(text)._id));
    expect(sampled.size).toBe(LIVE_SAMPLE_DEFAULT_SIZE);
  });

  it("cap the size, and refuse sizes that are not whole numbers", async () => {
    const capped = await get(operator, live("sample"), { ns: MANY, size: "5000" });
    expect(capped.body.size).toBe(LIVE_SAMPLE_MAX_SIZE);
    expect(capped.body.documents).toHaveLength(LIVE_SAMPLE_MAX_SIZE);
    const small = await get(operator, live("sample"), { ns: PEOPLE, size: "3" });
    expect(small.body.documents).toHaveLength(3);
    for (const size of ["0", "abc", "1.5"]) {
      expect((await get(operator, live("sample"), { ns: PEOPLE, size })).status).toBe(400);
    }
  });

  it("sample the matching documents only", async () => {
    const response = await get(operator, live("sample"), {
      ns: PEOPLE,
      filter: '{"group": 1}',
      size: "100",
    });
    const groups = response.body.documents.map((text: string) => JSON.parse(text).group);
    expect(groups).toHaveLength(PEOPLE_COUNT / 3);
    expect(new Set(groups)).toEqual(new Set([1]));
  });

  it("refuse server-side JavaScript and internal namespaces", async () => {
    const where = await get(operator, live("sample"), { ns: PEOPLE, filter: '{"$where": "1"}' });
    expect(where.status).toBe(400);
    expect(where.body.error.message).toContain("$where");
    const internal = await get(operator, live("sample"), { ns: "admin.system.users" });
    expect(internal.status).toBe(400);
  });

  it("are audited as live.browse with sample: true, without the documents", async () => {
    const samples = (await auditOf("live.browse")).filter((entry) => entry.details.sample);
    // Newest first: the filtered sample, then the small one, the capped one, the default.
    expect(samples.map((entry) => entry.details.documents)).toEqual([
      PEOPLE_COUNT / 3,
      3,
      LIVE_SAMPLE_MAX_SIZE,
      LIVE_SAMPLE_DEFAULT_SIZE,
    ]);
    expect(samples[0]?.actor).toBe("olga");
    expect(samples[0]?.details).toEqual({
      connection: ids.connection,
      documents: PEOPLE_COUNT / 3,
      filtered: true,
      sample: true,
    });
  });
});

// ---------------------------------------------------------------------------
// Live exports
// ---------------------------------------------------------------------------

describe("live exports", () => {
  it("export JSON by default: one array, one document per line", async () => {
    const response = await get(operator, live("export"), { ns: PEOPLE, sort: '{"_id": 1}' });
    expect(response.status, response.text).toBe(200);
    expect(response.body).toMatchObject({
      filename: `${PEOPLE}.json`,
      contentType: "application/json;charset=utf-8",
      documents: PEOPLE_COUNT,
      truncated: false,
    });
    const lines = response.body.content.split("\n");
    expect(lines).toHaveLength(PEOPLE_COUNT + 2);
    expect(lines[0]).toBe("[");
    const parsed = JSON.parse(response.body.content);
    expect(parsed.map((document: { _id: number }) => document._id)).toEqual(
      Array.from({ length: PEOPLE_COUNT }, (_, index) => index),
    );
  });

  it("export JSON Lines with a filter, projection and sort", async () => {
    const response = await get(operator, live("export"), {
      ns: PEOPLE,
      format: "jsonl",
      filter: '{"group": 0}',
      projection: '{"name": 1}',
      sort: '{"_id": -1}',
    });
    expect(response.body.filename).toBe(`${PEOPLE}.jsonl`);
    const lines = response.body.content.trimEnd().split("\n").map(JSON.parse);
    expect(lines[0]).toEqual({ _id: 27, name: "person 27" });
    expect(lines).toHaveLength(PEOPLE_COUNT / 3);
  });

  it("export canonical Extended JSON when asked", async () => {
    const response = await get(operator, live("export"), {
      ns: CSV,
      format: "jsonl",
      ejson: "canonical",
      filter: '{"_id": 2}',
    });
    expect(response.body.content).toBe(
      '{"_id":{"$numberInt":"2"},"name":"Say \\"hi\\"","score":{"$numberDouble":"2.5"},"big":{"$numberLong":"9007199254740993"}}\n',
    );
  });

  it("export CSV: flattened paths, RFC 4180 quoting and the formula guard", async () => {
    const response = await get(operator, live("export"), {
      ns: CSV,
      format: "csv",
      sort: '{"_id": 1}',
    });
    expect(response.body).toMatchObject({
      filename: `${CSV}.csv`,
      contentType: "text/csv;charset=utf-8",
      documents: 2,
    });
    expect(response.body.content).toBe(
      "_id,name,address.city,tags,note,at,score,big\r\n" +
        `1,"Ada, Countess",London,"[""math"",""poetry""]",'=1+1,2026-01-02T03:04:05.000Z,,\r\n` +
        `2,"Say ""hi""",,,,,2.5,9007199254740993\r\n`,
    );
  });

  it("stop at the limit and say so", async () => {
    const limited = await get(operator, live("export"), {
      ns: PEOPLE,
      format: "jsonl",
      limit: "5",
    });
    expect(limited.body).toMatchObject({ documents: 5, truncated: true });
    const exact = await get(operator, live("export"), {
      ns: PEOPLE,
      limit: String(PEOPLE_COUNT),
    });
    expect(exact.body).toMatchObject({ documents: PEOPLE_COUNT, truncated: false });
    const defaults = await get(operator, live("export"), { ns: MANY, format: "jsonl" });
    expect(defaults.body).toMatchObject({ documents: EXPORT_DEFAULT_LIMIT, truncated: true });
  });

  it("refuse bad formats, limits, flavours and server-side JavaScript", async () => {
    for (const query of [
      { format: "xlsx" },
      { limit: "0" },
      { limit: "10001" },
      { ejson: "strict" },
      { filter: '{"$where": "1"}' },
      { sort: '{"_id": 2}' },
    ]) {
      const response = await get(operator, live("export"), { ns: PEOPLE, ...query });
      expect(response.status, JSON.stringify(query)).toBe(400);
    }
  });

  it("are audited as live.export with counts, never contents", async () => {
    const entries = await auditOf("live.export");
    expect(entries.find((entry) => entry.details.format === "csv")?.details).toEqual({
      connection: ids.connection,
      documents: 2,
      format: "csv",
      filtered: false,
      truncated: false,
    });
    expect(
      entries.some((entry) => entry.details.truncated === true && entry.details.documents === 5),
    ).toBe(true);
    expect(JSON.stringify(entries)).not.toContain("Countess");
  });
});

// ---------------------------------------------------------------------------
// Canonical Extended JSON in the document browsers
// ---------------------------------------------------------------------------

describe("ejson=canonical on the document browsers", () => {
  it("adds canonical text to live documents only when asked", async () => {
    const plain = await get(operator, live("documents"), { ns: CSV, filter: '{"_id": 2}' });
    expect(plain.body.documents[0].canonical).toBeUndefined();
    const canonical = await get(operator, live("documents"), {
      ns: CSV,
      filter: '{"_id": 2}',
      ejson: "canonical",
    });
    expect(canonical.status).toBe(200);
    const [document] = canonical.body.documents;
    expect(JSON.parse(document.canonical)).toMatchObject({ score: { $numberDouble: "2.5" } });
    expect(JSON.parse(document.json)).toMatchObject({ score: 2.5 });
    const bad = await get(operator, live("documents"), { ns: CSV, ejson: "nope" });
    expect(bad.status).toBe(400);
  });

  it("adds a parallel canonical array to backup pages only when asked", async () => {
    const plain = await get(operator, backup("documents"), { ns: CSV });
    expect(plain.status, plain.text).toBe(200);
    expect(plain.body.canonical).toBeUndefined();
    const canonical = await get(operator, backup("documents"), { ns: CSV, ejson: "canonical" });
    expect(canonical.body.canonical).toHaveLength(canonical.body.documents.length);
    expect(JSON.parse(canonical.body.canonical[1])).toMatchObject({
      _id: { $numberInt: "2" },
      score: { $numberDouble: "2.5" },
    });
    expect((await get(operator, backup("documents"), { ns: CSV, ejson: "x" })).status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// Backups
// ---------------------------------------------------------------------------

describe("backup samples and exports", () => {
  it("need the operator role", async () => {
    expect((await get(viewer, backup("sample"), { ns: PEOPLE })).status).toBe(403);
    expect((await get(viewer, backup("export"), { ns: PEOPLE })).status).toBe(403);
  });

  it("sample the first documents, with the same caps as live samples", async () => {
    const response = await get(operator, backup("sample"), { ns: MANY });
    expect(response.status, response.text).toBe(200);
    expect(response.body).toMatchObject({ size: LIVE_SAMPLE_DEFAULT_SIZE, method: "first" });
    expect(response.body.documents).toHaveLength(LIVE_SAMPLE_DEFAULT_SIZE);
    const capped = await get(operator, backup("sample"), { ns: MANY, size: "99999" });
    expect(capped.body.size).toBe(LIVE_SAMPLE_MAX_SIZE);
    expect(capped.body.documents).toHaveLength(LIVE_SAMPLE_MAX_SIZE);
    const filtered = await get(operator, backup("sample"), {
      ns: PEOPLE,
      filter: '{"group": 2}',
      size: "4",
    });
    expect(filtered.body.documents.map((text: string) => JSON.parse(text)._id)).toEqual([
      2, 5, 8, 11,
    ]);
    expect((await get(operator, backup("sample"), { ns: "" })).status).toBe(400);
  });

  it("export a backed-up collection as CSV, like the live export", async () => {
    const response = await get(operator, backup("export"), { ns: CSV, format: "csv" });
    expect(response.status, response.text).toBe(200);
    expect(response.body.filename).toBe(`${CSV}.${ids.backup}.csv`);
    expect(response.body.content).toContain(`'=1+1`);
    expect(response.body.content.split("\r\n")[0]).toBe(
      "_id,name,address.city,tags,note,at,score,big",
    );
  });

  it("export with a filter, a limit and canonical Extended JSON", async () => {
    const response = await get(operator, backup("export"), {
      ns: PEOPLE,
      format: "jsonl",
      ejson: "canonical",
      filter: '{"group": 0}',
      limit: "2",
    });
    expect(response.body).toMatchObject({ documents: 2, truncated: true });
    const [first] = response.body.content.split("\n");
    expect(JSON.parse(first)).toMatchObject({ _id: { $numberInt: "0" } });
  });

  it("are audited as backup.browse (sample) and backup.export", async () => {
    const [browse] = await auditOf("backup.browse");
    expect(browse?.details).toMatchObject({ storage: "extras-store", sample: true });
    const exports = await auditOf("backup.export");
    expect(exports[0]?.details).toEqual({
      storage: "extras-store",
      documents: 2,
      format: "jsonl",
      filtered: true,
      truncated: true,
    });
  });
});

// ---------------------------------------------------------------------------
// Cancellation
// ---------------------------------------------------------------------------

describe("cancelled requests", () => {
  it("stop the query and are not logged as errors", async () => {
    const logged = vi.spyOn(testConsole.services.logger, "error");
    const controller = new AbortController();
    controller.abort();
    const response = await testConsole.app.request(
      `${live("documents")}?${new URLSearchParams({ ns: PEOPLE })}`,
      { headers: { cookie: operator.cookieHeader ?? "" }, signal: controller.signal },
    );
    expect(response.status).toBe(409);
    expect((await response.json()).error.code).toBe("MS_ABORTED");
    expect(logged).not.toHaveBeenCalled();
    logged.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// Atlas Free/Flex, with a fake Atlas client
// ---------------------------------------------------------------------------

/** What the fake Atlas client records and how it answers. */
interface FakeAtlas {
  /** The client the console gets instead of a real one (set once built). */
  client: MongoClient;
  /** Every pipeline passed to `aggregate`. */
  readonly pipelines: Document[][];
  /** How many probe commands were sent. */
  probes: number;
}

/**
 * A fake client of an Atlas cluster at `cluster0.abcde.mongodb.net`. `collStats` is the
 * error `$collStats` fails with; `getParameter` is refused like a shared tier when
 * `shared`, answered otherwise. `$sample` answers through `sample` (so a test can hold
 * it open).
 */
function fakeAtlas(options: {
  readonly shared: boolean;
  readonly collStats: Error;
  readonly sample?: () => Promise<Document[]>;
}): FakeAtlas {
  const fake: FakeAtlas = { client: undefined as unknown as MongoClient, pipelines: [], probes: 0 };
  const collection = {
    // A refused count shows as 0 rather than failing the page.
    estimatedDocumentCount: async () => {
      throw new MongoServerError({ message: "refused", code: 8000, codeName: "AtlasError" });
    },
    aggregate: (pipeline: Document[]) => {
      fake.pipelines.push(pipeline);
      return {
        toArray: async () => {
          if (pipeline[0]?.$collStats !== undefined) throw options.collStats;
          return options.sample === undefined ? [] : options.sample();
        },
      };
    },
    listIndexes: () => ({ toArray: async () => [{ v: 2, key: { _id: 1 }, name: "_id_" }] }),
  } as unknown as Collection<Document>;
  const database = {
    listCollections: () => ({
      toArray: async () => [{ name: "people", type: "collection", options: {} }],
    }),
    collection: () => collection,
    command: async () => {
      fake.probes += 1;
      if (options.shared) {
        throw new MongoServerError({
          message: "getParameter is not allowed in this atlas tier",
          code: 8000,
          codeName: "AtlasError",
        });
      }
      return { ok: 1 };
    },
  };
  fake.client = {
    options: { srvHost: "cluster0.abcde.mongodb.net", hosts: [] },
    db: () => database,
  } as unknown as MongoClient;
  return fake;
}

/** Makes the console use `client` for the test connection until restored. */
function useClient(client: MongoClient) {
  return vi.spyOn(testConsole.services.live.clients, "clientFor").mockResolvedValue(client);
}

describe("Atlas Free and Flex clusters", () => {
  const atlasRefusal = () =>
    new MongoServerError({
      message: "$collStats is not allowed in this atlas tier",
      code: 8000,
      codeName: "AtlasError",
    });

  it("explain missing collection sizes instead of failing, and flag the shared tier", async () => {
    const fake = fakeAtlas({ shared: false, collStats: atlasRefusal() });
    const spy = useClient(fake.client);
    try {
      const response = await get(operator, live("collection"), { ns: PEOPLE });
      expect(response.status, response.text).toBe(200);
      expect(response.body).toMatchObject({
        statsUnavailable: ATLAS_STATS_UNAVAILABLE,
        sharedTier: true,
        estimatedDocuments: 0,
        indexes: [{ name: "_id_" }],
      });
      expect(response.body.sizeBytes).toBeUndefined();
      // One $collStats call, and no probe: the refusal itself proved the shared tier.
      expect(fake.pipelines.filter((pipeline) => pipeline[0]?.$collStats)).toHaveLength(1);
      expect(fake.probes).toBe(0);
    } finally {
      spy.mockRestore();
    }
  });

  it("blame privileges, not Atlas, for an Unauthorized $collStats on a dedicated cluster", async () => {
    const unauthorized = new MongoServerError({
      message: "not authorized",
      code: 13,
      codeName: "Unauthorized",
    });
    const fake = fakeAtlas({ shared: false, collStats: unauthorized });
    const spy = useClient(fake.client);
    try {
      const response = await get(operator, live("collection"), { ns: PEOPLE });
      expect(response.status).toBe(200);
      expect(response.body.statsUnavailable).toBe(PRIVILEGE_STATS_UNAVAILABLE);
      expect(response.body.sharedTier).toBeUndefined();
      expect(fake.probes).toBe(1);
    } finally {
      spy.mockRestore();
    }
  });

  it("sample fewer documents, one sample at a time, in arrival order", async () => {
    const releases: (() => void)[] = [];
    const fake = fakeAtlas({
      shared: true,
      collStats: atlasRefusal(),
      sample: () =>
        new Promise<Document[]>((resolve) => {
          releases.push(() => resolve([{ _id: releases.length }]));
        }),
    });
    const spy = useClient(fake.client);
    try {
      const first = get(operator, live("sample"), { ns: PEOPLE, size: "1000" });
      const second = get(operator, live("sample"), { ns: PEOPLE });
      // Only the first sample reaches the cluster while it runs.
      await vi.waitFor(() => expect(releases).toHaveLength(1));
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(releases).toHaveLength(1);
      releases[0]?.();
      await vi.waitFor(() => expect(releases).toHaveLength(2));
      releases[1]?.();
      const [firstResponse, secondResponse] = await Promise.all([first, second]);
      expect(firstResponse.status, firstResponse.text).toBe(200);
      expect(firstResponse.body.size).toBe(LIVE_SAMPLE_SHARED_TIER_MAX_SIZE);
      expect(secondResponse.status).toBe(200);
      expect(fake.pipelines[0]).toEqual([{ $sample: { size: LIVE_SAMPLE_SHARED_TIER_MAX_SIZE } }]);
      expect(fake.probes).toBe(1);
    } finally {
      spy.mockRestore();
    }
  });
});
