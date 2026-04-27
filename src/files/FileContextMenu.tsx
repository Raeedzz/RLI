import { motion } from "motion/react";
import { useEffect, useRef } from "react";
import { dropdownVariants } from "@/design/motion";
import { system } from "@/lib/fs";

interface Props {
  path: string;
  isDir: boolean;
  anchor: { x: number; y: number };
  onOpenInEditor: () => void;
  onClose: () => void;
}

interface MenuItemSpec {
  label: string;
  /** Optional right-aligned hint text — usually a target app or shortcut. */
  hint?: string;
  onSelect: () => void | Promise<void>;
  divider?: boolean;
  danger?: boolean;
}

const MENU_WIDTH = 224;

/**
 * Right-click menu for file tree rows. Lets the user open the path in
 * Finder, the system default app, VS Code, or the default browser. The
 * underlying shell-out happens via the `system_open` / `system_open_with`
 * Tauri commands; if a target app isn't installed the OS surfaces its
 * own error dialog and the menu just closes.
 */
export function FileContextMenu({
  path,
  isDir,
  anchor,
  onOpenInEditor,
  onClose,
}: Props) {
  const ref = useRef<HTMLDivElement>(null);

  // Esc / click-outside dismiss
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

  const close = (fn: () => void | Promise<void>) => async () => {
    onClose();
    try {
      await fn();
    } catch {
      // System dialogs (e.g. "VS Code is not installed") surface natively;
      // we don't need to alert again.
    }
  };

  const isLikelyHtml =
    /\.(html?|svg|pdf|png|jpe?g|gif|webp)$/i.test(path);

  const items: MenuItemSpec[] = [
    {
      label: isDir ? "Reveal in editor" : "Open in editor",
      hint: "↵",
      onSelect: onOpenInEditor,
    },
    {
      label: "Reveal in Finder",
      onSelect: () => system.open(path, true),
    },
    {
      label: "Open with default app",
      onSelect: () => system.open(path, false),
      divider: true,
    },
    {
      label: "Open in VS Code",
      onSelect: () => system.openWith(path, "Visual Studio Code"),
    },
    {
      label: "Open in Cursor",
      onSelect: () => system.openWith(path, "Cursor"),
    },
    {
      label: "Open in Sublime Text",
      onSelect: () => system.openWith(path, "Sublime Text"),
      divider: true,
    },
    {
      label: isLikelyHtml ? "Open in browser" : "Open in browser…",
      onSelect: () => system.openWith(path, "Safari"),
    },
    {
      label: "Open in Chrome",
      onSelect: () => system.openWith(path, "Google Chrome"),
      divider: true,
    },
    {
      label: "Copy path",
      hint: "⌘C",
      onSelect: async () => {
        try {
          await navigator.clipboard.writeText(path);
        } catch {
          /* silent — clipboard API not available */
        }
      },
    },
  ];

  // Edge-flip — keep menu inside viewport
  const top = Math.min(anchor.y, window.innerHeight - 360);
  const left = Math.min(anchor.x, window.innerWidth - MENU_WIDTH - 8);

  return (
    <motion.div
      ref={ref}
      role="menu"
      variants={dropdownVariants}
      initial="hidden"
      animate="visible"
      exit="exit"
      style={{
        position: "fixed",
        top: Math.max(8, top),
        left: Math.max(8, left),
        width: MENU_WIDTH,
        backgroundColor: "var(--surface-3)",
        border: "var(--border-2)",
        borderRadius: "var(--radius-md)",
        boxShadow: "var(--shadow-popover)",
        padding: "var(--space-1) 0",
        zIndex: "var(--z-tooltip)",
      }}
    >
      {items.map((item, idx) => (
        <div key={`${item.label}-${idx}`}>
          <MenuRow item={item} onSelect={close(item.onSelect)} />
          {item.divider && (
            <div
              role="separator"
              style={{
                height: 1,
                margin: "var(--space-1) var(--space-2)",
                backgroundColor: "var(--border-hairline)",
              }}
            />
          )}
        </div>
      ))}
    </motion.div>
  );
}

function MenuRow({
  item,
  onSelect,
}: {
  item: MenuItemSpec;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onSelect}
      style={{
        display: "flex",
        alignItems: "center",
        gap: "var(--space-3)",
        width: "100%",
        height: 28,
        padding: "0 var(--space-3)",
        backgroundColor: "transparent",
        cursor: "default",
        fontFamily: "var(--font-sans)",
        fontSize: "var(--text-sm)",
        color: item.danger ? "var(--state-error)" : "var(--text-primary)",
        textAlign: "left",
        borderRadius: "var(--radius-xs)",
      }}
      onMouseEnter={(e) =>
        (e.currentTarget.style.backgroundColor = "var(--surface-4)")
      }
      onMouseLeave={(e) =>
        (e.currentTarget.style.backgroundColor = "transparent")
      }
    >
      <span style={{ flex: 1 }}>{item.label}</span>
      {item.hint && (
        <span
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: "var(--text-2xs)",
            color: "var(--text-tertiary)",
          }}
        >
          {item.hint}
        </span>
      )}
    </button>
  );
}
