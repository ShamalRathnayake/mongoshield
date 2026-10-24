// Unit tests for the `mongoshield-kms` stanza and the custom-stanza hooks of the age
// encrypt/decrypt streams: round trips through a fake KMS, coexistence with X25519
// recipients (unknown stanzas ignored), failure handling and strict parsing.

import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AWS_KEY,
  AZURE_KEY,
  FakeKms,
  GCP_KEY,
  installFakeKms,
} from "../../../test/helpers/fake-kms.ts";
import { isMongoShieldError, type MongoShieldError } from "../../errors.ts";
import type { KmsKeyRef } from "../../types.ts";
import { readStreamToBuffer } from "../../util/streams.ts";
import { createDecryptStream, type DecryptStreamOptions } from "../decrypt.ts";
import { createEncryptStream, type EncryptStreamOptions } from "../encrypt.ts";
import { encodeHeader, findHeaderEnd, parseHeader, type Stanza } from "../header.ts";
import { generateIdentity } from "../keys.ts";
import { resolveKmsClient } from "./registry.ts";
import {
  createKmsKeyUnwrapper,
  createKmsKeyWrapper,
  decodeKeyId,
  describeKmsStanza,
  encodeKeyId,
  KMS_STANZA_TYPE,
  type KmsClientResolver,
} from "./stanza.ts";

const PLAINTEXT = Buffer.from("the backup's own identity would be here\n");

let kms: FakeKms;
let uninstall: () => void;

beforeEach(() => {
  kms = new FakeKms();
  uninstall = installFakeKms(kms);
});

afterEach(() => uninstall());

async function encrypt(options: EncryptStreamOptions, plaintext = PLAINTEXT): Promise<Buffer> {
  return readStreamToBuffer(Readable.from([plaintext]).pipe(createEncryptStream(options)), {
    maxBytes: 1024 * 1024,
  });
}

async function decrypt(file: Buffer, options: DecryptStreamOptions): Promise<Buffer> {
  const chunks: Buffer[] = [];
  await pipeline(Readable.from([file]), createDecryptStream(options), async (source) => {
    for await (const chunk of source) chunks.push(chunk as Buffer);
  });
  return Buffer.concat(chunks);
}

async function failure(promise: Promise<unknown>): Promise<MongoShieldError> {
  const error = await promise.then(
    () => undefined,
    (caught: unknown) => caught,
  );
  if (!isMongoShieldError(error))
    throw new Error(`expected a MongoShieldError, got ${String(error)}`);
  return error;
}

function stanzasOf(file: Buffer): readonly Stanza[] {
  const end = findHeaderEnd(file);
  if (end === undefined) throw new Error("no header");
  return parseHeader(file.subarray(0, end)).stanzas;
}

const wrappers = (...refs: KmsKeyRef[]) => refs.map((ref) => createKmsKeyWrapper(ref));
const kmsOnly: DecryptStreamOptions = { keyUnwrappers: [createKmsKeyUnwrapper()] };

describe("the mongoshield-kms stanza", () => {
  it.each([
    ["aws", AWS_KEY, "SYMMETRIC_DEFAULT"],
    ["gcp", GCP_KEY, "GOOGLE_SYMMETRIC_ENCRYPTION"],
    ["azure", AZURE_KEY, "RSA-OAEP-256"],
  ] as const)("round-trips a file through %s", async (provider, key, algorithm) => {
    const file = await encrypt({ keyWrappers: wrappers({ provider, key }) });
    const [stanza] = stanzasOf(file);
    expect(stanza?.args[0]).toBe(KMS_STANZA_TYPE);
    expect(stanza?.args[1]).toBe(provider);
    expect(stanza?.args[3]).toBe(algorithm);
    expect(await decrypt(file, kmsOnly)).toEqual(PLAINTEXT);
    expect(kms.calls.map((call) => call.operation)).toEqual(["encrypt", "decrypt"]);
  });

  it("records the key the KMS reports: Azure's versioned key URL", async () => {
    const file = await encrypt({ keyWrappers: wrappers({ provider: "azure", key: AZURE_KEY }) });
    const ref = describeKmsStanza(stanzasOf(file)[0] ?? { args: [], body: Buffer.alloc(0) });
    expect(ref).toEqual({ provider: "azure", key: `${AZURE_KEY}/0123456789abcdef` });
  });

  it("puts every KMS key in its own stanza after the X25519 stanzas", async () => {
    const recovery = generateIdentity();
    const file = await encrypt({
      recipients: [recovery.recipient],
      keyWrappers: wrappers({ provider: "aws", key: AWS_KEY }, { provider: "gcp", key: GCP_KEY }),
    });
    const stanzas = stanzasOf(file);
    expect(stanzas.map((stanza) => stanza.args[0])).toEqual([
      "X25519",
      KMS_STANZA_TYPE,
      KMS_STANZA_TYPE,
    ]);
    expect(stanzas.map((stanza) => stanza.args[1]).slice(1)).toEqual(["aws", "gcp"]);
  });

  it("is ignored when decrypting with an identity, as the age spec requires", async () => {
    const recovery = generateIdentity();
    const file = await encrypt({
      recipients: [recovery.recipient],
      keyWrappers: wrappers({ provider: "aws", key: AWS_KEY }),
    });
    kms.calls.length = 0;
    expect(await decrypt(file, { identities: [recovery.identity] })).toEqual(PLAINTEXT);
    expect(kms.calls).toEqual([]);
  });

  it("prefers a local identity over a KMS call when both could open the file", async () => {
    const recovery = generateIdentity();
    const file = await encrypt({
      recipients: [recovery.recipient],
      keyWrappers: wrappers({ provider: "aws", key: AWS_KEY }),
    });
    kms.calls.length = 0;
    const options = { identities: [recovery.identity], ...kmsOnly };
    expect(await decrypt(file, options)).toEqual(PLAINTEXT);
    expect(kms.calls).toEqual([]);
  });

  it("falls back to another KMS key when access to the first is denied", async () => {
    const file = await encrypt({
      keyWrappers: wrappers({ provider: "aws", key: AWS_KEY }, { provider: "gcp", key: GCP_KEY }),
    });
    kms.denied.add(AWS_KEY);
    expect(await decrypt(file, kmsOnly)).toEqual(PLAINTEXT);
  });

  it("reports access denied with the missing permission when no stanza opens", async () => {
    const file = await encrypt({ keyWrappers: wrappers({ provider: "aws", key: AWS_KEY }) });
    kms.denied.add(AWS_KEY);
    const error = await failure(decrypt(file, kmsOnly));
    expect(error.code).toBe("MS_DECRYPTION_FAILED");
    expect(error.hint).toContain("kms:Decrypt");
    expect(error.details).toMatchObject({
      provider: "aws",
      kmsFailure: "access-denied",
      stage: "unwrap",
    });
  });

  it("fails encryption with MS_ENCRYPTION_FAILED naming the encrypt permission", async () => {
    kms.denied.add(GCP_KEY);
    const error = await failure(
      encrypt({ keyWrappers: wrappers({ provider: "gcp", key: GCP_KEY }) }),
    );
    expect(error.code).toBe("MS_ENCRYPTION_FAILED");
    expect(error.hint).toContain("cloudkms.cryptoKeyVersions.useToEncrypt");
  });

  it("detects a modified header through the MAC, even when the KMS opens the stanza", async () => {
    const file = await encrypt({ keyWrappers: wrappers({ provider: "aws", key: AWS_KEY }) });
    const end = findHeaderEnd(file) ?? 0;
    const [stanza] = stanzasOf(file);
    if (stanza === undefined) throw new Error("no stanza");
    // Same stanza plus a foreign one: the file key still unwraps, the MAC does not match.
    const extra: Stanza = { args: ["other-tool", "x"], body: Buffer.from("y") };
    const forgedHeader = encodeHeader([stanza, extra], Buffer.alloc(16));
    const forged = Buffer.concat([forgedHeader, file.subarray(end)]);
    const error = await failure(decrypt(forged, kmsOnly));
    expect(error.details?.stage).toBe("mac");
  });

  it("rejects a modified KMS ciphertext through the KMS", async () => {
    const file = await encrypt({ keyWrappers: wrappers({ provider: "aws", key: AWS_KEY }) });
    const [stanza] = stanzasOf(file);
    if (stanza === undefined) throw new Error("no stanza");
    const body = Buffer.from(stanza.body);
    body[20] = (body[20] ?? 0) ^ 1;
    const header = encodeHeader([{ args: stanza.args, body }], Buffer.alloc(16));
    const forged = Buffer.concat([header, file.subarray(findHeaderEnd(file) ?? 0)]);
    const error = await failure(decrypt(forged, kmsOnly));
    expect(error.code).toBe("MS_DECRYPTION_FAILED");
    expect(error.details?.kmsFailure).toBe("invalid-ciphertext");
  });

  it.each([
    ["too few arguments", [KMS_STANZA_TYPE, "aws", encodeKeyId(AWS_KEY)]],
    ["an unknown provider", [KMS_STANZA_TYPE, "ibm", encodeKeyId(AWS_KEY), "X"]],
    ["a padded key id", [KMS_STANZA_TYPE, "aws", `${encodeKeyId(AWS_KEY)}=`, "X"]],
    ["a key id of the wrong shape", [KMS_STANZA_TYPE, "aws", encodeKeyId("evil"), "X"]],
    [
      "an Azure key on a foreign host",
      [KMS_STANZA_TYPE, "azure", encodeKeyId("https://evil.example.com/keys/k"), "RSA-OAEP-256"],
    ],
    ["extra arguments", [KMS_STANZA_TYPE, "aws", encodeKeyId(AWS_KEY), "X", "Y"]],
  ])("refuses a stanza with %s before calling any KMS", async (_name, args) => {
    const header = encodeHeader([{ args, body: Buffer.from("ciphertext") }], Buffer.alloc(16));
    const file = Buffer.concat([header, Buffer.alloc(16), Buffer.alloc(16)]);
    const error = await failure(decrypt(file, kmsOnly));
    expect(error).toMatchObject({ code: "MS_DECRYPTION_FAILED", details: { stage: "header" } });
    expect(kms.calls).toEqual([]);
  });

  it("reports MS_NO_IDENTITY when the file has no stanza any key can open", async () => {
    const file = await encrypt({ recipients: [generateIdentity().recipient] });
    const error = await failure(decrypt(file, kmsOnly));
    expect(error.code).toBe("MS_NO_IDENTITY");
  });

  it("cannot be combined with a passphrase", () => {
    expect(() =>
      createEncryptStream({
        passphrase: "p",
        keyWrappers: wrappers({ provider: "aws", key: AWS_KEY }),
      }),
    ).toThrow(expect.objectContaining({ code: "MS_CONFIG_INVALID" }));
  });

  it("refuses an unwrapper result that is not a 16-byte file key", async () => {
    const file = await encrypt({ keyWrappers: wrappers({ provider: "aws", key: AWS_KEY }) });
    const error = await failure(decrypt(file, { keyUnwrappers: [async () => Buffer.alloc(8)] }));
    expect(error.details?.stage).toBe("header");
  });
});

describe("cancellation of KMS calls", () => {
  /** A resolver whose client records the options of every call. */
  function recordingResolver(seen: unknown[]): KmsClientResolver {
    return async (ref) => {
      const real = await resolveKmsClient(ref);
      return {
        provider: real.provider,
        key: real.key,
        encryptDataKey: (dataKey, options) => {
          seen.push(options);
          return real.encryptDataKey(dataKey, options);
        },
        decryptDataKey: (wrapped, options) => {
          seen.push(options);
          return real.decryptDataKey(wrapped, options);
        },
      };
    };
  }

  it("passes the wrapper's and unwrapper's signal to the KMS client", async () => {
    const seen: unknown[] = [];
    const resolve = recordingResolver(seen);
    const { signal } = new AbortController();
    const ref: KmsKeyRef = { provider: "aws", key: AWS_KEY };
    const file = await encrypt({ keyWrappers: [createKmsKeyWrapper(ref, resolve, { signal })] });
    await decrypt(file, { keyUnwrappers: [createKmsKeyUnwrapper(resolve, { signal })] });
    expect(seen).toEqual([{ signal }, { signal }]);
  });

  it("passes no options at all without a signal, as before signals existed", async () => {
    const seen: unknown[] = [];
    const resolve = recordingResolver(seen);
    const ref: KmsKeyRef = { provider: "gcp", key: GCP_KEY };
    const file = await encrypt({ keyWrappers: [createKmsKeyWrapper(ref, resolve)] });
    await decrypt(file, { keyUnwrappers: [createKmsKeyUnwrapper(resolve)] });
    expect(seen).toEqual([{}, {}]);
  });

  it("fails encryption with MS_ABORTED when the signal has fired", async () => {
    const ref: KmsKeyRef = { provider: "azure", key: AZURE_KEY };
    const wrapper = createKmsKeyWrapper(ref, resolveKmsClient, { signal: AbortSignal.abort() });
    const error = await failure(encrypt({ keyWrappers: [wrapper] }));
    expect(error.code).toBe("MS_ABORTED");
    expect(kms.calls).toEqual([]);
  });
});

describe("key id encoding", () => {
  it("round-trips identifiers as unpadded base64url", () => {
    for (const key of [AWS_KEY, GCP_KEY, AZURE_KEY]) {
      const encoded = encodeKeyId(key);
      expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(decodeKeyId(encoded)).toBe(key);
    }
  });

  it.each([
    ["empty", ""],
    ["a lone character", "a"],
    ["padded", "YQ=="],
    ["standard base64 characters", "a+b/"],
    ["non-zero trailing bits", "AR"],
  ])("rejects %s input", (_name, encoded) => {
    expect(decodeKeyId(encoded)).toBeUndefined();
  });
});
