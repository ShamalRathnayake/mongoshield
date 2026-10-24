/**
 * Unit tests for the JOSE helpers: parsing compact JWS, importing JWKs and
 * checking signatures for RS256, ES256 and EdDSA with node:crypto.
 */

import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  decodeJws,
  importJwk,
  isSupportedAlgorithm,
  JoseError,
  keyFitsAlgorithm,
  verifyJws,
} from "./jose.ts";

/** A signed compact JWS over `payload` with `key`. */
function signed(
  alg: string,
  privateKey: Parameters<typeof sign>[2],
  payload: object = { sub: "1" },
  digest: string | null = "sha256",
): string {
  const header = Buffer.from(JSON.stringify({ alg })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = sign(digest, Buffer.from(`${header}.${body}`), privateKey);
  return `${header}.${body}.${signature.toString("base64url")}`;
}

const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
const ec = generateKeyPairSync("ec", { namedCurve: "P-256" });
const ed = generateKeyPairSync("ed25519");

describe("decodeJws", () => {
  it("parses header, payload and the signed bytes", () => {
    const token = signed("RS256", rsa.privateKey, { sub: "abc" });
    const jws = decodeJws(token);
    expect(jws.header).toEqual({ alg: "RS256" });
    expect(jws.payload).toEqual({ sub: "abc" });
    expect(jws.signingInput.toString()).toBe(token.split(".").slice(0, 2).join("."));
  });

  it.each([
    ["two parts", "a.b"],
    ["five parts (JWE)", "a.b.c.d.e"],
    ["non-base64url characters", "a+b.c.d"],
    ["a non-JSON header", `${Buffer.from("nope").toString("base64url")}.e30.AA`],
    ["an array payload", `e30.${Buffer.from("[1]").toString("base64url")}.AA`],
    ["an over-long token", `e30.${"A".repeat(17 * 1024)}.AA`],
  ])("refuses %s", (_name, token) => {
    expect(() => decodeJws(token)).toThrow(JoseError);
  });
});

describe("importJwk", () => {
  it("imports public RSA, EC and OKP keys with their kid and alg", () => {
    const jwk = { ...rsa.publicKey.export({ format: "jwk" }), kid: "k1", alg: "RS256", use: "sig" };
    const imported = importJwk(jwk);
    expect(imported.keyId).toBe("k1");
    expect(imported.algorithm).toBe("RS256");
    expect(imported.key.asymmetricKeyType).toBe("rsa");
    expect(importJwk({ ...ec.publicKey.export({ format: "jwk" }) }).keyId).toBeUndefined();
    expect(
      importJwk({ ...ed.publicKey.export({ format: "jwk" }), key_ops: ["verify"] }).key.type,
    ).toBe("public");
  });

  it("uses only the public members of a JWK that also has private ones", () => {
    const imported = importJwk({ ...ec.privateKey.export({ format: "jwk" }) });
    expect(imported.key.type).toBe("public");
  });

  it.each([
    ["encryption keys", { ...rsa.publicKey.export({ format: "jwk" }), use: "enc" }],
    [
      "keys not allowed to verify",
      { ...rsa.publicKey.export({ format: "jwk" }), key_ops: ["encrypt"] },
    ],
    ["symmetric keys", { kty: "oct", k: "c2VjcmV0" }],
    ["incomplete keys", { kty: "RSA", e: "AQAB" }],
  ])("refuses %s", (_name, jwk) => {
    expect(() => importJwk(jwk)).toThrow(JoseError);
  });
});

describe("verifyJws", () => {
  it("verifies RS256, ES256 and EdDSA signatures", () => {
    expect(verifyJws(decodeJws(signed("RS256", rsa.privateKey)), "RS256", rsa.publicKey)).toBe(
      true,
    );
    const es = signed("ES256", { key: ec.privateKey, dsaEncoding: "ieee-p1363" });
    expect(verifyJws(decodeJws(es), "ES256", ec.publicKey)).toBe(true);
    expect(
      verifyJws(decodeJws(signed("EdDSA", ed.privateKey, {}, null)), "EdDSA", ed.publicKey),
    ).toBe(true);
  });

  it("refuses a wrong key, a key of the wrong type and a DER-encoded ECDSA signature", () => {
    const other = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const token = decodeJws(signed("RS256", rsa.privateKey));
    expect(verifyJws(token, "RS256", other.publicKey)).toBe(false);
    expect(verifyJws(token, "ES256", ec.publicKey)).toBe(false);
    expect(verifyJws(token, "EdDSA", rsa.publicKey)).toBe(false);
    // DER signatures are ~70 bytes: JWS requires the fixed 64-byte r || s form.
    const der = decodeJws(signed("ES256", ec.privateKey));
    expect(verifyJws(der, "ES256", ec.publicKey)).toBe(false);
  });

  it("refuses RSA keys shorter than 2048 bits", () => {
    const weak = generateKeyPairSync("rsa", { modulusLength: 1024 });
    expect(keyFitsAlgorithm(weak.publicKey, "RS256")).toBe(false);
    expect(verifyJws(decodeJws(signed("RS256", weak.privateKey)), "RS256", weak.publicKey)).toBe(
      false,
    );
  });

  it("refuses EC keys on other curves", () => {
    const p384 = generateKeyPairSync("ec", { namedCurve: "P-384" });
    expect(keyFitsAlgorithm(p384.publicKey, "ES256")).toBe(false);
  });

  it("knows exactly which algorithms it supports", () => {
    expect(["RS256", "ES256", "EdDSA"].every(isSupportedAlgorithm)).toBe(true);
    expect(["none", "HS256", "RS512", "PS256", undefined].some(isSupportedAlgorithm)).toBe(false);
  });
});
