import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { motion, AnimatePresence } from "motion/react";

interface ToastAction {
  label: string;
  onClick: () => void;
}

interface ToastEntry {
  id: number;
  message: string;
  action?: ToastAction;
  /** Auto-dismiss in ms (0 disables). Default 8000. */
  durationMs?: number;
}

interface ToastApi {
  show: (entry: Omit<ToastEntry, "id">) => void;
  dismiss: (id: number) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used inside <ToastProvider>");
  return ctx;
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastEntry[]>([]);
  const idRef = useRef(0);

  const dismiss = useCallback((id: number) => {
    setToasts((curr) => curr.filter((t) => t.id !== id));
  }, []);

  const show = useCallback(
    (entry: Omit<ToastEntry, "id">) => {
      const id = ++idRef.current;
      const next: ToastEntry = { id, ...entry };
      setToasts((curr) => [...curr, next]);
      const ms = entry.durationMs ?? 8000;
      if (ms > 0) {
        window.setTimeout(() => dismiss(id), ms);
      }
    },
    [dismiss],
  );

  const api = useMemo<ToastApi>(() => ({ show, dismiss }), [show, dismiss]);

  return (
    <ToastContext.Provider value={api}>
      {children}
      <ToastHost toasts={toasts} dismiss={dismiss} />
    </ToastContext.Provider>
  );
}

function ToastHost({
  toasts,
  dismiss,
}: {
  toasts: ToastEntry[];
  dismiss: (id: number) => void;
}) {
  return (
    <div
      style={{
        position: "fixed",
        right: 16,
        bottom: 16,
        zIndex: "var(--z-toast)",
        display: "flex",
        flexDirection: "column-reverse",
        gap: 8,
        pointerEvents: "none",
      }}
    >
      <AnimatePresence initial={false}>
        {toasts.map((t) => (
          <motion.div
            key={t.id}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 4 }}
            transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
            style={{
              pointerEvents: "auto",
              display: "flex",
              alignItems: "center",
              gap: 12,
              minWidth: 280,
              maxWidth: 420,
              padding: "10px 12px",
              borderRadius: "var(--radius-md)",
              backgroundColor: "var(--surface-3)",
              border: "var(--border-1)",
              boxShadow: "var(--shadow-popover)",
              color: "var(--text-primary)",
              fontSize: "var(--text-sm)",
            }}
          >
            <span
              style={{
                flex: 1,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {t.message}
            </span>
            {t.action && (
              <button
                type="button"
                onClick={() => {
                  t.action!.onClick();
                  dismiss(t.id);
                }}
                style={{
                  height: 22,
                  padding: "0 10px",
                  borderRadius: "var(--radius-xs)",
                  backgroundColor: "var(--surface-4)",
                  color: "var(--accent)",
                  fontSize: "var(--text-xs)",
                  fontWeight: "var(--weight-medium)",
                }}
              >
                {t.action.label}
              </button>
            )}
            <button
              type="button"
              onClick={() => dismiss(t.id)}
              title="Dismiss"
              aria-label="Dismiss"
              style={{
                height: 22,
                width: 22,
                color: "var(--text-tertiary)",
                fontSize: "var(--text-sm)",
                lineHeight: 1,
                borderRadius: "var(--radius-xs)",
              }}
            >
              ×
            </button>
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}
