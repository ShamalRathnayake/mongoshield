/**
 * The restore wizard's "Restore as" choice: under which names the chosen collections
 * land in the target, instead of typing rename rules by hand.
 *
 *   Original names                every collection keeps its name
 *   A copy next to the original   shop → shop_restored (the suffix is editable)
 *   Into another database         one source database → a database of the target,
 *                                 picked from the target's existing databases
 *                                 (`GET /api/connections/:id/namespaces`) or new
 *   Custom rules (advanced)       the `from=to` textarea, prefilled with the rules of
 *                                 the previous choice so people can start from them
 *
 * Below the choice a live preview lists "shop.users → shop_restored.users" for the
 * chosen collections, and notes the ones that already exist in the target (the review
 * step then shows exactly what happens to them). The rules themselves are computed by
 * ../restore-rename.ts; this file is only the form.
 *
 * Every field that is typed into offers one-click suggestions underneath
 * (components/fill-suggestions.tsx), so most restores need no typing at all:
 *
 *   Suffix              _restored  _copy  _20261024 (the backup's date)  _before_fix
 *   New database name   shop_restored  shop_20261024  shop_copy
 *   Rename rules        shop.*=shop_restored.* … (one line per chosen database, added
 *                       to what is already typed)
 */

import { useId } from "react";
import type { ConnectionView, DatabaseNode } from "../../shared/api.ts";
import { describeError } from "../api.ts";
import { SelectField, TextAreaField, TextField } from "../components/field.tsx";
import { FillSuggestions } from "../components/fill-suggestions.tsx";
import { Notice } from "../components/layout.tsx";
import { RadioCards } from "../components/radio-cards.tsx";
import { useApi, useLoad } from "../context.tsx";
import { plural } from "../format.ts";
import { databasesOf } from "../namespace-selection.ts";
import { splitNamespace } from "../namespaces.ts";
import {
  DEFAULT_COPY_SUFFIX,
  NEW_DATABASE,
  oneDatabaseOnly,
  type RestoreAsSettings,
  renameRulesToText,
  targetNamespace,
} from "../restore-rename.ts";
import "./restore-wizard.css";

/** How many "from → to" lines the preview shows before "and N more". */
const PREVIEW_LIMIT = 8;

/**
 * `2026-10-24T02:00:00Z` → `20261024`: the backup's day (in UTC, like the backup ids),
 * for names such as `shop_20261024`. Undefined when the date is missing or unreadable.
 */
export function compactDate(iso: string | undefined): string | undefined {
  if (iso === undefined) return undefined;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return undefined;
  // toISOString is always UTC: "2026-10-24T02:00:00.000Z" → "2026-10-24" → "20261024".
  return date.toISOString().slice(0, 10).replaceAll("-", "");
}

/** Suggestions for the copy's suffix: the usual ones and the backup's date. */
export function suffixSuggestions(backupDate: string | undefined): (string | undefined)[] {
  const day = compactDate(backupDate);
  return [DEFAULT_COPY_SUFFIX, "_copy", day === undefined ? undefined : `_${day}`, "_before_fix"];
}

/** Suggestions for a new database's name, derived from the source database. */
export function databaseNameSuggestions(
  source: string | undefined,
  backupDate: string | undefined,
): (string | undefined)[] {
  if (source === undefined) return [];
  const day = compactDate(backupDate);
  return [
    `${source}${DEFAULT_COPY_SUFFIX}`,
    day === undefined ? undefined : `${source}_${day}`,
    `${source}_copy`,
  ];
}

/**
 * Rule lines to add to the custom rules: one "copy next to the original" rule per chosen
 * database (`shop.*=shop_restored.*`), leaving out lines that are already typed.
 */
export function customRuleSuggestions(databases: readonly string[], typed: string): string[] {
  const existing = new Set(typed.split("\n").map((line) => line.trim()));
  return databases
    .map((database) => `${database}.*=${database}${DEFAULT_COPY_SUFFIX}.*`)
    .filter((line) => !existing.has(line));
}

/** Adds one line to the end of a multi-line text, on a line of its own. */
function appendLine(text: string, line: string): string {
  return text.trim() === "" ? line : `${text.replace(/\s+$/, "")}\n${line}`;
}

/** Props for `RestoreAsFields`. */
export interface RestoreAsFieldsProps {
  readonly settings: RestoreAsSettings;
  readonly onSettings: (settings: RestoreAsSettings) => void;
  /** The chosen namespaces, in the backup's order. */
  readonly chosen: readonly string[];
  /** The target connection, whose databases the "Into another database" select lists. */
  readonly target: ConnectionView | undefined;
  /** The rules for the current settings, or the problem with them (see `renameOf`). */
  readonly rules: Readonly<Record<string, string>> | string;
  /** The rename error to show, once the user has tried to go on (like other fields). */
  readonly error: string | undefined;
  /** When the backup was taken (ISO), for date-based name suggestions like `shop_20261024`. */
  readonly backupDate?: string | undefined;
}

/** The "Restore as" radio cards, the fields of the chosen card and the live preview. */
export function RestoreAsFields(props: RestoreAsFieldsProps) {
  const { settings, onSettings, target, rules, error } = props;
  const databases = databasesOf(props.chosen);
  const [source] = databases;
  const targetDatabases = useTargetDatabases(target);
  const targetName = target?.name ?? "the target";

  /** Changes one setting, keeping the others. */
  const update = (change: Partial<RestoreAsSettings>) => onSettings({ ...settings, ...change });

  return (
    <div className="restore-as">
      <RadioCards
        legend="Restore as"
        value={settings.kind}
        onValue={(kind) =>
          update({
            kind,
            // Custom rules start from what the previous choice would have sent.
            ...(kind === "custom" && settings.customText === "" && typeof rules !== "string"
              ? { customText: renameRulesToText(rules) }
              : {}),
          })
        }
        options={[
          {
            value: "original",
            label: "Original names",
            description: "Every collection keeps its name.",
          },
          {
            value: "copy",
            label: "A copy next to the original",
            description: `Each database gets a suffix, e.g. ${source ?? "shop"} → ${source ?? "shop"}${settings.suffix.trim() || "_restored"}. The safest way to recover a few documents.`,
          },
          {
            value: "database",
            label: "Into another database",
            description:
              databases.length > 1
                ? `Needs collections from one database; these come from ${databases.length}.`
                : `Pick one of the databases in ${targetName}, or a new one.`,
            // Offered only for one source database (explained above); stays choosable
            // while chosen, so the explanation below can say what to change.
            disabled: databases.length > 1 && settings.kind !== "database",
          },
          {
            value: "custom",
            label: "Custom rules (advanced)",
            description: "Type from=to rules, e.g. to rename single collections.",
          },
        ]}
      />

      {settings.kind === "copy" ? (
        <TextField
          label="Suffix"
          value={settings.suffix}
          onValue={(suffix) => update({ suffix })}
          spellCheck={false}
          autoComplete="off"
          hint="Added to the name of every chosen database."
          error={error}
          suggestions={
            <FillSuggestions
              field="Suffix"
              items={suffixSuggestions(props.backupDate)}
              current={settings.suffix}
              onPick={(suffix) => update({ suffix })}
              mono
            />
          }
        />
      ) : null}

      {settings.kind === "database" ? (
        databases.length > 1 ? (
          <Notice tone="warning" title="Choose collections from one database">
            {oneDatabaseOnly(databases)}
          </Notice>
        ) : (
          <>
            <SelectField
              label={`Database in ${targetName}`}
              value={settings.database}
              onValue={(database) => update({ database })}
              options={[
                // A placeholder that cannot be picked again once something is chosen.
                { value: "", label: "Choose a database…", disabled: true },
                ...(targetDatabases.databases ?? [])
                  // The source database itself would be "Original names".
                  .filter((database) => database.name !== source)
                  .map((database) => ({
                    value: database.name,
                    label: `${database.name} (${plural(database.collections.length, "collection")})`,
                  })),
                { value: NEW_DATABASE, label: "New database…" },
              ]}
              hint={targetDatabases.hint}
              error={settings.database === NEW_DATABASE ? undefined : error}
            />
            {settings.database === NEW_DATABASE ? (
              <TextField
                label="New database name"
                value={settings.newDatabase}
                onValue={(newDatabase) => update({ newDatabase })}
                spellCheck={false}
                autoComplete="off"
                placeholder={`${source ?? "shop"}_recovered`}
                hint="Created by the restore."
                error={error}
                suggestions={
                  <FillSuggestions
                    field="New database name"
                    items={databaseNameSuggestions(source, props.backupDate)}
                    current={settings.newDatabase}
                    onPick={(newDatabase) => update({ newDatabase })}
                    mono
                  />
                }
              />
            ) : null}
          </>
        )
      ) : null}

      {settings.kind === "custom" ? (
        <TextAreaField
          label="Rename rules"
          value={settings.customText}
          onValue={(customText) => update({ customText })}
          rows={3}
          spellCheck={false}
          placeholder="shop.*=shop_restored.*"
          hint="One from=to per line: shop.*=shop_restored.* moves a whole database, shop.users=shop.users_old renames one collection."
          error={error}
          // Each chip adds its line (instead of replacing the rules typed so far).
          suggestions={
            <FillSuggestions
              field="Rename rules"
              lead="Add"
              items={customRuleSuggestions(databases, settings.customText)}
              onPick={(line) => update({ customText: appendLine(settings.customText, line) })}
              mono
            />
          }
        />
      ) : null}

      {typeof rules === "string" || props.chosen.length === 0 ? null : (
        <RenamePreview
          chosen={props.chosen}
          rules={rules}
          targetName={targetName}
          targetDatabases={targetDatabases.databases}
        />
      )}
    </div>
  );
}

/** The target's databases, loaded once per target connection, with a hint for the select. */
function useTargetDatabases(target: ConnectionView | undefined): {
  databases: readonly DatabaseNode[] | undefined;
  hint: string | undefined;
} {
  const client = useApi();
  const targetId = target?.id ?? "";
  const state = useLoad(targetId === "" ? "" : `restore-target:${targetId}`, async (signal) => ({
    targetId,
    databases: await client.call("GET /api/connections/:id/namespaces", undefined, {
      params: { id: targetId },
      signal,
    }),
  }));
  // useLoad keeps the previous data while the next target loads; never show the
  // databases of another connection.
  const databases = state.data?.targetId === targetId ? state.data.databases : undefined;
  const name = target?.name ?? "the target";
  if (state.error !== undefined) {
    return {
      databases,
      hint: `Could not list the databases of ${name}: ${describeError(state.error)} You can still choose “New database…”.`,
    };
  }
  if (databases === undefined && targetId !== "") {
    return { databases, hint: `Loading the databases of ${name}…` };
  }
  return { databases, hint: undefined };
}

/** "shop.users → shop_restored.users" for the chosen namespaces (the first few). */
function RenamePreview(props: {
  chosen: readonly string[];
  rules: Readonly<Record<string, string>>;
  targetName: string;
  targetDatabases: readonly DatabaseNode[] | undefined;
}) {
  const titleId = useId();
  const shown = props.chosen.slice(0, PREVIEW_LIMIT);
  const hidden = props.chosen.length - shown.length;
  return (
    <div className="restore-as-preview">
      <p className="field-label" id={titleId}>
        Result in {props.targetName}
      </p>
      <ul aria-labelledby={titleId}>
        {shown.map((ns) => {
          const to = targetNamespace(ns, props.rules);
          const existing = existingDocuments(to, props.targetDatabases);
          return (
            <li key={ns}>
              <span className="mono">{ns}</span>
              <span aria-hidden="true"> → </span>
              <span className="visually-hidden"> restored as </span>
              <span className="mono">{to}</span>
              {existing === undefined ? null : (
                <span className="muted">
                  {" "}
                  · already exists
                  {existing > 0 ? ` (${plural(existing, "document")})` : " (empty)"}
                </span>
              )}
            </li>
          );
        })}
      </ul>
      {hidden > 0 ? <p className="muted">…and {plural(hidden, "more collection")}.</p> : null}
    </div>
  );
}

/** The estimated documents of `ns` in the target, or undefined when it does not exist (or is unknown). */
function existingDocuments(
  ns: string,
  databases: readonly DatabaseNode[] | undefined,
): number | undefined {
  const { database, collection } = splitNamespace(ns);
  return databases
    ?.find((candidate) => candidate.name === database)
    ?.collections.find((candidate) => candidate.name === collection)?.estimatedDocuments;
}
