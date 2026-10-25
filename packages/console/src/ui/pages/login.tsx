/**
 * The sign-in page.
 *
 * - Password login posts to `POST /api/session`.
 * - OIDC single sign-on is a plain link to `/api/oidc/login`: a full-page navigation,
 *   because the server answers with a redirect to the identity provider (fetch could
 *   not follow it into another site). When the provider sends the browser back, the
 *   server either signs it in or redirects to `#/?sso_error=<code>`, which this page
 *   explains.
 * - With trusted-proxy SSO the proxy signs people in, so the page only explains that.
 */

import { type FormEvent, useState } from "react";
import {
  OIDC_ERROR_CODES,
  OIDC_LOGIN_PATH,
  type OidcErrorCode,
  type SessionInfo,
} from "../../shared/api.ts";
import { describeError, RateLimitedError } from "../api.ts";
import { BrandLogo } from "../components/brand.tsx";
import { Button, LinkButton } from "../components/button.tsx";
import { TextField } from "../components/field.tsx";
import { Notice } from "../components/layout.tsx";
import { useApi } from "../context.tsx";
import { parseLocation } from "../router.ts";

/** What each single sign-on failure means for the person who just tried. */
const SSO_ERROR_MESSAGES: Readonly<Record<OidcErrorCode, string>> = {
  CONSOLE_OIDC_PROVIDER_ERROR:
    "Your identity provider did not complete the sign-in (it was cancelled or refused).",
  CONSOLE_OIDC_STATE:
    "The sign-in expired or was started in another browser tab or window. Start it again from here.",
  CONSOLE_OIDC_INVALID_TOKEN:
    "The identity provider's answer could not be verified, so it was refused. Ask an admin to check the console log.",
  CONSOLE_OIDC_UNAVAILABLE: "The identity provider could not be reached. Try again in a moment.",
  CONSOLE_OIDC_NO_ROLE:
    "Your account has no role in this console. Ask an admin to grant you access in the identity provider.",
  CONSOLE_OIDC_NOT_PROVISIONED:
    "There is no console account for you yet. Ask an admin to create one.",
  CONSOLE_OIDC_ACCOUNT_CONFLICT:
    "A different console account already uses your username. Ask an admin to resolve it.",
};

/**
 * The explanation for the `sso_error` in the current hash, if any. Unknown codes (a
 * newer server, or a hand-edited URL) get a generic message rather than their raw text.
 */
export function ssoErrorMessage(hash: string): string | undefined {
  const code = parseLocation(hash).query.get("sso_error");
  if (code === null) return undefined;
  const known = OIDC_ERROR_CODES.find((candidate) => candidate === code);
  return known === undefined
    ? "Single sign-on did not complete. Try again, or ask an admin to check the console log."
    : SSO_ERROR_MESSAGES[known];
}

/** Props for `LoginPage`. */
export interface LoginPageProps {
  readonly session: SessionInfo;
  readonly onSignedIn: (session: SessionInfo) => void;
  readonly mock: boolean;
}

/** Username/password sign-in. */
export function LoginPage(props: LoginPageProps) {
  const client = useApi();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const passwordAllowed = props.session.authMethods.includes("password");
  const oidcAllowed = props.session.authMethods.includes("oidc");
  // Read once: the message belongs to the redirect that brought the user here.
  const [ssoError] = useState(() => ssoErrorMessage(window.location.hash));

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (username.trim() === "" || password === "") {
      setError("Enter your username and password.");
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      const session = await client.call("POST /api/session", {
        username: username.trim(),
        password,
      });
      props.onSignedIn(session);
    } catch (failure) {
      setError(
        failure instanceof RateLimitedError
          ? "Too many attempts. Wait a minute before trying again."
          : describeError(failure),
      );
      setPassword("");
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="centered-page">
      <form className="auth-card" onSubmit={submit} noValidate aria-labelledby="login-title">
        <div className="auth-brand" aria-hidden="true">
          <BrandLogo size={32} />
          MongoShield
        </div>
        <h1 id="login-title" className="auth-title">
          Sign in to MongoShield
        </h1>
        {props.mock ? (
          <Notice tone="info" title="Mock mode">
            Sign in as <code>admin</code> / <code>admin</code> (or <code>maya</code> /{" "}
            <code>operator</code>, <code>sam</code> / <code>viewer</code>).
          </Notice>
        ) : null}
        {passwordAllowed ? (
          <>
            <TextField
              label="Username"
              value={username}
              onValue={setUsername}
              autoComplete="username"
              autoFocus
            />
            <TextField
              label="Password"
              type="password"
              value={password}
              onValue={setPassword}
              autoComplete="current-password"
            />
            {error === undefined ? null : (
              <Notice tone="danger" title="Could not sign in">
                {error}
              </Notice>
            )}
            <Button type="submit" variant="primary" busy={busy}>
              Sign in
            </Button>
          </>
        ) : null}
        {ssoError === undefined ? null : (
          <Notice tone="danger" title="Single sign-on failed">
            {ssoError}
          </Notice>
        )}
        {oidcAllowed ? (
          <LinkButton href={OIDC_LOGIN_PATH} variant={passwordAllowed ? "secondary" : "primary"}>
            Sign in with single sign-on
          </LinkButton>
        ) : null}
        {props.session.authMethods.includes("proxy") && !passwordAllowed && !oidcAllowed ? (
          <Notice tone="info" title="Signed in by your proxy">
            This console expects your reverse proxy to sign you in. Reload the page through the
            proxy.
          </Notice>
        ) : null}
      </form>
    </main>
  );
}
