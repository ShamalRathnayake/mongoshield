// Unit tests for the AWS KMS adapter against a mocked `KMSClient`
// (aws-sdk-client-mock): request shapes, recorded key ids, error mapping and
// client ownership. No network.

import {
  DecryptCommand,
  EncryptCommand,
  KMSClient,
  KMSServiceException,
} from "@aws-sdk/client-kms";
import { mockClient } from "aws-sdk-client-mock";
import { describe, expect, it } from "vitest";
import { AWS_ALIAS, AWS_KEY, FakeKms, fakeAwsSdkClient } from "../../../test/helpers/fake-kms.ts";
import { isMongoShieldError, type MongoShieldError } from "../../errors.ts";
import {
  assertValidAwsKmsKey,
  classifyAwsError,
  createAwsKmsClient,
  regionOfAwsKey,
} from "./aws.ts";
import { KMS_DATA_KEY_CONTEXT } from "./types.ts";

const DATA_KEY = new Uint8Array(16).fill(7);

function rawClient(): KMSClient {
  return new KMSClient({
    region: "eu-west-1",
    credentials: { accessKeyId: "test", secretAccessKey: "test" },
  });
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

function serviceError(name: string): KMSServiceException {
  return new KMSServiceException({ name, $fault: "client", $metadata: {}, message: name });
}

describe("createAwsKmsClient", () => {
  it("encrypts with the key, the default algorithm and the MongoShield encryption context", async () => {
    const client = rawClient();
    const mock = mockClient(client);
    mock.on(EncryptCommand).resolves({ CiphertextBlob: new Uint8Array([1, 2, 3]), KeyId: AWS_KEY });
    const kms = createAwsKmsClient(AWS_KEY, { client });
    const wrapped = await kms.encryptDataKey(DATA_KEY);
    expect(wrapped).toEqual({
      key: AWS_KEY,
      algorithm: "SYMMETRIC_DEFAULT",
      ciphertext: new Uint8Array([1, 2, 3]),
    });
    expect(mock.commandCalls(EncryptCommand)[0]?.args[0].input).toEqual({
      KeyId: AWS_KEY,
      Plaintext: DATA_KEY,
      EncryptionAlgorithm: "SYMMETRIC_DEFAULT",
      EncryptionContext: KMS_DATA_KEY_CONTEXT.aws,
    });
  });

  it("records the key ARN AWS reports instead of an alias", async () => {
    const kms = createAwsKmsClient(AWS_ALIAS, { client: fakeAwsSdkClient(new FakeKms()) });
    expect((await kms.encryptDataKey(DATA_KEY)).key).toBe(AWS_KEY);
  });

  it("round-trips a data key and names the key when decrypting", async () => {
    const fake = new FakeKms();
    const client = fakeAwsSdkClient(fake);
    const kms = createAwsKmsClient(AWS_KEY, { client });
    const wrapped = await kms.encryptDataKey(DATA_KEY);
    expect(await kms.decryptDataKey(wrapped)).toEqual(Buffer.from(DATA_KEY));
  });

  it("uses RSA OAEP without an encryption context for asymmetric keys", async () => {
    const client = rawClient();
    const mock = mockClient(client);
    mock.on(EncryptCommand).resolves({ CiphertextBlob: new Uint8Array([9]), KeyId: AWS_KEY });
    mock.on(DecryptCommand).resolves({ Plaintext: DATA_KEY });
    const kms = createAwsKmsClient(AWS_KEY, { client, algorithm: "RSAES_OAEP_SHA_256" });
    const wrapped = await kms.encryptDataKey(DATA_KEY);
    expect(wrapped.algorithm).toBe("RSAES_OAEP_SHA_256");
    await kms.decryptDataKey(wrapped);
    const input = mock.commandCalls(DecryptCommand)[0]?.args[0].input;
    expect(input?.EncryptionAlgorithm).toBe("RSAES_OAEP_SHA_256");
    expect(input?.EncryptionContext).toBeUndefined();
  });

  it("maps AccessDenied on decrypt to MS_DECRYPTION_FAILED naming kms:Decrypt", async () => {
    const client = rawClient();
    mockClient(client).on(DecryptCommand).rejects(serviceError("AccessDeniedException"));
    const kms = createAwsKmsClient(AWS_KEY, { client });
    const error = await failure(
      kms.decryptDataKey({
        key: AWS_KEY,
        algorithm: "SYMMETRIC_DEFAULT",
        ciphertext: new Uint8Array([1]),
      }),
    );
    expect(error.code).toBe("MS_DECRYPTION_FAILED");
    expect(error.hint).toContain("kms:Decrypt");
    expect(error.message).toContain(AWS_KEY);
  });

  it("maps AccessDenied on encrypt to MS_ENCRYPTION_FAILED naming kms:Encrypt", async () => {
    const client = rawClient();
    mockClient(client).on(EncryptCommand).rejects(serviceError("AccessDeniedException"));
    const error = await failure(createAwsKmsClient(AWS_KEY, { client }).encryptDataKey(DATA_KEY));
    expect(error.code).toBe("MS_ENCRYPTION_FAILED");
    expect(error.hint).toContain("kms:Encrypt");
  });

  it("refuses an algorithm it does not know without calling AWS", async () => {
    const client = rawClient();
    const mock = mockClient(client);
    const error = await failure(
      createAwsKmsClient(AWS_KEY, { client }).decryptDataKey({
        key: AWS_KEY,
        algorithm: "SM2PKE",
        ciphertext: new Uint8Array([1]),
      }),
    );
    expect(error.code).toBe("MS_DECRYPTION_FAILED");
    expect(mock.calls()).toHaveLength(0);
  });

  it("treats responses without bytes as failures", async () => {
    const client = rawClient();
    const mock = mockClient(client);
    mock.on(EncryptCommand).resolves({});
    mock.on(DecryptCommand).resolves({});
    const kms = createAwsKmsClient(AWS_KEY, { client });
    expect((await failure(kms.encryptDataKey(DATA_KEY))).code).toBe("MS_ENCRYPTION_FAILED");
    const wrapped = {
      key: AWS_KEY,
      algorithm: "SYMMETRIC_DEFAULT",
      ciphertext: new Uint8Array([1]),
    };
    expect((await failure(kms.decryptDataKey(wrapped))).code).toBe("MS_DECRYPTION_FAILED");
  });

  it("never destroys a client it was given", async () => {
    const client = rawClient();
    let destroyed = false;
    client.destroy = () => {
      destroyed = true;
    };
    mockClient(client)
      .on(EncryptCommand)
      .resolves({ CiphertextBlob: new Uint8Array([1]) });
    const kms = createAwsKmsClient(AWS_KEY, { client });
    await kms.encryptDataKey(DATA_KEY);
    await kms.close?.();
    expect(destroyed).toBe(false);
  });

  it("passes the call's signal to the SDK as abortSignal", async () => {
    const client = rawClient();
    const mock = mockClient(client);
    mock.on(EncryptCommand).resolves({ CiphertextBlob: new Uint8Array([1]), KeyId: AWS_KEY });
    mock.on(DecryptCommand).resolves({ Plaintext: DATA_KEY });
    const kms = createAwsKmsClient(AWS_KEY, { client });
    const { signal } = new AbortController();
    const wrapped = await kms.encryptDataKey(DATA_KEY, { signal });
    await kms.decryptDataKey(wrapped, { signal });
    // aws-sdk-client-mock types `args` as just the command; the send options come second.
    expect(mock.commandCalls(EncryptCommand)[0]?.args).toEqual([
      expect.anything(),
      { abortSignal: signal },
    ]);
    expect(mock.commandCalls(DecryptCommand)[0]?.args).toEqual([
      expect.anything(),
      { abortSignal: signal },
    ]);
  });

  it("reports a cancelled call as MS_ABORTED, not as a KMS failure", async () => {
    const client = rawClient();
    const controller = new AbortController();
    mockClient(client)
      .on(EncryptCommand)
      .callsFake(() => {
        controller.abort();
        throw Object.assign(new Error("Request aborted"), { name: "AbortError" });
      });
    const kms = createAwsKmsClient(AWS_KEY, { client });
    const error = await failure(kms.encryptDataKey(DATA_KEY, { signal: controller.signal }));
    expect(error.code).toBe("MS_ABORTED");
  });

  it("sends nothing when the signal has already fired", async () => {
    const client = rawClient();
    const mock = mockClient(client);
    const kms = createAwsKmsClient(AWS_KEY, { client });
    const signal = AbortSignal.abort();
    expect((await failure(kms.encryptDataKey(DATA_KEY, { signal }))).code).toBe("MS_ABORTED");
    const wrapped = { key: AWS_KEY, algorithm: "SYMMETRIC_DEFAULT", ciphertext: DATA_KEY };
    expect((await failure(kms.decryptDataKey(wrapped, { signal }))).code).toBe("MS_ABORTED");
    expect(mock.calls()).toHaveLength(0);
  });

  it("creates nothing until the first call, so close() before use is a no-op", async () => {
    await expect(createAwsKmsClient(AWS_KEY).close?.()).resolves.toBeUndefined();
  });
});

describe("AWS key identifiers", () => {
  it.each([
    AWS_KEY,
    "arn:aws:kms:us-east-1:111122223333:alias/backups",
    "arn:aws-us-gov:kms:us-gov-west-1:111122223333:key/mrk-1234abcd12ab34cd56ef1234567890ab",
    "alias/backups",
    "1234abcd-12ab-34cd-56ef-1234567890ab",
    "mrk-1234abcd12ab34cd56ef1234567890ab",
  ])("accepts %s", (key) => {
    expect(() => assertValidAwsKmsKey(key)).not.toThrow();
  });

  it.each(["", "my key", "arn:aws:s3:::bucket", "https://kms.example.com/key", "alias/a b"])(
    "rejects %j",
    (key) => {
      expect(() => assertValidAwsKmsKey(key)).toThrow(
        expect.objectContaining({ code: "MS_CONFIG_INVALID" }),
      );
    },
  );

  it("takes the region from a key ARN", () => {
    expect(regionOfAwsKey(AWS_KEY)).toBe("eu-west-1");
    expect(regionOfAwsKey("alias/backups")).toBeUndefined();
  });
});

describe("classifyAwsError", () => {
  it.each([
    ["AccessDeniedException", "access-denied"],
    ["ExpiredTokenException", "access-denied"],
    ["NotFoundException", "not-found"],
    ["InvalidCiphertextException", "invalid-ciphertext"],
    ["IncorrectKeyException", "invalid-ciphertext"],
    ["DisabledException", "key-unusable"],
    ["ThrottlingException", "other"],
  ])("classifies %s as %s", (name, kind) => {
    expect(classifyAwsError(serviceError(name))).toBe(kind);
  });
});
