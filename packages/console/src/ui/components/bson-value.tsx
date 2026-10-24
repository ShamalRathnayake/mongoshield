/**
 * Showing one BSON value inline, the same way in every view (table cells, cards, the
 * document tree, the detail panel):
 *
 *   ObjectId     its hex, with the creation time (from its timestamp) as a tooltip
 *   Date         date and time in the browser's time zone, ISO text as a tooltip
 *   numbers      digits in tabular figures; Int64 / Decimal128 marked with their type
 *   Boolean      true / false with a ✓ / ✕ shape (not color alone)
 *   null         a muted "null"; a missing field is a muted "—" (they differ in MongoDB)
 *   Binary       "Binary · 16 bytes", UUIDs as their usual text
 *   arrays       chips: the first few values, then "+3 more", with the length
 *   documents    "{ 3 fields }"
 *
 * Arrays and documents become a button when `onOpenNested` is given (the table opens
 * them in a popover), so nested data is one click away without widening the row.
 *
 * `TypeBadge` names a BSON type in a small pill; the type's color comes from the
 * `--type-*` tokens in styles.css and is always paired with the type's name.
 */

import type { MouseEvent } from "react";
import {
  BSON_TYPE_LABELS,
  type BsonType,
  binaryInfo,
  bsonTypeOf,
  dateOf,
  objectIdHex,
  objectIdTime,
  shortText,
  uuidText,
} from "../bson.ts";
import type { JsonValue } from "../ejson.ts";
import { formatDateTime } from "../format.ts";

/** Array items shown as chips before "+N more". */
const ARRAY_PREVIEW_ITEMS = 3;

/** CSS class group of a type, which decides its color token. */
export function typeGroup(type: BsonType): string {
  switch (type) {
    case "number":
    case "int":
    case "long":
    case "double":
    case "decimal":
      return "number";
    case "objectId":
    case "uuid":
      return "id";
    case "date":
    case "timestamp":
      return "date";
    case "string":
    case "symbol":
    case "code":
    case "regex":
      return "string";
    case "boolean":
      return "boolean";
    case "array":
    case "object":
      return "nested";
    default:
      return "other";
  }
}

/** A small pill naming a BSON type ("ObjectId", "String", …). */
export function TypeBadge(props: { type: BsonType; title?: string }) {
  return (
    <span className={`type-badge type-${typeGroup(props.type)}`} title={props.title}>
      {BSON_TYPE_LABELS[props.type]}
    </span>
  );
}

/** The tooltip of an ObjectId: when it was created. */
export function objectIdTitle(hex: string): string {
  const created = objectIdTime(hex);
  return created === undefined
    ? "ObjectId"
    : `ObjectId · created ${formatDateTime(created.toISOString(), true)} (${created.toISOString()})`;
}

/** Props for `BsonValue`. */
export interface BsonValueProps {
  /** The value; `undefined` means the field is missing from the document. */
  readonly value: JsonValue | undefined;
  /** Makes arrays and documents a button that calls this (e.g. to open a popover). */
  readonly onOpenNested?: (value: JsonValue, event: MouseEvent<HTMLButtonElement>) => void;
  /** Accessible name of that button, e.g. "Show items of document 3". */
  readonly nestedLabel?: string;
  /** Show strings whole and quoted (tree, detail panel) instead of clipped (cells, cards). */
  readonly full?: boolean;
}

/** One value, rendered for its type (see the file header). */
export function BsonValue(props: BsonValueProps) {
  const { value } = props;
  if (value === undefined) {
    return (
      <span className="bson bson-missing" title="This document has no such field">
        —
      </span>
    );
  }
  const type = bsonTypeOf(value);
  switch (type) {
    case "null":
      return <span className="bson bson-null">null</span>;
    case "boolean":
      return (
        <span className={`bson bson-boolean bson-${String(value)}`}>
          <span aria-hidden="true">{value === true ? "✓ " : "✕ "}</span>
          {String(value)}
        </span>
      );
    case "number":
      return <span className="bson bson-number">{String(value)}</span>;
    case "int":
    case "long":
    case "double":
    case "decimal":
      return (
        <span className="bson bson-number" title={BSON_TYPE_LABELS[type]}>
          {shortText(value)}
          {type === "long" || type === "decimal" ? (
            <span className="bson-suffix">{type === "long" ? " L" : " D"}</span>
          ) : null}
        </span>
      );
    case "string":
      // The tree and the detail panel show the whole string, quoted like JSON; cells and
      // cards show a clipped line with the whole text as the tooltip.
      return props.full === true ? (
        <span className="bson bson-string bson-full">{JSON.stringify(value)}</span>
      ) : (
        <span
          className="bson bson-string"
          title={(value as string).length > 80 ? (value as string) : undefined}
        >
          {shortText(value)}
        </span>
      );
    case "objectId": {
      const hex = objectIdHex(value) ?? "";
      return (
        <span className="bson bson-id" title={objectIdTitle(hex)}>
          {hex}
        </span>
      );
    }
    case "date": {
      const date = dateOf(value);
      return (
        <span className="bson bson-date" title={date?.toISOString() ?? "Invalid date"}>
          {date === undefined ? "Invalid date" : formatDateTime(date.toISOString(), true)}
        </span>
      );
    }
    case "uuid":
      return (
        <span className="bson bson-id" title="UUID">
          {uuidText(value) ?? "UUID"}
        </span>
      );
    case "binary": {
      const info = binaryInfo(value);
      return (
        <span
          className="bson bson-other"
          title={
            info === undefined
              ? "Binary"
              : `Binary, subtype ${info.subType}, base64 ${info.base64.slice(0, 64)}${info.base64.length > 64 ? "…" : ""}`
          }
        >
          {shortText(value)}
        </span>
      );
    }
    case "array":
      return <ArrayChips items={value as readonly JsonValue[]} {...props} />;
    case "object": {
      const count = Object.keys(value as object).length;
      const text = `{ ${count} ${count === 1 ? "field" : "fields"} }`;
      return props.onOpenNested === undefined ? (
        <span className="bson bson-nested">{text}</span>
      ) : (
        <button
          type="button"
          className="bson bson-nested bson-open"
          aria-label={props.nestedLabel ?? `Show ${text}`}
          onClick={(event) => props.onOpenNested?.(value, event)}
        >
          {text}
        </button>
      );
    }
    default:
      return (
        <span className="bson bson-other" title={BSON_TYPE_LABELS[type]}>
          {shortText(value)}
        </span>
      );
  }
}

/** An array as a count plus its first few values as chips. */
function ArrayChips(props: BsonValueProps & { items: readonly JsonValue[] }) {
  const { items } = props;
  const preview = items.slice(0, ARRAY_PREVIEW_ITEMS);
  const content = (
    <>
      <span className="bson-count">[{items.length}]</span>
      {preview.map((item, index) => (
        // Positions are stable while the value is shown.
        // biome-ignore lint/suspicious/noArrayIndexKey: see above.
        <span key={index} className="chip">
          {shortText(item)}
        </span>
      ))}
      {items.length > ARRAY_PREVIEW_ITEMS ? (
        <span className="chip chip-more">+{items.length - ARRAY_PREVIEW_ITEMS} more</span>
      ) : null}
    </>
  );
  if (props.onOpenNested === undefined || items.length === 0) {
    return <span className="bson bson-array">{content}</span>;
  }
  return (
    <button
      type="button"
      className="bson bson-array bson-open"
      aria-label={props.nestedLabel ?? `Show the ${items.length} items`}
      onClick={(event) => props.onOpenNested?.(items, event)}
    >
      {content}
    </button>
  );
}
