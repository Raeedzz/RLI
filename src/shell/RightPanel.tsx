import { useCallback, useEffect, useMemo, useState, type CSSProperties } from "react";
import { AnimatePresence, motion } from "motion/react";
import { invoke } from "@tauri-apps/api/core";
import {
  IconCheck,
  IconChevronDown,
  IconMore,
  IconPlus,
  IconPullRequest,
  IconPush,
  IconSparkles,
} from "@/design/icons";
import {
  useActiveWorktree,
  useAppDispatch,
  useAppState,
} from "@/state/AppState";
import {
  projectSettings,
  type RightPanelTab,
  type SecondaryTab,
  type Worktree,
} from "@/state/types";
import { fs } from "@/lib/fs";
import { git, type StatusEntry } from "@/lib/git";
import { FileTree } from "@/files/FileTree";
import { BlockTerminal } from "@/terminal/BlockTerminal";
import { useToast } from "@/primitives/Toast";
import { Loader } from "@/primitives/Loader";
import { BrowserPane } from "@/browser/BrowserPane";

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
  const collapsed = worktree.secondaryCollapsed === true;
  // The secondary panel collapses to just its tab header (32px). We
  // animate `grid-template-rows` directly — modern WebKit blends % and
  // px row tracks smoothly, and motion's MotionConfig sees the same
  // ease-out-quart curve for consistency with the rest of the chrome.
  return (
    <div
      style={{
        height: "100%",
        display: "grid",
        gridTemplateRows: collapsed ? "1fr 32px" : `${splitPct}% 1fr`,
        transition:
          "grid-template-rows var(--motion-base) var(--ease-out-quart)",
      }}
    >
      <UpperPanel worktree={worktree} />
      <SecondaryPanel worktree={worktree} collapsed={collapsed} />
    </div>
  );
}

/* ------------------------------------------------------------------
   Upper section: All files / Changes / Checks / Memory
   ------------------------------------------------------------------ */

function UpperPanel({ worktree }: { worktree: Worktree }) {
  const dispatch = useAppDispatch();
  const state = useAppState();

  // Keep `worktree.changeCount` (the badge on the Changes tab + the
  // sidebar's `+N` indicator) fresh whether or not the Changes view
  // is currently visible. ChangesView still runs its own poll for the
  // entries list, but its dispatch only fires while that view is
  // mounted — without this hook the badge sits stale on any tab the
  // user hasn't visited recently. Running here in UpperPanel covers
  // every tab the user could be looking at for the active worktree.
  useChangeCountPolling(worktree.id, worktree.path);

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
          label="Browser"
          tab="browser"
          active={worktree.rightPanel === "browser"}
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

      <div style={{ minHeight: 0, overflow: "auto", position: "relative" }}>
        {worktree.rightPanel === "files" ? (
          <FilesView worktree={worktree} />
        ) : worktree.rightPanel === "changes" ? (
          <ChangesView worktree={worktree} />
        ) : (
          // BrowserPane drives the in-house Chrome daemon at
          // $RLI_BROWSER_URL. Rendered embedded so it fills the panel
          // instead of floating as its old standalone overlay. The
          // pane's close button maps to switching the right panel
          // back to the file tree.
          <BrowserPane
            embedded
            onClose={() =>
              dispatch({
                type: "set-right-panel",
                worktreeId: worktree.id,
                panel: "files",
              })
            }
          />
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
  const [hover, setHover] = useState(false);
  // Two stacked highlights, both absolutely positioned behind the
  // label so the click target stays one cohesive rect:
  //
  //   - The *active* highlight is a motion.span with a shared
  //     `layoutId` scoped to this worktree's tab strip. When the
  //     active prop flips, the span unmounts from the old tab and
  //     mounts on the new one — motion sees the layoutId match and
  //     interpolates the transform between the two bounding rects.
  //     That's the "slide" effect: a single rect glides from Files
  //     → Changes → Browser instead of disappearing and reappearing.
  //   - The *hover* highlight is a plain span — fades in on enter,
  //     out on leave. Only renders when the tab is inactive; the
  //     active highlight already covers the surface treatment.
  //
  // Active tab fades its hover highlight away (covered by the active
  // rect anyway) so the two never visually overlap.
  return (
    <button
      type="button"
      onClick={() => dispatch({ type: "set-right-panel", worktreeId, panel: tab })}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        position: "relative",
        height: 28,
        padding: "0 var(--space-2)",
        backgroundColor: "transparent",
        color: active ? "var(--text-primary)" : "var(--text-secondary)",
        fontSize: "var(--text-sm)",
        fontWeight: active ? "var(--weight-medium)" : "var(--weight-regular)",
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        cursor: "default",
        transition: "color var(--motion-fast) var(--ease-out-quart)",
      }}
    >
      {active && (
        <motion.span
          layoutId={`right-panel-tab-active-${worktreeId}`}
          transition={{
            // Tween with ease-out-quart — same curve as the rest of
            // the chrome's punctuation animations. 240ms reads as
            // "considered" without feeling slow; the rectangle has
            // real distance to cover when jumping tab-to-tab so we
            // want enough duration to convey continuity.
            duration: 0.24,
            ease: [0.25, 1, 0.5, 1],
          }}
          style={{
            position: "absolute",
            inset: 0,
            borderRadius: "var(--radius-xs)",
            backgroundColor: "var(--surface-3)",
            zIndex: 0,
          }}
          aria-hidden
        />
      )}
      {!active && (
        <span
          style={{
            position: "absolute",
            inset: 0,
            borderRadius: "var(--radius-xs)",
            // --surface-3 (same as the active rect). The previous
            // --surface-2 sat only ~3% lightness above the panel
            // background, which read as "no highlight at all" on
            // near-black. Matching the active rect makes the hover
            // a preview of the would-be-active state.
            backgroundColor: "var(--surface-3)",
            opacity: hover ? 1 : 0,
            transition: "opacity var(--motion-fast) var(--ease-out-quart)",
            zIndex: 0,
            pointerEvents: "none",
          }}
          aria-hidden
        />
      )}
      <span
        style={{
          position: "relative",
          zIndex: 1,
          display: "inline-flex",
          alignItems: "center",
          gap: 4,
        }}
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
      </span>
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
        savedContent: null,
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

/**
 * Polls `git status` for a worktree and pushes the entry count into
 * `worktree.changeCount` so the Changes-tab badge and sidebar `+N`
 * indicator stay current.
 *
 * Two trigger paths:
 *  - 4-second polling — bounded cadence so the badge tracks ambient
 *    edits the user makes outside of GLI (e.g. via VS Code).
 *  - `rli-git-refresh` window event — emitted by the commit / push /
 *    merge paths so the count updates within ~50ms instead of waiting
 *    for the next tick.
 *
 * Mounted at the `UpperPanel` level (always live for the active
 * worktree) rather than inside `ChangesView` (only mounts while the
 * user is on that tab). ChangesView still runs its own poll for the
 * entries list, but doesn't need to drive the count anymore.
 */
function useChangeCountPolling(worktreeId: string, worktreePath: string) {
  const dispatch = useAppDispatch();
  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      try {
        const result = await git.status(worktreePath);
        if (cancelled) return;
        dispatch({
          type: "set-change-count",
          worktreeId,
          count: result.entries.length,
        });
      } catch {
        // Swallow — the next tick or refresh nudge will retry. A
        // failing git status (e.g. mid-rebase, locked index) shouldn't
        // bubble into the chrome.
      }
    };
    void poll();
    const t = window.setInterval(poll, 4000);
    const onRefresh = (e: Event) => {
      const detail = (e as CustomEvent<{ cwd?: string }>).detail;
      if (!detail?.cwd || detail.cwd === worktreePath) {
        void poll();
      }
    };
    window.addEventListener("rli-git-refresh", onRefresh);
    return () => {
      cancelled = true;
      window.clearInterval(t);
      window.removeEventListener("rli-git-refresh", onRefresh);
    };
  }, [worktreeId, worktreePath, dispatch]);
}

/* ------------------------------------------------------------------
   Changes view — git status + click → open diff tab in main column.
   ------------------------------------------------------------------ */

function ChangesView({ worktree }: { worktree: Worktree }) {
  const dispatch = useAppDispatch();
  const state = useAppState();
  const toast = useToast();
  const [entries, setEntries] = useState<StatusEntry[]>([]);
  const [ahead, setAhead] = useState<number>(0);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string>("");
  const [busy, setBusy] = useState<null | "stage" | "unstage" | "commit" | "push" | "draft">(null);

  const refresh = useCallback(async () => {
    try {
      const result = await git.status(worktree.path);
      setEntries(result.entries);
      setAhead(result.ahead);
      setError(null);
      // changeCount is dispatched by `useChangeCountPolling` in the
      // parent UpperPanel — running it here too would just race.
    } catch (e) {
      setError(String(e));
    }
  }, [worktree.path]);

  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      try {
        const result = await git.status(worktree.path);
        if (cancelled) return;
        setEntries(result.entries);
        setAhead(result.ahead);
        setError(null);
      } catch (e) {
        if (!cancelled) setError(String(e));
      }
    };
    void poll();
    const t = window.setInterval(poll, 4000);
    // External nudges from the merge / push paths so the panel doesn't
    // sit on a stale "uncommitted" row for up to 4s after the user has
    // already gotten everything onto main.
    const onRefresh = (e: Event) => {
      const detail = (e as CustomEvent<{ cwd?: string }>).detail;
      if (!detail?.cwd || detail.cwd === worktree.path) {
        void poll();
      }
    };
    window.addEventListener("rli-git-refresh", onRefresh);
    return () => {
      cancelled = true;
      window.clearInterval(t);
      window.removeEventListener("rli-git-refresh", onRefresh);
    };
  }, [worktree.id, worktree.path, dispatch]);

  const stagedCount = useMemo(
    () => entries.filter((e) => e.staged).length,
    [entries],
  );
  const unstagedCount = entries.length - stagedCount;

  const stageAll = async () => {
    if (entries.length === 0) return;
    setBusy("stage");
    try {
      await git.stage(
        worktree.path,
        Array.from(new Set(entries.map((e) => e.path))),
      );
      await refresh();
    } catch (e) {
      toast.show({ message: `Stage failed: ${e}` });
    } finally {
      setBusy(null);
    }
  };

  const unstageAll = async () => {
    const staged = entries.filter((e) => e.staged);
    if (staged.length === 0) return;
    setBusy("unstage");
    try {
      await git.unstage(worktree.path, staged.map((e) => e.path));
      await refresh();
    } catch (e) {
      toast.show({ message: `Unstage failed: ${e}` });
    } finally {
      setBusy(null);
    }
  };

  const draftMessage = async () => {
    if (stagedCount === 0) {
      toast.show({ message: "Stage some changes first to draft a message." });
      return;
    }
    setBusy("draft");
    try {
      const cli =
        worktree.agentCli ?? state.settings.helperCliCommit ?? "claude";
      // Model only applies when the user hasn't been overridden by the
      // worktree's running CLI — otherwise we'd pass a Claude model
      // string to a Codex run, etc.
      const model =
        cli === state.settings.helperCliCommit
          ? state.settings.helperModelCommit
          : "";
      const project = state.projects[worktree.projectId];
      const cfgPrefs = projectSettings(project).prefs;
      const extras = cfgPrefs.general.trim();
      const text = await git.aiCommitMessage(
        worktree.path,
        cli,
        model,
        extras || undefined,
      );
      setMessage(text.trim());
    } catch (e) {
      toast.show({ message: `AI draft failed: ${e}` });
    } finally {
      setBusy(null);
    }
  };

  const commit = async () => {
    if (stagedCount === 0) {
      toast.show({ message: "Nothing staged to commit." });
      return;
    }
    if (!message.trim()) {
      toast.show({ message: "Write a commit message first." });
      return;
    }
    setBusy("commit");
    try {
      await git.commit(worktree.path, message.trim());
      toast.show({ message: "Committed." });
      setMessage("");
      await refresh();
      window.dispatchEvent(
        new CustomEvent("rli-git-refresh", {
          detail: { cwd: worktree.path },
        }),
      );
    } catch (e) {
      toast.show({ message: `Commit failed: ${e}` });
    } finally {
      setBusy(null);
    }
  };

  const push = async () => {
    setBusy("push");
    try {
      await git.push(worktree.path);
      toast.show({ message: "Pushed." });
      await refresh();
      window.dispatchEvent(
        new CustomEvent("rli-git-refresh", {
          detail: { cwd: worktree.path },
        }),
      );
    } catch (e) {
      toast.show({ message: `Push failed: ${e}` });
    } finally {
      setBusy(null);
    }
  };

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

  const toggleStage = async (entry: StatusEntry) => {
    try {
      if (entry.staged) {
        await git.unstage(worktree.path, [entry.path]);
      } else {
        await git.stage(worktree.path, [entry.path]);
      }
      await refresh();
    } catch (e) {
      toast.show({ message: `${entry.staged ? "Unstage" : "Stage"} failed: ${e}` });
    }
  };

  if (error) {
    return (
      <div style={{ padding: "var(--space-3)", color: "var(--state-error)" }}>
        {error}
      </div>
    );
  }

  return (
    <div
      style={{
        display: "grid",
        gridTemplateRows: "auto 1fr",
        height: "100%",
        minHeight: 0,
      }}
    >
      <CommitComposer
        message={message}
        onChange={setMessage}
        onDraft={draftMessage}
        onCommit={commit}
        onPush={push}
        busy={busy}
        stagedCount={stagedCount}
        ahead={ahead}
      />

      <div style={{ minHeight: 0, overflow: "auto" }}>
        {entries.length === 0 ? (
          <div
            style={{
              padding: "var(--space-3)",
              color: "var(--text-tertiary)",
              fontSize: "var(--text-xs)",
            }}
          >
            No changes
          </div>
        ) : (
          <>
            {stagedCount > 0 && (
              <ChangesGroup
                label="Staged"
                count={stagedCount}
                actionLabel="Unstage all"
                actionDisabled={busy !== null}
                onAction={unstageAll}
              />
            )}
            {stagedCount > 0 && (
              <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
                {entries
                  .filter((e) => e.staged)
                  .map((entry) => (
                    <ChangeRow
                      key={`s:${entry.path}`}
                      entry={entry}
                      onOpen={openDiff}
                      onToggle={toggleStage}
                    />
                  ))}
              </ul>
            )}
            {unstagedCount > 0 && (
              <ChangesGroup
                label="Unstaged"
                count={unstagedCount}
                actionLabel="Stage all"
                actionDisabled={busy !== null}
                onAction={stageAll}
              />
            )}
            {unstagedCount > 0 && (
              <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
                {entries
                  .filter((e) => !e.staged)
                  .map((entry) => (
                    <ChangeRow
                      key={`u:${entry.path}`}
                      entry={entry}
                      onOpen={openDiff}
                      onToggle={toggleStage}
                    />
                  ))}
              </ul>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function ChangesGroup({
  label,
  count,
  actionLabel,
  actionDisabled,
  onAction,
}: {
  label: string;
  count: number;
  actionLabel: string;
  actionDisabled?: boolean;
  onAction: () => void;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        height: 24,
        padding: "0 var(--space-3)",
        marginTop: "var(--space-1)",
        backgroundColor: "var(--surface-2)",
        borderTop: "var(--border-1)",
        borderBottom: "var(--border-1)",
      }}
    >
      <span
        style={{
          fontSize: "var(--text-2xs)",
          fontWeight: "var(--weight-semibold)",
          textTransform: "uppercase",
          letterSpacing: "var(--tracking-caps)",
          color: "var(--text-tertiary)",
        }}
      >
        {label}
      </span>
      <span
        className="tabular"
        style={{
          marginLeft: 6,
          fontSize: "var(--text-2xs)",
          color: "var(--text-disabled)",
        }}
      >
        {count}
      </span>
      <span style={{ flex: 1 }} />
      <button
        type="button"
        disabled={actionDisabled}
        onClick={onAction}
        style={{
          fontSize: "var(--text-2xs)",
          color: actionDisabled ? "var(--text-disabled)" : "var(--text-tertiary)",
          backgroundColor: "transparent",
          padding: "0 4px",
          cursor: actionDisabled ? "default" : "pointer",
        }}
      >
        {actionLabel}
      </button>
    </div>
  );
}

function ChangeRow({
  entry,
  onOpen,
  onToggle,
}: {
  entry: StatusEntry;
  onOpen: (e: StatusEntry) => void;
  onToggle: (e: StatusEntry) => void;
}) {
  const tint = kindTint(entry.kind);
  return (
    <li>
      <div
        onClick={() => onOpen(entry)}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          width: "100%",
          height: 28,
          padding: "0 var(--space-3)",
          color: "var(--text-secondary)",
          backgroundColor: "transparent",
          fontSize: "var(--text-xs)",
          cursor: "pointer",
          transition: "background-color var(--motion-instant) var(--ease-out-quart)",
        }}
        onMouseOver={(e) =>
          (e.currentTarget.style.backgroundColor = "var(--surface-2)")
        }
        onMouseOut={(e) =>
          (e.currentTarget.style.backgroundColor = "transparent")
        }
      >
        <span
          aria-label={kindLabel(entry.kind)}
          title={kindLabel(entry.kind)}
          className="tabular"
          style={{
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            width: 16,
            height: 16,
            flexShrink: 0,
            borderRadius: "var(--radius-xs)",
            fontSize: "var(--text-2xs)",
            fontWeight: "var(--weight-bold)",
            color: tint.fg,
            backgroundColor: tint.bg,
            border: `1px solid ${tint.border}`,
          }}
        >
          {kindGlyph(entry.kind)}
        </span>
        <span
          style={{
            flex: 1,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            textAlign: "left",
            color: "var(--text-primary)",
          }}
          title={entry.path}
        >
          {entry.path}
        </span>
        <button
          type="button"
          title={entry.staged ? "Unstage" : "Stage"}
          onClick={(e) => {
            e.stopPropagation();
            onToggle(entry);
          }}
          style={{
            fontSize: "var(--text-2xs)",
            color: "var(--text-tertiary)",
            padding: "2px 6px",
            backgroundColor: "transparent",
            borderRadius: "var(--radius-xs)",
            opacity: 0.7,
            transition: "opacity var(--motion-instant) var(--ease-out-quart), background-color var(--motion-instant) var(--ease-out-quart)",
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.opacity = "1";
            e.currentTarget.style.backgroundColor = "var(--surface-3)";
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.opacity = "0.7";
            e.currentTarget.style.backgroundColor = "transparent";
          }}
        >
          {entry.staged ? "−" : "+"}
        </button>
      </div>
    </li>
  );
}

/**
 * Single-action commit / push composer. The textarea is the whole
 * surface; two icon-shaped buttons live in its corners:
 *
 *   ┌──────────────────────────── [✨] ┐ ← AI-draft (top-right)
 *   │ Describe the change…             │
 *   │                                  │
 *   │                       [Commit ↵] │ ← morphing action (bottom-right)
 *   └──────────────────────────────────┘
 *
 * The bottom-right button is one slot that morphs between Commit and
 * Push depending on the worktree's git state — never two buttons at
 * once. Commit when you have staged changes + a message; Push when
 * the branch is ahead. Disabled state when there's nothing to do.
 */
function CommitComposer({
  message,
  onChange,
  onDraft,
  onCommit,
  onPush,
  busy,
  stagedCount,
  ahead,
}: {
  message: string;
  onChange: (s: string) => void;
  onDraft: () => void;
  onCommit: () => void;
  onPush: () => void;
  busy: null | "stage" | "unstage" | "commit" | "push" | "draft";
  stagedCount: number;
  ahead: number;
}) {
  // Mode picker. Commit takes priority when there are staged changes
  // — the user is mid-edit; pushing existing commits can wait. Push
  // appears once the working tree is settled.
  const canCommit = stagedCount > 0 && message.trim().length > 0;
  const mode: "commit" | "push" | "idle" =
    canCommit ? "commit" : ahead > 0 ? "push" : "idle";
  const disabled = busy !== null || mode === "idle";

  const onAction = () => {
    if (disabled) return;
    if (mode === "commit") onCommit();
    else if (mode === "push") onPush();
  };

  return (
    <div
      style={{
        position: "relative",
        padding: "var(--space-3)",
        borderBottom: "var(--border-1)",
        backgroundColor: "var(--surface-2)",
      }}
    >
      <textarea
        value={message}
        onChange={(e) => onChange(e.target.value)}
        placeholder={
          stagedCount > 0
            ? "Describe the change…"
            : ahead > 0
              ? "Push to share — message optional for next commit"
              : "Stage changes to commit"
        }
        rows={4}
        style={{
          width: "100%",
          minHeight: 96,
          maxHeight: 240,
          // No native resize handle — it sat behind the Commit button
          // as a visual artifact. The textarea grows via row height
          // when its content exceeds 4 lines.
          resize: "none",
          // Reserve room in the corners for the absolutely-positioned
          // AI button (top-right) and action button (bottom-right) so
          // text never slides under them — generous so the buttons
          // breathe instead of crowding the textarea wall.
          padding: "var(--space-3) 44px var(--space-8) var(--space-3)",
          backgroundColor: "var(--surface-1)",
          border: "var(--border-1)",
          borderRadius: "var(--radius-sm)",
          color: "var(--text-primary)",
          fontFamily: "var(--font-sans)",
          fontSize: "var(--text-xs)",
          lineHeight: "var(--leading-xs)",
          outline: "none",
        }}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
            e.preventDefault();
            onAction();
          }
        }}
      />

      <AiDraftButton
        onClick={onDraft}
        disabled={busy !== null || stagedCount === 0}
        busy={busy === "draft"}
      />

      <ComposerActionButton
        mode={mode}
        busy={busy}
        disabled={disabled}
        onClick={onAction}
      />
    </div>
  );
}

function AiDraftButton({
  onClick,
  disabled,
  busy,
}: {
  onClick: () => void;
  disabled: boolean;
  busy: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={busy ? "Drafting…" : "Draft commit message with your CLI agent"}
      aria-label="Draft commit message with AI"
      style={{
        position: "absolute",
        top: "calc(var(--space-3) + 6px)",
        right: "calc(var(--space-3) + 6px)",
        width: 26,
        height: 26,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: "transparent",
        color: disabled
          ? "var(--text-disabled)"
          : busy
            ? "var(--accent-bright)"
            : "var(--text-tertiary)",
        border: "none",
        borderRadius: "var(--radius-sm)",
        cursor: disabled ? "default" : "pointer",
        transition:
          "background-color var(--motion-instant) var(--ease-out-quart), color var(--motion-instant) var(--ease-out-quart)",
      }}
      onMouseEnter={(e) => {
        if (disabled) return;
        e.currentTarget.style.backgroundColor = "var(--surface-3)";
        e.currentTarget.style.color = "var(--accent-bright)";
      }}
      onMouseLeave={(e) => {
        if (disabled) return;
        e.currentTarget.style.backgroundColor = "transparent";
        e.currentTarget.style.color = busy
          ? "var(--accent-bright)"
          : "var(--text-tertiary)";
      }}
    >
      <AnimatePresence mode="wait" initial={false}>
        {busy ? (
          <motion.span
            key="spinner"
            initial={{ opacity: 0, scale: 0.85 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.85 }}
            transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
            style={{
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              color: "var(--accent-bright)",
            }}
          >
            <ArcSpinner size={14} />
          </motion.span>
        ) : (
          <motion.span
            key="wand"
            initial={{ opacity: 0, scale: 0.85 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.85 }}
            transition={{ duration: 0.14, ease: [0.25, 1, 0.5, 1] }}
            style={{
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <IconSparkles size={14} />
          </motion.span>
        )}
      </AnimatePresence>
    </button>
  );
}

/**
 * Inline button loader. Delegates to the shared `<Loader>` primitive
 * so the spinner geometry, rotation cadence, and reduced-motion
 * handling stay in lockstep with the rest of the app — sidebar
 * worktree row, tab strip, hover-card status, and this button all
 * pull from the same source. `size` lets the caller tune for button
 * height; everything else is locked.
 */
function ArcSpinner({ size }: { size: number }) {
  return <Loader size={size} />;
}

function ComposerActionButton({
  mode,
  busy,
  disabled,
  onClick,
}: {
  mode: "commit" | "push" | "idle";
  busy: null | "stage" | "unstage" | "commit" | "push" | "draft";
  disabled: boolean;
  onClick: () => void;
}) {
  const isWorking = busy === "commit" || busy === "push";
  const labelKey = isWorking ? `working-${busy}` : mode;
  const label =
    busy === "commit"
      ? "Committing"
      : busy === "push"
        ? "Pushing"
        : mode === "push"
          ? "Push"
          : mode === "idle"
            ? "Commit"
            : "Commit";
  const Glyph =
    mode === "push" || busy === "push" ? IconPush : IconCheck;

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={
        mode === "push"
          ? "Push (⌘↵)"
          : mode === "idle"
            ? "Stage changes and write a message to commit"
            : "Commit (⌘↵)"
      }
      aria-label={label}
      style={{
        position: "absolute",
        right: "calc(var(--space-3) + 10px)",
        bottom: "calc(var(--space-3) + 10px)",
        height: 26,
        minWidth: 92,
        padding: "0 12px",
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        gap: 6,
        backgroundColor: disabled
          ? "var(--surface-3)"
          : "var(--surface-accent-tinted)",
        color: disabled ? "var(--text-disabled)" : "var(--text-primary)",
        border: disabled
          ? "var(--border-1)"
          : "1px solid var(--accent-muted)",
        borderRadius: "var(--radius-sm)",
        fontFamily: "var(--font-sans)",
        fontSize: "var(--text-2xs)",
        fontWeight: "var(--weight-semibold)",
        letterSpacing: "var(--tracking-tight)",
        cursor: disabled ? "default" : "pointer",
        transition:
          "background-color var(--motion-instant) var(--ease-out-quart), border-color var(--motion-instant) var(--ease-out-quart), color var(--motion-instant) var(--ease-out-quart)",
        overflow: "hidden",
      }}
      onMouseEnter={(e) => {
        if (disabled) return;
        e.currentTarget.style.backgroundColor =
          "color-mix(in oklch, var(--surface-accent-tinted), var(--accent) 8%)";
      }}
      onMouseLeave={(e) => {
        if (disabled) return;
        e.currentTarget.style.backgroundColor =
          "var(--surface-accent-tinted)";
      }}
    >
      <Glyph size={12} />
      <AnimatePresence mode="wait" initial={false}>
        <motion.span
          key={labelKey}
          initial={{ opacity: 0, y: 4 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -4 }}
          transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
          style={{ display: "inline-block" }}
        >
          {label}
        </motion.span>
      </AnimatePresence>
    </button>
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

function kindLabel(kind: string): string {
  if (kind === "modified") return "Modified";
  if (kind === "added") return "Added";
  if (kind === "deleted") return "Deleted";
  if (kind === "renamed") return "Renamed";
  if (kind === "untracked") return "Untracked";
  if (kind === "conflicted") return "Conflicted";
  return kind;
}

interface KindTint {
  fg: string;
  bg: string;
  border: string;
}

function kindTint(kind: string): KindTint {
  if (kind === "added" || kind === "untracked") {
    return {
      fg: "var(--diff-add-fg)",
      bg: "color-mix(in oklch, transparent, var(--diff-add-fg) 18%)",
      border: "color-mix(in oklch, transparent, var(--diff-add-fg) 28%)",
    };
  }
  if (kind === "deleted") {
    return {
      fg: "var(--diff-remove-fg)",
      bg: "color-mix(in oklch, transparent, var(--diff-remove-fg) 18%)",
      border: "color-mix(in oklch, transparent, var(--diff-remove-fg) 28%)",
    };
  }
  if (kind === "modified") {
    return {
      fg: "var(--diff-change-fg)",
      bg: "color-mix(in oklch, transparent, var(--diff-change-fg) 16%)",
      border: "color-mix(in oklch, transparent, var(--diff-change-fg) 26%)",
    };
  }
  if (kind === "renamed") {
    return {
      fg: "var(--accent-bright)",
      bg: "color-mix(in oklch, transparent, var(--accent-bright) 16%)",
      border: "color-mix(in oklch, transparent, var(--accent-bright) 26%)",
    };
  }
  if (kind === "conflicted") {
    return {
      fg: "var(--state-error-bright)",
      bg: "color-mix(in oklch, transparent, var(--state-error-bright) 22%)",
      border: "color-mix(in oklch, transparent, var(--state-error-bright) 32%)",
    };
  }
  return {
    fg: "var(--text-tertiary)",
    bg: "var(--surface-3)",
    border: "var(--border-default)",
  };
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
   Lower section: Setup / Run / Terminal subtabs
   ------------------------------------------------------------------ */

function SecondaryPanel({
  worktree,
  collapsed,
}: {
  worktree: Worktree;
  collapsed: boolean;
}) {
  const dispatch = useAppDispatch();
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
        <CollapseToggle
          collapsed={collapsed}
          onClick={() =>
            dispatch({
              type: "toggle-secondary-collapsed",
              worktreeId: worktree.id,
            })
          }
        />
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
        {(worktree.secondaryTerminals ?? []).map((ptyId, i) => (
          <TerminalTabButton
            key={ptyId}
            label={i === 0 ? "Terminal" : `Terminal ${i + 1}`}
            ptyId={ptyId}
            worktreeId={worktree.id}
            active={
              worktree.secondaryTab === "terminal" &&
              worktree.secondaryActiveTerminalId === ptyId
            }
            closable={(worktree.secondaryTerminals ?? []).length > 1}
          />
        ))}
        <button
          type="button"
          title="New terminal (⌘T)"
          aria-label="New terminal"
          onClick={() =>
            dispatch({
              type: "add-secondary-terminal",
              worktreeId: worktree.id,
            })
          }
          style={hoverableIcon(false)}
          onMouseEnter={(e) => {
            e.currentTarget.style.backgroundColor = "var(--surface-3)";
            e.currentTarget.style.color = "var(--text-primary)";
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.backgroundColor = "transparent";
            e.currentTarget.style.color = "var(--text-tertiary)";
          }}
        >
          <IconPlus size={14} />
        </button>
        <span style={{ flex: 1 }} />
        <PreviewUrlButton worktree={worktree} />
      </div>
      <AnimatePresence initial={false}>
        {!collapsed && (
          <motion.div
            key="secondary-content"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.18, ease: [0.25, 1, 0.5, 1] }}
            style={{
              minHeight: 0,
              overflow: "hidden",
              position: "relative",
            }}
          >
            {worktree.secondaryTab === "terminal" ? (
              <SecondaryTerminals worktree={worktree} />
            ) : (
              <ScriptPanel worktree={worktree} kind={worktree.secondaryTab} />
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function CollapseToggle({
  collapsed,
  onClick,
}: {
  collapsed: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={collapsed ? "Expand panel" : "Collapse panel"}
      aria-label={collapsed ? "Expand panel" : "Collapse panel"}
      aria-expanded={!collapsed}
      style={{
        ...hoverableIcon(false),
        marginRight: 2,
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
      <motion.span
        aria-hidden
        animate={{ rotate: collapsed ? 180 : 0 }}
        transition={{ duration: 0.24, ease: [0.25, 1, 0.5, 1] }}
        style={{
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          transformOrigin: "center",
        }}
      >
        <IconChevronDown size={14} />
      </motion.span>
    </button>
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

function TerminalTabButton({
  label,
  ptyId,
  worktreeId,
  active,
  closable,
}: {
  label: string;
  ptyId: string;
  worktreeId: string;
  active: boolean;
  closable: boolean;
}) {
  const dispatch = useAppDispatch();
  const [hover, setHover] = useState(false);
  return (
    <div
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: "inline-flex",
        alignItems: "center",
        height: 24,
        borderRadius: "var(--radius-xs)",
        borderBottom: active
          ? "1px solid var(--accent)"
          : "1px solid transparent",
        backgroundColor: hover && !active ? "var(--surface-3)" : "transparent",
        transition:
          "background-color var(--motion-instant) var(--ease-out-quart)",
      }}
    >
      <button
        type="button"
        onClick={() =>
          dispatch({
            type: "select-secondary-terminal",
            worktreeId,
            ptyId,
          })
        }
        style={{
          height: 24,
          paddingLeft: "var(--space-2)",
          paddingRight: closable && hover ? 2 : "var(--space-2)",
          color: active ? "var(--text-primary)" : "var(--text-secondary)",
          fontSize: "var(--text-sm)",
          backgroundColor: "transparent",
          transition:
            "color var(--motion-instant) var(--ease-out-quart), padding var(--motion-instant) var(--ease-out-quart)",
        }}
      >
        {label}
      </button>
      {closable && hover && (
        <button
          type="button"
          title="Close terminal"
          aria-label="Close terminal"
          onClick={(e) => {
            e.stopPropagation();
            dispatch({
              type: "close-secondary-terminal",
              worktreeId,
              ptyId,
            });
          }}
          style={{
            width: 16,
            height: 16,
            marginRight: 4,
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            color: "var(--text-tertiary)",
            backgroundColor: "transparent",
            borderRadius: "var(--radius-xs)",
            fontSize: 12,
            lineHeight: 1,
            transition:
              "background-color var(--motion-instant) var(--ease-out-quart), color var(--motion-instant) var(--ease-out-quart)",
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.backgroundColor = "var(--surface-4)";
            e.currentTarget.style.color = "var(--text-primary)";
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.backgroundColor = "transparent";
            e.currentTarget.style.color = "var(--text-tertiary)";
          }}
        >
          ×
        </button>
      )}
    </div>
  );
}

/**
 * Mounts every secondary-panel terminal at once, layering them via
 * absolute positioning. Only the active one is visible and accepts
 * pointer events; the others stay alive in the background so their
 * scrollback survives tab switches without us having to replay it
 * through the PTY.
 */
function SecondaryTerminals({ worktree }: { worktree: Worktree }) {
  const list = worktree.secondaryTerminals ?? [worktree.secondaryPtyId];
  const active = worktree.secondaryActiveTerminalId ?? list[list.length - 1];
  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
      }}
    >
      {list.map((ptyId) => {
        const isActive = ptyId === active;
        return (
          <div
            key={ptyId}
            style={{
              position: "absolute",
              inset: 0,
              visibility: isActive ? "visible" : "hidden",
              pointerEvents: isActive ? "auto" : "none",
              zIndex: isActive ? 1 : 0,
            }}
          >
            <BlockTerminal
              id={ptyId}
              command="zsh"
              cwd={worktree.path}
              projectId={worktree.projectId}
              sessionId={`${worktree.id}:${ptyId}`}
            />
          </div>
        );
      })}
    </div>
  );
}

function PreviewUrlButton({ worktree }: { worktree: Worktree }) {
  const state = useAppState();
  const project = state.projects[worktree.projectId];
  const cfg = projectSettings(project);
  const url = cfg.previewUrl.trim();
  if (!url) return null;
  // Accept both $GLI_* (current) and $RLI_* (legacy) placeholder names
  // so existing previewUrl values keep working after the rename.
  const resolved = url
    .replace(/\$(?:GLI|RLI)_WORKTREE_NAME/g, worktree.name)
    .replace(/\$(?:GLI|RLI)_PROJECT_ID/g, worktree.projectId)
    .replace(/\$(?:GLI|RLI)_PORT/g, "3000");
  return (
    <button
      type="button"
      onClick={() => {
        void invoke("system_open", { path: resolved }).catch(() => {});
      }}
      title={`Open ${resolved}`}
      style={{
        height: 22,
        padding: "0 8px",
        marginRight: 4,
        backgroundColor: "transparent",
        color: "var(--text-secondary)",
        border: "var(--border-1)",
        borderRadius: "var(--radius-sm)",
        fontFamily: "var(--font-sans)",
        fontSize: "var(--text-2xs)",
        fontWeight: "var(--weight-medium)",
        cursor: "pointer",
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.color = "var(--text-primary)";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.color = "var(--text-secondary)";
      }}
    >
      Open ↗
    </button>
  );
}

function ScriptPanel({
  worktree,
  kind,
}: {
  worktree: Worktree;
  kind: "setup" | "run";
}) {
  const state = useAppState();
  const dispatch = useAppDispatch();
  const project = state.projects[worktree.projectId];
  const cfg = projectSettings(project);
  const script = (kind === "run" ? cfg.runScript : cfg.setupScript).trim();

  const openSettings = () => {
    if (!project) return;
    dispatch({
      type: "set-settings-open",
      open: true,
      section: { kind: "repository", id: project.id },
    });
  };

  const playInTerminal = async () => {
    if (!script) return;
    const ptyId =
      worktree.secondaryActiveTerminalId ??
      worktree.secondaryTerminals?.[0] ??
      worktree.secondaryPtyId;
    if (!ptyId) return;
    dispatch({ type: "set-secondary-tab", worktreeId: worktree.id, tab: "terminal" });
    const bytes = Array.from(new TextEncoder().encode(script + "\n"));
    await invoke("term_input", { id: ptyId, data: bytes }).catch(() => {});
  };

  if (!script) {
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
            onClick={openSettings}
            style={{
              padding: "8px 12px",
              backgroundColor: "var(--surface-3)",
              color: "var(--text-primary)",
              borderRadius: "var(--radius-sm)",
              fontSize: "var(--text-sm)",
              fontWeight: "var(--weight-medium)",
              border: "var(--border-1)",
              justifySelf: "center",
              cursor: "pointer",
            }}
          >
            Add {kind} script
          </button>
          <span>
            {kind === "run"
              ? "Run tests or a dev server to verify changes in this workspace"
              : "Bootstrap a fresh workspace (install deps, prep env, etc.)"}
          </span>
        </div>
      </div>
    );
  }

  return (
    <div
      style={{
        height: "100%",
        display: "grid",
        gridTemplateRows: "auto 1fr",
        minHeight: 0,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "var(--space-2) var(--space-3)",
          borderBottom: "var(--border-1)",
        }}
      >
        <button
          type="button"
          onClick={() => void playInTerminal()}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            height: 24,
            padding: "0 10px",
            backgroundColor: "var(--accent-press)",
            color: "var(--text-primary)",
            borderRadius: "var(--radius-sm)",
            fontFamily: "var(--font-sans)",
            fontSize: "var(--text-xs)",
            fontWeight: "var(--weight-medium)",
            cursor: "pointer",
            border: "none",
          }}
          title={`Run ${kind} script in the active terminal`}
        >
          ▶ Run
        </button>
        <span style={{ flex: 1 }} />
        <button
          type="button"
          onClick={openSettings}
          style={{
            background: "transparent",
            border: "none",
            color: "var(--text-tertiary)",
            fontFamily: "var(--font-sans)",
            fontSize: "var(--text-2xs)",
            cursor: "pointer",
          }}
        >
          edit
        </button>
      </div>
      <pre
        style={{
          margin: 0,
          padding: "var(--space-3)",
          fontFamily: "var(--font-mono)",
          fontSize: "var(--text-sm)",
          color: "var(--text-primary)",
          lineHeight: "var(--leading-md)",
          whiteSpace: "pre-wrap",
          overflow: "auto",
          backgroundColor: "var(--surface-1)",
        }}
      >
        {script}
      </pre>
    </div>
  );
}

void fs;
// ChecksView is currently unrouted — its panel slot now hosts the
// Browser tab. The component itself is retained because checks are
// likely to come back as a different surface (status bar pill or
// notifications drawer), so deleting and re-implementing would be
// wasted work. The `void` reference silences the unused-locals
// diagnostic without contributing runtime cost.
void ChecksView;
