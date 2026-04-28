import { motion } from "motion/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { dropdownVariants } from "@/design/motion";
import { git, type BranchEntry } from "@/lib/git";

interface Props {
  cwd: string;
  /** Viewport coordinates of the click that opened the popover. */
  anchor: { x: number; y: number };
  onClose: () => void;
  /** Fires after a successful checkout / branch creation. */
  onSwitched?: (branch: string) => void;
}

const W = 280;
const MAX_H = 360;
const ROW_H = 28;

/**
 * Branch picker + inline create. Lists local branches sorted by recency
 * (Rust: `for-each-ref --sort=-committerdate`); the current branch is
 * marked with a thin accent dot. Type to filter; Enter on a filter that
 * matches no existing branch becomes "create branch <typed>".
 *
 * Esc / click-outside / row-click all dismiss.
 */
export function BranchSwitcher({ cwd, anchor, onClose, onSwitched }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [branches, setBranches] = useState<BranchEntry[] | null>(null);
  const [filter, setFilter] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Pull branches once on mount. Cheap; git for-each-ref is fast.
  useEffect(() => {
    let cancelled = false;
    git
      .branchList(cwd)
      .then((list) => {
        if (!cancelled) setBranches(list);
      })
      .catch((e) => {
        if (!cancelled) setError(String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [cwd]);

  // Click-outside + Esc to dismiss.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    const onClickOutside = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    window.addEventListener("keydown", onKey);
    const t = window.setTimeout(
      () => window.addEventListener("mousedown", onClickOutside),
      0,
    );
    return () => {
      window.removeEventListener("keydown", onKey);
      window.clearTimeout(t);
      window.removeEventListener("mousedown", onClickOutside);
    };
  }, [onClose]);

  // Focus the filter input on open.
  useEffect(() => {
    requestAnimationFrame(() => inputRef.current?.focus());
  }, []);

  const filtered = useMemo(() => {
    if (!branches) return [];
    const q = filter.trim().toLowerCase();
    if (!q) return branches;
    return branches.filter((b) => b.name.toLowerCase().includes(q));
  }, [branches, filter]);

  const exactMatch = useMemo(() => {
    const q = filter.trim();
    if (!q || !branches) return null;
    return branches.find((b) => b.name === q) ?? null;
  }, [branches, filter]);

  const canCreate = filter.trim().length > 0 && !exactMatch;

  const onCheckout = async (name: string) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await git.checkout(cwd, name);
      onSwitched?.(name);
      onClose();
    } catch (e) {
      setError(String(e));
      setBusy(false);
    }
  };

  const onCreate = async () => {
    if (busy || !canCreate) return;
    setBusy(true);
    setError(null);
    try {
      const name = filter.trim();
      await git.branchCreate(cwd, name);
      onSwitched?.(name);
      onClose();
    } catch (e) {
      setError(String(e));
      setBusy(false);
    }
  };

  // Edge-flip — keep popover within the viewport.
  const estH = Math.min(MAX_H, 64 + (filtered.length + (canCreate ? 1 : 0)) * ROW_H);
  const left = Math.max(8, Math.min(anchor.x, window.innerWidth - W - 8));
  const top = Math.max(8, Math.min(anchor.y, window.innerHeight - estH - 8));

  return (
    <motion.div
      ref={ref}
      role="dialog"
      aria-label="Switch branch"
      variants={dropdownVariants}
      initial="hidden"
      animate="visible"
      exit="exit"
      style={{
        position: "fixed",
        left,
        top,
        width: W,
        maxHeight: MAX_H,
        backgroundColor: "var(--surface-3)",
        border: "var(--border-2)",
        borderRadius: "var(--radius-md)",
        boxShadow: "var(--shadow-popover)",
        zIndex: "var(--z-dropdown)",
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
      }}
    >
      <div
        style={{
          padding: "var(--space-2)",
          borderBottom: "var(--border-1)",
        }}
      >
        <input
          ref={inputRef}
          type="text"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              if (exactMatch) void onCheckout(exactMatch.name);
              else if (canCreate) void onCreate();
              else if (filtered[0]) void onCheckout(filtered[0].name);
            }
          }}
          placeholder="filter or new branch name…"
          spellCheck={false}
          disabled={busy}
          style={{
            width: "100%",
            height: 24,
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
      </div>

      <div style={{ flex: 1, minHeight: 0, overflowY: "auto" }}>
        {!branches && <Empty label="loading branches…" />}
        {branches && filtered.length === 0 && !canCreate && (
          <Empty label="no matches" />
        )}
        {filtered.map((b) => (
          <Row
            key={b.name}
            name={b.name}
            current={b.current}
            disabled={busy}
            onClick={() => void onCheckout(b.name)}
          />
        ))}
        {canCreate && (
          <Row
            name={`create "${filter.trim()}" from current`}
            mono={false}
            current={false}
            disabled={busy}
            onClick={() => void onCreate()}
            tone="accent"
          />
        )}
      </div>

      {error && (
        <div
          style={{
            padding: "var(--space-1) var(--space-3)",
            borderTop: "var(--border-1)",
            backgroundColor: "var(--state-error-bg)",
            color: "var(--state-error-bright)",
            fontFamily: "var(--font-mono)",
            fontSize: "var(--text-2xs)",
            wordBreak: "break-all",
          }}
        >
          {error}
        </div>
      )}
    </motion.div>
  );
}

function Row({
  name,
  current,
  disabled,
  onClick,
  mono = true,
  tone,
}: {
  name: string;
  current: boolean;
  disabled?: boolean;
  onClick: () => void;
  mono?: boolean;
  tone?: "accent";
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      style={{
        width: "100%",
        height: ROW_H,
        display: "flex",
        alignItems: "center",
        gap: "var(--space-2)",
        padding: "0 var(--space-3)",
        backgroundColor: "transparent",
        border: "none",
        borderTop: "none",
        textAlign: "left",
        cursor: disabled ? "default" : "pointer",
        color: tone === "accent" ? "var(--accent-bright)" : "var(--text-primary)",
        fontFamily: mono ? "var(--font-mono)" : "var(--font-sans)",
        fontSize: "var(--text-2xs)",
        opacity: disabled ? 0.5 : 1,
      }}
      onMouseEnter={(e) =>
        (e.currentTarget.style.backgroundColor = "var(--surface-2)")
      }
      onMouseLeave={(e) =>
        (e.currentTarget.style.backgroundColor = "transparent")
      }
    >
      <span
        aria-hidden
        style={{
          width: 6,
          height: 6,
          borderRadius: "var(--radius-pill)",
          backgroundColor: current
            ? "var(--state-success)"
            : "var(--text-disabled)",
          flexShrink: 0,
          opacity: current ? 1 : 0.4,
        }}
      />
      <span
        style={{
          flex: 1,
          minWidth: 0,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {name}
      </span>
      {current && (
        <span
          style={{
            color: "var(--text-tertiary)",
            fontSize: "var(--text-2xs)",
            letterSpacing: "var(--tracking-caps)",
            textTransform: "uppercase",
            fontFamily: "var(--font-sans)",
          }}
        >
          current
        </span>
      )}
    </button>
  );
}

function Empty({ label }: { label: string }) {
  return (
    <div
      style={{
        padding: "var(--space-4)",
        textAlign: "center",
        color: "var(--text-tertiary)",
        fontSize: "var(--text-2xs)",
        fontFamily: "var(--font-sans)",
      }}
    >
      {label}
    </div>
  );
}
