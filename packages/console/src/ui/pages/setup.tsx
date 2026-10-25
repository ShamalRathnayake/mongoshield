/**
 * First-run setup: creates the first admin account.
 *
 * Two ways in (see src/server/routes/session.ts for the reasoning):
 *   - within the setup window after the console starts (15 minutes by default), the
 *     page works without anything else: choose a name and a password, done;
 *   - with the one-time token from the setup link the server prints in its log
 *     (`/setup?token=…`), which also works after the window has closed.
 *
 * The page says plainly which case applies, and that during the window whoever opens
 * the page first becomes the admin. After success the token (if any) is removed from the
 * address bar (it is single-use, but it should not linger in history or screenshots)
 * and the new admin is signed in.
 */

import { type FormEvent, useState } from "react";
import type { SessionInfo } from "../../shared/api.ts";
import { describeError } from "../api.ts";
import { BrandLogo } from "../components/brand.tsx";
import { Button } from "../components/button.tsx";
import { TextField } from "../components/field.tsx";
import { Notice } from "../components/layout.tsx";
import { useApi } from "../context.tsx";
import { formatDateTime } from "../format.ts";

/** Minimum password length; the server enforces the same rule. */
export const MIN_PASSWORD_LENGTH = 12;

/** Props for `SetupPage`. */
export interface SetupPageProps {
  /** The token from the URL, if the page was opened from the setup link. */
  readonly token: string | undefined;
  readonly onDone: (session: SessionInfo) => void;
  readonly mock: boolean;
  readonly fromSetupLink: boolean;
  /** Whether the token is needed now, and until when it is not (from `GET /api/session`). */
  readonly setup?: SessionInfo["setup"];
}

/**
 * True when the page is served over plain HTTP from a host other than this machine.
 * Browsers then refuse the console's `Secure` session cookie, so signing in would
 * silently fail; the page says so up front instead.
 */
export function insecureRemoteHttp(location: Pick<Location, "protocol" | "hostname">): boolean {
  if (location.protocol !== "http:") return false;
  const host = location.hostname.replace(/^\[|\]$/g, "");
  return !(
    host === "localhost" ||
    host === "::1" ||
    /^127\./.test(host) ||
    host.endsWith(".localhost")
  );
}

/** The one-time "create the first admin" page. */
export function SetupPage(props: SetupPageProps) {
  const client = useApi();
  // Without setup state (an older server) the token is required, as it always was.
  const tokenRequired = props.setup?.tokenRequired ?? true;
  const [token, setToken] = useState(props.token ?? "");
  // The token field is hidden while the window is open, unless the user has one anyway.
  const [showToken, setShowToken] = useState(tokenRequired || props.token !== undefined);
  const [username, setUsername] = useState("admin");
  const [password, setPassword] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  const sendToken = tokenRequired || (showToken && token.trim() !== "");
  const errors = {
    token:
      tokenRequired && token.trim() === ""
        ? "Paste the token from the setup link in the console's log."
        : undefined,
    username: username.trim() === "" ? "Choose a user name." : undefined,
    password:
      password.length < MIN_PASSWORD_LENGTH
        ? `Use at least ${MIN_PASSWORD_LENGTH} characters.`
        : undefined,
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
        ...(sendToken ? { token: token.trim() } : {}),
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
        <div className="auth-brand" aria-hidden="true">
          <BrandLogo size={32} />
          MongoShield
        </div>
        <h1 className="auth-title">Welcome to MongoShield</h1>
        <p className="muted">
          Create the administrator account. You will connect your database right after.
        </p>
        {props.mock ? (
          <Notice tone="info" title="Mock mode">
            Nothing is saved.{" "}
            {tokenRequired ? (
              <>
                Use the setup token <code>mock-setup-token</code>.
              </>
            ) : (
              "No token is needed."
            )}
          </Notice>
        ) : null}
        {insecureRemoteHttp(window.location) ? (
          <Notice tone="warning" title="Sign-in needs HTTPS here">
            Browsers keep the console's sign-in cookie only over HTTPS or on this computer
            (localhost). Open the console through an HTTPS proxy, or for a quick evaluation start it
            with <code>MONGOSHIELD_COOKIE_SECURE=false</code>.
          </Notice>
        ) : null}
        {tokenRequired ? (
          !props.fromSetupLink && props.token === undefined ? (
            <Notice tone="info" title="Setup token needed">
              The console printed a one-time setup link in its log (
              <code>docker logs &lt;container&gt;</code>). Open that link, or paste its token below.
              Restarting the console also lets you finish setup without the token for a few minutes.
            </Notice>
          ) : null
        ) : (
          <Notice tone="info" title="First come, first served">
            Until {formatDateTime(props.setup?.windowEndsAt)}, anyone who can open this page can
            create the administrator, so do it now. After that, setup needs the one-time link from
            the console's log.
          </Notice>
        )}
        {showToken ? (
          <TextField
            label={tokenRequired ? "Setup token" : "Setup token (optional)"}
            value={token}
            onValue={setToken}
            autoComplete="off"
            spellCheck={false}
            error={submitted ? errors.token : undefined}
          />
        ) : null}
        <TextField
          label="User name"
          value={username}
          onValue={setUsername}
          autoComplete="username"
          hint="Letters, digits, dots, dashes, underscores, or an email address."
          error={submitted ? errors.username : undefined}
        />
        <TextField
          label="Password"
          // The field's eye button shows what was typed, instead of asking for it twice.
          type="password"
          value={password}
          onValue={setPassword}
          autoComplete="new-password"
          hint={`At least ${MIN_PASSWORD_LENGTH} characters. A few words in a row are easy to remember and hard to guess.`}
          error={submitted ? errors.password : undefined}
        />
        {error === undefined ? null : (
          <Notice tone="danger" title="Setup failed">
            {error}
          </Notice>
        )}
        <Button type="submit" variant="primary" busy={busy}>
          Create account and continue
        </Button>
        {!tokenRequired && !showToken ? (
          <Button variant="ghost" size="small" onClick={() => setShowToken(true)}>
            I have a setup token
          </Button>
        ) : null}
      </form>
    </main>
  );
}
