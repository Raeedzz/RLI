import { motion } from "motion/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { connectionsViewVariants } from "@/design/motion";
import {
  browser,
  type BrowserHealth,
  type BrowserLogEntry,
  type BrowserStatus,
} from "@/lib/browser";

interface Props {
  onClose: () => void;
  /**
   * When true, renders inline (fills its container) instead of as the
   * absolute-positioned overlay. Used by the workspace pane tree.
   */
  embedded?: boolean;
  /**
   * Initial URL to navigate to on mount. If omitted, the URL bar opens
   * empty and waits for the user.
   */
  initialUrl?: string;
}

const SCREENSHOT_INTERVAL_MS = 1000;
const STATUS_INTERVAL_MS = 1500;
const COMMON_DEV_PORTS = [5173, 3000, 8080, 4321, 1420];

/**
 * In-house browser pane — drives the Rust-side browser daemon.
 *
 * URL bar at the top forwards /navigate. Clicks on the screenshot
 * forward /click in viewport coordinates. Keystrokes (when the viewport
 * is "focused") forward to /type or /key. The daemon's PNG screenshot
 * is polled at 1Hz; polling pauses while the tab is hidden so background
 * windows don't burn CPU.
 */
export function BrowserPane({ onClose, embedded = false, initialUrl }: Props) {
  const [health, setHealth] = useState<BrowserHealth | null>(null);
  const [status, setStatus] = useState<BrowserStatus | null>(null);
  const [logs, setLogs] = useState<BrowserLogEntry[]>([]);
  const [screenshotUrl, setScreenshotUrl] = useState<string | null>(null);
  const [urlInput, setUrlInput] = useState(initialUrl ?? "");
  const [focused, setFocused] = useState(false);

  const imgRef = useRef<HTMLImageElement | null>(null);
  const focusTrap = useRef<HTMLTextAreaElement | null>(null);

  // Health check on mount, retry every 2s until daemon is up.
  useEffect(() => {
    let cancelled = false;
    const check = () => {
      void browser.health().then((h) => {
        if (!cancelled) setHealth(h);
      });
    };
    check();
    const t = window.setInterval(() => {
      if (!cancelled && !health?.ok) check();
    }, 2000);
    return () => {
      cancelled = true;
      window.clearInterval(t);
    };
  }, [health?.ok]);

  // Auto-navigate to the initial URL once health flips ok.
  useEffect(() => {
    if (health?.ok && initialUrl && !status?.url) {
      void browser.navigate(initialUrl);
    }
  }, [health?.ok, initialUrl, status?.url]);

  // Poll status + console while connected. Pause when the document is
  // hidden (background window) — no point polling a screenshot the user
  // can't see.
  useEffect(() => {
    if (!health?.ok) return;
    let cancelled = false;
    const poll = async () => {
      if (document.visibilityState === "hidden") return;
      const s = await browser.status();
      if (!cancelled) setStatus(s);
      const c = await browser.console();
      if (!cancelled && c) setLogs(c.entries.slice(-100));
    };
    void poll();
    const t = window.setInterval(() => void poll(), STATUS_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(t);
    };
  }, [health?.ok]);

  // Refresh screenshot URL on a 1Hz tick (drives <img> reload).
  useEffect(() => {
    if (!health?.ok || !status?.ready) return;
    let cancelled = false;
    const tick = async () => {
      if (document.visibilityState === "hidden") return;
      const u = await browser.screenshotUrl();
      if (!cancelled) setScreenshotUrl(u);
    };
    void tick();
    const t = window.setInterval(() => void tick(), SCREENSHOT_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(t);
    };
  }, [health?.ok, status?.ready]);

  // Esc to close — overlay mode only. In embedded (in-pane) mode the
  // PaneFrame's × is the canonical way to close, and a global Esc would
  // collide with the user pressing Esc inside the pane for other reasons.
  useEffect(() => {
    if (embedded) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !focused) {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, embedded, focused]);

  const handleNavigate = useCallback(async (raw: string) => {
    const trimmed = raw.trim();
    if (!trimmed) return;
    // Bare port number → localhost:N.
    let target = trimmed;
    if (/^\d+$/.test(trimmed)) target = `http://localhost:${trimmed}/`;
    else if (!/^https?:\/\//i.test(trimmed)) target = `https://${trimmed}`;
    await browser.navigate(target);
    setUrlInput(target);
  }, []);

  const handleClick = useCallback(async (e: React.MouseEvent<HTMLImageElement>) => {
    const img = imgRef.current;
    if (!img || !img.naturalWidth || !img.naturalHeight) return;
    const rect = img.getBoundingClientRect();
    const xRatio = img.naturalWidth / rect.width;
    const yRatio = img.naturalHeight / rect.height;
    const x = (e.clientX - rect.left) * xRatio;
    const y = (e.clientY - rect.top) * yRatio;
    setFocused(true);
    focusTrap.current?.focus();
    await browser.click(x, y);
  }, []);

  // Map browser keypresses inside the focus trap to /key (named keys)
  // or /type (printable text). The hidden textarea catches the events;
  // we preventDefault to keep its DOM contents empty.
  const handleKey = useCallback(async (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (!focused) return;
    if (e.key === "Escape") {
      setFocused(false);
      focusTrap.current?.blur();
      e.preventDefault();
      return;
    }
    e.preventDefault();
    if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      await browser.type(e.key);
    } else {
      await browser.key(e.key);
    }
  }, [focused]);

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
      <UrlBar
        urlInput={urlInput}
        onUrlChange={setUrlInput}
        onNavigate={handleNavigate}
        onBack={() => void browser.back()}
        onForward={() => void browser.forward()}
        onReload={() => void browser.reload()}
        onOpen={() => void browser.openInBrowser()}
        onClose={onClose}
        embedded={embedded}
        status={status}
        health={health}
      />

      {!health && <Empty label="starting browser daemon…" />}
      {health && !health.ok && <DaemonOffline error={health.error} />}
      {health?.ok && (
        <>
          <Frame
            status={status}
            screenshotUrl={screenshotUrl}
            imgRef={imgRef}
            focused={focused}
            onClick={handleClick}
            onBlur={() => setFocused(false)}
          />
          <textarea
            ref={focusTrap}
            value=""
            onChange={() => {}}
            onKeyDown={handleKey}
            onBlur={() => setFocused(false)}
            tabIndex={-1}
            aria-hidden
            style={{
              position: "absolute",
              left: -9999,
              top: -9999,
              width: 1,
              height: 1,
              opacity: 0,
              pointerEvents: "none",
            }}
          />
          <ConsoleTail logs={logs} />
        </>
      )}
    </motion.aside>
  );
}

function UrlBar({
  urlInput,
  onUrlChange,
  onNavigate,
  onBack,
  onForward,
  onReload,
  onOpen,
  onClose,
  embedded,
  status,
  health,
}: {
  urlInput: string;
  onUrlChange: (v: string) => void;
  onNavigate: (v: string) => Promise<void>;
  onBack: () => void;
  onForward: () => void;
  onReload: () => void;
  onOpen: () => void;
  onClose: () => void;
  embedded?: boolean;
  status: BrowserStatus | null;
  health: BrowserHealth | null;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  return (
    <div
      style={{
        height: 32,
        flexShrink: 0,
        display: "flex",
        alignItems: "center",
        gap: "var(--space-1)",
        padding: "0 var(--space-2)",
        borderBottom: "var(--border-1)",
        backgroundColor: "var(--surface-1)",
      }}
    >
      <NavBtn label="◀" onClick={onBack} disabled={!health?.ok} title="back" />
      <NavBtn label="▶" onClick={onForward} disabled={!health?.ok} title="forward" />
      <NavBtn label="↻" onClick={onReload} disabled={!status?.ready} title="reload" />

      <Dot
        color={
          health?.ok
            ? status?.ready
              ? "var(--state-success)"
              : "var(--text-tertiary)"
            : "var(--state-error)"
        }
      />

      <input
        ref={inputRef}
        type="text"
        value={urlInput}
        onChange={(e) => onUrlChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            void onNavigate(urlInput);
          }
        }}
        placeholder={
          status?.url ?? `localhost:${COMMON_DEV_PORTS[0]} or full URL`
        }
        spellCheck={false}
        style={{
          flex: 1,
          minWidth: 0,
          height: 22,
          padding: "0 var(--space-2)",
          fontFamily: "var(--font-mono)",
          fontSize: "var(--text-2xs)",
          color: "var(--text-primary)",
          backgroundColor: "var(--surface-0)",
          border: "var(--border-1)",
          borderRadius: "var(--radius-sm)",
          outline: "none",
        }}
      />

      <PortQuickList
        ports={COMMON_DEV_PORTS}
        onPick={(p) => {
          const url = `http://localhost:${p}/`;
          onUrlChange(url);
          void onNavigate(url);
        }}
      />

      {health?.ok && (
        <NavBtn label="↗" onClick={onOpen} title="open in real browser" />
      )}
      {!embedded && (
        <NavBtn label="×" onClick={onClose} title="close (esc)" />
      )}
    </div>
  );
}

function NavBtn({
  label,
  onClick,
  title,
  disabled,
}: {
  label: string;
  onClick: () => void;
  title?: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      disabled={disabled}
      style={{
        width: 22,
        height: 22,
        display: "grid",
        placeItems: "center",
        backgroundColor: "transparent",
        color: disabled ? "var(--text-tertiary)" : "var(--text-secondary)",
        fontFamily: "var(--font-mono)",
        fontSize: "var(--text-xs)",
        border: "none",
        borderRadius: "var(--radius-sm)",
        cursor: disabled ? "default" : "pointer",
      }}
    >
      {label}
    </button>
  );
}

function PortQuickList({
  ports,
  onPick,
}: {
  ports: readonly number[];
  onPick: (p: number) => void;
}) {
  return (
    <div style={{ display: "flex", gap: 2 }}>
      {ports.slice(0, 3).map((p) => (
        <button
          key={p}
          type="button"
          onClick={() => onPick(p)}
          title={`localhost:${p}`}
          style={{
            height: 22,
            padding: "0 var(--space-1)",
            fontFamily: "var(--font-mono)",
            fontSize: "var(--text-2xs)",
            color: "var(--text-tertiary)",
            backgroundColor: "transparent",
            border: "var(--border-1)",
            borderRadius: "var(--radius-sm)",
            cursor: "pointer",
          }}
        >
          {p}
        </button>
      ))}
    </div>
  );
}

function Frame({
  status,
  screenshotUrl,
  imgRef,
  focused,
  onClick,
  onBlur,
}: {
  status: BrowserStatus | null;
  screenshotUrl: string | null;
  imgRef: React.MutableRefObject<HTMLImageElement | null>;
  focused: boolean;
  onClick: (e: React.MouseEvent<HTMLImageElement>) => void;
  onBlur: () => void;
}) {
  if (!status?.ready || !screenshotUrl) {
    return <Empty label="ready · type a URL above to load a page" />;
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
        position: "relative",
        outline: focused ? "2px solid var(--accent-1)" : "2px solid transparent",
        outlineOffset: -2,
      }}
      onClick={() => onBlur()}
    >
      <img
        ref={imgRef}
        src={screenshotUrl}
        alt={status.title ?? "browser preview"}
        draggable={false}
        onClick={(e) => {
          e.stopPropagation();
          void onClick(e);
        }}
        style={{
          maxWidth: "100%",
          maxHeight: "100%",
          objectFit: "contain",
          cursor: "crosshair",
          WebkitUserDrag: "none",
        } as React.CSSProperties}
      />
    </div>
  );
}

function ConsoleTail({ logs }: { logs: BrowserLogEntry[] }) {
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

function LogRow({ entry }: { entry: BrowserLogEntry }) {
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
          browser daemon failed to start
        </div>
        <div
          style={{
            fontSize: "var(--text-sm)",
            color: "var(--text-secondary)",
            lineHeight: "var(--leading-sm)",
          }}
        >
          The in-house daemon couldn't bind a local port. Check the app
          log for details — usually means another process is using
          ports 4000–4099.
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
