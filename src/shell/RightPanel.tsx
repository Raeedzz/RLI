import { useEffect, useState, type CSSProperties } from "react";
import { motion } from "motion/react";
import {
  IconClose,
  IconMore,
  IconPlus,
  IconPullRequest,
} from "@/design/icons";
import {
  useActiveWorktree,
  useAppDispatch,
  useAppState,
} from "@/state/AppState";
import type { RightPanelTab, SecondaryTab, Worktree } from "@/state/types";
import { fs } from "@/lib/fs";
import { git, type StatusEntry } from "@/lib/git";
import { FileTree } from "@/files/FileTree";
import { GraphView } from "@/graph/GraphView";
import { BlockTerminal } from "@/terminal/BlockTerminal";

/**
 * Right panel: top tabs (All files / Changes / Checks / Memory) + Review
 * + ⋮(Create PR), with a vertical splitter to a secondary section
 * (Setup / Run / Terminal subtabs).
 *
 * A worktree's secondary terminal is always-on — its PTY is bound to
 * `worktree.secondaryPtyId` and survives tab switches.
 */
export function RightPanel() {
  const worktree = useActiveWorktree();
  if (!worktree) return null;
  const splitPct = Math.min(80, Math.max(20, worktree.rightSplitPct));
  return (
    <div
      style={{
        height: "100%",
        display: "grid",
        gridTemplateRows: `${splitPct}% 1fr`,
      }}
    >
      <UpperPanel worktree={worktree} />
      <SecondaryPanel worktree={worktree} />
    </div>
  );
}

/* ------------------------------------------------------------------
   Upper section: All files / Changes / Checks / Memory
   ------------------------------------------------------------------ */

function UpperPanel({ worktree }: { worktree: Worktree }) {
  const dispatch = useAppDispatch();
  const state = useAppState();

  return (
    <div
      style={{
        display: "grid",
        gridTemplateRows: "auto 1fr",
        minHeight: 0,
        backgroundColor: "var(--surface-1)",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          height: 36,
          padding: "0 var(--space-2)",
          gap: 2,
          borderBottom: "var(--border-1)",
        }}
      >
        <PanelTab
          worktreeId={worktree.id}
          label="All files"
          tab="files"
          active={worktree.rightPanel === "files"}
        />
        <PanelTab
          worktreeId={worktree.id}
          label="Changes"
          tab="changes"
          active={worktree.rightPanel === "changes"}
          badge={worktree.changeCount > 0 ? worktree.changeCount : undefined}
        />
        <PanelTab
          worktreeId={worktree.id}
          label="Checks"
          tab="checks"
          active={worktree.rightPanel === "checks"}
        />
        <PanelTab
          worktreeId={worktree.id}
          label="Memory"
          tab="memory"
          active={worktree.rightPanel === "memory"}
        />
        <span style={{ flex: 1 }} />
        <button
          type="button"
          title="Create pull request"
          onClick={() =>
            dispatch({ type: "set-pr-dialog", worktreeId: worktree.id })
          }
          style={hoverableIcon(false)}
        >
          <IconPullRequest size={14} />
        </button>
        <button type="button" title="More" style={hoverableIcon(false)}>
          <IconMore size={14} />
        </button>
      </div>

      <div style={{ minHeight: 0, overflow: "auto" }}>
        {worktree.rightPanel === "files" ? (
          <FilesView worktree={worktree} />
        ) : worktree.rightPanel === "changes" ? (
          <ChangesView worktree={worktree} />
        ) : worktree.rightPanel === "checks" ? (
          <ChecksView />
        ) : (
          <MemoryView />
        )}
      </div>

      {state.prDialogOpen ? null : null}
    </div>
  );
}

function PanelTab({
  worktreeId,
  label,
  tab,
  active,
  badge,
}: {
  worktreeId: string;
  label: string;
  tab: RightPanelTab;
  active: boolean;
  badge?: number;
}) {
  const dispatch = useAppDispatch();
  const baseStyle: CSSProperties = {
    height: 28,
    padding: "0 var(--space-2)",
    color: active ? "var(--text-primary)" : "var(--text-secondary)",
    fontSize: "var(--text-sm)",
    fontWeight: active ? "var(--weight-medium)" : "var(--weight-regular)",
    borderRadius: "var(--radius-xs)",
    backgroundColor: active ? "var(--surface-3)" : "transparent",
    display: "inline-flex",
    alignItems: "center",
    gap: 4,
    transition: "background-color var(--motion-instant) var(--ease-out-quart)",
  };
  return (
    <button
      type="button"
      onClick={() => dispatch({ type: "set-right-panel", worktreeId, panel: tab })}
      style={baseStyle}
    >
      {label}
      {badge !== undefined && (
        <span
          className="tabular"
          style={{
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            minWidth: 18,
            height: 16,
            padding: "0 4px",
            borderRadius: "var(--radius-pill)",
            fontSize: "var(--text-2xs)",
            color: "var(--text-tertiary)",
            backgroundColor: "var(--surface-4)",
          }}
        >
          {badge}
        </span>
      )}
    </button>
  );
}

function hoverableIcon(active: boolean): CSSProperties {
  return {
    width: 26,
    height: 26,
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    color: active ? "var(--text-primary)" : "var(--text-tertiary)",
    backgroundColor: active ? "var(--surface-3)" : "transparent",
    borderRadius: "var(--radius-sm)",
    transition: "background-color var(--motion-instant) var(--ease-out-quart)",
  };
}

/* ------------------------------------------------------------------
   Files view — embeds the existing FileTree, opens .md as a markdown
   tab; everything else as an editor tab in the main column.
   ------------------------------------------------------------------ */

function FilesView({ worktree }: { worktree: Worktree }) {
  const dispatch = useAppDispatch();

  const onOpen = (path: string) => {
    const id = `t_${Date.now().toString(36)}`;
    dispatch({
      type: "open-tab",
      tab: {
        id,
        worktreeId: worktree.id,
        kind: "markdown",
        filePath: path,
        mode: "edit",
        content: null,
        title: path.split("/").pop() ?? path,
        summary: relPath(path, worktree.path),
        summaryUpdatedAt: Date.now(),
      },
    });
  };

  return (
    <div style={{ padding: "var(--space-1) 0", minHeight: 0 }}>
      <FileTree root={worktree.path} onOpenFile={onOpen} />
    </div>
  );
}

function relPath(abs: string, root: string): string {
  if (abs.startsWith(root + "/")) return abs.slice(root.length + 1);
  return abs;
}

/* ------------------------------------------------------------------
   Changes view — git status + click → open diff tab in main column.
   ------------------------------------------------------------------ */

function ChangesView({ worktree }: { worktree: Worktree }) {
  const dispatch = useAppDispatch();
  const [entries, setEntries] = useState<StatusEntry[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      try {
        const result = await git.status(worktree.path);
        if (cancelled) return;
        setEntries(result.entries);
        setError(null);
        dispatch({
          type: "set-change-count",
          worktreeId: worktree.id,
          count: result.entries.length,
        });
      } catch (e) {
        if (!cancelled) setError(String(e));
      }
    };
    void poll();
    const t = window.setInterval(poll, 4000);
    return () => {
      cancelled = true;
      window.clearInterval(t);
    };
  }, [worktree.id, worktree.path, dispatch]);

  if (error) {
    return (
      <div style={{ padding: "var(--space-3)", color: "var(--state-error)" }}>
        {error}
      </div>
    );
  }
  if (entries.length === 0) {
    return (
      <div
        style={{
          padding: "var(--space-3)",
          color: "var(--text-tertiary)",
          fontSize: "var(--text-xs)",
        }}
      >
        No changes
      </div>
    );
  }

  const openDiff = (entry: StatusEntry) => {
    const id = `t_diff_${Date.now().toString(36)}`;
    dispatch({
      type: "open-tab",
      tab: {
        id,
        worktreeId: worktree.id,
        kind: "diff",
        filePath: entry.path,
        staged: entry.staged,
        title: entry.path.split("/").pop() ?? entry.path,
        summary: entry.path,
        summaryUpdatedAt: Date.now(),
      },
    });
  };

  return (
    <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
      {entries.map((entry) => (
        <li key={`${entry.path}:${entry.staged}`}>
          <button
            type="button"
            onClick={() => openDiff(entry)}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              width: "100%",
              height: 28,
              padding: "0 var(--space-3)",
              color: "var(--text-secondary)",
              backgroundColor: "transparent",
              fontSize: "var(--text-xs)",
            }}
            onMouseOver={(e) =>
              (e.currentTarget.style.backgroundColor = "var(--surface-2)")
            }
            onMouseOut={(e) =>
              (e.currentTarget.style.backgroundColor = "transparent")
            }
          >
            <span style={{ width: 10, color: kindColor(entry.kind) }}>
              {kindGlyph(entry.kind)}
            </span>
            <span
              style={{
                flex: 1,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
                textAlign: "left",
              }}
            >
              {entry.path}
            </span>
            {entry.staged && (
              <span
                className="tabular"
                style={{
                  fontSize: "var(--text-2xs)",
                  color: "var(--state-success)",
                }}
              >
                ●
              </span>
            )}
          </button>
        </li>
      ))}
    </ul>
  );
}

function kindGlyph(kind: string): string {
  if (kind === "modified") return "M";
  if (kind === "added") return "A";
  if (kind === "deleted") return "D";
  if (kind === "renamed") return "R";
  if (kind === "untracked") return "U";
  if (kind === "conflicted") return "C";
  return "·";
}
function kindColor(kind: string): string {
  if (kind === "added" || kind === "untracked") return "var(--diff-add-fg)";
  if (kind === "deleted") return "var(--diff-remove-fg)";
  if (kind === "conflicted") return "var(--state-error)";
  return "var(--text-tertiary)";
}

/* ------------------------------------------------------------------
   Checks view (stub for v1)
   ------------------------------------------------------------------ */

function ChecksView() {
  return (
    <div
      style={{
        padding: "var(--space-4)",
        color: "var(--text-tertiary)",
        fontSize: "var(--text-xs)",
      }}
    >
      No checks configured.
    </div>
  );
}

/* ------------------------------------------------------------------
   Memory view — embeds GraphView. Click a node opens its source .md as
   a markdown tab in the main column. (GraphView already exposes
   onSelect via context; for v1 we just embed the visualization.)
   ------------------------------------------------------------------ */

function MemoryView() {
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.32, ease: [0.16, 1, 0.3, 1] }}
      style={{ height: "100%", minHeight: 0, position: "relative" }}
    >
      <GraphView />
    </motion.div>
  );
}

/* ------------------------------------------------------------------
   Lower section: Setup / Run / Terminal subtabs
   ------------------------------------------------------------------ */

function SecondaryPanel({ worktree }: { worktree: Worktree }) {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateRows: "auto 1fr",
        minHeight: 0,
        borderTop: "var(--border-1)",
        backgroundColor: "var(--surface-1)",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          height: 32,
          padding: "0 var(--space-2)",
          gap: 4,
          borderBottom: "var(--border-1)",
        }}
      >
        <button type="button" style={hoverableIcon(false)} title="Collapse">
          <IconClose size={12} />
        </button>
        <SecondaryTabButton
          label="Setup"
          tab="setup"
          worktreeId={worktree.id}
          active={worktree.secondaryTab === "setup"}
        />
        <SecondaryTabButton
          label="Run"
          tab="run"
          worktreeId={worktree.id}
          active={worktree.secondaryTab === "run"}
        />
        <SecondaryTabButton
          label="Terminal"
          tab="terminal"
          worktreeId={worktree.id}
          active={worktree.secondaryTab === "terminal"}
        />
        <span style={{ flex: 1 }} />
        <button
          type="button"
          title="New (placeholder)"
          style={hoverableIcon(false)}
        >
          <IconPlus size={14} />
        </button>
      </div>
      <div style={{ minHeight: 0, overflow: "hidden" }}>
        {worktree.secondaryTab === "terminal" ? (
          <BlockTerminal
            id={worktree.secondaryPtyId}
            command="zsh"
            cwd={worktree.path}
            projectId={worktree.projectId}
            sessionId={worktree.id}
          />
        ) : (
          <EmptyRunOrSetup />
        )}
      </div>
    </div>
  );
}

function SecondaryTabButton({
  label,
  tab,
  active,
  worktreeId,
}: {
  label: string;
  tab: SecondaryTab;
  active: boolean;
  worktreeId: string;
}) {
  const dispatch = useAppDispatch();
  return (
    <button
      type="button"
      onClick={() =>
        dispatch({ type: "set-secondary-tab", worktreeId, tab })
      }
      style={{
        height: 24,
        padding: "0 var(--space-2)",
        color: active ? "var(--text-primary)" : "var(--text-secondary)",
        fontSize: "var(--text-sm)",
        borderRadius: "var(--radius-xs)",
        backgroundColor: "transparent",
        borderBottom: active
          ? "1px solid var(--accent)"
          : "1px solid transparent",
      }}
    >
      {label}
    </button>
  );
}

function EmptyRunOrSetup() {
  return (
    <div
      style={{
        height: "100%",
        display: "grid",
        placeItems: "center",
        padding: "var(--space-4)",
      }}
    >
      <div
        style={{
          width: 280,
          padding: "var(--space-4)",
          border: "1px dashed var(--border-default)",
          borderRadius: "var(--radius-md)",
          color: "var(--text-tertiary)",
          fontSize: "var(--text-xs)",
          textAlign: "center",
          display: "grid",
          gap: 8,
        }}
      >
        <button
          type="button"
          style={{
            padding: "8px 12px",
            backgroundColor: "var(--surface-3)",
            color: "var(--text-primary)",
            borderRadius: "var(--radius-sm)",
            fontSize: "var(--text-sm)",
            fontWeight: "var(--weight-medium)",
            border: "var(--border-1)",
            justifySelf: "center",
          }}
        >
          Add run script
        </button>
        <span>Run tests or a development server to test changes in this worktree</span>
      </div>
    </div>
  );
}

void fs;
