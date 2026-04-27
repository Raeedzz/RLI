import { useEffect, useState } from "react";
import { git, type StatusEntry } from "../lib/git";

export type GitStatusMap = Map<string, StatusEntry>;

/**
 * Polls `git status` for the given project root and returns a path →
 * status entry map. Path keys are absolute (joined with the project
 * root) so the file tree can do an O(1) lookup per row.
 *
 * Polls at a relaxed cadence — git status reads are fast but not free,
 * and the file tree doesn't need sub-second freshness.
 */
export function useGitStatus(projectPath: string | null): GitStatusMap {
  const [map, setMap] = useState<GitStatusMap>(() => new Map());

  useEffect(() => {
    if (!projectPath) {
      setMap(new Map());
      return;
    }

    let cancelled = false;
    const root = projectPath.replace(/\/$/, "");

    const refresh = async () => {
      try {
        const status = await git.status(projectPath);
        if (cancelled) return;
        const next: GitStatusMap = new Map();
        for (const e of status.entries) {
          // Git emits paths relative to the repo root. Normalize to
          // the absolute paths the file tree uses.
          const abs = `${root}/${e.path}`;
          next.set(abs, e);
        }
        setMap(next);
      } catch {
        // Project might not be a git repo — leave the map empty
        // rather than spamming errors.
        if (!cancelled) setMap(new Map());
      }
    };

    void refresh();
    const id = window.setInterval(refresh, 4000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [projectPath]);

  return map;
}

/* ------------------------------------------------------------------
   Color mapping — used by both the file tree and the git panel
   ------------------------------------------------------------------ */

export interface GitStatusVisual {
  /** CSS color expression for the row's text. */
  color: string;
  /** Single-letter status badge shown in the row's right margin. */
  badge: string;
  /** Tooltip-friendly label for the badge. */
  label: string;
}

export function statusVisual(entry: StatusEntry | undefined): GitStatusVisual | null {
  if (!entry) return null;
  switch (entry.kind) {
    case "added":
      return {
        color: "var(--diff-add-fg)",
        badge: "A",
        label: entry.staged ? "added (staged)" : "added",
      };
    case "modified":
      return {
        color: "var(--state-warning)",
        badge: "M",
        label: entry.staged ? "modified (staged)" : "modified",
      };
    case "deleted":
      return {
        color: "var(--diff-remove-fg)",
        badge: "D",
        label: entry.staged ? "deleted (staged)" : "deleted",
      };
    case "renamed":
      return {
        color: "var(--state-info)",
        badge: "R",
        label: "renamed",
      };
    case "untracked":
      return {
        color: "var(--diff-add-fg)",
        badge: "U",
        label: "untracked",
      };
    case "conflicted":
      return {
        color: "var(--state-error)",
        badge: "!",
        label: "conflicted",
      };
    default:
      return null;
  }
}
