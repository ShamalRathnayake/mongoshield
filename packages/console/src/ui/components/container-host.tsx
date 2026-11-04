/**
 * Help for the most common container mistake: `localhost` in a connection string.
 *
 * Inside a Docker or Podman container, `localhost` is the container itself, not the
 * computer it runs on, so `mongodb://localhost:27017` finds no database. The computer
 * is `host.docker.internal` (Podman: `host.containers.internal`), but that name exists
 * by default only on Docker Desktop, OrbStack and Podman; on Linux Docker Engine it
 * needs `--add-host=host.docker.internal:host-gateway`. The server looks the name up
 * (SessionInfo.container) so the pages only offer it where it works.
 *
 * - `LocalhostHint`, while typing: the string points at localhost (or at the host name)
 *   in such a container. When the name resolves it offers a one-click "Use
 *   host.docker.internal"; when it does not, it explains how to create it (also while
 *   the field is empty, in place of the quick fill for "this computer").
 * - `ReachedThroughNotice`, after a check: localhost was refused, the console tried
 *   the computer it runs on by itself, and that worked. The connection is saved with
 *   that address.
 *
 * `connectionStringSuggestions` gives the quick-fill strings that make sense where the
 * console runs, so a console in Docker never suggests localhost, and never suggests
 * host.docker.internal where it does not resolve. In Kubernetes and with host
 * networking `localhost` means what it says, so it is kept.
 */

import type { ConnectionTestResult, ContainerEnvironment } from "../../shared/api.ts";
import {
  analyzeConnectionString,
  isContainerHostAlias,
  throughContainerHost,
  withDirectConnection,
} from "../../shared/connection-string.ts";
import {
  addHostFlag,
  composeExtraHosts,
  hostAliasMissing,
  localhostIsContainer,
  runtimeName,
  usableHostAlias,
} from "../../shared/container.ts";
import { Button } from "./button.tsx";
import type { FillSuggestion } from "./fill-suggestions.tsx";
import { Notice } from "./layout.tsx";

/**
 * Shown under a connection string that points at localhost (or at the host alias)
 * while the console runs in a Docker or Podman container; renders nothing otherwise.
 */
export function LocalhostHint(props: {
  /** The connection string as shown (its password may be a placeholder). */
  uri: string;
  /** Where the console runs (from the session); absent: not in a container. */
  container: ContainerEnvironment | undefined;
  /** Called with the same string pointing at the host alias. */
  onUse: (uri: string) => void;
}) {
  const { container } = props;
  if (container === undefined || !localhostIsContainer(container.kind)) return null;
  const uri = props.uri.trim();
  const usable = usableHostAlias(container);
  if (usable !== undefined) {
    const onHost = throughContainerHost(uri, usable);
    if (onHost === undefined) return null;
    return (
      <Notice tone="info" title="localhost is the console's own container here">
        <p>
          The console runs in {runtimeName(container.kind)}, so <code>localhost</code> does not
          reach this computer. For a database on this computer use <code>{usable}</code>; the
          console also tries it by itself if localhost does not answer.
        </p>
        <Button size="small" onClick={() => props.onUse(onHost)}>
          Use {usable}
        </Button>
      </Notice>
    );
  }
  // The alias does not resolve: explain how to create it, in place of the quick fill
  // while the field is empty, and for a string that points at localhost or the alias.
  const pointsAtThisComputer =
    uri === "" ||
    throughContainerHost(uri) !== undefined ||
    hostsOf(uri).some(isContainerHostAlias);
  if (!hostAliasMissing(container) || !pointsAtThisComputer) return null;
  return <HostAliasMissingNotice container={container} />;
}

/**
 * How to reach a database on this computer when the host alias does not resolve, as on
 * Linux Docker Engine started without `--add-host`. Shown by {@link LocalhostHint}.
 */
function HostAliasMissingNotice(props: { container: ContainerEnvironment | undefined }) {
  const { container } = props;
  if (container?.hostAlias === undefined || !hostAliasMissing(container)) return null;
  const alias = container.hostAlias;
  return (
    <Notice tone="info" title={`${alias} does not exist in this container`}>
      <p>
        The console runs in {runtimeName(container.kind)}, so <code>localhost</code> is its own
        container. To reach a database on this computer, restart the console with{" "}
        <code>{addHostFlag(alias)}</code> (Docker Compose: <code>{composeExtraHosts(alias)}</code>),
        then use <code>{withDirectConnection(`mongodb://${alias}:27017`)}</code>.
      </p>
      <p>
        On Linux, mongod listens only on 127.0.0.1 by default; also let it listen on the Docker
        bridge (<code>bindIp: 127.0.0.1,172.17.0.1</code>). A database in another container is
        reached by its container name on a shared network instead.
      </p>
    </Notice>
  );
}

/** Shown after a check or test that got through on the host machine's address. */
export function ReachedThroughNotice(props: { result: ConnectionTestResult | undefined }) {
  const reached = props.result?.reachedThrough;
  if (reached === undefined) return null;
  return (
    <Notice tone="success" title={`Connected through ${reached.to}`}>
      <code>{reached.from}</code> is the console's own container, so the console connected to this
      computer at <code>{reached.to}</code> instead. The connection uses that address from now on.
    </Notice>
  );
}

/** The quick-fill strings that make sense where the console runs (see the file header). */
export function connectionStringSuggestions(
  container: ContainerEnvironment | undefined,
): FillSuggestion[] {
  const kind = container?.kind ?? "none";
  const suggestions: FillSuggestion[] = [];
  if (localhostIsContainer(kind)) {
    // Only a name that resolves; otherwise HostAliasMissingNotice explains --add-host.
    const alias = usableHostAlias(container);
    if (alias !== undefined) {
      suggestions.push({
        // directConnection: a single-node replica set on the host names its member
        // localhost:27017, which the driver would then try from inside the container.
        value: withDirectConnection(`mongodb://${alias}:27017`),
        label: `This computer (console in ${runtimeName(kind)})`,
        hint: "MongoDB running on the machine that runs the console's container",
      });
    }
  } else {
    suggestions.push({
      value: "mongodb://localhost:27017",
      label: "localhost:27017",
      hint:
        kind === "kubernetes"
          ? "MongoDB in another container of the console's pod (a sidecar)"
          : "MongoDB on the same machine as the console",
    });
  }
  suggestions.push(
    kind === "kubernetes"
      ? {
          value: "mongodb://mongo:27017",
          label: "A Service (mongo)",
          hint: "A Kubernetes Service called “mongo” in the console's namespace",
        }
      : {
          value: "mongodb://mongo:27017",
          label: "Another container (mongo)",
          hint: "A container called “mongo” on the same Docker network",
        },
    {
      value: "mongodb+srv://<username>:<db_password>@cluster0.xxxxx.mongodb.net/",
      label: "Atlas template",
      hint: "Replace <username> and cluster0.xxxxx with your cluster's address; the password goes in its own field",
    },
  );
  return suggestions;
}

/** The hosts of a connection string, or none when it does not parse (yet). */
function hostsOf(uri: string): readonly string[] {
  try {
    return analyzeConnectionString(uri).hosts;
  } catch {
    return [];
  }
}
