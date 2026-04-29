import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { git, type StatusEntry, type StatusResult } from "@/lib/git";
import { useAppDispatch } from "@/state/AppState";

interface Props {
  projectPath: string;
  /**
   * Selected file path in the panel — gets a highlighted row treatment
   * so the user can see which diff is currently open in the workspace.
   */
  selectedPath?: string | null;
  /**
   * Fired when the user clicks a row. `staged` indicates whether to ask
   * git for the staged-vs-HEAD diff (true) or the unstaged-vs-index diff
   * (false). The owner renders the diff view in response.
   */
  onOpenDiff?: (path: string, staged: boolean) => void;
}

const POLL_MS = 4000;

/**
 * Source-control panel — VS Code-style. Single git tree (one project per
 * RLI window).
 *
 *   ┌───────────────────────────────────────┐
 *   │ message ▏                             │  textarea
 *   │ ✻ ai                            [push]│  secondary actions
 *   │ ┌───────────────────────────────────┐ │
 *   │ │           ✓ Commit                │ │  primary, full-width
 *   │ └───────────────────────────────────┘ │
 *   ├───────────────────────────────────────┤
 *   │ ▾ STAGED CHANGES                  1   │  expandable, count badge
 *   │   ▣ src/foo.ts          M          ↩  │  row + status + action
 *   │ ▾ CHANGES                         3   │
 *   │   ▣ README.md           M          +  │
 *   │   ▣ notes.md            U          +  │
 *   └───────────────────────────────────────┘
 *
 * Polls `git_status` every 4 s. AI generate uses Gemini Flash-Lite via
 * `git_ai_commit_message`. Push without a remote argument lets git
 * respect the user's branch tracking config.
 */
export function GitPanel({ projectPath, selectedPath, onOpenDiff }: Props) {
  const dispatch = useAppDispatch();
  const [status, setStatus] = useState<StatusResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyPath, setBusyPath] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [committing, setCommitting] = useState(false);
  const [pushing, setPushing] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [stagedOpen, setStagedOpen] = useState(true);
  const [changesOpen, setChangesOpen] = useState(true);
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<number | null>(null);

  const flashToast = useCallback((msg: string) => {
    setToast(msg);
    if (toastTimer.current) window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 2400);
  }, []);

  const refresh = useCallback(async () => {
    try {
      const s = await git.status(projectPath);
      setStatus(s);
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  }, [projectPath]);

  useEffect(() => {
    void refresh();
    const id = window.setInterval(() => void refresh(), POLL_MS);
    return () => window.clearInterval(id);
  }, [refresh]);

  const { staged, unstaged } = useMemo(() => {
    const s: StatusEntry[] = [];
    const u: StatusEntry[] = [];
    for (const e of status?.entries ?? []) {
      if (e.staged) s.push(e);
      else u.push(e);
    }
    return { staged: s, unstaged: u };
  }, [status]);

  const onStage = async (path: string) => {
    setBusyPath(path);
    try {
      await git.stage(projectPath, [path]);
      await refresh();
    } catch (e) {
      flashToast(`stage failed: ${e}`);
    } finally {
      setBusyPath(null);
    }
  };

  const onUnstage = async (path: string) => {
    setBusyPath(path);
    try {
      await git.unstage(projectPath, [path]);
      await refresh();
    } catch (e) {
      flashToast(`unstage failed: ${e}`);
    } finally {
      setBusyPath(null);
    }
  };

  const onStageAll = async () => {
    if (unstaged.length === 0) return;
    setBusyPath("__all__");
    try {
      await git.stage(
        projectPath,
        unstaged.map((e) => e.path),
      );
      await refresh();
    } catch (e) {
      flashToast(`stage all failed: ${e}`);
    } finally {
      setBusyPath(null);
    }
  };

  const onUnstageAll = async () => {
    if (staged.length === 0) return;
    setBusyPath("__all_staged__");
    try {
      await git.unstage(
        projectPath,
        staged.map((e) => e.path),
      );
      await refresh();
    } catch (e) {
      flashToast(`unstage all failed: ${e}`);
    } finally {
      setBusyPath(null);
    }
  };

  const confirmDiscard = (count: number, label: string): boolean => {
    return window.confirm(
      count === 1
        ? `Discard changes to ${label}? This cannot be undone.`
        : `Discard changes to ${count} files? This cannot be undone.`,
    );
  };

  const onDiscard = async (path: string) => {
    if (!confirmDiscard(1, path.split("/").pop() || path)) return;
    setBusyPath(path);
    try {
      await git.discard(projectPath, [path]);
      await refresh();
    } catch (e) {
      flashToast(`discard failed: ${e}`);
    } finally {
      setBusyPath(null);
    }
  };

  const onDiscardAll = async (which: "staged" | "unstaged") => {
    const list = which === "staged" ? staged : unstaged;
    if (list.length === 0) return;
    if (!confirmDiscard(list.length, "")) return;
    const busyKey =
      which === "staged" ? "__discard_staged__" : "__discard_unstaged__";
    setBusyPath(busyKey);
    try {
      await git.discard(
        projectPath,
        list.map((e) => e.path),
      );
      await refresh();
    } catch (e) {
      flashToast(`discard all failed: ${e}`);
    } finally {
      setBusyPath(null);
    }
  };

  const onGenerate = async () => {
    if (staged.length === 0) {
      flashToast("stage something first");
      return;
    }
    setGenerating(true);
    try {
      const msg = await git.aiCommitMessage(projectPath);
      setMessage(msg);
    } catch (e) {
      const msg = String(e).toLowerCase();
      // First-run UX: when there's no key, jump straight into the
      // entry dialog instead of leaving the user to hunt down the
      // command-palette item. AskCard does the same.
      if (msg.includes("api key") || msg.includes("not configured")) {
        flashToast("paste your Gemini API key to enable AI commit messages");
        dispatch({ type: "set-api-key-dialog", open: true });
      } else {
        flashToast(`generate failed: ${e}`);
      }
    } finally {
      setGenerating(false);
    }
  };

  const onCommit = async () => {
    const trimmed = message.trim();
    if (!trimmed) {
      flashToast("commit message is empty");
      return;
    }
    if (staged.length === 0) {
      flashToast("nothing staged");
      return;
    }
    setCommitting(true);
    try {
      await git.commit(projectPath, trimmed);
      setMessage("");
      flashToast("committed");
      await refresh();
    } catch (e) {
      flashToast(`commit failed: ${e}`);
    } finally {
      setCommitting(false);
    }
  };

  const onPush = async () => {
    setPushing(true);
    try {
      await git.push(projectPath);
      flashToast("pushed");
      await refresh();
    } catch (e) {
      flashToast(`push failed: ${e}`);
    } finally {
      setPushing(false);
    }
  };

  return (
    <div
      style={{
        height: "100%",
        display: "flex",
        flexDirection: "column",
        backgroundColor: "var(--surface-1)",
        minHeight: 0,
        position: "relative",
      }}
    >
      <Header status={status} />

      {error && (
        <div
          style={{
            padding: "var(--space-2) var(--space-3)",
            color: "var(--state-error-bright)",
            fontFamily: "var(--font-mono)",
            fontSize: "var(--text-2xs)",
            borderBottom: "var(--border-1)",
          }}
        >
          {error}
        </div>
      )}

      <CommitBox
        message={message}
        onMessage={setMessage}
        onCommit={onCommit}
        onPush={onPush}
        onGenerate={onGenerate}
        committing={committing}
        pushing={pushing}
        generating={generating}
        stagedCount={staged.length}
        ahead={status?.ahead ?? 0}
      />

      <div
        style={{
          flex: 1,
          minHeight: 0,
          overflowY: "auto",
        }}
      >
        {staged.length > 0 && (
          <Section
            label="staged changes"
            count={staged.length}
            open={stagedOpen}
            onToggle={() => setStagedOpen((v) => !v)}
            entries={staged}
            actionLabel="−"
            actionTitle="unstage"
            onAction={onUnstage}
            onDiscard={onDiscard}
            onRowClick={(p) => onOpenDiff?.(p, true)}
            selectedPath={selectedPath}
            busyPath={busyPath}
            secondaryAction={
              staged.length > 1
                ? {
                    label: "unstage all",
                    onClick: () => void onUnstageAll(),
                    disabled: busyPath === "__all_staged__",
                  }
                : undefined
            }
            discardAllAction={{
              title: "discard all staged changes",
              onClick: () => void onDiscardAll("staged"),
              disabled: busyPath === "__discard_staged__",
            }}
          />
        )}
        {unstaged.length > 0 && (
          <Section
            label="changes"
            count={unstaged.length}
            open={changesOpen}
            onToggle={() => setChangesOpen((v) => !v)}
            entries={unstaged}
            actionLabel="+"
            actionTitle="stage"
            onAction={onStage}
            onDiscard={onDiscard}
            onRowClick={(p) => onOpenDiff?.(p, false)}
            selectedPath={selectedPath}
            busyPath={busyPath}
            secondaryAction={
              unstaged.length > 1
                ? {
                    label: "stage all",
                    onClick: () => void onStageAll(),
                    disabled: busyPath === "__all__",
                  }
                : undefined
            }
            discardAllAction={{
              title: "discard all changes",
              onClick: () => void onDiscardAll("unstaged"),
              disabled: busyPath === "__discard_unstaged__",
            }}
          />
        )}
        {staged.length === 0 && unstaged.length === 0 && !error && (
          <Empty />
        )}
      </div>

      {toast && (
        <div
          style={{
            position: "absolute",
            bottom: 8,
            left: 8,
            right: 8,
            padding: "var(--space-2) var(--space-3)",
            backgroundColor: "var(--surface-3)",
            border: "var(--border-1)",
            borderRadius: "var(--radius-sm)",
            fontFamily: "var(--font-sans)",
            fontSize: "var(--text-2xs)",
            color: "var(--text-primary)",
            boxShadow: "var(--shadow-popover)",
          }}
        >
          {toast}
        </div>
      )}
    </div>
  );
}

function Header({ status }: { status: StatusResult | null }) {
  return (
    <div
      style={{
        height: "var(--pane-header-height)",
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        padding: "0 var(--space-3)",
        borderBottom: "var(--border-1)",
        flexShrink: 0,
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
        source control
      </span>
      <span
        className="tabular"
        style={{
          fontFamily: "var(--font-mono)",
          fontSize: "var(--text-2xs)",
          color: "var(--text-tertiary)",
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis",
          maxWidth: "60%",
        }}
        title={
          status?.upstream
            ? `branch ${status.branch ?? "—"} · upstream ${status.upstream}`
            : `branch ${status?.branch ?? "—"}`
        }
      >
        {status?.branch ? `⎇ ${status.branch}` : "no branch"}
        {status && (status.ahead || status.behind) ? (
          <>
            {" "}
            <span style={{ color: "var(--text-disabled)" }}>·</span>{" "}
            {status.ahead > 0 ? `↑${status.ahead}` : ""}
            {status.behind > 0
              ? `${status.ahead > 0 ? " " : ""}↓${status.behind}`
              : ""}
          </>
        ) : null}
      </span>
    </div>
  );
}

function CommitBox({
  message,
  onMessage,
  onCommit,
  onPush,
  onGenerate,
  committing,
  pushing,
  generating,
  stagedCount,
  ahead,
}: {
  message: string;
  onMessage: (s: string) => void;
  onCommit: () => void;
  onPush: () => void;
  onGenerate: () => void;
  committing: boolean;
  pushing: boolean;
  generating: boolean;
  stagedCount: number;
  ahead: number;
}) {
  // Single primary button morphs based on state — commit when there's
  // something staged, push when the local branch is ahead and there's
  // nothing to commit. Same key chord (⌘↵) routes through whichever
  // mode is currently active.
  const mode: "commit" | "push" | "idle" =
    stagedCount > 0 ? "commit" : ahead > 0 ? "push" : "idle";

  return (
    <div
      style={{
        padding: "var(--space-2) var(--space-3)",
        borderBottom: "var(--border-1)",
        display: "flex",
        flexDirection: "column",
        gap: "var(--space-2)",
        flexShrink: 0,
        backgroundColor: "var(--surface-1)",
      }}
    >
      <div style={{ position: "relative" }}>
        <textarea
          value={message}
          onChange={(e) => onMessage(e.target.value)}
          placeholder={
            generating
              ? "generating…"
              : mode === "push"
                ? "Nothing staged — ⌘↵ to push"
                : "Message (⌘↵ to commit)"
          }
          rows={2}
          spellCheck={false}
          className="allow-select"
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
              e.preventDefault();
              if (mode === "commit") onCommit();
              else if (mode === "push") onPush();
            }
          }}
          style={{
            width: "100%",
            minHeight: 44,
            maxHeight: 120,
            // Right padding leaves room for the absolutely-positioned
            // ✻ AI button so the cursor never slides under it.
            padding: "var(--space-2) 28px var(--space-2) var(--space-2)",
            backgroundColor: "var(--surface-0)",
            border: "var(--border-1)",
            borderRadius: "var(--radius-sm)",
            fontFamily: "var(--font-mono)",
            fontSize: "var(--text-xs)",
            color: "var(--text-primary)",
            resize: "vertical",
            outline: "none",
            opacity: generating ? 0.5 : 1,
          }}
        />
        <button
          type="button"
          onClick={onGenerate}
          disabled={generating}
          title="Gemini drafts a message from the staged diff"
          style={{
            position: "absolute",
            top: 4,
            right: 4,
            width: 22,
            height: 22,
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            fontFamily: "var(--font-mono)",
            fontSize: "var(--text-sm)",
            color: generating
              ? "var(--text-disabled)"
              : "var(--state-warning)",
            backgroundColor: "transparent",
            borderRadius: "var(--radius-xs)",
            cursor: generating ? "default" : "pointer",
            opacity: generating ? 0.5 : 1,
            transition:
              "background-color var(--motion-instant) var(--ease-out-quart)",
          }}
          onMouseEnter={(e) => {
            if (!generating) {
              e.currentTarget.style.backgroundColor = "var(--surface-2)";
            }
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.backgroundColor = "transparent";
          }}
        >
          ✻
        </button>
      </div>

      <PrimaryButton
        mode={mode}
        loading={mode === "commit" ? committing : pushing}
        stagedCount={stagedCount}
        ahead={ahead}
        onClick={mode === "commit" ? onCommit : onPush}
      />
    </div>
  );
}

function PrimaryButton({
  mode,
  loading,
  stagedCount,
  ahead,
  onClick,
}: {
  mode: "commit" | "push" | "idle";
  loading: boolean;
  stagedCount: number;
  ahead: number;
  onClick: () => void;
}) {
  const disabled = mode === "idle" || loading;
  const palette =
    mode === "push"
      ? {
          fg: "var(--accent-bright)",
          fill: "var(--surface-accent-soft)",
          fillHover: "var(--surface-accent-tinted)",
          border: "1px solid color-mix(in oklch, var(--accent), transparent 50%)",
        }
      : {
          fg: "var(--state-success-bright)",
          fill: "var(--surface-success-soft)",
          fillHover: "color-mix(in oklch, var(--surface-1), var(--state-success) 14%)",
          border:
            "1px solid color-mix(in oklch, var(--state-success), transparent 50%)",
        };
  const label =
    mode === "push"
      ? loading
        ? "pushing…"
        : "Push"
      : loading
        ? "committing…"
        : "Commit";
  const glyph = mode === "push" ? "↑" : "✓";
  const count = mode === "push" ? ahead : stagedCount;
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={mode === "push" ? "git push (⌘↵)" : "commit (⌘↵)"}
      style={{
        height: 30,
        width: "100%",
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        gap: "var(--space-2)",
        padding: "0 var(--space-3)",
        fontFamily: "var(--font-sans)",
        fontSize: "var(--text-xs)",
        fontWeight: "var(--weight-semibold)",
        letterSpacing: "var(--tracking-tight)",
        color: disabled ? "var(--text-disabled)" : palette.fg,
        backgroundColor: disabled ? "var(--surface-2)" : palette.fill,
        border: disabled ? "var(--border-1)" : palette.border,
        borderRadius: "var(--radius-sm)",
        cursor: disabled ? "default" : "pointer",
        opacity: disabled ? 0.5 : 1,
        transition:
          "background-color var(--motion-fast) var(--ease-out-quart), color var(--motion-fast) var(--ease-out-quart), border-color var(--motion-fast) var(--ease-out-quart)",
      }}
      onMouseEnter={(e) => {
        if (!disabled) e.currentTarget.style.backgroundColor = palette.fillHover;
      }}
      onMouseLeave={(e) => {
        if (!disabled) e.currentTarget.style.backgroundColor = palette.fill;
      }}
    >
      <span aria-hidden style={{ fontSize: "var(--text-sm)" }}>
        {glyph}
      </span>
      {label}
      {!loading && count > 0 && (
        <span
          className="tabular"
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: "var(--text-2xs)",
            color: "var(--text-secondary)",
            opacity: 0.7,
          }}
        >
          {count}
        </span>
      )}
    </button>
  );
}

function Section({
  label,
  count,
  open,
  onToggle,
  entries,
  actionLabel,
  actionTitle,
  onAction,
  onDiscard,
  onRowClick,
  selectedPath,
  busyPath,
  secondaryAction,
  discardAllAction,
}: {
  label: string;
  count: number;
  open: boolean;
  onToggle: () => void;
  entries: StatusEntry[];
  actionLabel: string;
  actionTitle: string;
  onAction: (path: string) => void;
  onDiscard: (path: string) => void;
  onRowClick: (path: string) => void;
  selectedPath?: string | null;
  busyPath: string | null;
  secondaryAction?: {
    label: string;
    onClick: () => void;
    disabled?: boolean;
  };
  discardAllAction?: {
    title: string;
    onClick: () => void;
    disabled?: boolean;
  };
}) {
  return (
    <div>
      <div
        style={{
          height: 26,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "0 var(--space-2) 0 var(--space-3)",
          color: "var(--text-tertiary)",
          backgroundColor: "var(--surface-1)",
          borderBottom: "var(--border-1)",
          position: "sticky",
          top: 0,
          zIndex: 1,
          cursor: "pointer",
          userSelect: "none",
        }}
        onClick={onToggle}
      >
        <span
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 4,
            fontFamily: "var(--font-sans)",
            fontSize: "var(--text-2xs)",
            fontWeight: "var(--weight-semibold)",
            letterSpacing: "var(--tracking-caps)",
            textTransform: "uppercase",
          }}
        >
          <Caret open={open} />
          {label}
        </span>
        <span
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: "var(--space-2)",
          }}
        >
          {discardAllAction && open && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                discardAllAction.onClick();
              }}
              disabled={discardAllAction.disabled}
              title={discardAllAction.title}
              aria-label={discardAllAction.title}
              style={{
                width: 22,
                height: 22,
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                color: "var(--text-tertiary)",
                backgroundColor: "transparent",
                borderRadius: "var(--radius-xs)",
                cursor: discardAllAction.disabled ? "default" : "pointer",
                opacity: discardAllAction.disabled ? 0.5 : 1,
              }}
              onMouseEnter={(e) => {
                if (!discardAllAction.disabled) {
                  e.currentTarget.style.backgroundColor = "var(--surface-error-soft)";
                  e.currentTarget.style.color = "var(--state-error-bright)";
                }
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.backgroundColor = "transparent";
                e.currentTarget.style.color = "var(--text-tertiary)";
              }}
            >
              <DiscardGlyph />
            </button>
          )}
          {secondaryAction && open && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                secondaryAction.onClick();
              }}
              disabled={secondaryAction.disabled}
              style={{
                fontFamily: "var(--font-sans)",
                fontSize: "var(--text-2xs)",
                fontWeight: "var(--weight-medium)",
                letterSpacing: "var(--tracking-base)",
                textTransform: "lowercase",
                color: "var(--accent-bright)",
                backgroundColor: "transparent",
                padding: "0 4px",
                borderRadius: "var(--radius-xs)",
                cursor: secondaryAction.disabled ? "default" : "pointer",
                opacity: secondaryAction.disabled ? 0.5 : 1,
              }}
            >
              {secondaryAction.label}
            </button>
          )}
          <span
            className="tabular"
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: "var(--text-2xs)",
              color: "var(--text-secondary)",
              backgroundColor: "var(--surface-2)",
              padding: "0 6px",
              borderRadius: "var(--radius-pill)",
              minWidth: 18,
              textAlign: "center",
            }}
          >
            {count}
          </span>
        </span>
      </div>
      {open &&
        entries.map((e) => (
          <Row
            key={`${label}::${e.path}`}
            entry={e}
            actionLabel={actionLabel}
            actionTitle={actionTitle}
            onDiscard={() => onDiscard(e.path)}
            busy={
              busyPath === e.path ||
              busyPath === "__all__" ||
              busyPath === "__all_staged__"
            }
            onAction={() => onAction(e.path)}
            onRowClick={() => onRowClick(e.path)}
            selected={selectedPath === e.path}
          />
        ))}
    </div>
  );
}

function Row({
  entry,
  actionLabel,
  actionTitle,
  busy,
  onAction,
  onDiscard,
  onRowClick,
  selected,
}: {
  entry: StatusEntry;
  actionLabel: string;
  actionTitle: string;
  busy: boolean;
  onAction: () => void;
  onDiscard: () => void;
  onRowClick: () => void;
  selected: boolean;
}) {
  const filename = entry.path.split("/").pop() || entry.path;
  const dirname = entry.path.includes("/")
    ? entry.path.slice(0, entry.path.lastIndexOf("/"))
    : "";
  return (
    <div
      onClick={onRowClick}
      style={{
        height: 26,
        display: "flex",
        alignItems: "center",
        gap: "var(--space-2)",
        padding: "0 var(--space-2) 0 28px",
        fontFamily: "var(--font-sans)",
        fontSize: "var(--text-xs)",
        color: "var(--text-secondary)",
        cursor: "pointer",
        backgroundColor: selected ? "var(--surface-accent-tinted)" : "transparent",
        transition:
          "background-color var(--motion-instant) var(--ease-out-quart)",
      }}
      onMouseEnter={(e) => {
        if (!selected) {
          e.currentTarget.style.backgroundColor = "var(--surface-2)";
        }
      }}
      onMouseLeave={(e) => {
        if (!selected) {
          e.currentTarget.style.backgroundColor = "transparent";
        }
      }}
    >
      <span
        style={{
          flex: 1,
          minWidth: 0,
          display: "inline-flex",
          alignItems: "baseline",
          gap: 6,
          overflow: "hidden",
          whiteSpace: "nowrap",
        }}
        title={entry.path}
      >
        <span
          style={{
            color: "var(--text-primary)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            flexShrink: 1,
            minWidth: 0,
          }}
        >
          {filename}
        </span>
        {dirname && (
          <span
            style={{
              color: "var(--text-tertiary)",
              fontSize: "var(--text-2xs)",
              overflow: "hidden",
              textOverflow: "ellipsis",
              flexShrink: 2,
              minWidth: 0,
            }}
          >
            {dirname}
          </span>
        )}
      </span>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onDiscard();
        }}
        disabled={busy}
        title="discard changes"
        aria-label="discard changes"
        style={{
          width: 20,
          height: 20,
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          color: "var(--text-tertiary)",
          backgroundColor: "transparent",
          borderRadius: "var(--radius-xs)",
          cursor: busy ? "default" : "pointer",
          opacity: busy ? 0.5 : 1,
          flexShrink: 0,
        }}
        onMouseEnter={(e) => {
          if (!busy) {
            e.currentTarget.style.backgroundColor = "var(--surface-error-soft)";
            e.currentTarget.style.color = "var(--state-error-bright)";
          }
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.backgroundColor = "transparent";
          e.currentTarget.style.color = "var(--text-tertiary)";
        }}
      >
        <DiscardGlyph />
      </button>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onAction();
        }}
        disabled={busy}
        title={actionTitle}
        style={{
          width: 20,
          height: 20,
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          fontFamily: "var(--font-mono)",
          fontSize: "var(--text-sm)",
          color: "var(--text-tertiary)",
          backgroundColor: "transparent",
          borderRadius: "var(--radius-xs)",
          cursor: busy ? "default" : "pointer",
          opacity: busy ? 0.5 : 1,
          flexShrink: 0,
        }}
        onMouseEnter={(e) => {
          if (!busy) {
            e.currentTarget.style.backgroundColor = "var(--surface-3)";
            e.currentTarget.style.color = "var(--text-primary)";
          }
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.backgroundColor = "transparent";
          e.currentTarget.style.color = "var(--text-tertiary)";
        }}
      >
        {actionLabel}
      </button>
      <KindGlyph kind={entry.kind} />
    </div>
  );
}

function KindGlyph({ kind }: { kind: string }) {
  const map: Record<string, { glyph: string; color: string }> = {
    modified: { glyph: "M", color: "var(--state-warning)" },
    added: { glyph: "A", color: "var(--diff-add-fg)" },
    deleted: { glyph: "D", color: "var(--diff-remove-fg)" },
    renamed: { glyph: "R", color: "var(--state-info)" },
    untracked: { glyph: "U", color: "var(--diff-add-fg)" },
    conflicted: { glyph: "C", color: "var(--state-error-bright)" },
  };
  const entry = map[kind] || { glyph: "·", color: "var(--text-tertiary)" };
  return (
    <span
      aria-hidden
      title={kind}
      style={{
        width: 14,
        textAlign: "center",
        fontFamily: "var(--font-mono)",
        fontSize: "var(--text-2xs)",
        fontWeight: "var(--weight-semibold)",
        color: entry.color,
        flexShrink: 0,
      }}
    >
      {entry.glyph}
    </span>
  );
}

/**
 * Curved counter-clockwise arrow — the conventional "revert / discard
 * changes" glyph used by VS Code and most other git UIs. Renders at the
 * size of the surrounding action buttons (20×20 wrapper, 14×14 glyph).
 */
function DiscardGlyph() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 14 14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {/* counter-clockwise 270° arc starting from the top */}
      <path d="M11 7a4 4 0 1 0-1.17 2.83" />
      {/* arrowhead at the open end of the arc */}
      <path d="M11 4.2 V7 H8.2" />
    </svg>
  );
}

function Caret({ open }: { open: boolean }) {
  return (
    <span
      aria-hidden
      style={{
        display: "inline-block",
        width: 10,
        textAlign: "center",
        fontSize: "var(--text-2xs)",
        color: "var(--text-tertiary)",
        transform: open ? "rotate(0deg)" : "rotate(-90deg)",
        transition: "transform var(--motion-instant) var(--ease-out-quart)",
      }}
    >
      ▾
    </span>
  );
}

function Empty() {
  return (
    <div
      style={{
        padding: "var(--space-6) var(--space-4)",
        textAlign: "center",
        color: "var(--text-tertiary)",
        fontSize: "var(--text-xs)",
        fontFamily: "var(--font-sans)",
      }}
    >
      working tree clean
    </div>
  );
}
