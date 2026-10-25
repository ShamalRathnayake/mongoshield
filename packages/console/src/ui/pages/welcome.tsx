/**
 * Welcome: the first thing an admin sees on a console without connections.
 *
 * The page is a short flow of numbered tabs (StepFlow, ../components/step-flow.tsx), so
 * getting started reads as three steps instead of panels stacked down the page:
 *
 *   (1) Connect ─── (2) Details ─── (3) Browse and back up
 *
 *   1. Connect: paste a connection string. Quotes, a `mongosh "…"` command and wrapped
 *      lines are cleaned up; the password moves into a separate masked field (an Atlas
 *      `<db_password>` placeholder asks for it there), so it is never on screen; special
 *      characters in it are encoded. The check runs as soon as a complete string is
 *      pasted, or with "Check connection". "Quick fill" chips under the field fill in a
 *      MongoDB next to the console (FillSuggestions). Failures are explained in plain words with a
 *      fix (`ConnectionProblem` from the server). When it connects, the flow moves on to
 *      "Details" by itself.
 *   2. Details (locked until the check succeeds): what it is (MongoDB version, replica
 *      set, Atlas tier) and the two defaults to confirm: a name (from the cluster,
 *      replica set or host) and whether it is production (Atlas and other servers: yes;
 *      this computer and Docker: no); chips under the name offer it and the usual roles
 *      ("Production", "Staging", "Local dev"). "Save and browse data" finishes the flow.
 *   3. Browse and back up: always locked here, it shows where saving leads: the live
 *      data browser of the new connection, where the backup actions bar
 *      (backup-actions.tsx) offers "Back up now" and "Restore a backup".
 *
 * The password is never shown again: previews use the masked connection string.
 */

import { type ClipboardEvent, useEffect, useRef, useState } from "react";
import type { ConnectionCheckResult, ConnectionProblem, PublicIpResult } from "../../shared/api.ts";
import {
  analyzeConnectionString,
  ConnectionStringError,
  type ConnectionStringInfo,
  cleanPastedConnectionString,
  maskConnectionString,
  separatePassword,
  throughContainerHost,
  withPassword,
} from "../../shared/connection-string.ts";
import { describeError } from "../api.ts";
import { BrandLogo } from "../components/brand.tsx";
import { Button } from "../components/button.tsx";
import {
  connectionStringSuggestions,
  LocalhostHint,
  ReachedThroughNotice,
} from "../components/container-host.tsx";
import { CheckboxField, TextAreaField, TextField } from "../components/field.tsx";
import { FillSuggestions } from "../components/fill-suggestions.tsx";
import { KeyValueList, Notice, PageHeader, Panel } from "../components/layout.tsx";
import { type FlowStep, StepFlow } from "../components/step-flow.tsx";
import { useApi, useSession } from "../context.tsx";
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

/**
 * The connection string to save after a successful check: the one checked, or, when the
 * console had to reach a `localhost` database through the host machine (it runs in
 * Docker), the same string pointing at host.docker.internal.
 */
export function savedUri(result: {
  readonly uri: string;
  readonly check: ConnectionCheckResult;
}): string {
  if (result.check.reachedThrough === undefined) return result.uri;
  return throughContainerHost(result.uri) ?? result.uri;
}

/** The steps of the welcome flow, in order (see the file header). */
export type WelcomeStepId = "connect" | "details" | "browse";

/**
 * One-click names for the checked connection: the names taken from the server's answer
 * and from the string itself (cluster, replica set or host), then the usual roles,
 * the likelier one first ("Production" for a production database, "Local dev" for
 * this computer). Duplicates are dropped by FillSuggestions.
 */
export function connectionNameSuggestions(
  fromServer: string,
  fromString: string | undefined,
  production: boolean,
): (string | undefined)[] {
  const roles = production
    ? ["Production", "Staging", "Local dev"]
    : ["Local dev", "Staging", "Production"];
  return [fromServer, fromString, ...roles];
}

/** The welcome page. */
export function WelcomePage() {
  const client = useApi();
  // In Docker, quick fill offers host.docker.internal rather than localhost.
  const inContainer = useSession().session.inContainer === true;
  const [text, setText] = useState("");
  const [password, setPassword] = useState("");
  const [checking, setChecking] = useState(false);
  const [result, setResult] = useState<
    { readonly uri: string; readonly check: ConnectionCheckResult } | undefined
  >(undefined);
  // Two separate errors, each shown on the step it belongs to: a failed check request
  // on "Connect", a failed save on "Details".
  const [checkError, setCheckError] = useState<string | undefined>(undefined);
  const [saveError, setSaveError] = useState<string | undefined>(undefined);
  const [name, setName] = useState("");
  const [production, setProduction] = useState(true);
  const [saving, setSaving] = useState(false);
  /** The step the user is on. "browse" is never opened: saving leaves the page. */
  const [step, setStep] = useState<WelcomeStepId>("connect");

  const understood = understand(text);
  const uri = uriToSend(understood, password);
  const host = understood.info?.hosts[0];
  const succeeded = result?.check.ok === true;
  // "Details" only exists for a checked connection: without one, the flow is on
  // "Connect" whatever the last step was (a changed string clears the check).
  const current: WelcomeStepId = succeeded ? step : "connect";

  // After a successful check the flow moves on to "Details" by itself. Focus goes to
  // the new step's panel (as StepFlow's own Next button does), so screen readers
  // announce "Connected" instead of staying on a field that is now hidden.
  const detailsRef = useRef<HTMLDivElement>(null);
  const focusDetails = useRef(false);
  useEffect(() => {
    if (!focusDetails.current || current !== "details") return;
    focusDetails.current = false;
    // The panel StepFlow wraps around the step's content; it is focusable from script.
    detailsRef.current?.closest<HTMLElement>('[role="tabpanel"]')?.focus();
  }, [current]);

  /** Checks `target` (when complete) and, when it connects, moves on to "Details". */
  const check = async (target: string | undefined) => {
    if (target === undefined) return;
    setChecking(true);
    setResult(undefined);
    setCheckError(undefined);
    try {
      const answer = await client.call("POST /api/connections/check", { uri: target });
      setResult({ uri: target, check: answer });
      setName(answer.suggestedName);
      setProduction(answer.production.suggested);
      if (answer.ok) {
        focusDetails.current = true;
        setStep("details");
      }
    } catch (failure) {
      setCheckError(describeError(failure));
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

  /** Saves the checked connection and opens its live data browser. */
  const save = async () => {
    // The button is disabled for these too; this also covers any other way of saving.
    if (result === undefined || nameProblem !== undefined) return;
    setSaving(true);
    setSaveError(undefined);
    try {
      const created = await client.call("POST /api/connections", {
        name: name.trim(),
        uri: savedUri(result),
        production,
      });
      navigate(`/connections/${encodeURIComponent(created.id)}/data`);
    } catch (failure) {
      setSaveError(describeError(failure));
      setSaving(false);
    }
  };

  /** "Skip for now": remembered for this session, then the overview. */
  const skip = () => {
    rememberWelcomeSkipped();
    navigate("/");
  };

  // A check that ran and failed, or could not run: the "Connect" tab says so.
  const checkFailed = checkError !== undefined || (result !== undefined && !result.check.ok);
  // The server stores names of at most 100 characters (routes/connections.ts).
  const nameProblem =
    name.trim() === ""
      ? "Give the connection a name."
      : name.trim().length > 100
        ? "Use at most 100 characters."
        : undefined;
  const nameMissing = nameProblem !== undefined;

  // ---- step 1: Connect --------------------------------------------------------------
  const connectStep = (
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
        // "Quick fill": a MongoDB next to the console, in one click.
        suggestions={
          <FillSuggestions
            field="Connection string"
            lead="Quick fill"
            items={connectionStringSuggestions(inContainer)}
            current={text}
            onPick={(value) => {
              setText(value);
              setResult(undefined);
            }}
          />
        }
      />
      <LocalhostHint
        uri={text}
        inContainer={inContainer}
        onUse={(value) => {
          setText(value);
          setResult(undefined);
        }}
      />
      {understood.info?.usernamePlaceholder === undefined ? null : (
        <Notice tone="warning" title="The user name is missing">
          Replace <code>{understood.info.usernamePlaceholder}</code> with your database user's name.
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
              <code>{understood.info.passwordPlaceholder}</code>), so it is never shown on screen.
              Any characters are fine; they are encoded for you.
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
      {checking ? (
        <p className="muted" role="status">
          Connecting to {host ?? "the server"}. This can take up to 10 seconds.
        </p>
      ) : null}
      {checkError === undefined ? null : (
        <Notice tone="danger" title="That did not work">
          {checkError}
        </Notice>
      )}
      {result !== undefined && !result.check.ok && result.check.problem !== undefined ? (
        <ProblemNotice problem={result.check.problem} />
      ) : null}
    </div>
  );

  // ---- step 2: Details (only rendered with a checked connection) --------------------
  const detailsStep =
    result?.check.ok === true ? (
      <div className="stack-vertical" ref={detailsRef}>
        <ReachedThroughNotice result={result.check} />
        <Notice tone="success" title="Connected">
          <KeyValueList
            items={[
              ["Database", maskConnectionString(savedUri(result))],
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
              Free and Flex clusters are throttled by Atlas. Backups adapt by themselves: they read
              gently so your app keeps its share.
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
          error={nameProblem}
          suggestions={
            <FillSuggestions
              field="Name"
              items={connectionNameSuggestions(
                result.check.suggestedName,
                understood.info?.suggestedName,
                result.check.production.suggested,
              )}
              current={name}
              onPick={setName}
            />
          }
        />
        <CheckboxField
          label="This is a production database"
          checked={production}
          onChecked={setProduction}
          hint={`${result.check.production.reason} Restoring into a production database needs an admin and the name typed to confirm.`}
        />
        {saveError === undefined ? null : (
          <Notice tone="danger" title="Could not save">
            {saveError}
          </Notice>
        )}
      </div>
    ) : null;

  // ---- the flow ---------------------------------------------------------------------
  const steps: readonly FlowStep<WelcomeStepId>[] = [
    {
      id: "connect",
      title: "Connect",
      hint: "Paste a connection string",
      state: succeeded ? "done" : checkFailed ? "error" : undefined,
      content: connectStep,
    },
    {
      id: "details",
      title: "Details",
      hint: "Name it, mark production",
      // Opens once the connection has been checked.
      locked: !succeeded,
      state: succeeded && (nameMissing || saveError !== undefined) ? "error" : undefined,
      content: detailsStep,
    },
    {
      // The destination, shown so the flow reads to its end: "Save and browse data"
      // opens it (the live data browser with "Back up now"), so it is never a tab of
      // its own here.
      id: "browse",
      title: "Browse and back up",
      hint: "After saving",
      locked: true,
      content: (
        <p className="muted">
          Your data, with “Back up now” one click away. Saving the connection opens it.
        </p>
      ),
    },
  ];

  // The step's own action takes Next's place while the step after it is locked:
  // "Check connection" on Connect (until it connects), "Save and browse data" on Details.
  const finish =
    current === "connect" ? (
      <Button
        variant="primary"
        busy={checking}
        disabled={uri === undefined}
        onClick={() => void check(uri)}
      >
        {checking ? "Connecting…" : "Check connection"}
      </Button>
    ) : (
      <Button variant="primary" busy={saving} disabled={nameMissing} onClick={() => void save()}>
        Save and browse data
      </Button>
    );

  return (
    <div className="welcome">
      <div className="welcome-hero" aria-hidden="true">
        <BrandLogo size={44} />
      </div>
      <PageHeader
        title="Connect your database"
        description="Paste a MongoDB connection string. You can browse your data and back it up in the next step."
        actions={
          <Button variant="ghost" size="small" onClick={skip}>
            Skip for now
          </Button>
        }
      />

      {/* One panel holds the whole flow: tabs, the current step, Back / Next. */}
      <Panel>
        <StepFlow
          label="Getting started"
          steps={steps}
          current={current}
          onStep={setStep}
          finish={finish}
        />
      </Panel>
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
