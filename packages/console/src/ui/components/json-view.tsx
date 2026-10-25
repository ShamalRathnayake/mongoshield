/**
 * The JSON view: documents as syntax-highlighted Extended JSON text, the way they would
 * be exported.
 *
 * - Relaxed Extended JSON (readable: plain numbers and ISO dates) or canonical (every
 *   BSON type explicit: `{"$numberInt": "42"}`), switched by the viewer; the server sends
 *   the canonical text when asked (`ejson=canonical`), so it is exact, not guessed.
 * - "Wrap lines" toggles soft wrapping for long values.
 * - Each document has a copy button, and the toolbar copies them all as one array.
 *
 * Highlighting is a small tokenizer over the pretty-printed text (keys, strings, numbers,
 * booleans, null, punctuation); it never evaluates anything.
 */

import type { ReactNode } from "react";

/** One token class of the highlighter. */
type TokenKind = "key" | "wrapper" | "string" | "number" | "boolean" | "null" | "punctuation";

/**
 * Strings (a key when followed by a colon), literals, numbers and punctuation of
 * pretty-printed JSON. Whitespace between tokens is kept as it is.
 */
const TOKEN_PATTERN =
  /("(?:\\.|[^"\\])*")(\s*:)?|\b(true|false)\b|\b(null)\b|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|([{}[\],])/g;

/** Splits JSON text into highlighted spans. */
export function highlightJson(text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let last = 0;
  let key = 0;
  const push = (kind: TokenKind, token: string) => {
    nodes.push(
      <span key={key} className={`json-${kind}`}>
        {token}
      </span>,
    );
    key += 1;
  };
  for (const match of text.matchAll(TOKEN_PATTERN)) {
    const index = match.index ?? 0;
    if (index > last) nodes.push(text.slice(last, index));
    const [whole, string, colon, boolean, nullLiteral, number] = match;
    if (string !== undefined) {
      if (colon === undefined) push("string", string);
      else {
        // `"$oid":`, `"$date":` … are the type of the value, not a field: styled apart.
        push(string.startsWith('"$') ? "wrapper" : "key", string);
        push("punctuation", colon);
      }
    } else if (boolean !== undefined) push("boolean", boolean);
    else if (nullLiteral !== undefined) push("null", nullLiteral);
    else if (number !== undefined) push("number", number);
    else push("punctuation", whole);
    last = index + whole.length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

/** Pretty-prints one Extended JSON text (2-space indent); unparseable text is shown as is. */
export function prettyJson(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

/** One document as highlighted text, a figure named for screen readers. */
export function JsonText(props: { text: string; wrap: boolean; label: string }) {
  return (
    <figure className="json-figure" aria-label={props.label}>
      <pre
        className={`json-text ${props.wrap ? "json-wrap" : ""}`}
        // Focusable, so keyboard users can scroll long documents.
        // biome-ignore lint/a11y/noNoninteractiveTabindex: see above.
        tabIndex={0}
      >
        <code>{highlightJson(prettyJson(props.text))}</code>
      </pre>
    </figure>
  );
}
