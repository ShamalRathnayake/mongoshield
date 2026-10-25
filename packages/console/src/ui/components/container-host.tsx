/**
 * Help for the most common Docker mistake: `localhost` in a connection string.
 *
 * Inside a container, `localhost` is the container itself, not the computer it runs
 * on, so `mongodb://localhost:27017` finds no database. The console handles it in two
 * places, and these two notices explain what happens:
 *
 * - `LocalhostHint`, while typing: the string points at localhost and the console runs
 *   in a container. It says so and offers a one-click "Use host.docker.internal".
 * - `ReachedThroughNotice`, after a check: localhost was refused, the console tried
 *   the computer it runs on by itself (`host.docker.internal`), and that worked. The
 *   connection is saved with that address.
 *
 * `connectionStringSuggestions` gives the quick-fill strings that make sense where the
 * console runs, so a console in Docker never suggests localhost in the first place.
 */

import type { ConnectionTestResult } from "../../shared/api.ts";
import { CONTAINER_HOST, throughContainerHost } from "../../shared/connection-string.ts";
import { Button } from "./button.tsx";
import type { FillSuggestion } from "./fill-suggestions.tsx";
import { Notice } from "./layout.tsx";

/**
 * Shown under a connection string that points at localhost while the console runs in
 * a container; renders nothing otherwise (or when the string has other hosts too).
 */
export function LocalhostHint(props: {
  /** The connection string as shown (its password may be a placeholder). */
  uri: string;
  inContainer: boolean;
  /** Called with the same string pointing at host.docker.internal. */
  onUse: (uri: string) => void;
}) {
  const onHost = props.inContainer ? throughContainerHost(props.uri.trim()) : undefined;
  if (onHost === undefined) return null;
  return (
    <Notice tone="info" title="localhost is the console's own container here">
      <p>
        The console runs in Docker, so <code>localhost</code> does not reach this computer. For a
        database on this computer use <code>{CONTAINER_HOST}</code>; the console also tries it by
        itself if localhost does not answer.
      </p>
      <Button size="small" onClick={() => props.onUse(onHost)}>
        Use {CONTAINER_HOST}
      </Button>
    </Notice>
  );
}

/** Shown after a check or test that got through on the host machine's address. */
export function ReachedThroughNotice(props: { result: ConnectionTestResult | undefined }) {
  const reached = props.result?.reachedThrough;
  if (reached === undefined) return null;
  return (
    <Notice tone="success" title={`Connected through ${reached.to}`}>
      <code>{reached.from}</code> is the console's own container in Docker, so the console connected
      to this computer at <code>{reached.to}</code> instead. The connection uses that address from
      now on.
    </Notice>
  );
}

/**
 * Connection strings for a MongoDB next to the console, one click to fill in. The first
 * two are for "this computer": host.docker.internal from a container, localhost when the
 * console runs directly on the machine; `connectionStringSuggestions` offers the right one.
 */
const CONNECTION_STRING_SUGGESTIONS: readonly FillSuggestion[] = [
  {
    value: "mongodb://host.docker.internal:27017",
    label: "This computer (console in Docker)",
    hint: "MongoDB running on the machine that runs the console's container",
  },
  {
    value: "mongodb://localhost:27017",
    label: "localhost:27017",
    hint: "MongoDB on the same machine, when the console is not in a container",
  },
  {
    value: "mongodb://mongo:27017",
    label: "Another container (mongo)",
    hint: "A container called “mongo” on the same Docker network",
  },
  {
    value: "mongodb+srv://<username>:<db_password>@cluster0.xxxxx.mongodb.net/",
    label: "Atlas template",
    hint: "Replace <username> and cluster0.xxxxx with your cluster's address; the password goes in its own field",
  },
];

/** The quick-fill strings that make sense where the console runs (see above). */
export function connectionStringSuggestions(inContainer: boolean): FillSuggestion[] {
  return CONNECTION_STRING_SUGGESTIONS.filter((suggestion) =>
    inContainer
      ? !suggestion.value.includes("//localhost")
      : !suggestion.value.includes("host.docker.internal"),
  );
}
