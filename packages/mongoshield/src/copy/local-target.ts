/**
 * Deciding whether a connection string points at this machine.
 *
 * `mongoshield pull` copies production data for local development, so by default it
 * only writes to a local MongoDB: a typo in `--to` must never send production data
 * (even masked) to some other server. A URI is local when EVERY host in it is a
 * loopback name or address, or a Unix socket. `mongodb+srv://` URIs are never local:
 * their hosts come from DNS.
 */

/** Host names that always mean this machine. */
const LOCAL_HOST_NAMES = new Set(["localhost", "127.0.0.1", "::1", "0.0.0.0"]);

/** Matches `scheme://[userinfo@]hosts[/path][?query]`. */
const URI_PARTS = /^(mongodb(?:\+srv)?):\/\/(?:[^@/]*@)?([^/?]*)/i;

/** True when every host of a `mongodb://` URI is on this machine. */
export function isLocalMongoUri(uri: string): boolean {
  const match = URI_PARTS.exec(uri.trim());
  const scheme = match?.[1]?.toLowerCase();
  const hostList = match?.[2];
  if (scheme !== "mongodb" || hostList === undefined || hostList === "") return false;
  return hostList.split(",").every((host) => isLocalHost(host.trim()));
}

/** One `host[:port]` entry: a loopback name or address, `*.localhost`, or a socket path. */
function isLocalHost(entry: string): boolean {
  const decoded = safeDecode(entry);
  // Unix domain sockets are percent-encoded paths ending in `.sock`.
  if (decoded.startsWith("/") && decoded.endsWith(".sock")) return true;
  const host = hostWithoutPort(decoded).toLowerCase();
  if (LOCAL_HOST_NAMES.has(host) || host.endsWith(".localhost")) return true;
  // The whole 127.0.0.0/8 block is loopback.
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}

/** `[::1]:27017` → `::1`, `localhost:27017` → `localhost`. */
function hostWithoutPort(entry: string): string {
  if (entry.startsWith("[")) {
    const end = entry.indexOf("]");
    return end === -1 ? entry : entry.slice(1, end);
  }
  const colon = entry.lastIndexOf(":");
  return colon === -1 ? entry : entry.slice(0, colon);
}

function safeDecode(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}
