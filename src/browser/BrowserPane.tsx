import { motion } from "motion/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { connectionsViewVariants } from "@/design/motion";
import {
  browser,
  invalidateBrowserBaseCache,
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

// Console-pane resize bounds. 80px keeps the header row + a single
// log line visible (the minimum useful state); 600px is a generous
// upper bound that still leaves room for the screenshot frame above
// even on small windows.
const CONSOLE_MIN_HEIGHT = 80;
const CONSOLE_MAX_HEIGHT = 600;
const CONSOLE_DEFAULT_HEIGHT = 220;
const CONSOLE_HEIGHT_STORAGE_KEY = "rli.browser.consoleHeight";

function loadConsoleHeight(): number {
  if (typeof window === "undefined") return CONSOLE_DEFAULT_HEIGHT;
  try {
    const raw = window.localStorage.getItem(CONSOLE_HEIGHT_STORAGE_KEY);
    if (!raw) return CONSOLE_DEFAULT_HEIGHT;
    const n = parseInt(raw, 10);
    if (!Number.isFinite(n)) return CONSOLE_DEFAULT_HEIGHT;
    return clampConsoleHeight(n);
  } catch {
    return CONSOLE_DEFAULT_HEIGHT;
  }
}

function clampConsoleHeight(h: number): number {
  return Math.min(CONSOLE_MAX_HEIGHT, Math.max(CONSOLE_MIN_HEIGHT, h));
}

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
  // User-resizable console pane height. Persisted to localStorage so
  // a deliberately-tall console survives reloads and tab-switches.
  const [consoleHeight, setConsoleHeight] = useState<number>(loadConsoleHeight);

  const imgRef = useRef<HTMLImageElement | null>(null);
  const focusTrap = useRef<HTMLTextAreaElement | null>(null);

  // Health check on mount, retry every 2s until daemon is up. We
  // require multiple *consecutive* failures before flipping into the
  // "daemon offline" UI: a single transient `AbortError` (the 3s
  // fetch timeout firing during a layout reflow, a brief webview
  // pause when the bottom panel collapses, etc.) shouldn't make the
  // pane scream that the daemon is dead. We hold the previous
  // `health` value steady during transient failures so the UI stays
  // calm — only after `FAILURE_THRESHOLD` failures in a row do we
  // surface the DaemonOffline state.
  const FAILURE_THRESHOLD = 5;
  const failuresRef = useRef(0);
  const checkRef = useRef<() => void>(() => {});
  useEffect(() => {
    let cancelled = false;
    const check = () => {
      void browser.health().then((h) => {
        if (cancelled) return;
        if (h.ok) {
          failuresRef.current = 0;
          setHealth(h);
        } else {
          failuresRef.current += 1;
          if (failuresRef.current >= FAILURE_THRESHOLD) {
            setHealth(h);
          }
          // Otherwise leave `health` as it was. On first mount that
          // means it stays `null` (showing "starting browser daemon…")
          // and on a previously-ok daemon it stays `{ ok: true }` so
          // the pane keeps rendering while we ride out the blip.
        }
      });
    };
    checkRef.current = check;
    check();
    const t = window.setInterval(check, 2000);
    return () => {
      cancelled = true;
      window.clearInterval(t);
    };
    // Setup-once; the interval handles ongoing rechecks. Re-running
    // this effect on every health flip would tear down and rebuild
    // the timer pointlessly.
  }, []);
  // Manual retry — bypasses the URL cache, resets the failure
  // counter, and triggers an immediate re-check so the user can
  // recover from the offline UI without waiting for the next
  // interval tick.
  const retryHealth = useCallback(() => {
    invalidateBrowserBaseCache();
    failuresRef.current = 0;
    setHealth(null);
    checkRef.current();
  }, []);

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
      {health && !health.ok && (
        <DaemonOffline error={health.error} onRetry={retryHealth} />
      )}
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
          <ConsoleResizeHandle
            height={consoleHeight}
            onChange={(h) => {
              const clamped = clampConsoleHeight(h);
              setConsoleHeight(clamped);
              try {
                window.localStorage.setItem(
                  CONSOLE_HEIGHT_STORAGE_KEY,
                  String(clamped),
                );
              } catch {
                /* localStorage can fail under storage pressure; not fatal. */
              }
            }}
          />
          <ConsoleTail logs={logs} height={consoleHeight} />
        </>
      )}
    </motion.aside>
  );
}

/**
 * Thin draggable strip pinned just above the console. Drag up to grow
 * the console (shrinks the screenshot frame), drag down to shrink it.
 * The hit zone is 6px tall but the visible center line is 1px so the
 * chrome stays calm; we tint the line on hover/drag to indicate the
 * affordance is alive.
 */
function ConsoleResizeHandle({
  height,
  onChange,
}: {
  height: number;
  onChange: (next: number) => void;
}) {
  const startYRef = useRef(0);
  const startHRef = useRef(0);
  const draggingRef = useRef(false);
  const [hover, setHover] = useState(false);
  const [active, setActive] = useState(false);

  const onMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      draggingRef.current = true;
      startYRef.current = e.clientY;
      startHRef.current = height;
      setActive(true);
      document.body.style.cursor = "row-resize";
      document.body.style.userSelect = "none";
    },
    [height],
  );

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!draggingRef.current) return;
      // Drag UP (negative dy) → console grows. The console sits at
      // the bottom of the pane, so its height increases as the
      // pointer moves up. Caller clamps to the min/max bounds.
      const dy = e.clientY - startYRef.current;
      onChange(startHRef.current - dy);
    };
    const onUp = () => {
      if (!draggingRef.current) return;
      draggingRef.current = false;
      setActive(false);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [onChange]);

  const lit = hover || active;
  return (
    <div
      role="separator"
      aria-orientation="horizontal"
      aria-label="Resize console"
      onMouseDown={onMouseDown}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        flexShrink: 0,
        // 6px hit zone, with a 1px hairline centered inside it.
        height: 6,
        marginTop: -3,
        marginBottom: -3,
        position: "relative",
        cursor: "row-resize",
        zIndex: 5,
      }}
    >
      <div
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          top: 2,
          height: 1,
          backgroundColor: lit ? "var(--accent)" : "transparent",
          transition:
            "background-color var(--motion-fast) var(--ease-out-quart)",
        }}
      />
    </div>
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

type LogLevel = BrowserLogEntry["level"];
type LogFilter = "all" | "errors" | "warnings";

// Per-level visual presentation. `tag` is what reads in the row's
// pill column (4 chars wide so the column aligns regardless of which
// level a line is); `tone` colors the pill and tint rail; `bg` is
// the row's faint background tint.
const LEVEL_PRESENTATION: Record<
  LogLevel,
  { tag: string; tone: string; bg: string }
> = {
  error: {
    tag: "ERR",
    tone: "var(--state-error-bright)",
    bg: "var(--surface-error-soft)",
  },
  warn: {
    tag: "WARN",
    tone: "var(--state-warning-bright)",
    bg: "var(--surface-warning-soft)",
  },
  info: {
    tag: "INFO",
    tone: "var(--state-info)",
    bg: "transparent",
  },
  log: {
    tag: "LOG",
    tone: "var(--text-secondary)",
    bg: "transparent",
  },
  debug: {
    tag: "DBG",
    tone: "var(--text-tertiary)",
    bg: "transparent",
  },
};

function ConsoleTail({
  logs,
  height,
}: {
  logs: BrowserLogEntry[];
  height: number;
}) {
  const [filter, setFilter] = useState<LogFilter>("all");
  const scrollRef = useRef<HTMLDivElement | null>(null);
  // Stick-to-bottom: only auto-scroll when the user is already near
  // the bottom. If they've scrolled up to read something, leave them
  // there — otherwise rapid log activity would yank the viewport
  // around mid-read.
  const stickRef = useRef(true);

  const counts = useMemo(() => {
    let err = 0;
    let warn = 0;
    for (const e of logs) {
      if (e.level === "error") err++;
      else if (e.level === "warn") warn++;
    }
    return { err, warn, total: logs.length };
  }, [logs]);

  const filtered = useMemo(() => {
    if (filter === "all") return logs;
    if (filter === "errors") return logs.filter((e) => e.level === "error");
    return logs.filter((e) => e.level === "warn" || e.level === "error");
  }, [logs, filter]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !stickRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [filtered]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const slop = 12;
    stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < slop;
  };

  return (
    <div
      style={{
        height,
        flexShrink: 0,
        backgroundColor: "var(--surface-1)",
        borderTop: "var(--border-1)",
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
      }}
    >
      <ConsoleHeader
        counts={counts}
        filter={filter}
        onFilter={setFilter}
      />
      <div
        ref={scrollRef}
        onScroll={onScroll}
        style={{
          flex: 1,
          minHeight: 0,
          overflowY: "auto",
          fontFamily: "var(--font-mono)",
          fontSize: "var(--text-xs)",
          lineHeight: 1.5,
        }}
      >
        {filtered.length === 0 ? (
          <Empty
            label={
              logs.length === 0
                ? "No console output yet — interact with the page above."
                : `No ${filter === "errors" ? "errors" : "errors or warnings"} in the last ${logs.length} entries.`
            }
            small
          />
        ) : (
          filtered.map((entry, i) => (
            <LogRow key={`${entry.ts}-${i}`} entry={entry} />
          ))
        )}
      </div>
    </div>
  );
}

function ConsoleHeader({
  counts,
  filter,
  onFilter,
}: {
  counts: { err: number; warn: number; total: number };
  filter: LogFilter;
  onFilter: (f: LogFilter) => void;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: "var(--space-2)",
        height: 26,
        flexShrink: 0,
        padding: "0 var(--space-2) 0 var(--space-3)",
        borderBottom: "var(--border-1)",
        backgroundColor: "var(--surface-1)",
      }}
    >
      <span
        style={{
          fontFamily: "var(--font-sans)",
          fontSize: "var(--text-2xs)",
          fontWeight: "var(--weight-semibold)",
          letterSpacing: "var(--tracking-caps)",
          textTransform: "uppercase",
          color: "var(--text-tertiary)",
        }}
      >
        Console
      </span>
      <span
        className="tabular"
        style={{
          fontFamily: "var(--font-mono)",
          fontSize: "var(--text-2xs)",
          color: "var(--text-tertiary)",
        }}
      >
        {counts.total}
      </span>

      <span style={{ flex: 1 }} />

      <LevelCount
        tone="var(--state-error-bright)"
        count={counts.err}
        title={`${counts.err} error${counts.err === 1 ? "" : "s"}`}
      />
      <LevelCount
        tone="var(--state-warning-bright)"
        count={counts.warn}
        title={`${counts.warn} warning${counts.warn === 1 ? "" : "s"}`}
      />

      <span
        aria-hidden
        style={{
          width: 1,
          height: 14,
          backgroundColor: "var(--border-default)",
          margin: "0 var(--space-1)",
        }}
      />

      <FilterPill
        active={filter === "all"}
        onClick={() => onFilter("all")}
        label="All"
      />
      <FilterPill
        active={filter === "errors"}
        onClick={() => onFilter("errors")}
        label="Errors"
      />
      <FilterPill
        active={filter === "warnings"}
        onClick={() => onFilter("warnings")}
        label="Warn+"
      />
    </div>
  );
}

function LevelCount({
  tone,
  count,
  title,
}: {
  tone: string;
  count: number;
  title: string;
}) {
  const dim = count === 0;
  return (
    <span
      title={title}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 5,
        opacity: dim ? 0.4 : 1,
      }}
    >
      <span
        aria-hidden
        style={{
          width: 7,
          height: 7,
          borderRadius: "var(--radius-pill)",
          backgroundColor: tone,
          flexShrink: 0,
        }}
      />
      <span
        className="tabular"
        style={{
          fontFamily: "var(--font-mono)",
          fontSize: "var(--text-2xs)",
          color: dim ? "var(--text-tertiary)" : "var(--text-secondary)",
          minWidth: 12,
          textAlign: "right",
        }}
      >
        {count}
      </span>
    </span>
  );
}

function FilterPill({
  active,
  onClick,
  label,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        height: 18,
        padding: "0 8px",
        fontFamily: "var(--font-sans)",
        fontSize: "var(--text-2xs)",
        fontWeight: "var(--weight-medium)",
        color: active ? "var(--text-primary)" : "var(--text-tertiary)",
        backgroundColor: active ? "var(--surface-3)" : "transparent",
        border: "none",
        borderRadius: "var(--radius-sm)",
        cursor: "pointer",
        transition:
          "background-color var(--motion-instant) var(--ease-out-quart)," +
          "color var(--motion-instant) var(--ease-out-quart)",
      }}
      onMouseEnter={(e) => {
        if (!active) {
          e.currentTarget.style.color = "var(--text-secondary)";
          e.currentTarget.style.backgroundColor = "var(--surface-2)";
        }
      }}
      onMouseLeave={(e) => {
        if (!active) {
          e.currentTarget.style.color = "var(--text-tertiary)";
          e.currentTarget.style.backgroundColor = "transparent";
        }
      }}
    >
      {label}
    </button>
  );
}

function LogRow({ entry }: { entry: BrowserLogEntry }) {
  const pres = LEVEL_PRESENTATION[entry.level] ?? LEVEL_PRESENTATION.log;
  const time = formatLogTime(entry.ts);
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "3px 38px 56px 1fr",
        gap: "var(--space-2)",
        padding: "4px var(--space-3) 4px 0",
        backgroundColor: pres.bg,
        borderTop: "1px solid color-mix(in oklch, var(--surface-1), transparent 90%)",
      }}
    >
      {/* Tint rail — colors the row's left edge with the level tone.
          Reads as gradient ribbon when stacked, error rows visually
          cluster together. */}
      <span
        aria-hidden
        style={{
          backgroundColor:
            entry.level === "error" || entry.level === "warn"
              ? pres.tone
              : "transparent",
        }}
      />
      {/* Level pill — fixed 38px column keeps the timestamp + text
          aligned across every row regardless of which level fired. */}
      <span
        style={{
          fontFamily: "var(--font-mono)",
          fontSize: 10,
          fontWeight: "var(--weight-semibold)",
          letterSpacing: "var(--tracking-caps)",
          color: pres.tone,
          alignSelf: "start",
          paddingTop: 1,
        }}
      >
        {pres.tag}
      </span>
      <span
        className="tabular"
        style={{
          fontFamily: "var(--font-mono)",
          fontSize: 10,
          color: "var(--text-tertiary)",
          alignSelf: "start",
          paddingTop: 1,
        }}
      >
        {time}
      </span>
      <span
        style={{
          fontFamily: "var(--font-mono)",
          fontSize: "var(--text-xs)",
          color:
            entry.level === "error"
              ? "var(--text-primary)"
              : entry.level === "warn"
                ? "var(--text-primary)"
                : "var(--text-secondary)",
          fontVariantLigatures: "none",
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
          minWidth: 0,
        }}
      >
        {entry.text}
      </span>
    </div>
  );
}

function formatLogTime(ts: number): string {
  if (!ts || !Number.isFinite(ts)) return "--:--:--";
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
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

function DaemonOffline({
  error,
  onRetry,
}: {
  error?: string;
  onRetry: () => void;
}) {
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
          browser daemon unreachable
        </div>
        <div
          style={{
            fontSize: "var(--text-sm)",
            color: "var(--text-secondary)",
            lineHeight: "var(--leading-sm)",
          }}
        >
          The daemon hasn't responded to a health check after multiple
          attempts. It may still be starting up, or another process
          may be holding its preferred port range.
        </div>
        <button
          type="button"
          onClick={onRetry}
          style={{
            justifySelf: "center",
            padding: "6px 14px",
            backgroundColor: "var(--surface-3)",
            color: "var(--text-primary)",
            border: "1px solid var(--border-default)",
            borderRadius: "var(--radius-sm)",
            fontFamily: "var(--font-sans)",
            fontSize: "var(--text-xs)",
            fontWeight: "var(--weight-medium)",
            cursor: "pointer",
          }}
        >
          Retry
        </button>
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
