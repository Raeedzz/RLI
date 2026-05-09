import { useEffect, useMemo, useRef, type ComponentType } from "react";
import { createPortal } from "react-dom";
import { motion, AnimatePresence } from "motion/react";

export interface ContextMenuItem {
  /** Stable id, used as React key. */
  id: string;
  label: string;
  /** HugeIcon-style component. Rendered at 16px. */
  Glyph: ComponentType<{ size?: number }>;
  /** Optional shortcut hint shown right-aligned in monospace. */
  shortcut?: string;
  /** When true, item is rendered with destructive (red) styling and sits
   *  below a divider. */
  destructive?: boolean;
  /** Disable the item without hiding it. */
  disabled?: boolean;
  onSelect: () => void;
}

interface Props {
  open: boolean;
  /** Viewport coords of the right-click that opened the menu. */
  anchor: { x: number; y: number } | null;
  items: ContextMenuItem[];
  onClose: () => void;
}

const W = 260;
const ITEM_HEIGHT = 40;

/**
 * Right-click context menu. Items render top-down with their HugeIcon
 * glyph + label + optional shortcut chip; destructive items sit below
 * a hairline divider in error-bright text. Mounts as a portaled
 * fixed-position panel anchored at the click coords, edge-flipping to
 * stay inside the viewport.
 *
 *   ┌─────────────────────────────────┐
 *   │ +  New workspace          ⌘N    │
 *   │ ⛓  Create from…           ⌘⇧N   │
 *   │ ⚙  Repository settings    ⌘,    │
 *   │ 🖼  Change icon                  │
 *   │ ⊘  Hide repository              │
 *   ├─────────────────────────────────┤
 *   │ 🗑  Remove repository            │
 *   └─────────────────────────────────┘
 */
export function ContextMenu({ open, anchor, items, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    const onMouseDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    window.addEventListener("keydown", onKey);
    // Defer so the contextmenu's mousedown that opened us doesn't
    // immediately close us.
    const t = window.setTimeout(
      () => window.addEventListener("mousedown", onMouseDown),
      0,
    );
    return () => {
      window.removeEventListener("keydown", onKey);
      window.clearTimeout(t);
      window.removeEventListener("mousedown", onMouseDown);
    };
  }, [open, onClose]);

  // Edge-flip: keep within viewport with 8px gutter.
  const { left, top } = useMemo(() => {
    if (!anchor) return { left: 0, top: 0 };
    const h = items.length * ITEM_HEIGHT + 16;
    return {
      left: Math.max(8, Math.min(anchor.x, window.innerWidth - W - 8)),
      top: Math.max(8, Math.min(anchor.y, window.innerHeight - h - 8)),
    };
  }, [anchor, items.length]);

  if (!open || !anchor) return null;

  // Group: regular items, then destructive ones (with a divider).
  const regular = items.filter((i) => !i.destructive);
  const destructive = items.filter((i) => i.destructive);

  return createPortal(
    <AnimatePresence>
      {open && (
        <motion.div
          ref={ref}
          role="menu"
          initial={{ opacity: 0, scale: 0.96, y: -4 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.97, y: -2 }}
          transition={{ duration: 0.16, ease: [0.22, 1, 0.36, 1] }}
          data-tauri-drag-region={false}
          style={{
            position: "fixed",
            left,
            top,
            width: W,
            backgroundColor: "var(--surface-2)",
            border: "var(--border-1)",
            borderRadius: "var(--radius-md)",
            boxShadow:
              "0 24px 60px -16px rgba(0,0,0,0.65), 0 4px 10px rgba(0,0,0,0.4)",
            padding: 4,
            zIndex: 10_001,
            userSelect: "none",
          }}
        >
          {regular.map((item) => (
            <ContextMenuRow
              key={item.id}
              item={item}
              onPick={() => {
                if (item.disabled) return;
                onClose();
                item.onSelect();
              }}
            />
          ))}
          {destructive.length > 0 && (
            <div
              role="separator"
              style={{
                height: 1,
                margin: "4px 6px",
                backgroundColor: "var(--border-default)",
              }}
            />
          )}
          {destructive.map((item) => (
            <ContextMenuRow
              key={item.id}
              item={item}
              onPick={() => {
                if (item.disabled) return;
                onClose();
                item.onSelect();
              }}
            />
          ))}
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  );
}

function ContextMenuRow({
  item,
  onPick,
}: {
  item: ContextMenuItem;
  onPick: () => void;
}) {
  const Glyph = item.Glyph;
  const baseColor = item.destructive
    ? "var(--state-error-bright)"
    : item.disabled
      ? "var(--text-disabled)"
      : "var(--text-primary)";
  const iconColor = item.destructive
    ? "var(--state-error-bright)"
    : item.disabled
      ? "var(--text-disabled)"
      : "var(--text-secondary)";
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onPick}
      disabled={item.disabled}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 12,
        width: "100%",
        height: ITEM_HEIGHT - 2,
        padding: "0 10px",
        backgroundColor: "transparent",
        color: baseColor,
        borderRadius: "var(--radius-sm)",
        textAlign: "left",
        cursor: item.disabled ? "default" : "pointer",
        transition:
          "background-color var(--motion-instant) var(--ease-out-quart)",
      }}
      onMouseEnter={(e) => {
        if (item.disabled) return;
        e.currentTarget.style.backgroundColor = item.destructive
          ? "color-mix(in oklch, var(--surface-2), var(--state-error) 16%)"
          : "var(--surface-3)";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.backgroundColor = "transparent";
      }}
    >
      <span
        aria-hidden
        style={{
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          width: 22,
          height: 22,
          color: iconColor,
          flexShrink: 0,
        }}
      >
        <Glyph size={16} />
      </span>
      <span
        style={{
          flex: 1,
          fontSize: "var(--text-sm)",
          fontWeight: "var(--weight-medium)",
          letterSpacing: "var(--tracking-tight)",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {item.label}
      </span>
      {item.shortcut && (
        <span
          className="tabular"
          style={{
            fontSize: "var(--text-2xs)",
            fontFamily: "var(--font-mono)",
            color: "var(--text-disabled)",
            flexShrink: 0,
            paddingLeft: 8,
          }}
        >
          {item.shortcut}
        </span>
      )}
    </button>
  );
}
