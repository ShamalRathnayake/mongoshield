/**
 * The benchmark dataset: four collections with the document shapes real
 * applications have, generated from a seeded pseudo-random generator so every run
 * (and every machine) gets byte-for-byte the same data.
 *
 *   users        ~1 KiB documents: names, e-mail, nested address with a GeoJSON
 *                point, tag arrays, a free-text bio, Decimal128 balance
 *   orders       ~1.5 KiB documents: ObjectId reference, 1–8 line items, prices
 *   events       ~250 B documents: the small, numerous "log" shape (UUIDs, numbers)
 *   attachments  ~512 KiB documents: the large-document case, half incompressible
 *                bytes (like images or already-compressed files), half text
 *
 * Text is built from a fixed English word list, so it compresses the way real text
 * does: random bytes would not compress at all, and repeated characters would
 * compress far better than anything real.
 */

import { Binary, Decimal128, type Document, type MongoClient, ObjectId } from "mongodb";

/** The database the benchmark seeds, backs up and restores from. */
export const BENCH_DATABASE = "mongoshield_bench";

/** Where restores go (dropped before every restore so each one starts empty). */
export const RESTORE_DATABASE = "mongoshield_bench_restored";

/** Size presets for `--scale`. Counts are documents per collection. */
export interface Scale {
  readonly users: number;
  readonly orders: number;
  readonly events: number;
  readonly attachments: number;
}

/**
 * The presets. `small`, `medium` and `large` are 100 thousand, 2 million and 5
 * million documents in total (about 75 MiB, 1.5 GiB and 3.7 GiB of BSON); `tiny`
 * only proves the harness works (CI) and its numbers mean nothing. The large
 * attachments are about a quarter of the bytes, so incompressible data is roughly an
 * eighth of the total: enough to matter, not enough to hide how the tools compress
 * ordinary documents.
 */
export const SCALES: Readonly<Record<string, Scale>> = {
  tiny: { users: 300, orders: 700, events: 996, attachments: 4 },
  small: { users: 15_000, orders: 35_000, events: 49_960, attachments: 40 },
  medium: { users: 300_000, orders: 700_000, events: 999_200, attachments: 800 },
  large: { users: 750_000, orders: 1_750_000, events: 2_498_000, attachments: 2_000 },
};

/** Average size of the large documents: 512 KiB. */
const ATTACHMENT_BYTES = 512 * 1024;

/** Documents per insertMany call; large documents go in smaller batches (16 MiB-ish). */
const BATCH_SIZE = 1_000;
const ATTACHMENT_BATCH_SIZE = 16;

/** insertMany calls in flight at once while seeding (keeps mongod busy). */
const SEED_CONCURRENCY = 4;

/** A fixed epoch so dates are reproducible too: 2026-01-01T00:00:00Z. */
const EPOCH_MS = Date.UTC(2026, 0, 1);

// ---------------------------------------------------------------------------
// Seeded randomness
// ---------------------------------------------------------------------------

/**
 * A small, fast, seeded pseudo-random generator (mulberry32). Not for security:
 * it only has to be reproducible and spread values evenly.
 */
export class Random {
  private state: number;

  constructor(seed: number) {
    // `>>> 0` keeps the state an unsigned 32-bit integer.
    this.state = seed >>> 0;
  }

  /** The next unsigned 32-bit integer. */
  nextUint32(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let mixed = this.state;
    mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return (mixed ^ (mixed >>> 14)) >>> 0;
  }

  /** A float in [0, 1). */
  next(): number {
    return this.nextUint32() / 4_294_967_296;
  }

  /** An integer in [min, max] (both inclusive). */
  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }

  /** One element of a non-empty list. */
  pick<T>(items: readonly T[]): T {
    return items[Math.floor(this.next() * items.length)] as T;
  }

  /** `length` incompressible bytes. */
  bytes(length: number): Uint8Array {
    // Filling 32 bits at a time is about four times faster than byte by byte.
    const words = new Uint32Array(Math.ceil(length / 4));
    for (let index = 0; index < words.length; index++) words[index] = this.nextUint32();
    return new Uint8Array(words.buffer, 0, length);
  }

  /** A sentence-like run of `wordCount` words from the word list. */
  words(wordCount: number): string {
    const parts: string[] = [];
    for (let index = 0; index < wordCount; index++) parts.push(this.pick(WORDS));
    return parts.join(" ");
  }

  /** Text of roughly `length` characters, in sentences. */
  text(length: number): string {
    let result = "";
    while (result.length < length) {
      const sentence = this.words(this.int(6, 18));
      result += `${sentence.charAt(0).toUpperCase()}${sentence.slice(1)}. `;
    }
    return result.slice(0, length);
  }

  /** A 12-byte ObjectId whose bytes come from this generator. */
  objectId(): ObjectId {
    return new ObjectId(this.bytes(12));
  }

  /** A UUID-subtype Binary (subtype 4) from this generator. */
  uuid(): Binary {
    return new Binary(this.bytes(16), Binary.SUBTYPE_UUID);
  }

  /** A date within `days` days after the fixed epoch. */
  date(days: number): Date {
    return new Date(EPOCH_MS + Math.floor(this.next() * days * 86_400_000));
  }
}

/** Common English words; text built from them compresses like real prose. */
const WORDS: readonly string[] = (
  "the of and to in is you that it he was for on are as with his they at be this have " +
  "from or one had by word but not what all were we when your can said there use an each " +
  "which she do how their if will up other about out many then them these so some her " +
  "would make like him into time has look two more write go see number no way could people " +
  "my than first water been call who oil its now find long down day did get come made may " +
  "part over new sound take only little work know place year live me back give most very " +
  "after thing our just name good sentence man think say great where help through much " +
  "before line right too mean old any same tell boy follow came want show also around form " +
  "three small set put end does another well large must big even such because turn here why " +
  "ask went men read need land different home us move try kind hand picture again change off " +
  "play spell air away animal house point page letter mother answer found study still learn " +
  "should america world high every near add food between own below country plant last school"
).split(" ");

const FIRST_NAMES = ["Ada", "Grace", "Linus", "Margaret", "Ken", "Barbara", "Alan", "Frances"];
const LAST_NAMES = ["Lovelace", "Hopper", "Torvalds", "Hamilton", "Thompson", "Liskov", "Turing"];
const CITIES = ["Colombo", "Kandy", "London", "Berlin", "Tokyo", "Toronto", "Nairobi", "Lima"];
const COUNTRIES = ["LK", "GB", "DE", "JP", "CA", "KE", "PE", "US"];
const TAGS = ["beta", "vip", "newsletter", "trial", "churn-risk", "partner", "staff", "eu"];
const ORDER_STATUSES = ["pending", "paid", "shipped", "delivered", "refunded", "cancelled"];
const EVENT_TYPES = ["page_view", "click", "login", "logout", "search", "purchase", "error"];
const CONTENT_TYPES = ["image/png", "application/pdf", "image/jpeg", "text/plain"];

// ---------------------------------------------------------------------------
// Document generators
// ---------------------------------------------------------------------------

/** A ~1 KiB user profile. `index` makes the e-mail unique. */
function userDocument(random: Random, index: number): Document {
  const first = random.pick(FIRST_NAMES);
  const last = random.pick(LAST_NAMES);
  return {
    _id: random.objectId(),
    name: { first, last },
    email: `${first}.${last}.${index}@example.com`.toLowerCase(),
    address: {
      street: `${random.int(1, 999)} ${random.words(2)} street`,
      city: random.pick(CITIES),
      country: random.pick(COUNTRIES),
      // GeoJSON point (longitude, latitude) for the 2dsphere index.
      location: { type: "Point", coordinates: [random.int(-180, 180), random.int(-85, 85)] },
    },
    tags: Array.from({ length: random.int(0, 4) }, () => random.pick(TAGS)),
    bio: random.text(random.int(300, 700)),
    preferences: { theme: random.pick(["light", "dark"]), emails: random.next() < 0.5 },
    loginCount: random.int(0, 5_000),
    balance: Decimal128.fromString((random.int(0, 10_000_000) / 100).toFixed(2)),
    createdAt: random.date(365),
  };
}

/** A ~1.5 KiB order with 1–8 line items. */
function orderDocument(random: Random): Document {
  const items = Array.from({ length: random.int(1, 8) }, () => ({
    sku: `SKU-${random.int(10_000, 99_999)}`,
    name: random.words(random.int(2, 5)),
    quantity: random.int(1, 10),
    price: Decimal128.fromString((random.int(100, 50_000) / 100).toFixed(2)),
  }));
  return {
    _id: random.objectId(),
    userId: random.objectId(),
    status: random.pick(ORDER_STATUSES),
    items,
    shipping: {
      city: random.pick(CITIES),
      country: random.pick(COUNTRIES),
      postcode: String(random.int(10_000, 99_999)),
    },
    notes: random.text(random.int(200, 600)),
    total: random.int(100, 400_000) / 100,
    createdAt: random.date(365),
  };
}

/** A ~250 B event (the small, numerous log/telemetry shape). */
function eventDocument(random: Random): Document {
  return {
    _id: random.objectId(),
    at: random.date(30),
    type: random.pick(EVENT_TYPES),
    userId: random.objectId(),
    sessionId: random.uuid(),
    durationMs: random.int(0, 30_000),
    value: random.next() * 1000,
    meta: { ip: `10.${random.int(0, 255)}.${random.int(0, 255)}.${random.int(0, 255)}` },
  };
}

/** A ~512 KiB attachment: half random bytes, half text. */
function attachmentDocument(random: Random, index: number): Document {
  // Vary the size ±50% around the average so the parts are not all the same size.
  const size = Math.floor(ATTACHMENT_BYTES * (0.5 + random.next()));
  const binaryBytes = Math.floor(size / 2);
  return {
    _id: random.objectId(),
    filename: `file-${index}.${random.pick(["png", "pdf", "jpg", "txt"])}`,
    contentType: random.pick(CONTENT_TYPES),
    data: new Binary(random.bytes(binaryBytes)),
    extractedText: random.text(size - binaryBytes),
    uploadedAt: random.date(365),
  };
}

// ---------------------------------------------------------------------------
// Collections and indexes
// ---------------------------------------------------------------------------

/** One collection of the dataset: how to make its documents and which indexes it has. */
interface CollectionPlan {
  readonly name: string;
  readonly count: number;
  readonly batchSize: number;
  readonly make: (random: Random, index: number) => Document;
  readonly indexes: readonly { readonly key: Document; readonly unique?: boolean }[];
}

/** The four collections for a scale, each with its own seed so they are independent. */
function plansFor(scale: Scale): readonly CollectionPlan[] {
  return [
    {
      name: "users",
      count: scale.users,
      batchSize: BATCH_SIZE,
      make: userDocument,
      indexes: [
        { key: { email: 1 }, unique: true },
        { key: { "address.location": "2dsphere" } },
        { key: { tags: 1 } },
      ],
    },
    {
      name: "orders",
      count: scale.orders,
      batchSize: BATCH_SIZE,
      make: (random) => orderDocument(random),
      indexes: [{ key: { userId: 1, createdAt: -1 } }, { key: { status: 1 } }],
    },
    {
      name: "events",
      count: scale.events,
      batchSize: BATCH_SIZE,
      make: (random) => eventDocument(random),
      indexes: [{ key: { at: 1 } }, { key: { type: 1, at: -1 } }],
    },
    {
      name: "attachments",
      count: scale.attachments,
      batchSize: ATTACHMENT_BATCH_SIZE,
      make: attachmentDocument,
      indexes: [{ key: { filename: 1 } }],
    },
  ];
}

/** What the seeded database looks like, for the results file and the restore check. */
export interface DatasetSummary {
  readonly collections: readonly {
    readonly name: string;
    readonly documents: number;
    /** Uncompressed BSON size (collStats `size`). */
    readonly dataBytes: number;
    /** Indexes including `_id`. */
    readonly indexes: number;
  }[];
  readonly totalDocuments: number;
  readonly totalDataBytes: number;
  /** WiredTiger's on-disk size of data + indexes (block-compressed with snappy). */
  readonly storageBytes: number;
  readonly indexBytes: number;
}

/**
 * Drops and re-creates the benchmark database at `scale`. Indexes are created after
 * the data (that is what a bulk load normally does, and it is faster).
 */
export async function seedDataset(
  client: MongoClient,
  scale: Scale,
  onProgress: (line: string) => void,
): Promise<DatasetSummary> {
  const database = client.db(BENCH_DATABASE);
  await database.dropDatabase();
  const plans = plansFor(scale);
  for (const [planIndex, plan] of plans.entries()) {
    const started = performance.now();
    // Seed = collection position + 1, so each collection has a fixed, distinct stream.
    const random = new Random(planIndex + 1);
    await insertAll(client, plan, random);
    for (const index of plan.indexes) {
      await database
        .collection(plan.name)
        .createIndex(index.key, index.unique === true ? { unique: true } : {});
    }
    const seconds = ((performance.now() - started) / 1000).toFixed(1);
    onProgress(`  ${plan.name}: ${plan.count.toLocaleString("en-US")} documents in ${seconds} s`);
  }
  return summarizeDatabase(client, BENCH_DATABASE);
}

/**
 * Inserts `plan.count` documents with up to SEED_CONCURRENCY insertMany calls in
 * flight. Documents are generated in order, so the data does not depend on timing.
 */
async function insertAll(client: MongoClient, plan: CollectionPlan, random: Random): Promise<void> {
  const collection = client.db(BENCH_DATABASE).collection(plan.name);
  const inFlight = new Set<Promise<unknown>>();
  for (let start = 0; start < plan.count; start += plan.batchSize) {
    const batch: Document[] = [];
    const end = Math.min(plan.count, start + plan.batchSize);
    for (let index = start; index < end; index++) batch.push(plan.make(random, index));
    const insert = collection.insertMany(batch, { ordered: false });
    inFlight.add(insert);
    void insert.finally(() => inFlight.delete(insert));
    // Wait for one call to finish before generating more, so memory stays bounded.
    if (inFlight.size >= SEED_CONCURRENCY) await Promise.race(inFlight);
  }
  await Promise.all(inFlight);
}

/** Document counts, sizes and index counts of every collection in `databaseName`. */
export async function summarizeDatabase(
  client: MongoClient,
  databaseName: string,
): Promise<DatasetSummary> {
  const database = client.db(databaseName);
  const names = (await database.listCollections({}, { nameOnly: true }).toArray())
    .map((entry) => entry.name)
    .sort();
  const collections = [];
  for (const name of names) {
    // $collStats is the supported replacement for the deprecated collStats command.
    const [stats] = await database
      .collection(name)
      .aggregate<{ storageStats: { count: number; size: number; nindexes: number } }>([
        { $collStats: { storageStats: {} } },
      ])
      .toArray();
    collections.push({
      name,
      documents: stats?.storageStats.count ?? 0,
      dataBytes: stats?.storageStats.size ?? 0,
      indexes: stats?.storageStats.nindexes ?? 0,
    });
  }
  const databaseStats = await database.command({ dbStats: 1 });
  return {
    collections,
    totalDocuments: collections.reduce((sum, entry) => sum + entry.documents, 0),
    totalDataBytes: collections.reduce((sum, entry) => sum + entry.dataBytes, 0),
    storageBytes: Number(databaseStats.storageSize ?? 0),
    indexBytes: Number(databaseStats.indexSize ?? 0),
  };
}

/**
 * Checks that a restored database has the same collections, document counts and
 * index counts as the source. Returns a description of the first difference, or
 * undefined when they match. (Byte sizes may differ slightly after a reload, so
 * they are not compared.)
 */
export function compareSummaries(
  source: DatasetSummary,
  restored: DatasetSummary,
): string | undefined {
  for (const expected of source.collections) {
    const actual = restored.collections.find((entry) => entry.name === expected.name);
    if (actual === undefined) return `collection ${expected.name} is missing`;
    if (actual.documents !== expected.documents) {
      return `${expected.name}: ${actual.documents} documents, expected ${expected.documents}`;
    }
    if (actual.indexes !== expected.indexes) {
      return `${expected.name}: ${actual.indexes} indexes, expected ${expected.indexes}`;
    }
  }
  return undefined;
}
