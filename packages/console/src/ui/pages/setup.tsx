/**
 * First-run setup: creates the first admin account with the one-time token from the
 * setup link the server prints in its log (`/setup?token=…`).
 *
 * After success the token is removed from the address bar (it is single-use, but it
 * should not linger in history or screenshots) and the new admin is signed in.
 */

import { type FormEvent, useState } from "react";
import type { SessionInfo } from "../../shared/api.ts";
import { describeError } from "../api.ts";
import { Button } from "../components/button.tsx";
import { TextField } from "../components/field.tsx";
import { Notice } from "../components/layout.tsx";
import { useApi } from "../context.tsx";

/** Minimum password length; the server enforces the same rule. */
export const MIN_PASSWORD_LENGTH = 12;

/** Props for `SetupPage`. */
export interface SetupPageProps {
  /** The token from the URL, if the page was opened from the setup link. */
  readonly token: string | undefined;
  readonly onDone: (session: SessionInfo) => void;
  readonly mock: boolean;
  readonly fromSetupLink: boolean;
}

/** The one-time "create the first admin" page. */
export function SetupPage(props: SetupPageProps) {
  const client = useApi();
  const [token, setToken] = useState(props.token ?? "");
  const [username, setUsername] = useState("admin");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  const errors = {
    token:
      token.trim() === "" ? "Paste the token from the setup link in the server log." : undefined,
    username: username.trim() === "" ? "Choose a username." : undefined,
    password:
      password.length < MIN_PASSWORD_LENGTH
        ? `Use at least ${MIN_PASSWORD_LENGTH} characters.`
        : undefined,
    confirm: confirm !== password ? "The passwords do not match." : undefined,
  };
  const valid = Object.values(errors).every((message) => message === undefined);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSubmitted(true);
    if (!valid) return;
    setBusy(true);
    setError(undefined);
    try {
      const session = await client.call("POST /api/setup", {
        token: token.trim(),
        username: username.trim(),
        password,
      });
      // Drop `/setup?token=…` from the address bar and history.
      window.history.replaceState(null, "", `${window.location.pathname.replace(/setup$/, "")}#/`);
      props.onDone(session);
    } catch (failure) {
      setError(describeError(failure));
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="centered-page">
      <form className="auth-card" onSubmit={submit} noValidate>
        <h1 className="auth-title">Set up MongoShield</h1>
        <p className="muted">Create the first administrator. This can only be done once.</p>
        {props.mock ? (
          <Notice tone="info" title="Mock mode">
            Use the setup token <code>mock-setup-token</code>.
          </Notice>
        ) : null}
        {!props.fromSetupLink && props.token === undefined ? (
          <Notice tone="info" title="Setup required">
            The server printed a one-time setup link in its log when it first started. Open that
            link, or paste its token below.
          </Notice>
        ) : null}
        <TextField
          label="Setup token"
          value={token}
          onValue={setToken}
          autoComplete="off"
          spellCheck={false}
          error={submitted ? errors.token : undefined}
        />
        <TextField
          label="Admin username"
          value={username}
          onValue={setUsername}
          autoComplete="username"
          error={submitted ? errors.username : undefined}
        />
        <TextField
          label="Password"
          type="password"
          value={password}
          onValue={setPassword}
          autoComplete="new-password"
          hint={`At least ${MIN_PASSWORD_LENGTH} characters. A passphrase of several words is easiest.`}
          error={submitted ? errors.password : undefined}
        />
        <TextField
          label="Repeat password"
          type="password"
          value={confirm}
          onValue={setConfirm}
          autoComplete="new-password"
          error={submitted ? errors.confirm : undefined}
        />
        {error === undefined ? null : (
          <Notice tone="danger" title="Setup failed">
            {error}
          </Notice>
        )}
        <Button type="submit" variant="primary" busy={busy}>
          Create admin and sign in
        </Button>
      </form>
    </main>
  );
}
