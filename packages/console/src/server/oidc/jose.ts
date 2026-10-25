/**
 * The small part of JOSE the console needs to verify OIDC ID tokens, built on
 * `node:crypto` only (no dependency):
 *
 *   decodeJws        splits a compact JWS (`header.payload.signature`) and parses it
 *   importJwk        turns one public JWK from the provider's JWKS into a KeyObject
 *   verifyJws        checks the signature with a key, for the algorithms below
 *
 * Supported algorithms (RFC 7518 / RFC 8037):
 *
 *   RS256   RSASSA-PKCS1-v1_5 with SHA-256, RSA keys of at least 2048 bits
 *   ES256   ECDSA on P-256 with SHA-256; the JWS signature is r || s (64 bytes),
 *           which node calls `dsaEncoding: "ieee-p1363"`
 *   EdDSA   Ed25519 (the only EdDSA curve providers use for tokens)
 *
 * Everything else is refused, in particular `none` (unsigned tokens) and the
 * HMAC algorithms `HS*`: with those, a token "signed" with the provider's public
 * key as an HMAC secret would verify (the classic algorithm-confusion attack).
 * The algorithm must also fit the key type, for the same reason.
 */

import { createPublicKey, type JsonWebKey, type KeyObject, verify } from "node:crypto";

/** Algorithms the console accepts for ID tokens. */
export const SUPPORTED_ALGORITHMS = ["RS256", "ES256", "EdDSA"] as const;

/** One of {@link SUPPORTED_ALGORITHMS}. */
export type SupportedAlgorithm = (typeof SUPPORTED_ALGORITHMS)[number];

/** Smallest RSA modulus accepted (NIST SP 800-57: 2048 bits). */
const MIN_RSA_BITS = 2048;

/** Longest token accepted. Real ID tokens are a few KiB; this caps parsing work. */
const MAX_TOKEN_LENGTH = 16 * 1024;

/** Why a token or key was refused. The message is safe to log (no token content). */
export class JoseError extends Error {
  override readonly name = "JoseError";
}

/** A parsed compact JWS. */
export interface DecodedJws {
  readonly header: Readonly<Record<string, unknown>>;
  readonly payload: Readonly<Record<string, unknown>>;
  /** `base64url(header) + "." + base64url(payload)`: the bytes that were signed. */
  readonly signingInput: Buffer;
  readonly signature: Buffer;
}

/** A provider key with what the JWKS says about it. */
export interface PublicJwk {
  readonly key: KeyObject;
  /** `kid`, when the JWKS gives one. */
  readonly keyId: string | undefined;
  /** `alg`, when the JWKS pins the key to one algorithm. */
  readonly algorithm: string | undefined;
}

/** True when `value` is one of the supported algorithms. */
export function isSupportedAlgorithm(value: unknown): value is SupportedAlgorithm {
  return SUPPORTED_ALGORITHMS.some((algorithm) => algorithm === value);
}

/**
 * Splits and parses a compact JWS. Only checks the structure; the signature is
 * checked by {@link verifyJws}.
 *
 * @throws JoseError for anything that is not a three-part JWS with JSON objects.
 */
export function decodeJws(token: string): DecodedJws {
  if (token.length > MAX_TOKEN_LENGTH) throw new JoseError("The token is too long.");
  const parts = token.split(".");
  // Five parts would be an encrypted token (JWE), which the console never asks for.
  if (parts.length !== 3) throw new JoseError("The token is not a signed JWT (JWS).");
  const [header = "", payload = "", signature = ""] = parts;
  if (![header, payload, signature].every(isBase64Url)) {
    throw new JoseError("The token is not base64url encoded.");
  }
  return {
    header: parseJsonObject(header, "header"),
    payload: parseJsonObject(payload, "payload"),
    signingInput: Buffer.from(`${header}.${payload}`, "ascii"),
    signature: Buffer.from(signature, "base64url"),
  };
}

/** Base64url without padding, as JWS uses (RFC 7515 §2). */
function isBase64Url(value: string): boolean {
  return /^[A-Za-z0-9_-]*$/.test(value);
}

function parseJsonObject(part: string, what: string): Readonly<Record<string, unknown>> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
  } catch {
    throw new JoseError(`The token ${what} is not JSON.`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new JoseError(`The token ${what} is not a JSON object.`);
  }
  return Object.fromEntries(Object.entries(parsed));
}

/**
 * Imports one public JWK. Keys meant for encryption (`use: "enc"`) or for other
 * operations are refused, so a key the provider publishes for encrypting
 * requests can never verify a token.
 *
 * @throws JoseError for unusable keys.
 */
export function importJwk(jwk: Readonly<Record<string, unknown>>): PublicJwk {
  if (jwk.use !== undefined && jwk.use !== "sig")
    throw new JoseError("The key is not for signing.");
  const operations = jwk.key_ops;
  if (Array.isArray(operations) && !operations.includes("verify")) {
    throw new JoseError("The key may not be used to verify signatures.");
  }
  // Copy only the public members: a JWKS must not publish private ones, and if a
  // misconfigured provider does, they are simply ignored.
  const publicMembers: JsonWebKey = {};
  for (const name of ["kty", "crv", "n", "e", "x", "y"] as const) {
    const value = jwk[name];
    if (typeof value === "string") publicMembers[name] = value;
  }
  let key: KeyObject;
  try {
    key = createPublicKey({ key: publicMembers, format: "jwk" });
  } catch {
    throw new JoseError("The key is not a valid public JWK.");
  }
  return {
    key,
    keyId: typeof jwk.kid === "string" ? jwk.kid : undefined,
    algorithm: typeof jwk.alg === "string" ? jwk.alg : undefined,
  };
}

/** True when `key` is of the type `algorithm` needs (no algorithm confusion). */
export function keyFitsAlgorithm(key: KeyObject, algorithm: SupportedAlgorithm): boolean {
  switch (algorithm) {
    case "RS256":
      return (
        key.asymmetricKeyType === "rsa" &&
        (key.asymmetricKeyDetails?.modulusLength ?? 0) >= MIN_RSA_BITS
      );
    case "ES256":
      return (
        key.asymmetricKeyType === "ec" && key.asymmetricKeyDetails?.namedCurve === "prime256v1"
      );
    case "EdDSA":
      return key.asymmetricKeyType === "ed25519";
  }
}

/** Checks a JWS signature. Returns false (never throws) for a wrong key or a bad signature. */
export function verifyJws(jws: DecodedJws, algorithm: SupportedAlgorithm, key: KeyObject): boolean {
  if (!keyFitsAlgorithm(key, algorithm)) return false;
  try {
    switch (algorithm) {
      case "RS256":
        return verify("sha256", jws.signingInput, key, jws.signature);
      case "ES256":
        // JWS carries ECDSA signatures as fixed-size r || s, not DER (RFC 7518 §3.4).
        return (
          jws.signature.length === 64 &&
          verify("sha256", jws.signingInput, { key, dsaEncoding: "ieee-p1363" }, jws.signature)
        );
      case "EdDSA":
        // Ed25519 hashes internally; node takes `null` as the digest for it.
        return verify(null, jws.signingInput, key, jws.signature);
    }
  } catch {
    return false;
  }
}
