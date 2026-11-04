/**
 * Tests for the recovery kit: what is stored, where, and that it opens with the
 * passphrase (and with the plain age format), keeps every key across re-inits and
 * refuses weak or wrong passphrases.
 */

import { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { describe, expect, it } from "vitest";
import { isMongoShieldError } from "../errors.ts";
import { memoryStorage } from "../storage/memory.ts";
import { createDecryptStream } from "./decrypt.ts";
import { generateIdentity } from "./keys.ts";
import {
  hasRecoveryKit,
  RECOVERY_KIT_KEY,
  readRecoveryKit,
  writeRecoveryKit,
} from "./recovery-kit.ts";

const PASSPHRASE = "a long kit passphrase";
/** Low scrypt cost so the tests stay fast; the default is 18. */
const FAST = { scryptWorkFactor: 10 };

async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error("expected a rejection");
    },
    (error: unknown) => error,
  );
}

async function readAll(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk as Uint8Array));
  return Buffer.concat(chunks);
}

describe("recovery kit", () => {
  it("is stored at _state/recovery-kit.age", async () => {
    const storage = memoryStorage();
    expect(await hasRecoveryKit(storage)).toBe(false);
    const written = await writeRecoveryKit(storage, {
      identity: generateIdentity().identity,
      passphrase: PASSPHRASE,
      ...FAST,
    });
    expect(written).toEqual({ key: "_state/recovery-kit.age", identities: 1 });
    expect(RECOVERY_KIT_KEY).toBe("_state/recovery-kit.age");
    expect(await hasRecoveryKit(storage)).toBe(true);
  });

  it("returns the key with the passphrase, and nothing when there is no kit", async () => {
    const storage = memoryStorage();
    expect(await readRecoveryKit(storage, { passphrase: PASSPHRASE })).toBeUndefined();
    const { identity } = generateIdentity();
    await writeRecoveryKit(storage, { identity, passphrase: PASSPHRASE, ...FAST });
    expect(await readRecoveryKit(storage, { passphrase: PASSPHRASE })).toEqual([identity]);
  });

  it("is a plain age file whose plaintext is an age identity file", async () => {
    const storage = memoryStorage();
    const key = generateIdentity();
    await writeRecoveryKit(storage, { identity: key.identity, passphrase: PASSPHRASE, ...FAST });
    const encrypted = await readAll(await storage.get(RECOVERY_KIT_KEY));
    expect(encrypted.subarray(0, 21).toString()).toBe("age-encryption.org/v1");
    expect(encrypted.toString("latin1")).toContain("-> scrypt ");
    expect(encrypted.toString("latin1")).not.toContain(key.identity);

    const chunks: Buffer[] = [];
    await pipeline(
      Readable.from([encrypted]),
      createDecryptStream({ passphrase: PASSPHRASE }),
      new Writable({
        write(chunk: Buffer, _encoding, done) {
          chunks.push(chunk);
          done();
        },
      }),
    );
    const text = Buffer.concat(chunks).toString();
    expect(text).toContain(`# public key: ${key.recipient}`);
    expect(text).toContain(`\n${key.identity}\n`);
  });

  it("keeps the earlier keys when a second key is added", async () => {
    const storage = memoryStorage();
    const first = generateIdentity().identity;
    const second = generateIdentity().identity;
    await writeRecoveryKit(storage, { identity: first, passphrase: PASSPHRASE, ...FAST });
    const written = await writeRecoveryKit(storage, {
      identity: second,
      passphrase: PASSPHRASE,
      ...FAST,
    });
    expect(written.identities).toBe(2);
    expect(await readRecoveryKit(storage, { passphrase: PASSPHRASE })).toEqual([first, second]);
  });

  it("does not add a key twice", async () => {
    const storage = memoryStorage();
    const { identity } = generateIdentity();
    await writeRecoveryKit(storage, { identity, passphrase: PASSPHRASE, ...FAST });
    expect(
      (await writeRecoveryKit(storage, { identity, passphrase: PASSPHRASE, ...FAST })).identities,
    ).toBe(1);
  });

  it("refuses to extend a kit with a different passphrase, and leaves it as it was", async () => {
    const storage = memoryStorage();
    const first = generateIdentity().identity;
    await writeRecoveryKit(storage, { identity: first, passphrase: PASSPHRASE, ...FAST });
    const error = await rejectionOf(
      writeRecoveryKit(storage, {
        identity: generateIdentity().identity,
        passphrase: "another passphrase entirely",
        ...FAST,
      }),
    );
    expect(isMongoShieldError(error, "MS_DECRYPTION_FAILED")).toBe(true);
    expect((error as { hint?: string }).hint).toMatch(/existing kit/);
    expect(await readRecoveryKit(storage, { passphrase: PASSPHRASE })).toEqual([first]);
  });

  it("fails with MS_DECRYPTION_FAILED for a wrong passphrase, without echoing it", async () => {
    const storage = memoryStorage();
    await writeRecoveryKit(storage, {
      identity: generateIdentity().identity,
      passphrase: PASSPHRASE,
      ...FAST,
    });
    const wrong = "wrong passphrase here";
    const error = await rejectionOf(readRecoveryKit(storage, { passphrase: wrong }));
    expect(isMongoShieldError(error, "MS_DECRYPTION_FAILED")).toBe(true);
    expect(String(error)).not.toContain(wrong);
  });

  it("refuses passphrases shorter than 12 characters", async () => {
    const error = await rejectionOf(
      writeRecoveryKit(memoryStorage(), {
        identity: generateIdentity().identity,
        passphrase: "short",
        ...FAST,
      }),
    );
    expect(isMongoShieldError(error, "MS_CONFIG_INVALID")).toBe(true);
  });

  it("refuses an invalid identity", async () => {
    const error = await rejectionOf(
      writeRecoveryKit(memoryStorage(), { identity: "not-a-key", passphrase: PASSPHRASE, ...FAST }),
    );
    expect(isMongoShieldError(error, "MS_CONFIG_INVALID")).toBe(true);
  });
});
