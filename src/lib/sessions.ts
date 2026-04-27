import { invoke } from "@tauri-apps/api/core";
import { git } from "./git";
import type { Session } from "@/state/types";

/**
 * Session lifecycle helpers (Task #9).
 *
 * A "session" in RLI is one running agent (claude / codex / etc.) inside
 * its own git worktree on its own branch. These helpers create and tear
 * those down using the existing git layer.
 *
 * For v1, slug + branch name are passed in by the caller. The Flash-Lite
 * "name from first prompt" path lives in Task #13's session-naming side
 * which can call into this module once it has a slug.
 *
 * The worktree convention: `<projectRoot>/.rli/sessions/<slug>` with a
 * branch named `rli/<slug>` off the project's current branch.
 */

export type CloseAction =
  | { kind: "merge"; into?: string }
  | { kind: "pr" }
  | { kind: "keep" }
  | { kind: "discard" };

export async function createWorktree(opts: {
  projectPath: string;
  slug: string;
}): Promise<{ worktreePath: string; branch: string }> {
  const { projectPath, slug } = opts;
  const worktreePath = `${projectPath}/.rli/sessions/${slug}`;
  const branch = `rli/${slug}`;
  await git.worktreeAdd(projectPath, worktreePath, branch);
  return { worktreePath, branch };
}

export async function closeWorktree(opts: {
  session: Session;
  projectPath: string;
  worktreePath: string;
  action: CloseAction;
}): Promise<void> {
  const { session, projectPath, worktreePath, action } = opts;

  switch (action.kind) {
    case "merge": {
      const into = action.into ?? (await git.branchCurrent(projectPath));
      await git.worktreeRemove(projectPath, worktreePath);
      await invoke("git_merge_branch", {
        cwd: projectPath,
        branch: session.branch,
        into,
      }).catch(() => {
        /* command may not yet exist; defer to a future merge command */
      });
      return;
    }
    case "pr": {
      // Push the branch and use `gh` to open a PR. We do that from a
      // shell command rather than the git layer so user creds + the gh
      // session pick it up exactly as in their terminal.
      await git.push(projectPath, "origin", session.branch);
      await invoke("shell_run", {
        cwd: projectPath,
        command: "gh",
        args: ["pr", "create", "--web", "--head", session.branch],
      }).catch(() => {
        /* defer if shell_run isn't registered; user can pr from terminal */
      });
      await git.worktreeRemove(projectPath, worktreePath);
      return;
    }
    case "keep":
      await git.worktreeRemove(projectPath, worktreePath, true);
      return;
    case "discard":
      await git.worktreeRemove(projectPath, worktreePath, true);
      // Branch deletion handled in a later iteration if needed.
      return;
  }
}

export function defaultSlugFor(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/['"`]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}
