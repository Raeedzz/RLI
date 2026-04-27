import { useEffect, useState } from "react";
import { git } from "@/lib/git";

interface Props {
  /** Working directory the terminal was started in. */
  cwd: string;
  /** Shell or agent binary name (zsh / claude / codex). */
  command: string;
}

interface GitInfo {
  branch: string | null;
  ahead: number;
  behind: number;
  added: number;
  removed: number;
  modified: number;
}

const POLL_MS = 4000;

/**
 * Slim Warp-style breadcrumb at the bottom of the terminal pane:
 *
 *   ✻ claude   ~/Developer/RLI   ⎇ main ↑2   +3 −1                ⌘K commands
 *
 * Polls `git status` at 4s cadence — glanceable info, not sub-second.
 * Sits below the xterm grid; the Claude usage bar (when active)
 * stacks underneath.
 */
export function TerminalStatusBar({ cwd, command }: Props) {
  const info = useGitInfo(cwd);
  const home = abbreviateHome(cwd);
  const totalChanges = info.added + info.removed + info.modified;

  return (
    <div
      role="status"
      aria-label="Terminal context"
      className="allow-select"
      style={{
        flexShrink: 0,
        height: 26,
        display: "flex",
        alignItems: "center",
        gap: "var(--space-3)",
        padding: "0 var(--space-3) 0 var(--space-3)",
        backgroundColor: "var(--surface-1)",
        borderTop: "var(--border-1)",
        fontFamily: "var(--font-sans)",
        fontSize: "var(--text-2xs)",
        color: "var(--text-tertiary)",
        userSelect: "text",
        whiteSpace: "nowrap",
        overflow: "hidden",
      }}
    >
      <span
        aria-hidden
        style={{
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          width: 14,
          color: shellGlyphColor(command),
          fontFamily: "var(--font-mono)",
          fontVariantLigatures: "none",
          fontSize: "var(--text-xs)",
        }}
      >
        {shellGlyph(command)}
      </span>
      <span
        style={{
          color: "var(--text-secondary)",
          fontWeight: "var(--weight-medium)",
          letterSpacing: "var(--tracking-tight)",
        }}
      >
        {command}
      </span>

      <Sep />

      <span
        title={cwd}
        style={{
          color: "var(--text-secondary)",
          fontFamily: "var(--font-mono)",
          fontVariantLigatures: "none",
          overflow: "hidden",
          textOverflow: "ellipsis",
          minWidth: 0,
        }}
      >
        {home}
      </span>

      {info.branch && (
        <>
          <Sep />
          <Branch
            branch={info.branch}
            ahead={info.ahead}
            behind={info.behind}
          />
        </>
      )}

      {totalChanges > 0 && (
        <>
          <Sep />
          <Diff
            added={info.added}
            modified={info.modified}
            removed={info.removed}
          />
        </>
      )}

      <span style={{ flex: 1 }} />

      <span
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: "var(--space-1-5)",
          color: "var(--text-tertiary)",
          letterSpacing: "var(--tracking-tight)",
        }}
      >
        <span
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: "var(--text-2xs)",
            padding: "1px var(--space-1-5)",
            backgroundColor: "var(--surface-2)",
            borderRadius: "var(--radius-xs)",
            color: "var(--text-secondary)",
            fontVariantLigatures: "none",
          }}
        >
          ⌘K
        </span>
        <span>commands</span>
      </span>
    </div>
  );
}

function useGitInfo(cwd: string): GitInfo {
  const [info, setInfo] = useState<GitInfo>({
    branch: null,
    ahead: 0,
    behind: 0,
    added: 0,
    removed: 0,
    modified: 0,
  });

  useEffect(() => {
    if (!cwd) return;
    let cancelled = false;
    const refresh = async () => {
      try {
        const status = await git.status(cwd);
        if (cancelled) return;
        let added = 0;
        let removed = 0;
        let modified = 0;
        for (const e of status.entries) {
          if (e.kind === "added" || e.kind === "untracked") added++;
          else if (e.kind === "deleted") removed++;
          else if (e.kind === "modified" || e.kind === "renamed") modified++;
        }
        setInfo({
          branch: status.branch,
          ahead: status.ahead,
          behind: status.behind,
          added,
          removed,
          modified,
        });
      } catch {
        if (!cancelled) {
          setInfo((prev) => ({
            ...prev,
            branch: null,
            added: 0,
            removed: 0,
            modified: 0,
          }));
        }
      }
    };
    void refresh();
    const id = window.setInterval(refresh, POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [cwd]);

  return info;
}

function abbreviateHome(p: string): string {
  return p.replace(/^\/Users\/[^/]+/, "~");
}

function shellGlyph(command: string): string {
  const c = command.toLowerCase();
  if (c.includes("claude")) return "✻";
  if (c.includes("codex")) return "◇";
  return ">_";
}

function shellGlyphColor(command: string): string {
  const c = command.toLowerCase();
  if (c.includes("claude")) return "var(--state-warning)";
  if (c.includes("codex")) return "var(--accent-bright)";
  return "var(--text-tertiary)";
}

function Sep() {
  return (
    <span
      aria-hidden
      style={{
        color: "var(--text-disabled)",
        flexShrink: 0,
      }}
    >
      ·
    </span>
  );
}

function Branch({
  branch,
  ahead,
  behind,
}: {
  branch: string;
  ahead: number;
  behind: number;
}) {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: "var(--space-1-5)",
        color: "var(--text-secondary)",
        flexShrink: 0,
      }}
      title={`branch ${branch}${
        ahead || behind ? `  ↑${ahead} ↓${behind}` : ""
      }`}
    >
      <BranchGlyph />
      <span
        style={{
          color: "var(--state-info)",
          fontFamily: "var(--font-mono)",
          fontVariantLigatures: "none",
        }}
      >
        {branch}
      </span>
      {ahead > 0 && (
        <span
          style={{
            color: "var(--text-tertiary)",
            fontFamily: "var(--font-mono)",
            fontSize: "var(--text-2xs)",
            fontVariantLigatures: "none",
          }}
        >
          ↑{ahead}
        </span>
      )}
      {behind > 0 && (
        <span
          style={{
            color: "var(--text-tertiary)",
            fontFamily: "var(--font-mono)",
            fontSize: "var(--text-2xs)",
            fontVariantLigatures: "none",
          }}
        >
          ↓{behind}
        </span>
      )}
    </span>
  );
}

function Diff({
  added,
  modified,
  removed,
}: {
  added: number;
  modified: number;
  removed: number;
}) {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: "var(--space-2)",
        flexShrink: 0,
        fontFamily: "var(--font-mono)",
        fontVariantLigatures: "none",
      }}
    >
      {added > 0 && (
        <span style={{ color: "var(--diff-add-fg)" }}>+{added}</span>
      )}
      {modified > 0 && (
        <span style={{ color: "var(--state-warning)" }}>~{modified}</span>
      )}
      {removed > 0 && (
        <span style={{ color: "var(--diff-remove-fg)" }}>−{removed}</span>
      )}
    </span>
  );
}

function BranchGlyph() {
  return (
    <svg width="9" height="11" viewBox="0 0 9 11" fill="none" aria-hidden>
      <circle
        cx="2"
        cy="2"
        r="1.4"
        stroke="currentColor"
        strokeWidth="1"
      />
      <circle
        cx="2"
        cy="9"
        r="1.4"
        stroke="currentColor"
        strokeWidth="1"
      />
      <circle
        cx="7"
        cy="5.5"
        r="1.4"
        stroke="currentColor"
        strokeWidth="1"
      />
      <path
        d="M2 3.4 V7.6 M3.2 5.5 H5.6"
        stroke="currentColor"
        strokeWidth="1"
        fill="none"
        strokeLinecap="round"
      />
    </svg>
  );
}
