/**
 * React glue shared by every page: the API client, the signed-in session and a small
 * data-loading hook.
 *
 * Pages call `useApi()` for the typed client, `useSession()` for who is signed in and
 * what they may do, and `useLoad()` to fetch data with loading/error state and a
 * `reload()` for after mutations. There is no global cache on purpose: each page loads
 * what it shows, which keeps data fresh and the code easy to follow.
 */

import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { ROLES, type Role, type SessionInfo, type UserView } from "../shared/api.ts";
import type { ApiClient } from "./api.ts";

// ---------------------------------------------------------------------------
// API client
// ---------------------------------------------------------------------------

const ApiContext = createContext<ApiClient | undefined>(undefined);

/** Makes `client` available to `useApi()` below it. */
export function ApiProvider(props: { client: ApiClient; children: ReactNode }) {
  return <ApiContext value={props.client}>{props.children}</ApiContext>;
}

/** The typed API client. Must be used below `ApiProvider`. */
export function useApi(): ApiClient {
  const client = useContext(ApiContext);
  if (client === undefined) throw new Error("useApi() must be used inside <ApiProvider>.");
  return client;
}

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

/** What pages know about the signed-in user. */
export interface SessionState {
  readonly session: SessionInfo;
  /** The signed-in user (always set on pages behind the login). */
  readonly user: UserView | undefined;
  /** True when the user's role includes `role` (admin ⊃ operator ⊃ viewer). */
  hasRole(role: Role): boolean;
  /** Replaces the session, e.g. after login. */
  setSession(session: SessionInfo): void;
  /** Ends the session on the server and shows the login page. */
  logout(): Promise<void>;
}

const SessionContext = createContext<SessionState | undefined>(undefined);

/** True when `actual` is `required` or a more powerful role. */
export function roleIncludes(actual: Role | undefined, required: Role): boolean {
  if (actual === undefined) return false;
  return ROLES.indexOf(actual) >= ROLES.indexOf(required);
}

/** Provides the session to `useSession()`. The app shell owns the state. */
export function SessionProvider(props: {
  session: SessionInfo;
  onChange: (session: SessionInfo) => void;
  children: ReactNode;
}) {
  const client = useApi();
  const { session, onChange } = props;
  const logout = useCallback(async () => {
    try {
      await client.call("DELETE /api/session");
    } finally {
      client.forgetSession();
      onChange({ setupComplete: session.setupComplete, authMethods: session.authMethods });
    }
  }, [client, onChange, session.setupComplete, session.authMethods]);

  const value: SessionState = {
    session,
    user: session.user,
    hasRole: (role) => roleIncludes(session.user?.role, role),
    setSession: onChange,
    logout,
  };
  return <SessionContext value={value}>{props.children}</SessionContext>;
}

/** The current session. Must be used below `SessionProvider`. */
export function useSession(): SessionState {
  const state = useContext(SessionContext);
  if (state === undefined) throw new Error("useSession() must be used inside <SessionProvider>.");
  return state;
}

// ---------------------------------------------------------------------------
// Data loading
// ---------------------------------------------------------------------------

/** The state of one `useLoad` call. */
export interface LoadState<T> {
  readonly data: T | undefined;
  readonly error: unknown;
  /** True while the first load or a reload is in flight. */
  readonly loading: boolean;
  /** Loads again, e.g. after a change. Keeps showing the old data meanwhile. */
  reload(): void;
  /** Replaces the data locally (optimistic update after a mutation). */
  setData(data: T): void;
}

/**
 * Loads data and tracks loading/error state.
 *
 * `key` identifies what is being loaded: when it changes the data is loaded again, and
 * an empty key means "nothing to load yet" (e.g. no storage chosen). The `load`
 * function may change every render; only `key` decides when to run it. A load that is
 * superseded is aborted, so late responses never overwrite newer data.
 */
export function useLoad<T>(key: string, load: (signal: AbortSignal) => Promise<T>): LoadState<T> {
  const [data, setData] = useState<T | undefined>(undefined);
  const [error, setError] = useState<unknown>(undefined);
  const [loading, setLoading] = useState(key !== "");
  const [generation, setGeneration] = useState(0);
  const loadRef = useRef(load);
  loadRef.current = load;

  useEffect(() => {
    // `generation` is read so that reload() re-runs this effect.
    if (key === "" || generation < 0) {
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    loadRef.current(controller.signal).then(
      (result) => {
        if (controller.signal.aborted) return;
        setData(result);
        setError(undefined);
        setLoading(false);
      },
      (failure: unknown) => {
        if (controller.signal.aborted) return;
        setError(failure);
        setLoading(false);
      },
    );
    return () => controller.abort();
  }, [key, generation]);

  const reload = useCallback(() => setGeneration((value) => value + 1), []);
  return { data, error, loading, reload, setData };
}
