/**
 * Where the console may be told to send requests: a guard for the URLs admins enter
 * (notification webhooks, storage endpoints) and for connection strings that would
 * authenticate with the console's own cloud identity.
 *
 * The console runs with an identity of its own: an instance role, a Kubernetes service
 * account, an Azure managed identity. An admin account (or whoever stole one) is not
 * automatically trusted with it. Without this guard:
 *
 *   - a webhook URL such as http://169.254.169.254/… is blind SSRF into the cloud's
 *     metadata service, which hands out exactly those credentials;
 *   - an Azure storage location without stored credentials uses the managed identity,
 *     and with `endpoint=https://attacker.example` the SDK sends its bearer token there;
 *   - `authMechanism=MONGODB-OIDC&authMechanismProperties=ENVIRONMENT:k8s` (or azure,
 *     gcp) makes the MongoDB driver fetch the workload's token and send it to whatever
 *     server the connection string names.
 *
 * MONGOSHIELD_ALLOW_UNSAFE_TARGETS=true turns the guard off, for deployments where the
 * admins are trusted with the console's identity (or where a webhook really lives on a
 * link-local address).
 *
 * Limits: names are checked as written. A public name that resolves to a metadata
 * address is not caught here (the check would need to resolve and pin addresses at
 * connection time, inside the library and the SDKs).
 */

import { BlockList, isIP } from "node:net";

/** Host names of cloud metadata services (AWS, GCP, Azure, OpenStack-style). */
const METADATA_NAMES = new Set([
  "metadata",
  "metadata.google.internal",
  "metadata.goog",
  "instance-data",
  "instance-data.ec2.internal",
]);

/**
 * Addresses no webhook or storage endpoint has a reason to use: link-local ranges
 * (where AWS, GCP, Azure and OCI serve instance metadata, 169.254.169.254), Alibaba's
 * metadata address, AWS's IPv6 metadata address, and "this network" (0.0.0.0/8, which
 * some stacks route to the local host).
 */
const UNSAFE_ADDRESSES = (() => {
  const list = new BlockList();
  list.addSubnet("169.254.0.0", 16, "ipv4");
  list.addSubnet("0.0.0.0", 8, "ipv4");
  list.addAddress("100.100.100.200", "ipv4");
  list.addSubnet("fe80::", 10, "ipv6");
  list.addAddress("fd00:ec2::254", "ipv6");
  list.addAddress("::", "ipv6");
  return list;
})();

/** Domains of Azure Blob Storage endpoints (public cloud, China, US Government). */
const AZURE_STORAGE_SUFFIXES = [
  ".core.windows.net",
  ".core.chinacloudapi.cn",
  ".core.usgovcloudapi.net",
];

/** The hint every refusal ends with. */
export const UNSAFE_TARGET_HINT =
  "If the console's admins may use its cloud identity and reach these addresses, start the console with MONGOSHIELD_ALLOW_UNSAFE_TARGETS=true.";

/**
 * Why the console should not send requests to `hostname` (a URL's host name, IPv6 in
 * brackets or not), or `undefined` when it may. The WHATWG URL parser has already
 * turned forms like `2852039166` or `0xA9FEA9FE` into dotted IPv4 by then.
 */
export function unsafeHostReason(hostname: string): string | undefined {
  const host = hostname
    .toLowerCase()
    .replace(/^\[(.*)\]$/, "$1")
    .replace(/\.$/, "");
  if (METADATA_NAMES.has(host)) return `${host} is a cloud metadata service`;
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(host)?.[1];
  const address = mapped ?? host;
  const family = isIP(address);
  if (family !== 0 && UNSAFE_ADDRESSES.check(address, family === 4 ? "ipv4" : "ipv6")) {
    return `${address} is a link-local or cloud metadata address`;
  }
  return undefined;
}

/**
 * Why a notification URL may not be used, or `undefined`. Only its host is checked;
 * the scheme (http/https) is checked where the URL is parsed.
 */
export function unsafeWebhookReason(url: string, allowUnsafe: boolean): string | undefined {
  if (allowUnsafe) return undefined;
  let hostname: string;
  try {
    hostname = new URL(url).hostname;
  } catch {
    return undefined;
  }
  return unsafeHostReason(hostname);
}

/**
 * Why an Azure storage endpoint may not be used with the console's managed identity
 * (no stored credentials), or `undefined`: the SDK sends the identity's bearer token to
 * the endpoint, so it must be Azure's own.
 */
export function unsafeManagedIdentityEndpointReason(hostname: string): string | undefined {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  if (AZURE_STORAGE_SUFFIXES.some((suffix) => host.endsWith(suffix))) return undefined;
  return `without stored credentials the console's own Azure identity would send its token to ${host}, which is not an Azure Storage endpoint`;
}

/**
 * Why a MongoDB connection string may not be used, or `undefined`: MONGODB-OIDC with an
 * `ENVIRONMENT` property makes the driver fetch the console's workload token (Kubernetes,
 * Azure, GCP) and send it to the server the string names. The one check for every way a
 * connection string enters the console: the connection routes, the connection check
 * and config import (its document and its `secrets.uri`).
 */
export function unsafeConnectionUriReason(uri: string, allowUnsafe: boolean): string | undefined {
  if (allowUnsafe) return undefined;
  const queryStart = uri.indexOf("?");
  if (queryStart === -1) return undefined;
  // Option names are case-insensitive; the last occurrence wins, as in the driver.
  const options = new Map<string, string>();
  for (const [name, value] of new URLSearchParams(uri.slice(queryStart + 1))) {
    options.set(name.toLowerCase(), value);
  }
  const mechanism = options.get("authmechanism")?.toUpperCase();
  const properties = options.get("authmechanismproperties") ?? "";
  if (mechanism === "MONGODB-OIDC" && /(^|,)\s*ENVIRONMENT\s*:/i.test(properties)) {
    return "authMechanism=MONGODB-OIDC with an ENVIRONMENT property authenticates with the console's own workload identity";
  }
  return undefined;
}
