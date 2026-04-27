import { AnimatePresence, motion } from "motion/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { KeyChord } from "@/primitives/KeyChord";
import {
  backdropVariants,
  paletteVariants,
} from "@/design/motion";
import { useAppDispatch, useAppState } from "@/state/AppState";
import { openProjectDialog } from "@/lib/projectDialog";

/**
 * The ⌘K palette. Mounts as a controlled overlay above all other surfaces.
 *
 * v1 commands are placeholder — most route to features that land in later
 * tasks. Selection by keyboard arrow + enter is fully functional.
 *
 * Filter is instant — no list reorder animation.
 */

interface Command {
  id: string;
  label: string;
  hint?: string;
  keys?: string[];
  run: () => void;
}

export function CommandPalette() {
  const { paletteOpen } = useAppState();
  const dispatch = useAppDispatch();

  const close = () => dispatch({ type: "set-palette", open: false });

  return (
    <AnimatePresence>
      {paletteOpen && (
        <motion.div
          key="backdrop"
          variants={backdropVariants}
          initial="hidden"
          animate="visible"
          exit="exit"
          onClick={close}
          style={{
            position: "fixed",
            inset: 0,
            backgroundColor: "var(--backdrop)",
            zIndex: "var(--z-modal-backdrop)",
            display: "grid",
            placeItems: "start center",
            paddingTop: "min(20vh, 200px)",
          }}
        >
          <motion.div
            key="palette"
            variants={paletteVariants}
            initial="hidden"
            animate="visible"
            exit="exit"
            onClick={(e) => e.stopPropagation()}
            style={{
              width: "var(--palette-width)",
              maxWidth: "90vw",
              maxHeight: "60vh",
              backgroundColor: "var(--surface-2)",
              borderRadius: "var(--radius-lg)",
              boxShadow: "var(--shadow-modal)",
              overflow: "hidden",
              display: "flex",
              flexDirection: "column",
              zIndex: "var(--z-modal)",
            }}
          >
            <PaletteContents onClose={close} />
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function PaletteContents({ onClose }: { onClose: () => void }) {
  const dispatch = useAppDispatch();
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);

  const commands = useMemo<Command[]>(
    () => [
      {
        id: "new-session",
        label: "New session",
        hint: "spawns claude in a fresh worktree",
        keys: ["⌘", "N"],
        run: () => {
          /* Task #9 */
        },
      },
      {
        id: "open-project",
        label: "Open project…",
        keys: ["⌘", "O"],
        run: () => {
          onClose();
          void openProjectDialog(dispatch);
        },
      },
      {
        id: "toggle-file-tree",
        label: "Toggle file tree",
        keys: ["⌘", "B"],
        run: () => dispatch({ type: "toggle-left-panel", panel: "files" }),
      },
      {
        id: "toggle-source-control",
        label: "Toggle source control",
        hint: "git status + stage + commit + push",
        keys: ["⌃", "⇧", "G"],
        run: () => dispatch({ type: "toggle-left-panel", panel: "git" }),
      },
      {
        id: "open-connections",
        label: "Show skills + MCPs",
        hint: "everything connected across ~/.claude/",
        keys: ["⌘", "⇧", ";"],
        run: () => {
          /* Task #10 */
        },
      },
      {
        id: "search",
        label: "Search in project…",
        hint: "ripgrep + ast-grep",
        keys: ["⌘", "⇧", "F"],
        run: () => {
          /* Task #15 */
        },
      },
      {
        id: "browser",
        label: "Open browser pane (GStack)",
        keys: ["⌘", "⇧", "B"],
        run: () => {
          /* Task #14 */
        },
      },
      {
        id: "commit",
        label: "Commit with AI message",
        hint: "writes a message via Gemini, asks before committing",
        keys: ["⌘", "↵"],
        run: () => {
          /* Task #8 */
        },
      },
      {
        id: "set-api-key",
        label: "Set Gemini API key…",
        hint: "stored in macOS Keychain",
        run: () => dispatch({ type: "set-api-key-dialog", open: true }),
      },
    ],
    [dispatch],
  );

  const filtered = useMemo(() => {
    if (!query.trim()) return commands;
    const q = query.toLowerCase();
    return commands.filter(
      (c) =>
        c.label.toLowerCase().includes(q) ||
        (c.hint?.toLowerCase().includes(q) ?? false),
    );
  }, [commands, query]);

  // Keep cursor in bounds when filter changes
  useEffect(() => {
    if (cursor >= filtered.length) setCursor(0);
  }, [filtered.length, cursor]);

  // Auto-focus input on mount
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const handleKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setCursor((c) => Math.min(c + 1, filtered.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setCursor((c) => Math.max(c - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const cmd = filtered[cursor];
      if (cmd) {
        cmd.run();
        onClose();
      }
    } else if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    }
  };

  return (
    <>
      <input
        ref={inputRef}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={handleKey}
        placeholder="Search commands, files, agents…"
        className="allow-select"
        style={{
          height: 44,
          padding: "0 var(--space-4)",
          backgroundColor: "transparent",
          border: "none",
          outline: "none",
          fontFamily: "var(--font-sans)",
          fontSize: "var(--text-md)",
          fontWeight: "var(--weight-regular)",
          color: "var(--text-primary)",
          borderBottom: "var(--border-1)",
        }}
      />

      <div
        role="listbox"
        style={{
          flex: 1,
          minHeight: 0,
          overflowY: "auto",
          padding: "var(--space-1) 0",
        }}
      >
        {filtered.length === 0 ? (
          <div
            style={{
              padding: "var(--space-6) var(--space-4)",
              textAlign: "center",
              color: "var(--text-tertiary)",
              fontSize: "var(--text-sm)",
            }}
          >
            No matching commands.
          </div>
        ) : (
          filtered.map((cmd, i) => (
            <CommandRow
              key={cmd.id}
              cmd={cmd}
              active={i === cursor}
              onMouseEnter={() => setCursor(i)}
              onClick={() => {
                cmd.run();
                onClose();
              }}
            />
          ))
        )}
      </div>
    </>
  );
}

function CommandRow({
  cmd,
  active,
  onMouseEnter,
  onClick,
}: {
  cmd: Command;
  active: boolean;
  onMouseEnter: () => void;
  onClick: () => void;
}) {
  return (
    <div
      role="option"
      aria-selected={active}
      onMouseEnter={onMouseEnter}
      onClick={onClick}
      style={{
        height: "var(--row-height-md)",
        padding: "0 var(--space-4)",
        display: "flex",
        alignItems: "center",
        gap: "var(--space-3)",
        backgroundColor: active ? "var(--surface-3)" : "transparent",
        cursor: "default",
      }}
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            fontFamily: "var(--font-sans)",
            fontSize: "var(--text-base)",
            fontWeight: "var(--weight-medium)",
            color: "var(--text-primary)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {cmd.label}
        </div>
        {cmd.hint && (
          <div
            style={{
              fontFamily: "var(--font-sans)",
              fontSize: "var(--text-xs)",
              color: "var(--text-tertiary)",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              marginTop: -1,
            }}
          >
            {cmd.hint}
          </div>
        )}
      </div>
      {cmd.keys && <KeyChord keys={cmd.keys} />}
    </div>
  );
}
