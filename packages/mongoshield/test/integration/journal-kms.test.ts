// A journal encrypted to a KMS key must never hang on a slow KMS when it is aborted:
// the writer passes its signal to the KMS call that wraps each segment's file key,
// and the reader passes its signal to the call that unwraps it.

import { afterAll, afterEach, describe, expect, it } from "vitest";
import { setKmsClientFactory } from "../../src/crypto/kms/registry.ts";
import type { KmsCallOptions, KmsClient } from "../../src/crypto/kms/types.ts";
import { abortError } from "../../src/errors.ts";
import {
  journalStatus,
  loadJournalCoverage,
  readJournalSegments,
} from "../../src/journal/index.ts";
import { memoryStorage } from "../../src/storage/memory.ts";
import { AWS_KEY, FakeKms, installFakeKms } from "../helpers/fake-kms.ts";
import { uniqueDb, useMongoClient } from "../helpers/mongo.ts";
import type { AnyDocument } from "./converge-test-utils.ts";
import { startTestJournal, waitFor, waitForJournalToCatchUp } from "./journal-test-utils.ts";

const client = useMongoClient();
const databases: string[] = [];
const restorers: (() => void)[] = [];

afterEach(() => {
  for (const restore of restorers.splice(0).reverse()) restore();
});

afterAll(async () => {
  for (const database of databases) await client().db(database).dropDatabase();
});

function newDatabase(): string {
  const name = uniqueDb("jkms");
  databases.push(name);
  return name;
}

/**
 * A KMS that never answers: its calls only end when their signal fires. A caller that
 * passes no signal would wait forever (and the test would time out).
 */
function slowKms(): { calls: () => number; cancelled: () => number } {
  let calls = 0;
  let cancelled = 0;
  const wait = (options?: KmsCallOptions): Promise<never> => {
    calls += 1;
    return new Promise((_resolve, reject) => {
      const signal = options?.signal;
      if (signal === undefined) return;
      const cancel = (): void => {
        cancelled += 1;
        reject(abortError(signal));
      };
      if (signal.aborted) cancel();
      else signal.addEventListener("abort", cancel, { once: true });
    });
  };
  const kmsClient: KmsClient = {
    provider: "aws",
    key: AWS_KEY,
    encryptDataKey: (_key, options) => wait(options),
    decryptDataKey: (_wrapped, options) => wait(options),
  };
  restorers.push(setKmsClientFactory("aws", async () => kmsClient));
  return { calls: () => calls, cancelled: () => cancelled };
}

const encryption = { kms: [{ provider: "aws" as const, key: AWS_KEY }] };

describe("journal KMS calls", () => {
  it("stops a writer that waits on a slow KMS when its signal fires", async () => {
    const kms = slowKms();
    const controller = new AbortController();
    const journal = await startTestJournal(client(), memoryStorage(), newDatabase(), {
      encryption,
      signal: controller.signal,
    });
    await waitFor(() => kms.calls() > 0, 30_000, "the first KMS call");
    controller.abort();
    await expect(journal.done).rejects.toMatchObject({ code: "MS_ABORTED" });
    // The KMS call itself was cancelled, not left waiting in the background.
    expect(kms.cancelled()).toBe(kms.calls());
  });

  it("stops a reader that waits on a slow KMS when its signal fires", async () => {
    const database = newDatabase();
    const storage = memoryStorage();
    restorers.push(installFakeKms(new FakeKms()));
    const journal = await startTestJournal(client(), storage, database, { encryption });
    try {
      await client().db(database).collection<AnyDocument>("items").insertOne({ _id: 1 });
      await waitForJournalToCatchUp(client(), storage);
    } finally {
      await journal.stop();
    }

    const kms = slowKms();
    const coverage = await loadJournalCoverage(storage);
    const first = coverage.segments[0];
    const to = (await journalStatus(storage)).recoveryPoint;
    if (first === undefined || to === undefined) throw new Error("no journal");
    const controller = new AbortController();
    const reading = (async () => {
      for await (const _event of readJournalSegments(storage, {
        from: first.from,
        to,
        coverage,
        signal: controller.signal,
      })) {
        // Draining; the first segment's KMS call never answers.
      }
    })();
    await waitFor(() => kms.calls() > 0, 30_000, "the reader's KMS call");
    controller.abort();
    await expect(reading).rejects.toMatchObject({ code: "MS_ABORTED" });
    expect(kms.cancelled()).toBe(kms.calls());
  });
});
