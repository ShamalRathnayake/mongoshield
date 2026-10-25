/**
 * Plan editor tests for the choices that replace free-text fields: "What to back up"
 * (Everything / the checkbox tree / patterns), the "Repeat" schedule presets, the time
 * zone select, the full-backup interval and the retention presets. Each is checked for
 * how an existing plan opens, how the controls change, and what is sent on save. Each
 * test opens the step (tab) whose fields it uses, or links to it with `?step=`.
 */

import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { DatabaseNode } from "../../shared/api.ts";
import { NamespacePicker } from "../components/namespace-picker.tsx";
import { renderFailingApp } from "../failing-backend.testkit.tsx";
import type { MockBackend } from "../mock/backend.ts";
import { renderApp, requestsTo } from "../testing.tsx";
import { isClosed, openNewPlanStep } from "./plan-editor.testkit.tsx";
import {
  browserTimeZone,
  emptyPlanForm,
  fullBackupLabel,
  planToForm,
  selectionPatterns,
  validatePlanForm,
  withPreset,
  withRepeat,
  withRetentionPreset,
  withSelection,
} from "./plan-editor.tsx";

/** A form that passes validation, to vary one field at a time. */
const validForm = () => ({
  ...emptyPlanForm(),
  name: "Plan",
  connectionId: "c",
  storageId: "s",
  encryptionKind: "none" as const,
});

/** A select by its label, typed so `.value` can be read. */
const select = (label: string) => screen.getByLabelText(label) as HTMLSelectElement;

/** A checkbox by its accessible name. */
const checkbox = (name: string) => screen.getByRole("checkbox", { name }) as HTMLInputElement;

/** Opens a step of the editor by its tab title ("Schedule", "What to back up" …). */
async function openStep(user: ReturnType<typeof renderApp>["user"], title: string) {
  // A tab's name starts with its title, followed by its hint and state.
  await user.click(screen.getByRole("tab", { name: new RegExp(`^${title}`) }));
}

/** The schedule in words and its next runs (the tab hint and summary repeat the words). */
const schedulePreview = () => document.querySelector(".schedule-preview") as HTMLElement;

/** Names the plan, turns encryption off and creates it from the Review step. */
async function finishNewPlan(user: ReturnType<typeof renderApp>["user"], name: string) {
  await openStep(user, "Basics");
  // Replaces the name typed to open the later steps (see openNewPlanStep).
  await user.clear(screen.getByLabelText("Name"));
  await user.type(screen.getByLabelText("Name"), name);
  await openStep(user, "Security");
  await user.selectOptions(screen.getByLabelText("Encryption"), "none");
  await openStep(user, "Review");
  await user.click(screen.getByRole("button", { name: "Create plan" }));
}

/** Changes one plan in the mock before the app loads. */
const changePlan =
  (id: string, change: (plan: MockBackend["data"]["plans"][number]) => object) =>
  (mock: MockBackend) => {
    mock.data.plans = mock.data.plans.map((plan) =>
      plan.id === id ? { ...plan, ...change(plan) } : plan,
    );
  };

/** Saves the open plan and returns the body of the PUT it sent. */
async function saveExisting(
  user: ReturnType<typeof renderApp>["user"],
  backend: MockBackend,
  id: string,
) {
  await user.click(screen.getByRole("button", { name: "Save changes" }));
  expect(await screen.findByRole("heading", { name: "Backup plans" })).toBeTruthy();
  return requestsTo(backend, "PUT", `/api/plans/${id}`)[0]?.body;
}

describe("form helpers for the choices", () => {
  it("sends the patterns of the chosen mode only", () => {
    const form = { ...validForm(), picks: ["shop.*"], include: "a.*", exclude: "b.c" };
    expect(selectionPatterns({ ...form, selection: "everything" })).toEqual({
      include: [],
      exclude: [],
    });
    expect(selectionPatterns({ ...form, selection: "pick" })).toEqual({
      include: ["shop.*"],
      exclude: [],
    });
    expect(selectionPatterns({ ...form, selection: "advanced" })).toEqual({
      include: ["a.*"],
      exclude: ["b.c"],
    });
  });

  it("refuses an empty tree, which the server would read as everything", () => {
    const result = validatePlanForm({ ...validForm(), selection: "pick", picks: [] });
    expect(result.errors?.picks).toMatch(/Tick at least one database or collection/);
    // Hidden pattern boxes never block saving.
    expect(
      validatePlanForm({ ...validForm(), selection: "everything", include: "bad" }).input,
    ).toBeDefined();
  });

  it("carries plain patterns into the tree and picks into empty pattern boxes", () => {
    const advanced = { ...validForm(), selection: "advanced" as const, include: "shop.users" };
    expect(withSelection(advanced, "pick")).toMatchObject({
      selection: "pick",
      picks: ["shop.users"],
    });
    // Wildcards cannot be ticks: the tree starts empty and the boxes keep them.
    const wild = { ...advanced, include: "*.users" };
    expect(withSelection(wild, "pick")).toMatchObject({ picks: [], include: "*.users" });

    const picked = { ...validForm(), selection: "pick" as const, picks: ["a.*", "b.c"] };
    expect(withSelection(picked, "advanced")).toMatchObject({ include: "a.*\nb.c" });
    // Boxes that already hold patterns are not overwritten.
    expect(withSelection({ ...picked, exclude: "x.y" }, "advanced")).toMatchObject({
      include: "",
      exclude: "x.y",
    });
    expect(withSelection(picked, "everything").picks).toEqual(["a.*", "b.c"]);
  });

  it("rewrites the cron from presets and keeps it for custom", () => {
    const form = validForm();
    expect(withRepeat(form, "weekly").cron).toBe("0 2 * * 1");
    expect(withRepeat({ ...form, cron: "1 2 3 4 5" }, "custom")).toMatchObject({
      repeat: "custom",
      cron: "1 2 3 4 5",
    });
    expect(
      withPreset(form, { repeat: "monthly", minute: 30, hour: 4, weekday: 1, dayOfMonth: 9 }),
    ).toMatchObject({ repeat: "monthly", cron: "30 4 9 * *" });
  });

  it("fills the counts from a retention preset and keeps them for custom", () => {
    const last7 = withRetentionPreset(validForm(), "last7");
    expect(last7.retention.last).toBe("7");
    expect(validatePlanForm(last7).input?.retention).toEqual({ last: 7 });
    expect(withRetentionPreset(last7, "custom")).toMatchObject({
      retentionPreset: "custom",
      retention: last7.retention,
    });
    expect(validatePlanForm(withRetentionPreset(last7, "forever")).input?.retention).toBe(
      undefined,
    );
  });

  it("opens existing plans on the choices that match them", () => {
    const base = {
      id: "p",
      name: "x",
      connectionId: "c",
      storageId: "s",
      include: [],
      exclude: [],
      compression: "zstd" as const,
      encryption: { kind: "none" as const },
      consistency: "auto" as const,
      verify: "fast" as const,
      notify: [],
    };
    expect(planToForm(base)).toMatchObject({
      selection: "everything",
      retentionPreset: "forever",
      scheduled: false,
      repeat: "daily",
    });
    expect(
      planToForm({
        ...base,
        include: ["shop.*", "analytics.daily"],
        schedule: { cron: "0 */6 * * *", timezone: "UTC" },
        retention: { last: 30 },
      }),
    ).toMatchObject({
      selection: "pick",
      picks: ["shop.*", "analytics.daily"],
      repeat: "every6h",
      retentionPreset: "last30",
    });
    expect(
      planToForm({
        ...base,
        include: ["*.users"],
        schedule: { cron: "0 2 * * 1-5", timezone: "UTC" },
        retention: { last: 3, daily: 7 },
      }),
    ).toMatchObject({
      selection: "advanced",
      picks: [],
      include: "*.users",
      repeat: "custom",
      retentionPreset: "custom",
    });
  });

  it("names full-backup intervals", () => {
    expect(fullBackupLabel("1")).toBe("Every day");
    expect(fullBackupLabel("7")).toBe("Every week (7 days)");
    expect(fullBackupLabel("14")).toBe("Every 2 weeks (14 days)");
    expect(fullBackupLabel("3")).toBe("Every 3 days");
  });
});

describe("new plan defaults", () => {
  it("starts with everything, daily at 02:00 in this browser's zone, recommended retention", async () => {
    const { user, backend } = renderApp({ signedInAs: "admin", hash: "#/plans/new" });
    await screen.findByRole("heading", { name: "New backup plan" });

    await openNewPlanStep(user, "What to back up");
    expect((screen.getByRole("radio", { name: "Everything" }) as HTMLInputElement).checked).toBe(
      true,
    );
    await openNewPlanStep(user, "Schedule");
    expect(select("Repeat").value).toBe("daily");
    expect(select("Time of day").value).toBe("02:00");
    expect(select("Time zone").value).toBe(browserTimeZone());
    // The browser's zone is the first suggestion, and says so.
    expect(select("Time zone").options[0]?.textContent).toMatch(/this browser/);
    await openStep(user, "Retention & alerts");
    expect(select("Keep").value).toBe("recommended");
    expect(screen.queryByLabelText("Last N")).toBeNull();

    await finishNewPlan(user, "Defaults");
    expect(await screen.findByRole("heading", { name: "Backup plans" })).toBeTruthy();
    expect(requestsTo(backend, "POST", "/api/plans")[0]?.body).toMatchObject({
      include: [],
      exclude: [],
      schedule: { cron: "0 2 * * *", timezone: browserTimeZone() },
      retention: { daily: 7, weekly: 4, monthly: 12 },
    });
  });
});

describe("choosing databases and collections", () => {
  it("ticks databases and collections, searches, and saves them as patterns", async () => {
    const { user, backend } = renderApp({ signedInAs: "admin", hash: "#/plans/new" });
    await screen.findByRole("heading", { name: "New backup plan" });
    await openNewPlanStep(user, "What to back up");
    await user.click(screen.getByRole("radio", { name: "Choose databases and collections" }));

    // The production tree: shop (6 collections) and analytics (2), nothing ticked.
    await screen.findByRole("checkbox", { name: "shop" });
    expect(screen.getByText(/of 8 collections chosen/)).toBeTruthy();
    expect(screen.getByText("0 of 6 collections · 14,676,217 documents")).toBeTruthy();

    // A whole database, then one collection out of it: the database box becomes mixed.
    await user.click(checkbox("shop"));
    expect(checkbox("shop").checked).toBe(true);
    await user.click(checkbox("shop.sessions"));
    expect(checkbox("shop").indeterminate).toBe(true);
    expect(screen.getByText(/^5 of 6 collections/)).toBeTruthy();

    // Searching narrows the list; "Select shown" ticks only the matches.
    await user.type(screen.getByLabelText("Search databases and collections"), "fun");
    expect(screen.queryByRole("checkbox", { name: "shop" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Select shown" }));
    expect(checkbox("analytics.funnel_view").checked).toBe(true);
    await user.clear(screen.getByLabelText("Search databases and collections"));
    await user.type(screen.getByLabelText("Search databases and collections"), "zzz");
    expect(screen.getByText('Nothing matches "zzz".')).toBeTruthy();
    await user.clear(screen.getByLabelText("Search databases and collections"));

    // The other analytics collection completes the database: it becomes analytics.*.
    await user.click(checkbox("analytics.daily_rollups"));
    expect(checkbox("analytics").checked).toBe(true);
    expect(screen.getByText("7", { selector: ".ns-picker-summary strong" })).toBeTruthy();

    await finishNewPlan(user, "Picked");
    expect(await screen.findByRole("heading", { name: "Backup plans" })).toBeTruthy();
    expect(requestsTo(backend, "POST", "/api/plans")[0]?.body).toMatchObject({
      include: [
        "shop.users",
        "shop.orders",
        "shop.products",
        "shop.carts",
        "shop.events.2026",
        "analytics.*",
      ],
      exclude: [],
    });
  });

  it("asks for at least one tick, and Select all / none act on everything", async () => {
    const { user, backend } = renderApp({ signedInAs: "admin", hash: "#/plans/new" });
    await screen.findByRole("heading", { name: "New backup plan" });
    await openNewPlanStep(user, "What to back up");
    await user.click(screen.getByRole("radio", { name: "Choose databases and collections" }));
    await user.click(await screen.findByRole("button", { name: "Select all" }));
    expect(checkbox("shop").checked && checkbox("analytics").checked).toBe(true);
    await user.click(screen.getByRole("button", { name: "Select none" }));
    expect(checkbox("shop").checked || checkbox("analytics").checked).toBe(false);
    // With nothing ticked the preview selects nothing (not "everything").
    const preview = screen.getByRole("complementary", { name: "Selection preview" });
    expect(within(preview).getByText(/collections selected/).textContent).toMatch(/^0 of /);

    // Nothing ticked: Next stays on the step and asks for a tick.
    expect(screen.queryByText(/Tick at least one database or collection/)).toBeNull();
    await user.click(screen.getByRole("button", { name: /Next: Security/ }));
    expect(
      screen.getByRole("tab", { name: /^What to back up/ }).getAttribute("aria-selected"),
    ).toBe("true");
    expect(screen.getByText(/Tick at least one database or collection/)).toBeTruthy();
    // The later steps, Review included, are closed until something is ticked.
    expect(isClosed("Review")).toBe(true);
    expect(requestsTo(backend, "POST", "/api/plans")).toHaveLength(0);
  });

  it("opens a plan of single collections in the tree, with the database mixed", async () => {
    // plan-hourly backs up shop.orders of the staging connection.
    const { user } = renderApp({ signedInAs: "admin", hash: "#/plans/plan-hourly?step=what" });
    await screen.findByRole("heading", { name: "Staging hourly" });
    expect(
      (screen.getByRole("radio", { name: "Choose databases and collections" }) as HTMLInputElement)
        .checked,
    ).toBe(true);
    expect((await screen.findByRole("checkbox", { name: "shop.orders" })).matches(":checked")).toBe(
      true,
    );
    expect(checkbox("shop").indeterminate).toBe(true);

    // Small trees open fully; a database can be folded away.
    await user.click(screen.getByRole("button", { name: "Hide collections in shop" }));
    expect(screen.queryByRole("checkbox", { name: "shop.orders" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Show collections in shop" }));
    expect(checkbox("shop.orders").checked).toBe(true);
  });

  it("keeps picks the new connection does not have, until they are removed", async () => {
    const { user, backend } = renderApp({ signedInAs: "admin", hash: "#/plans/plan-hourly" });
    await screen.findByRole("heading", { name: "Staging hourly" });
    await openStep(user, "What to back up");
    await user.click(await screen.findByRole("checkbox", { name: "shop.audit_log" }));

    // The local connection has only test.fixtures.
    await openStep(user, "Basics");
    await user.selectOptions(screen.getByLabelText("Connection"), "conn-local");
    await openStep(user, "What to back up");
    const notice = (await screen.findByText("Not on this connection")).closest(
      ".notice",
    ) as HTMLElement;
    expect(within(notice).getByText("shop.orders")).toBeTruthy();
    expect(within(notice).getByText("shop.audit_log")).toBeTruthy();
    await user.click(within(notice).getByRole("button", { name: "Remove them" }));
    expect(screen.queryByText("Not on this connection")).toBeNull();

    await user.click(checkbox("test"));
    const body = await saveExisting(user, backend, "plan-hourly");
    expect(body).toMatchObject({ connectionId: "conn-local", include: ["test.*"], exclude: [] });
  });

  it("collapses large trees to the partly chosen databases, and marks empty ones", async () => {
    const many: DatabaseNode[] = ["a", "b", "c", "d"].map((name) => ({
      name,
      collections: [
        { name: "one", type: "collection", estimatedDocuments: 1, indexes: 1 },
        { name: "two", type: "view", estimatedDocuments: 0, indexes: 0 },
      ],
    }));
    renderApp({
      signedInAs: "admin",
      hash: "#/plans/plan-hourly?step=what",
      prepare: (mock) => {
        const staging = mock.data.connections.find(
          (connection) => connection.id === "conn-staging",
        );
        if (staging !== undefined) {
          staging.namespaces = [...many, { name: "fresh", collections: [] }];
        }
        changePlan("plan-hourly", () => ({ include: ["b.one"] }))(mock);
      },
    });
    await screen.findByRole("checkbox", { name: "a" });
    // Only "b" (partly chosen) is open.
    expect(screen.queryByRole("checkbox", { name: "a.one" })).toBeNull();
    expect(checkbox("b.one").checked).toBe(true);
    expect(screen.getAllByText("view").length).toBeGreaterThan(0);
    expect(screen.getByText(/No collections yet/)).toBeTruthy();
  });

  it("says when the connection has no databases", async () => {
    const { user } = renderApp({
      signedInAs: "admin",
      hash: "#/plans/new",
      prepare: (mock) => {
        for (const connection of mock.data.connections) connection.namespaces = [];
      },
    });
    await screen.findByRole("heading", { name: "New backup plan" });
    await openNewPlanStep(user, "What to back up");
    await user.click(screen.getByRole("radio", { name: "Choose databases and collections" }));
    expect(await screen.findByText("This connection has no user databases yet.")).toBeTruthy();
  });

  it("explains a failed listing and retries it", async () => {
    const { user } = renderFailingApp({
      signedInAs: "admin",
      hash: "#/plans/new",
      failures: [
        {
          method: "GET",
          path: /\/namespaces$/,
          status: 502,
          message: "Cannot connect.",
          times: 1,
        },
      ],
    });
    await screen.findByRole("heading", { name: "New backup plan" });
    await openNewPlanStep(user, "What to back up");
    await user.click(screen.getByRole("radio", { name: "Choose databases and collections" }));
    const notice = (
      await screen.findByText("Could not list the databases of this connection")
    ).closest(".notice") as HTMLElement;
    await user.click(within(notice).getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("checkbox", { name: "shop" })).toBeTruthy();
  });

  it("asks for a connection before listing anything", () => {
    // In the editor, "What to back up" only opens once a connection is chosen; the
    // picker itself still says what it needs.
    render(
      <NamespacePicker
        legend="Databases and collections to back up"
        tree={undefined}
        loading={false}
        error={undefined}
        onRetry={() => undefined}
        picks={[]}
        onPicks={() => undefined}
      />,
    );
    expect(screen.getByText("Choose a connection to see its databases.")).toBeTruthy();
  });

  it("opens wildcard plans in the pattern boxes", async () => {
    // plan-nightly uses exclude patterns, which only the pattern boxes can show.
    const { user } = renderApp({ signedInAs: "admin", hash: "#/plans/plan-nightly?step=what" });
    await screen.findByRole("heading", { name: "Nightly production" });
    expect((screen.getByLabelText("Include") as HTMLTextAreaElement).value).toBe(
      "shop.*\nanalytics.*",
    );
    expect((screen.getByLabelText("Exclude") as HTMLTextAreaElement).value).toBe(
      "*.sessions\nshop.events.*",
    );
    // Everything hides the boxes; the preview then counts every collection.
    await user.click(screen.getByRole("radio", { name: "Everything" }));
    expect(screen.queryByLabelText("Include")).toBeNull();
    const summary = await screen.findByText(/of 8 collections selected/);
    expect(summary.textContent).toMatch(/^8 of 8 collections selected/);
  });
});

describe("schedule presets", () => {
  it("builds weekly, monthly and hourly schedules from selects", async () => {
    const { user, backend } = renderApp({ signedInAs: "admin", hash: "#/plans/plan-nightly" });
    await screen.findByRole("heading", { name: "Nightly production" });
    await openStep(user, "Schedule");
    // "0 2 * * *" opens as every day at 02:00.
    expect(select("Repeat").value).toBe("daily");
    expect(select("Time of day").value).toBe("02:00");
    expect(select("Time zone").value).toBe("UTC");

    await user.selectOptions(select("Repeat"), "weekly");
    expect(select("Day of the week").value).toBe("1");
    await user.selectOptions(select("Day of the week"), "5");
    await user.selectOptions(select("Time of day"), "23:30");
    expect(within(schedulePreview()).getByText("Every Friday at 23:30")).toBeTruthy();

    await user.selectOptions(select("Repeat"), "monthly");
    await user.selectOptions(select("Day of the month"), "15");
    expect(within(schedulePreview()).getByText("On day 15 of every month at 23:30")).toBeTruthy();

    // The minute carries over to the kinds that repeat during the day.
    await user.selectOptions(select("Repeat"), "every6h");
    expect(screen.queryByLabelText("Time of day")).toBeNull();
    expect(select("Minutes past the hour").value).toBe("30");
    await user.selectOptions(select("Minutes past the hour"), "45");
    expect(within(schedulePreview()).getByText("Every 6 hours at minute 45")).toBeTruthy();

    await user.selectOptions(select("Time zone"), "Europe/Berlin");
    const body = await saveExisting(user, backend, "plan-nightly");
    expect(body).toMatchObject({ schedule: { cron: "45 */6 * * *", timezone: "Europe/Berlin" } });
  });

  it("opens an hourly plan on its minute and a custom one on the cron field", async () => {
    renderApp({
      signedInAs: "admin",
      hash: "#/plans/plan-hourly?step=schedule",
      prepare: changePlan("plan-hourly", () => ({
        schedule: { cron: "15 * * * *", timezone: "Europe/Berlin" },
      })),
    });
    await screen.findByRole("heading", { name: "Staging hourly" });
    expect(select("Repeat").value).toBe("hourly");
    expect(select("Minutes past the hour").value).toBe("15");
    expect(select("Time zone").value).toBe("Europe/Berlin");
  });

  it("shows a schedule no preset describes as a cron expression", async () => {
    const { user, backend } = renderApp({
      signedInAs: "admin",
      hash: "#/plans/plan-nightly?step=schedule",
      prepare: changePlan("plan-nightly", () => ({
        schedule: { cron: "0 2 * * 1-5", timezone: "Mars/Olympus" },
      })),
    });
    await screen.findByRole("heading", { name: "Nightly production" });
    expect(select("Repeat").value).toBe("custom");
    expect((screen.getByLabelText("Cron expression") as HTMLInputElement).value).toBe(
      "0 2 * * 1-5",
    );
    // A zone this browser does not know is still offered, and flagged on save.
    expect(select("Time zone").value).toBe("Mars/Olympus");
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    expect(screen.getByText(/"Mars\/Olympus" is not a known time zone/)).toBeTruthy();

    // Picking a preset from a custom schedule starts from the defaults.
    await user.selectOptions(select("Repeat"), "daily");
    expect(select("Time of day").value).toBe("02:00");
    await user.selectOptions(select("Time zone"), "UTC");
    const body = await saveExisting(user, backend, "plan-nightly");
    expect(body).toMatchObject({ schedule: { cron: "0 2 * * *", timezone: "UTC" } });
  });
});

describe("full backup interval", () => {
  it("offers common intervals and keeps a plan's own", async () => {
    const { user, backend } = renderApp({
      signedInAs: "admin",
      hash: "#/plans/plan-local?step=schedule",
      prepare: changePlan("plan-local", () => ({ incremental: { fullEveryDays: 0.5 } })),
    });
    await screen.findByRole("heading", { name: "Local dev snapshot" });
    expect(select("Full backup").value).toBe("0.5");
    expect(select("Full backup").selectedOptions[0]?.textContent).toBe(
      "Every 0.5 days (this plan's setting)",
    );
    await user.selectOptions(select("Full backup"), "14");
    const body = await saveExisting(user, backend, "plan-local");
    expect(body).toMatchObject({ incremental: { fullEveryDays: 14 } });
  });
});

describe("retention presets", () => {
  it("opens a plan whose counts match no preset as Custom, and switches to a preset", async () => {
    // plan-nightly keeps last 3 + daily 7 + weekly 4 + monthly 12: no preset.
    const { user, backend } = renderApp({
      signedInAs: "admin",
      hash: "#/plans/plan-nightly?step=retention",
    });
    await screen.findByRole("heading", { name: "Nightly production" });
    expect(select("Keep").value).toBe("custom");
    expect((screen.getByLabelText("Last N") as HTMLInputElement).value).toBe("3");

    await user.selectOptions(select("Keep"), "last30");
    expect(screen.queryByLabelText("Last N")).toBeNull();
    expect(screen.getByText("Keeps the 30 newest backups and deletes older ones.")).toBeTruthy();

    // Custom again shows the preset's counts, ready to adjust.
    await user.selectOptions(select("Keep"), "custom");
    expect((screen.getByLabelText("Last N") as HTMLInputElement).value).toBe("30");
    await user.clear(screen.getByLabelText("Last N"));
    await user.type(screen.getByLabelText("Last N"), "45");
    const body = await saveExisting(user, backend, "plan-nightly");
    expect(body).toMatchObject({ retention: { last: 45 } });
  });

  it("opens a plan without retention as keep-everything and saves none", async () => {
    const { user, backend } = renderApp({ signedInAs: "admin", hash: "#/plans/plan-local" });
    await screen.findByRole("heading", { name: "Local dev snapshot" });
    await openStep(user, "Retention & alerts");
    expect(select("Keep").value).toBe("forever");
    await user.selectOptions(select("Keep"), "recommended");
    await user.selectOptions(select("Keep"), "forever");
    const body = await saveExisting(user, backend, "plan-local");
    expect(body).not.toHaveProperty("retention");
  });
});
