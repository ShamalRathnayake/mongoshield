/**
 * Plan editor tests for the step flow and the fill suggestions:
 * - the helpers behind it (step of a field, hints, summaries, name suggestions);
 * - the tabs: their hints follow the choices, ✓ once visited and valid, "!" after a
 *   failed save (or at once for an existing plan that is invalid as stored);
 * - saving with problems opens the first step that has one, with focus on its field;
 * - the Review step with its "Change" buttons, the side column, and `?step=` in the URL;
 * - one-click suggestions for the name, patterns, cron, retention counts, and the
 *   per-type notification placeholders.
 */

import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { renderApp, requestsTo } from "../testing.tsx";
import { openNewPlanStep } from "./plan-editor.testkit.tsx";
import {
  appendLine,
  describeRetention,
  describeSelection,
  describeTarget,
  emptyPlanForm,
  type PlanContext,
  parsePlanStep,
  planNameSuggestions,
  planStepHints,
  stepOfField,
  stepsWithErrors,
} from "./plan-editor.tsx";

type User = ReturnType<typeof renderApp>["user"];

/** A step's tab by its title (its name goes on with the hint and state). */
const tab = (title: string) => screen.getByRole("tab", { name: new RegExp(`^${title}`) });

/** The hint under a step's tab. */
const hintOf = (title: string) => tab(title).querySelector(".step-tab-hint")?.textContent;

/** Opens a step by clicking its tab. */
async function openStep(user: User, title: string) {
  await user.click(tab(title));
}

/** True when the step's tab is the open one. */
const isOpen = (title: string) => tab(title).getAttribute("aria-selected") === "true";

/** A suggestion chip in the row under the field labelled `field`. */
const chip = (field: string, name: string | RegExp) =>
  within(screen.getByRole("group", { name: `Suggestions for ${field}` })).getByRole("button", {
    name,
  });

/** Names for the ids the helpers see, as the mock backend has them. */
const context: PlanContext = {
  connections: [
    {
      id: "c",
      name: "Production cluster",
      production: true,
    } as PlanContext["connections"][number],
  ],
  storage: [{ id: "s", name: "S3 primary" } as PlanContext["storage"][number]],
  tree: [
    {
      name: "shop",
      collections: [
        { name: "users", type: "collection", estimatedDocuments: 1, indexes: 1 },
        { name: "orders", type: "collection", estimatedDocuments: 1, indexes: 1 },
      ],
    },
    {
      name: "analytics",
      collections: [{ name: "daily", type: "collection", estimatedDocuments: 1, indexes: 1 }],
    },
  ],
};

/** A blank form pointing at the context's connection and storage. */
const baseForm = () => ({ ...emptyPlanForm(), connectionId: "c", storageId: "s" });

describe("step helpers", () => {
  it("reads the step from the URL, falling back to the first", () => {
    expect(parsePlanStep("schedule")).toBe("schedule");
    expect(parsePlanStep("nope")).toBe("basics");
    expect(parsePlanStep(null)).toBe("basics");
  });

  it("traces each field to its step, and lists the steps with errors in order", () => {
    expect(stepOfField("storageId")).toBe("basics");
    expect(stepOfField("picks")).toBe("what");
    expect(stepOfField("passphrase")).toBe("security");
    expect(stepOfField("fullEveryDays")).toBe("schedule");
    expect(stepOfField("retention.daily")).toBe("retention");
    expect(stepOfField("notify.2")).toBe("retention");
    expect(stepsWithErrors({ cron: "x", name: "y", "notify.0": "z", include: undefined })).toEqual([
      "basics",
      "schedule",
      "retention",
    ]);
    expect(stepsWithErrors(undefined)).toEqual([]);
  });

  it("sums up where, what and how long", () => {
    expect(describeTarget(baseForm(), context)).toBe("Production cluster → S3 primary");
    expect(describeTarget({ ...baseForm(), storageId: "" }, context)).toBe(
      "Production cluster → no storage",
    );
    expect(describeTarget({ ...baseForm(), connectionId: "", storageId: "" }, context)).toBe(
      "Choose a connection and storage",
    );

    const pick = {
      ...baseForm(),
      selection: "pick" as const,
      picks: ["shop.*", "analytics.daily"],
    };
    expect(describeSelection(pick, context.tree)).toBe("3 collections");
    // Before the tree is listed, the picks are counted instead.
    expect(describeSelection(pick, undefined)).toBe("1 database, 1 collection");
    expect(describeSelection({ ...pick, picks: [] }, undefined)).toBe("Nothing chosen yet");
    const advanced = { ...baseForm(), selection: "advanced" as const };
    expect(describeSelection(advanced, undefined)).toBe("Everything");
    expect(describeSelection({ ...advanced, include: "a.*", exclude: "*.x" }, undefined)).toBe(
      "2 patterns",
    );
    expect(describeSelection({ ...advanced, exclude: "shop.users" }, context.tree)).toBe(
      "2 collections",
    );

    expect(describeRetention(baseForm())).toBe("7 daily, 4 weekly, 12 monthly");
    expect(
      describeRetention({
        ...baseForm(),
        retention: { last: "3", daily: "", weekly: "", monthly: "", yearly: "2" },
      }),
    ).toBe("Last 3, 2 yearly");
    expect(
      describeRetention({
        ...baseForm(),
        retention: { last: "", daily: "", weekly: "", monthly: "", yearly: "" },
      }),
    ).toBe("Every backup kept");
  });

  it("writes a hint for every step", () => {
    const hints = planStepHints(
      {
        ...baseForm(),
        encryptionKind: "none",
        compression: "none",
        incremental: true,
        notify: [{ type: "slack", url: "" }],
      },
      context,
      false,
    );
    expect(hints).toEqual({
      basics: "Production cluster → S3 primary",
      what: "Everything",
      security: "Not encrypted · no compression",
      schedule: "Every day at 02:00 · incremental",
      retention: "7 daily, 4 weekly, 12 monthly · 1 alert",
      review: "Check, then save",
    });
    expect(planStepHints({ ...baseForm(), scheduled: false }, context, true)).toMatchObject({
      schedule: "Manual runs only",
      review: "Check, then create",
    });
  });
});

describe("fill suggestion helpers", () => {
  it("adds a pattern on its own line, once", () => {
    expect(appendLine("", "a.*")).toBe("a.*");
    expect(appendLine("a.*\n\n", "b.*")).toBe("a.*\nb.*");
    expect(appendLine("a.*\nb.*", "b.*")).toBe("a.*\nb.*");
  });

  it("makes names from the connection, the schedule, the ticks and the storage", () => {
    expect(planNameSuggestions(baseForm(), context)).toEqual([
      "Production cluster nightly",
      "Production cluster → S3 primary",
      "Production cluster backups",
    ]);
    // A daytime run is "daily"; ticked databases get a name of their own.
    const picked = {
      ...baseForm(),
      cron: "0 14 * * *",
      selection: "pick" as const,
      picks: ["shop.*", "shop.users", "analytics.daily", "logs.*"],
    };
    expect(planNameSuggestions(picked, context)).toEqual([
      "Production cluster daily",
      "Daily shop",
      "Daily analytics",
      "Production cluster → S3 primary",
      "Production cluster backups",
    ]);
    // Every kind of repeat has its word; a custom cron has none.
    const word = (form: ReturnType<typeof baseForm>) => planNameSuggestions(form, context)[0];
    expect(word({ ...baseForm(), repeat: "hourly" })).toBe("Production cluster hourly");
    expect(word({ ...baseForm(), repeat: "every6h" })).toBe("Production cluster 6-hourly");
    expect(word({ ...baseForm(), repeat: "every12h" })).toBe("Production cluster twice daily");
    expect(word({ ...baseForm(), repeat: "weekly" })).toBe("Production cluster weekly");
    expect(word({ ...baseForm(), repeat: "monthly" })).toBe("Production cluster monthly");
    expect(word({ ...baseForm(), scheduled: false })).toBe("Production cluster manual");
    expect(
      planNameSuggestions(
        { ...baseForm(), repeat: "custom", selection: "pick", picks: ["shop.*"] },
        context,
      ),
    ).toEqual(["shop backup", "Production cluster → S3 primary", "Production cluster backups"]);
    expect(
      planNameSuggestions({ ...baseForm(), connectionId: "", storageId: "" }, context),
    ).toEqual([]);
  });
});

describe("the step tabs", () => {
  it("hint at the choices made so far, and update as they change", async () => {
    const { user } = renderApp({ signedInAs: "admin", hash: "#/plans/new" });
    await screen.findByRole("heading", { name: "New backup plan" });
    expect(screen.getByRole("tablist", { name: "Backup plan steps" })).toBeTruthy();
    expect(hintOf("Basics")).toBe("Production cluster → S3 primary");
    expect(hintOf("What to back up")).toBe("Everything");
    expect(hintOf("Security")).toBe("Public keys · zstd");
    expect(hintOf("Schedule")).toBe("Every day at 02:00");
    expect(hintOf("Retention & alerts")).toBe("7 daily, 4 weekly, 12 monthly · No alerts");
    expect(hintOf("Review")).toBe("Check, then create");

    await user.selectOptions(screen.getByLabelText("Storage"), "st-r2");
    expect(hintOf("Basics")).toBe("Production cluster → R2 offsite");

    await openNewPlanStep(user, "What to back up");
    await user.click(screen.getByRole("radio", { name: "Choose databases and collections" }));
    expect(hintOf("What to back up")).toBe("Nothing chosen yet");
    await user.click(await screen.findByRole("checkbox", { name: "shop" }));
    expect(hintOf("What to back up")).toBe("6 collections");
  });

  it("mark steps done once visited and valid, and flag problems after a save attempt", async () => {
    const { user, backend } = renderApp({ signedInAs: "admin", hash: "#/plans/new" });
    await screen.findByRole("heading", { name: "New backup plan" });
    // Basics is open but has no name yet; the other steps were not visited.
    expect(tab("Basics").getAttribute("data-state")).toBeNull();
    expect(tab("What to back up").getAttribute("data-state")).toBeNull();
    await user.type(screen.getByLabelText("Name"), "Flow");
    expect(tab("Basics").getAttribute("data-state")).toBe("done");
    expect(tab("Basics").textContent).toContain("(done)");

    // Next walks the steps in order; "What" is valid as it starts (everything).
    await user.click(screen.getByRole("button", { name: /Next: What to back up/ }));
    expect(tab("What to back up").getAttribute("data-state")).toBe("done");
    // Security needs a recipient, so visiting it is not enough.
    await user.click(screen.getByRole("button", { name: /Next: Security/ }));
    expect(tab("Security").getAttribute("data-state")).toBeNull();
    // Nothing is flagged before the user tries to move on.
    expect(screen.queryByText("Add at least one age recipient (age1…).")).toBeNull();

    // The steps after it are closed, with a reason; Review too.
    for (const title of ["Schedule", "Retention & alerts", "Review"]) {
      expect(tab(title).getAttribute("aria-disabled")).toBe("true");
      expect(tab(title).getAttribute("title")).toBe("Complete “Security” first");
    }
    // Clicking a closed tab stays on Security and flags it, focus on the field.
    await openStep(user, "Review");
    expect(isOpen("Security")).toBe(true);
    expect(tab("Security").getAttribute("data-state")).toBe("error");
    expect(tab("Security").textContent).toContain("(needs attention)");
    expect(document.activeElement).toBe(screen.getByLabelText("Recipients"));
    expect(screen.getByText("Add at least one age recipient (age1…).")).toBeTruthy();
    expect(requestsTo(backend, "POST", "/api/plans")).toHaveLength(0);

    // Fixed, the step is done again and the plan can be created.
    await user.selectOptions(screen.getByLabelText("Encryption"), "managed");
    expect(tab("Security").getAttribute("data-state")).toBe("done");
    await openStep(user, "Review");
    await user.click(screen.getByRole("button", { name: "Create plan" }));
    expect(await screen.findByRole("heading", { name: "Backup plans" })).toBeTruthy();
    expect(requestsTo(backend, "POST", "/api/plans")[0]?.body).toMatchObject({
      name: "Flow",
      encryption: { kind: "managed" },
    });
  });

  it("flag an existing plan's invalid step at once, the others as done", async () => {
    renderApp({
      signedInAs: "admin",
      hash: "#/plans/plan-nightly",
      prepare: (mock) => {
        mock.data.plans = mock.data.plans.map((plan) =>
          plan.id === "plan-nightly"
            ? { ...plan, schedule: { cron: "0 2 * * *", timezone: "Mars/Olympus" } }
            : plan,
        );
      },
    });
    await screen.findByRole("heading", { name: "Nightly production" });
    expect(tab("Schedule").getAttribute("data-state")).toBe("error");
    for (const title of ["Basics", "What to back up", "Security", "Retention & alerts"]) {
      expect(tab(title).getAttribute("data-state")).toBe("done");
    }
    expect(screen.getByText(/"Mars\/Olympus" is not a known time zone/)).toBeTruthy();
    // The page actions stay in the header; Save works from any step of a saved plan.
    expect(screen.getByRole("button", { name: "Run now" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Delete plan" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Save changes" })).toBeTruthy();
  });

  it("keep the open step in the URL", async () => {
    const { user } = renderApp({ signedInAs: "admin", hash: "#/plans/new" });
    await screen.findByRole("heading", { name: "New backup plan" });
    await openNewPlanStep(user, "Schedule");
    expect(window.location.hash).toBe("#/plans/new?step=schedule");
    await openStep(user, "Retention & alerts");
    expect(window.location.hash).toBe("#/plans/new?step=retention");
    // The first step needs no query.
    await openStep(user, "Basics");
    expect(window.location.hash).toBe("#/plans/new");
  });

  it("open the first incomplete step instead of a closed one named in the URL", async () => {
    // A reload of a new plan starts empty, so its Schedule step is closed.
    renderApp({ signedInAs: "admin", hash: "#/plans/new?step=schedule" });
    await screen.findByRole("heading", { name: "New backup plan" });
    // The URL is put right just after the first render.
    await waitFor(() => expect(isOpen("Basics")).toBe(true));
    expect(window.location.hash).toBe("#/plans/new");
    // Nothing was tried yet, so nothing is flagged.
    expect(screen.queryByText("Give the plan a name.")).toBeNull();
  });

  it("let an existing valid plan open any step and move freely", async () => {
    const { user } = renderApp({
      signedInAs: "admin",
      hash: "#/plans/plan-nightly?step=retention",
    });
    await screen.findByRole("heading", { name: "Nightly production" });
    expect(isOpen("Retention & alerts")).toBe(true);
    for (const title of ["Basics", "What to back up", "Security", "Schedule", "Review"]) {
      expect(tab(title).getAttribute("aria-disabled")).toBeNull();
    }
    await openStep(user, "Review");
    expect(isOpen("Review")).toBe(true);
    await openStep(user, "Basics");
    await user.click(screen.getByRole("button", { name: /Next: What to back up/ }));
    expect(isOpen("What to back up")).toBe(true);
  });

  it("open an existing invalid plan on its first problem, and hold it there", async () => {
    const { user } = renderApp({
      signedInAs: "admin",
      hash: "#/plans/plan-nightly",
      prepare: (mock) => {
        mock.data.plans = mock.data.plans.map((plan) =>
          plan.id === "plan-nightly"
            ? { ...plan, schedule: { cron: "0 2 * * *", timezone: "Mars/Olympus" } }
            : plan,
        );
      },
    });
    await screen.findByRole("heading", { name: "Nightly production" });
    await waitFor(() => expect(isOpen("Schedule")).toBe(true));
    expect(window.location.hash).toBe("#/plans/plan-nightly?step=schedule");
    expect(screen.getByText(/"Mars\/Olympus" is not a known time zone/)).toBeTruthy();
    // The earlier steps stay open; the later ones (and Review) wait for the fix.
    expect(tab("Basics").getAttribute("aria-disabled")).toBeNull();
    expect(tab("Review").getAttribute("aria-disabled")).toBe("true");
    await user.selectOptions(screen.getByLabelText("Time zone"), "UTC");
    expect(tab("Review").getAttribute("aria-disabled")).toBeNull();
  });

  it("flag a step left incomplete for an earlier one", async () => {
    const { user } = renderApp({ signedInAs: "admin", hash: "#/plans/new" });
    await screen.findByRole("heading", { name: "New backup plan" });
    await openNewPlanStep(user, "Security");
    // Back with Security still incomplete: its tab says so.
    await user.click(screen.getByRole("button", { name: /Back/ }));
    expect(isOpen("What to back up")).toBe(true);
    expect(tab("Security").getAttribute("data-state")).toBe("error");
    await openStep(user, "Security");
    expect(screen.getByText("Add at least one age recipient (age1…).")).toBeTruthy();
  });

  it("refuse a name another plan already has", async () => {
    const { user } = renderApp({ signedInAs: "admin", hash: "#/plans/new" });
    await screen.findByRole("heading", { name: "New backup plan" });
    await user.type(screen.getByLabelText("Name"), "Nightly production");
    await user.click(screen.getByRole("button", { name: /Next: What to back up/ }));
    expect(isOpen("Basics")).toBe(true);
    expect(
      screen.getByText('Another plan is already called "Nightly production". Choose another name.'),
    ).toBeTruthy();
  });

  it("open on the first step for an unknown ?step=", async () => {
    renderApp({ signedInAs: "admin", hash: "#/plans/new?step=bogus" });
    await screen.findByRole("heading", { name: "New backup plan" });
    expect(isOpen("Basics")).toBe(true);
  });
});

describe("the side column", () => {
  it("shows the plan summary, and the selection preview on What to back up", async () => {
    const { user } = renderApp({ signedInAs: "admin", hash: "#/plans/new" });
    await screen.findByRole("heading", { name: "New backup plan" });
    const summary = screen.getByRole("complementary", { name: "Plan summary" });
    expect(within(summary).getByText("Not named yet")).toBeTruthy();
    expect(within(summary).getByText("Production cluster → S3 primary")).toBeTruthy();
    expect(within(summary).getByText("Public keys (age recipients)")).toBeTruthy();
    expect(within(summary).getByText("7 daily, 4 weekly, 12 monthly")).toBeTruthy();
    await user.type(screen.getByLabelText("Name"), "Summed up");
    expect(within(summary).getByText("Summed up")).toBeTruthy();
    expect(screen.queryByRole("complementary", { name: "Selection preview" })).toBeNull();

    await openNewPlanStep(user, "What to back up");
    expect(screen.getByRole("complementary", { name: "Selection preview" })).toBeTruthy();
    expect(screen.queryByRole("complementary", { name: "Plan summary" })).toBeNull();

    // On Review the review itself is the summary: no side column.
    await openNewPlanStep(user, "Review");
    expect(screen.queryByRole("complementary")).toBeNull();
    // Without a schedule the summary says so.
    await openStep(user, "Schedule");
    await user.click(screen.getByLabelText("Run on a schedule"));
    expect(
      within(screen.getByRole("complementary", { name: "Plan summary" })).getByText(
        "Manual runs only",
      ),
    ).toBeTruthy();
  });
});

describe("the review step", () => {
  it("lists every choice and opens a step from its Change button", async () => {
    const { user } = renderApp({ signedInAs: "admin", hash: "#/plans/plan-hourly?step=review" });
    await screen.findByRole("heading", { name: "Staging hourly" });
    const review = screen.getByRole("tabpanel");
    const section = (title: string) => within(review).getByRole("region", { name: title });
    expect(within(section("Basics")).getByText("Staging hourly")).toBeTruthy();
    expect(within(section("What to back up")).getByText("shop.orders")).toBeTruthy();
    expect(within(section("Security")).getByText("gzip")).toBeTruthy();
    expect(within(section("Security")).getByText("The stored one is kept")).toBeTruthy();
    expect(within(section("Schedule")).getByText("Every hour at minute 15")).toBeTruthy();
    expect(
      within(review).getByText("Check the changes, then save them.", { exact: false }),
    ).toBeTruthy();
    // Save ends the flow here.
    expect(screen.getAllByRole("button", { name: "Save changes" })).toHaveLength(1);

    // Each Change button says which step it opens; focus goes to that step.
    await user.click(screen.getByRole("button", { name: "Change schedule" }));
    expect(isOpen("Schedule")).toBe(true);
    expect(window.location.hash).toBe("#/plans/plan-hourly?step=schedule");
    expect(document.activeElement?.getAttribute("role")).toBe("tabpanel");
    for (const name of [
      "Change basics",
      "Change what to back up",
      "Change security",
      "Change retention & alerts",
    ]) {
      expect(screen.getByRole("button", { name, hidden: true })).toBeTruthy();
    }
  });

  it("describes a new plan's choices in every mode, and opens only once all is complete", async () => {
    const { user } = renderApp({ signedInAs: "admin", hash: "#/plans/new" });
    await screen.findByRole("heading", { name: "New backup plan" });
    await openNewPlanStep(user, "What to back up", "Described");
    await user.click(screen.getByLabelText("Patterns (advanced)"));
    await user.type(screen.getByLabelText("Exclude"), "*.sessions");
    await openStep(user, "Security");
    await user.selectOptions(screen.getByLabelText("Encryption"), "passphrase");
    // Review stays closed while any step is incomplete (no passphrase yet).
    expect(tab("Review").getAttribute("aria-disabled")).toBe("true");
    await user.type(screen.getByLabelText("Passphrase"), "a long enough phrase");
    await openStep(user, "Schedule");
    await user.click(screen.getByLabelText("Incremental backups between full ones"));
    await openStep(user, "Retention & alerts");
    await user.click(screen.getByRole("button", { name: "Add notification" }));
    await user.selectOptions(screen.getByLabelText("Type"), "discord");
    // A new notification needs its URL.
    expect(tab("Review").getAttribute("aria-disabled")).toBe("true");
    await user.click(screen.getByRole("button", { name: /Next: Review/ }));
    expect(screen.getByText("Enter the webhook URL.")).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByLabelText("URL"));
    await user.type(screen.getByLabelText("URL"), "https://discord.example/hook");

    await openStep(user, "Review");
    const review = screen.getByRole("tabpanel");
    const section = (title: string) => within(review).getByRole("region", { name: title });
    expect(within(section("Basics")).getByText("Described")).toBeTruthy();
    expect(within(section("Basics")).getByText("Production cluster (production)")).toBeTruthy();
    expect(within(section("What to back up")).getByText("*.sessions")).toBeTruthy();
    expect(within(section("What to back up")).getByText("Everything")).toBeTruthy();
    expect(within(section("Security")).getByText("New passphrase entered")).toBeTruthy();
    expect(
      within(section("Schedule")).getByText("On, a full backup every week (7 days)"),
    ).toBeTruthy();
    expect(within(section("Retention & alerts")).getByText("Discord")).toBeTruthy();
    expect(within(review).queryByText("Needs attention")).toBeNull();
  });

  it("says when a new passphrase replaces the stored one", async () => {
    const { user } = renderApp({ signedInAs: "admin", hash: "#/plans/plan-hourly?step=security" });
    await screen.findByRole("heading", { name: "Staging hourly" });
    await user.type(screen.getByLabelText("Passphrase"), "a much longer phrase");
    await openStep(user, "Review");
    const security = within(screen.getByRole("tabpanel")).getByRole("region", { name: "Security" });
    expect(within(security).getByText("New passphrase entered")).toBeTruthy();
  });

  it("lets operators look through every step without changing anything", async () => {
    const { user } = renderApp({ signedInAs: "maya", hash: "#/plans/plan-nightly?step=review" });
    await screen.findByRole("heading", { name: "Nightly production" });
    expect(screen.queryByRole("button", { name: "Save changes" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Change security" }));
    expect(isOpen("Security")).toBe(true);
    expect(screen.getByLabelText("Encryption").matches(":disabled")).toBe(true);
    await user.click(screen.getByRole("button", { name: /Next: Schedule/ }));
    expect(isOpen("Schedule")).toBe(true);
  });
});

describe("fill suggestions", () => {
  it("suggests plan names from the choices made", async () => {
    const { user } = renderApp({ signedInAs: "admin", hash: "#/plans/new" });
    await screen.findByRole("heading", { name: "New backup plan" });
    await user.click(chip("Name", "Production cluster nightly"));
    expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe(
      "Production cluster nightly",
    );
    expect(chip("Name", /Production cluster nightly/).getAttribute("aria-pressed")).toBe("true");
    await user.click(chip("Name", "Production cluster → S3 primary"));
    expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe(
      "Production cluster → S3 primary",
    );
  });

  it("adds the connection's databases and common exclusions as patterns", async () => {
    const { user } = renderApp({ signedInAs: "admin", hash: "#/plans/new" });
    await screen.findByRole("heading", { name: "New backup plan" });
    await openNewPlanStep(user, "What to back up");
    await user.click(screen.getByLabelText("Patterns (advanced)"));
    await user.click(await screen.findByRole("button", { name: "shop.*" }));
    expect((screen.getByLabelText("Include") as HTMLTextAreaElement).value).toBe("shop.*");
    // A pattern already in the box is not offered again.
    expect(
      within(screen.getByRole("group", { name: "Suggestions for Include" })).queryByRole("button", {
        name: "shop.*",
      }),
    ).toBeNull();
    await user.click(chip("Exclude", "*.sessions"));
    await user.click(chip("Exclude", "*.cache"));
    expect((screen.getByLabelText("Exclude") as HTMLTextAreaElement).value).toBe(
      "*.sessions\n*.cache",
    );
    // shop.* without its sessions: 5 of the 8 collections.
    const preview = screen.getByRole("complementary", { name: "Selection preview" });
    expect(within(preview).getByText(/collections selected/).textContent).toMatch(/^5 of 8/);
  });

  it("fills a custom schedule with a ready-made cron expression", async () => {
    const { user } = renderApp({ signedInAs: "admin", hash: "#/plans/new" });
    await screen.findByRole("heading", { name: "New backup plan" });
    await openNewPlanStep(user, "Schedule");
    await user.selectOptions(screen.getByLabelText("Repeat"), "custom");
    // The current expression (the default 02:00 run) is the chosen chip.
    expect(chip("Cron expression", /Daily at 02:00/).getAttribute("aria-pressed")).toBe("true");
    expect(chip("Cron expression", "Every 6 hours").getAttribute("title")).toBe("0 */6 * * *");
    await user.click(chip("Cron expression", "Sundays at 03:00"));
    expect((screen.getByLabelText("Cron expression") as HTMLInputElement).value).toBe("0 3 * * 0");
    expect(
      within(document.querySelector(".schedule-preview") as HTMLElement).getByText(
        "Every Sunday at 03:00",
      ),
    ).toBeTruthy();
  });

  it("offers usual retention counts and saves the one clicked", async () => {
    const { user, backend } = renderApp({
      signedInAs: "admin",
      hash: "#/plans/plan-local?step=retention",
    });
    await screen.findByRole("heading", { name: "Local dev snapshot" });
    await user.selectOptions(screen.getByLabelText("Keep"), "custom");
    await user.click(chip("Last N", "14"));
    expect((screen.getByLabelText("Last N") as HTMLInputElement).value).toBe("14");
    expect(chip("Last N", /14/).getAttribute("aria-pressed")).toBe("true");
    await user.click(chip("Yearly", "3"));
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    expect(await screen.findByRole("heading", { name: "Backup plans" })).toBeTruthy();
    expect(requestsTo(backend, "PUT", "/api/plans/plan-local")[0]?.body).toMatchObject({
      retention: { last: 14, yearly: 3 },
    });
  });

  it("shows each notification type's URL shape, without filling anything in", async () => {
    const { user } = renderApp({ signedInAs: "admin", hash: "#/plans/new" });
    await screen.findByRole("heading", { name: "New backup plan" });
    await openNewPlanStep(user, "Retention & alerts");
    await user.click(screen.getByRole("button", { name: "Add notification" }));
    const url = () => screen.getByLabelText("URL") as HTMLInputElement;
    expect(url().placeholder).toBe("https://hooks.slack.com/services/…");
    await user.selectOptions(screen.getByLabelText("Type"), "discord");
    expect(url().placeholder).toBe("https://discord.com/api/webhooks/…");
    await user.selectOptions(screen.getByLabelText("Type"), "webhook");
    expect(url().placeholder).toBe("https://your-server.example/hooks/…");
    expect(url().value).toBe("");
    expect(screen.queryByRole("group", { name: "Suggestions for URL" })).toBeNull();
  });
});
