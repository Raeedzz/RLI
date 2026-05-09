import { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { SearchIcon } from "@/primitives/Icon";
import { IconPullRequest } from "@/design/icons";
import { useIsFullscreen } from "@/hooks/useIsFullscreen";
import {
  useActiveWorktree,
  useAppDispatch,
  useAppState,
} from "@/state/AppState";
import { useToast } from "@/primitives/Toast";
import type { Tab, Worktree } from "@/state/types";

const TRAFFIC_LIGHT_GUTTER = 78;
const HEIGHT = 28;
const PR_POLL_MS = 12_000;

interface PrStatus {
  exists: boolean;
  number: number | null;
  url: string | null;
  state: string | null;
  mergeable: string | null;
}

interface ConflictResult {
  conflicts: boolean;
  files: string[];
  alreadyUpToDate: boolean;
}

/**
 * Thin window-chrome strip pinned to the very top of the app. Houses
 * the search summoner (centered) and the per-branch action button on
 * the right — Create PR / Merge / Resolve conflicts depending on the
 * worktree's PR state. The button polls `gh pr view` every 12s.
 */
export function WindowChrome() {
  const dispatch = useAppDispatch();
  const isFullscreen = useIsFullscreen();
  const worktree = useActiveWorktree();

  return (
    <div
      data-tauri-drag-region
      style={{
        position: "relative",
        height: HEIGHT,
        flexShrink: 0,
        backgroundColor: "var(--surface-2)",
        borderBottom: "var(--border-1)",
        paddingLeft: isFullscreen ? "var(--space-2)" : TRAFFIC_LIGHT_GUTTER,
        paddingRight: "var(--space-2)",
        userSelect: "none",
        transition:
          "padding-left var(--motion-fast) var(--ease-out-quart)",
      }}
    >
      <div
        data-tauri-drag-region
        style={{
          position: "absolute",
          top: "50%",
          left: "50%",
          transform: "translate(-50%, -50%)",
          display: "flex",
          alignItems: "center",
          lineHeight: 0,
        }}
      >
        <SearchTrigger
          onOpen={() => dispatch({ type: "set-search", open: true })}
        />
      </div>

      <div
        data-tauri-drag-region
        style={{
          position: "absolute",
          top: "50%",
          right: "var(--space-2)",
          transform: "translateY(-50%)",
          display: "flex",
          alignItems: "center",
        }}
      >
        <BranchActionButton worktree={worktree} />
      </div>
    </div>
  );
}

function BranchActionButton({ worktree }: { worktree: Worktree | null }) {
  const dispatch = useAppDispatch();
  const toast = useToast();
  const state = useAppState();
  const branch = worktree?.branch ?? "";
  const path = worktree?.path ?? "";
  const onMain = branch === "main" || branch === "master";
  const eligible = !!worktree && !onMain && branch.length > 0;

  const [pr, setPr] = useState<PrStatus | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    if (!eligible) {
      setPr(null);
      return;
    }
    try {
      const status = await invoke<PrStatus>("pr_status", {
        cwd: path,
        branch,
      });
      setPr(status);
    } catch {
      setPr(null);
    }
  }, [eligible, path, branch]);

  useEffect(() => {
    void refresh();
    if (!eligible) return;
    const t = window.setInterval(() => void refresh(), PR_POLL_MS);
    const onGitRefresh = (e: Event) => {
      const detail = (e as CustomEvent<{ cwd?: string }>).detail;
      if (!detail?.cwd || detail.cwd === path) void refresh();
    };
    window.addEventListener("rli-git-refresh", onGitRefresh);
    return () => {
      window.clearInterval(t);
      window.removeEventListener("rli-git-refresh", onGitRefresh);
    };
  }, [eligible, refresh, path]);

  // Find a terminal-tab PTY to inject a prompt into when delegating
  // conflict resolution to the agent. Falls back to the secondary
  // panel's active terminal if no main-column terminal is open.
  const targetPtyId = useMemo(() => {
    if (!worktree) return null;
    const activeTab = worktree.activeTabId
      ? state.tabs[worktree.activeTabId]
      : null;
    if (activeTab && isTerminal(activeTab)) return activeTab.ptyId;
    for (const id of worktree.tabIds) {
      const t = state.tabs[id];
      if (t && isTerminal(t)) return t.ptyId;
    }
    return (
      worktree.secondaryActiveTerminalId ??
      worktree.secondaryPtyId ??
      null
    );
  }, [worktree, state.tabs]);

  const merge = useCallback(async () => {
    if (!worktree || !pr?.number) return;
    setBusy(true);
    try {
      await invoke("pr_merge", {
        cwd: path,
        number: pr.number,
        method: "merge",
      });
      // Notify the Changes panel (and anyone else watching) that the
      // worktree's git state may have shifted after the server-side
      // merge, so they can drop stale "uncommitted changes" rows.
      window.dispatchEvent(
        new CustomEvent("rli-git-refresh", { detail: { cwd: path } }),
      );
      toast.show({ message: `Merged PR #${pr.number} into ${branch === "master" ? "master" : "main"}.` });
      await refresh();
    } catch (e) {
      toast.show({ message: `Merge failed: ${e}` });
    } finally {
      setBusy(false);
    }
  }, [worktree, pr, path, branch, refresh, toast]);

  const resolveConflicts = useCallback(async () => {
    if (!worktree) return;
    setBusy(true);
    try {
      const result = await invoke<ConflictResult>(
        "merge_base_into_branch",
        { cwd: path, base: "main" },
      );
      if (!result.conflicts) {
        window.dispatchEvent(
          new CustomEvent("rli-git-refresh", { detail: { cwd: path } }),
        );
        toast.show({
          message: result.alreadyUpToDate
            ? "Branch is already up to date with main."
            : "Merged main into branch — no conflicts. Push to retry the PR merge.",
        });
        await refresh();
        return;
      }
      // Conflicts present in working tree. Hand off to the worktree's
      // agent via PTY injection — user sees the agent work in real
      // time, which beats a one-shot helperRun for a multi-file edit.
      const fileList = result.files.slice(0, 24).join(", ");
      const prompt =
        `Merge conflicts after pulling main into this branch. ` +
        `Files: ${fileList}. ` +
        `Read each conflicted file, resolve the <<<<<<<, =======, >>>>>>> markers ` +
        `keeping the correct intent, then run \`git add <files>\`, \`git commit --no-edit\`, ` +
        `and \`git push\`. Don't ask for confirmation between files — just resolve them all.`;
      if (targetPtyId) {
        const bytes = stringToUtf8Bytes(prompt + "\n");
        await invoke("term_input", { id: targetPtyId, data: bytes }).catch(
          () => undefined,
        );
        toast.show({
          message: `Conflicts in ${result.files.length} file${result.files.length === 1 ? "" : "s"} — sent to agent.`,
        });
      } else {
        toast.show({
          message: `Conflicts in ${result.files.length} file${result.files.length === 1 ? "" : "s"}. Open your agent terminal and ask it to resolve.`,
        });
      }
      await refresh();
    } catch (e) {
      toast.show({ message: `Resolve failed: ${e}` });
    } finally {
      setBusy(false);
    }
  }, [worktree, path, targetPtyId, refresh, toast]);

  const openCreatePR = () => {
    if (!worktree) return;
    dispatch({ type: "set-pr-dialog", worktreeId: worktree.id });
  };

  // ----- render -----

  if (!eligible) {
    return <ActionButton kind="create-pr" disabled onClick={() => {}} />;
  }
  if (busy) {
    return <ActionButton kind="working" disabled onClick={() => {}} />;
  }
  if (!pr || !pr.exists || pr.state === "MERGED" || pr.state === "CLOSED") {
    return <ActionButton kind="create-pr" onClick={openCreatePR} />;
  }
  if (pr.mergeable === "CONFLICTING") {
    return <ActionButton kind="resolve" onClick={resolveConflicts} />;
  }
  // MERGEABLE or UNKNOWN — UNKNOWN is GitHub still computing; let the
  // user try, gh will surface the failure if it isn't actually clean.
  return <ActionButton kind="merge" onClick={merge} />;
}

type ButtonKind = "create-pr" | "merge" | "resolve" | "working";

function ActionButton({
  kind,
  onClick,
  disabled,
}: {
  kind: ButtonKind;
  onClick: () => void;
  disabled?: boolean;
}) {
  const label =
    kind === "create-pr"
      ? "Create PR"
      : kind === "merge"
        ? "Merge"
        : kind === "resolve"
          ? "Resolve conflicts"
          : "Working…";
  const title =
    kind === "create-pr"
      ? "Create pull request"
      : kind === "merge"
        ? "Merge this PR into main"
        : kind === "resolve"
          ? "Pull main, send conflicts to your agent"
          : "Working…";
  // Distinguish the destructive-ish states with intent-based color:
  //   resolve → warning tint (something is blocking)
  //   merge   → success tint (one click ships it)
  //   create-pr → accent tint (default)
  const intent: ButtonIntent =
    kind === "resolve" ? "warning" : kind === "merge" ? "success" : "accent";

  return (
    <button
      type="button"
      onClick={onClick}
      data-tauri-drag-region={false}
      disabled={disabled}
      title={title}
      aria-label={title}
      style={{
        height: 22,
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        padding: "0 10px",
        backgroundColor: disabled
          ? "var(--surface-1)"
          : intentBg(intent),
        color: disabled ? "var(--text-disabled)" : "var(--text-primary)",
        border: disabled
          ? "var(--border-1)"
          : `1px solid ${intentBorder(intent)}`,
        borderRadius: "var(--radius-sm)",
        fontFamily: "var(--font-sans)",
        fontSize: "var(--text-2xs)",
        fontWeight: "var(--weight-semibold)",
        letterSpacing: "var(--tracking-tight)",
        cursor: disabled ? "default" : "pointer",
        flexShrink: 0,
        transition:
          "background-color var(--motion-instant) var(--ease-out-quart), border-color var(--motion-instant) var(--ease-out-quart), color var(--motion-instant) var(--ease-out-quart)",
      }}
      onMouseEnter={(e) => {
        if (disabled) return;
        e.currentTarget.style.backgroundColor = intentHoverBg(intent);
      }}
      onMouseLeave={(e) => {
        if (disabled) return;
        e.currentTarget.style.backgroundColor = intentBg(intent);
      }}
    >
      <IconPullRequest size={12} />
      <span>{label}</span>
    </button>
  );
}

type ButtonIntent = "accent" | "success" | "warning";

function intentBg(intent: ButtonIntent): string {
  if (intent === "success")
    return "color-mix(in oklch, var(--surface-2), var(--state-success) 14%)";
  if (intent === "warning")
    return "color-mix(in oklch, var(--surface-2), var(--state-warning) 16%)";
  return "var(--surface-accent-tinted)";
}
function intentHoverBg(intent: ButtonIntent): string {
  if (intent === "success")
    return "color-mix(in oklch, var(--surface-2), var(--state-success) 22%)";
  if (intent === "warning")
    return "color-mix(in oklch, var(--surface-2), var(--state-warning) 24%)";
  return "color-mix(in oklch, var(--surface-accent-tinted), var(--accent) 8%)";
}
function intentBorder(intent: ButtonIntent): string {
  if (intent === "success")
    return "color-mix(in oklch, var(--accent-muted), var(--state-success) 30%)";
  if (intent === "warning")
    return "color-mix(in oklch, var(--accent-muted), var(--state-warning) 30%)";
  return "var(--accent-muted)";
}

function isTerminal(t: Tab): t is Extract<Tab, { kind: "terminal" }> {
  return t.kind === "terminal";
}

function stringToUtf8Bytes(s: string): number[] {
  const enc = new TextEncoder();
  return Array.from(enc.encode(s));
}

function SearchTrigger({ onOpen }: { onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      data-tauri-drag-region={false}
      title="Search  ⌘K"
      aria-label="Search"
      style={{
        width: 360,
        maxWidth: "50vw",
        height: 22,
        display: "inline-flex",
        alignItems: "center",
        gap: "var(--space-2)",
        padding: "0 10px",
        backgroundColor: "var(--surface-1)",
        border: "var(--border-1)",
        borderRadius: "var(--radius-sm)",
        cursor: "text",
        textAlign: "left",
        transition:
          "background-color var(--motion-instant) var(--ease-out-quart), border-color var(--motion-instant) var(--ease-out-quart)",
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.backgroundColor = "var(--surface-0)";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.backgroundColor = "var(--surface-1)";
      }}
    >
      <span
        style={{
          color: "var(--text-tertiary)",
          display: "inline-flex",
          alignItems: "center",
          flexShrink: 0,
        }}
      >
        <SearchIcon size={13} />
      </span>
      <span
        style={{
          flex: 1,
          minWidth: 0,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          fontFamily: "var(--font-sans)",
          fontSize: "var(--text-xs)",
          color: "var(--text-tertiary)",
          letterSpacing: "var(--tracking-tight)",
        }}
      >
        Search
      </span>
      <span
        style={{
          fontFamily: "var(--font-mono)",
          fontSize: "var(--text-2xs)",
          color: "var(--text-disabled)",
          flexShrink: 0,
        }}
      >
        ⌘K
      </span>
    </button>
  );
}
