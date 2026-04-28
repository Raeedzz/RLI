import { motion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { dropdownVariants } from "@/design/motion";
import type { PaneContent, SplitDirection } from "@/state/types";

interface Props {
  mode: "split" | "replace";
  anchor: { x: number; y: number };
  currentContent: PaneContent;
  workspaceLeafCount: number;
  onSplit: (direction: SplitDirection, content: PaneContent) => void;
  onReplace: (content: PaneContent) => void;
  onClose: () => void;
}

const WIDTH = 256;

const CONTENT_OPTIONS: { id: PaneContent; label: string; hint: string }[] = [
  { id: "terminal", label: "Terminal", hint: "shell or claude" },
  { id: "editor", label: "Code editor", hint: "open file" },
  { id: "browser", label: "Browser", hint: "GStack preview" },
  { id: "graph", label: "Memory graph", hint: "embedding map" },
];

const DIRECTION_OPTIONS: {
  id: SplitDirection;
  label: string;
  glyph: string;
}[] = [
  { id: "left", label: "Left", glyph: "←" },
  { id: "up", label: "Up", glyph: "↑" },
  { id: "down", label: "Down", glyph: "↓" },
  { id: "right", label: "Right", glyph: "→" },
];

/**
 * Two-step popover used both for splitting an existing pane and for
 * swapping the content of an existing pane in place.
 *
 * Split mode: user picks direction, then content. The popover dismisses
 * on the second click. Replace mode skips the direction step — only
 * content is asked for.
 */
export function SplitChooser({
  mode,
  anchor,
  currentContent,
  onSplit,
  onReplace,
  onClose,
}: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [direction, setDirection] = useState<SplitDirection>("right");

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    window.addEventListener("keydown", onKey);
    const t = window.setTimeout(
      () => window.addEventListener("mousedown", onClick),
      0,
    );
    return () => {
      window.removeEventListener("keydown", onKey);
      window.clearTimeout(t);
      window.removeEventListener("mousedown", onClick);
    };
  }, [onClose]);

  const top = Math.min(anchor.y, window.innerHeight - 360);
  const left = Math.min(anchor.x - WIDTH, window.innerWidth - WIDTH - 8);

  const handleContentClick = (content: PaneContent) => {
    if (mode === "replace") {
      onReplace(content);
    } else {
      onSplit(direction, content);
    }
  };

  return (
    <motion.div
      ref={ref}
      role="dialog"
      variants={dropdownVariants}
      initial="hidden"
      animate="visible"
      exit="exit"
      style={{
        position: "fixed",
        top: Math.max(8, top),
        left: Math.max(8, left),
        width: WIDTH,
        backgroundColor: "var(--surface-3)",
        border: "var(--border-2)",
        borderRadius: "var(--radius-md)",
        boxShadow: "var(--shadow-popover)",
        padding: "var(--space-2)",
        zIndex: "var(--z-tooltip)",
        display: "grid",
        gap: "var(--space-3)",
      }}
    >
      {mode === "split" && (
        <section>
          <Label>Split direction</Label>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(4, 1fr)",
              gap: "var(--space-1)",
            }}
          >
            {DIRECTION_OPTIONS.map((d) => (
              <DirectionButton
                key={d.id}
                glyph={d.glyph}
                label={d.label}
                active={direction === d.id}
                onClick={() => setDirection(d.id)}
              />
            ))}
          </div>
        </section>
      )}

      <section>
        <Label>{mode === "split" ? "New pane" : "Change to"}</Label>
        <div style={{ display: "grid", gap: 2 }}>
          {CONTENT_OPTIONS.map((c) => (
            <ContentButton
              key={c.id}
              label={c.label}
              hint={c.hint}
              active={mode === "replace" && c.id === currentContent}
              disabled={mode === "replace" && c.id === currentContent}
              onClick={() => handleContentClick(c.id)}
            />
          ))}
        </div>
      </section>
    </motion.div>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        fontSize: "var(--text-2xs)",
        textTransform: "uppercase",
        letterSpacing: "var(--tracking-caps)",
        fontWeight: "var(--weight-semibold)",
        color: "var(--text-tertiary)",
        marginBottom: "var(--space-1-5)",
      }}
    >
      {children}
    </div>
  );
}

function DirectionButton({
  glyph,
  label,
  active,
  onClick,
}: {
  glyph: string;
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={`Split ${label}`}
      aria-pressed={active}
      style={{
        height: 36,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        borderRadius: "var(--radius-sm)",
        backgroundColor: active
          ? "var(--surface-accent-tinted)"
          : "var(--surface-2)",
        color: active ? "var(--accent-bright)" : "var(--text-secondary)",
        fontSize: "var(--text-md)",
        fontFamily: "var(--font-mono)",
        cursor: "default",
        transition:
          "background-color var(--motion-instant) var(--ease-out-quart), color var(--motion-instant) var(--ease-out-quart)",
      }}
      onMouseEnter={(e) => {
        if (!active) {
          e.currentTarget.style.backgroundColor = "var(--surface-accent-soft)";
          e.currentTarget.style.color = "var(--text-primary)";
        }
      }}
      onMouseLeave={(e) => {
        if (!active) {
          e.currentTarget.style.backgroundColor = "var(--surface-2)";
          e.currentTarget.style.color = "var(--text-secondary)";
        }
      }}
    >
      {glyph}
    </button>
  );
}

function ContentButton({
  label,
  hint,
  active,
  disabled,
  onClick,
}: {
  label: string;
  hint: string;
  active: boolean;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      style={{
        display: "flex",
        alignItems: "center",
        gap: "var(--space-3)",
        height: 32,
        padding: "0 var(--space-3)",
        borderRadius: "var(--radius-sm)",
        backgroundColor: active ? "var(--surface-accent-tinted)" : "transparent",
        color: disabled
          ? "var(--text-disabled)"
          : active
            ? "var(--accent-bright)"
            : "var(--text-primary)",
        cursor: disabled ? "default" : "default",
        opacity: disabled ? 0.5 : 1,
        textAlign: "left",
      }}
      onMouseEnter={(e) => {
        if (!disabled && !active) {
          e.currentTarget.style.backgroundColor = "var(--surface-4)";
        }
      }}
      onMouseLeave={(e) => {
        if (!disabled && !active) {
          e.currentTarget.style.backgroundColor = "transparent";
        }
      }}
    >
      <span style={{ flex: 1, fontSize: "var(--text-sm)" }}>{label}</span>
      <span
        style={{
          fontSize: "var(--text-2xs)",
          color: "var(--text-tertiary)",
        }}
      >
        {active ? "current" : hint}
      </span>
    </button>
  );
}
