/**
 * Toasts: short confirmations ("Plan saved") and failures shown in a corner and read
 * out by screen readers through a live region. Success toasts disappear after a few
 * seconds; error toasts stay until dismissed, because people need time to read them.
 */

import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
} from "react";
import { StatusBadge } from "./status-badge.tsx";

/** How a toast looks; errors also stay until dismissed. */
export type ToastTone = "success" | "error" | "info";

interface ToastItem {
  readonly id: number;
  readonly tone: ToastTone;
  readonly message: string;
}

/** What `useToast()` returns. */
export interface ToastApi {
  show(tone: ToastTone, message: string): void;
}

const ToastContext = createContext<ToastApi | undefined>(undefined);

/** How long success and info toasts stay visible. */
const TOAST_TIMEOUT_MS = 5_000;

/** Renders toasts for everything below it. */
export function ToastProvider(props: { children: ReactNode }) {
  const [toasts, setToasts] = useState<readonly ToastItem[]>([]);
  const nextId = useRef(1);

  const dismiss = useCallback((id: number) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const api = useMemo<ToastApi>(
    () => ({
      show(tone, message) {
        const id = nextId.current;
        nextId.current += 1;
        setToasts((current) => [...current, { id, tone, message }]);
        if (tone !== "error") setTimeout(() => dismiss(id), TOAST_TIMEOUT_MS);
      },
    }),
    [dismiss],
  );

  return (
    <ToastContext value={api}>
      {props.children}
      {/* The live region exists from the start so screen readers notice additions. */}
      <section className="toast-region" aria-live="polite" aria-label="Notifications">
        {toasts.map((toast) => (
          <div
            key={toast.id}
            className={`toast toast-${toast.tone}`}
            role={toast.tone === "error" ? "alert" : "status"}
          >
            <StatusBadge
              status={
                toast.tone === "error"
                  ? "failed"
                  : toast.tone === "success"
                    ? "succeeded"
                    : "queued"
              }
              label={toast.tone === "error" ? "Error" : toast.tone === "success" ? "Done" : "Note"}
            />
            <span className="toast-message">{toast.message}</span>
            <button
              type="button"
              className="icon-button"
              aria-label="Dismiss notification"
              onClick={() => dismiss(toast.id)}
            >
              <span aria-hidden="true">×</span>
            </button>
          </div>
        ))}
      </section>
    </ToastContext>
  );
}

/** Shows toasts. Must be used below `ToastProvider`. */
export function useToast(): ToastApi {
  const api = useContext(ToastContext);
  if (api === undefined) throw new Error("useToast() must be used inside <ToastProvider>.");
  return api;
}
