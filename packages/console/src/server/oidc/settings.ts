/**
 * OIDC settings and what the console takes from a verified ID token: the role
 * (from a configured claim, through a mapping, with a default) and the username.
 *
 * The settings come from MONGOSHIELD_OIDC_* environment variables (parsed in
 * ../config.ts). Everything here is pure, so the mapping rules are unit tested
 * without an identity provider.
 */

import { createHash } from "node:crypto";
import type { Role } from "../../shared/api.ts";

/** How the console signs people in with an OpenID Connect provider. */
export interface OidcSettings {
  /**
   * The issuer identifier, e.g. `https://login.example.com/realms/ops`. Compared
   * exactly (no normalisation) with the discovery document's `issuer` and every
   * token's `iss`, as OpenID Connect Discovery 1.0 §4.3 requires.
   */
  readonly issuer: string;
  readonly clientId: string;
  /** Unset for a public client (PKCE only, `token_endpoint_auth_method: none`). */
  readonly clientSecret?: string;
  /** Where the provider sends the browser back: `<console>/api/oidc/callback`. */
  readonly redirectUrl: string;
  /** Requested scopes; always includes `openid`. */
  readonly scopes: readonly string[];
  /**
   * Claim holding the user's groups or roles, e.g. `groups` or `realm_access.roles`
   * (dots walk into nested objects). Unset: roles are managed in the console only.
   */
  readonly roleClaim?: string;
  /** Claim value → console role, e.g. `backup-admins` → `admin`. */
  readonly rolesMap: ReadonlyMap<string, Role>;
  /**
   * Role when no mapping matches (and for new accounts when no role claim is set).
   * `"none"` refuses sign-in to identities without a mapped role.
   */
  readonly defaultRole: Role | "none";
  /** Create console accounts for new identities at their first sign-in. */
  readonly autoProvision: boolean;
  /** Tolerated clock difference with the provider for `exp`, `nbf` and `iat`. */
  readonly clockSkewMs: number;
}

/** Default clock skew: one minute, enough for NTP-synced hosts, too short to matter for replay. */
export const DEFAULT_CLOCK_SKEW_MS = 60_000;

/** Default scopes: `openid` plus the claims a username is taken from. */
export const DEFAULT_SCOPES: readonly string[] = ["openid", "profile", "email"];

/** Usernames the console accepts (same rule as auth.ts, repeated to keep this file pure). */
const USERNAME = /^[A-Za-z0-9._@-]{1,64}$/;

/** Rank of each role, for "the highest mapped role wins". */
const RANK: Readonly<Record<Role, number>> = { viewer: 0, operator: 1, admin: 2 };

/** The verified claims of an ID token (values are still untyped JSON). */
export type IdTokenClaims = Readonly<Record<string, unknown>>;

/**
 * The console role for a token's claims.
 *
 * - No role claim configured: `undefined` (the caller keeps the account's role, or
 *   uses the default role for a new account).
 * - Otherwise the highest role any claim value maps to, or the default role when
 *   none matches (which may be `"none"`: refuse).
 *
 * A claim may be a string, a list of strings, or a space-separated string (some
 * providers flatten lists that way); anything else counts as no values.
 */
export function roleFromClaims(
  claims: IdTokenClaims,
  settings: Pick<OidcSettings, "roleClaim" | "rolesMap" | "defaultRole">,
): Role | "none" | undefined {
  if (settings.roleClaim === undefined) return undefined;
  let best: Role | undefined;
  for (const value of claimValues(claimAt(claims, settings.roleClaim))) {
    const role = settings.rolesMap.get(value);
    if (role !== undefined && (best === undefined || RANK[role] > RANK[best])) best = role;
  }
  return best ?? settings.defaultRole;
}

/** Reads a claim by name, walking `a.b.c` into nested objects. A literal dotted name wins. */
function claimAt(claims: IdTokenClaims, path: string): unknown {
  if (Object.hasOwn(claims, path)) return claims[path];
  let current: unknown = claims;
  for (const part of path.split(".")) {
    if (typeof current !== "object" || current === null || Array.isArray(current)) return undefined;
    current = Reflect.get(current, part);
  }
  return current;
}

/** The string values of a claim (see {@link roleFromClaims}). */
function claimValues(value: unknown): string[] {
  if (typeof value === "string") return value.split(" ").filter((part) => part !== "");
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === "string");
  }
  return [];
}

/**
 * The console username for an identity: `preferred_username`, else a verified
 * `email`, else `sub`, whichever first fits the console's username rule. If none
 * does (non-ASCII names, very long subjects), a stable `oidc-<hash>` name derived
 * from issuer and subject is used, so every identity can still get an account.
 *
 * The username is only a label for a NEW account. It never links an identity to an
 * existing account: `preferred_username` is often editable by the user at the provider
 * (see {@link linkableNamesOf} for what does link). Accounts are bound to issuer +
 * subject afterwards.
 */
export function usernameFromClaims(claims: IdTokenClaims, issuer: string): string {
  const candidates: unknown[] = [claims.preferred_username];
  // An unverified email may belong to someone else; never derive a name from it.
  const email = verifiedEmailOf(claims);
  if (email !== undefined) candidates.push(email);
  candidates.push(claims.sub);
  for (const candidate of candidates) {
    if (typeof candidate === "string" && USERNAME.test(candidate)) return candidate;
  }
  const digest = createHash("sha256")
    .update(`${issuer}\n${String(claims.sub)}`)
    .digest("hex");
  return `oidc-${digest.slice(0, 16)}`;
}

/**
 * The `email` claim, only when the provider says it is verified (`email_verified` is
 * exactly `true`; a missing claim counts as unverified: many providers let users type
 * any address, and some leave the claim out instead of sending `false`).
 */
export function verifiedEmailOf(claims: IdTokenClaims): string | undefined {
  if (claims.email_verified !== true) return undefined;
  return typeof claims.email === "string" && claims.email !== "" ? claims.email : undefined;
}

/**
 * The account names an identity may claim at its first sign-in: an SSO-only account an
 * admin prepared is linked when its username is the identity's verified email (compared
 * case-insensitively) or its exact subject (`sub`, stable and assigned by the provider).
 * Never `preferred_username`, which many providers let users change to anything,
 * including the name of an account prepared for someone else.
 */
export function linkableNamesOf(claims: IdTokenClaims): {
  readonly email?: string;
  readonly subject: string;
} {
  const email = verifiedEmailOf(claims)?.toLowerCase();
  return { subject: String(claims.sub), ...(email === undefined ? {} : { email }) };
}
