import { motion } from "motion/react";
import { useEffect, useState } from "react";
import { connectionsViewVariants } from "@/design/motion";
import {
  gstack,
  type GstackHealth,
  type GstackLogEntry,
  type GstackStatus,
} from "@/lib/gstack";

interface Props {
  onClose: () => void;
  /**
   * When true, renders inline (fills its container) instead of as the
   * absolute-positioned overlay. Used by the workspace pane tree.
   */
  embedded?: boolean;
}

const SCREENSHOT_INTERVAL_MS = 1000;
const STATUS_INTERVAL_MS = 1500;

/**
 * GStack browser pane (Task #14).
 *
 * Slides in from the right edge. Shows live screenshot of the page
 * GStack is on, the URL, and a tailing console feed.
 *
 * If the daemon isn't reachable, surfaces an empty-state with the
 * install hint instead of an error wall.
 */
export function BrowserPane({ onClose, embedded = false }: Props) {
  const [health, setHealth] = useState<GstackHealth | null>(null);
  const [status, setStatus] = useState<GstackStatus | null>(null);
  const [logs, setLogs] = useState<GstackLogEntry[]>([]);
  const [screenshotKey, setScreenshotKey] = useState(0);

  // Health check on mount
  useEffect(() => {
    let cancelled = false;
    gstack.health().then((h) => {
      if (!cancelled) setHealth(h);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Poll status + console while connected
  useEffect(() => {
    if (!health?.ok) return;
    let cancelled = false;
    const poll = async () => {
      const s = await gstack.status();
      if (!cancelled) setStatus(s);
      const c = await gstack.console();
      if (!cancelled && c) setLogs(c.entries.slice(-100));
    };
    void poll();
    const t = window.setInterval(() => void poll(), STATUS_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(t);
    };
  }, [health?.ok]);

  // Bump screenshot key periodically to force <img> reload
  useEffect(() => {
    if (!health?.ok || !status?.ready) return;
    const t = window.setInterval(
      () => setScreenshotKey((k) => k + 1),
      SCREENSHOT_INTERVAL_MS,
    );
    return () => window.clearInterval(t);
  }, [health?.ok, status?.ready]);

  // Esc to close — overlay mode only. In embedded (in-pane) mode the
  // PaneFrame's × is the canonical way to close, and a global Esc would
  // collide with the user pressing Esc inside the pane for other reasons.
  useEffect(() => {
    if (embedded) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, embedded]);

  const overlayStyle = {
    position: "absolute" as const,
    top: 0,
    right: 0,
    bottom: 0,
    width: "min(640px, 55vw)",
    backgroundColor: "var(--surface-1)",
    borderLeft: "var(--border-1)",
    boxShadow: "var(--shadow-popover)",
    zIndex: "var(--z-modal)",
    display: "flex",
    flexDirection: "column" as const,
  };
  const embeddedStyle = {
    position: "relative" as const,
    height: "100%",
    width: "100%",
    backgroundColor: "var(--surface-0)",
    display: "flex",
    flexDirection: "column" as const,
  };
  return (
    <motion.aside
      variants={embedded ? undefined : connectionsViewVariants}
      initial={embedded ? false : "hidden"}
      animate="visible"
      exit="exit"
      style={embedded ? embeddedStyle : overlayStyle}
    >
      <Header
        status={status}
        health={health}
        onClose={onClose}
        embedded={embedded}
      />

      {!health && <Empty label="checking gstack daemon…" />}
      {health && !health.ok && <DaemonOffline error={health.error} />}
      {health?.ok && (
        <>
          <Frame status={status} screenshotKey={screenshotKey} />
          <ConsoleTail logs={logs} />
        </>
      )}
    </motion.aside>
  );
}

function Header({
  status,
  health,
  onClose,
  embedded,
}: {
  status: GstackStatus | null;
  health: GstackHealth | null;
  onClose: () => void;
  embedded?: boolean;
}) {
  // Embedded mode: thin URL bar only (PaneFrame gives the title row).
  // Overlay mode: full title + URL row.
  const height = embedded ? 26 : 36;
  return (
    <div
      style={{
        height,
        flexShrink: 0,
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        padding: "0 var(--space-3)",
        borderBottom: "var(--border-1)",
        backgroundColor: "var(--surface-1)",
        userSelect: "none",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "var(--space-2)",
          minWidth: 0,
        }}
      >
        <Dot
          color={
            health?.ok
              ? "var(--state-success)"
              : health
                ? "var(--state-error)"
                : "var(--text-tertiary)"
          }
        />
        {!embedded && (
          <span
            style={{
              fontFamily: "var(--font-sans)",
              fontSize: "var(--text-sm)",
              fontWeight: "var(--weight-medium)",
              color: "var(--text-primary)",
              letterSpacing: "var(--tracking-tight)",
            }}
          >
            browser
          </span>
        )}
        <span
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: "var(--text-2xs)",
            color: "var(--text-tertiary)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            minWidth: 0,
          }}
        >
          {status?.url ?? (health?.ok ? "no url" : "daemon offline")}
        </span>
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: "var(--space-1)" }}>
        {health?.ok && (
          <button
            type="button"
            onClick={() => void gstack.openInBrowser()}
            title="open in real browser"
            style={{
              height: 20,
              padding: "0 var(--space-2)",
              fontFamily: "var(--font-sans)",
              fontSize: "var(--text-2xs)",
              color: "var(--text-secondary)",
              backgroundColor: "transparent",
              border: "var(--border-1)",
              borderRadius: "var(--radius-sm)",
              cursor: "pointer",
            }}
          >
            open
          </button>
        )}
        {!embedded && (
          <button
            type="button"
            onClick={onClose}
            title="close (esc)"
            style={{
              width: 24,
              height: 24,
              backgroundColor: "transparent",
              color: "var(--text-tertiary)",
              fontFamily: "var(--font-mono)",
              fontSize: "var(--text-md)",
              borderRadius: "var(--radius-sm)",
              cursor: "pointer",
            }}
          >
            ×
          </button>
        )}
      </div>
    </div>
  );
}

function Frame({
  status,
  screenshotKey,
}: {
  status: GstackStatus | null;
  screenshotKey: number;
}) {
  if (!status?.ready) {
    return <Empty label="daemon connected · waiting for a page" />;
  }
  return (
    <div
      style={{
        flex: 1,
        minHeight: 0,
        backgroundColor: "var(--surface-0)",
        display: "grid",
        placeItems: "center",
        overflow: "hidden",
      }}
    >
      <img
        key={screenshotKey}
        src={gstack.screenshotUrl()}
        alt={status.title ?? "browser preview"}
        style={{
          maxWidth: "100%",
          maxHeight: "100%",
          objectFit: "contain",
        }}
      />
    </div>
  );
}

function ConsoleTail({ logs }: { logs: GstackLogEntry[] }) {
  return (
    <div
      style={{
        height: 200,
        flexShrink: 0,
        backgroundColor: "var(--surface-1)",
        borderTop: "var(--border-1)",
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
      }}
    >
      <div
        style={{
          padding: "var(--space-1) var(--space-3)",
          fontFamily: "var(--font-sans)",
          fontSize: "var(--text-2xs)",
          fontWeight: "var(--weight-semibold)",
          letterSpacing: "var(--tracking-caps)",
          textTransform: "uppercase",
          color: "var(--text-tertiary)",
          borderBottom: "var(--border-1)",
        }}
      >
        console · {logs.length}
      </div>
      <div style={{ flex: 1, minHeight: 0, overflowY: "auto" }}>
        {logs.length === 0 ? (
          <Empty label="(no entries)" small />
        ) : (
          logs.map((entry, i) => (
            <LogRow key={`${entry.ts}-${i}`} entry={entry} />
          ))
        )}
      </div>
    </div>
  );
}

function LogRow({ entry }: { entry: GstackLogEntry }) {
  const tone =
    entry.level === "error"
      ? "var(--state-error)"
      : entry.level === "warn"
        ? "var(--state-warning)"
        : "var(--text-secondary)";
  return (
    <div
      style={{
        padding: "2px var(--space-3)",
        borderLeft:
          entry.level === "error"
            ? "2px solid var(--state-error)"
            : "2px solid transparent",
        backgroundColor:
          entry.level === "error" ? "var(--state-error-bg)" : "transparent",
      }}
    >
      <span
        style={{
          fontFamily: "var(--font-mono)",
          fontSize: "var(--text-xs)",
          color: tone,
          fontVariantLigatures: "none",
        }}
      >
        {entry.text}
      </span>
    </div>
  );
}

function Dot({ color }: { color: string }) {
  return (
    <span
      style={{
        width: 6,
        height: 6,
        borderRadius: "var(--radius-pill)",
        backgroundColor: color,
        flexShrink: 0,
      }}
    />
  );
}

function Empty({ label, small = false }: { label: string; small?: boolean }) {
  return (
    <div
      style={{
        flex: 1,
        display: "grid",
        placeItems: "center",
        padding: "var(--space-6) var(--space-4)",
        textAlign: "center",
        color: "var(--text-tertiary)",
        fontSize: small ? "var(--text-xs)" : "var(--text-sm)",
        fontFamily: "var(--font-sans)",
      }}
    >
      {label}
    </div>
  );
}

function DaemonOffline({ error }: { error?: string }) {
  return (
    <div
      style={{
        flex: 1,
        display: "grid",
        placeItems: "center",
        padding: "var(--space-8) var(--space-6)",
      }}
    >
      <div
        style={{
          maxWidth: 380,
          textAlign: "center",
          display: "grid",
          gap: "var(--space-3)",
          fontFamily: "var(--font-sans)",
        }}
      >
        <div
          style={{
            fontSize: "var(--text-md)",
            fontWeight: "var(--weight-semibold)",
            color: "var(--text-primary)",
          }}
        >
          gstack daemon not running
        </div>
        <div
          style={{
            fontSize: "var(--text-sm)",
            color: "var(--text-secondary)",
            lineHeight: "var(--leading-sm)",
          }}
        >
          The browser pane talks to gstack's persistent Chromium daemon. Start
          it from a terminal or install it if you haven't yet.
        </div>
        <div
          style={{
            display: "grid",
            gap: 4,
            justifyContent: "center",
          }}
        >
          <Mono>brew install gstack</Mono>
          <Mono>gstack browser start</Mono>
        </div>
        {error && (
          <div
            style={{
              fontSize: "var(--text-2xs)",
              fontFamily: "var(--font-mono)",
              color: "var(--text-tertiary)",
              wordBreak: "break-all",
            }}
          >
            {error}
          </div>
        )}
      </div>
    </div>
  );
}

function Mono({ children }: { children: React.ReactNode }) {
  return (
    <span
      style={{
        fontFamily: "var(--font-mono)",
        fontSize: "var(--text-xs)",
        color: "var(--text-secondary)",
        backgroundColor: "var(--surface-2)",
        padding: "2px 8px",
        borderRadius: "var(--radius-xs)",
        fontVariantLigatures: "none",
      }}
    >
      {children}
    </span>
  );
}
