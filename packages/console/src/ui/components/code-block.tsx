/**
 * Showing data: `CodeBlock` for preformatted text (manifests, config exports) with a
 * copy button, and `EjsonTree` for documents from a backup, rendered as a collapsible
 * tree with Extended JSON types shown the way MongoDB users know them
 * (`ObjectId("…")`, `ISODate("…")`).
 */

import { useState } from "react";
import { describeWrapper, isJsonObject, type JsonValue } from "../ejson.ts";

/** Preformatted text with a "Copy" button. */
export function CodeBlock(props: { code: string; label: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(props.code);
      setCopied(true);
      setTimeout(() => setCopied(false), 2_000);
    } catch {
      // Clipboard access can be denied (insecure context, permissions); selecting by hand still works.
      setCopied(false);
    }
  };
  return (
    <figure className="code-block">
      <figcaption className="code-block-header">
        <span>{props.label}</span>
        <button type="button" className="button button-ghost button-small" onClick={copy}>
          {copied ? "Copied" : "Copy"}
        </button>
      </figcaption>
      {/* tabIndex lets keyboard users scroll long code horizontally. */}
      {/* biome-ignore lint/a11y/noNoninteractiveTabindex: scrollable region must be focusable. */}
      <pre tabIndex={0} className="code-block-pre">
        <code>{props.code}</code>
      </pre>
    </figure>
  );
}

/** How many levels of a document start expanded. */
const DEFAULT_OPEN_DEPTH = 1;

/**
 * A collapsible tree of one JSON/EJSON value. Objects and arrays have a disclosure
 * button (`aria-expanded`), so the tree works with the keyboard and screen readers.
 */
export function EjsonTree(props: { value: JsonValue; label?: string }) {
  return (
    <div className="ejson-tree">
      <EjsonNode name={props.label} value={props.value} depth={0} />
    </div>
  );
}

function EjsonNode(props: { name: string | undefined; value: JsonValue; depth: number }) {
  const { name, value, depth } = props;
  const [open, setOpen] = useState(depth < DEFAULT_OPEN_DEPTH);
  const wrapper = describeWrapper(value);
  const keyLabel = name === undefined ? null : <span className="ejson-key">{name}: </span>;

  if (wrapper !== undefined) {
    return (
      <div className="ejson-row">
        {keyLabel}
        <span className={`ejson-value ejson-${wrapper.type.toLowerCase()}`} title={wrapper.type}>
          {wrapper.text}
        </span>
      </div>
    );
  }
  if (value === null || typeof value !== "object") {
    return (
      <div className="ejson-row">
        {keyLabel}
        <EjsonScalar value={value} />
      </div>
    );
  }

  const entries: [string, JsonValue][] = Array.isArray(value)
    ? value.map((item, index) => [String(index), item])
    : isJsonObject(value)
      ? Object.entries(value)
      : [];
  const isArray = Array.isArray(value);
  const summary = isArray ? `Array(${entries.length})` : `{ ${entries.length} fields }`;

  return (
    <div className="ejson-branch">
      <button
        type="button"
        className="ejson-toggle"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <span className="ejson-caret" aria-hidden="true">
          {open ? "▾" : "▸"}
        </span>
        {keyLabel}
        <span className="ejson-summary">{summary}</span>
      </button>
      {open ? (
        <div className="ejson-children">
          {entries.map(([key, child]) => (
            <EjsonNode key={key} name={key} value={child} depth={depth + 1} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function EjsonScalar(props: { value: string | number | boolean | null }) {
  const { value } = props;
  if (value === null) return <span className="ejson-value ejson-null">null</span>;
  if (typeof value === "string")
    return <span className="ejson-value ejson-string">{JSON.stringify(value)}</span>;
  if (typeof value === "number")
    return <span className="ejson-value ejson-number">{String(value)}</span>;
  return <span className="ejson-value ejson-boolean">{String(value)}</span>;
}
