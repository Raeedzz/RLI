import { useCallback, useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import type { Update } from "@tauri-apps/plugin-updater";
import { Download04Icon, Cancel01Icon } from "hugeicons-react";
import {
  checkForUpdate,
  downloadAndInstall,
  relaunchApp,
  type UpdaterPhase,
} from "@/lib/updater";

/**
 * Bottom-left "update available" toast.
 *
 * Lifecycle the user sees:
 *   1. App boot → silent `check`. If nothing, the toast stays hidden.
 *   2. New version found → slide in from below-left, "Install" button.
 *   3. Click Install → progress bar fills with downloaded bytes.
 *   4. Download done → "Restart now" button replaces the progress bar.
 *   5. Click Restart → app relaunches into the new binary.
 *
 * The X icon dismisses the toast for this session — the next launch
 * (or the periodic re-check below) will surface it again.
 *
 * Checks run on startup and every `RECHECK_INTERVAL_MS` after that,
 * so a long-running session still picks up new releases.
 */

const RECHECK_INTERVAL_MS = 4 * 60 * 60 * 1000; // 4 hours
const STARTUP_DELAY_MS = 5 * 1000; // wait 5s after mount so we don't race app boot
const TOAST_WIDTH = 320;

export function UpdaterToast() {
  const [phase, setPhase] = useState<UpdaterPhase>({ kind: "idle" });
  const [dismissed, setDismissed] = useState(false);
  const updateRef = useRef<Update | null>(null);

  const runCheck = useCallback(async () => {
    // Don't re-check while we're already in a non-idle flow — the
    // caller is mid-install or showing an error; trampling that with
    // a fresh "available" state would confuse the UI.
    if (phase.kind !== "idle") return;
    setPhase({ kind: "checking" });
    try {
      const update = await checkForUpdate();
      if (!update) {
        setPhase({ kind: "idle" });
        return;
      }
      updateRef.current = update;
      setPhase({
        kind: "available",
        version: update.version,
        notes: update.body ?? undefined,
      });
      setDismissed(false);
    } catch (err) {
      // Network blip / endpoint 404 / signature mismatch — keep the
      // session quiet and try again on the next tick.
      setPhase({ kind: "idle" });
      // eslint-disable-next-line no-console
      console.warn("[updater] check failed", err);
    }
  }, [phase.kind]);

  useEffect(() => {
    const t = window.setTimeout(() => void runCheck(), STARTUP_DELAY_MS);
    const i = window.setInterval(() => void runCheck(), RECHECK_INTERVAL_MS);
    return () => {
      window.clearTimeout(t);
      window.clearInterval(i);
    };
  }, [runCheck]);

  const onInstall = useCallback(async () => {
    const update = updateRef.current;
    if (!update) return;
    setPhase({
      kind: "downloading",
      version: update.version,
      downloaded: 0,
      total: null,
    });
    try {
      await downloadAndInstall(update, (downloaded, total) => {
        setPhase({
          kind: "downloading",
          version: update.version,
          downloaded,
          total,
        });
      });
      setPhase({ kind: "ready", version: update.version });
    } catch (err) {
      setPhase({
        kind: "error",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }, []);

  const onRestart = useCallback(async () => {
    setPhase({ kind: "applying" });
    try {
      await relaunchApp();
    } catch (err) {
      setPhase({
        kind: "error",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }, []);

  const visible =
    !dismissed &&
    (phase.kind === "available" ||
      phase.kind === "downloading" ||
      phase.kind === "ready" ||
      phase.kind === "applying" ||
      phase.kind === "error");

  return (
    <AnimatePresence>
      {visible && (
        <motion.div
          key="updater-toast"
          initial={{ opacity: 0, x: -12, y: 8 }}
          animate={{ opacity: 1, x: 0, y: 0 }}
          exit={{ opacity: 0, x: -8, y: 4, transition: { duration: 0.16 } }}
          transition={{ duration: 0.26, ease: [0.16, 1, 0.3, 1] }}
          role="status"
          aria-live="polite"
          style={{
            position: "fixed",
            left: 16,
            bottom: 16,
            width: TOAST_WIDTH,
            zIndex: "var(--z-toast)" as unknown as number,
            backgroundColor: "var(--surface-2)",
            border: "1px solid var(--border-strong)",
            borderRadius: "var(--radius-md)",
            boxShadow:
              "0 10px 30px oklch(0% 0 0 / 0.45), 0 1px 2px oklch(0% 0 0 / 0.4)",
            padding: "12px 14px 12px 12px",
            fontFamily: "var(--font-sans)",
            color: "var(--text-primary)",
            display: "flex",
            flexDirection: "column",
            gap: 10,
          }}
        >
          <Header phase={phase} onDismiss={() => setDismissed(true)} />
          <Body phase={phase} onInstall={onInstall} onRestart={onRestart} />
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function Header({
  phase,
  onDismiss,
}: {
  phase: UpdaterPhase;
  onDismiss: () => void;
}) {
  const title = (() => {
    switch (phase.kind) {
      case "available":
        return "Update available";
      case "downloading":
        return "Downloading update";
      case "ready":
        return "Update ready";
      case "applying":
        return "Restarting…";
      case "error":
        return "Update failed";
      default:
        return "";
    }
  })();
  const version =
    phase.kind === "available" ||
    phase.kind === "downloading" ||
    phase.kind === "ready"
      ? phase.version
      : null;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <span
        aria-hidden
        style={{
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          width: 22,
          height: 22,
          borderRadius: "var(--radius-sm)",
          backgroundColor:
            phase.kind === "error"
              ? "var(--surface-error-soft)"
              : "color-mix(in oklch, var(--surface-3), var(--accent) 14%)",
          color:
            phase.kind === "error" ? "var(--state-error)" : "var(--accent)",
          flexShrink: 0,
        }}
      >
        <Download04Icon size={14} />
      </span>
      <div
        style={{
          flex: 1,
          minWidth: 0,
          display: "flex",
          flexDirection: "column",
          gap: 1,
        }}
      >
        <div
          style={{
            fontSize: "var(--text-sm)",
            fontWeight: "var(--weight-semibold)",
            letterSpacing: "var(--tracking-tight)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {title}
        </div>
        {version && (
          <div
            style={{
              fontSize: "var(--text-2xs)",
              color: "var(--text-tertiary)",
              fontFamily: "var(--font-mono)",
            }}
          >
            v{version}
          </div>
        )}
      </div>
      <button
        type="button"
        title="Dismiss"
        onClick={onDismiss}
        style={{
          width: 22,
          height: 22,
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          borderRadius: "var(--radius-sm)",
          backgroundColor: "transparent",
          color: "var(--text-tertiary)",
          border: "none",
          cursor: "pointer",
          transition:
            "background-color var(--motion-instant) var(--ease-out-quart)," +
            "color var(--motion-instant) var(--ease-out-quart)",
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.backgroundColor = "var(--surface-3)";
          e.currentTarget.style.color = "var(--text-primary)";
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.backgroundColor = "transparent";
          e.currentTarget.style.color = "var(--text-tertiary)";
        }}
      >
        <Cancel01Icon size={12} />
      </button>
    </div>
  );
}

function Body({
  phase,
  onInstall,
  onRestart,
}: {
  phase: UpdaterPhase;
  onInstall: () => void;
  onRestart: () => void;
}) {
  if (phase.kind === "available") {
    return (
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 10,
        }}
      >
        {phase.notes && (
          <p
            style={{
              margin: 0,
              fontSize: "var(--text-xs)",
              color: "var(--text-secondary)",
              lineHeight: 1.45,
              maxHeight: 60,
              overflow: "hidden",
              display: "-webkit-box",
              WebkitLineClamp: 3,
              WebkitBoxOrient: "vertical",
              textOverflow: "ellipsis",
            }}
          >
            {phase.notes}
          </p>
        )}
        <div style={{ display: "flex", justifyContent: "flex-end" }}>
          <PrimaryButton onClick={onInstall}>Install</PrimaryButton>
        </div>
      </div>
    );
  }
  if (phase.kind === "downloading") {
    const pct =
      phase.total && phase.total > 0
        ? Math.min(100, Math.round((phase.downloaded / phase.total) * 100))
        : null;
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <ProgressBar value={pct} />
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            fontSize: "var(--text-2xs)",
            fontFamily: "var(--font-mono)",
            color: "var(--text-tertiary)",
          }}
        >
          <span>{formatBytes(phase.downloaded)}</span>
          <span>
            {phase.total ? formatBytes(phase.total) : "…"}
            {pct != null ? `  ·  ${pct}%` : ""}
          </span>
        </div>
      </div>
    );
  }
  if (phase.kind === "ready") {
    return (
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 10,
        }}
      >
        <span
          style={{
            fontSize: "var(--text-xs)",
            color: "var(--text-secondary)",
          }}
        >
          Restart to apply.
        </span>
        <PrimaryButton onClick={onRestart}>Restart now</PrimaryButton>
      </div>
    );
  }
  if (phase.kind === "applying") {
    return (
      <div
        style={{
          fontSize: "var(--text-xs)",
          color: "var(--text-tertiary)",
        }}
      >
        Hold on…
      </div>
    );
  }
  if (phase.kind === "error") {
    return (
      <div
        style={{
          fontSize: "var(--text-xs)",
          color: "var(--text-secondary)",
          lineHeight: 1.45,
        }}
      >
        {phase.message}
      </div>
    );
  }
  return null;
}

function PrimaryButton({
  onClick,
  children,
}: {
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        height: 28,
        padding: "0 14px",
        borderRadius: "var(--radius-sm)",
        backgroundColor: "var(--accent)",
        color: "var(--text-inverse)",
        border: "none",
        fontFamily: "var(--font-sans)",
        fontSize: "var(--text-xs)",
        fontWeight: "var(--weight-semibold)",
        letterSpacing: "var(--tracking-tight)",
        cursor: "pointer",
        transition:
          "background-color var(--motion-instant) var(--ease-out-quart)",
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.backgroundColor = "var(--accent-hover)";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.backgroundColor = "var(--accent)";
      }}
    >
      {children}
    </button>
  );
}

function ProgressBar({ value }: { value: number | null }) {
  // Two modes: known total → fill from 0..100, unknown → indeterminate
  // shimmer (a tinted bar sliding back and forth).
  return (
    <div
      style={{
        position: "relative",
        height: 6,
        borderRadius: "var(--radius-pill)",
        backgroundColor: "var(--surface-3)",
        overflow: "hidden",
      }}
    >
      {value != null ? (
        <motion.div
          animate={{ width: `${value}%` }}
          transition={{ duration: 0.2, ease: [0.25, 1, 0.5, 1] }}
          style={{
            position: "absolute",
            inset: 0,
            backgroundColor: "var(--accent)",
            borderRadius: "inherit",
          }}
        />
      ) : (
        <motion.div
          initial={{ left: "-40%" }}
          animate={{ left: "100%" }}
          transition={{
            duration: 1.2,
            ease: "linear",
            repeat: Infinity,
          }}
          style={{
            position: "absolute",
            top: 0,
            bottom: 0,
            width: "40%",
            backgroundColor: "var(--accent)",
            borderRadius: "inherit",
          }}
        />
      )}
    </div>
  );
}

function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v < 10 && i > 0 ? 1 : 0)} ${units[i]}`;
}
