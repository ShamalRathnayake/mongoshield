/**
 * Making sense of a pasted MongoDB connection string, shared by the onboarding page
 * (src/ui/pages/welcome.tsx) and the server (src/server/routes/connections.ts).
 *
 * People paste connection strings from many places, and the Atlas "Connect" dialog in
 * particular hands out strings that do not work as they are:
 *
 *   mongodb+srv://shamal:<db_password>@cluster0.abcde.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0
 *   mongosh "mongodb+srv://cluster0.abcde.mongodb.net/" --apiVersion 1 --username shamal
 *
 * This module turns such text into a usable URI without ever showing the password:
 *
 *   - {@link cleanPastedConnectionString} strips whitespace and line breaks, quotes, and a
 *     `mongosh "…"` wrapper (taking its `--username` along);
 *   - {@link analyzeConnectionString} finds the parts: user, a password placeholder such as
 *     `<db_password>` (the UI then asks for the password in a separate masked field),
 *     hosts, SRV, replica set, Atlas or local, a suggested name, and whether it looks like
 *     production;
 *   - {@link withPassword} puts a typed password in, percent-encoded;
 *   - {@link encodeCredentials} fixes passwords pasted with unencoded special characters
 *     (`@ : / ? # [ ] %` and spaces), which otherwise break the URI's structure.
 *
 * Pure functions with no Node or browser APIs, so both sides run the same code.
 */

/** The parts of a connection string that the onboarding flow cares about. */
export interface ConnectionStringInfo {
  /** `mongodb+srv` (DNS seed list) or `mongodb` (hosts listed). */
  readonly scheme: "mongodb" | "mongodb+srv";
  /** The user name, decoded; absent without credentials. */
  readonly username?: string;
  /** True when a real password is present (not a placeholder). */
  readonly hasPassword: boolean;
  /**
   * A placeholder where the password belongs, exactly as pasted (e.g. `<db_password>`,
   * `<password>`): Atlas's copy-paste strings carry one. Ask for the password instead.
   */
  readonly passwordPlaceholder?: string;
  /** A placeholder where the user name belongs (`<username>`). The user must type it. */
  readonly usernamePlaceholder?: string;
  /** True when the user name or password has characters that must be percent-encoded. */
  readonly credentialsNeedEncoding: boolean;
  /** Host names (or IPs) without ports, in order. For SRV: the one DNS name. */
  readonly hosts: readonly string[];
  /** The `replicaSet` option, if given. */
  readonly replicaSet?: string;
  /** Any host is an Atlas host (`*.mongodb.net`, `*.mongodbgov.net`). */
  readonly atlas: boolean;
  /** Every host is this machine or a development host (localhost, docker names, …). */
  readonly local: boolean;
  /** A short, readable name for the connection (Atlas cluster, replica set or host). */
  readonly suggestedName: string;
  /** Whether to mark the connection production by default, and why, in plain words. */
  readonly production: { readonly suggested: boolean; readonly reason: string };
}

/** Why a pasted text is not a connection string, in plain words. */
export class ConnectionStringError extends Error {
  override readonly name = "ConnectionStringError";
}

/** Longest accepted connection string (as on the server). */
export const MAX_CONNECTION_STRING_LENGTH = 4096;

/** `mongodb://` or `mongodb+srv://`, case-insensitive. */
const SCHEME_PATTERN = /^(mongodb(?:\+srv)?):\/\/(.*)$/is;

/** A comma-separated host list (`a:27017,b:27017`, `[::1]:27017`), as far as we accept one. */
const HOST_LIST_PATTERN = /^[A-Za-z0-9._%\-[\]:,]+$/;

/** A placeholder such as `<password>` or `<db_password>`, as Atlas writes them. */
const PLACEHOLDER_PATTERN = /^<[^<>]*>$/;

/**
 * Characters that must be percent-encoded inside the user name or password: they have
 * a meaning in the URI's structure (RFC 3986 gen-delims, plus space). `%` counts only
 * when it does not start a valid `%XX` escape.
 */
const RESERVED_IN_CREDENTIALS = /[@:/?#[\]\s]|%(?![0-9A-Fa-f]{2})/;

/** Atlas host names (the same rule as the library's `isAtlasHost`). */
const ATLAS_HOST_PATTERN = /\.mongodb(?:-dev|-qa|-stage)?\.net$|\.mongodbgov\.net$/i;

/**
 * Cleans pasted text into a connection string:
 *
 *   - removes surrounding quotes (`"…"`, `'…'`, backticks) and whitespace;
 *   - unwraps `mongosh "<uri>" [--username <user>] [other options]`, the form Atlas offers
 *     for the shell, adding the user name to the URI so the password can be asked for;
 *   - removes line breaks inside, with the spaces around them (a long string copied from
 *     a wrapped terminal or a document often contains them; a valid URI never does).
 *     Other spaces are kept: inside a raw password they are part of it, and
 *     {@link encodeCredentials} encodes them;
 *
 * Returns the cleaned text; it is not validated here (see {@link analyzeConnectionString}).
 */
export function cleanPastedConnectionString(text: string): string {
  let value = text.trim();
  let username: string | undefined;

  const shell = /^mongosh(?:\.exe)?\s+(.*)$/is.exec(value);
  if (shell !== null) {
    const words = splitShellWords(shell[1] ?? "");
    const uri = words.find((word) => SCHEME_PATTERN.test(word));
    const userFlag = words.findIndex((word) => word === "--username" || word === "-u");
    if (userFlag !== -1) username = words[userFlag + 1];
    value = uri ?? value;
  }

  value = stripQuotes(value).replace(/[ \t]*[\r\n]+[ \t]*/g, "");
  if (username !== undefined && username !== "") value = addUsername(value, username);
  return value;
}

/**
 * Analyzes a connection string (clean it first). Never returns or logs the password.
 *
 * @throws ConnectionStringError when it is not a MongoDB connection string at all.
 */
export function analyzeConnectionString(uri: string): ConnectionStringInfo {
  const parts = splitConnectionString(uri);
  const hosts = parts.hostList
    .split(",")
    .map(hostWithoutPort)
    .filter((host) => host !== "");
  if (hosts.length === 0) {
    throw new ConnectionStringError("The connection string has no host after mongodb://.");
  }
  const replicaSet = optionValue(parts.query, "replicaSet");
  const atlas = hosts.some((host) => ATLAS_HOST_PATTERN.test(host));
  const local = hosts.every(isDevelopmentHost);
  const username = parts.username === undefined ? undefined : safeDecode(parts.username);
  const passwordPlaceholder =
    parts.password !== undefined && PLACEHOLDER_PATTERN.test(parts.password)
      ? parts.password
      : undefined;
  const usernamePlaceholder =
    username !== undefined && PLACEHOLDER_PATTERN.test(username) ? username : undefined;
  const credentialsNeedEncoding =
    (parts.username !== undefined &&
      usernamePlaceholder === undefined &&
      RESERVED_IN_CREDENTIALS.test(parts.username)) ||
    (parts.password !== undefined &&
      passwordPlaceholder === undefined &&
      RESERVED_IN_CREDENTIALS.test(parts.password));

  return {
    scheme: parts.scheme,
    ...(username === undefined ? {} : { username }),
    hasPassword:
      parts.password !== undefined && parts.password !== "" && passwordPlaceholder === undefined,
    ...(passwordPlaceholder === undefined ? {} : { passwordPlaceholder }),
    ...(usernamePlaceholder === undefined ? {} : { usernamePlaceholder }),
    credentialsNeedEncoding,
    hosts,
    ...(replicaSet === undefined ? {} : { replicaSet }),
    atlas,
    local,
    suggestedName: suggestName(hosts, replicaSet, parts.scheme),
    production: productionGuess(atlas, local),
  };
}

/**
 * Puts a password into a connection string: in place of a placeholder, or after the
 * user name when there is none. The password is percent-encoded, so any character works.
 *
 * @throws ConnectionStringError when the string has no user name to go with it.
 */
export function withPassword(uri: string, password: string): string {
  const parts = splitConnectionString(uri);
  if (parts.username === undefined) {
    throw new ConnectionStringError(
      "The connection string has no user name (user:password@host), so a password cannot be added.",
    );
  }
  return joinConnectionString({ ...parts, password: encodeURIComponent(password) });
}

/** The placeholder {@link separatePassword} leaves where the password was. */
export const PASSWORD_PLACEHOLDER = "<password>";

/**
 * Takes the password out of a connection string, leaving {@link PASSWORD_PLACEHOLDER}
 * in its place, so a page can show the string without it and keep the password in a
 * masked field. The password comes back decoded (as the user would type it); a raw,
 * unencoded one comes back as it was. Strings without a real password are returned
 * unchanged with no password. {@link withPassword} puts it back, encoded.
 */
export function separatePassword(uri: string): {
  readonly uri: string;
  readonly password?: string;
} {
  let parts: ConnectionStringParts;
  try {
    parts = splitConnectionString(uri);
  } catch {
    return { uri };
  }
  const raw = parts.password;
  if (raw === undefined || raw === "" || PLACEHOLDER_PATTERN.test(raw)) return { uri };
  const password = RESERVED_IN_CREDENTIALS.test(raw) ? raw : safeDecode(raw);
  return { uri: joinConnectionString({ ...parts, password: PASSWORD_PLACEHOLDER }), password };
}

/**
 * Percent-encodes a user name and password that were pasted raw (with `@`, `:`, `/`, …
 * inside them). Already-encoded parts are kept as they are. `changed` says whether
 * anything was encoded, so the UI can tell the user (without showing the password).
 */
export function encodeCredentials(uri: string): {
  readonly uri: string;
  readonly changed: boolean;
} {
  const parts = splitConnectionString(uri);
  const username = encodeIfRaw(parts.username);
  const password = encodeIfRaw(parts.password);
  const changed = username !== parts.username || password !== parts.password;
  if (!changed) return { uri, changed: false };
  return {
    uri: joinConnectionString({
      ...parts,
      ...(username === undefined ? {} : { username }),
      ...(password === undefined ? {} : { password }),
    }),
    changed: true,
  };
}

/**
 * The connection string with its password replaced by `***`, for display. Unlike the
 * library's `redactMongoUri` it also copes with the raw, unencoded passwords this
 * module repairs, and it runs in the browser.
 */
export function maskConnectionString(uri: string): string {
  try {
    const parts = splitConnectionString(uri);
    if (parts.password === undefined || PLACEHOLDER_PATTERN.test(parts.password)) {
      return joinConnectionString(parts);
    }
    return joinConnectionString({ ...parts, password: "***" });
  } catch {
    // Not a connection string: show nothing of it rather than risk showing a password.
    return "mongodb://***";
  }
}

// ---------------------------------------------------------------------------
// Splitting and joining
// ---------------------------------------------------------------------------

/** A connection string cut into its pieces, all still as written (encoded). */
interface ConnectionStringParts {
  readonly scheme: "mongodb" | "mongodb+srv";
  readonly username?: string;
  readonly password?: string;
  readonly hostList: string;
  /** Everything after the host list: `/db?options`, possibly empty. */
  readonly rest: string;
  /** The options after `?` (without it), possibly empty. */
  readonly query: string;
}

/**
 * Splits a connection string. The user info ends at the LAST `@` that is followed by
 * something that looks like a host list: a raw password may itself contain `@`, `/` or
 * `?`, so the first `@` (or the first `/`) cannot be trusted.
 */
function splitConnectionString(uri: string): ConnectionStringParts {
  if (uri.length > MAX_CONNECTION_STRING_LENGTH) {
    throw new ConnectionStringError(
      `The connection string is longer than ${MAX_CONNECTION_STRING_LENGTH} characters.`,
    );
  }
  const match = SCHEME_PATTERN.exec(uri);
  if (match === null) {
    throw new ConnectionStringError(
      "A MongoDB connection string starts with mongodb:// or mongodb+srv://.",
    );
  }
  const scheme = (match[1] ?? "").toLowerCase() === "mongodb+srv" ? "mongodb+srv" : "mongodb";
  const body = match[2] ?? "";

  let userInfo: string | undefined;
  let afterUserInfo = body;
  for (let at = body.lastIndexOf("@"); at !== -1; at = body.lastIndexOf("@", at - 1)) {
    const candidate = body.slice(at + 1);
    const hostList = candidate.split(/[/?#]/, 1)[0] ?? "";
    if (hostList !== "" && HOST_LIST_PATTERN.test(hostList)) {
      userInfo = body.slice(0, at);
      afterUserInfo = candidate;
      break;
    }
    if (at === 0) break;
  }

  const hostEnd = afterUserInfo.search(/[/?]/);
  const hostList = hostEnd === -1 ? afterUserInfo : afterUserInfo.slice(0, hostEnd);
  const rest = hostEnd === -1 ? "" : afterUserInfo.slice(hostEnd);
  const questionMark = rest.indexOf("?");
  const query = questionMark === -1 ? "" : rest.slice(questionMark + 1);

  if (userInfo === undefined) return { scheme, hostList, rest, query };
  // The first ":" separates user and password; later ones belong to a raw password.
  const colon = userInfo.indexOf(":");
  if (colon === -1) return { scheme, username: userInfo, hostList, rest, query };
  return {
    scheme,
    username: userInfo.slice(0, colon),
    password: userInfo.slice(colon + 1),
    hostList,
    rest,
    query,
  };
}

function joinConnectionString(parts: ConnectionStringParts): string {
  const userInfo =
    parts.username === undefined
      ? ""
      : parts.password === undefined
        ? `${parts.username}@`
        : `${parts.username}:${parts.password}@`;
  return `${parts.scheme}://${userInfo}${parts.hostList}${parts.rest}`;
}

/** Adds a user name (from `mongosh --username`) to a URI that has none. */
function addUsername(uri: string, username: string): string {
  try {
    const parts = splitConnectionString(uri);
    if (parts.username !== undefined) return uri;
    // An empty placeholder makes the UI ask for the password, as for Atlas strings.
    return joinConnectionString({
      ...parts,
      username: encodeURIComponent(username),
      password: PASSWORD_PLACEHOLDER,
    });
  } catch {
    return uri;
  }
}

/** Encodes a user name or password unless it is already safely encoded (or a placeholder). */
function encodeIfRaw(value: string | undefined): string | undefined {
  if (value === undefined || PLACEHOLDER_PATTERN.test(value)) return value;
  if (!RESERVED_IN_CREDENTIALS.test(value)) return value;
  // Raw text: encode every character that needs it. Valid `%XX` escapes in a raw
  // password are ambiguous; we treat `%` as literal only where it cannot be an escape
  // (RESERVED_IN_CREDENTIALS), so a password like "50%off" is encoded, "a%20b" kept.
  return value.replace(/[^A-Za-z0-9\-._~!$&'()*+,;=%]|%(?![0-9A-Fa-f]{2})/g, (character) =>
    encodeURIComponent(character),
  );
}

// ---------------------------------------------------------------------------
// Hosts, names and production
// ---------------------------------------------------------------------------

/** `host:27017` → `host`; `[::1]:27017` → `::1`. */
function hostWithoutPort(host: string): string {
  const trimmed = safeDecode(host.trim());
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(trimmed);
  if (bracketed?.[1] !== undefined) return bracketed[1].toLowerCase();
  const colon = trimmed.lastIndexOf(":");
  if (colon === -1 || trimmed.indexOf(":") !== colon) return trimmed.toLowerCase();
  return trimmed.slice(0, colon).toLowerCase();
}

/**
 * Hosts that are almost certainly not production: this machine, Docker's name for the
 * host machine, `.local` / `.localhost` names, and single-label names such as `mongo`
 * (a Compose service or a hosts-file entry on a developer's machine).
 */
function isDevelopmentHost(host: string): boolean {
  if (host === "localhost" || host === "::1" || host === "host.docker.internal") return true;
  if (/^127\.\d+\.\d+\.\d+$/.test(host)) return true;
  if (/\.(?:local|localhost|internal|test)$/.test(host)) return true;
  return !host.includes(".") && !host.includes(":");
}

/** A short name: the Atlas cluster or first host label, or the replica set for host lists. */
function suggestName(
  hosts: readonly string[],
  replicaSet: string | undefined,
  scheme: ConnectionStringInfo["scheme"],
): string {
  const first = hosts[0] ?? "mongodb";
  if (scheme === "mongodb" && hosts.length > 1 && replicaSet !== undefined) return replicaSet;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(first) || first.includes(":")) {
    return replicaSet ?? first;
  }
  if (first === "host.docker.internal") return "MongoDB on this computer";
  return first.split(".")[0] ?? first;
}

/** Production by default unless every host is local; Atlas says so explicitly. */
function productionGuess(atlas: boolean, local: boolean): ConnectionStringInfo["production"] {
  if (atlas) {
    return {
      suggested: true,
      reason: "This is a MongoDB Atlas cluster, so it is treated as production.",
    };
  }
  if (local) {
    return {
      suggested: false,
      reason: "This database runs on this computer or in Docker, so it looks like a test database.",
    };
  }
  return {
    suggested: true,
    reason: "This database is on another server, so it is treated as production to be safe.",
  };
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** The value of one `?name=value` option (names are case-insensitive in MongoDB). */
function optionValue(query: string, name: string): string | undefined {
  for (const pair of query.split("&")) {
    const equals = pair.indexOf("=");
    if (equals === -1) continue;
    if (pair.slice(0, equals).toLowerCase() === name.toLowerCase()) {
      const value = safeDecode(pair.slice(equals + 1));
      return value === "" ? undefined : value;
    }
  }
  return undefined;
}

/** decodeURIComponent that leaves malformed escapes as they are. */
function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** Removes one pair of matching quotes around the whole text. */
function stripQuotes(value: string): string {
  const trimmed = value.trim();
  const first = trimmed[0];
  if (
    trimmed.length >= 2 &&
    (first === '"' || first === "'" || first === "`") &&
    trimmed.endsWith(first)
  ) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

/** Splits a shell command line into words, honouring single and double quotes. */
function splitShellWords(line: string): string[] {
  const words: string[] = [];
  let current = "";
  let quote: string | undefined;
  let inWord = false;
  for (const character of line) {
    if (quote !== undefined) {
      if (character === quote) quote = undefined;
      else current += character;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      inWord = true;
    } else if (/\s/.test(character)) {
      if (inWord) words.push(current);
      current = "";
      inWord = false;
    } else {
      current += character;
      inWord = true;
    }
  }
  if (inWord) words.push(current);
  return words;
}
