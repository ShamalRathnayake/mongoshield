/**
 * StepFlow: a long form split into steps, shown as numbered tabs with one step at a
 * time, so filling it in feels like a flow instead of a long scroll.
 *
 *   (1) Basics ─── (2) What ─── (3) How ─── (4) When ─── (5) Review
 *   ┌───────────────────────────────────────────────────────────────┐
 *   │ the current step's fields                                     │
 *   └───────────────────────────────────────────────────────────────┘
 *   [← Back]                                       [Next: What →]
 *
 * - The tabs are the WAI-ARIA tabs pattern: ←/→/Home/End move between them, and every
 *   step stays reachable, so people can go back and change anything at any time.
 * - Each tab shows its state with a shape AND a word for screen readers: a number
 *   (to do), a check mark ("done") or an exclamation mark ("needs attention"), so the
 *   state is never shown by colour alone.
 * - Every step's panel stays mounted (inactive ones are `hidden`), so what was typed
 *   in a step is kept while another one is shown, and browsers keep their own state.
 * - Back / Next move one step; on the last step (or before a locked one) the page's
 *   own action button (e.g. "Create plan", "Review plan") takes Next's place. After Back or Next, focus goes to the new
 *   step's panel so screen readers announce it, and the flow scrolls into view.
 *
 * The page owns the current step and the validation: it marks steps as done or as
 * having errors, and on submit it can jump to the first step that needs attention.
 */

import { Fragment, type KeyboardEvent, type ReactNode, useEffect, useId, useRef } from "react";
import { Button } from "./button.tsx";
import { Icon } from "./icons.tsx";
import "./step-flow.css";

/** One step of a flow. */
export interface FlowStep<Id extends string> {
  readonly id: Id;
  /** The tab's title, e.g. "What to back up". */
  readonly title: string;
  /** A few words under the title, e.g. "Databases and collections". */
  readonly hint?: string;
  /** "done" shows a check mark, "error" an exclamation mark; undefined shows the number. */
  readonly state?: "done" | "error" | undefined;
  /**
   * A step that cannot be opened yet (e.g. "Review" before the choices are checked).
   * It is shown dimmed, skipped by the arrow keys, and Next does not go to it.
   */
  readonly locked?: boolean | undefined;
  /** The step's content. */
  readonly content: ReactNode;
}

/** Props for `StepFlow`. */
export interface StepFlowProps<Id extends string> {
  /** Names the tab list for screen readers, e.g. "Backup plan steps". */
  readonly label: string;
  readonly steps: readonly FlowStep<Id>[];
  readonly current: Id;
  readonly onStep: (id: Id) => void;
  /** Shown on the last step instead of "Next", e.g. the form's submit button. */
  readonly finish?: ReactNode;
  /**
   * Shows `finish` on every step, next to a quieter "Next" — for editing something that
   * already exists, where people change one field and save without walking every step.
   */
  readonly finishOnEveryStep?: boolean;
  /** Extra buttons on the left of the navigation row (e.g. "Cancel"). */
  readonly extra?: ReactNode;
  /**
   * Whether a step's required values are filled in and valid. With it, the flow keeps
   * people from moving past an incomplete step: Next stays on it (and calls
   * `onIncomplete` so the page can show what is missing), and the tabs after the first
   * incomplete step are closed until it is done. Earlier steps stay open.
   */
  readonly isComplete?: (id: Id) => boolean;
  /** Called with a step that was left incomplete, to show its errors and focus them. */
  readonly onIncomplete?: (id: Id) => void;
}

/** The flow (see the file header). */
export function StepFlow<Id extends string>(props: StepFlowProps<Id>) {
  const { steps, current, onStep } = props;
  const prefix = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const index = Math.max(
    0,
    steps.findIndex((step) => step.id === current),
  );
  const previous = steps[index - 1];
  const next = steps[index + 1];
  // The first open step that is not complete yet; the steps after it are closed.
  const incompleteAt =
    props.isComplete === undefined
      ? -1
      : steps.findIndex((step) => step.locked !== true && props.isComplete?.(step.id) === false);
  const incomplete = incompleteAt < 0 ? undefined : steps[incompleteAt];
  /** True for a step behind an incomplete one ("finish the earlier step first"). */
  const gated = (position: number): boolean => incompleteAt >= 0 && position > incompleteAt;
  // Steps the tabs and arrow keys may go to.
  const open = steps.filter((step, position) => step.locked !== true && !gated(position));
  /** Next: on an incomplete step, say what is missing instead of moving on. */
  const goNext = (target: FlowStep<Id>) => {
    if (props.isComplete?.(current) === false) {
      props.onIncomplete?.(current);
      return;
    }
    go(target.id);
  };

  // Back and Next sit at the bottom and the new step starts at the top: after one of
  // them, focus moves to the new step's panel and the flow scrolls into view. (Tabs
  // keep focus on the tab list, as the WAI-ARIA tabs pattern expects.)
  const moveFocusToPanel = useRef(false);
  useEffect(() => {
    if (!moveFocusToPanel.current) return;
    moveFocusToPanel.current = false;
    document.getElementById(`${prefix}-panel-${current}`)?.focus({ preventScroll: true });
    rootRef.current?.scrollIntoView?.({ block: "start", behavior: "smooth" });
  }, [current, prefix]);
  /** Goes to a step from the Back / Next buttons. */
  const go = (id: Id) => {
    moveFocusToPanel.current = true;
    onStep(id);
  };

  // ←/→/Home/End between tabs, as in every WAI-ARIA tab list.
  // Locked steps are skipped.
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const at = Math.max(
      0,
      open.findIndex((step) => step.id === current),
    );
    let target: FlowStep<Id> | undefined;
    if (event.key === "ArrowRight") target = open[(at + 1) % open.length];
    else if (event.key === "ArrowLeft") target = open[(at - 1 + open.length) % open.length];
    else if (event.key === "Home") target = open[0];
    else if (event.key === "End") target = open[open.length - 1];
    if (target === undefined) return;
    event.preventDefault();
    onStep(target.id);
    document.getElementById(`${prefix}-tab-${target.id}`)?.focus();
  };

  return (
    <div className="step-flow" ref={rootRef}>
      <div role="tablist" aria-label={props.label} className="step-tabs" onKeyDown={onKeyDown}>
        {steps.map((step, position) => {
          const selected = step.id === current;
          const closed = step.locked === true || gated(position);
          return (
            <button
              key={step.id}
              id={`${prefix}-tab-${step.id}`}
              type="button"
              role="tab"
              aria-selected={selected}
              aria-controls={`${prefix}-panel-${step.id}`}
              // Only the current tab is in the Tab order; the arrow keys reach the rest.
              tabIndex={selected ? 0 : -1}
              className="step-tab"
              data-state={step.state}
              // aria-disabled, not disabled: the tab stays readable for screen readers.
              aria-disabled={closed || undefined}
              title={
                gated(position) && incomplete !== undefined
                  ? `Complete “${incomplete.title}” first`
                  : undefined
              }
              onClick={() => {
                if (step.locked === true) return;
                // Behind an incomplete step: open that step and show what is missing.
                if (gated(position) && incomplete !== undefined) {
                  onStep(incomplete.id);
                  props.onIncomplete?.(incomplete.id);
                  return;
                }
                onStep(step.id);
              }}
            >
              <span className="step-tab-marker" aria-hidden="true">
                {step.state === "done" ? (
                  <Icon name="check" size={13} />
                ) : step.state === "error" ? (
                  "!"
                ) : (
                  position + 1
                )}
              </span>
              <span className="step-tab-text">
                <span className="step-tab-title">{step.title}</span>
                {step.hint === undefined ? null : (
                  <span className="step-tab-hint">{step.hint}</span>
                )}
              </span>
              {/* The state in words, for screen readers. */}
              {step.state === undefined ? null : (
                <span className="visually-hidden">
                  {step.state === "done" ? " (done)" : " (needs attention)"}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {steps.map((step) => (
        <div
          key={step.id}
          id={`${prefix}-panel-${step.id}`}
          role="tabpanel"
          aria-labelledby={`${prefix}-tab-${step.id}`}
          className="step-panel"
          hidden={step.id !== current}
          // Focusable from script only, so a step change can move focus here.
          tabIndex={-1}
        >
          {step.content}
        </div>
      ))}

      <div className="step-nav">
        <div className="step-nav-start">
          {previous === undefined ? null : (
            <Button onClick={() => go(previous.id)}>
              <Icon name="chevronLeft" size={14} />
              Back
            </Button>
          )}
          {props.extra}
        </div>
        <span className="step-nav-count" aria-hidden="true">
          Step {index + 1} of {steps.length}
        </span>
        <div className="step-nav-end">
          {/*
           * Keyed, so React never turns the clicked "Next" <button> into the finish button:
           * a reused element would become type="submit" while its click is still being
           * handled, and the browser would then submit the form (e.g. "Next: Review"
           * creating the plan right away).
           */}
          {next === undefined || next.locked === true ? (
            <Fragment key="finish">{props.finish}</Fragment>
          ) : (
            <>
              {/* Next is the main action unless finish is offered on every step. */}
              <Button
                key="next"
                variant={props.finishOnEveryStep === true ? "secondary" : "primary"}
                onClick={() => goNext(next)}
              >
                Next: {next.title}
                <Icon name="chevronRight" size={14} />
              </Button>
              {props.finishOnEveryStep === true ? (
                <Fragment key="finish">{props.finish}</Fragment>
              ) : null}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
