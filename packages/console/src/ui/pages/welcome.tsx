/**
 * Welcome: the first thing an admin sees on a console without connections.
 *
 *   1. Paste a connection string. Quotes, a `mongosh "…"` command and wrapped lines are
 *      cleaned up; the password moves into a separate masked field (an Atlas
 *      `<db_password>` placeholder asks for it there), so it is never on screen; special
 *      characters in it are encoded. The check runs as soon as a complete string is
 *      pasted.
 *   2. See what it is (MongoDB version, replica set, Atlas tier) and confirm the two
 *      defaults: a name (from the cluster, replica set or host) and whether it is
 *      production (Atlas and other servers: yes; this computer and Docker: no). Failures
 *      are explained in plain words with a fix (`ConnectionProblem` from the server).
 *   3. "Save and browse": the live data browser of the new connection, where the backup
 *      actions bar (backup-actions.tsx) offers "Back up now" and "Restore a backup".
 *
 * The password is never shown again: previews use the masked connection string.
 */

import { type ClipboardEvent, useState } from "react";
import type { ConnectionCheckResult, ConnectionProblem, PublicIpResult } from "../../shared/api.ts";
import {
  analyzeConnectionString,
  ConnectionStringError,
  type ConnectionStringInfo,
  cleanPastedConnectionString,
  maskConnectionString,
  separatePassword,
  withPassword,
} from "../../shared/connection-string.ts";
import { describeError } from "../api.ts";
import { Button } from "../components/button.tsx";
import { CheckboxField, TextAreaField, TextField } from "../components/field.tsx";
import { KeyValueList, Notice, PageHeader, Panel } from "../components/layout.tsx";
import { useApi } from "../context.tsx";
import { humanize } from "../format.ts";
import { atlasTierLabel, rememberWelcomeSkipped } from "../onboarding.ts";
import { navigate } from "../router.ts";
import "./onboarding.css";

/** The pasted text, understood (or why not). */
interface Understood {
  readonly cleaned: string;
  readonly info?: ConnectionStringInfo;
  readonly problem?: string;
}

/** Cleans and analyzes pasted text. Empty text is "nothing yet", not an error. */
export function understand(text: string): Understood {
  const cleaned = cleanPastedConnectionString(text);
  if (cleaned === "") return { cleaned };
  try {
    return { cleaned, info: analyzeConnectionString(cleaned) };
  } catch (error) {
    return {
      cleaned,
      problem:
        error instanceof ConnectionStringError
          ? error.message
          : "That does not look like a MongoDB connection string.",
    };
  }
}

/**
 * The connection string to send: the cleaned text with the typed password in place of
 * a placeholder. Undefined while something is still missing.
 */
export function uriToSend(understood: Understood, password: string): string | undefined {
  const info = understood.info;
  if (info === undefined || info.usernamePlaceholder !== undefined) return undefined;
  if (info.passwordPlaceholder === undefined) return understood.cleaned;
  if (password === "") return undefined;
  return withPassword(understood.cleaned, password);
}

/** The welcome page. */
export function WelcomePage() {
  const client = useApi();
  const [text, setText] = useState("");
  const [password, setPassword] = useState("");
  const [checking, setChecking] = useState(false);
  const [result, setResult] = useState<
    { readonly uri: string; readonly check: ConnectionCheckResult } | undefined
  >(undefined);
  const [requestError, setRequestError] = useState<string | undefined>(undefined);
  const [name, setName] = useState("");
  const [production, setProduction] = useState(true);
  const [saving, setSaving] = useState(false);

  const understood = understand(text);
  const uri = uriToSend(understood, password);
  const host = understood.info?.hosts[0];

  const check = async (target: string | undefined) => {
    if (target === undefined) return;
    setChecking(true);
    setResult(undefined);
    setRequestError(undefined);
    try {
      const answer = await client.call("POST /api/connections/check", { uri: target });
      setResult({ uri: target, check: answer });
      setName(answer.suggestedName);
      setProduction(answer.production.suggested);
    } catch (failure) {
      setRequestError(describeError(failure));
    } finally {
      setChecking(false);
    }
  };

  /**
   * Shows `value` cleaned, with its password moved into the masked password field, so
   * the password never stays on screen. Returns the string shown and the password found.
   */
  const takeIn = (value: string): { readonly uri: string; readonly password?: string } => {
    const separated = separatePassword(cleanPastedConnectionString(value));
    setText(separated.uri);
    setResult(undefined);
    if (separated.password !== undefined) setPassword(separated.password);
    return separated;
  };

  // A complete string pasted in one go is cleaned, its password masked, and checked
  // right away: one click less.
  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    event.preventDefault();
    const shown = takeIn(event.clipboardData.getData("text"));
    const ready = uriToSend(understand(shown.uri), shown.password ?? password);
    if (ready !== undefined) void check(ready);
  };

  const save = async () => {
    if (result === undefined) return;
    setSaving(true);
    setRequestError(undefined);
    try {
      const created = await client.call("POST /api/connections", {
        name: name.trim(),
        uri: result.uri,
        production,
      });
      navigate(`/connections/${encodeURIComponent(created.id)}/data`);
    } catch (failure) {
      setRequestError(describeError(failure));
      setSaving(false);
    }
  };

  const skip = () => {
    rememberWelcomeSkipped();
    navigate("/");
  };

  const succeeded = result?.check.ok === true;
  return (
    <div className="welcome">
      <PageHeader
        title="Connect your database"
        description="Paste a MongoDB connection string. You can browse your data and back it up in the next step."
        actions={
          <Button variant="ghost" size="small" onClick={skip}>
            Skip for now
          </Button>
        }
      />

      <Panel title="1. Connection string">
        <div className="stack-vertical">
          <TextAreaField
            label="Connection string"
            value={text}
            onValue={(value) => {
              setText(value);
              setResult(undefined);
            }}
            onPaste={onPaste}
            // Typed in by hand: the password moves out of sight when the field is left.
            onBlur={() => {
              if (separatePassword(text).password !== undefined) takeIn(text);
            }}
            rows={3}
            spellCheck={false}
            autoComplete="off"
            placeholder="mongodb+srv://user:password@cluster0.abcde.mongodb.net/"
            hint={<ConnectionStringHelp />}
            error={text.trim() === "" ? undefined : understood.problem}
          />
          {understood.info?.usernamePlaceholder === undefined ? null : (
            <Notice tone="warning" title="The user name is missing">
              Replace <code>{understood.info.usernamePlaceholder}</code> with your database user's
              name.
            </Notice>
          )}
          {understood.info?.passwordPlaceholder === undefined ? null : (
            <TextField
              label={`Password for ${understood.info.username ?? "the database user"}`}
              type="password"
              value={password}
              onValue={setPassword}
              autoComplete="off"
              hint={
                <>
                  Kept apart from the connection string (where it says{" "}
                  <code>{understood.info.passwordPlaceholder}</code>), so it is never shown on
                  screen. Any characters are fine; they are encoded for you.
                </>
              }
            />
          )}
          {understood.info?.credentialsNeedEncoding === true ||
          (understood.info?.passwordPlaceholder !== undefined && /[@:/?#[\]%\s]/.test(password)) ? (
            <Notice tone="info" title="Special characters in the password">
              Characters such as <code>@ : / ? #</code> must be encoded inside a connection string.
              MongoShield encodes them for you when it saves the connection.
            </Notice>
          ) : null}
          <div className="form-actions">
            <Button
              variant={succeeded ? "secondary" : "primary"}
              busy={checking}
              disabled={uri === undefined}
              onClick={() => void check(uri)}
            >
              {checking ? "Connecting…" : "Check connection"}
            </Button>
          </div>
          {checking ? (
            <p className="muted" role="status">
              Connecting to {host ?? "the server"}. This can take up to 10 seconds.
            </p>
          ) : null}
          {requestError === undefined ? null : (
            <Notice tone="danger" title="That did not work">
              {requestError}
            </Notice>
          )}
          {result !== undefined && !result.check.ok && result.check.problem !== undefined ? (
            <ProblemNotice problem={result.check.problem} />
          ) : null}
        </div>
      </Panel>

      {result?.check.ok ? (
        <Panel title="2. Check the details">
          <div className="stack-vertical">
            <Notice tone="success" title="Connected">
              <KeyValueList
                items={[
                  ["Database", maskConnectionString(result.uri)],
                  ["MongoDB", result.check.serverVersion ?? "unknown version"],
                  ["Type", topologyLabel(result.check.topology)],
                  ...(result.check.atlas === undefined
                    ? []
                    : ([
                        [
                          "Hosted on",
                          <span key="atlas" className="badge badge-neutral">
                            {atlasTierLabel(result.check.atlas.tier)}
                          </span>,
                        ],
                      ] as const)),
                ]}
              />
              {result.check.atlas?.tier === "shared" ? (
                <p className="muted">
                  Free and Flex clusters are throttled by Atlas. Backups adapt by themselves: they
                  read gently so your app keeps its share.
                </p>
              ) : null}
            </Notice>
            {result.check.privilegeAdvice === undefined ? null : (
              <ProblemNotice problem={result.check.privilegeAdvice} tone="warning" />
            )}
            <TextField
              label="Name"
              value={name}
              onValue={setName}
              hint="How this database is called in the console."
              error={name.trim() === "" ? "Give the connection a name." : undefined}
            />
            <CheckboxField
              label="This is a production database"
              checked={production}
              onChecked={setProduction}
              hint={`${result.check.production.reason} Restoring into a production database needs an admin and the name typed to confirm.`}
            />
            <div className="form-actions">
              <Button
                variant="primary"
                busy={saving}
                disabled={name.trim() === ""}
                onClick={() => void save()}
              >
                Save and browse data
              </Button>
            </div>
          </div>
        </Panel>
      ) : null}
    </div>
  );
}

/** A deployment's topology in plain words. */
export function topologyLabel(topology: string | undefined): string {
  switch (topology) {
    case "replicaSet":
      return "Replica set";
    case "sharded":
      return "Sharded cluster";
    case "standalone":
      return "Single server";
    default:
      return topology === undefined ? "Unknown" : humanize(topology);
  }
}

/** Where to find a connection string, in three lines. */
function ConnectionStringHelp() {
  return (
    <>
      From Atlas: Clusters → Connect → Drivers, then copy the string (a mongosh command works too).
      For MongoDB on this computer while the console runs in Docker, use{" "}
      <code>mongodb://host.docker.internal:27017</code>; for another container on the same Docker
      network, use its name, e.g. <code>mongodb://mongo:27017</code>.
    </>
  );
}

/** A connection problem: what is wrong, how to fix it, links, the public IP and the details. */
export function ProblemNotice(props: { problem: ConnectionProblem; tone?: "danger" | "warning" }) {
  const { problem } = props;
  return (
    <Notice tone={props.tone ?? "danger"} title={problem.title}>
      <p>{problem.message}</p>
      <p>
        <strong>How to fix it:</strong> {problem.fix}
      </p>
      {problem.links.length === 0 ? null : (
        <ul className="welcome-links">
          {problem.links.map((link) => (
            <li key={link.url}>
              <a href={link.url} target="_blank" rel="noopener noreferrer">
                {link.label}
              </a>
            </li>
          ))}
        </ul>
      )}
      {problem.offerPublicIp === true ? <PublicIp /> : null}
      {problem.detail === "" ? null : (
        <details className="welcome-details">
          <summary>Technical details</summary>
          <code>{problem.detail}</code>
        </details>
      )}
    </Notice>
  );
}

/**
 * "Show my public IP address": asks the server (which asks an external service, only on
 * this click) for the address to add to an Atlas IP access list.
 */
function PublicIp() {
  const client = useApi();
  const [busy, setBusy] = useState(false);
  const [answer, setAnswer] = useState<PublicIpResult | undefined>(undefined);
  const lookUp = async () => {
    setBusy(true);
    try {
      setAnswer(await client.call("POST /api/network/public-ip"));
    } catch (failure) {
      setAnswer({ error: describeError(failure) });
    } finally {
      setBusy(false);
    }
  };
  if (answer?.ip !== undefined) {
    return (
      <p role="status">
        The console's public IP address is <code className="welcome-ip">{answer.ip}</code>. Add it
        under Network Access in Atlas, wait a minute, then check again.
      </p>
    );
  }
  return (
    <div className="stack-vertical">
      <div>
        <Button size="small" busy={busy} onClick={() => void lookUp()}>
          Show my public IP address
        </Button>
      </div>
      <p className="muted">This asks checkip.amazonaws.com which address the console has.</p>
      {answer?.error === undefined ? null : <p role="status">{answer.error}</p>}
    </div>
  );
}
