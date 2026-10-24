/**
 * The sign-in page. Password login posts to `POST /api/session`. With trusted-proxy SSO
 * the proxy signs people in, so the page only explains that. (OIDC is not served yet.)
 */

import { type FormEvent, useState } from "react";
import type { SessionInfo } from "../../shared/api.ts";
import { describeError, RateLimitedError } from "../api.ts";
import { Button } from "../components/button.tsx";
import { TextField } from "../components/field.tsx";
import { Notice } from "../components/layout.tsx";
import { useApi } from "../context.tsx";

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
        {/* OIDC sign-in is planned but not served yet, so no SSO button is offered. */}
        {props.session.authMethods.includes("proxy") && !passwordAllowed ? (
          <Notice tone="info" title="Signed in by your proxy">
            This console expects your reverse proxy to sign you in. Reload the page through the
            proxy.
          </Notice>
        ) : null}
      </form>
    </main>
  );
}
