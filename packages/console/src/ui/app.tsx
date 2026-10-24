/**
 * The app shell: loads the session, decides between setup, login and the console, and
 * renders the navigation plus the page that matches the current hash route.
 *
 * Flow:
 *   GET /api/session
 *     ├─ setup not complete → Setup page (token from the setup link) or "setup required"
 *     ├─ not signed in      → Login page
 *     └─ signed in          → navigation + routed page
 * A 401 from any later request (session expired) drops back to the login page.
 */

import { type ReactNode, useCallback, useEffect, useState } from "react";
import type { Role, SessionInfo } from "../shared/api.ts";
import type { ApiClient } from "./api.ts";
import { Button } from "./components/button.tsx";
import { ErrorNotice, Loading, Notice, PageHeader } from "./components/layout.tsx";
import { ToastProvider, useToast } from "./components/toast.tsx";
import { ApiProvider, SessionProvider, useApi, useSession } from "./context.tsx";
import { useWelcomeRedirect } from "./onboarding.ts";
import { AuditPage } from "./pages/audit.tsx";
import { BackupDetailPage } from "./pages/backup-detail.tsx";
import { BackupsPage } from "./pages/backups.tsx";
import { ConnectionDetailPage } from "./pages/connection-detail.tsx";
import { ConnectionsPage } from "./pages/connections.tsx";
import { EditHistoryPage } from "./pages/edit-history.tsx";
import { JobDetailPage } from "./pages/job-detail.tsx";
import { JobsPage } from "./pages/jobs.tsx";
import { LiveBrowserPage } from "./pages/live-browser.tsx";
import { LoginPage } from "./pages/login.tsx";
import { OverviewPage } from "./pages/overview.tsx";
import { PlanEditorPage } from "./pages/plan-editor.tsx";
import { PlansPage } from "./pages/plans.tsx";
import { RestoreWizardPage } from "./pages/restore-wizard.tsx";
import { SettingsPage } from "./pages/settings.tsx";
import { SetupPage } from "./pages/setup.tsx";
import { StoragePage } from "./pages/storage.tsx";
import { UsersPage } from "./pages/users.tsx";
import { WelcomePage } from "./pages/welcome.tsx";
import { matchPath, useLocation } from "./router.ts";
import { applyTheme, nextTheme, storedTheme, type ThemeChoice } from "./theme.ts";

/** Props for `App`. */
export interface AppProps {
  readonly client: ApiClient;
  /** Shows a "mock data" banner and sign-in hint. */
  readonly mock?: boolean;
}

/** The whole console. `client` decides whether it talks to the server or the mock. */
export function App(props: AppProps) {
  return (
    <ToastProvider>
      <ApiProvider client={props.client}>
        <SessionGate mock={props.mock === true} />
      </ApiProvider>
    </ToastProvider>
  );
}

/** Reads the setup token from `/setup?token=…` (the link in the server log) or `#/setup?token=…`. */
function setupTokenFromUrl(hashQuery: URLSearchParams): string | undefined {
  const fromSearch = new URLSearchParams(window.location.search).get("token");
  return fromSearch ?? hashQuery.get("token") ?? undefined;
}

function SessionGate(props: { mock: boolean }) {
  const client = useApi();
  const toast = useToast();
  const location = useLocation();
  const [session, setSession] = useState<SessionInfo | undefined>(undefined);
  const [error, setError] = useState<unknown>(undefined);

  const loadSession = useCallback(() => {
    setError(undefined);
    client.call("GET /api/session").then(setSession, setError);
  }, [client]);

  useEffect(loadSession, [loadSession]);

  // An expired session anywhere sends the user back to the login page.
  useEffect(() => {
    client.onUnauthorized = () => {
      setSession((current) =>
        current === undefined
          ? current
          : { setupComplete: current.setupComplete, authMethods: current.authMethods },
      );
      toast.show("info", "Your session has expired. Sign in again.");
    };
    return () => {
      client.onUnauthorized = undefined;
    };
  }, [client, toast]);

  if (error !== undefined) {
    return (
      <main className="centered-page">
        <ErrorNotice title="Cannot reach the console server" error={error} onRetry={loadSession} />
      </main>
    );
  }
  if (session === undefined) {
    return (
      <main className="centered-page">
        <Loading label="Connecting to the console…" />
      </main>
    );
  }

  const isSetupUrl = window.location.pathname.endsWith("/setup") || location.path === "/setup";
  if (!session.setupComplete) {
    return (
      <SetupPage
        token={setupTokenFromUrl(location.query)}
        onDone={setSession}
        mock={props.mock}
        fromSetupLink={isSetupUrl}
        {...(session.setup === undefined ? {} : { setup: session.setup })}
      />
    );
  }
  if (session.user === undefined) {
    return <LoginPage session={session} onSignedIn={setSession} mock={props.mock} />;
  }
  return (
    <SessionProvider session={session} onChange={setSession}>
      <Shell mock={props.mock} />
    </SessionProvider>
  );
}

/** One routed page: a hash path pattern, its nav section and how to render it. */
interface RouteDefinition {
  readonly pattern: string;
  readonly title: string;
  /** Which navigation item is highlighted. */
  readonly section: string;
  readonly role?: Role;
  readonly render: (params: Readonly<Record<string, string>>, query: URLSearchParams) => ReactNode;
}

/** Every page. The first match wins, so more specific patterns come first. */
const ROUTES: readonly RouteDefinition[] = [
  { pattern: "/", title: "Overview", section: "overview", render: () => <OverviewPage /> },
  {
    // The first stop of a console without connections (onboarding.ts redirects here).
    pattern: "/welcome",
    title: "Welcome",
    section: "connections",
    role: "admin",
    render: () => <WelcomePage />,
  },
  {
    pattern: "/connections",
    title: "Connections",
    section: "connections",
    render: () => <ConnectionsPage />,
  },
  {
    pattern: "/connections/:id",
    title: "Connection",
    section: "connections",
    render: (params) => <ConnectionDetailPage connectionId={params.id ?? ""} />,
  },
  {
    pattern: "/connections/:id/data",
    title: "Live data",
    section: "connections",
    role: "operator",
    // The page shows the backup actions bar (pages/backup-actions.tsx) under its title.
    render: (params, query) => (
      <LiveBrowserPage connectionId={params.id ?? ""} ns={query.get("ns") ?? undefined} />
    ),
  },
  { pattern: "/storage", title: "Storage", section: "storage", render: () => <StoragePage /> },
  { pattern: "/plans", title: "Backup plans", section: "plans", render: () => <PlansPage /> },
  {
    pattern: "/plans/new",
    title: "New plan",
    section: "plans",
    role: "admin",
    render: () => <PlanEditorPage />,
  },
  {
    pattern: "/plans/:id",
    title: "Edit plan",
    section: "plans",
    render: (params) => <PlanEditorPage planId={params.id ?? ""} />,
  },
  {
    pattern: "/backups",
    title: "Backups",
    section: "backups",
    render: (_params, query) => <BackupsPage storageId={query.get("storage") ?? undefined} />,
  },
  {
    pattern: "/backups/:storageId",
    title: "Backups",
    section: "backups",
    render: (params) => <BackupsPage storageId={params.storageId} />,
  },
  {
    pattern: "/backups/:storageId/:backupId",
    title: "Backup",
    section: "backups",
    render: (params, query) => (
      <BackupDetailPage
        storageId={params.storageId ?? ""}
        backupId={params.backupId ?? ""}
        tab={query.get("tab") ?? undefined}
      />
    ),
  },
  {
    pattern: "/backups/:storageId/:backupId/restore",
    title: "Restore",
    section: "backups",
    role: "operator",
    render: (params, query) => (
      <RestoreWizardPage
        storageId={params.storageId ?? ""}
        backupId={params.backupId ?? ""}
        namespace={query.get("ns") ?? undefined}
        documentIds={query.get("ids") ?? undefined}
      />
    ),
  },
  { pattern: "/jobs", title: "Jobs", section: "jobs", render: () => <JobsPage /> },
  {
    pattern: "/jobs/:id",
    title: "Job",
    section: "jobs",
    render: (params) => <JobDetailPage jobId={params.id ?? ""} />,
  },
  {
    pattern: "/edit-history",
    title: "Edit history",
    section: "edit-history",
    role: "operator",
    render: (_params, query) => (
      <EditHistoryPage connectionId={query.get("connection") ?? undefined} />
    ),
  },
  { pattern: "/audit", title: "Audit log", section: "audit", render: () => <AuditPage /> },
  {
    pattern: "/users",
    title: "Users",
    section: "users",
    role: "admin",
    render: () => <UsersPage />,
  },
  { pattern: "/settings", title: "Settings", section: "settings", render: () => <SettingsPage /> },
];

/** Navigation entries, in display order. */
const NAV_ITEMS: readonly { section: string; label: string; href: string; role?: Role }[] = [
  { section: "overview", label: "Overview", href: "#/" },
  { section: "plans", label: "Backup plans", href: "#/plans" },
  { section: "backups", label: "Backups", href: "#/backups" },
  { section: "jobs", label: "Jobs", href: "#/jobs" },
  { section: "edit-history", label: "Edit history", href: "#/edit-history", role: "operator" },
  { section: "connections", label: "Connections", href: "#/connections" },
  { section: "storage", label: "Storage", href: "#/storage" },
  { section: "audit", label: "Audit log", href: "#/audit" },
  { section: "users", label: "Users", href: "#/users", role: "admin" },
  { section: "settings", label: "Settings", href: "#/settings" },
];

/** Finds the route for a path. */
export function resolveRoute(
  path: string,
): { route: RouteDefinition; params: Readonly<Record<string, string>> } | undefined {
  for (const route of ROUTES) {
    const params = matchPath(route.pattern, path);
    if (params !== undefined) return { route, params };
  }
  return undefined;
}

/** How long to wait for a page's heading after navigating (its data may still be loading). */
const HEADING_WAIT_MS = 10_000;

/**
 * Focuses the page's `<h1>` as soon as it is rendered. Most pages show it only
 * once their data has loaded, after this runs, so it watches `main` until the
 * heading appears. If the user has moved focus elsewhere in the meantime, focus
 * is left where they put it. Returns a function that stops watching.
 */
export function focusHeadingWhenRendered(main: HTMLElement | null): () => void {
  if (main === null) return () => {};
  const focusedAtNavigation = document.activeElement;
  const tryFocus = (): boolean => {
    const heading = main.querySelector<HTMLElement>("h1");
    if (heading === null) return false;
    const active = document.activeElement;
    const userMovedFocus =
      active !== null && active !== document.body && active !== focusedAtNavigation;
    if (!userMovedFocus) heading.focus();
    return true;
  };
  if (tryFocus()) return () => {};
  const observer = new MutationObserver(() => {
    if (tryFocus()) stop();
  });
  const timer = setTimeout(() => stop(), HEADING_WAIT_MS);
  function stop(): void {
    observer.disconnect();
    clearTimeout(timer);
  }
  observer.observe(main, { childList: true, subtree: true });
  return stop;
}

function Shell(props: { mock: boolean }) {
  const location = useLocation();
  const { user, hasRole, logout } = useSession();
  const [theme, setTheme] = useState<ThemeChoice>(storedTheme);
  const resolved = resolveRoute(location.path);
  // An admin of a console without connections starts on the welcome page.
  useWelcomeRedirect(location.path, hasRole("admin"));

  useEffect(() => {
    document.title = `${resolved?.route.title ?? "Not found"} · MongoShield`;
  }, [resolved?.route.title]);

  // Move focus to the page heading on navigation so screen readers announce the new page.
  useEffect(() => {
    if (location.path === "") return;
    return focusHeadingWhenRendered(document.getElementById("main"));
  }, [location.path]);

  const toggleTheme = () => {
    const next = nextTheme(theme);
    applyTheme(next);
    setTheme(next);
  };

  let page: ReactNode;
  if (resolved === undefined) {
    // These pages still get a heading: navigation moves focus to it, and screen
    // reader users find their way by headings.
    page = (
      <>
        <PageHeader title="Page not found" />
        <Notice tone="warning">
          There is no page at {location.path}. <a href="#/">Go to the overview</a>.
        </Notice>
      </>
    );
  } else if (resolved.route.role !== undefined && !hasRole(resolved.route.role)) {
    page = (
      <>
        <PageHeader title="Not allowed" />
        <Notice tone="warning">
          This page needs the {resolved.route.role} role. You are signed in as {user?.role}.
        </Notice>
      </>
    );
  } else {
    page = resolved.route.render(resolved.params, location.query);
  }

  return (
    <div className="shell">
      {/* A button, not a link: the URL hash belongs to the router, so "#main" would navigate. */}
      <button
        type="button"
        className="skip-link"
        onClick={() => document.getElementById("main")?.focus()}
      >
        Skip to content
      </button>
      <header className="topbar">
        <a href="#/" className="brand">
          <svg
            viewBox="0 0 24 24"
            width="20"
            height="20"
            aria-hidden="true"
            focusable="false"
            className="brand-mark"
          >
            <path d="M12 2l8 3v6c0 5-3.4 9.4-8 11-4.6-1.6-8-6-8-11V5z" />
          </svg>
          MongoShield
        </a>
        {props.mock ? (
          <span className="mock-badge" title="Data is generated in the browser; nothing is saved.">
            Mock data
          </span>
        ) : null}
        <div className="topbar-actions">
          <Button
            variant="ghost"
            size="small"
            onClick={toggleTheme}
            aria-label={`Theme: ${theme}. Change theme`}
          >
            Theme: {theme}
          </Button>
          <span className="topbar-user">
            {user?.username} <span className="muted">({user?.role})</span>
          </span>
          <Button variant="ghost" size="small" onClick={() => void logout()}>
            Sign out
          </Button>
        </div>
      </header>
      <nav className="sidebar" aria-label="Main">
        <ul>
          {NAV_ITEMS.filter((item) => item.role === undefined || hasRole(item.role)).map((item) => (
            <li key={item.section}>
              <a
                href={item.href}
                className="nav-link"
                aria-current={resolved?.route.section === item.section ? "page" : undefined}
              >
                {item.label}
              </a>
            </li>
          ))}
        </ul>
      </nav>
      <main id="main" className="main" tabIndex={-1}>
        {page}
      </main>
    </div>
  );
}
