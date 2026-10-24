/**
 * The cards view: each document as a compact, readable summary card.
 *
 *   ┌──────────────────────────────┐
 *   │ Ada #12                      │  title field (chosen, or guessed: name, title, …)
 *   │ ada.12@example.com           │  subtitle field
 *   │ plan      pro                │  the next few fields, type-aware
 *   │ logins    444                │
 *   │ +3 more fields      Open ↗   │
 *   └──────────────────────────────┘
 *
 * The title and subtitle fields are chosen above the cards (remembered per collection);
 * until then the viewer guesses a readable field. Clicking a value opens its value menu
 * (quick filters, copy); "Open" opens the document's detail panel.
 */

import { type MouseEvent, useState } from "react";
import { flattenDocument, isPlainObject, valueAtPath } from "../bson.ts";
import type { JsonValue } from "../ejson.ts";
import type { ViewerDocument, ViewerSelection } from "../viewer-model.ts";
import { BsonValue } from "./bson-value.tsx";
import { Icon } from "./icons.tsx";
import { Menu } from "./popover.tsx";
import { type QuickFilterHandler, valueMenuItems } from "./value-menu.tsx";

/** Fields listed on a card below its title and subtitle. */
export const CARD_FIELDS = 6;

/** Field names that usually make a good card title, in order of preference. */
const TITLE_CANDIDATES = [
  "name",
  "title",
  "displayName",
  "fullName",
  "username",
  "label",
  "email",
  "sku",
  "slug",
];
/** And a good subtitle. */
const SUBTITLE_CANDIDATES = [
  "email",
  "description",
  "status",
  "type",
  "kind",
  "category",
  "createdAt",
];

/** The first candidate field present (as a string) in most of the documents, if any. */
function guessField(
  documents: readonly ViewerDocument[],
  candidates: readonly string[],
  exclude?: string,
): string | undefined {
  for (const candidate of candidates) {
    if (candidate === exclude) continue;
    const present = documents.filter(
      (document) => valueAtPath(document.value, candidate) !== undefined,
    );
    if (present.length > 0 && present.length >= documents.length / 2) return candidate;
  }
  return undefined;
}

/** The title and subtitle fields to use: the chosen ones, else a guess. */
export function cardFields(
  documents: readonly ViewerDocument[],
  /** `subtitle: null` means the user chose no subtitle (no guess either). */
  chosen: { title?: string | undefined; subtitle?: string | null | undefined },
): { title: string; subtitle: string | undefined } {
  const title = chosen.title ?? guessField(documents, TITLE_CANDIDATES) ?? "_id";
  if (chosen.subtitle === null) return { title, subtitle: undefined };
  const subtitle = chosen.subtitle ?? guessField(documents, SUBTITLE_CANDIDATES, title);
  return { title, subtitle: subtitle === title ? undefined : subtitle };
}

/** Props for `DocumentCards`. */
export interface DocumentCardsProps {
  readonly documents: readonly ViewerDocument[];
  readonly firstNumber: number;
  readonly titleField: string;
  readonly subtitleField: string | undefined;
  readonly onOpen: (index: number) => void;
  readonly onQuickFilter?: QuickFilterHandler | undefined;
  readonly selection?: ViewerSelection | undefined;
  readonly onCopied?: ((ok: boolean, what: string) => void) | undefined;
}

/** The cards view (see the file header). */
export function DocumentCards(props: DocumentCardsProps) {
  const [menu, setMenu] = useState<
    { anchor: HTMLElement; path: string; value: JsonValue | undefined } | undefined
  >(undefined);
  const openMenu = (
    event: MouseEvent<HTMLButtonElement>,
    path: string,
    value: JsonValue | undefined,
  ) => setMenu({ anchor: event.currentTarget, path, value });

  return (
    <>
      <ol className="card-grid" aria-label="Documents">
        {props.documents.map((document, index) => {
          const number = props.firstNumber + index;
          const title = valueAtPath(document.value, props.titleField);
          const subtitle =
            props.subtitleField === undefined
              ? undefined
              : valueAtPath(document.value, props.subtitleField);
          const shown = new Set([props.titleField, props.subtitleField]);
          const fields =
            document.value !== undefined && isPlainObject(document.value)
              ? flattenDocument(document.value, 1).filter(([path]) => !shown.has(path))
              : [];
          const selected = props.selection?.isSelected(document) === true;
          return (
            <li
              key={document.key}
              className={selected ? "doc-card doc-card-selected" : "doc-card"}
              aria-label={`Document ${number}: ${document.label}`}
            >
              <div className="doc-card-head">
                {props.selection === undefined ? null : (
                  <input
                    type="checkbox"
                    className="checkbox"
                    checked={selected}
                    disabled={!props.selection.canSelect(document)}
                    aria-label={`Select document ${document.label}`}
                    onChange={() => props.selection?.toggle(document)}
                  />
                )}
                <div className="doc-card-titles">
                  <p className="doc-card-title">
                    {document.value === undefined ? (
                      <span className="mono">{document.text.slice(0, 80)}</span>
                    ) : (
                      <BsonValue value={title} />
                    )}
                  </p>
                  {props.subtitleField === undefined ? null : (
                    <p className="doc-card-subtitle">
                      <BsonValue value={subtitle} />
                    </p>
                  )}
                </div>
                <span className="doc-card-number" aria-hidden="true">
                  {number}
                </span>
              </div>
              {fields.length === 0 ? null : (
                <dl className="doc-card-fields">
                  {fields.slice(0, CARD_FIELDS).map(([path, value]) => (
                    <div key={path} className="doc-card-field">
                      <dt>{path}</dt>
                      <dd>
                        <button
                          type="button"
                          className="doc-card-value"
                          aria-label={`${path}: actions`}
                          onClick={(event) => openMenu(event, path, value)}
                        >
                          <BsonValue value={value} />
                        </button>
                      </dd>
                    </div>
                  ))}
                </dl>
              )}
              <div className="doc-card-foot">
                <span className="muted">
                  {fields.length > CARD_FIELDS ? `+${fields.length - CARD_FIELDS} more fields` : ""}
                </span>
                <button
                  type="button"
                  className="button button-ghost button-small"
                  onClick={() => props.onOpen(index)}
                  aria-label={`Open document ${document.label}`}
                >
                  Open
                  <Icon name="open" size={12} />
                </button>
              </div>
            </li>
          );
        })}
      </ol>
      {menu === undefined ? null : (
        <Menu
          anchor={menu.anchor}
          label={`Actions for ${menu.path}`}
          onClose={() => setMenu(undefined)}
          items={valueMenuItems({
            path: menu.path,
            value: menu.value,
            onQuickFilter: props.onQuickFilter,
            ...(props.onCopied === undefined ? {} : { onCopied: props.onCopied }),
          })}
        />
      )}
    </>
  );
}
