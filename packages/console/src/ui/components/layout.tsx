/**
 * Small layout pieces every page uses: the page header, panels (cards), empty states,
 * loading and error notices, key/value lists, tabs and times.
 *
 * They are tiny on purpose; keeping them in one file makes the page files read like
 * an outline of what is on the screen.
 */

import { type KeyboardEvent, type ReactNode, type Ref, useEffect, useState } from "react";
import { describeError } from "../api.ts";
import { formatDateTime, formatRelative } from "../format.ts";

/** The title row of a page, with optional breadcrumbs and actions on the right. */
export function PageHeader(props: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  /** Links to the pages above this one; a crumb without `href` is the current place. */
  breadcrumbs?: readonly { readonly label: string; readonly href?: string }[];
}) {
  return (
    <header className="page-header">
      <div className="page-header-text">
        {props.breadcrumbs === undefined || props.breadcrumbs.length === 0 ? null : (
          <nav aria-label="Breadcrumb" className="breadcrumbs">
            <ol>
              {props.breadcrumbs.map((crumb, index) => (
                // Crumbs are a fixed path for one render; the position is a stable key.
                // biome-ignore lint/suspicious/noArrayIndexKey: see above.
                <li key={index}>
                  {crumb.href === undefined ? (
                    <span aria-current="location">{crumb.label}</span>
                  ) : (
                    <a href={crumb.href}>{crumb.label}</a>
                  )}
                </li>
              ))}
            </ol>
          </nav>
        )}
        {/* tabIndex -1: the shell focuses the heading after navigation. */}
        <h1 className="page-title" tabIndex={-1}>
          {props.title}
        </h1>
        {props.description === undefined ? null : (
          <p className="page-description">{props.description}</p>
        )}
      </div>
      {props.actions === undefined ? null : <div className="page-actions">{props.actions}</div>}
    </header>
  );
}

/** A bordered section of a page with a heading. */
export function Panel(props: {
  title?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  /**
   * The heading element. Passing it also makes the heading focusable from script
   * (tabindex -1), so a page can move focus to a panel that just appeared.
   */
  titleRef?: Ref<HTMLHeadingElement>;
}) {
  return (
    <section className={`panel ${props.className ?? ""}`}>
      {props.title === undefined && props.actions === undefined ? null : (
        <header className="panel-header">
          {props.title === undefined ? (
            <span />
          ) : (
            <h2
              className="panel-title"
              ref={props.titleRef}
              tabIndex={props.titleRef === undefined ? undefined : -1}
            >
              {props.title}
            </h2>
          )}
          {props.actions === undefined ? null : (
            <div className="panel-actions">{props.actions}</div>
          )}
        </header>
      )}
      <div className="panel-body">{props.children}</div>
    </section>
  );
}

/** What to show when a list is empty: say why and offer the next step. */
export function EmptyState(props: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty-state">
      <p className="empty-state-title">{props.title}</p>
      {props.children === undefined ? null : (
        <div className="empty-state-text">{props.children}</div>
      )}
      {props.action === undefined ? null : <div className="empty-state-action">{props.action}</div>}
    </div>
  );
}

/** A polite loading message (announced by screen readers). */
export function Loading(props: { label?: string }) {
  return (
    <p className="loading" role="status">
      <span className="spinner" aria-hidden="true" />
      {props.label ?? "Loading…"}
    </p>
  );
}

/** An error box with the server's message and hint, and an optional retry. */
export function ErrorNotice(props: { error: unknown; onRetry?: () => void; title?: string }) {
  return (
    <div className="notice notice-danger" role="alert">
      <p className="notice-title">
        <span aria-hidden="true">✕ </span>
        {props.title ?? "Something went wrong"}
      </p>
      <p>{describeError(props.error)}</p>
      {props.onRetry === undefined ? null : (
        <button
          type="button"
          className="button button-secondary button-small"
          onClick={props.onRetry}
        >
          Try again
        </button>
      )}
    </div>
  );
}

/** An informational or warning box. The leading symbol repeats the tone for non-color readers. */
export function Notice(props: {
  tone: "info" | "warning" | "danger" | "success";
  title?: ReactNode;
  children?: ReactNode;
}) {
  const symbol = { info: "i", warning: "!", danger: "✕", success: "✓" }[props.tone];
  return (
    <div
      className={`notice notice-${props.tone}`}
      role={props.tone === "danger" ? "alert" : undefined}
    >
      {props.title === undefined ? null : (
        <p className="notice-title">
          <span aria-hidden="true">{symbol} </span>
          {props.title}
        </p>
      )}
      {props.children}
    </div>
  );
}

/** A two-column list of labels and values (`<dl>`). */
export function KeyValueList(props: { items: readonly (readonly [ReactNode, ReactNode])[] }) {
  return (
    <dl className="key-value-list">
      {props.items.map(([key, value], index) => (
        // Labels are static per call site, so the index is a stable key.
        // biome-ignore lint/suspicious/noArrayIndexKey: see above.
        <div key={index} className="key-value-row">
          <dt>{key}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Re-renders every 30 s so relative times ("2 min ago") stay current. */
function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

/** A time shown absolute and relative: "Oct 21, 2026, 02:00 (3 hr. ago)". */
export function Time(props: { value: string | undefined; relativeOnly?: boolean }) {
  const now = useNow();
  if (props.value === undefined) return <span className="muted">–</span>;
  const absolute = formatDateTime(props.value);
  const relative = formatRelative(props.value, now);
  return (
    <time dateTime={props.value} title={formatDateTime(props.value, true)} className="time">
      {props.relativeOnly ? (
        relative
      ) : (
        <>
          {absolute} <span className="muted">({relative})</span>
        </>
      )}
    </time>
  );
}

/** One tab of `Tabs`. */
export interface TabItem {
  readonly id: string;
  readonly label: string;
}

/**
 * Accessible tabs (WAI-ARIA tabs pattern): ←/→ move between tabs, the selected tab is
 * in the tab order and the others are reached with the arrow keys.
 */
export function Tabs(props: {
  label: string;
  tabs: readonly TabItem[];
  selected: string;
  onSelect: (id: string) => void;
  children: ReactNode;
  /** Prefix of the element ids, for pages with two tab sets (default `tab`). */
  idPrefix?: string;
}) {
  const { tabs, onSelect } = props;
  const prefix = props.idPrefix ?? "tab";
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const index = tabs.findIndex((tab) => tab.id === props.selected);
    let next: TabItem | undefined;
    if (event.key === "ArrowRight") next = tabs[(index + 1) % tabs.length];
    else if (event.key === "ArrowLeft") next = tabs[(index - 1 + tabs.length) % tabs.length];
    else if (event.key === "Home") next = tabs[0];
    else if (event.key === "End") next = tabs[tabs.length - 1];
    if (next === undefined) return;
    event.preventDefault();
    onSelect(next.id);
    document.getElementById(`${prefix}-${next.id}`)?.focus();
  };
  return (
    <div className="tabs">
      <div role="tablist" aria-label={props.label} className="tab-list" onKeyDown={onKeyDown}>
        {tabs.map((tab) => (
          <button
            key={tab.id}
            id={`${prefix}-${tab.id}`}
            type="button"
            role="tab"
            aria-selected={tab.id === props.selected}
            aria-controls={`${prefix}panel-${tab.id}`}
            tabIndex={tab.id === props.selected ? 0 : -1}
            className="tab"
            onClick={() => onSelect(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </div>
      <div
        role="tabpanel"
        id={`${prefix}panel-${props.selected}`}
        aria-labelledby={`${prefix}-${props.selected}`}
        className="tab-panel"
      >
        {props.children}
      </div>
    </div>
  );
}
