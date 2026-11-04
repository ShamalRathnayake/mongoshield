/**
 * OIDC sign-in routes (browser redirects, not JSON):
 *
 *   GET /api/oidc/login      anyone   → 302 to the provider; sets the transaction cookie
 *   GET /api/oidc/callback   anyone   ← the provider's redirect; signs in → 303 to `/#/`,
 *                                       or → 303 to `/#/?sso_error=<code>` on failure
 *
 * The transaction cookie is `SameSite=Lax`, unlike the `Strict` session cookie:
 * the provider's redirect back is a cross-site navigation, and browsers send only
 * Lax (or None) cookies on those. It carries a random id of a pending login held in
 * memory (client.ts), lives 10 minutes, and is cleared by the callback.
 *
 * Accounts (see `signInOidcUser`):
 *   1. an account linked to this issuer + subject signs in;
 *   2. else an SSO-only account (no password) named after the identity's VERIFIED email
 *      (`email_verified: true`) or its subject is linked, once. Never by
 *      `preferred_username`, which users can often change at the provider; an existing
 *      account with the new account's name is never taken over (`ACCOUNT_CONFLICT`);
 *   3. else, with auto-provisioning on, a new SSO-only account is created, otherwise
 *      the sign-in is refused (`NOT_PROVISIONED`).
 * With a role claim configured, the account's role follows the provider at every
 * sign-in (except that the last admin is never demoted, which would lock everyone out).
 */

import type { Context, Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { Role } from "../../shared/api.ts";
import { randomId } from "../../state/crypto.ts";
import type { UserRecord } from "../../state/types.ts";
import { recordAudit } from "../audit.ts";
import { clientAddress } from "../auth.ts";
import type { AppEnv, ConsoleServices } from "../context.ts";
import { notFound } from "../errors.ts";
import { basePathOf } from "../hosts.ts";
import { PENDING_LOGIN_TTL_MS } from "../oidc/client.ts";
import { OidcError } from "../oidc/errors.ts";
import {
  type IdTokenClaims,
  linkableNamesOf,
  type OidcSettings,
  roleFromClaims,
  usernameFromClaims,
} from "../oidc/settings.ts";
import { startSession } from "./session.ts";

/**
 * Where the browser goes after signing in: the UI's start page, under the sub-path the
 * console is served at (MONGOSHIELD_PUBLIC_URL's path, see hosts.ts), if any.
 */
function signedInLocation(services: ConsoleServices): string {
  return `${basePathOf(services.settings.publicUrl)}/#/`;
}

/** The transaction cookie's name: `__Host-` prefixed when cookies are Secure. */
function transactionCookieName(services: ConsoleServices): string {
  return services.settings.cookieSecure ? "__Host-mongoshield_oidc" : "mongoshield_oidc";
}

/** Registers the OIDC routes. They answer 404 when OIDC is not configured. */
export function oidcRoutes(app: Hono<AppEnv>, services: ConsoleServices): void {
  app.get("/api/oidc/login", async (c) => {
    const oidc = services.oidc;
    if (oidc === undefined) throw notFound("Single sign-on");
    let started: Awaited<ReturnType<typeof oidc.begin>>;
    try {
      // Keyed by client address, so one address looping on this endpoint can only push
      // out its own pending sign-ins (client.ts).
      started = await oidc.begin(clientAddress(c));
    } catch (error) {
      return failedSignIn(c, services, error);
    }
    setCookie(c, transactionCookieName(services), started.transactionId, {
      httpOnly: true,
      secure: services.settings.cookieSecure,
      // Lax, not Strict: it must come back with the provider's cross-site redirect.
      sameSite: "Lax",
      path: "/",
      maxAge: Math.floor(PENDING_LOGIN_TTL_MS / 1000),
    });
    return c.redirect(started.url, 302);
  });

  app.get("/api/oidc/callback", async (c) => {
    const oidc = services.oidc;
    if (oidc === undefined) throw notFound("Single sign-on");
    const transactionId = getCookie(c, transactionCookieName(services));
    // Single use: whatever happens next, this browser's pending login is over.
    deleteCookie(c, transactionCookieName(services), {
      path: "/",
      secure: services.settings.cookieSecure,
    });
    try {
      const claims = await oidc.complete(
        transactionId !== undefined && transactionId.length <= 128 ? transactionId : undefined,
        {
          code: c.req.query("code"),
          state: c.req.query("state"),
          error: c.req.query("error"),
          iss: c.req.query("iss"),
        },
      );
      const user = await signInOidcUser(services, oidc.settings, claims);
      const principal = await startSession(c, services, user);
      await recordAudit(services, {
        actor: principal,
        action: "session.login",
        outcome: "success",
        details: { method: "oidc" },
      });
      return c.redirect(signedInLocation(services), 303);
    } catch (error) {
      return failedSignIn(c, services, error);
    }
  });
}

/**
 * Sends the browser back to the login page with the reason's code. Unexpected
 * errors are rethrown (the app's error handler logs them and answers 500).
 */
async function failedSignIn(
  c: Context<AppEnv>,
  services: ConsoleServices,
  error: unknown,
): Promise<Response> {
  if (!(error instanceof OidcError)) throw error;
  services.logger.warn("OIDC sign-in failed", { code: error.code, detail: error.message });
  await recordAudit(services, {
    actor: "anonymous",
    action: "session.login_failed",
    outcome: "failure",
    details: { method: "oidc", reason: error.code },
  });
  return c.redirect(
    `${signedInLocation(services)}?sso_error=${encodeURIComponent(error.code)}`,
    303,
  );
}

/** The outcome of matching an identity to an account, decided inside one state update. */
type AccountDecision =
  | { readonly ok: true; readonly user: UserRecord; readonly created: boolean }
  | { readonly ok: false; readonly error: OidcError };

/**
 * Finds, links or creates the console account for verified claims (rules in the
 * file header). Runs as one state update, so two simultaneous first sign-ins of
 * the same person cannot create two accounts.
 *
 * @throws OidcError when the identity may not sign in.
 */
export async function signInOidcUser(
  services: ConsoleServices,
  settings: OidcSettings,
  claims: IdTokenClaims,
): Promise<UserRecord> {
  const subject = String(claims.sub);
  const identity = { issuer: settings.issuer, subject };
  const mappedRole = roleFromClaims(claims, settings);
  const username = usernameFromClaims(claims, settings.issuer);
  const linkable = linkableNamesOf(claims);
  const now = services.now().toISOString();

  const decision = await services.store.update((state): AccountDecision => {
    const linked = state.users.find(
      (user) => user.oidc?.issuer === identity.issuer && user.oidc.subject === identity.subject,
    );
    let account: UserRecord | undefined = linked;
    let created = false;

    if (account === undefined) {
      // An SSO-only account an admin prepared (or the proxy created), named after the
      // verified email or the subject: link it. Never by preferred_username (A2).
      const prepared = state.users.find(
        (user) =>
          user.passwordHash === "" &&
          user.oidc === undefined &&
          (user.username === linkable.subject || user.username.toLowerCase() === linkable.email),
      );
      if (prepared !== undefined) account = { ...prepared, oidc: identity };
    }
    if (account === undefined && state.users.some((user) => user.username === username)) {
      return {
        ok: false,
        error: new OidcError(
          "CONSOLE_OIDC_ACCOUNT_CONFLICT",
          `The console account "${username}" belongs to someone else (it has a password or another identity, or it was prepared for a different verified email).`,
        ),
      };
    }

    const role = roleFor(account, mappedRole, settings, state.users);
    if (role === "none") {
      return {
        ok: false,
        error: new OidcError(
          "CONSOLE_OIDC_NO_ROLE",
          `The identity ${JSON.stringify(username)} has no mapped role and there is no default role.`,
        ),
      };
    }

    if (account === undefined) {
      if (!settings.autoProvision) {
        return {
          ok: false,
          error: new OidcError(
            "CONSOLE_OIDC_NOT_PROVISIONED",
            `No console account belongs to ${JSON.stringify(username)} and auto-provisioning is off.`,
          ),
        };
      }
      account = {
        id: randomId(),
        username,
        role,
        // No password: this account signs in only through SSO.
        passwordHash: "",
        createdAt: now,
        oidc: identity,
      };
      created = true;
    } else {
      account = { ...account, role };
    }

    const final = account;
    state.users = created
      ? [...state.users, final]
      : state.users.map((user) => (user.id === final.id ? final : user));
    return { ok: true, user: final, created };
  });

  if (!decision.ok) throw decision.error;
  if (decision.created) {
    await recordAudit(services, {
      actor: decision.user.username,
      action: "user.provision",
      target: decision.user.username,
      outcome: "success",
      details: { via: "oidc", role: decision.user.role },
    });
  }
  return decision.user;
}

/**
 * The role an account gets at this sign-in: the mapped role when a role claim is
 * configured (never demoting the last admin), the account's current role when not,
 * and the default role for a new account.
 */
function roleFor(
  account: UserRecord | undefined,
  mappedRole: Role | "none" | undefined,
  settings: OidcSettings,
  users: readonly UserRecord[],
): Role | "none" {
  if (account === undefined) return mappedRole ?? settings.defaultRole;
  if (mappedRole === undefined) return account.role;
  const lastAdmin =
    account.role === "admin" &&
    !users.some((user) => user.role === "admin" && user.id !== account.id);
  if (lastAdmin && mappedRole !== "admin") return "admin";
  return mappedRole;
}
